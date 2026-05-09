// services/api/src/services/shopify.service.ts
// Shopify Admin API client with rate limiting, retry, and full sync support

import Shopify, { DataType } from '@shopify/shopify-api';
import { db } from '../lib/database';
import { createLogger } from '../lib/logger';
import { AppError } from '../lib/errors';
import type { Order, OrderStatus } from '@snackpos/types';

const logger = createLogger('shopify.service');

// ─── Rate Limiter (Shopify: 40 req/s burst, 2 req/s sustained) ───────────────

class ShopifyRateLimiter {
  private queue: Array<() => Promise<unknown>> = [];
  private running = 0;
  private readonly concurrency = 2;
  private readonly minDelay = 500; // ms between requests

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      });
      this.process();
    });
  }

  private async process() {
    if (this.running >= this.concurrency || this.queue.length === 0) return;
    this.running++;
    const task = this.queue.shift()!;
    await task();
    await new Promise(r => setTimeout(r, this.minDelay));
    this.running--;
    this.process();
  }
}

const rateLimiter = new ShopifyRateLimiter();

// ─── Shopify Client Factory ────────────────────────────────────────────────────

function getClient(shopDomain: string, accessToken: string) {
  return new Shopify.Clients.Rest(shopDomain, accessToken);
}

// ─── Retry with exponential backoff ──────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelay = 1000
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const error = err as { response?: { status?: number }; message: string };
      const status = error.response?.status;

      // Retry on 429 (rate limit) and 5xx (server errors)
      if (attempt < maxAttempts && (status === 429 || (status && status >= 500))) {
        const retryAfter = status === 429 ? 2000 : baseDelay * Math.pow(2, attempt);
        logger.warn({ attempt, status, retryAfter }, 'Shopify request failed, retrying');
        await new Promise(r => setTimeout(r, retryAfter));
        continue;
      }

      throw err;
    }
  }
  throw new Error('Unreachable');
}

// ─── Shopify Service ──────────────────────────────────────────────────────────

export class ShopifyService {
  private async getStoreClient(storeId: string) {
    const store = await db('stores')
      .where({ id: storeId, is_active: true })
      .whereNotNull('shopify_shop_domain')
      .whereNotNull('shopify_access_token')
      .first();

    if (!store) {
      throw new AppError('SHOPIFY_NOT_CONNECTED', 'Store not connected to Shopify', 400);
    }

    return {
      client: getClient(store.shopify_shop_domain, store.shopify_access_token),
      store,
    };
  }

  // ─── Order Operations ───────────────────────────────────────────────────────

  async createDraftOrder(order: Order): Promise<{ shopifyOrderId: string; shopifyOrderName: string }> {
    const { client, store } = await this.getStoreClient(order.storeId);

    const lineItems = order.items.map(item => ({
      variant_id: null, // Will use title if no variant ID
      title: item.name,
      quantity: item.quantity,
      price: item.unitPrice.toFixed(2),
      ...(item.variantId ? {} : {}), // Add shopify_variant_id if synced
    }));

    const draftOrderPayload = {
      draft_order: {
        line_items: lineItems,
        note: order.notes ?? undefined,
        tags: `snackpos,${order.type.toLowerCase()}`,
        tax_exempt: false,
        applied_discount: order.discountAmount > 0 ? {
          amount: order.discountAmount.toFixed(2),
          description: order.couponCode ?? 'Discount',
        } : undefined,
        shipping_address: order.deliveryAddress ? {
          address1: order.deliveryAddress.line1,
          address2: order.deliveryAddress.line2 ?? undefined,
          city: order.deliveryAddress.city,
          province: order.deliveryAddress.state,
          zip: order.deliveryAddress.postalCode,
          country: order.deliveryAddress.country,
        } : undefined,
        email: order.customerEmail ?? undefined,
        phone: order.customerPhone ?? undefined,
        note_attributes: [
          { name: 'snackpos_order_id', value: order.id },
          { name: 'snackpos_order_number', value: order.orderNumber },
          { name: 'fulfillment_type', value: order.fulfillmentType },
        ],
      },
    };

    const response = await rateLimiter.execute(() =>
      withRetry(() => client.post({
        path: 'draft_orders',
        data: draftOrderPayload,
        type: DataType.JSON,
      }))
    );

    const draftOrder = (response.body as Record<string, unknown>).draft_order as Record<string, unknown>;

    // Complete the draft order (convert to real order)
    const completeResponse = await rateLimiter.execute(() =>
      withRetry(() => client.put({
        path: `draft_orders/${draftOrder.id}/complete`,
        data: {},
        type: DataType.JSON,
      }))
    );

    const completedOrder = (completeResponse.body as Record<string, unknown>).draft_order as Record<string, unknown>;
    const shopifyOrder = completedOrder.order_id
      ? await this.getShopifyOrder(client, String(completedOrder.order_id))
      : null;

    const shopifyOrderId = String(shopifyOrder?.id ?? draftOrder.id);
    const shopifyOrderName = String(shopifyOrder?.name ?? draftOrder.name ?? '');

    // Update our order with Shopify IDs
    await db('orders').where({ id: order.id }).update({
      shopify_order_id: shopifyOrderId,
      shopify_order_name: shopifyOrderName,
    });

    return { shopifyOrderId, shopifyOrderName };
  }

