// services/api/src/services/analytics.service.ts
// Production analytics with period comparisons, cohorts, and trend analysis

import { db } from '../lib/database';
import { redis } from '../lib/redis';
import { createLogger } from '../lib/logger';

const logger = createLogger('analytics.service');

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface DashboardMetrics {
  revenue: PeriodMetric;
  orders: PeriodMetric;
  averageOrderValue: PeriodMetric;
  newCustomers: PeriodMetric;
  topProducts: TopProduct[];
  hourlyRevenue: HourlyData[];
  ordersByStatus: StatusBreakdown[];
  ordersByType: TypeBreakdown[];
  revenueByPaymentMethod: PaymentBreakdown[];
  inventoryAlerts: InventoryAlert[];
}

interface PeriodMetric {
  current: number;
  previous: number;
  change: number;      // percentage change
  trend: 'up' | 'down' | 'flat';
}

interface TopProduct {
  productId: string;
  name: string;
  imageUrl: string | null;
  quantitySold: number;
  revenue: number;
  rank: number;
}

interface HourlyData {
  hour: number;
  revenue: number;
  orders: number;
}

interface StatusBreakdown {
  status: string;
  count: number;
  percentage: number;
}

interface TypeBreakdown {
  type: string;
  count: number;
  revenue: number;
}

interface PaymentBreakdown {
  method: string;
  amount: number;
  percentage: number;
}

interface InventoryAlert {
  variantId: string;
  productName: string;
  variantName: string;
  quantity: number;
  threshold: number;
  alertType: string;
}

export interface SalesReport {
  storeId: string;
  period: { start: Date; end: Date };
  summary: {
    grossRevenue: number;
    netRevenue: number;
    taxCollected: number;
    discountsGiven: number;
    refundsIssued: number;
    totalOrders: number;
    completedOrders: number;
    cancelledOrders: number;
    averageOrderValue: number;
    itemsSold: number;
  };
  dailyBreakdown: DailyBreakdown[];
  productBreakdown: ProductBreakdown[];
  employeeBreakdown: EmployeeBreakdown[];
  categoryBreakdown: CategoryBreakdown[];
}

interface DailyBreakdown {
  date: string;
  revenue: number;
  orders: number;
  averageOrderValue: number;
  refunds: number;
}

interface ProductBreakdown {
  productId: string;
  productName: string;
  categoryName: string | null;
  quantitySold: number;
  revenue: number;
  refunds: number;
  netRevenue: number;
}

interface EmployeeBreakdown {
  employeeId: string;
  employeeName: string;
  ordersProcessed: number;
  revenue: number;
  averageOrderValue: number;
  refundsProcessed: number;
}

interface CategoryBreakdown {
  categoryId: string;
  categoryName: string;
  revenue: number;
  itemsSold: number;
  percentage: number;
}

// ─── Analytics Service ────────────────────────────────────────────────────────

export class AnalyticsService {
  private readonly CACHE_TTL = 5 * 60; // 5 minutes

