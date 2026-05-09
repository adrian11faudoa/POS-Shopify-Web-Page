// packages/types/src/index.ts
// Central type definitions for the entire SnackPOS ecosystem

// ─── Enums ────────────────────────────────────────────────────────────────────

export enum OrderStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  PREPARING = 'PREPARING',
  READY = 'READY',
  OUT_FOR_DELIVERY = 'OUT_FOR_DELIVERY',
  DELIVERED = 'DELIVERED',
  PICKED_UP = 'PICKED_UP',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED',
}

export enum OrderType {
  ONLINE = 'ONLINE',
  POS = 'POS',
  SHOPIFY = 'SHOPIFY',
}

export enum FulfillmentType {
  PICKUP = 'PICKUP',
  DELIVERY = 'DELIVERY',
  DINE_IN = 'DINE_IN',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  AUTHORIZED = 'AUTHORIZED',
  CAPTURED = 'CAPTURED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  REFUNDED = 'REFUNDED',
  FAILED = 'FAILED',
  VOIDED = 'VOIDED',
}

export enum PaymentMethod {
  CASH = 'CASH',
  CARD = 'CARD',
  STRIPE = 'STRIPE',
  SHOPIFY = 'SHOPIFY',
  MIXED = 'MIXED',
}

export enum EmployeeRole {
  OWNER = 'OWNER',
  MANAGER = 'MANAGER',
  CASHIER = 'CASHIER',
  KITCHEN = 'KITCHEN',
  DELIVERY = 'DELIVERY',
}

export enum InventoryAlertType {
  LOW_STOCK = 'LOW_STOCK',
  OUT_OF_STOCK = 'OUT_OF_STOCK',
  EXPIRY_SOON = 'EXPIRY_SOON',
}

export enum AuditAction {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  REFUND = 'REFUND',
  CANCEL = 'CANCEL',
  LOGIN = 'LOGIN',
  LOGOUT = 'LOGOUT',
  CASH_CLOSE = 'CASH_CLOSE',
  DISCOUNT_APPLIED = 'DISCOUNT_APPLIED',
}

// ─── Base Types ───────────────────────────────────────────────────────────────

export interface BaseEntity {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SoftDeleteEntity extends BaseEntity {
  deletedAt: Date | null;
}

// ─── Store / Multi-tenant ─────────────────────────────────────────────────────

export interface Store extends BaseEntity {
  name: string;
  slug: string;
  address: Address;
  phone: string;
  email: string;
  timezone: string;
  currency: string;
  logoUrl: string | null;
  shopifyShopDomain: string | null;
  shopifyAccessToken: string | null;
  settings: StoreSettings;
  isActive: boolean;
}

export interface StoreSettings {
  taxRate: number;
  taxIncluded: boolean;
  receiptFooter: string;
  autoConfirmOrders: boolean;
  preparationTimeMinutes: number;
  deliveryRadiusKm: number;
  minimumOrderAmount: number;
  openingHours: OpeningHours[];
  printerConfig: PrinterConfig | null;
}

export interface OpeningHours {
  dayOfWeek: number; // 0 = Sunday
  openTime: string;  // HH:MM
  closeTime: string;
  isClosed: boolean;
}

export interface PrinterConfig {
  type: 'STAR' | 'EPSON' | 'ZEBRA' | 'CUPS';
  connectionType: 'USB' | 'NETWORK' | 'BLUETOOTH';
  address: string;
  paperWidth: 58 | 80;
}

// ─── Address ─────────────────────────────────────────────────────────────────

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude?: number;
  longitude?: number;
}

// ─── Product & Catalog ────────────────────────────────────────────────────────

export interface Category extends SoftDeleteEntity {
  storeId: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  sortOrder: number;
  isActive: boolean;
  parentId: string | null;
}

export interface Product extends SoftDeleteEntity {
  storeId: string;
  categoryId: string;
  shopifyProductId: string | null;
  name: string;
  slug: string;
  description: string | null;
  imageUrls: string[];
  basePrice: number;
  compareAtPrice: number | null;
  sku: string | null;
  barcode: string | null;
  isActive: boolean;
  isFeatured: boolean;
  trackInventory: boolean;
  allowBackorder: boolean;
  tags: string[];
  metafields: Record<string, unknown>;
  variants: ProductVariant[];
  modifierGroups: ModifierGroup[];
}

export interface ProductVariant extends BaseEntity {
  productId: string;
  shopifyVariantId: string | null;
  name: string;
  sku: string | null;
  barcode: string | null;
  price: number;
  compareAtPrice: number | null;
  weight: number | null;
  weightUnit: 'g' | 'kg' | 'oz' | 'lb' | null;
  imageUrl: string | null;
  inventoryQuantity: number;
  lowStockThreshold: number;
  isActive: boolean;
  options: Record<string, string>; // { size: 'Large', flavor: 'BBQ' }
}

