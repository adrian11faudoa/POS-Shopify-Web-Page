// apps/admin/src/app/dashboard/page.tsx
// Production admin dashboard with KPI cards, charts, and real-time inventory alerts

'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import type { DashboardMetrics } from '@snackpos/types';

const CHART_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

interface KPICardProps {
  title: string;
  value: string;
  change: number;
  trend: 'up' | 'down' | 'flat';
  icon: string;
  prefix?: string;
  loading?: boolean;
}

function KPICard({ title, value, change, trend, icon, prefix = '', loading }: KPICardProps) {
  return (
    <div className={`kpi-card ${loading ? 'kpi-card--loading' : ''}`}>
      <div className="kpi-header">
        <span className="kpi-icon">{icon}</span>
        <span className={`kpi-trend kpi-trend--${trend}`}>
          {trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'}
          {' '}{Math.abs(change).toFixed(1)}%
        </span>
      </div>
      <div className="kpi-value">
        {prefix}{loading ? '—' : value}
      </div>
      <div className="kpi-title">{title}</div>
      <div className="kpi-vs">vs yesterday</div>
    </div>
  );
}

function MetricSkeleton() {
  return <div className="kpi-card kpi-card--skeleton" aria-hidden />;
}

export default function DashboardPage() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('admin_token') ?? '';
      const res = await fetch(`/api/analytics/dashboard?date=${selectedDate}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to fetch metrics');
      const { data } = await res.json();
      setMetrics(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [selectedDate, refreshKey]);

  useEffect(() => { fetchMetrics(); }, [fetchMetrics]);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    const interval = setInterval(() => setRefreshKey(k => k + 1), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const fmt = (n: number) => n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtInt = (n: number) => n.toLocaleString('es-MX');

  return (
    <div className="admin-page">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">
            {new Date(selectedDate).toLocaleDateString('es-MX', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            })}
          </p>
        </div>
        <div className="page-header-actions">
          <input
            type="date"
            value={selectedDate}
            max={new Date().toISOString().split('T')[0]}
            onChange={e => setSelectedDate(e.target.value)}
            className="date-picker"
          />
          <button
            className="btn-icon"
            onClick={() => setRefreshKey(k => k + 1)}
            title="Refresh"
          >
            ↻
          </button>
        </div>
      </div>

      {error && (
        <div className="alert alert-error">
          {error}
          <button onClick={fetchMetrics}>Retry</button>
        </div>
      )}

      {/* KPI Cards */}
      <div className="kpi-grid">
        {loading || !metrics ? (
          <>
            <MetricSkeleton /><MetricSkeleton />
            <MetricSkeleton /><MetricSkeleton />
          </>
        ) : (
          <>
            <KPICard
              title="Revenue"
              value={`$${fmt(metrics.revenue.current)}`}
              change={metrics.revenue.change}
              trend={metrics.revenue.trend}
              icon="💰"
            />
            <KPICard
              title="Orders"
              value={fmtInt(metrics.orders.current)}
              change={metrics.orders.change}
              trend={metrics.orders.trend}
              icon="📦"
            />
            <KPICard
              title="Avg Order Value"
              value={`$${fmt(metrics.averageOrderValue.current)}`}
              change={metrics.averageOrderValue.change}
              trend={metrics.averageOrderValue.trend}
              icon="🧾"
            />
            <KPICard
              title="New Customers"
              value={fmtInt(metrics.newCustomers.current)}
              change={metrics.newCustomers.change}
              trend={metrics.newCustomers.trend}
              icon="👥"
            />
          </>
        )}
      </div>

      {/* Charts Row */}
      <div className="charts-row">
        {/* Hourly Revenue */}
        <div className="chart-card chart-card--wide">
          <div className="chart-header">
            <h2>Revenue by Hour</h2>
            <span className="chart-badge">Today</span>
          </div>
          <div className="chart-body">
            {loading || !metrics ? (
              <div className="chart-skeleton" />
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={metrics.hourlyRevenue} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
                  <XAxis
                    dataKey="hour"
                    tickFormatter={(h) => `${h}:00`}
                    tick={{ fontSize: 11, fill: '#94a3b8' }}
                    interval={3}
                  />
                  <YAxis
                    tickFormatter={(v) => `$${v}`}
                    tick={{ fontSize: 11, fill: '#94a3b8' }}
                    width={60}
                  />
                  <Tooltip
                    formatter={(value: number) => [`$${fmt(value)}`, 'Revenue']}
                    labelFormatter={(label) => `${label}:00 hrs`}
                    contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                  />
                  <Bar dataKey="revenue" fill="#6366f1" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Orders by Type */}
        <div className="chart-card">
          <div className="chart-header">
            <h2>Orders by Type</h2>
          </div>
          <div className="chart-body">
            {loading || !metrics ? (
              <div className="chart-skeleton" />
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={metrics.ordersByType}
                    dataKey="count"
                    nameKey="type"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    label={({ type, percent }) => `${type} ${(percent * 100).toFixed(0)}%`}
                    labelLine={false}
                  >
                    {metrics.ordersByType.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v: number, name: string) => [v, name]}
                    contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Row */}
      <div className="bottom-row">
        {/* Top Products */}
        <div className="data-card">
          <div className="data-card-header">
            <h2>Top Products</h2>
            <a href="/admin/products" className="link-sm">View all →</a>
          </div>
          <div className="data-card-body">
            {loading || !metrics ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="data-row data-row--skeleton" />
              ))
            ) : metrics.topProducts.length === 0 ? (
              <p className="empty-state">No sales data for this period</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Product</th>
                    <th className="right">Units</th>
                    <th className="right">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.topProducts.slice(0, 8).map((product) => (
                    <tr key={product.productId}>
                      <td className="rank">#{product.rank}</td>
                      <td>
                        <div className="product-name-cell">
                          {product.imageUrl && (
                            <img src={product.imageUrl} alt="" className="product-thumb" />
                          )}
                          <span>{product.name}</span>
                        </div>
                      </td>
                      <td className="right">{fmtInt(product.quantitySold)}</td>
                      <td className="right">${fmt(product.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Inventory Alerts */}
        <div className="data-card">
          <div className="data-card-header">
            <h2>
              Inventory Alerts
              {metrics && metrics.inventoryAlerts.length > 0 && (
                <span className="badge badge-red">{metrics.inventoryAlerts.length}</span>
              )}
            </h2>
            <a href="/admin/inventory" className="link-sm">Manage →</a>
          </div>
          <div className="data-card-body">
            {loading || !metrics ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="data-row data-row--skeleton" />
              ))
            ) : metrics.inventoryAlerts.length === 0 ? (
              <div className="empty-state-positive">
                <span>✓</span>
                <p>All inventory levels are healthy</p>
              </div>
            ) : (
              <div className="alert-list">
                {metrics.inventoryAlerts.map((alert) => (
                  <div
                    key={alert.variantId}
                    className={`inventory-alert ${alert.alertType === 'OUT_OF_STOCK' ? 'alert-critical' : 'alert-warning'}`}
                  >
                    <div className="alert-icon">
                      {alert.alertType === 'OUT_OF_STOCK' ? '🚨' : '⚠️'}
                    </div>
                    <div className="alert-info">
                      <div className="alert-product">{alert.productName}</div>
                      <div className="alert-variant">{alert.variantName}</div>
                      <div className="alert-qty">
                        {alert.alertType === 'OUT_OF_STOCK'
                          ? 'Out of stock'
                          : `${alert.quantity} left (threshold: ${alert.threshold})`}
                      </div>
                    </div>
                    <a
                      href={`/admin/inventory?variant=${alert.variantId}`}
                      className="alert-action"
                    >
                      Restock →
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Payment Methods */}
        <div className="data-card">
          <div className="data-card-header">
            <h2>Revenue by Payment</h2>
          </div>
          <div className="data-card-body">
            {loading || !metrics ? (
              <div className="chart-skeleton" />
            ) : (
              <>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart
                    data={metrics.revenueByPaymentMethod}
                    layout="vertical"
                    margin={{ top: 0, right: 60, left: 0, bottom: 0 }}
                  >
                    <XAxis type="number" hide />
                    <YAxis
                      type="category"
                      dataKey="method"
                      tick={{ fontSize: 12, fill: '#94a3b8' }}
                      width={60}
                    />
                    <Tooltip
                      formatter={(v: number) => [`$${fmt(v)}`, 'Amount']}
                      contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                    />
                    <Bar dataKey="amount" radius={[0, 4, 4, 0]}>
                      {metrics.revenueByPaymentMethod.map((_, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>

                <div className="payment-breakdown">
                  {metrics.revenueByPaymentMethod.map((pm, i) => (
                    <div key={pm.method} className="payment-row">
                      <span className="payment-dot" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                      <span className="payment-method">{pm.method}</span>
                      <span className="payment-pct">{pm.percentage}%</span>
                      <span className="payment-amount">${fmt(pm.amount)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Order Status */}
      <div className="status-breakdown">
        <div className="data-card-header">
          <h2>Orders by Status</h2>
        </div>
        <div className="status-pills">
          {loading || !metrics ? (
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="status-pill status-pill--skeleton" />
            ))
          ) : (
            metrics.ordersByStatus.map((s) => (
              <div key={s.status} className={`status-pill status-${s.status.toLowerCase()}`}>
                <span className="status-pill-count">{s.count}</span>
                <span className="status-pill-label">{s.status}</span>
                <span className="status-pill-pct">{s.percentage}%</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