  async getDashboard(storeId: string, date: Date = new Date()): Promise<DashboardMetrics> {
    const cacheKey = `dashboard:${storeId}:${date.toISOString().split('T')[0]}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const prevStart = new Date(startOfDay);
    prevStart.setDate(prevStart.getDate() - 1);
    const prevEnd = new Date(endOfDay);
    prevEnd.setDate(prevEnd.getDate() - 1);

    const [
      todayRevenue, yesterdayRevenue,
      todayOrders, yesterdayOrders,
      todayNewCustomers, yesterdayNewCustomers,
      topProducts, hourlyRevenue,
      ordersByStatus, ordersByType,
      revenueByPayment, inventoryAlerts,
    ] = await Promise.all([
      this.getRevenue(storeId, startOfDay, endOfDay),
      this.getRevenue(storeId, prevStart, prevEnd),
      this.getOrderCount(storeId, startOfDay, endOfDay),
      this.getOrderCount(storeId, prevStart, prevEnd),
      this.getNewCustomerCount(storeId, startOfDay, endOfDay),
      this.getNewCustomerCount(storeId, prevStart, prevEnd),
      this.getTopProducts(storeId, startOfDay, endOfDay, 10),
      this.getHourlyRevenue(storeId, startOfDay, endOfDay),
      this.getOrdersByStatus(storeId, startOfDay, endOfDay),
      this.getOrdersByType(storeId, startOfDay, endOfDay),
      this.getRevenueByPaymentMethod(storeId, startOfDay, endOfDay),
      this.getInventoryAlerts(storeId),
    ]);

    const metrics: DashboardMetrics = {
      revenue: this.buildPeriodMetric(todayRevenue, yesterdayRevenue),
      orders: this.buildPeriodMetric(todayOrders, yesterdayOrders),
      averageOrderValue: this.buildPeriodMetric(
        todayOrders > 0 ? todayRevenue / todayOrders : 0,
        yesterdayOrders > 0 ? yesterdayRevenue / yesterdayOrders : 0
      ),
      newCustomers: this.buildPeriodMetric(todayNewCustomers, yesterdayNewCustomers),
      topProducts,
      hourlyRevenue,
      ordersByStatus,
      ordersByType,
      revenueByPaymentMethod: revenueByPayment,
      inventoryAlerts,
    };

    // Cache for 5 minutes (don't cache for today's data too long)
    const ttl = date.toDateString() === new Date().toDateString() ? 60 : this.CACHE_TTL;
    await redis.setex(cacheKey, ttl, JSON.stringify(metrics));

    return metrics;
  }

  async generateSalesReport(
    storeId: string,
    startDate: Date,
    endDate: Date
  ): Promise<SalesReport> {
    const cacheKey = `report:${storeId}:${startDate.toISOString()}:${endDate.toISOString()}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    logger.info({ storeId, startDate, endDate }, 'Generating sales report');

    const [summary, dailyBreakdown, productBreakdown, employeeBreakdown, categoryBreakdown] =
      await Promise.all([
        this.getSummary(storeId, startDate, endDate),
        this.getDailyBreakdown(storeId, startDate, endDate),
        this.getProductBreakdown(storeId, startDate, endDate),
        this.getEmployeeBreakdown(storeId, startDate, endDate),
        this.getCategoryBreakdown(storeId, startDate, endDate),
      ]);

    const report: SalesReport = {
      storeId,
      period: { start: startDate, end: endDate },
      summary,
      dailyBreakdown,
      productBreakdown,
      employeeBreakdown,
      categoryBreakdown,
    };

    await redis.setex(cacheKey, this.CACHE_TTL, JSON.stringify(report));
    return report;
  }

  private async getSummary(storeId: string, start: Date, end: Date) {
    const [orderStats] = await db('orders')
      .where({ store_id: storeId })
      .whereBetween('created_at', [start, end])
      .select(
        db.raw('COUNT(*) as total_orders'),
        db.raw("COUNT(*) FILTER (WHERE status NOT IN ('CANCELLED','REFUNDED')) as completed_orders"),
        db.raw("COUNT(*) FILTER (WHERE status = 'CANCELLED') as cancelled_orders"),
        db.raw("COALESCE(SUM(total) FILTER (WHERE status NOT IN ('CANCELLED','REFUNDED')), 0) as gross_revenue"),
        db.raw("COALESCE(SUM(tax_amount) FILTER (WHERE status NOT IN ('CANCELLED','REFUNDED')), 0) as tax_collected"),
        db.raw("COALESCE(SUM(discount_amount) FILTER (WHERE status NOT IN ('CANCELLED','REFUNDED')), 0) as discounts_given"),
      );

    const [refundStats] = await db('refunds')
      .join('orders', 'refunds.order_id', 'orders.id')
      .where('orders.store_id', storeId)
      .whereBetween('refunds.created_at', [start, end])
      .select(db.raw('COALESCE(SUM(refunds.amount), 0) as total_refunds'));

    const [itemStats] = await db('order_items')
      .join('orders', 'order_items.order_id', 'orders.id')
      .where('orders.store_id', storeId)
      .whereBetween('orders.created_at', [start, end])
      .whereNotIn('orders.status', ['CANCELLED', 'REFUNDED'])
      .select(db.raw('COALESCE(SUM(order_items.quantity), 0) as items_sold'));

    const grossRevenue = parseFloat(orderStats.gross_revenue);
    const refunds = parseFloat(refundStats.total_refunds);
    const totalOrders = parseInt(orderStats.total_orders, 10);
    const completedOrders = parseInt(orderStats.completed_orders, 10);

    return {
      grossRevenue,
      netRevenue: grossRevenue - refunds,
      taxCollected: parseFloat(orderStats.tax_collected),
      discountsGiven: parseFloat(orderStats.discounts_given),
      refundsIssued: refunds,
      totalOrders,
      completedOrders,
      cancelledOrders: parseInt(orderStats.cancelled_orders, 10),
      averageOrderValue: completedOrders > 0 ? grossRevenue / completedOrders : 0,
      itemsSold: parseInt(itemStats.items_sold, 10),
    };
  }

