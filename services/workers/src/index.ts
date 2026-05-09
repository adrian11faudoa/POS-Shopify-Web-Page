// services/workers/src/index.ts
// BullMQ background workers: webhooks, reports, inventory alerts, email

import { Worker, Queue, QueueEvents, type Job } from 'bullmq';
import { createClient } from 'redis';
import { db } from '../../api/src/lib/database';
import { createLogger } from '../../api/src/lib/logger';
import { analyticsService } from '../../api/src/services/analytics.service';
import { shopifyService } from '../../api/src/services/shopify.service';
import { emailService } from './services/email.service';
import { config } from '../../api/src/config';

const logger = createLogger('workers');

const connection = { url: config.REDIS_URL };

// ─── Queue Definitions ────────────────────────────────────────────────────────

export const queues = {
  webhooks: new Queue('webhooks', { connection }),
  reports: new Queue('reports', { connection }),
  inventory: new Queue('inventory', { connection }),
  email: new Queue('email', { connection }),
  shopifySync: new Queue('shopify-sync', { connection }),
  receipts: new Queue('receipts', { connection }),
};

// ─── Job Type Definitions ─────────────────────────────────────────────────────

interface WebhookJobData {
  eventId: string;
  topic: string;
  storeId: string;
  retryCount: number;
}

interface ReportJobData {
  storeId: string;
  reportType: 'daily' | 'weekly' | 'monthly';
  date: string;
  recipientEmails: string[];
}

interface InventoryJobData {
  storeId: string;
  variantId: string;
  alertType: 'LOW_STOCK' | 'OUT_OF_STOCK';
  quantity: number;
  threshold: number;
}

interface EmailJobData {
  to: string | string[];
  subject: string;
  template: string;
  variables: Record<string, unknown>;
}

interface ShopifySyncJobData {
  storeId: string;
  operation: 'sync_products' | 'sync_inventory' | 'sync_customers';
  cursor?: string;
}

interface ReceiptJobData {
  orderId: string;
  storeId: string;
  printerAddress: string;
  printerType: string;
}

// ─── Worker: Webhook Retry ─────────────────────────────────────────────────────

const webhookWorker = new Worker<WebhookJobData>(
  'webhooks',
  async (job: Job<WebhookJobData>) => {
    const { eventId, topic, storeId } = job.data;
    logger.info({ eventId, topic, storeId, attempt: job.attemptsMade }, 'Processing webhook');

    const event = await db('webhook_events').where({ id: eventId }).first();
    if (!event || event.status === 'PROCESSED') return;

    try {
      // Re-dispatch to appropriate handler
      const { handlers } = await import('../../api/src/webhooks/shopify.webhooks');
      const store = await db('stores').where({ id: storeId }).first();
      if (!store) throw new Error('Store not found');

      await handlers[topic]?.(store, event.payload);

      await db('webhook_events').where({ id: eventId }).update({
        status: 'PROCESSED',
        processed_at: new Date(),
      });
    } catch (err) {
      const error = err as Error;
      await db('webhook_events').where({ id: eventId }).update({
        error: error.message,
      });
      throw err; // BullMQ will retry
    }
  },
  {
    connection,
    concurrency: 10,
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  }
);

// ─── Worker: Scheduled Reports ─────────────────────────────────────────────────

const reportWorker = new Worker<ReportJobData>(
  'reports',
  async (job: Job<ReportJobData>) => {
    const { storeId, reportType, date, recipientEmails } = job.data;
    logger.info({ storeId, reportType, date }, 'Generating scheduled report');

    const reportDate = new Date(date);
    let startDate: Date;
    let endDate: Date;

    switch (reportType) {
      case 'daily':
        startDate = new Date(reportDate);
        startDate.setHours(0, 0, 0, 0);
        endDate = new Date(reportDate);
        endDate.setHours(23, 59, 59, 999);
        break;
      case 'weekly':
        startDate = new Date(reportDate);
        startDate.setDate(startDate.getDate() - 7);
        endDate = new Date(reportDate);
        break;
      case 'monthly':
        startDate = new Date(reportDate.getFullYear(), reportDate.getMonth(), 1);
        endDate = new Date(reportDate.getFullYear(), reportDate.getMonth() + 1, 0);
        break;
    }

    const report = await analyticsService.generateSalesReport(storeId, startDate, endDate);

    for (const email of recipientEmails) {
      await queues.email.add('send-report', {
        to: email,
        subject: `${reportType.charAt(0).toUpperCase() + reportType.slice(1)} Sales Report - ${date}`,
        template: 'sales-report',
        variables: { report, reportType, date },
      });
    }

    logger.info({ storeId, reportType }, 'Report generated and queued for email');
  },
  { connection, concurrency: 2 }
);

// ─── Worker: Inventory Alerts ──────────────────────────────────────────────────

