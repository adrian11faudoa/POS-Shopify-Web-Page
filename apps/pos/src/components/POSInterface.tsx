// apps/pos/src/components/POSInterface.tsx
// Production cashier POS interface with offline support, barcode scanner, and real-time sync

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSocket } from '../hooks/useSocket';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { useOrderStore } from '../stores/order.store';
import { useInventoryStore } from '../stores/inventory.store';
import { CartItem, OrderSummary } from './cart';
import { ProductGrid } from './ProductGrid';
import { NumPad } from './NumPad';
import { PaymentModal } from './PaymentModal';
import { OrderTicket } from './OrderTicket';
import { BarcodeScanner } from './BarcodeScanner';
import type { Product, ProductVariant, OrderType } from '@snackpos/types';

interface POSInterfaceProps {
  storeId: string;
  posTerminalId: string;
  employeeId: string;
  employeeName: string;
}

interface CartLineItem {
  id: string; // local UUID for cart management
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  price: number;
  quantity: number;
  modifiers: { modifierId: string; name: string; priceAdjustment: number }[];
  notes: string;
  imageUrl: string | null;
}

export function POSInterface({ storeId, posTerminalId, employeeId, employeeName }: POSInterfaceProps) {
  const { socket, isConnected } = useSocket(storeId, posTerminalId);
  const { enqueue, isSyncing } = useOfflineQueue(socket);

  const [cart, setCart] = useState<CartLineItem[]>([]);
  const [orderType, setOrderType] = useState<OrderType>('POS');
  const [customerName, setCustomerName] = useState('');
  const [tableNumber, setTableNumber] = useState('');
  const [discountPercent, setDiscountPercent] = useState(0);
  const [couponCode, setCouponCode] = useState('');
  const [notes, setNotes] = useState('');
  const [showPayment, setShowPayment] = useState(false);
  const [lastOrder, setLastOrder] = useState<Order | null>(null);
  const [pendingOrders, setPendingOrders] = useState<Order[]>([]);
  const [view, setView] = useState<'pos' | 'orders' | 'kds'>('pos');
  const [searchQuery, setSearchQuery] = useState('');

  const barcodeBuffer = useRef('');
  const barcodeTimer = useRef<ReturnType<typeof setTimeout>>();

  // ─── Barcode Scanner (USB HID) ────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;

      if (e.key === 'Enter' && barcodeBuffer.current.length > 3) {
        handleBarcodeScan(barcodeBuffer.current);
        barcodeBuffer.current = '';
        return;
      }

      if (e.key.length === 1) {
        barcodeBuffer.current += e.key;
        clearTimeout(barcodeTimer.current);
        barcodeTimer.current = setTimeout(() => {
          barcodeBuffer.current = '';
        }, 100);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleBarcodeScan = useCallback(async (barcode: string) => {
    try {
      const res = await fetch(`/api/products/barcode/${encodeURIComponent(barcode)}?storeId=${storeId}`);
      if (!res.ok) {
        playErrorSound();
        return;
      }
      const { data } = await res.json();
      addToCart(data.product, data.variant, 1);
      playSuccessSound();
    } catch {
      playErrorSound();
    }
  }, [storeId]);

  // ─── Real-time order updates ──────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    socket.on('order:created', (event) => {
      if (event.order.type === 'ONLINE' || event.order.type === 'SHOPIFY') {
        setPendingOrders(prev => [event.order, ...prev].slice(0, 50));
        playNewOrderSound();
      }
    });

    socket.on('order:status_changed', (event) => {
      setPendingOrders(prev =>
        prev.map(o => o.id === event.orderId ? { ...o, status: event.newStatus } : o)
      );
    });

    return () => {
      socket.off('order:created');
      socket.off('order:status_changed');
    };
  }, [socket]);

  // ─── Cart Operations ──────────────────────────────────────────────────────
  const addToCart = useCallback((product: Product, variant: ProductVariant | null, qty: number) => {
    setCart(prev => {
      const existing = prev.find(item =>
        item.productId === product.id && item.variantId === (variant?.id ?? null)
      );

      if (existing) {
        return prev.map(item =>
          item.id === existing.id
            ? { ...item, quantity: item.quantity + qty }
            : item
        );
      }

      return [...prev, {
        id: crypto.randomUUID(),
        productId: product.id,
        variantId: variant?.id ?? null,
        name: product.name,
        variantName: variant?.name ?? null,
        price: variant?.price ?? product.basePrice,
        quantity: qty,
        modifiers: [],
        notes: '',
        imageUrl: product.imageUrls[0] ?? null,
      }];
    });
  }, []);

  const updateQuantity = useCallback((itemId: string, qty: number) => {
    if (qty <= 0) {
      setCart(prev => prev.filter(item => item.id !== itemId));
    } else {
      setCart(prev => prev.map(item =>
        item.id === itemId ? { ...item, quantity: qty } : item
      ));
    }
  }, []);

  const removeFromCart = useCallback((itemId: string) => {
    setCart(prev => prev.filter(item => item.id !== itemId));
  }, []);

  const clearCart = useCallback(() => {
    setCart([]);
    setCustomerName('');
    setTableNumber('');
    setDiscountPercent(0);
    setCouponCode('');
    setNotes('');
  }, []);

  // ─── Totals ───────────────────────────────────────────────────────────────
  const subtotal = cart.reduce((sum, item) => {
    const modTotal = item.modifiers.reduce((m, mod) => m + mod.priceAdjustment, 0);
    return sum + (item.price + modTotal) * item.quantity;
  }, 0);

  const discountAmount = discountPercent > 0 ? subtotal * (discountPercent / 100) : 0;
  const taxRate = 0.16; // from store config
  const taxAmount = (subtotal - discountAmount) * taxRate;
  const total = subtotal - discountAmount + taxAmount;

  // ─── Submit Order ─────────────────────────────────────────────────────────
  const submitOrder = useCallback(async (paymentData: PaymentData) => {
    const idempotencyKey = crypto.randomUUID();

    const orderPayload = {
      storeId,
      type: 'POS' as const,
      fulfillmentType: tableNumber ? 'DINE_IN' as const : 'PICKUP' as const,
      items: cart.map(item => ({
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        modifiers: item.modifiers.map(m => ({ modifierId: m.modifierId })),
        notes: item.notes || undefined,
      })),
      customerName: customerName || undefined,
      tableNumber: tableNumber || undefined,
      notes: notes || undefined,
      couponCode: couponCode || undefined,
      assignedEmployeeId: employeeId,
      posTerminalId,
      payments: paymentData.payments,
      idempotencyKey,
    };

    try {
      if (!isConnected) {
        // Offline: queue for later sync
        enqueue({
          type: 'order:create',
          payload: orderPayload,
          idempotencyKey,
        });

        // Optimistic local "order" for receipt
        const localOrder = {
          id: idempotencyKey,
          orderNumber: `OFFLINE-${Date.now()}`,
          status: 'PENDING',
          items: cart,
          total,
          payments: paymentData.payments,
          createdAt: new Date(),
          _offline: true,
        };
        setLastOrder(localOrder as unknown as Order);
        clearCart();
        setShowPayment(false);
        return;
      }

      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify(orderPayload),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message ?? 'Order failed');
      }

      const { data: order } = await res.json();
      setLastOrder(order);
      clearCart();
      setShowPayment(false);
    } catch (err) {
      console.error('Order submission failed:', err);
      throw err;
    }
  }, [cart, storeId, posTerminalId, employeeId, customerName, tableNumber, notes, couponCode, total, isConnected, enqueue, clearCart]);

  return (
    <div className="pos-container">
      {/* Status Bar */}
      <div className="pos-statusbar">
        <div className="statusbar-left">
          <div className={`connection-dot ${isConnected ? 'online' : 'offline'}`} />
          <span>{isConnected ? 'Online' : 'Offline Mode'}</span>
          {isSyncing && <span className="sync-indicator">↑ Syncing...</span>}
        </div>
        <div className="statusbar-center">
          <button
            className={`tab-btn ${view === 'pos' ? 'active' : ''}`}
            onClick={() => setView('pos')}
          >
            Cashier
          </button>
          <button
            className={`tab-btn ${view === 'orders' ? 'active' : ''}`}
            onClick={() => setView('orders')}
          >
            Orders
            {pendingOrders.filter(o => o.status === 'PENDING').length > 0 && (
              <span className="badge">
                {pendingOrders.filter(o => o.status === 'PENDING').length}
              </span>
            )}
          </button>
        </div>
        <div className="statusbar-right">
          <span>{employeeName}</span>
          <button className="icon-btn" title="Cash Register">💰</button>
        </div>
      </div>

      {view === 'pos' && (
        <div className="pos-layout">
          {/* Left: Product Catalog */}
          <div className="pos-catalog">
            <div className="catalog-search">
              <input
                type="text"
                placeholder="Search products or scan barcode..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="search-input"
              />
            </div>
            <ProductGrid
              storeId={storeId}
              search={searchQuery}
              onSelect={addToCart}
            />
          </div>

          {/* Right: Cart */}
          <div className="pos-cart">
            {/* Order Options */}
            <div className="cart-options">
              <div className="order-type-tabs">
                {(['POS', 'ONLINE'] as const).map(type => (
                  <button
                    key={type}
                    className={`type-tab ${orderType === type ? 'active' : ''}`}
                    onClick={() => setOrderType(type)}
                  >
                    {type === 'POS' ? '🏪 Counter' : '📦 Online'}
                  </button>
                ))}
              </div>

              <div className="cart-fields">
                <input
                  type="text"
                  placeholder="Customer name"
                  value={customerName}
                  onChange={e => setCustomerName(e.target.value)}
                  className="field-input"
                />
                <input
                  type="text"
                  placeholder="Table #"
                  value={tableNumber}
                  onChange={e => setTableNumber(e.target.value)}
                  className="field-input field-small"
                />
              </div>
            </div>

            {/* Cart Items */}
            <div className="cart-items">
              {cart.length === 0 ? (
                <div className="cart-empty">
                  <div className="cart-empty-icon">🛒</div>
                  <p>Scan or tap products to add them</p>
                </div>
              ) : (
                cart.map(item => (
                  <CartItem
                    key={item.id}
                    item={item}
                    onUpdateQty={(qty) => updateQuantity(item.id, qty)}
                    onRemove={() => removeFromCart(item.id)}
                    onNotesChange={(notes) => setCart(prev =>
                      prev.map(i => i.id === item.id ? { ...i, notes } : i)
                    )}
                  />
                ))
              )}
            </div>

            {/* Discount / Coupon */}
            {cart.length > 0 && (
              <div className="cart-discounts">
                <div className="discount-row">
                  <label>Discount %</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={discountPercent || ''}
                    onChange={e => setDiscountPercent(Math.min(100, parseInt(e.target.value) || 0))}
                    className="field-input field-small"
                    placeholder="0"
                  />
                </div>
                <div className="discount-row">
                  <label>Coupon</label>
                  <input
                    type="text"
                    value={couponCode}
                    onChange={e => setCouponCode(e.target.value.toUpperCase())}
                    placeholder="CODE"
                    className="field-input field-small"
                  />
                </div>
              </div>
            )}

            {/* Totals */}
            <div className="cart-totals">
              <div className="total-row">
                <span>Subtotal</span>
                <span>${subtotal.toFixed(2)}</span>
              </div>
              {discountAmount > 0 && (
                <div className="total-row discount">
                  <span>Discount ({discountPercent}%)</span>
                  <span>-${discountAmount.toFixed(2)}</span>
                </div>
              )}
              <div className="total-row">
                <span>Tax (16%)</span>
                <span>${taxAmount.toFixed(2)}</span>
              </div>
              <div className="total-row grand-total">
                <span>Total</span>
                <span>${total.toFixed(2)}</span>
              </div>
            </div>

            {/* Actions */}
            <div className="cart-actions">
              <button
                className="btn-secondary"
                onClick={clearCart}
                disabled={cart.length === 0}
              >
                Clear
              </button>
              <button
                className="btn-primary"
                onClick={() => setShowPayment(true)}
                disabled={cart.length === 0}
              >
                Charge ${total.toFixed(2)}
              </button>
            </div>
          </div>
        </div>
      )}

      {view === 'orders' && (
        <OrderQueue
          storeId={storeId}
          orders={pendingOrders}
          onStatusChange={async (orderId, status) => {
            const res = await fetch(`/api/orders/${orderId}/status`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${getToken()}`,
              },
              body: JSON.stringify({ status }),
            });
            if (res.ok) {
              const { data } = await res.json();
              setPendingOrders(prev =>
                prev.map(o => o.id === orderId ? data : o)
              );
            }
          }}
        />
      )}

      {/* Payment Modal */}
      {showPayment && (
        <PaymentModal
          total={total}
          onSubmit={submitOrder}
          onClose={() => setShowPayment(false)}
        />
      )}

      {/* Last Order Receipt */}
      {lastOrder && (
        <div className="receipt-overlay">
          <OrderTicket
            order={lastOrder}
            onClose={() => setLastOrder(null)}
            onPrint={() => printReceipt(lastOrder)}
            onNewOrder={() => setLastOrder(null)}
          />
        </div>
      )}
    </div>
  );
}

// ─── Order Queue Component ────────────────────────────────────────────────────
function OrderQueue({ storeId, orders, onStatusChange }: {
  storeId: string;
  orders: Order[];
  onStatusChange: (id: string, status: string) => Promise<void>;
}) {
  const [loading, setLoading] = useState<string | null>(null);

  const statusColors: Record<string, string> = {
    PENDING: 'status-pending',
    CONFIRMED: 'status-confirmed',
    PREPARING: 'status-preparing',
    READY: 'status-ready',
    CANCELLED: 'status-cancelled',
  };

  const nextStatus: Record<string, string> = {
    PENDING: 'CONFIRMED',
    CONFIRMED: 'PREPARING',
    PREPARING: 'READY',
    READY: 'PICKED_UP',
  };

  return (
    <div className="order-queue">
      <h2>Incoming Orders</h2>
      <div className="orders-grid">
        {orders.length === 0 && (
          <div className="empty-state">No active orders</div>
        )}
        {orders.map(order => (
          <div key={order.id} className={`order-card ${statusColors[order.status] ?? ''}`}>
            <div className="order-card-header">
              <strong>{order.orderNumber}</strong>
              <span className={`status-badge ${statusColors[order.status] ?? ''}`}>
                {order.status}
              </span>
            </div>
            <div className="order-card-customer">
              {order.customerName ?? 'Walk-in'} •{' '}
              {order.type === 'SHOPIFY' ? '🛍 Online' : order.type === 'POS' ? '🏪 Counter' : '📱 App'}
            </div>
            <div className="order-card-items">
              {order.items?.map((item, i) => (
                <div key={i} className="order-item-row">
                  <span className="qty">{item.quantity}×</span>
                  <span className="item-name">{item.name}</span>
                  {item.variantName && <span className="variant">({item.variantName})</span>}
                </div>
              ))}
            </div>
            {order.notes && (
              <div className="order-notes">📝 {order.notes}</div>
            )}
            <div className="order-card-footer">
              <span className="order-time">
                {new Date(order.createdAt).toLocaleTimeString()}
              </span>
              <strong>${Number(order.total).toFixed(2)}</strong>
              {nextStatus[order.status] && (
                <button
                  className="btn-advance"
                  disabled={loading === order.id}
                  onClick={async () => {
                    setLoading(order.id);
                    try {
                      await onStatusChange(order.id, nextStatus[order.status]);
                    } finally {
                      setLoading(null);
                    }
                  }}
                >
                  {loading === order.id ? '...' : `→ ${nextStatus[order.status]}`}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function getToken(): string {
  return localStorage.getItem('pos_token') ?? '';
}

function playSuccessSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.1);
  } catch {}
}

function playErrorSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 220;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch {}
}

function playNewOrderSound() {
  try {
    const ctx = new AudioContext();
    [440, 554, 659].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      const start = ctx.currentTime + i * 0.15;
      gain.gain.setValueAtTime(0.2, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.15);
      osc.start(start);
      osc.stop(start + 0.15);
    });
  } catch {}
}

async function printReceipt(order: Order): Promise<void> {
  await fetch(`/api/orders/${order.id}/print`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
  });
}

// Type stubs (to be imported from @snackpos/types in real code)
type Order = {
  id: string;
  orderNumber: string;
  status: string;
  type: string;
  customerName: string | null;
  items: Array<{ name: string; quantity: number; variantName: string | null }>;
  total: number;
  notes: string | null;
  payments: unknown[];
  createdAt: Date;
  _offline?: boolean;
};

type PaymentData = {
  payments: Array<{ method: string; amount: number; cashTendered?: number }>;
};
