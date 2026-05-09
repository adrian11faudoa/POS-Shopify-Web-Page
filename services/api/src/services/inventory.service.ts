// services/api/src/services/inventory.service.ts
// Production inventory management with reservation pattern and Shopify sync

import { db } from '../lib/database';
import { eventBus } from '../lib/event-bus';
import { queues } from '../../workers/src/index';
import { createLogger } from '../lib/logger';
import { AppError } from '../lib/errors';
import type { InventoryMovementType } from '@snackpos/types';

const logger = createLogger('inventory.service');

interface ReserveItem {
  variantId: string;
  quantity: number;
}

interface AdjustInput {
  storeId: string;
  variantId: string;
  quantity: number; // positive = add, negative = remove
  type: InventoryMovementType;
  reason: string;
  referenceId?: string;
  referenceType?: string;
  employeeId: string;
  notes?: string;
}

interface StockCountInput {
  storeId: string;
  counts: Array<{ variantId: string; actualQuantity: number; notes?: string }>;
  employeeId: string;
}

export class InventoryService {
  // ─── Reserve stock when order is placed ────────────────────────────────────
  async reserveForOrder(
    trx: typeof db,
    storeId: string,
    orderId: string,
    items: ReserveItem[]
  ): Promise<void> {
    for (const item of items) {
      const inv = await trx('inventory_items')
        .where({ store_id: storeId, variant_id: item.variantId })
        .first();

      if (!inv) continue; // No inventory tracking for this item

      const available = inv.quantity - inv.reserved_quantity;
      if (available < item.quantity) {
        // Check if backorder is allowed
        const variant = await trx('product_variants')
          .join('products', 'product_variants.product_id', 'products.id')
          .where('product_variants.id', item.variantId)
          .select('products.allow_backorder', 'products.name', 'product_variants.name as variant_name')
          .first();

        if (!variant?.allow_backorder) {
          throw new AppError(
            'INSUFFICIENT_INVENTORY',
            `Insufficient stock for ${variant?.name ?? item.variantId}: available ${available}, requested ${item.quantity}`,
            422
          );
        }
      }

      await trx('inventory_items')
        .where({ id: inv.id })
        .increment('reserved_quantity', item.quantity);
    }
  }

  // ─── Release reservation on cancellation ───────────────────────────────────
  async releaseReservation(
    dbOrTrx: typeof db,
    storeId: string,
    orderId: string
  ): Promise<void> {
    const items = await dbOrTrx('order_items')
      .where({ order_id: orderId })
      .whereNot({ status: 'CANCELLED' })
      .whereNotNull('variant_id');

    for (const item of items) {
      await dbOrTrx('inventory_items')
        .where({ store_id: storeId, variant_id: item.variant_id })
        .decrement('reserved_quantity', Math.max(0, item.quantity));
    }

    logger.info({ orderId, storeId }, 'Inventory reservation released');
  }

  // ─── Commit reservation to actual deduction on fulfillment ─────────────────
  async commitReservation(
    dbOrTrx: typeof db,
    storeId: string,
    orderId: string,
    employeeId: string
  ): Promise<void> {
    const items = await dbOrTrx('order_items')
      .where({ order_id: orderId })
      .whereNot({ status: 'CANCELLED' })
      .whereNotNull('variant_id');

    for (const item of items) {
      const inv = await dbOrTrx('inventory_items')
        .where({ store_id: storeId, variant_id: item.variant_id })
        .first();

      if (!inv) continue;

      const previousQuantity = inv.quantity;
      const newQuantity = Math.max(0, inv.quantity - item.quantity);
      const newReserved = Math.max(0, inv.reserved_quantity - item.quantity);

      await dbOrTrx('inventory_items')
        .where({ id: inv.id })
        .update({
          quantity: newQuantity,
          reserved_quantity: newReserved,
        });

      // Update variant quantity cache
      await dbOrTrx('product_variants')
        .where({ id: item.variant_id })
        .update({ inventory_quantity: newQuantity });

      // Record movement
      await dbOrTrx('inventory_movements').insert({
        store_id: storeId,
        inventory_item_id: inv.id,
        type: 'SALE',
        quantity: -item.quantity,
        reason: `Order fulfilled: ${orderId}`,
        reference_id: orderId,
        reference_type: 'order',
        employee_id: employeeId,
      });

      // Check alerts after commit
      await this.checkAndEmitAlerts(dbOrTrx, inv.id, storeId, item.variant_id, previousQuantity, newQuantity, inv.low_stock_threshold);
    }

    logger.info({ orderId, storeId }, 'Inventory reservation committed');
  }

