// services/api/src/controllers/product.controller.ts

import type { Request, Response, NextFunction } from 'express';
import { productService } from '../services/product.service';
import { AppError } from '../lib/errors';

export const productController = {
  list: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = (req.query.storeId as string) ?? req.auth?.storeId;
      if (!storeId) throw new AppError('VALIDATION_ERROR', 'storeId required', 400);

      const { products, total } = await productService.list(storeId, {
        page: Number(req.query.page ?? 1),
        perPage: Number(req.query.perPage ?? 20),
        categoryId: req.query.categoryId as string,
        search: req.query.search as string,
        isActive: req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : true,
        isFeatured: req.query.isFeatured === 'true' ? true : undefined,
        tags: req.query.tags as string,
        sortBy: req.query.sortBy as string ?? 'name',
        sortOrder: (req.query.sortOrder as 'asc' | 'desc') ?? 'asc',
      });

      const page = Number(req.query.page ?? 1);
      const perPage = Number(req.query.perPage ?? 20);

      res.json({
        success: true,
        data: products,
        meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
      });
    } catch (err) { next(err); }
  },

  get: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = (req.query.storeId as string) ?? req.auth?.storeId;
      const product = await productService.getById(req.params.id, storeId);
      res.json({ success: true, data: product });
    } catch (err) { next(err); }
  },

  getByBarcode: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = (req.query.storeId as string) ?? req.auth?.storeId;
      if (!storeId) throw new AppError('VALIDATION_ERROR', 'storeId required', 400);
      const result = await productService.getByBarcode(req.params.barcode, storeId);
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },

  create: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const product = await productService.create(req.auth.storeId, req.body);
      res.status(201).json({ success: true, data: product });
    } catch (err) { next(err); }
  },

  update: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const product = await productService.update(req.params.id, req.auth.storeId, req.body);
      res.json({ success: true, data: product });
    } catch (err) { next(err); }
  },

  delete: async (req: Request, res: Response, next: NextFunction) => {
    try {
      await productService.delete(req.params.id, req.auth.storeId);
      res.json({ success: true, data: null });
    } catch (err) { next(err); }
  },

  syncToShopify: async (req: Request, res: Response, next: NextFunction) => {
    try {
      await productService.syncToShopify(req.params.id, req.auth.storeId);
      res.json({ success: true, data: { synced: true } });
    } catch (err) { next(err); }
  },
};

// services/api/src/controllers/inventory.controller.ts

import { inventoryService } from '../services/inventory.service';

export const inventoryController = {
  list: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.auth;
      const result = await inventoryService.listInventory(storeId, {
        page: Number(req.query.page ?? 1),
        perPage: Number(req.query.perPage ?? 50),
        search: req.query.search as string,
        alertsOnly: req.query.alertsOnly === 'true',
        lowStock: req.query.lowStock === 'true',
        categoryId: req.query.categoryId as string,
        supplierId: req.query.supplierId as string,
      });
      res.json({ success: true, data: result.items, meta: { total: result.total } });
    } catch (err) { next(err); }
  },

  get: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.auth;
      const inv = await require('../lib/database').db('inventory_items')
        .where({ store_id: storeId, variant_id: req.params.variantId })
        .first();
      if (!inv) throw new AppError('NOT_FOUND', 'Inventory item not found', 404);
      res.json({ success: true, data: inv });
    } catch (err) { next(err); }
  },

  getAlerts: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.auth;
      const metrics = await require('../services/analytics.service').analyticsService.getDashboard(storeId);
      res.json({ success: true, data: metrics.inventoryAlerts });
    } catch (err) { next(err); }
  },

  adjust: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, sub: employeeId } = req.auth;
      const { quantity, type, reason, notes, referenceId, referenceType } = req.body as {
        quantity: number;
        type: string;
        reason: string;
        notes?: string;
        referenceId?: string;
        referenceType?: string;
      };

      const result = await inventoryService.adjustStock({
        storeId,
        variantId: req.params.variantId,
        quantity,
        type: type as Parameters<typeof inventoryService.adjustStock>[0]['type'],
        reason,
        referenceId,
        referenceType,
        employeeId,
        notes,
      });

      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },

  count: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, sub: employeeId } = req.auth;
      const { counts } = req.body as {
        counts: Array<{ variantId: string; actualQuantity: number; notes?: string }>;
      };

      const result = await inventoryService.performStockCount({ storeId, counts, employeeId });
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },

  getMovements: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.auth;
      const result = await inventoryService.getMovements(storeId, req.params.variantId, {
        page: Number(req.query.page ?? 1),
        perPage: Number(req.query.perPage ?? 50),
        startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
        endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
      });
      res.json({ success: true, data: result.movements, meta: { total: result.total } });
    } catch (err) { next(err); }
  },
};
