// services/api/src/controllers/analytics.controller.ts

import type { Request, Response, NextFunction } from 'express';
import { analyticsService } from '../services/analytics.service';
import { AppError } from '../lib/errors';
import { createObjectCsvStringifier } from 'csv-writer';

export const analyticsController = {
  getDashboard: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.auth.storeId;
      const date = req.query.date ? new Date(req.query.date as string) : new Date();
      const metrics = await analyticsService.getDashboard(storeId, date);
      res.json({ success: true, data: metrics });
    } catch (err) { next(err); }
  },

  getSalesReport: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.auth.storeId;
      const { startDate, endDate } = req.query as { startDate: string; endDate: string };
      if (!startDate || !endDate) throw new AppError('VALIDATION_ERROR', 'startDate and endDate required', 400);

      const report = await analyticsService.generateSalesReport(
        storeId,
        new Date(startDate),
        new Date(endDate)
      );
      res.json({ success: true, data: report });
    } catch (err) { next(err); }
  },

  getTopProducts: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.auth.storeId;
      const { startDate, endDate, limit = '10' } = req.query as Record<string, string>;
      const metrics = await analyticsService.getDashboard(storeId, new Date(endDate ?? Date.now()));
      res.json({ success: true, data: metrics.topProducts.slice(0, parseInt(limit)) });
    } catch (err) { next(err); }
  },

  getRevenueChart: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.auth.storeId;
      const metrics = await analyticsService.getDashboard(storeId);
      res.json({ success: true, data: metrics.hourlyRevenue });
    } catch (err) { next(err); }
  },

  exportReport: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.auth.storeId;
      const { startDate, endDate, format = 'csv' } = req.query as Record<string, string>;
      if (!startDate || !endDate) throw new AppError('VALIDATION_ERROR', 'startDate and endDate required', 400);

      const report = await analyticsService.generateSalesReport(storeId, new Date(startDate), new Date(endDate));

      if (format === 'csv') {
        const csvStringifier = createObjectCsvStringifier({
          header: [
            { id: 'date', title: 'Date' },
            { id: 'revenue', title: 'Revenue' },
            { id: 'orders', title: 'Orders' },
            { id: 'averageOrderValue', title: 'AOV' },
            { id: 'refunds', title: 'Refunds' },
          ],
        });

        const csvContent = csvStringifier.getHeaderString() +
          csvStringifier.stringifyRecords(report.dailyBreakdown);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="sales-report-${startDate}-${endDate}.csv"`);
        res.send(csvContent);
      } else {
        res.json({ success: true, data: report });
      }
    } catch (err) { next(err); }
  },
};