  // ─── Manual stock adjustment ────────────────────────────────────────────────
  async adjustStock(input: AdjustInput): Promise<{ newQuantity: number }> {
    return await db.transaction(async (trx) => {
      let inv = await trx('inventory_items')
        .where({ store_id: input.storeId, variant_id: input.variantId })
        .first();

      if (!inv) {
        // Auto-create inventory record if doesn't exist
        const [newInv] = await trx('inventory_items').insert({
          store_id: input.storeId,
          variant_id: input.variantId,
          quantity: 0,
          reserved_quantity: 0,
          low_stock_threshold: 5,
          reorder_point: 10,
          reorder_quantity: 50,
        }).returning('*');
        inv = newInv;
      }

      const previousQuantity = inv.quantity;
      const newQuantity = Math.max(0, inv.quantity + input.quantity);

      await trx('inventory_items')
        .where({ id: inv.id })
        .update({ quantity: newQuantity });

      // Sync to variant cache
      await trx('product_variants')
        .where({ id: input.variantId })
        .update({ inventory_quantity: newQuantity });

      // Record movement
      await trx('inventory_movements').insert({
        store_id: input.storeId,
        inventory_item_id: inv.id,
        type: input.type,
        quantity: input.quantity,
        reason: input.reason,
        reference_id: input.referenceId ?? null,
        reference_type: input.referenceType ?? null,
        employee_id: input.employeeId,
        notes: input.notes ?? null,
      });

      await this.checkAndEmitAlerts(
        trx, inv.id, input.storeId, input.variantId,
        previousQuantity, newQuantity, inv.low_stock_threshold
      );

      return { newQuantity };
    });
  }

  // ─── Physical stock count / reconciliation ──────────────────────────────────
  async performStockCount(input: StockCountInput): Promise<{
    variantsUpdated: number;
    discrepancies: Array<{ variantId: string; expected: number; actual: number; delta: number }>;
  }> {
    const discrepancies: Array<{ variantId: string; expected: number; actual: number; delta: number }> = [];
    let variantsUpdated = 0;

    await db.transaction(async (trx) => {
      for (const count of input.counts) {
        const inv = await trx('inventory_items')
          .where({ store_id: input.storeId, variant_id: count.variantId })
          .first();

        if (!inv) continue;

        const delta = count.actualQuantity - inv.quantity;
        if (delta !== 0) {
          discrepancies.push({
            variantId: count.variantId,
            expected: inv.quantity,
            actual: count.actualQuantity,
            delta,
          });

          await trx('inventory_items')
            .where({ id: inv.id })
            .update({ quantity: count.actualQuantity, last_counted_at: new Date() });

          await trx('product_variants')
            .where({ id: count.variantId })
            .update({ inventory_quantity: count.actualQuantity });

          await trx('inventory_movements').insert({
            store_id: input.storeId,
            inventory_item_id: inv.id,
            type: 'ADJUSTMENT',
            quantity: delta,
            reason: `Stock count adjustment`,
            reference_type: 'stock_count',
            employee_id: input.employeeId,
            notes: count.notes ?? null,
          });

          variantsUpdated++;
        } else {
          // Update last counted timestamp even if no change
          await trx('inventory_items')
            .where({ id: inv.id })
            .update({ last_counted_at: new Date() });
        }
      }
    });

    logger.info({
      storeId: input.storeId,
      variantsUpdated,
      discrepancies: discrepancies.length,
    }, 'Stock count complete');

    return { variantsUpdated, discrepancies };
  }

