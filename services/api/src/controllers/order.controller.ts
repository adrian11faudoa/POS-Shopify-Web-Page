// services/api/src/controllers/order.controller.ts
// HTTP handlers for order operations - thin layer over order service

import type { Request, Response, NextFunction } from 'express';
import { orderService } from '../services/order.service';
import { printService } from '../services/print.service';
import { createLogger } from '../lib/logger';
import { AppError } from '../lib/errors';
import type { PaginationMeta } from '@snackpos/types';

const logger = createLogger('order.controller');

export const orderController = {
  list: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.query.storeId as string ?? req.auth?.storeId;
      if (!storeId) throw new AppError('VALIDATION_ERROR', 'storeId required', 400);

      const { orders, total } = await orderService.listOrders(storeId, {
        page: Number(req.query.page ?? 1),
        perPage: Math.min(Number(req.query.perPage ?? 20), 100),
        status: req.query.status as string,
        type: req.query.type as string,
        search: req.query.search as string,
        startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
        endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
        sortBy: req.query.sortBy as string ?? 'created_at',
        sortOrder: (req.query.sortOrder as 'asc' | 'desc') ?? 'desc',
      });

      const page = Number(req.query.page ?? 1);
      const perPage = Number(req.query.perPage ?? 20);
      const meta: PaginationMeta = {
        page,
        perPage,
        total,
        totalPages: Math.ceil(total / perPage),
      };

      res.json({ success: true, data: orders, meta });
    } catch (err) {
      next(err);
    }
  },

  create: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.body.storeId ?? req.auth?.storeId;
      const employeeId = req.auth?.sub;

      const order = await orderService.createOrder(
        { ...req.body, storeId },
        employeeId
      );

      res.status(201).json({ success: true, data: order });
    } catch (err) {
      next(err);
    }
  },

  get: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await orderService.getOrderById(
        require('../lib/database').db,
        req.params.id
      );

      // Verify tenant isolation
      if (order.storeId !== req.auth?.storeId) {
        throw new AppError('FORBIDDEN', 'Access denied', 403);
      }

      res.json({ success: true, data: order });
    } catch (err) {
      next(err);
    }
  },

  updateStatus: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await orderService.updateOrderStatus(
        req.params.id,
        req.body,
        req.auth.sub
      );
      res.json({ success: true, data: order });
    } catch (err) {
      next(err);
    }
  },

  refund: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await orderService.refundOrder(
        req.params.id,
        req.body,
        req.auth.sub
      );
      res.json({ success: true, data: order });
    } catch (err) {
      next(err);
    }
  },

  print: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = require('../lib/database');
      const order = await orderService.getOrderById(db, req.params.id);
      await printService.printReceipt(order);
      res.json({ success: true, data: { printed: true } });
    } catch (err) {
      next(err);
    }
  },

  getReceipt: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = require('../lib/database');
      const order = await orderService.getOrderById(db, req.params.id);
      const html = await printService.generateReceiptHtml(order);
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      next(err);
    }
  },
};