  private async getShopifyOrder(client: ReturnType<typeof getClient>, orderId: string) {
    const response = await rateLimiter.execute(() =>
      withRetry(() => client.get({ path: `orders/${orderId}` }))
    );
    return (response.body as Record<string, unknown>).order as Record<string, unknown>;
  }

  async syncOrderStatus(shopifyOrderId: string, status: OrderStatus): Promise<void> {
    // Load store by Shopify order
    const order = await db('orders').where({ shopify_order_id: shopifyOrderId }).first();
    if (!order) return;

    const { client } = await this.getStoreClient(order.store_id);

    // Map our status to Shopify fulfillment actions
    if (['DELIVERED', 'PICKED_UP'].includes(status)) {
      // Create fulfillment
      await rateLimiter.execute(() =>
        withRetry(() => client.post({
          path: `orders/${shopifyOrderId}/fulfillments`,
          data: {
            fulfillment: {
              location_id: null, // Will use default
              notify_customer: true,
            },
          },
          type: DataType.JSON,
        }))
      ).catch(err => {
        logger.error({ err, shopifyOrderId }, 'Failed to create Shopify fulfillment');
      });
    }

    if (status === 'CANCELLED') {
      await rateLimiter.execute(() =>
        withRetry(() => client.post({
          path: `orders/${shopifyOrderId}/cancel`,
          data: { reason: 'customer' },
          type: DataType.JSON,
        }))
      ).catch(err => {
        logger.error({ err, shopifyOrderId }, 'Failed to cancel Shopify order');
      });
    }
  }

  async createRefund(shopifyOrderId: string, refundData: { amount: number; reason: string }): Promise<void> {
    const order = await db('orders').where({ shopify_order_id: shopifyOrderId }).first();
    if (!order) return;

    const { client, store } = await this.getStoreClient(order.store_id);

    await rateLimiter.execute(() =>
      withRetry(() => client.post({
        path: `orders/${shopifyOrderId}/refunds`,
        data: {
          refund: {
            note: refundData.reason,
            transactions: [{
              kind: 'refund',
              gateway: 'manual',
              amount: refundData.amount.toFixed(2),
            }],
          },
        },
        type: DataType.JSON,
      }))
    );
  }

  // ─── Product Sync ────────────────────────────────────────────────────────────

  async syncFromShopify(storeId: string, shopifyProduct: Record<string, unknown>): Promise<void> {
    const store = await db('stores').where({ id: storeId }).first();
    if (!store) return;

    const shopifyProductId = String(shopifyProduct.id);
    const existing = await db('products')
      .where({ store_id: storeId, shopify_product_id: shopifyProductId })
      .first();

    const variants = (shopifyProduct.variants as Record<string, unknown>[]) ?? [];
    const images = (shopifyProduct.images as Record<string, unknown>[]) ?? [];

    const productData = {
      store_id: storeId,
      shopify_product_id: shopifyProductId,
      name: shopifyProduct.title as string,
      slug: this.slugify(shopifyProduct.title as string),
      description: shopifyProduct.body_html as string ?? null,
      image_urls: JSON.stringify(images.map((img: Record<string, unknown>) => img.src as string)),
      base_price: variants[0] ? parseFloat(variants[0].price as string) : 0,
      is_active: shopifyProduct.status === 'active',
      tags: JSON.stringify(String(shopifyProduct.tags ?? '').split(',').map((t: string) => t.trim()).filter(Boolean)),
      updated_at: new Date(),
    };

    if (existing) {
      await db('products').where({ id: existing.id }).update(productData);

      // Sync variants
      for (const variant of variants) {
        await this.syncVariant(storeId, existing.id, variant);
      }
    } else {
      // Find or create category from Shopify product_type
      let categoryId: string | null = null;
      if (shopifyProduct.product_type) {
        const category = await db('categories')
          .where({ store_id: storeId, name: shopifyProduct.product_type })
          .first();

        if (category) {
          categoryId = category.id;
        } else {
          const [newCat] = await db('categories').insert({
            store_id: storeId,
            name: shopifyProduct.product_type,
            slug: this.slugify(shopifyProduct.product_type as string),
          }).returning('id');
          categoryId = newCat.id;
        }
      }

      const [product] = await db('products').insert({
        ...productData,
        category_id: categoryId,
      }).returning('*');

      for (const variant of variants) {
        await this.syncVariant(storeId, product.id, variant);
      }
    }

    logger.info({ shopifyProductId, storeId }, 'Product synced from Shopify');
  }