  // ─── List inventory with filters ────────────────────────────────────────────
  async listInventory(storeId: string, query: {
    page?: number;
    perPage?: number;
    search?: string;
    alertsOnly?: boolean;
    categoryId?: string;
    lowStock?: boolean;
    supplierId?: string;
  }) {
    const { page = 1, perPage = 50, search, alertsOnly, categoryId, lowStock, supplierId } = query;

    let q = db('inventory_items')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .leftJoin('categories', 'products.category_id', 'categories.id')
      .leftJoin('suppliers', 'inventory_items.supplier_id', 'suppliers.id')
      .where('inventory_items.store_id', storeId)
      .whereNull('products.deleted_at')
      .where('products.is_active', true);

    if (search) {
      q = q.where(builder => {
        builder
          .whereLike('products.name', `%${search}%`)
          .orWhereLike('product_variants.name', `%${search}%`)
          .orWhereLike('product_variants.sku', `%${search}%`)
          .orWhereLike('product_variants.barcode', `%${search}%`);
      });
    }

    if (alertsOnly) {
      q = q.whereRaw('array_length(inventory_items.alerts, 1) > 0');
    }

    if (lowStock) {
      q = q.whereRaw('inventory_items.quantity <= inventory_items.low_stock_threshold');
    }

    if (categoryId) {
      q = q.where('products.category_id', categoryId);
    }

    if (supplierId) {
      q = q.where('inventory_items.supplier_id', supplierId);
    }

    const [{ count }] = await q.clone().count('inventory_items.id as count');
    const total = parseInt(count as string, 10);

    const rows = await q
      .select(
        'inventory_items.*',
        'product_variants.name as variant_name',
        'product_variants.sku',
        'product_variants.barcode',
        'product_variants.price',
        'products.id as product_id',
        'products.name as product_name',
        'products.image_urls',
        'categories.name as category_name',
        'suppliers.name as supplier_name',
        db.raw('inventory_items.quantity - inventory_items.reserved_quantity as available_quantity'),
      )
      .orderBy('products.name', 'asc')
      .orderBy('product_variants.name', 'asc')
      .limit(perPage)
      .offset((page - 1) * perPage);

    return { items: rows, total };
  }

  // ─── Get movements history ──────────────────────────────────────────────────
  async getMovements(storeId: string, variantId: string, options: {
    page?: number;
    perPage?: number;
    startDate?: Date;
    endDate?: Date;
  }) {
    const { page = 1, perPage = 50, startDate, endDate } = options;

    const inv = await db('inventory_items')
      .where({ store_id: storeId, variant_id: variantId })
      .first();

    if (!inv) throw new AppError('NOT_FOUND', 'Inventory item not found', 404);

    let q = db('inventory_movements')
      .join('employees', 'inventory_movements.employee_id', 'employees.id')
      .where('inventory_movements.inventory_item_id', inv.id)
      .select(
        'inventory_movements.*',
        db.raw("employees.first_name || ' ' || employees.last_name as employee_name"),
      );

    if (startDate) q = q.where('inventory_movements.created_at', '>=', startDate);
    if (endDate) q = q.where('inventory_movements.created_at', '<=', endDate);

    const [{ count }] = await q.clone().count('inventory_movements.id as count');
    const total = parseInt(count as string, 10);

    const movements = await q
      .orderBy('inventory_movements.created_at', 'desc')
      .limit(perPage)
      .offset((page - 1) * perPage);

    return { movements, total };
  }

  // ─── Private: check and emit inventory alerts ───────────────────────────────
  private async checkAndEmitAlerts(
    dbOrTrx: typeof db,
    invId: string,
    storeId: string,
    variantId: string,
    previousQty: number,
    newQty: number,
    threshold: number
  ): Promise<void> {
    let alertType: string | null = null;

    if (newQty <= 0 && previousQty > 0) {
      alertType = 'OUT_OF_STOCK';
    } else if (newQty <= threshold && previousQty > threshold) {
      alertType = 'LOW_STOCK';
    }

    if (alertType) {
      // Emit real-time event
      eventBus.emit('inventory:updated', {
        storeId,
        variantId,
        previousQuantity: previousQty,
        newQuantity: newQty,
        alert: alertType,
      });

      // Queue email/notification alert (non-blocking)
      try {
        await queues.inventory.add('alert', {
          storeId,
          variantId,
          alertType,
          quantity: newQty,
          threshold,
        }, { priority: alertType === 'OUT_OF_STOCK' ? 1 : 2 });
      } catch (err) {
        logger.error({ err }, 'Failed to queue inventory alert');
      }
    }
  }
}

export const inventoryService = new InventoryService();
