// apps/admin/src/app/reports/page.tsx
// Sales reports with period selection, breakdown tables, and CSV export

'use client';

import { useState, useCallback } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import type { SalesReport } from '@snackpos/types';

type Preset = 'today' | 'yesterday' | '7days' | '30days' | 'month' | 'custom';

const PRESETS: { label: string; value: Preset }[] = [
  { label: 'Today', value: 'today' },
  { label: 'Yesterday', value: 'yesterday' },
  { label: '7 Days', value: '7days' },
  { label: '30 Days', value: '30days' },
  { label: 'This Month', value: 'month' },
  { label: 'Custom', value: 'custom' },
];

function getDateRange(preset: Preset): { start: Date; end: Date } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (preset) {
    case 'today':
      return { start: today, end: new Date() };
    case 'yesterday': {
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      const end = new Date(yesterday);
      end.setHours(23, 59, 59, 999);
      return { start: yesterday, end };
    }
    case '7days': {
      const start = new Date(today);
      start.setDate(today.getDate() - 7);
      return { start, end: new Date() };
    }
    case '30days': {
      const start = new Date(today);
      start.setDate(today.getDate() - 30);
      return { start, end: new Date() };
    }
    case 'month':
      return {
        start: new Date(now.getFullYear(), now.getMonth(), 1),
        end: new Date(),
      };
    default:
      return { start: today, end: new Date() };
  }
}

