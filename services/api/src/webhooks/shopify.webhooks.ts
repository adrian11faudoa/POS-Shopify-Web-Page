// services/api/src/webhooks/shopify.webhooks.ts
// Production Shopify webhook handlers with HMAC verification

import crypto from 'crypto';
import type { Request, Response } from 'express';
import { db } from '../lib/database';
import { eventBus } from '../lib/event-bus';
import { orderService } from '../services/order.service';
import { inventoryService } from '../services/inventory.service';
import { productService } from '../services/product.service';
import { createLogger } from '../lib/logger';
import { AppError } from '../lib/errors';
import type { Router } from 'express';
import express from 'express';

const logger = createLogger('shopify.webhooks');

// ─── HMAC Verification ────────────────────────────────────────────────────────

function verifyShopifyWebhook(rawBody: Buffer, signature: string, secret: string): boolean {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const digest = hmac.digest('base64');
  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

// ─── Webhook Middleware ───────────────────────────────────────────────────────

async function shopifyWebhookMiddleware(req: Request, res: Response, next: () => void) {
  const shopDomain = req.headers['x-shopify-shop-domain'] as string;
  const topic = req.headers['x-shopify-topic'] as string;
  const signature = req.headers['x-shopify-hmac-sha256'] as string;
  const webhookId = req.headers['x-shopify-webhook-id'] as string;

  if (!shopDomain || !topic || !signature) {
    return res.status(400).json({ error: 'Missing Shopify headers' });
  }

  // Load store by Shopify domain
  const store = await db('stores')
    .where({ shopify_shop_domain: shopDomain, is_active: true })
    .first();

  if (!store) {
    logger.warn({ shopDomain }, 'Webhook from unknown Shopify shop');
    // Return 200 to prevent Shopify retries for unknown shops
    return res.status(200).json({ received: true });
  }

  // Verify HMAC
  const rawBody = req.body as Buffer;
  const secret = store.shopify_webhook_secret;

  if (!verifyShopifyWebhook(rawBody, signature, secret)) {
    logger.error({ shopDomain, topic }, 'Invalid Shopify webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Parse body
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  // Check idempotency
  if (webhookId) {
    const existing = await db('webhook_events')
      .where({ shopify_id: webhookId })
      .first();
    if (existing?.status === 'PROCESSED') {
      logger.info({ webhookId }, 'Duplicate webhook, skipping');
      return res.status(200).json({ received: true, duplicate: true });
    }
  }

  // Log webhook event
  const [event] = await db('webhook_events').insert({
    store_id: store.id,
    source: 'shopify',
    topic,
    shopify_id: webhookId ?? null,
    payload: JSON.stringify(payload),
    signature,
    status: 'PENDING',
  }).returning('*');

  // Attach to request
  (req as Record<string, unknown>).shopifyStore = store;
  (req as Record<string, unknown>).webhookPayload = payload;
  (req as Record<string, unknown>).webhookEventId = event.id;

  // Always respond 200 immediately (Shopify expects < 5s response)
  res.status(200).json({ received: true });

  // Process asynchronously (next() after response)
  next();
}

// ─── Topic Handlers ───────────────────────────────────────────────────────────

const handlers: Record<string, (store: Record<string, unknown>, payload: Record<string, unknown>) => Promise<void>> = {
  'orders/create': handleOrderCreate,
  'orders/updated': handleOrderUpdate,
  'orders/paid': handleOrderPaid,
  'orders/cancelled': handleOrderCancelled,
  'orders/fulfilled': handleOrderFulfilled,
  'orders/refunds/create': handleRefundCreate,
  'products/create': handleProductCreate,
  'products/update': handleProductUpdate,
  'products/delete': handleProductDelete,
  'inventory_levels/update': handleInventoryUpdate,
  'customers/create': handleCustomerCreate,
  'customers/update': handleCustomerUpdate,
  'shop/redact': handleShopRedact,
  'customers/redact': handleCustomerRedact,
};

async function handleOrderCreate(
  store: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<void> {
  const shopifyOrderId = String(payload.id);
  const storeId = store.id as string;

  // Check if we already have this order (could have been created via our API)
  const existing = await db('orders')
    .where({ store_id: storeId, shopify_order_id: shopifyOrderId })
    .first();

  if (existing) {
    logger.info({ shopifyOrderId }, 'Order already exists, updating Shopify IDs only');
    await db('orders').where({ id: existing.id }).update({
      shopify_order_name: payload.name,
    });
    return;
  }

  // Map Shopify order to our order format
  const shopifyLineItems = (payload.line_items as unknown[]) ?? [];
  const customer = payload.customer as Record<string, unknown> | null;
  const shippingAddress = payload.shipping_address as Record<string, unknown> | null;

  const items = shopifyLineItems.map((li: Record<string, unknown>) => ({
    // Try to match by Shopify variant ID
    productId: null, // will be resolved
    shopifyVariantId: String(li.variant_id ?? ''),
    name: li.name as string,
    quantity: li.quantity as number,
    unitPrice: parseFloat(li.price as string),
  }));

  // Resolve product IDs from Shopify variant IDs
  const resolvedItems = await Promise.all(items.map(async (item) => {
    const variant = await db('product_variants')
      .where({ shopify_variant_id: item.shopifyVariantId })
      .first();
    const product = variant
      ? await db('products').where({ id: variant.product_id }).first()
      : null;

    return {
      productId: product?.id ?? null,
      variantId: variant?.id ?? null,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      total: item.unitPrice * item.quantity,
    };
  }));

  const subtotal = parseFloat(payload.subtotal_price as string);
  const taxAmount = parseFloat(payload.total_tax as string);
  const total = parseFloat(payload.total_price as string);
  const discountCodes = (payload.discount_codes as unknown[]) ?? [];

  await db('orders').insert({
    store_id: storeId,
    order_number: `SHF-${payload.order_number}`,
    shopify_order_id: shopifyOrderId,
    shopify_order_name: payload.name,
    status: 'CONFIRMED',
    type: 'SHOPIFY',
    fulfillment_type: shippingAddress ? 'DELIVERY' : 'PICKUP',
    customer_name: customer
      ? `${customer.first_name} ${customer.last_name}`.trim()
      : (payload.contact_email as string),
    customer_email: customer?.email as string ?? payload.email as string ?? null,
    customer_phone: customer?.phone as string ?? null,
    delivery_address: shippingAddress ? JSON.stringify({
      line1: shippingAddress.address1,
      line2: shippingAddress.address2,
      city: shippingAddress.city,
      state: shippingAddress.province,
      postalCode: shippingAddress.zip,
      country: shippingAddress.country,
    }) : null,
    subtotal,
    tax_amount: taxAmount,
    discount_amount: parseFloat(payload.total_discounts as string ?? '0'),
    delivery_fee: 0,
    total,
    coupon_code: discountCodes.length > 0
      ? (discountCodes[0] as Record<string, unknown>).code as string
      : null,
    confirmed_at: new Date(),
    metadata: JSON.stringify({ shopifySource: true }),
  });

  // Insert order items
  if (resolvedItems.length > 0) {
    await db('order_items').insert(resolvedItems.map(item => ({
      order_id: db('orders').where({ store_id: storeId, shopify_order_id: shopifyOrderId }).select('id'),
      product_id: item.productId,
      variant_id: item.variantId,
      name: item.name,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      discount_amount: 0,
      tax_amount: 0,
      total: item.total,
      modifiers: '[]',
      status: 'PENDING',
    })));
  }

  // Emit realtime event
  eventBus.emit('order:created', {
    storeId,
    order: await db('orders').where({ store_id: storeId, shopify_order_id: shopifyOrderId }).first(),
  });

  logger.info({ shopifyOrderId, storeId }, 'Shopify order created successfully');
}

async function handleOrderUpdate(
  store: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<void> {
  const shopifyOrderId = String(payload.id);
  const order = await db('orders')
    .where({ store_id: store.id, shopify_order_id: shopifyOrderId })
    .first();

  if (!order) return;

  // Sync financial/fulfillment status changes
  const financialStatus = payload.financial_status as string;
  const fulfillmentStatus = payload.fulfillment_status as string;

  const statusMap: Record<string, string> = {
    'paid': 'CONFIRMED',
    'refunded': 'REFUNDED',
    'partially_refunded': 'CONFIRMED',
    'fulfilled': 'DELIVERED',
    'partial': 'PREPARING',
  };

  const newStatus = statusMap[fulfillmentStatus] ?? statusMap[financialStatus];
  if (newStatus && newStatus !== order.status) {
    await db('orders').where({ id: order.id }).update({ status: newStatus });
    eventBus.emit('order:status_changed', {
      storeId: store.id,
      orderId: order.id,
      orderNumber: order.order_number,
      previousStatus: order.status,
      newStatus,
      timestamp: new Date(),
    });
  }
}

async function handleOrderPaid(
  store: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<void> {
  const shopifyOrderId = String(payload.id);
  await db('orders')
    .where({ store_id: store.id, shopify_order_id: shopifyOrderId })
    .update({ status: 'CONFIRMED', confirmed_at: new Date() });
}

async function handleOrderCancelled(
  store: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<void> {
  const shopifyOrderId = String(payload.id);
  const order = await db('orders')
    .where({ store_id: store.id, shopify_order_id: shopifyOrderId })
    .first();
  if (!order) return;

  await db('orders').where({ id: order.id }).update({
    status: 'CANCELLED',
    cancelled_at: new Date(),
    cancelled_reason: payload.cancel_reason as string ?? 'Cancelled via Shopify',
  });

  await inventoryService.releaseReservation(db, store.id as string, order.id);
}

async function handleOrderFulfilled(
  store: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<void> {
  const shopifyOrderId = String(payload.id);
  await db('orders')
    .where({ store_id: store.id, shopify_order_id: shopifyOrderId })
    .update({ status: 'DELIVERED', completed_at: new Date() });
}

async function handleRefundCreate(
  store: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<void> {
  const shopifyOrderId = String((payload as Record<string, unknown>).order_id ?? payload.id);
  const order = await db('orders')
    .where({ store_id: store.id, shopify_order_id: shopifyOrderId })
    .first();

  if (!order) return;

  const refundTransactions = (payload.transactions as unknown[]) ?? [];
  for (const txn of refundTransactions) {
    const t = txn as Record<string, unknown>;
    if (t.kind === 'refund') {
      const payment = await db('payments')
        .where({ order_id: order.id, shopify_transaction_id: String(t.parent_id ?? '') })
        .first();

      await db('refunds').insert({
        order_id: order.id,
        payment_id: payment?.id,
        amount: parseFloat(t.amount as string),
        reason: payload.note as string ?? 'Shopify refund',
        shopify_refund_id: String(t.id),
        processed_by: null,
      });
    }
  }
}

async function handleProductCreate(
  store: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<void> {
  await productService.syncFromShopify(store.id as string, payload);
}

async function handleProductUpdate(
  store: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<void> {
  await productService.syncFromShopify(store.id as string, payload);
}

async function handleProductDelete(
  store: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<void> {
  await db('products')
    .where({ store_id: store.id, shopify_product_id: String(payload.id) })
    .update({ deleted_at: new Date(), is_active: false });
}

async function handleInventoryUpdate(
  store: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<void> {
  const shopifyInventoryItemId = String(payload.inventory_item_id);
  const available = parseInt(payload.available as string, 10);

  // Find our variant by Shopify inventory item ID (stored in variant metadata)
  const variant = await db('product_variants')
    .whereRaw("(options->>'shopifyInventoryItemId') = ?", [shopifyInventoryItemId])
    .first();

  if (!variant) return;

  const invItem = await db('inventory_items')
    .where({ store_id: store.id, variant_id: variant.id })
    .first();

  if (!invItem) return;

  const previousQuantity = invItem.quantity;
  await db('inventory_items')
    .where({ id: invItem.id })
    .update({ quantity: available });

  await db('product_variants')
    .where({ id: variant.id })
    .update({ inventory_quantity: available });

  eventBus.emit('inventory:updated', {
    storeId: store.id,
    variantId: variant.id,
    previousQuantity,
    newQuantity: available,
    alert: available <= 0 ? 'OUT_OF_STOCK' : available <= invItem.low_stock_threshold ? 'LOW_STOCK' : null,
  });
}

async function handleCustomerCreate(
  store: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<void> {
  const existing = await db('customers')
    .where({ store_id: store.id, shopify_customer_id: String(payload.id) })
    .first();
  if (existing) return;

  const addr = (payload.default_address as Record<string, unknown> | null);
  await db('customers').insert({
    store_id: store.id,
    shopify_customer_id: String(payload.id),
    first_name: payload.first_name as string ?? '',
    last_name: payload.last_name as string ?? '',
    email: payload.email as string ?? null,
    phone: payload.phone as string ?? null,
    accepts_marketing: payload.accepts_marketing as boolean ?? false,
    default_address: addr ? JSON.stringify({
      line1: addr.address1,
      line2: addr.address2,
      city: addr.city,
      state: addr.province,
      postalCode: addr.zip,
      country: addr.country,
    }) : null,
  });
}

async function handleCustomerUpdate(
  store: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<void> {
  await db('customers')
    .where({ store_id: store.id, shopify_customer_id: String(payload.id) })
    .update({
      first_name: payload.first_name as string,
      last_name: payload.last_name as string,
      email: payload.email as string ?? null,
      phone: payload.phone as string ?? null,
      accepts_marketing: payload.accepts_marketing as boolean,
    });
}

// GDPR compliance handlers
async function handleShopRedact(
  store: Record<string, unknown>,
  _payload: Record<string, unknown>
): Promise<void> {
  logger.info({ storeId: store.id }, 'Shop redact request received');
  // In production: anonymize/delete all store data per GDPR requirements
}

async function handleCustomerRedact(
  store: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<void> {
  const shopifyCustomerId = String(payload.customer?.id ?? '');
  logger.info({ storeId: store.id, shopifyCustomerId }, 'Customer redact request received');

  // Anonymize customer data
  await db('customers')
    .where({ store_id: store.id, shopify_customer_id: shopifyCustomerId })
    .update({
      email: null,
      phone: null,
      first_name: '[REDACTED]',
      last_name: '[REDACTED]',
      default_address: null,
    });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const shopifyWebhookRouter: Router = express.Router();

shopifyWebhookRouter.post('/shopify', async (req: Request, res: Response, next) => {
  const topic = req.headers['x-shopify-topic'] as string;
  const store = (req as Record<string, unknown>).shopifyStore as Record<string, unknown>;
  const payload = (req as Record<string, unknown>).webhookPayload as Record<string, unknown>;
  const eventId = (req as Record<string, unknown>).webhookEventId as string;

  const handler = handlers[topic];
  if (!handler) {
    logger.warn({ topic }, 'No handler for Shopify webhook topic');
    await db('webhook_events').where({ id: eventId }).update({ status: 'IGNORED' });
    return;
  }

  try {
    await handler(store, payload);
    await db('webhook_events').where({ id: eventId }).update({
      status: 'PROCESSED',
      processed_at: new Date(),
    });
  } catch (err) {
    const error = err as Error;
    logger.error({ err, topic, eventId }, 'Webhook handler error');
    await db('webhook_events').where({ id: eventId }).update({
      status: 'FAILED',
      error: error.message,
    });
  }
});

// Apply middleware before the route handler at the router level
shopifyWebhookRouter.use(shopifyWebhookMiddleware as express.RequestHandler);
