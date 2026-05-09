// apps/web/src/app/track/[orderNumber]/page.tsx
// Real-time order status tracking for customers

'use client';

import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { Order, OrderStatus } from '@snackpos/types';

interface TrackPageProps {
  params: { orderNumber: string };
  searchParams: { storeId?: string };
}

const STATUS_STEPS: OrderStatus[] = [
  'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED',
];

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Order Received',
  CONFIRMED: 'Order Confirmed',
  PREPARING: 'Being Prepared',
  READY: 'Ready for Pickup',
  OUT_FOR_DELIVERY: 'Out for Delivery',
  DELIVERED: 'Delivered!',
  PICKED_UP: 'Picked Up!',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
};

const STATUS_ICONS: Record<string, string> = {
  PENDING: '📋',
  CONFIRMED: '✅',
  PREPARING: '👨‍🍳',
  READY: '🎉',
  OUT_FOR_DELIVERY: '🚗',
  DELIVERED: '🏠',
  PICKED_UP: '👋',
  CANCELLED: '❌',
  REFUNDED: '💰',
};

const STATUS_DESCRIPTIONS: Record<string, string> = {
  PENDING: 'We received your order and are reviewing it.',
  CONFIRMED: 'Your order has been confirmed and is queued for preparation.',
  PREPARING: 'Our kitchen team is preparing your order right now!',
  READY: 'Your order is ready! Come pick it up.',
  OUT_FOR_DELIVERY: 'Your order is on the way to you.',
  DELIVERED: 'Your order was delivered. Enjoy!',
  PICKED_UP: 'Order picked up. Enjoy your snacks!',
  CANCELLED: 'Your order was cancelled.',
  REFUNDED: 'Your order has been refunded.',
};

export default function TrackOrderPage({ params, searchParams }: TrackPageProps) {
  const { orderNumber } = params;
  const storeId = searchParams.storeId ?? process.env.NEXT_PUBLIC_STORE_ID!;

  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());

  // Load order
  useEffect(() => {
    fetch(`/api/orders?storeId=${storeId}&search=${encodeURIComponent(orderNumber)}&perPage=1`)
      .then(r => r.json())
      .then(({ data }) => {
        const found = data?.[0] ?? null;
        setOrder(found);
        setLoading(false);
        if (!found) setError('Order not found. Check your order number.');
      })
      .catch(() => {
        setError('Failed to load order. Please try again.');
        setLoading(false);
      });
  }, [orderNumber, storeId]);

  // Real-time updates
  useEffect(() => {
    if (!order) return;

    const socket: Socket = io(process.env.NEXT_PUBLIC_API_URL!, {
      auth: { storeId, clientType: 'customer' },
      transports: ['websocket'],
    });

    socket.on('connect', () => {
      socket.emit('order:subscribe', { orderId: order.id });
    });

    socket.on('order:status_changed', (event) => {
      if (event.orderId === order.id) {
        setOrder(prev => prev ? { ...prev, status: event.newStatus } : prev);
        setLastUpdated(new Date());
      }
    });

    return () => { socket.disconnect(); };
  }, [order?.id, storeId]);

  if (loading) {
    return (
      <div className="track-page">
        <div className="track-loading">
          <div className="spinner" />
          <p>Loading your order...</p>
        </div>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="track-page">
        <div className="track-error">
          <div className="error-icon">❌</div>
          <h2>Order Not Found</h2>
          <p>{error ?? 'We could not find an order with that number.'}</p>
          <a href="/" className="btn-primary">Back to Store</a>
        </div>
      </div>
    );
  }

  const isFinal = ['DELIVERED', 'PICKED_UP', 'CANCELLED', 'REFUNDED'].includes(order.status);
  const currentStepIdx = STATUS_STEPS.indexOf(order.status as OrderStatus);

  return (
    <div className="track-page">
      <div className="track-card">
        {/* Header */}
        <div className="track-header">
          <div className="track-icon">{STATUS_ICONS[order.status] ?? '📦'}</div>
          <div>
            <h1 className="track-title">{STATUS_LABELS[order.status] ?? order.status}</h1>
            <p className="track-order-num">Order #{order.orderNumber}</p>
          </div>
        </div>

        {/* Description */}
        <div className={`track-status-desc ${isFinal ? 'final' : ''}`}>
          {STATUS_DESCRIPTIONS[order.status] ?? ''}
        </div>

        {/* Progress Steps */}
        {!['CANCELLED', 'REFUNDED'].includes(order.status) && (
          <div className="track-steps">
            {STATUS_STEPS.slice(0, order.fulfillmentType === 'DELIVERY' ? 5 : 4).map((step, idx) => {
              const isComplete = currentStepIdx > idx;
              const isCurrent = currentStepIdx === idx;
              const label = STATUS_LABELS[step] ?? step;

              return (
                <div key={step} className="track-step-wrapper">
                  <div className={`track-step ${isComplete ? 'complete' : ''} ${isCurrent ? 'current' : ''}`}>
                    <div className="step-dot">
                      {isComplete ? '✓' : isCurrent ? <span className="step-pulse" /> : null}
                    </div>
                    <span className="step-label">{label}</span>
                  </div>
                  {idx < (order.fulfillmentType === 'DELIVERY' ? 4 : 3) && (
                    <div className={`step-connector ${isComplete ? 'complete' : ''}`} />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Order Details */}
        <div className="track-details">
          <h3>Order Summary</h3>
          <div className="track-items">
            {order.items.map((item, i) => (
              <div key={i} className="track-item">
                <span className="track-item-qty">{item.quantity}×</span>
                <span className="track-item-name">
                  {item.name}
                  {item.variantName ? ` (${item.variantName})` : ''}
                </span>
                <span className="track-item-price">${item.total.toFixed(2)}</span>
              </div>
            ))}
          </div>

          <div className="track-totals">
            <div className="track-total-row">
              <span>Subtotal</span>
              <span>${order.subtotal.toFixed(2)}</span>
            </div>
            {order.discountAmount > 0 && (
              <div className="track-total-row discount">
                <span>Discount</span>
                <span>-${order.discountAmount.toFixed(2)}</span>
              </div>
            )}
            <div className="track-total-row">
              <span>Tax</span>
              <span>${order.taxAmount.toFixed(2)}</span>
            </div>
            {order.deliveryFee > 0 && (
              <div className="track-total-row">
                <span>Delivery</span>
                <span>${order.deliveryFee.toFixed(2)}</span>
              </div>
            )}
            <div className="track-total-row total">
              <span>Total</span>
              <span>${order.total.toFixed(2)}</span>
            </div>
          </div>

          {order.notes && (
            <div className="track-notes">
              <span>📝 Note:</span> {order.notes}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="track-footer">
          <p className="track-update-time">
            Last updated: {lastUpdated.toLocaleTimeString()}
          </p>
          <div className="track-footer-actions">
            <a href="/" className="btn-secondary">New Order</a>
            {!isFinal && (
              <button
                className="btn-refresh"
                onClick={() => window.location.reload()}
              >
                Refresh
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