const inventoryWorker = new Worker<InventoryJobData>(
  'inventory',
  async (job: Job<InventoryJobData>) => {
    const { storeId, variantId, alertType, quantity, threshold } = job.data;
    logger.info({ storeId, variantId, alertType }, 'Processing inventory alert');

    const [variant, store] = await Promise.all([
      db('product_variants')
        .join('products', 'product_variants.product_id', 'products.id')
        .where('product_variants.id', variantId)
        .select(
          'product_variants.name as variant_name',
          'products.name as product_name',
        )
        .first(),
      db('stores').where({ id: storeId }).first(),
    ]);

    if (!variant || !store) return;

    // Find managers/owners to notify
    const managers = await db('employees')
      .where({ store_id: storeId, is_active: true })
      .whereIn('role', ['OWNER', 'MANAGER'])
      .whereNotNull('email');

    for (const manager of managers) {
      await queues.email.add('inventory-alert', {
        to: manager.email,
        subject: `${alertType === 'OUT_OF_STOCK' ? '🚨 Out of Stock' : '⚠️ Low Stock'}: ${variant.product_name}`,
        template: 'inventory-alert',
        variables: {
          productName: variant.product_name,
          variantName: variant.variant_name,
          quantity,
          threshold,
          alertType,
          storeName: store.name,
          managerName: `${manager.first_name} ${manager.last_name}`,
        },
      });
    }

    // Auto-create reorder suggestion if configured
    const invItem = await db('inventory_items')
      .where({ store_id: storeId, variant_id: variantId })
      .first();

    if (invItem?.reorder_point && quantity <= invItem.reorder_point && invItem.supplier_id) {
      logger.info({ variantId, quantity }, 'Auto-reorder threshold reached');
      // In production: create purchase order or notify supplier
    }
  },
  { connection, concurrency: 20 }
);

// ─── Worker: Email ─────────────────────────────────────────────────────────────

const emailWorker = new Worker<EmailJobData>(
  'email',
  async (job: Job<EmailJobData>) => {
    const { to, subject, template, variables } = job.data;
    await emailService.send({ to, subject, template, variables });
  },
  {
    connection,
    concurrency: 5,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  }
);

// ─── Worker: Shopify Full Sync ─────────────────────────────────────────────────

const shopifySyncWorker = new Worker<ShopifySyncJobData>(
  'shopify-sync',
  async (job: Job<ShopifySyncJobData>) => {
    const { storeId, operation, cursor } = job.data;
    logger.info({ storeId, operation, cursor }, 'Running Shopify sync');

    switch (operation) {
      case 'sync_products':
        await shopifyService.syncAllProducts(storeId, cursor);
        break;
      case 'sync_inventory':
        await shopifyService.syncAllInventory(storeId);
        break;
      case 'sync_customers':
        await shopifyService.syncAllCustomers(storeId, cursor);
        break;
    }
  },
  {
    connection,
    concurrency: 1, // Shopify rate limits: one sync at a time per store
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'fixed', delay: 60000 }, // 1 min between retries
    },
  }
);

// ─── Worker: Thermal Printing ──────────────────────────────────────────────────

const receiptWorker = new Worker<ReceiptJobData>(
  'receipts',
  async (job: Job<ReceiptJobData>) => {
    const { orderId, storeId } = job.data;
    logger.info({ orderId }, 'Printing receipt');

    const { printService } = await import('../../api/src/services/print.service');
    const { orderService } = await import('../../api/src/services/order.service');

    const order = await orderService.getOrderById(db, orderId);
    await printService.printReceipt(order);
  },
  {
    connection,
    concurrency: 3,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'fixed', delay: 5000 },
    },
  }
);

// ─── Scheduled Jobs ────────────────────────────────────────────────────────────

async function scheduleRecurringJobs() {
  // Daily report: 11 PM every night
  await queues.reports.add(
    'daily-reports',
    { storeId: '*', reportType: 'daily', date: new Date().toISOString(), recipientEmails: [] },
    {
      repeat: { pattern: '0 23 * * *' },
      jobId: 'daily-reports',
    }
  );

  // Weekly report: Sunday 11:30 PM
  await queues.reports.add(
    'weekly-reports',
    { storeId: '*', reportType: 'weekly', date: new Date().toISOString(), recipientEmails: [] },
    {
      repeat: { pattern: '30 23 * * 0' },
      jobId: 'weekly-reports',
    }
  );

  // Shopify sync: every 4 hours
  await queues.shopifySync.add(
    'periodic-sync',
    { storeId: '*', operation: 'sync_inventory' },
    {
      repeat: { pattern: '0 */4 * * *' },
      jobId: 'shopify-inventory-sync',
    }
  );

  logger.info('Recurring jobs scheduled');
}

// ─── Error Handling ────────────────────────────────────────────────────────────

const workers = [webhookWorker, reportWorker, inventoryWorker, emailWorker, shopifySyncWorker, receiptWorker];

for (const worker of workers) {
  worker.on('completed', (job: Job) => {
    logger.info({ jobId: job.id, queue: job.queueName }, 'Job completed');
  });

  worker.on('failed', (job: Job | undefined, err: Error) => {
    logger.error({ jobId: job?.id, queue: job?.queueName, err: err.message }, 'Job failed');
  });

  worker.on('error', (err: Error) => {
    logger.error({ err }, 'Worker error');
  });
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────────

async function shutdown() {
  logger.info('Shutting down workers...');
  await Promise.all(workers.map(w => w.close()));
  logger.info('Workers shut down');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Start ─────────────────────────────────────────────────────────────────────

scheduleRecurringJobs().then(() => {
  logger.info('Worker service started');
}).catch((err) => {
  logger.error({ err }, 'Failed to start worker service');
  process.exit(1);
});

export { queues, webhookWorker, reportWorker, inventoryWorker, emailWorker };
