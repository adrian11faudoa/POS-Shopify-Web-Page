// services/api/src/schemas/order.schema.ts
import { z } from 'zod';

export const createOrderItemSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  quantity: z.number().int().min(1).max(999),
  modifiers: z.array(z.object({ modifierId: z.string().uuid() })).optional(),
  notes: z.string().max(500).optional(),
});

export const createPaymentSchema = z.object({
  method: z.enum(['CASH', 'CARD', 'STRIPE', 'SHOPIFY', 'MIXED']),
  amount: z.number().positive(),
  cashTendered: z.number().positive().optional(),
  stripePaymentIntentId: z.string().optional(),
});

export const createOrderSchema = z.object({
  type: z.enum(['ONLINE', 'POS', 'SHOPIFY']).default('POS'),
  fulfillmentType: z.enum(['PICKUP', 'DELIVERY', 'DINE_IN']).default('PICKUP'),
  items: z.array(createOrderItemSchema).min(1),
  customerId: z.string().uuid().optional(),
  customerName: z.string().max(200).optional(),
  customerEmail: z.string().email().optional(),
  customerPhone: z.string().max(20).optional(),
  deliveryAddress: z.object({
    line1: z.string(),
    line2: z.string().optional(),
    city: z.string(),
    state: z.string(),
    postalCode: z.string(),
    country: z.string().default('MX'),
  }).optional(),
  notes: z.string().max(1000).optional(),
  internalNotes: z.string().max(1000).optional(),
  couponCode: z.string().max(50).optional(),
  tip: z.number().min(0).default(0),
  scheduledAt: z.string().datetime().optional().transform(v => v ? new Date(v) : undefined),
  tableNumber: z.string().max(20).optional(),
  posTerminalId: z.string().max(100).optional(),
  assignedEmployeeId: z.string().uuid().optional(),
  payments: z.array(createPaymentSchema).optional(),
  idempotencyKey: z.string().uuid().optional(),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum([
    'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY',
    'DELIVERED', 'PICKED_UP', 'CANCELLED', 'REFUNDED',
  ]),
  reason: z.string().max(500).optional(),
  internalNotes: z.string().max(1000).optional(),
});

export const refundOrderSchema = z.object({
  paymentId: z.string().uuid(),
  amount: z.number().positive(),
  reason: z.string().min(1).max(500),
});

export const listOrdersSchema = z.object({
  page: z.string().optional().transform(v => v ? parseInt(v) : 1),
  perPage: z.string().optional().transform(v => v ? Math.min(parseInt(v), 100) : 20),
  status: z.enum([
    'PENDING', 'CONFIRMED', 'PREPARING', 'READY',
    'OUT_FOR_DELIVERY', 'DELIVERED', 'PICKED_UP', 'CANCELLED', 'REFUNDED',
  ]).optional(),
  type: z.enum(['ONLINE', 'POS', 'SHOPIFY']).optional(),
  search: z.string().max(100).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  sortBy: z.enum(['created_at', 'updated_at', 'total', 'order_number']).optional().default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

// services/api/src/schemas/product.schema.ts
export const createProductSchema = z.object({
  categoryId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  imageUrls: z.array(z.string().url()).optional().default([]),
  basePrice: z.number().min(0),
  compareAtPrice: z.number().min(0).optional(),
  sku: z.string().max(100).optional(),
  barcode: z.string().max(100).optional(),
  isActive: z.boolean().default(true),
  isFeatured: z.boolean().default(false),
  trackInventory: z.boolean().default(true),
  allowBackorder: z.boolean().default(false),
  tags: z.array(z.string()).optional().default([]),
  variants: z.array(z.object({
    name: z.string(),
    sku: z.string().optional(),
    barcode: z.string().optional(),
    price: z.number().min(0),
    compareAtPrice: z.number().min(0).optional(),
    inventoryQuantity: z.number().int().min(0).default(0),
    lowStockThreshold: z.number().int().min(0).default(5),
    options: z.record(z.string()).optional().default({}),
  })).optional().default([]),
  modifierGroups: z.array(z.object({
    name: z.string(),
    required: z.boolean().default(false),
    minSelections: z.number().int().min(0).default(0),
    maxSelections: z.number().int().min(1).default(1),
    modifiers: z.array(z.object({
      name: z.string(),
      priceAdjustment: z.number().default(0),
      isDefault: z.boolean().default(false),
    })),
  })).optional().default([]),
});

export const updateProductSchema = createProductSchema.partial();

export const listProductsSchema = z.object({
  page: z.string().optional().transform(v => v ? parseInt(v) : 1),
  perPage: z.string().optional().transform(v => v ? Math.min(parseInt(v), 100) : 20),
  categoryId: z.string().uuid().optional(),
  search: z.string().max(100).optional(),
  storeId: z.string().uuid().optional(),
  isActive: z.string().optional().transform(v => v === 'false' ? false : v === 'true' ? true : undefined),
  isFeatured: z.string().optional().transform(v => v === 'true' ? true : undefined),
  tags: z.string().optional(),
  sortBy: z.enum(['name', 'base_price', 'created_at', 'is_featured']).optional().default('name'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('asc'),
});
