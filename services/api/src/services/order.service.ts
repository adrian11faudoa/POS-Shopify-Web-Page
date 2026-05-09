// services/api/src/services/order.service.ts
// Core order management with transaction safety and event emission

import { db } from '../lib/database';
import { redis } from '../lib/redis';
import { eventBus } from '../lib/event-bus';
import { shopifyService } from './shopify.service';
import { inventoryService } from './inventory.service';
import { couponService } from './coupon.service';
import { printService } from './print.service';
import { createLogger } from '../lib/logger';
import { AppError } from '../lib/errors';
import type {
  Order, OrderItem, OrderStatus, CreateOrderInput,
  UpdateOrderStatusInput, RefundOrderInput, OrderType,
  FulfillmentType, Payment, PaymentMethod,
} from '@snackpos/types';

const logger = createLogger('order.service');

// ─── Input Types ──────────────────────────────────────────────────────────────

export interface CreateOrderInput {
  storeId: string;
  type: OrderType;
  fulfillmentType: FulfillmentType;
  items: CreateOrderItemInput[];
  customerId?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  deliveryAddress?: Address;
  notes?: string;
  couponCode?: string;
  tip?: number;
  scheduledAt?: Date;
  tableNumber?: string;
  posTerminalId?: string;
  assignedEmployeeId?: string;
  payments?: CreatePaymentInput[];
  idempotencyKey?: string;
}

export interface CreateOrderItemInput {
  productId: string;
  variantId?: string;
  quantity: number;
  modifiers?: { modifierId: string }[];
  notes?: string;
}

export interface CreatePaymentInput {
  method: PaymentMethod;
  amount: number;
  cashTendered?: number;
  stripePaymentIntentId?: string;
}

// ─── Order Service ────────────────────────────────────────────────────────────

export class OrderService {
  async createOrder(input: CreateOrderInput, employeeId?: string): Promise<Order> {
    // Idempotency check
    if (input.idempotencyKey) {
      const cached = await redis.get(`idempotency:${input.idempotencyKey}`);
      if (cached) {
        logger.info({ idempotencyKey: input.idempotencyKey }, 'Returning cached order');
        return JSON.parse(cached) as Order;
      }
    }

    return await db.transaction(async (trx) => {
      // 1. Load store config
      const store = await trx('stores').where({ id: input.storeId }).first();
      if (!store) throw new AppError('STORE_NOT_FOUND', 'Store not found', 404);

      // 2. Resolve and validate items
      const resolvedItems = await this.resolveOrderItems(trx, input.storeId, input.items);

      // 3. Validate coupon if provided
      let couponDiscount = 0;
      let appliedCoupon = null;
      if (input.couponCode) {
        const couponResult = await couponService.validateAndApply(
          trx, input.storeId, input.couponCode,
          resolvedItems, input.customerId
        );
        couponDiscount = couponResult.discountAmount;
        appliedCoupon = couponResult.coupon;
      }

      // 4. Calculate totals
      const subtotal = resolvedItems.reduce((sum, item) => sum + item.total, 0);
      const deliveryFee = input.fulfillmentType === 'DELIVERY'
        ? store.settings.deliveryFee ?? 0
        : 0;
      const taxAmount = store.settings.taxIncluded
        ? 0
        : Math.round(subtotal * store.settings.taxRate * 100) / 100;
      const tip = input.tip ?? 0;
      const total = subtotal - couponDiscount + taxAmount + deliveryFee + tip;

      // 5. Generate order number
      const orderNumber = await this.generateOrderNumber(trx, store.slug);

      // 6. Insert order
      const [order] = await trx('orders').insert({
        store_id: input.storeId,
        order_number: orderNumber,
        type: input.type,
        fulfillment_type: input.fulfillmentType,
        status: store.settings.autoConfirmOrders ? 'CONFIRMED' : 'PENDING',
        customer_id: input.customerId ?? null,
        customer_name: input.customerName ?? null,
        customer_email: input.customerEmail ?? null,
        customer_phone: input.customerPhone ?? null,
        delivery_address: input.deliveryAddress ? JSON.stringify(input.deliveryAddress) : null,
        notes: input.notes ?? null,
        coupon_code: input.couponCode ?? null,
        subtotal,
        tax_amount: taxAmount,
        discount_amount: couponDiscount,
        delivery_fee: deliveryFee,
        tip,
        total,
        scheduled_at: input.scheduledAt ?? null,
        table_number: input.tableNumber ?? null,
        pos_terminal_id: input.posTerminalId ?? null,
        assigned_employee_id: input.assignedEmployeeId ?? null,
        confirmed_at: store.settings.autoConfirmOrders ? new Date() : null,
      }).returning('*');

      // 7. Insert order items
      const itemInserts = resolvedItems.map(item => ({
        order_id: order.id,
        product_id: item.productId,
        variant_id: item.variantId ?? null,
        name: item.name,
        variant_name: item.variantName ?? null,
        sku: item.sku ?? null,
        quantity: item.quantity,
        unit_price: item.unitPrice,
        discount_amount: 0,
        tax_amount: store.settings.taxIncluded ? 0 : item.total * store.settings.taxRate,
        total: item.total,
        modifiers: JSON.stringify(item.modifiers),
        notes: item.notes ?? null,
        status: 'PENDING',
      }));

      const insertedItems = await trx('order_items').insert(itemInserts).returning('*');

      // 8. Reserve inventory
      await inventoryService.reserveForOrder(
        trx,
        input.storeId,
        order.id,
        resolvedItems.map(i => ({ variantId: i.variantId!, quantity: i.quantity }))
          .filter(i => i.variantId)
      );

      // 9. Process payments if provided (POS cash sale)
      if (input.payments?.length) {
        await this.processPayments(trx, order.id, input.payments);
      }

      // 10. Update coupon usage
      if (appliedCoupon) {
        await trx('coupons')
          .where({ id: appliedCoupon.id })
          .increment('usage_count', 1);
      }

      // 11. Update customer stats
      if (input.customerId) {
        await trx('customers')
          .where({ id: input.customerId })
          .increment('total_orders', 1)
          .increment('total_spent', total)
          .update({ last_order_at: new Date() });
      }

      const fullOrder = await this.getOrderById(trx, order.id);

      // 12. Audit log
      await this.createAuditLog(trx, {
        storeId: input.storeId,
        employeeId,
        action: 'CREATE',
        resourceType: 'order',
        resourceId: order.id,
        newValue: { orderNumber, total, status: order.status },
      });

      // 13. Cache idempotency result
      if (input.idempotencyKey) {
        await redis.setex(
          `idempotency:${input.idempotencyKey}`,
          3600,
          JSON.stringify(fullOrder)
        );
      }

      return fullOrder;
    }).then(async (order) => {
      // Post-transaction side effects (non-atomic)
      await this.postOrderCreation(order);
      return order;
    });
  }