  private async getDailyBreakdown(storeId: string, start: Date, end: Date): Promise<DailyBreakdown[]> {
    const rows = await db('orders')
      .where({ store_id: storeId })
      .whereBetween('created_at', [start, end])
      .whereNotIn('status', ['CANCELLED', 'REFUNDED'])
      .select(
        db.raw("DATE(created_at AT TIME ZONE 'UTC') as date"),
        db.raw('COALESCE(SUM(total), 0) as revenue'),
        db.raw('COUNT(*) as orders'),
        db.raw('COALESCE(AVG(total), 0) as avg_order'),
      )
      .groupByRaw("DATE(created_at AT TIME ZONE 'UTC')")
      .orderByRaw("DATE(created_at AT TIME ZONE 'UTC')");

    const refundRows = await db('refunds')
      .join('orders', 'refunds.order_id', 'orders.id')
      .where('orders.store_id', storeId)
      .whereBetween('refunds.created_at', [start, end])
      .select(
        db.raw("DATE(refunds.created_at AT TIME ZONE 'UTC') as date"),
        db.raw('COALESCE(SUM(refunds.amount), 0) as refunds'),
      )
      .groupByRaw("DATE(refunds.created_at AT TIME ZONE 'UTC')");

    const refundMap = Object.fromEntries(
      refundRows.map((r: { date: string; refunds: string }) => [r.date, parseFloat(r.refunds)])
    );

    return rows.map((row: { date: string; revenue: string; orders: string; avg_order: string }) => ({
      date: row.date,
      revenue: parseFloat(row.revenue),
      orders: parseInt(row.orders, 10),
      averageOrderValue: parseFloat(row.avg_order),
      refunds: refundMap[row.date] ?? 0,
    }));
  }

  private async getProductBreakdown(storeId: string, start: Date, end: Date): Promise<ProductBreakdown[]> {
    const rows = await db('order_items')
      .join('orders', 'order_items.order_id', 'orders.id')
      .leftJoin('products', 'order_items.product_id', 'products.id')
      .leftJoin('categories', 'products.category_id', 'categories.id')
      .where('orders.store_id', storeId)
      .whereBetween('orders.created_at', [start, end])
      .whereNotIn('orders.status', ['CANCELLED', 'REFUNDED'])
      .whereNot('order_items.status', 'CANCELLED')
      .select(
        'order_items.product_id',
        db.raw('MAX(order_items.name) as product_name'),
        db.raw('MAX(categories.name) as category_name'),
        db.raw('SUM(order_items.quantity) as quantity_sold'),
        db.raw('SUM(order_items.total) as revenue'),
      )
      .groupBy('order_items.product_id')
      .orderBy('revenue', 'desc');

    // Get refunds by product
    const refundRows = await db('order_items')
      .join('orders', 'order_items.order_id', 'orders.id')
      .join('refunds', 'orders.id', 'refunds.order_id')
      .where('orders.store_id', storeId)
      .whereBetween('refunds.created_at', [start, end])
      .select(
        'order_items.product_id',
        db.raw('COALESCE(SUM(refunds.amount / (SELECT COUNT(*) FROM order_items oi2 WHERE oi2.order_id = orders.id)), 0) as refunds'),
      )
      .groupBy('order_items.product_id');

    const refundMap = Object.fromEntries(
      refundRows.map((r: { product_id: string; refunds: string }) => [r.product_id, parseFloat(r.refunds)])
    );

    return rows.map((row: {
      product_id: string;
      product_name: string;
      category_name: string | null;
      quantity_sold: string;
      revenue: string;
    }) => {
      const revenue = parseFloat(row.revenue);
      const refunds = refundMap[row.product_id] ?? 0;
      return {
        productId: row.product_id,
        productName: row.product_name,
        categoryName: row.category_name,
        quantitySold: parseInt(row.quantity_sold, 10),
        revenue,
        refunds,
        netRevenue: revenue - refunds,
      };
    });
  }