  private async syncVariant(
    storeId: string,
    productId: string,
    variant: Record<string, unknown>
  ): Promise<void> {
    const shopifyVariantId = String(variant.id);
    const existing = await db('product_variants')
      .where({ product_id: productId, shopify_variant_id: shopifyVariantId })
      .first();

    const options: Record<string, string> = {};
    if (variant.option1) options.option1 = variant.option1 as string;
    if (variant.option2) options.option2 = variant.option2 as string;
    if (variant.option3) options.option3 = variant.option3 as string;

    const variantData = {
      product_id: productId,
      shopify_variant_id: shopifyVariantId,
      name: [variant.option1, variant.option2, variant.option3]
        .filter(Boolean).join(' / ') || 'Default',
      sku: variant.sku as string ?? null,
      barcode: variant.barcode as string ?? null,
      price: parseFloat(variant.price as string ?? '0'),
      compare_at_price: variant.compare_at_price ? parseFloat(variant.compare_at_price as string) : null,
      inventory_quantity: parseInt(variant.inventory_quantity as string ?? '0', 10),
      options: JSON.stringify({
        ...options,
        shopifyInventoryItemId: String(variant.inventory_item_id ?? ''),
      }),
      updated_at: new Date(),
    };

    if (existing) {
      await db('product_variants').where({ id: existing.id }).update(variantData);
    } else {
      await db('product_variants').insert(variantData);
    }

    // Sync inventory item
    const variantRow = existing ?? await db('product_variants')
      .where({ product_id: productId, shopify_variant_id: shopifyVariantId })
      .first();

    if (variantRow && variant.inventory_quantity !== undefined) {
      await db('inventory_items')
        .insert({
          store_id: storeId,
          variant_id: variantRow.id,
          quantity: parseInt(variant.inventory_quantity as string ?? '0', 10),
          reserved_quantity: 0,
          low_stock_threshold: 5,
          reorder_point: 10,
          reorder_quantity: 50,
        })
        .onConflict(['store_id', 'variant_id'])
        .merge({ quantity: parseInt(variant.inventory_quantity as string ?? '0', 10) });
    }
  }

  // ─── Full Sync Operations ────────────────────────────────────────────────────

  async syncAllProducts(storeId: string, cursor?: string): Promise<void> {
    const { client, store } = await this.getStoreClient(storeId);

    let pageInfo = cursor;
    let hasMore = true;
    let synced = 0;

    while (hasMore) {
      const response = await rateLimiter.execute(() =>
        withRetry(() => client.get({
          path: 'products',
          query: {
            limit: '50',
            fields: 'id,title,body_html,vendor,product_type,status,tags,variants,images',
            ...(pageInfo ? { page_info: pageInfo } : {}),
          },
        }))
      );

      const products = (response.body as Record<string, unknown>).products as Record<string, unknown>[];

      for (const product of products) {
        await this.syncFromShopify(storeId, product).catch(err => {
          logger.error({ err, productId: product.id }, 'Failed to sync product');
        });
        synced++;
      }

      // Check for next page
      const linkHeader = response.headers?.link as string ?? '';
      const nextMatch = linkHeader.match(/<[^>]+page_info=([^&>]+)[^>]*>;\s*rel="next"/);
      if (nextMatch) {
        pageInfo = nextMatch[1];
      } else {
        hasMore = false;
      }
    }

    logger.info({ storeId, synced }, 'Shopify product sync complete');
  }

  async syncAllInventory(storeId: string): Promise<void> {
    const { client, store } = await this.getStoreClient(storeId);

    // Get all inventory items
    let pageInfo: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const response = await rateLimiter.execute(() =>
        withRetry(() => client.get({
          path: 'inventory_levels',
          query: {
            limit: '250',
            ...(pageInfo ? { page_info: pageInfo } : {}),
          },
        }))
      );

      const levels = (response.body as Record<string, unknown>).inventory_levels as Record<string, unknown>[];

      for (const level of levels) {
        const variant = await db('product_variants')
          .whereRaw("(options->>'shopifyInventoryItemId') = ?", [String(level.inventory_item_id)])
          .first();

        if (variant) {
          await db('inventory_items')
            .where({ store_id: storeId, variant_id: variant.id })
            .update({ quantity: parseInt(level.available as string ?? '0', 10) });

          await db('product_variants')
            .where({ id: variant.id })
            .update({ inventory_quantity: parseInt(level.available as string ?? '0', 10) });
        }
      }

      const linkHeader = response.headers?.link as string ?? '';
      const nextMatch = linkHeader.match(/<[^>]+page_info=([^&>]+)[^>]*>;\s*rel="next"/);
      if (nextMatch) {
        pageInfo = nextMatch[1];
      } else {
        hasMore = false;
      }
    }

