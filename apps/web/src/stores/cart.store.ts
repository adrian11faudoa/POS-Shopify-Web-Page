// apps/web/src/stores/cart.store.ts
// Zustand cart store with localStorage persistence and optimistic updates

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

export interface CartItem {
  id: string; // local UUID
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  price: number; // effective price including modifiers
  quantity: number;
  imageUrl: string | null;
  modifiers: Array<{ modifierId: string; name: string; priceAdjustment: number }>;
  notes: string;
}

export interface CartStore {
  items: CartItem[];
  couponCode: string;
  couponDiscount: number;
  notes: string;
  fulfillmentType: 'PICKUP' | 'DELIVERY' | 'DINE_IN';
  deliveryAddress: DeliveryAddress | null;
  scheduledAt: Date | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;

  // Computed
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  deliveryFee: number;
  total: number;
  itemCount: number;

  // Actions
  addItem: (item: Omit<CartItem, 'id' | 'quantity'> & { quantity?: number }) => void;
  removeItem: (id: string) => void;
  updateQuantity: (id: string, quantity: number) => void;
  updateItemNotes: (id: string, notes: string) => void;
  clearCart: () => void;
  applyCoupon: (code: string, discount: number) => void;
  removeCoupon: () => void;
  setFulfillmentType: (type: 'PICKUP' | 'DELIVERY' | 'DINE_IN') => void;
  setDeliveryAddress: (address: DeliveryAddress | null) => void;
  setScheduledAt: (date: Date | null) => void;
  setNotes: (notes: string) => void;
  setCustomer: (data: { name?: string; email?: string; phone?: string }) => void;
}

interface DeliveryAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

const TAX_RATE = 0.16;
const DELIVERY_FEE = 45; // MXN

function computeTotals(items: CartItem[], couponDiscount: number, fulfillmentType: string) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const discountAmount = Math.min(couponDiscount, subtotal);
  const taxableAmount = subtotal - discountAmount;
  const taxAmount = Math.round(taxableAmount * TAX_RATE * 100) / 100;
  const deliveryFee = fulfillmentType === 'DELIVERY' ? DELIVERY_FEE : 0;
  const total = taxableAmount + taxAmount + deliveryFee;
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  return { subtotal, discountAmount, taxAmount, deliveryFee, total, itemCount };
}

export const useCartStore = create<CartStore>()(
  persist(
    immer((set, get) => ({
      items: [],
      couponCode: '',
      couponDiscount: 0,
      notes: '',
      fulfillmentType: 'PICKUP',
      deliveryAddress: null,
      scheduledAt: null,
      customerName: '',
      customerEmail: '',
      customerPhone: '',

      // Computed (derived from items on access)
      get subtotal() { return computeTotals(get().items, get().couponDiscount, get().fulfillmentType).subtotal; },
      get discountAmount() { return computeTotals(get().items, get().couponDiscount, get().fulfillmentType).discountAmount; },
      get taxAmount() { return computeTotals(get().items, get().couponDiscount, get().fulfillmentType).taxAmount; },
      get deliveryFee() { return computeTotals(get().items, get().couponDiscount, get().fulfillmentType).deliveryFee; },
      get total() { return computeTotals(get().items, get().couponDiscount, get().fulfillmentType).total; },
      get itemCount() { return get().items.reduce((sum, i) => sum + i.quantity, 0); },

      addItem: (item) => set(state => {
        const existing = state.items.find(i =>
          i.productId === item.productId &&
          i.variantId === item.variantId &&
          JSON.stringify(i.modifiers) === JSON.stringify(item.modifiers)
        );

        if (existing) {
          existing.quantity += item.quantity ?? 1;
        } else {
          state.items.push({
            ...item,
            id: crypto.randomUUID(),
            quantity: item.quantity ?? 1,
          });
        }
      }),

      removeItem: (id) => set(state => {
        state.items = state.items.filter(i => i.id !== id);
      }),

      updateQuantity: (id, quantity) => set(state => {
        if (quantity <= 0) {
          state.items = state.items.filter(i => i.id !== id);
        } else {
          const item = state.items.find(i => i.id === id);
          if (item) item.quantity = Math.min(quantity, 99);
        }
      }),

      updateItemNotes: (id, notes) => set(state => {
        const item = state.items.find(i => i.id === id);
        if (item) item.notes = notes.slice(0, 200);
      }),

      clearCart: () => set(state => {
        state.items = [];
        state.couponCode = '';
        state.couponDiscount = 0;
        state.notes = '';
        state.scheduledAt = null;
      }),

      applyCoupon: (code, discount) => set(state => {
        state.couponCode = code;
        state.couponDiscount = discount;
      }),

      removeCoupon: () => set(state => {
        state.couponCode = '';
        state.couponDiscount = 0;
      }),

      setFulfillmentType: (type) => set(state => { state.fulfillmentType = type; }),
      setDeliveryAddress: (address) => set(state => { state.deliveryAddress = address; }),
      setScheduledAt: (date) => set(state => { state.scheduledAt = date; }),
      setNotes: (notes) => set(state => { state.notes = notes.slice(0, 500); }),
      setCustomer: (data) => set(state => {
        if (data.name !== undefined) state.customerName = data.name;
        if (data.email !== undefined) state.customerEmail = data.email;
        if (data.phone !== undefined) state.customerPhone = data.phone;
      }),
    })),
    {
      name: 'snackpos-cart',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        items: state.items,
        couponCode: state.couponCode,
        couponDiscount: state.couponDiscount,
        fulfillmentType: state.fulfillmentType,
        deliveryAddress: state.deliveryAddress,
        customerName: state.customerName,
        customerEmail: state.customerEmail,
        customerPhone: state.customerPhone,
      }),
    }
  )
);