  private async postOrderCreation(order: Order): Promise<void> {
    try {
      // Emit realtime event
      eventBus.emit('order:created', { storeId: order.storeId, order });

      // Send to KDS
      eventBus.emit('kds:order', {
        storeId: order.storeId,
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          items: order.items,
          type: order.type,
          notes: order.notes,
          createdAt: order.createdAt,
        },
      });

      // Sync to Shopify if it's an online order (not already from Shopify)
      if (order.type === 'ONLINE' && !order.shopifyOrderId) {
        await shopifyService.createDraftOrder(order).catch(err => {
          logger.error({ err, orderId: order.id }, 'Failed to sync order to Shopify');
        });
      }

      // Print receipt if POS order with printer configured
      if (order.type === 'POS' && order.posTerminalId) {
        await printService.printReceipt(order).catch(err => {
          logger.error({ err, orderId: order.id }, 'Failed to print receipt');
        });
      }
    } catch (err) {
      logger.error({ err, orderId: order.id }, 'Error in post-order creation');
    }
  }

  async updateOrderStatus(
    orderId: string,
    input: UpdateOrderStatusInput,
    employeeId: string
  ): Promise<Order> {
    const order = await this.getOrderById(db, orderId);
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);

    const validTransitions = this.getValidTransitions(order.status);
    if (!validTransitions.includes(input.status)) {
      throw new AppError(
        'INVALID_STATUS_TRANSITION',
        `Cannot transition from ${order.status} to ${input.status}`,
        400
      );
    }

    const timestampField = this.getStatusTimestampField(input.status);
    const updateData: Record<string, unknown> = {
      status: input.status,
      internal_notes: input.internalNotes ?? order.internalNotes,
    };
    if (timestampField) updateData[timestampField] = new Date();
    if (input.status === 'CANCELLED') {
      updateData.cancelled_reason = input.reason ?? null;
    }

    await db('orders').where({ id: orderId }).update(updateData);

    const updatedOrder = await this.getOrderById(db, orderId);

    // Release inventory on cancellation
    if (input.status === 'CANCELLED') {
      await inventoryService.releaseReservation(db, order.storeId, orderId);
    }

    // Deduct inventory on completion
    if (['DELIVERED', 'PICKED_UP'].includes(input.status)) {
      await inventoryService.commitReservation(db, order.storeId, orderId, employeeId);
    }

    await this.createAuditLog(db, {
      storeId: order.storeId,
      employeeId,
      action: input.status === 'CANCELLED' ? 'CANCEL' : 'UPDATE',
      resourceType: 'order',
      resourceId: orderId,
      previousValue: { status: order.status },
      newValue: { status: input.status },
    });

    eventBus.emit('order:status_changed', {
      storeId: order.storeId,
      orderId,
      orderNumber: order.orderNumber,
      previousStatus: order.status,
      newStatus: input.status,
      timestamp: new Date(),
    });

    // Sync status back to Shopify
    if (order.shopifyOrderId) {
      await shopifyService.syncOrderStatus(order.shopifyOrderId, input.status).catch(err => {
        logger.error({ err, orderId }, 'Failed to sync status to Shopify');
      });
    }

    return updatedOrder;
  }

  async refundOrder(
    orderId: string,
    input: RefundOrderInput,
    employeeId: string
  ): Promise<Order> {
    const order = await this.getOrderById(db, orderId);
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);

    const payment = order.payments.find(p =>
      ['CAPTURED', 'AUTHORIZED'].includes(p.status) && p.id === input.paymentId
    );
    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Eligible payment not found', 404);

    const existingRefunds = order.refunds.reduce((sum, r) => sum + r.amount, 0);
    const maxRefundable = payment.amount - existingRefunds;
    if (input.amount > maxRefundable) {
      throw new AppError('REFUND_EXCEEDS_PAYMENT', `Maximum refundable: ${maxRefundable}`, 400);
    }

    return await db.transaction(async (trx) => {
      // Create refund record
      const [refund] = await trx('refunds').insert({
        order_id: orderId,
        payment_id: input.paymentId,
        amount: input.amount,
        reason: input.reason,
        processed_by: employeeId,
      }).returning('*');

      // Update payment status
      const totalRefunded = existingRefunds + input.amount;
      const newPaymentStatus = totalRefunded >= payment.amount
        ? 'REFUNDED'
        : 'PARTIALLY_REFUNDED';

      await trx('payments').where({ id: payment.id }).update({ status: newPaymentStatus });

      // Update order status if fully refunded
      const allRefunded = order.total <= totalRefunded;
      if (allRefunded) {
        await trx('orders').where({ id: orderId }).update({ status: 'REFUNDED' });
      }

      // Process Shopify refund if applicable
      if (payment.shopifyTransactionId && order.shopifyOrderId) {
        await shopifyService.createRefund(order.shopifyOrderId, {
          amount: input.amount,
          reason: input.reason,
        }).catch(err => {
          logger.error({ err, orderId }, 'Shopify refund failed');
        });
      }

      await this.createAuditLog(trx, {
        storeId: order.storeId,
        employeeId,
        action: 'REFUND',
        resourceType: 'order',
        resourceId: orderId,
        newValue: { refundId: refund.id, amount: input.amount, reason: input.reason },
      });

      return this.getOrderById(trx, orderId);
    });
  }

  async listOrders(storeId: string, query: OrderListQuery): Promise<{ orders: Order[]; total: number }> {
    const {
      page = 1, perPage = 20, status, type, search,
      startDate, endDate, sortBy = 'created_at', sortOrder = 'desc'
    } = query;

    let q = db('orders')
      .where({ store_id: storeId })
      .whereNull('deleted_at');

    if (status) q = q.where({ status });
    if (type) q = q.where({ type });
    if (startDate) q = q.where('created_at', '>=', startDate);
    if (endDate) q = q.where('created_at', '<=', endDate);
    if (search) {
      q = q.where(builder => {
        builder
          .whereLike('order_number', `%${search}%`)
          .orWhereLike('customer_name', `%${search}%`)
          .orWhereLike('customer_email', `%${search}%`)
          .orWhereLike('customer_phone', `%${search}%`);
      });
    }

    const [{ count }] = await q.clone().count('* as count');
    const total = parseInt(count as string, 10);

    const rows = await q
      .orderBy(sortBy, sortOrder)
      .limit(perPage)
      .offset((page - 1) * perPage);

    const orders = await Promise.all(rows.map(row => this.hydrateOrder(row)));
    return { orders, total };
  }

  async getOrderById(dbOrTrx: typeof db, orderId: string): Promise<Order> {
    const row = await dbOrTrx('orders').where({ id: orderId }).first();
    if (!row) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    return this.hydrateOrder(row);
  }

  private async hydrateOrder(row: Record<string, unknown>): Promise<Order> {
    const [items, payments, refunds] = await Promise.all([
      db('order_items').where({ order_id: row.id }),
      db('payments').where({ order_id: row.id }),
      db('refunds').where({ order_id: row.id }),
    ]);

    return {
      id: row.id as string,
      storeId: row.store_id as string,
      orderNumber: row.order_number as string,
      shopifyOrderId: row.shopify_order_id as string | null,
      shopifyOrderName: row.shopify_order_name as string | null,
      status: row.status as OrderStatus,
      type: row.type as OrderType,
      fulfillmentType: row.fulfillment_type as FulfillmentType,
      customerId: row.customer_id as string | null,
      customerName: row.customer_name as string | null,
      customerEmail: row.customer_email as string | null,
      customerPhone: row.customer_phone as string | null,
      deliveryAddress: row.delivery_address as Address | null,
      items: items.map(this.mapOrderItem),
      subtotal: parseFloat(row.subtotal as string),
      taxAmount: parseFloat(row.tax_amount as string),
      discountAmount: parseFloat(row.discount_amount as string),
      deliveryFee: parseFloat(row.delivery_fee as string),
      tip: parseFloat(row.tip as string),
      total: parseFloat(row.total as string),
      notes: row.notes as string | null,
      internalNotes: row.internal_notes as string | null,
      couponCode: row.coupon_code as string | null,
      tableNumber: row.table_number as string | null,
      posTerminalId: row.pos_terminal_id as string | null,
      assignedEmployeeId: row.assigned_employee_id as string | null,
      scheduledAt: row.scheduled_at as Date | null,
      confirmedAt: row.confirmed_at as Date | null,
      preparingAt: row.preparing_at as Date | null,
      readyAt: row.ready_at as Date | null,
      completedAt: row.completed_at as Date | null,
      cancelledAt: row.cancelled_at as Date | null,
      cancelledReason: row.cancelled_reason as string | null,
      payments: payments.map(this.mapPayment),
      refunds: refunds.map(this.mapRefund),
      metadata: row.metadata as Record<string, unknown>,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }

  private mapOrderItem = (row: Record<string, unknown>): OrderItem => ({
    id: row.id as string,
    orderId: row.order_id as string,
    productId: row.product_id as string,
    variantId: row.variant_id as string | null,
    shopifyLineItemId: row.shopify_line_item_id as string | null,
    name: row.name as string,
    variantName: row.variant_name as string | null,
    sku: row.sku as string | null,
    quantity: row.quantity as number,
    unitPrice: parseFloat(row.unit_price as string),
    discountAmount: parseFloat(row.discount_amount as string),
    taxAmount: parseFloat(row.tax_amount as string),
    total: parseFloat(row.total as string),
    modifiers: row.modifiers as OrderItemModifier[],
    notes: row.notes as string | null,
    status: row.status as OrderItemStatus,
    preparedAt: row.prepared_at as Date | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  });

  private mapPayment = (row: Record<string, unknown>): Payment => ({
    id: row.id as string,
    orderId: row.order_id as string,
    method: row.method as PaymentMethod,
    status: row.status as PaymentStatus,
    amount: parseFloat(row.amount as string),
    currency: row.currency as string,
    stripePaymentIntentId: row.stripe_payment_intent_id as string | null,
    shopifyTransactionId: row.shopify_transaction_id as string | null,
    cashTendered: row.cash_tendered ? parseFloat(row.cash_tendered as string) : null,
    cashChange: row.cash_change ? parseFloat(row.cash_change as string) : null,
    metadata: row.metadata as Record<string, unknown>,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  });

  private mapRefund = (row: Record<string, unknown>): Refund => ({
    id: row.id as string,
    orderId: row.order_id as string,
    paymentId: row.payment_id as string,
    amount: parseFloat(row.amount as string),
    reason: row.reason as string,
    stripeRefundId: row.stripe_refund_id as string | null,
    shopifyRefundId: row.shopify_refund_id as string | null,
    processedBy: row.processed_by as string,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  });

  private async resolveOrderItems(trx: typeof db, storeId: string, items: CreateOrderItemInput[]) {
    return Promise.all(items.map(async (item) => {
      const product = await trx('products')
        .where({ id: item.productId, store_id: storeId, is_active: true })
        .whereNull('deleted_at')
        .first();

      if (!product) throw new AppError('PRODUCT_NOT_FOUND', `Product ${item.productId} not found`, 404);

      let unitPrice = product.base_price;
      let variantName = null;

      if (item.variantId) {
        const variant = await trx('product_variants')
          .where({ id: item.variantId, product_id: product.id, is_active: true })
          .first();
        if (!variant) throw new AppError('VARIANT_NOT_FOUND', `Variant ${item.variantId} not found`, 404);
        unitPrice = variant.price;
        variantName = variant.name;

        // Check inventory
        if (product.track_inventory && !product.allow_backorder) {
          const inv = await trx('inventory_items')
            .where({ store_id: storeId, variant_id: item.variantId })
            .first();
          const available = inv ? inv.quantity - inv.reserved_quantity : 0;
          if (available < item.quantity) {
            throw new AppError(
              'INSUFFICIENT_INVENTORY',
              `Insufficient inventory for ${product.name}`,
              422
            );
          }
        }
      }

      // Resolve modifiers
      const modifiers: OrderItemModifier[] = [];
      let modifierTotal = 0;
      if (item.modifiers?.length) {
        const modifierIds = item.modifiers.map(m => m.modifierId);
        const dbModifiers = await trx('modifiers').whereIn('id', modifierIds).where({ is_active: true });
        for (const mod of dbModifiers) {
          modifiers.push({ modifierId: mod.id, name: mod.name, priceAdjustment: parseFloat(mod.price_adjustment) });
          modifierTotal += parseFloat(mod.price_adjustment);
        }
      }

      const effectivePrice = unitPrice + modifierTotal;
      return {
        productId: product.id,
        variantId: item.variantId ?? null,
        name: product.name,
        variantName,
        sku: product.sku,
        quantity: item.quantity,
        unitPrice: effectivePrice,
        modifiers,
        total: effectivePrice * item.quantity,
        notes: item.notes,
      };
    }));
  }

  private async processPayments(trx: typeof db, orderId: string, payments: CreatePaymentInput[]) {
    for (const payment of payments) {
      await trx('payments').insert({
        order_id: orderId,
        method: payment.method,
        status: 'CAPTURED',
        amount: payment.amount,
        currency: 'MXN',
        cash_tendered: payment.cashTendered ?? null,
        cash_change: payment.cashTendered ? payment.cashTendered - payment.amount : null,
        stripe_payment_intent_id: payment.stripePaymentIntentId ?? null,
      });
    }
  }

  private async generateOrderNumber(trx: typeof db, storeSlug: string): Promise<string> {
    const [result] = await trx.raw('SELECT generate_order_number(?) AS order_number', [storeSlug]);
    return result.order_number;
  }

  private getValidTransitions(currentStatus: OrderStatus): OrderStatus[] {
    const transitions: Record<OrderStatus, OrderStatus[]> = {
      PENDING: ['CONFIRMED', 'CANCELLED'],
      CONFIRMED: ['PREPARING', 'CANCELLED'],
      PREPARING: ['READY', 'CANCELLED'],
      READY: ['OUT_FOR_DELIVERY', 'PICKED_UP', 'DELIVERED'],
      OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
      DELIVERED: ['REFUNDED'],
      PICKED_UP: ['REFUNDED'],
      CANCELLED: [],
      REFUNDED: [],
    };
    return transitions[currentStatus] ?? [];
  }

  private getStatusTimestampField(status: OrderStatus): string | null {
    const fields: Partial<Record<OrderStatus, string>> = {
      CONFIRMED: 'confirmed_at',
      PREPARING: 'preparing_at',
      READY: 'ready_at',
      DELIVERED: 'completed_at',
      PICKED_UP: 'completed_at',
      CANCELLED: 'cancelled_at',
    };
    return fields[status] ?? null;
  }

  private async createAuditLog(dbOrTrx: typeof db, data: {
    storeId: string;
    employeeId?: string;
    action: string;
    resourceType: string;
    resourceId: string;
    previousValue?: Record<string, unknown>;
    newValue?: Record<string, unknown>;
  }) {
    await dbOrTrx('audit_logs').insert({
      store_id: data.storeId,
      employee_id: data.employeeId ?? null,
      action: data.action,
      resource_type: data.resourceType,
      resource_id: data.resourceId,
      previous_value: data.previousValue ? JSON.stringify(data.previousValue) : null,
      new_value: data.newValue ? JSON.stringify(data.newValue) : null,
    });
  }
}

export const orderService = new OrderService();
