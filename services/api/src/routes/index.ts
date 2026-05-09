// services/api/src/routes/index.ts
// Centralized route registration with versioning

import type { Application } from 'express';
import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth';
import { loginHandler, pinLoginHandler, refreshTokenHandler, logoutHandler } from '../middleware/auth';
import { orderController } from '../controllers/order.controller';
import { productController } from '../controllers/product.controller';
import { inventoryController } from '../controllers/inventory.controller';
import { customerController } from '../controllers/customer.controller';
import { employeeController } from '../controllers/employee.controller';
import { analyticsController } from '../controllers/analytics.controller';
import { cashRegisterController } from '../controllers/cash-register.controller';
import { storeController } from '../controllers/store.controller';
import { couponController } from '../controllers/coupon.controller';
import { supplierController } from '../controllers/supplier.controller';
import { shopifyWebhookRouter } from '../webhooks/shopify.webhooks';
import { validateBody, validateQuery } from '../middleware/validate';
import {
  createOrderSchema, updateOrderStatusSchema, refundOrderSchema,
  listOrdersSchema,
} from '../schemas/order.schema';
import {
  createProductSchema, updateProductSchema, listProductsSchema,
} from '../schemas/product.schema';

export function registerRoutes(app: Application): void {
  const v1 = Router();

  // ─── Auth ──────────────────────────────────────────────────────────────────
  const authRouter = Router();
  authRouter.post('/login', loginHandler);
  authRouter.post('/pin-login', pinLoginHandler);
  authRouter.post('/refresh', refreshTokenHandler);
  authRouter.post('/logout', requireAuth, logoutHandler);
  authRouter.get('/me', requireAuth, (req, res) => res.json({ success: true, data: req.auth }));

  // ─── Orders ───────────────────────────────────────────────────────────────
  const ordersRouter = Router();
  ordersRouter.use(requireAuth);
  ordersRouter.get('/', requirePermission('orders:read'), validateQuery(listOrdersSchema), orderController.list);
  ordersRouter.post('/', requirePermission('orders:write'), validateBody(createOrderSchema), orderController.create);
  ordersRouter.get('/:id', requirePermission('orders:read'), orderController.get);
  ordersRouter.patch('/:id/status', requirePermission('orders:write'), validateBody(updateOrderStatusSchema), orderController.updateStatus);
  ordersRouter.post('/:id/refund', requirePermission('orders:refund'), validateBody(refundOrderSchema), orderController.refund);
  ordersRouter.post('/:id/print', requirePermission('orders:read'), orderController.print);
  ordersRouter.get('/:id/receipt', requirePermission('orders:read'), orderController.getReceipt);

  // ─── Products ─────────────────────────────────────────────────────────────
  const productsRouter = Router();
  productsRouter.get('/', validateQuery(listProductsSchema), productController.list); // Public for storefront
  productsRouter.get('/barcode/:barcode', productController.getByBarcode);
  productsRouter.get('/:id', productController.get);
  productsRouter.use(requireAuth); // Auth required below this point
  productsRouter.post('/', requirePermission('products:write'), validateBody(createProductSchema), productController.create);
  productsRouter.put('/:id', requirePermission('products:write'), validateBody(updateProductSchema), productController.update);
  productsRouter.delete('/:id', requirePermission('products:write'), productController.delete);
  productsRouter.post('/:id/sync-shopify', requirePermission('products:write'), productController.syncToShopify);

  // ─── Inventory ────────────────────────────────────────────────────────────
  const inventoryRouter = Router();
  inventoryRouter.use(requireAuth, requirePermission('inventory:read'));
  inventoryRouter.get('/', inventoryController.list);
  inventoryRouter.get('/alerts', inventoryController.getAlerts);
  inventoryRouter.get('/:variantId', inventoryController.get);
  inventoryRouter.patch('/:variantId/adjust', requirePermission('inventory:write'), inventoryController.adjust);
  inventoryRouter.post('/count', requirePermission('inventory:write'), inventoryController.count);
  inventoryRouter.get('/movements/:variantId', inventoryController.getMovements);

  // ─── Customers ───────────────────────────────────────────────────────────
  const customersRouter = Router();
  customersRouter.use(requireAuth, requirePermission('orders:read'));
  customersRouter.get('/', customerController.list);
  customersRouter.post('/', customerController.create);
  customersRouter.get('/:id', customerController.get);
  customersRouter.put('/:id', customerController.update);
  customersRouter.get('/:id/orders', customerController.getOrders);
  customersRouter.get('/:id/stats', customerController.getStats);

  // ─── Employees ───────────────────────────────────────────────────────────
  const employeesRouter = Router();
  employeesRouter.use(requireAuth, requirePermission('employees:read'));
  employeesRouter.get('/', employeeController.list);
  employeesRouter.post('/', requirePermission('employees:write'), employeeController.create);
  employeesRouter.get('/:id', employeeController.get);
  employeesRouter.put('/:id', requirePermission('employees:write'), employeeController.update);
  employeesRouter.delete('/:id', requirePermission('employees:write'), employeeController.delete);
  employeesRouter.patch('/:id/reset-pin', requirePermission('employees:write'), employeeController.resetPin);

  // ─── Analytics ───────────────────────────────────────────────────────────
  const analyticsRouter = Router();
  analyticsRouter.use(requireAuth, requirePermission('reports:read'));
  analyticsRouter.get('/dashboard', analyticsController.getDashboard);
  analyticsRouter.get('/sales-report', analyticsController.getSalesReport);
  analyticsRouter.get('/top-products', analyticsController.getTopProducts);
  analyticsRouter.get('/revenue-chart', analyticsController.getRevenueChart);
  analyticsRouter.get('/export', analyticsController.exportReport);

  // ─── Cash Register ───────────────────────────────────────────────────────
  const cashRouter = Router();
  cashRouter.use(requireAuth, requirePermission('cash_register:open'));
  cashRouter.get('/current', cashRegisterController.getCurrentSession);
  cashRouter.post('/open', cashRegisterController.openSession);
  cashRouter.post('/close', requirePermission('cash_register:close'), cashRegisterController.closeSession);
  cashRouter.get('/history', cashRegisterController.getHistory);
  cashRouter.get('/report/:sessionId', cashRegisterController.getSessionReport);

  // ─── Coupons ─────────────────────────────────────────────────────────────
  const couponsRouter = Router();
  couponsRouter.post('/validate', couponController.validate); // Public
  couponsRouter.use(requireAuth);
  couponsRouter.get('/', couponController.list);
  couponsRouter.post('/', requirePermission('settings:write'), couponController.create);
  couponsRouter.get('/:id', couponController.get);
  couponsRouter.put('/:id', requirePermission('settings:write'), couponController.update);
  couponsRouter.delete('/:id', requirePermission('settings:write'), couponController.delete);

  // ─── Suppliers ───────────────────────────────────────────────────────────
  const suppliersRouter = Router();
  suppliersRouter.use(requireAuth, requirePermission('suppliers:read'));
  suppliersRouter.get('/', supplierController.list);
  suppliersRouter.post('/', requirePermission('suppliers:write'), supplierController.create);
  suppliersRouter.get('/:id', supplierController.get);
  suppliersRouter.put('/:id', requirePermission('suppliers:write'), supplierController.update);
  suppliersRouter.delete('/:id', requirePermission('suppliers:write'), supplierController.delete);

  // ─── Store Settings ──────────────────────────────────────────────────────
  const storeRouter = Router();
  storeRouter.use(requireAuth);
  storeRouter.get('/:id', storeController.get);
  storeRouter.patch('/:id', requirePermission('settings:write'), storeController.update);
  storeRouter.get('/:id/audit-log', requirePermission('reports:read'), storeController.getAuditLog);
  storeRouter.post('/:id/shopify/connect', requirePermission('settings:write'), storeController.connectShopify);
  storeRouter.post('/:id/shopify/sync', requirePermission('settings:write'), storeController.triggerShopifySync);

  // ─── Register All Routers ─────────────────────────────────────────────────
  v1.use('/auth', authRouter);
  v1.use('/orders', ordersRouter);
  v1.use('/products', productsRouter);
  v1.use('/inventory', inventoryRouter);
  v1.use('/customers', customersRouter);
  v1.use('/employees', employeesRouter);
  v1.use('/analytics', analyticsRouter);
  v1.use('/cash-register', cashRouter);
  v1.use('/coupons', couponsRouter);
  v1.use('/suppliers', suppliersRouter);
  v1.use('/stores', storeRouter);

  app.use('/api/v1', v1);
  app.use('/api/webhooks', shopifyWebhookRouter);

  // Backwards-compatible alias
  app.use('/api', v1);
}