export interface ModifierGroup extends BaseEntity {
  productId: string;
  name: string;
  description: string | null;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  sortOrder: number;
  modifiers: Modifier[];
}

export interface Modifier extends BaseEntity {
  groupId: string;
  name: string;
  priceAdjustment: number;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  inventoryVariantId: string | null;
}

// ─── Order ────────────────────────────────────────────────────────────────────

export interface Order extends BaseEntity {
  storeId: string;
  orderNumber: string;
  shopifyOrderId: string | null;
  shopifyOrderName: string | null;
  status: OrderStatus;
  type: OrderType;
  fulfillmentType: FulfillmentType;
  customerId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  deliveryAddress: Address | null;
  items: OrderItem[];
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  deliveryFee: number;
  tip: number;
  total: number;
  notes: string | null;
  internalNotes: string | null;
  couponCode: string | null;
  scheduledAt: Date | null;
  confirmedAt: Date | null;
  preparingAt: Date | null;
  readyAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelledReason: string | null;
  payments: Payment[];
  refunds: Refund[];
  assignedEmployeeId: string | null;
  tableNumber: string | null;
  posTerminalId: string | null;
  metadata: Record<string, unknown>;
}

export interface OrderItem extends BaseEntity {
  orderId: string;
  productId: string;
  variantId: string | null;
  shopifyLineItemId: string | null;
  name: string;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
  modifiers: OrderItemModifier[];
  notes: string | null;
  status: OrderItemStatus;
  preparedAt: Date | null;
}

export type OrderItemStatus = 'PENDING' | 'PREPARING' | 'READY' | 'SERVED' | 'CANCELLED';

export interface OrderItemModifier {
  modifierId: string;
  name: string;
  priceAdjustment: number;
}

// ─── Payment ─────────────────────────────────────────────────────────────────

export interface Payment extends BaseEntity {
  orderId: string;
  method: PaymentMethod;
  status: PaymentStatus;
  amount: number;
  currency: string;
  stripePaymentIntentId: string | null;
  shopifyTransactionId: string | null;
  cashTendered: number | null;
  cashChange: number | null;
  metadata: Record<string, unknown>;
}

export interface Refund extends BaseEntity {
  orderId: string;
  paymentId: string;
  amount: number;
  reason: string;
  stripeRefundId: string | null;
  shopifyRefundId: string | null;
  processedBy: string;
}

// ─── Customer ────────────────────────────────────────────────────────────────

export interface Customer extends BaseEntity {
  storeId: string;
  shopifyCustomerId: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  defaultAddress: Address | null;
  loyaltyPoints: number;
  totalOrders: number;
  totalSpent: number;
  tags: string[];
  notes: string | null;
  acceptsMarketing: boolean;
  lastOrderAt: Date | null;
}

// ─── Employee ─────────────────────────────────────────────────────────────────

export interface Employee extends SoftDeleteEntity {
  storeId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  role: EmployeeRole;
  pin: string; // hashed 4-digit PIN for POS
  permissions: Permission[];
  isActive: boolean;
  lastLoginAt: Date | null;
}

export type Permission =
  | 'orders:read'
  | 'orders:write'
  | 'orders:cancel'
  | 'orders:refund'
  | 'products:read'
  | 'products:write'
  | 'inventory:read'
  | 'inventory:write'
  | 'reports:read'
  | 'employees:read'
  | 'employees:write'
  | 'settings:read'
  | 'settings:write'
  | 'cash_register:open'
  | 'cash_register:close'
  | 'discounts:apply'
  | 'suppliers:read'
  | 'suppliers:write';

export const ROLE_PERMISSIONS: Record<EmployeeRole, Permission[]> = {
  [EmployeeRole.OWNER]: [
    'orders:read', 'orders:write', 'orders:cancel', 'orders:refund',
    'products:read', 'products:write', 'inventory:read', 'inventory:write',
    'reports:read', 'employees:read', 'employees:write', 'settings:read',
    'settings:write', 'cash_register:open', 'cash_register:close',
    'discounts:apply', 'suppliers:read', 'suppliers:write',
  ],
  [EmployeeRole.MANAGER]: [
    'orders:read', 'orders:write', 'orders:cancel', 'orders:refund',
    'products:read', 'products:write', 'inventory:read', 'inventory:write',
    'reports:read', 'employees:read', 'settings:read',
    'cash_register:open', 'cash_register:close', 'discounts:apply',
    'suppliers:read',
  ],
  [EmployeeRole.CASHIER]: [
    'orders:read', 'orders:write', 'products:read', 'inventory:read',
    'cash_register:open', 'cash_register:close', 'discounts:apply',
  ],
  [EmployeeRole.KITCHEN]: [
    'orders:read', 'orders:write', 'inventory:read',
  ],
  [EmployeeRole.DELIVERY]: [
    'orders:read', 'orders:write',
  ],
};

