// services/api/src/controllers/cash-register.controller.ts
// Cash register session management: open, close, reconcile

import type { Request, Response, NextFunction } from 'express';
import { db } from '../lib/database';
import { analyticsService } from '../services/analytics.service';
import { AppError } from '../lib/errors';
import { createLogger } from '../lib/logger';

const logger = createLogger('cash-register.controller');

export const cashRegisterController = {
  getCurrentSession: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, sub: employeeId } = req.auth;
      const posTerminalId = req.query.posTerminalId as string;

      const session = await db('cash_register_sessions')
        .where({ store_id: storeId })
        .where(builder => {
          if (posTerminalId) builder.where({ pos_terminal_id: posTerminalId });
          else builder.where({ employee_id: employeeId });
        })
        .whereNull('closed_at')
        .orderBy('opened_at', 'desc')
        .first();

      res.json({ success: true, data: session ?? null });
    } catch (err) { next(err); }
  },

  openSession: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, sub: employeeId } = req.auth;
      const { posTerminalId, openingFloat } = req.body as {
        posTerminalId: string;
        openingFloat: number;
      };

      if (!posTerminalId) throw new AppError('VALIDATION_ERROR', 'posTerminalId required', 400);
      if (openingFloat === undefined || openingFloat < 0) {
        throw new AppError('VALIDATION_ERROR', 'Opening float must be >= 0', 400);
      }

      // Check for existing open session
      const existing = await db('cash_register_sessions')
        .where({ store_id: storeId, pos_terminal_id: posTerminalId })
        .whereNull('closed_at')
        .first();

      if (existing) {
        throw new AppError('SESSION_ALREADY_OPEN', 'A cash register session is already open for this terminal', 409);
      }

      const [session] = await db('cash_register_sessions').insert({
        store_id: storeId,
        pos_terminal_id: posTerminalId,
        employee_id: employeeId,
        opened_by: employeeId,
        opening_float: openingFloat,
        opened_at: new Date(),
      }).returning('*');

      // Audit log
      await db('audit_logs').insert({
        store_id: storeId,
        employee_id: employeeId,
        action: 'CREATE',
        resource_type: 'cash_register_session',
        resource_id: session.id,
        new_value: JSON.stringify({ posTerminalId, openingFloat }),
        ip_address: req.ip,
      });

      logger.info({ sessionId: session.id, posTerminalId, storeId }, 'Cash register opened');
      res.status(201).json({ success: true, data: session });
    } catch (err) { next(err); }
  },

  closeSession: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, sub: employeeId } = req.auth;
      const { sessionId, closingFloat, notes } = req.body as {
        sessionId: string;
        closingFloat: number;
        notes?: string;
      };

      const session = await db('cash_register_sessions')
        .where({ id: sessionId, store_id: storeId })
        .whereNull('closed_at')
        .first();

      if (!session) throw new AppError('SESSION_NOT_FOUND', 'Open session not found', 404);

      // Generate close report for expected cash calculation
      const report = await analyticsService.generateCashCloseReport(
        storeId,
        session.pos_terminal_id,
        sessionId
      );

      const expectedCash = report.expectedCash;
      const variance = closingFloat - expectedCash;

      const [closed] = await db('cash_register_sessions')
        .where({ id: sessionId })
        .update({
          closed_by: employeeId,
          closing_float: closingFloat,
          expected_cash: expectedCash,
          variance,
          closed_at: new Date(),
          cash_sales: report.cashSales,
          card_sales: report.cardSales,
          orders_count: report.orders.count,
          notes: notes ?? null,
          updated_at: new Date(),
        })
        .returning('*');

      // Audit log
      await db('audit_logs').insert({
        store_id: storeId,
        employee_id: employeeId,
        action: 'CASH_CLOSE',
        resource_type: 'cash_register_session',
        resource_id: sessionId,
        new_value: JSON.stringify({ closingFloat, expectedCash, variance }),
        ip_address: req.ip,
      });

      logger.info({
        sessionId,
        variance,
        closingFloat,
        expectedCash,
      }, 'Cash register closed');

      res.json({
        success: true,
        data: {
          session: closed,
          report,
          variance,
          varianceWarning: Math.abs(variance) > 50,
        },
      });
    } catch (err) { next(err); }
  },

  getHistory: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.auth;
      const page = parseInt(req.query.page as string ?? '1');
      const perPage = Math.min(parseInt(req.query.perPage as string ?? '20'), 100);

      const [{ count }] = await db('cash_register_sessions')
        .where({ store_id: storeId })
        .count('* as count');

      const sessions = await db('cash_register_sessions')
        .join('employees as opener', 'cash_register_sessions.opened_by', 'opener.id')
        .leftJoin('employees as closer', 'cash_register_sessions.closed_by', 'closer.id')
        .where('cash_register_sessions.store_id', storeId)
        .select(
          'cash_register_sessions.*',
          db.raw("opener.first_name || ' ' || opener.last_name as opened_by_name"),
          db.raw("closer.first_name || ' ' || closer.last_name as closed_by_name"),
        )
        .orderBy('cash_register_sessions.opened_at', 'desc')
        .limit(perPage)
        .offset((page - 1) * perPage);

      res.json({
        success: true,
        data: sessions,
        meta: {
          page,
          perPage,
          total: parseInt(count as string),
          totalPages: Math.ceil(parseInt(count as string) / perPage),
        },
      });
    } catch (err) { next(err); }
  },

  getSessionReport: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.auth;
      const session = await db('cash_register_sessions')
        .where({ id: req.params.sessionId, store_id: storeId })
        .first();

      if (!session) throw new AppError('NOT_FOUND', 'Session not found', 404);

      const report = await analyticsService.generateCashCloseReport(
        storeId,
        session.pos_terminal_id,
        session.id
      );

      res.json({ success: true, data: { session, report } });
    } catch (err) { next(err); }
  },
};