export default function ReportsPage() {
  const [preset, setPreset] = useState<Preset>('7days');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [report, setReport] = useState<SalesReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'products' | 'employees' | 'categories'>('overview');

  const generateReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { start, end } = preset === 'custom'
        ? { start: new Date(customStart), end: new Date(customEnd + 'T23:59:59') }
        : getDateRange(preset);

      const token = localStorage.getItem('admin_token') ?? '';
      const params = new URLSearchParams({
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      });

      const res = await fetch(`/api/analytics/sales-report?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to generate report');
      const { data } = await res.json();
      setReport(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [preset, customStart, customEnd]);

  const exportCSV = useCallback(async () => {
    const { start, end } = preset === 'custom'
      ? { start: new Date(customStart), end: new Date(customEnd + 'T23:59:59') }
      : getDateRange(preset);

    const token = localStorage.getItem('admin_token') ?? '';
    const params = new URLSearchParams({
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      format: 'csv',
    });

    const res = await fetch(`/api/analytics/export?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales-report-${start.toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [preset, customStart, customEnd]);

  const fmt = (n: number) => `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
  const fmtInt = (n: number) => n.toLocaleString('es-MX');

  return (
    <div className="admin-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Sales Reports</h1>
          <p className="page-subtitle">Detailed revenue and order analysis</p>
        </div>
        {report && (
          <button className="btn-secondary" onClick={exportCSV}>
            ⬇ Export CSV
          </button>
        )}
      </div>

      {/* Period Selector */}
      <div className="report-controls">
        <div className="preset-tabs">
          {PRESETS.map(p => (
            <button
              key={p.value}
              className={`preset-tab ${preset === p.value ? 'active' : ''}`}
              onClick={() => setPreset(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {preset === 'custom' && (
          <div className="custom-dates">
            <input
              type="date"
              value={customStart}
              max={customEnd || new Date().toISOString().split('T')[0]}
              onChange={e => setCustomStart(e.target.value)}
              className="date-input"
            />
            <span>to</span>
            <input
              type="date"
              value={customEnd}
              min={customStart}
              max={new Date().toISOString().split('T')[0]}
              onChange={e => setCustomEnd(e.target.value)}
              className="date-input"
            />
          </div>
        )}

        <button
          className="btn-primary"
          onClick={generateReport}
          disabled={loading || (preset === 'custom' && (!customStart || !customEnd))}
        >
          {loading ? '⏳ Generating...' : '📊 Generate Report'}
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {report && (
        <>
          {/* Summary Cards */}
          <div className="report-summary">
            {[
              { label: 'Gross Revenue', value: fmt(report.summary.grossRevenue), sub: 'Before refunds', icon: '💰' },
              { label: 'Net Revenue', value: fmt(report.summary.netRevenue), sub: 'After refunds', icon: '📈' },
              { label: 'Total Orders', value: fmtInt(report.summary.totalOrders), sub: `${report.summary.completedOrders} completed`, icon: '📦' },
              { label: 'Avg Order Value', value: fmt(report.summary.averageOrderValue), sub: 'Per completed order', icon: '🧾' },
              { label: 'Items Sold', value: fmtInt(report.summary.itemsSold), sub: 'Total units', icon: '🛍' },
              { label: 'Tax Collected', value: fmt(report.summary.taxCollected), sub: 'IVA 16%', icon: '🏛' },
              { label: 'Discounts Given', value: fmt(report.summary.discountsGiven), sub: 'Coupons & promotions', icon: '🏷' },
              { label: 'Refunds Issued', value: fmt(report.summary.refundsIssued), sub: `${report.summary.cancelledOrders} cancelled`, icon: '↩️' },
            ].map(item => (
              <div key={item.label} className="summary-card">
                <div className="summary-icon">{item.icon}</div>
                <div className="summary-value">{item.value}</div>
                <div className="summary-label">{item.label}</div>
                <div className="summary-sub">{item.sub}</div>
              </div>
            ))}
          </div>

          {/* Revenue Area Chart */}
          {report.dailyBreakdown.length > 1 && (
            <div className="chart-card">
              <div className="chart-header">
                <h2>Revenue Trend</h2>
              </div>
              <div className="chart-body">
                <ResponsiveContainer width="100%" height={240}>
                  <AreaChart data={report.dailyBreakdown} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="revenueGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 11, fill: '#94a3b8' }}
                      tickFormatter={(d) => new Date(d).toLocaleDateString('es-MX', { month: 'short', day: 'numeric' })}
                    />
                    <YAxis
                      tickFormatter={(v) => `$${v}`}
                      tick={{ fontSize: 11, fill: '#94a3b8' }}
                      width={70}
                    />
                    <Tooltip
                      formatter={(v: number, name: string) => [`$${v.toFixed(2)}`, name]}
                      labelFormatter={(d) => new Date(d).toLocaleDateString('es-MX', { weekday: 'long', month: 'long', day: 'numeric' })}
                      contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                    />
                    <Area
                      type="monotone"
                      dataKey="revenue"
                      name="Revenue"
                      stroke="#6366f1"
                      strokeWidth={2}
                      fill="url(#revenueGradient)"
                    />
                    <Area
                      type="monotone"
                      dataKey="refunds"
                      name="Refunds"
                      stroke="#ef4444"
                      strokeWidth={1.5}
                      fill="none"
                      strokeDasharray="4 2"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Data Tabs */}
          <div className="report-tabs">
            {(['overview', 'products', 'employees', 'categories'] as const).map(tab => (
              <button
                key={tab}
                className={`report-tab ${activeTab === tab ? 'active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

          {activeTab === 'overview' && (
            <div className="data-card">
              <div className="data-card-header"><h2>Daily Breakdown</h2></div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th className="right">Orders</th>
                      <th className="right">Revenue</th>
                      <th className="right">Avg Order</th>
                      <th className="right">Refunds</th>
                      <th className="right">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.dailyBreakdown.map(day => (
                      <tr key={day.date}>
                        <td>{new Date(day.date).toLocaleDateString('es-MX', { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                        <td className="right">{fmtInt(day.orders)}</td>
                        <td className="right">{fmt(day.revenue)}</td>
                        <td className="right">{fmt(day.averageOrderValue)}</td>
                        <td className="right refund">{day.refunds > 0 ? fmt(day.refunds) : '—'}</td>
                        <td className="right">{fmt(day.revenue - day.refunds)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="total-row">
                      <td><strong>Total</strong></td>
                      <td className="right"><strong>{fmtInt(report.summary.totalOrders)}</strong></td>
                      <td className="right"><strong>{fmt(report.summary.grossRevenue)}</strong></td>
                      <td className="right"><strong>{fmt(report.summary.averageOrderValue)}</strong></td>
                      <td className="right refund"><strong>{fmt(report.summary.refundsIssued)}</strong></td>
                      <td className="right"><strong>{fmt(report.summary.netRevenue)}</strong></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'products' && (
            <div className="data-card">
              <div className="data-card-header"><h2>Product Performance</h2></div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Category</th>
                      <th className="right">Units Sold</th>
                      <th className="right">Revenue</th>
                      <th className="right">Refunds</th>
                      <th className="right">Net Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.productBreakdown.map(p => (
                      <tr key={p.productId}>
                        <td>{p.productName}</td>
                        <td className="muted">{p.categoryName ?? '—'}</td>
                        <td className="right">{fmtInt(p.quantitySold)}</td>
                        <td className="right">{fmt(p.revenue)}</td>
                        <td className="right refund">{p.refunds > 0 ? fmt(p.refunds) : '—'}</td>
                        <td className="right">{fmt(p.netRevenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'employees' && (
            <div className="data-card">
              <div className="data-card-header"><h2>Employee Performance</h2></div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th className="right">Orders</th>
                      <th className="right">Revenue</th>
                      <th className="right">Avg Order</th>
                      <th className="right">Refunds</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.employeeBreakdown.map(e => (
                      <tr key={e.employeeId}>
                        <td>{e.employeeName}</td>
                        <td className="right">{fmtInt(e.ordersProcessed)}</td>
                        <td className="right">{fmt(e.revenue)}</td>
                        <td className="right">{fmt(e.averageOrderValue)}</td>
                        <td className="right">{e.refundsProcessed > 0 ? e.refundsProcessed : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'categories' && (
            <div className="data-card">
              <div className="data-card-header"><h2>Category Breakdown</h2></div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th className="right">Items Sold</th>
                      <th className="right">Revenue</th>
                      <th className="right">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.categoryBreakdown.map(c => (
                      <tr key={c.categoryId}>
                        <td>{c.categoryName}</td>
                        <td className="right">{fmtInt(c.itemsSold)}</td>
                        <td className="right">{fmt(c.revenue)}</td>
                        <td className="right">
                          <div className="pct-bar">
                            <div className="pct-fill" style={{ width: `${c.percentage}%` }} />
                            <span>{c.percentage}%</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {!report && !loading && (
        <div className="report-prompt">
          <div className="report-prompt-icon">📊</div>
          <h2>Select a period and generate your report</h2>
          <p>Choose a date range above, then click "Generate Report" to see detailed sales analytics.</p>
        </div>
      )}
    </div>
  );
}