  private async getEmployeeBreakdown(storeId: string, start: Date, end: Date): Promise<EmployeeBreakdown[]> {
    const rows = await db('orders')
      .join('employees', 'orders.assigned_employee_id', 'employees.id')
      .where('orders.store_id', storeId)
      .whereBetween('orders.created_at', [start, end])
      .whereNotIn('orders.status', ['CANCELLED', 'REFUNDED'])
      .whereNotNull('orders.assigned_employee_id')
      .select(
        'employees.id as employee_id',
        db.raw("employees.first_name || ' ' || employees.last_name as employee_name"),
        db.raw('COUNT(*) as orders_processed'),
        db.raw('COALESCE(SUM(orders.total), 0) as revenue'),
        db.raw('COALESCE(AVG(orders.total), 0) as avg_order'),
      )
      .groupBy('employees.id', 'employees.first_name', 'employees.last_name')
      .orderBy('revenue', 'desc');

    const refundRows = await db('refunds')
      .join('orders', 'refunds.order_id', 'orders.id')
      .where('orders.store_id', storeId)
      .whereBetween('refunds.created_at', [start, end])
      .select(
        'refunds.processed_by as employee_id',
        db.raw('COUNT(*) as refunds_processed'),
      )
      .groupBy('refunds.processed_by');

    const refundMap = Object.fromEntries(
      refundRows.map((r: { employee_id: string; refunds_processed: string }) => [
        r.employee_id,
        parseInt(r.refunds_processed, 10),
      ])
    );

    return rows.map((row: {
      employee_id: string;
      employee_name: string;
      orders_processed: string;
      revenue: string;
      avg_order: string;
    }) => ({
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      ordersProcessed: parseInt(row.orders_processed, 10),
      revenue: parseFloat(row.revenue),
      averageOrderValue: parseFloat(row.avg_order),
      refundsProcessed: refundMap[row.employee_id] ?? 0,
    }));
  }

  private async getCategoryBreakdown(storeId: string, start: Date, end: Date): Promise<CategoryBreakdown[]> {
    const rows = await db('order_items')
      .join('orders', 'order_items.order_id', 'orders.id')
      .join('products', 'order_items.product_id', 'products.id')
      .join('categories', 'products.category_id', 'categories.id')
      .where('orders.store_id', storeId)
      .whereBetween('orders.created_at', [start, end])
      .whereNotIn('orders.status', ['CANCELLED', 'REFUNDED'])
      .select(
        'categories.id as category_id',
        'categories.name as category_name',
        db.raw('COALESCE(SUM(order_items.total), 0) as revenue'),
        db.raw('SUM(order_items.quantity) as items_sold'),
      )
      .groupBy('categories.id', 'categories.name')
      .orderBy('revenue', 'desc');

    const totalRevenue = rows.reduce(
      (sum: number, r: { revenue: string }) => sum + parseFloat(r.revenue), 0
    );

    return rows.map((row: {
      category_id: string;
      category_name: string;
      revenue: string;
      items_sold: string;
    }) => {
      const revenue = parseFloat(row.revenue);
      return {
        categoryId: row.category_id,
        categoryName: row.category_name,
        revenue,
        itemsSold: parseInt(row.items_sold, 10),
        percentage: totalRevenue > 0 ? Math.round((revenue / totalRevenue) * 100 * 10) / 10 : 0,
      };
    });
  }

  private async getRevenue(storeId: string, start: Date, end: Date): Promise<number> {
    const [{ total }] = await db('orders')
      .where({ store_id: storeId })
      .whereBetween('created_at', [start, end])
      .whereNotIn('status', ['CANCELLED', 'REFUNDED'])
      .select(db.raw('COALESCE(SUM(total), 0) as total'));
    return parseFloat(total);
  }

  private async getOrderCount(storeId: string, start: Date, end: Date): Promise<number> {
    const [{ count }] = await db('orders')
      .where({ store_id: storeId })
      .whereBetween('created_at', [start, end])
      .whereNotIn('status', ['CANCELLED', 'REFUNDED'])
      .count('* as count');
    return parseInt(count as string, 10);
  }