    logger.info({ storeId }, 'Shopify inventory sync complete');
  }

  async syncAllCustomers(storeId: string, cursor?: string): Promise<void> {
    const { client } = await this.getStoreClient(storeId);

    let pageInfo = cursor;
    let hasMore = true;
    let synced = 0;

    while (hasMore) {
      const response = await rateLimiter.execute(() =>
        withRetry(() => client.get({
          path: 'customers',
          query: {
            limit: '250',
            fields: 'id,first_name,last_name,email,phone,default_address,accepts_marketing,tags',
            ...(pageInfo ? { page_info: pageInfo } : {}),
          },
        }))
      );

      const customers = (response.body as Record<string, unknown>).customers as Record<string, unknown>[];

      for (const customer of customers) {
        const existing = await db('customers')
          .where({ store_id: storeId, shopify_customer_id: String(customer.id) })
          .first();

        const addr = customer.default_address as Record<string, unknown> | null;
        const customerData = {
          store_id: storeId,
          shopify_customer_id: String(customer.id),
          first_name: customer.first_name as string ?? '',
          last_name: customer.last_name as string ?? '',
          email: customer.email as string ?? null,
          phone: customer.phone as string ?? null,
          accepts_marketing: Boolean(customer.accepts_marketing),
          default_address: addr ? JSON.stringify({
            line1: addr.address1,
            city: addr.city,
            state: addr.province,
            postalCode: addr.zip,
            country: addr.country,
          }) : null,
        };

        if (existing) {
          await db('customers').where({ id: existing.id }).update(customerData);
        } else {
          await db('customers').insert(customerData).onConflict(['store_id', 'shopify_customer_id']).merge();
        }
        synced++;
      }

      const linkHeader = response.headers?.link as string ?? '';
      const nextMatch = linkHeader.match(/<[^>]+page_info=([^&>]+)[^>]*>;\s*rel="next"/);
      if (nextMatch) {
        pageInfo = nextMatch[1];
      } else {
        hasMore = false;
      }
    }

    logger.info({ storeId, synced }, 'Shopify customer sync complete');
  }

  // ─── Connect store to Shopify (OAuth flow) ────────────────────────────────

  async generateInstallUrl(shop: string, scopes: string, redirectUri: string): Promise<string> {
    const nonce = crypto.randomUUID();
    const scopeList = scopes || 'read_products,write_products,read_orders,write_orders,read_inventory,write_inventory,read_customers,write_customers';

    return `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=${scopeList}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${nonce}`;
  }

  async completeOAuth(
    storeId: string,
    shop: string,
    code: string,
    hmac: string,
    state: string
  ): Promise<{ accessToken: string; shopDomain: string }> {
    // Exchange code for access token
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code,
      }),
    });

    if (!response.ok) throw new AppError('SHOPIFY_AUTH_FAILED', 'Failed to get Shopify access token', 400);

    const { access_token: accessToken } = await response.json() as { access_token: string };

    // Generate webhook secret
    const webhookSecret = crypto.randomUUID();

    // Save to store
    await db('stores').where({ id: storeId }).update({
      shopify_shop_domain: shop,
      shopify_access_token: accessToken,
      shopify_webhook_secret: webhookSecret,
    });

    // Register webhooks
    await this.registerWebhooks(shop, accessToken);

    // Trigger initial sync
    await Promise.all([
      this.syncAllProducts(storeId),
      this.syncAllCustomers(storeId),
      this.syncAllInventory(storeId),
    ]);

    return { accessToken, shopDomain: shop };
  }

  private async registerWebhooks(shop: string, accessToken: string): Promise<void> {
    const client = getClient(shop, accessToken);
    const callbackUrl = `${process.env.API_PUBLIC_URL}/api/webhooks/shopify`;

    const topics = [
      'orders/create', 'orders/updated', 'orders/paid',
      'orders/cancelled', 'orders/fulfilled', 'orders/refunds/create',
      'products/create', 'products/update', 'products/delete',
      'inventory_levels/update',
      'customers/create', 'customers/update',
      'shop/redact', 'customers/redact',
    ];

    for (const topic of topics) {
      await rateLimiter.execute(() =>
        withRetry(() => client.post({
          path: 'webhooks',
          data: {
            webhook: {
              topic,
              address: callbackUrl,
              format: 'json',
            },
          },
          type: DataType.JSON,
        }))
      ).catch(err => {
        logger.error({ err, topic }, 'Failed to register webhook');
      });
    }

    logger.info({ shop, topics: topics.length }, 'Shopify webhooks registered');
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  private slugify(str: string): string {
    return str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 100);
  }
}

export const shopifyService = new ShopifyService();
