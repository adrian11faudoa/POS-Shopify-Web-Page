// apps/kds/src/components/KitchenDisplay.tsx
// Real-time Kitchen Display System with item-level tracking and timer alerts

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSocket } from '../hooks/useSocket';
import type { Order, OrderItem, OrderItemStatus } from '@snackpos/types';

interface KDSOrder {
  id: string;
  orderNumber: string;
  type: string;
  customerName: string | null;
  tableNumber: string | null;
  notes: string | null;
  items: KDSItem[];
  createdAt: Date;
  confirmedAt: Date | null;
  elapsedSeconds: number;
}

interface KDSItem extends OrderItem {
  isBeingPrepared: boolean;
  prepStartedAt: Date | null;
}

type ColumnLayout = 'two' | 'three' | 'four';

interface KitchenDisplayProps {
  storeId: string;
  posTerminalId: string;
}

// Time thresholds in seconds
const WARN_THRESHOLD = 8 * 60;  // 8 minutes
const ALERT_THRESHOLD = 12 * 60; // 12 minutes

export function KitchenDisplay({ storeId, posTerminalId }: KitchenDisplayProps) {
  const { socket, isConnected } = useSocket(storeId, posTerminalId, 'kds');
  const [orders, setOrders] = useState<KDSOrder[]>([]);
  const [layout, setLayout] = useState<ColumnLayout>('three');
  const [filter, setFilter] = useState<'all' | 'pending' | 'preparing'>('all');
  const [completedOrders, setCompletedOrders] = useState<KDSOrder[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  // ─── Elapsed Time Ticker ────────────────────────────────────────────────────
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setOrders(prev => prev.map(order => ({
        ...order,
        elapsedSeconds: Math.floor(
          (Date.now() - new Date(order.confirmedAt ?? order.createdAt).getTime()) / 1000
        ),
      })));
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, []);

  // ─── Load Active Orders on Mount ────────────────────────────────────────────
  useEffect(() => {
    const token = localStorage.getItem('kds_token') ?? '';
    fetch(`/api/orders?storeId=${storeId}&status=CONFIRMED,PREPARING&perPage=50`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(({ data }) => {
        const now = Date.now();
        setOrders((data.orders ?? []).map((o: Order) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          type: o.type,
          customerName: o.customerName,
          tableNumber: o.tableNumber,
          notes: o.notes,
          items: o.items.filter(i => i.status !== 'CANCELLED').map(i => ({
            ...i,
            isBeingPrepared: i.status === 'PREPARING',
            prepStartedAt: null,
          })),
          createdAt: new Date(o.createdAt),
          confirmedAt: o.confirmedAt ? new Date(o.confirmedAt) : null,
          elapsedSeconds: Math.floor(
            (now - new Date(o.confirmedAt ?? o.createdAt).getTime()) / 1000
          ),
        })));
      })
      .catch(err => console.error('Failed to load orders:', err));
  }, [storeId]);

  // ─── Socket Events ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    socket.on('kds:order', (event) => {
      const order = event.order;
      const newKDSOrder: KDSOrder = {
        id: order.id,
        orderNumber: order.orderNumber,
        type: order.type,
        customerName: order.customerName ?? null,
        tableNumber: order.tableNumber ?? null,
        notes: order.notes ?? null,
        items: (order.items ?? [])
          .filter((i: OrderItem) => i.status !== 'CANCELLED')
          .map((i: OrderItem) => ({
            ...i,
            isBeingPrepared: false,
            prepStartedAt: null,
          })),
        createdAt: new Date(order.createdAt),
        confirmedAt: new Date(),
        elapsedSeconds: 0,
      };

      setOrders(prev => {
        const exists = prev.find(o => o.id === order.id);
        if (exists) return prev;
        return [newKDSOrder, ...prev];
      });

      // Flash notification
      document.title = `🔔 NEW ORDER - KDS`;
      setTimeout(() => { document.title = 'Kitchen Display'; }, 3000);
    });

    socket.on('order:status_changed', (event) => {
      if (['CANCELLED', 'PICKED_UP', 'DELIVERED'].includes(event.newStatus)) {
        setOrders(prev => {
          const order = prev.find(o => o.id === event.orderId);
          if (order) {
            setCompletedOrders(c => [order, ...c].slice(0, 10));
          }
          return prev.filter(o => o.id !== event.orderId);
        });
      }
    });

    socket.on('order_item:status_changed', (event) => {
      setOrders(prev => prev.map(order => {
        if (order.id !== event.orderId) return order;
        return {
          ...order,
          items: order.items.map(item => {
            if (item.id !== event.itemId) return item;
            return {
              ...item,
              status: event.newStatus as OrderItemStatus,
              isBeingPrepared: event.newStatus === 'PREPARING',
              prepStartedAt: event.newStatus === 'PREPARING' ? new Date() : item.prepStartedAt,
            };
          }),
        };
      }));
    });

    return () => {
      socket.off('kds:order');
      socket.off('order:status_changed');
      socket.off('order_item:status_changed');
    };
  }, [socket]);

  // ─── Actions ────────────────────────────────────────────────────────────────
  const markItemPreparing = useCallback((orderId: string, itemId: string) => {
    socket?.emit('kds:item_preparing', { orderId, itemId });
    setOrders(prev => prev.map(order => {
      if (order.id !== orderId) return order;
      return {
        ...order,
        items: order.items.map(item =>
          item.id === itemId
            ? { ...item, status: 'PREPARING' as OrderItemStatus, isBeingPrepared: true, prepStartedAt: new Date() }
            : item
        ),
      };
    }));
  }, [socket]);

  const markItemReady = useCallback((orderId: string, itemId: string) => {
    socket?.emit('kds:item_ready', { orderId, itemId });
    setOrders(prev => prev.map(order => {
      if (order.id !== orderId) return order;
      const updatedItems = order.items.map(item =>
        item.id === itemId
          ? { ...item, status: 'READY' as OrderItemStatus, isBeingPrepared: false }
          : item
      );
      return { ...order, items: updatedItems };
    }));
  }, [socket]);

  const markOrderComplete = useCallback(async (orderId: string) => {
    const token = localStorage.getItem('kds_token') ?? '';
    await fetch(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ status: 'READY' }),
    });

    setOrders(prev => {
      const order = prev.find(o => o.id === orderId);
      if (order) setCompletedOrders(c => [order, ...c].slice(0, 10));
      return prev.filter(o => o.id !== orderId);
    });
  }, []);

  // ─── Filtering ───────────────────────────────────────────────────────────────
  const filteredOrders = orders.filter(order => {
    if (filter === 'pending') return order.items.every(i => i.status === 'PENDING');
    if (filter === 'preparing') return order.items.some(i => i.status === 'PREPARING');
    return true;
  });

  const columnClass = { two: 'cols-2', three: 'cols-3', four: 'cols-4' }[layout];

  return (
    <div className="kds-root">
      {/* Header */}
      <div className="kds-header">
        <div className="kds-header-left">
          <h1 className="kds-title">Kitchen</h1>
          <div className={`kds-connection ${isConnected ? 'online' : 'offline'}`}>
            <span className="dot" />
            {isConnected ? 'Live' : 'Offline'}
          </div>
          <div className="kds-stats">
            <span>{orders.length} active</span>
            {orders.filter(o => o.elapsedSeconds > WARN_THRESHOLD).length > 0 && (
              <span className="stat-warn">
                ⚠ {orders.filter(o => o.elapsedSeconds > WARN_THRESHOLD).length} late
              </span>
            )}
          </div>
        </div>

        <div className="kds-header-center">
          <div className="kds-filters">
            {(['all', 'pending', 'preparing'] as const).map(f => (
              <button
                key={f}
                className={`filter-btn ${filter === f ? 'active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="kds-header-right">
          <div className="layout-switcher">
            {(['two', 'three', 'four'] as const).map(l => (
              <button
                key={l}
                className={`layout-btn ${layout === l ? 'active' : ''}`}
                onClick={() => setLayout(l)}
                title={`${l} columns`}
              >
                {l === 'two' ? '⊞' : l === 'three' ? '⊟' : '⊠'}
              </button>
            ))}
          </div>
          <div className="kds-clock">
            {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      </div>

      {/* Order Grid */}
      <div className={`kds-grid ${columnClass}`}>
        {filteredOrders.length === 0 && (
          <div className="kds-empty">
            <div className="kds-empty-icon">✓</div>
            <p>All caught up</p>
          </div>
        )}

        {filteredOrders.map(order => (
          <KDSOrderCard
            key={order.id}
            order={order}
            onItemPreparing={markItemPreparing}
            onItemReady={markItemReady}
            onOrderComplete={markOrderComplete}
          />
        ))}
      </div>

      {/* Completed Orders Strip */}
      {completedOrders.length > 0 && (
        <div className="kds-completed-strip">
          <span className="strip-label">Recent:</span>
          {completedOrders.slice(0, 5).map(o => (
            <span key={o.id} className="completed-badge">
              ✓ {o.orderNumber}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Order Card ───────────────────────────────────────────────────────────────
function KDSOrderCard({ order, onItemPreparing, onItemReady, onOrderComplete }: {
  order: KDSOrder;
  onItemPreparing: (orderId: string, itemId: string) => void;
  onItemReady: (orderId: string, itemId: string) => void;
  onOrderComplete: (orderId: string) => Promise<void>;
}) {
  const allReady = order.items.every(i => i.status === 'READY' || i.status === 'SERVED');
  const someReady = order.items.some(i => i.status === 'READY');

  const urgency =
    order.elapsedSeconds > ALERT_THRESHOLD ? 'urgent' :
    order.elapsedSeconds > WARN_THRESHOLD ? 'warning' : 'normal';

  const pendingItems = order.items.filter(i => i.status === 'PENDING');
  const preparingItems = order.items.filter(i => i.status === 'PREPARING');
  const readyItems = order.items.filter(i => i.status === 'READY' || i.status === 'SERVED');

  return (
    <div className={`kds-card kds-card--${urgency} ${allReady ? 'kds-card--complete' : ''}`}>
      {/* Card Header */}
      <div className="kds-card-header">
        <div className="kds-card-order">
          <span className="order-num">{order.orderNumber}</span>
          <span className={`order-type type-${order.type.toLowerCase()}`}>
            {order.type === 'SHOPIFY' ? 'Online' : order.type === 'POS' ? 'Counter' : 'App'}
          </span>
        </div>
        <div className="kds-card-meta">
          {order.tableNumber && (
            <span className="table-badge">Table {order.tableNumber}</span>
          )}
          {order.customerName && (
            <span className="customer-name">{order.customerName}</span>
          )}
        </div>
        <div className="kds-timer">
          <KDSTimer seconds={order.elapsedSeconds} urgency={urgency} />
        </div>
      </div>

      {/* Notes */}
      {order.notes && (
        <div className="kds-card-notes">
          <span className="notes-icon">📝</span>
          {order.notes}
        </div>
      )}

      {/* Items */}
      <div className="kds-card-items">
        {/* Pending items */}
        {pendingItems.map(item => (
          <KDSItemRow
            key={item.id}
            item={item}
            status="pending"
            onPreparing={() => onItemPreparing(order.id, item.id)}
          />
        ))}

        {/* Preparing items */}
        {preparingItems.map(item => (
          <KDSItemRow
            key={item.id}
            item={item}
            status="preparing"
            onReady={() => onItemReady(order.id, item.id)}
          />
        ))}

        {/* Ready items */}
        {readyItems.map(item => (
          <KDSItemRow
            key={item.id}
            item={item}
            status="ready"
          />
        ))}
      </div>

      {/* Progress Bar */}
      <div className="kds-progress">
        <div
          className="kds-progress-bar"
          style={{
            width: `${Math.round((readyItems.length / order.items.length) * 100)}%`,
            background: allReady ? '#22c55e' : someReady ? '#f59e0b' : '#3b82f6',
          }}
        />
      </div>

      {/* Card Footer */}
      <div className="kds-card-footer">
        <span className="item-count">
          {readyItems.length}/{order.items.length} ready
        </span>
        {allReady ? (
          <button
            className="btn-complete"
            onClick={() => onOrderComplete(order.id)}
          >
            ✓ Order Ready
          </button>
        ) : preparingItems.length === 0 && pendingItems.length > 0 ? (
          <button
            className="btn-start-all"
            onClick={() => pendingItems.forEach(i => onItemPreparing(order.id, i.id))}
          >
            Start All
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ─── Item Row ─────────────────────────────────────────────────────────────────
function KDSItemRow({ item, status, onPreparing, onReady }: {
  item: KDSItem;
  status: 'pending' | 'preparing' | 'ready';
  onPreparing?: () => void;
  onReady?: () => void;
}) {
  return (
    <div className={`kds-item kds-item--${status}`}>
      <div className="kds-item-left">
        <span className="item-qty">{item.quantity}×</span>
        <div className="item-details">
          <span className="item-name">{item.name}</span>
          {item.variantName && (
            <span className="item-variant">{item.variantName}</span>
          )}
          {(item.modifiers as { name: string; priceAdjustment: number }[])?.map((mod, i) => (
            <span key={i} className="item-modifier">+ {mod.name}</span>
          ))}
          {item.notes && (
            <span className="item-note">📝 {item.notes}</span>
          )}
        </div>
      </div>

      <div className="kds-item-actions">
        {status === 'pending' && (
          <button
            className="item-btn item-btn--start"
            onClick={onPreparing}
            title="Start preparing"
          >
            ▶
          </button>
        )}
        {status === 'preparing' && (
          <div className="preparing-indicator">
            <span className="prep-dot" />
            <button
              className="item-btn item-btn--ready"
              onClick={onReady}
              title="Mark ready"
            >
              ✓
            </button>
          </div>
        )}
        {status === 'ready' && (
          <span className="ready-check">✓</span>
        )}
      </div>
    </div>
  );
}

// ─── Timer ────────────────────────────────────────────────────────────────────
function KDSTimer({ seconds, urgency }: { seconds: number; urgency: string }) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return (
    <span className={`kds-time kds-time--${urgency}`}>
      {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
      {urgency === 'urgent' && ' ⚠'}
    </span>
  );
}