  private async getNewCustomerCount(storeId: string, start: Date, end: Date): Promise<number> {
    const [{ count }] = await db('customers')
      .where({ store_id: storeId })
      .whereBetween('created_at', [start, end])
      .count('* as count');
    return parseInt(count as string, 10);
  }

  private async getTopProducts(storeId: string, start: Date, end: Date, limit: number): Promise<TopProduct[]> {
    const rows = await db('order_items')
      .join('orders', 'order_items.order_id', 'orders.id')
      .leftJoin('products', 'order_items.product_id', 'products.id')
      .where('orders.store_id', storeId)
      .whereBetween('orders.created_at', [start, end])
      .whereNotIn('orders.status', ['CANCELLED', 'REFUNDED'])
      .select(
        'order_items.product_id',
        db.raw('MAX(order_items.name) as name'),
        db.raw('MAX(products.image_urls->>0) as image_url'),
        db.raw('SUM(order_items.quantity) as quantity_sold'),
        db.raw('SUM(order_items.total) as revenue'),
      )
      .groupBy('order_items.product_id')
      .orderBy('revenue', 'desc')
      .limit(limit);

    return rows.map((row: {
      product_id: string;
      name: string;
      image_url: string | null;
      quantity_sold: string;
      revenue: string;
    }, i: number) => ({
      productId: row.product_id,
      name: row.name,
      imageUrl: row.image_url,
      quantitySold: parseInt(row.quantity_sold, 10),
      revenue: parseFloat(row.revenue),
      rank: i + 1,
    }));
  }

  private async getHourlyRevenue(storeId: string, start: Date, end: Date): Promise<HourlyData[]> {
    const rows = await db('orders')
      .where({ store_id: storeId })
      .whereBetween('created_at', [start, end])
      .whereNotIn('status', ['CANCELLED', 'REFUNDED'])
      .select(
        db.raw("EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int as hour"),
        db.raw('COALESCE(SUM(total), 0) as revenue'),
        db.raw('COUNT(*) as orders'),
      )
      .groupByRaw("EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')")
      .orderByRaw("EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')");

    const hourMap = Object.fromEntries(
      rows.map((r: { hour: number; revenue: string; orders: string }) => [
        r.hour,
        { revenue: parseFloat(r.revenue), orders: parseInt(r.orders, 10) },
      ])
    );

    return Array.from({ length: 24 }, (_, hour) => ({
      hour,
      revenue: hourMap[hour]?.revenue ?? 0,
      orders: hourMap[hour]?.orders ?? 0,
    }));
  }

  private async getOrdersByStatus(storeId: string, start: Date, end: Date): Promise<StatusBreakdown[]> {
    const rows = await db('orders')
      .where({ store_id: storeId })
      .whereBetween('created_at', [start, end])
      .select('status', db.raw('COUNT(*) as count'))
      .groupBy('status');

    const total = rows.reduce((sum: number, r: { count: string }) => sum + parseInt(r.count, 10), 0);
    return rows.map((row: { status: string; count: string }) => ({
      status: row.status,
      count: parseInt(row.count, 10),
      percentage: total > 0 ? Math.round((parseInt(row.count, 10) / total) * 100 * 10) / 10 : 0,
    }));
  }

  private async getOrdersByType(storeId: string, start: Date, end: Date): Promise<TypeBreakdown[]> {
    const rows = await db('orders')
      .where({ store_id: storeId })
      .whereBetween('created_at', [start, end])
      .whereNotIn('status', ['CANCELLED', 'REFUNDED'])
      .select('type', db.raw('COUNT(*) as count'), db.raw('COALESCE(SUM(total), 0) as revenue'))
      .groupBy('type');

    return rows.map((row: { type: string; count: string; revenue: string }) => ({
      type: row.type,
      count: parseInt(row.count, 10),
      revenue: parseFloat(row.revenue),
    }));
  }