// ─── Inventory ────────────────────────────────────────────────────────────────

export interface InventoryItem extends BaseEntity {
  storeId: string;
  variantId: string;
  supplierId: string | null;
  quantity: number;
  reservedQuantity: number;
  availableQuantity: number; // computed: quantity - reservedQuantity
  lowStockThreshold: number;
  reorderPoint: number;
  reorderQuantity: number;
  costPrice: number | null;
  location: string | null;
  expiresAt: Date | null;
  lastCountedAt: Date | null;
  alerts: InventoryAlertType[];
}

export interface InventoryMovement extends BaseEntity {
  storeId: string;
  inventoryItemId: string;
  type: InventoryMovementType;
  quantity: number; // positive = in, negative = out
  reason: string;
  referenceId: string | null; // orderId, purchaseOrderId, etc.
  referenceType: string | null;
  employeeId: string;
  notes: string | null;
}

export type InventoryMovementType =
  | 'PURCHASE'
  | 'SALE'
  | 'ADJUSTMENT'
  | 'TRANSFER'
  | 'WASTE'
  | 'RETURN'
  | 'INITIAL_STOCK';

// ─── Cash Register ────────────────────────────────────────────────────────────

export interface CashRegisterSession extends BaseEntity {
  storeId: string;
  posTerminalId: string;
  employeeId: string;
  openedBy: string;
  closedBy: string | null;
  openingFloat: number;
  closingFloat: number | null;
  expectedCash: number | null;
  variance: number | null;
  openedAt: Date;
  closedAt: Date | null;
  cashSales: number;
  cardSales: number;
  refundsTotal: number;
  discountsTotal: number;
  ordersCount: number;
  notes: string | null;
}

// ─── Coupon / Promotion ───────────────────────────────────────────────────────

export interface Coupon extends BaseEntity {
  storeId: string;
  shopifyCouponId: string | null;
  code: string;
  description: string | null;
  type: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FREE_SHIPPING' | 'BUY_X_GET_Y';
  value: number;
  minimumOrderAmount: number | null;
  maximumDiscountAmount: number | null;
  usageLimit: number | null;
  usageCount: number;
  perCustomerLimit: number | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  applicableProductIds: string[];
  applicableCategoryIds: string[];
  isActive: boolean;
}

// ─── Supplier ─────────────────────────────────────────────────────────────────

export interface Supplier extends SoftDeleteEntity {
  storeId: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: Address | null;
  paymentTerms: string | null;
  notes: string | null;
  isActive: boolean;
}

// ─── Audit Log ───────────────────────────────────────────────────────────────

export interface AuditLog extends BaseEntity {
  storeId: string;
  employeeId: string | null;
  action: AuditAction;
  resourceType: string;
  resourceId: string;
  previousValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
}

// ─── Realtime Events ──────────────────────────────────────────────────────────

export type RealtimeEvent =
  | OrderCreatedEvent
  | OrderStatusChangedEvent
  | OrderItemStatusChangedEvent
  | InventoryUpdatedEvent
  | KDSOrderEvent
  | POSNotificationEvent;

export interface OrderCreatedEvent {
  type: 'order:created';
  storeId: string;
  order: Order;
}

export interface OrderStatusChangedEvent {
  type: 'order:status_changed';
  storeId: string;
  orderId: string;
  orderNumber: string;
  previousStatus: OrderStatus;
  newStatus: OrderStatus;
  timestamp: Date;
}

export interface OrderItemStatusChangedEvent {
  type: 'order_item:status_changed';
  storeId: string;
  orderId: string;
  itemId: string;
  newStatus: OrderItemStatus;
}

export interface InventoryUpdatedEvent {
  type: 'inventory:updated';
  storeId: string;
  variantId: string;
  previousQuantity: number;
  newQuantity: number;
  alert: InventoryAlertType | null;
}

export interface KDSOrderEvent {
  type: 'kds:order';
  storeId: string;
  order: Pick<Order, 'id' | 'orderNumber' | 'items' | 'type' | 'notes' | 'createdAt'>;
}

export interface POSNotificationEvent {
  type: 'pos:notification';
  storeId: string;
  level: 'info' | 'warning' | 'error';
  title: string;
  message: string;
}

// ─── API Response Wrappers ────────────────────────────────────────────────────

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: PaginationMeta;
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, string[]>;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export interface PaginationMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface PaginationQuery {
  page?: number;
  perPage?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  search?: string;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface AuthToken {
  sub: string;       // employeeId
  storeId: string;
  role: EmployeeRole;
  permissions: Permission[];
  sessionId: string;
  iat: number;
  exp: number;
}

export interface POSPinSession {
  employeeId: string;
  storeId: string;
  posTerminalId: string;
  role: EmployeeRole;
  permissions: Permission[];
}
