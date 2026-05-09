// services/api/src/services/coupon.service.ts
// Coupon validation with all discount types, limits, and customer tracking

import { db } from '../lib/database';
import { AppError } from '../lib/errors';
import { createLogger } from '../lib/logger';

const logger = createLogger('coupon.service');

interface ResolvedItem {
  productId: string;
  variantId: string | null;
  total: number;
  quantity: number;
}

interface CouponResult {
  coupon: Record<string, unknown>;
  discountAmount: number;
}

export class CouponService {
  async validateAndApply(
    dbOrTrx: typeof db,
    storeId: string,
    code: string,
    items: ResolvedItem[],
    customerId?: string
  ): Promise<CouponResult> {
    const coupon = await dbOrTrx('coupons')
      .where({ store_id: storeId, code: code.toUpperCase(), is_active: true })
      .first();

    if (!coupon) throw new AppError('COUPON_NOT_FOUND', 'Invalid coupon code', 400);

    const now = new Date();

    // Date range validation
    if (coupon.starts_at && new Date(coupon.starts_at) > now) {
      throw new AppError('COUPON_NOT_STARTED', 'Coupon is not yet active', 400);
    }
    if (coupon.expires_at && new Date(coupon.expires_at) < now) {
      throw new AppError('COUPON_EXPIRED', 'Coupon has expired', 400);
    }

    // Usage limit
    if (coupon.usage_limit !== null && coupon.usage_count >= coupon.usage_limit) {
      throw new AppError('COUPON_EXHAUSTED', 'Coupon usage limit reached', 400);
    }

    // Per-customer limit
    if (customerId && coupon.per_customer_limit) {
      const customerUsage = await dbOrTrx('orders')
        .where({
          store_id: storeId,
          customer_id: customerId,
          coupon_code: code.toUpperCase(),
        })
        .whereNotIn('status', ['CANCELLED', 'REFUNDED'])
        .count('* as count')
        .first();

      if (parseInt(customerUsage!.count as string, 10) >= coupon.per_customer_limit) {
        throw new AppError('COUPON_CUSTOMER_LIMIT', 'You have already used this coupon', 400);
      }
    }

    // Determine eligible subtotal
    let eligibleSubtotal = items.reduce((sum, i) => sum + i.total, 0);

    // Product/category restrictions
    const applicableProductIds = coupon.applicable_product_ids ?? [];
    const applicableCategoryIds = coupon.applicable_category_ids ?? [];

    if (applicableProductIds.length > 0 || applicableCategoryIds.length > 0) {
      // Filter to only eligible items
      const eligibleItems: ResolvedItem[] = [];

      for (const item of items) {
        let eligible = applicableProductIds.includes(item.productId);

        if (!eligible && applicableCategoryIds.length > 0) {
          const product = await dbOrTrx('products')
            .where({ id: item.productId })
            .select('category_id')
            .first();

          eligible = product && applicableCategoryIds.includes(product.category_id);
        }

        if (eligible) eligibleItems.push(item);
      }

      eligibleSubtotal = eligibleItems.reduce((sum, i) => sum + i.total, 0);
    }

    // Minimum order amount
    if (coupon.minimum_order_amount && eligibleSubtotal < coupon.minimum_order_amount) {
      throw new AppError(
        'COUPON_MINIMUM_NOT_MET',
        `Minimum order amount of $${coupon.minimum_order_amount.toFixed(2)} required`,
        400
      );
    }

    // Calculate discount
    let discountAmount = 0;

    switch (coupon.type) {
      case 'PERCENTAGE':
        discountAmount = eligibleSubtotal * (coupon.value / 100);
        break;

      case 'FIXED_AMOUNT':
        discountAmount = Math.min(coupon.value, eligibleSubtotal);
        break;

      case 'FREE_SHIPPING':
        // Returns the shipping fee as discount (handled by order service)
        discountAmount = 0; // Caller sets delivery_fee to 0
        break;

      case 'BUY_X_GET_Y':
        // Simple implementation: buy X items, get discount on cheapest
        const sortedItems = [...items].sort((a, b) => a.total - b.total);
        const buyQty = Math.floor(coupon.value); // value = items to buy
        const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
        const freeQty = Math.floor(totalQty / (buyQty + 1));
        if (freeQty > 0 && sortedItems.length > 0) {
          discountAmount = sortedItems[0].total * freeQty;
        }
        break;
    }

    // Apply maximum discount cap
    if (coupon.maximum_discount_amount && discountAmount > coupon.maximum_discount_amount) {
      discountAmount = coupon.maximum_discount_amount;
    }

    discountAmount = Math.round(discountAmount * 100) / 100;

    logger.info({
      code,
      storeId,
      customerId,
      discountAmount,
      couponType: coupon.type,
    }, 'Coupon applied');

    return { coupon, discountAmount };
  }

  async validate(storeId: string, code: string, subtotal: number) {
    const coupon = await db('coupons')
      .where({ store_id: storeId, code: code.toUpperCase(), is_active: true })
      .first();

    if (!coupon) return { valid: false, error: 'Invalid coupon code' };

    const now = new Date();
    if (coupon.expires_at && new Date(coupon.expires_at) < now) {
      return { valid: false, error: 'Coupon has expired' };
    }
    if (coupon.usage_limit !== null && coupon.usage_count >= coupon.usage_limit) {
      return { valid: false, error: 'Coupon usage limit reached' };
    }
    if (coupon.minimum_order_amount && subtotal < coupon.minimum_order_amount) {
      return {
        valid: false,
        error: `Minimum order amount of $${coupon.minimum_order_amount.toFixed(2)} required`,
      };
    }

    return {
      valid: true,
      coupon: {
        code: coupon.code,
        type: coupon.type,
        value: coupon.value,
        description: coupon.description,
      },
    };
  }
}

export const couponService = new CouponService();