  private async getRevenueByPaymentMethod(storeId: string, start: Date, end: Date): Promise<PaymentBreakdown[]> {
    const rows = await db('payments')
      .join('orders', 'payments.order_id', 'orders.id')
      .where('orders.store_id', storeId)
      .whereBetween('payments.created_at', [start, end])
      .where('payments.status', 'CAPTURED')
      .select(
        'payments.method',
        db.raw('COALESCE(SUM(payments.amount), 0) as amount'),
      )
      .groupBy('payments.method');

    const total = rows.reduce((sum: number, r: { amount: string }) => sum + parseFloat(r.amount), 0);
    return rows.map((row: { method: string; amount: string }) => ({
      method: row.method,
      amount: parseFloat(row.amount),
      percentage: total > 0 ? Math.round((parseFloat(row.amount) / total) * 100 * 10) / 10 : 0,
    }));
  }

  private async getInventoryAlerts(storeId: string): Promise<InventoryAlert[]> {
    const rows = await db('inventory_items')
      .join('product_variants', 'inventory_items.variant_id', 'product_variants.id')
      .join('products', 'product_variants.product_id', 'products.id')
      .where('inventory_items.store_id', storeId)
      .where(builder => {
        builder
          .whereRaw('inventory_items.quantity <= inventory_items.low_stock_threshold')
          .orWhere('inventory_items.quantity', '<=', 0);
      })
      .select(
        'product_variants.id as variant_id',
        'products.name as product_name',
        'product_variants.name as variant_name',
        'inventory_items.quantity',
        'inventory_items.low_stock_threshold as threshold',
        db.raw("CASE WHEN inventory_items.quantity <= 0 THEN 'OUT_OF_STOCK' ELSE 'LOW_STOCK' END as alert_type"),
      )
      .orderBy('inventory_items.quantity', 'asc')
      .limit(20);

    return rows.map((row: {
      variant_id: string;
      product_name: string;
      variant_name: string;
      quantity: number;
      threshold: number;
      alert_type: string;
    }) => ({
      variantId: row.variant_id,
      productName: row.product_name,
      variantName: row.variant_name,
      quantity: row.quantity,
      threshold: row.threshold,
      alertType: row.alert_type,
    }));
  }

  private buildPeriodMetric(current: number, previous: number): PeriodMetric {
    const change = previous > 0
      ? Math.round(((current - previous) / previous) * 100 * 10) / 10
      : current > 0 ? 100 : 0;

    return {
      current,
      previous,
      change,
      trend: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
    };
  }

  // ─── Cash Register Close Report ─────────────────────────────────────────────
  async generateCashCloseReport(
    storeId: string,
    posTerminalId: string,
    sessionId: string
  ): Promise<{
    session: Record<string, unknown>;
    orders: { count: number; total: number };
    cashSales: number;
    cardSales: number;
    expectedCash: number;
  }> {
    const session = await db('cash_register_sessions')
      .where({ id: sessionId, store_id: storeId })
      .first();

    if (!session) throw new Error('Session not found');

    const [orderStats] = await db('orders')
      .where({ store_id: storeId, pos_terminal_id: posTerminalId })
      .where('created_at', '>=', session.opened_at)
      .whereNotIn('status', ['CANCELLED', 'REFUNDED'])
      .select(
        db.raw('COUNT(*) as count'),
        db.raw('COALESCE(SUM(total), 0) as total'),
      );

    const paymentStats = await db('payments')
      .join('orders', 'payments.order_id', 'orders.id')
      .where('orders.store_id', storeId)
      .where('orders.pos_terminal_id', posTerminalId)
      .where('payments.created_at', '>=', session.opened_at)
      .where('payments.status', 'CAPTURED')
      .select(
        'payments.method',
        db.raw('COALESCE(SUM(payments.amount), 0) as amount'),
      )
      .groupBy('payments.method');

    const cashSales = parseFloat(
      paymentStats.find((p: { method: string }) => p.method === 'CASH')?.amount ?? '0'
    );
    const cardSales = parseFloat(
      paymentStats.filter((p: { method: string }) => p.method !== 'CASH')
        .reduce((sum: number, p: { amount: string }) => sum + parseFloat(p.amount), 0).toString()
    );

    return {
      session,
      orders: {
        count: parseInt(orderStats.count, 10),
        total: parseFloat(orderStats.total),
      },
      cashSales,
      cardSales,
      expectedCash: session.opening_float + cashSales,
    };
  }
}

export const analyticsService = new AnalyticsService();
