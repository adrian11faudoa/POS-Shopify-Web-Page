// services/api/src/middleware/auth.ts
// JWT + PIN authentication middleware with RBAC

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { db } from '../lib/database';
import { redis } from '../lib/redis';
import { AppError } from '../lib/errors';
import { createLogger } from '../lib/logger';
import { config } from '../config';
import type { AuthToken, Permission, EmployeeRole } from '@snackpos/types';
import { ROLE_PERMISSIONS } from '@snackpos/types';

const logger = createLogger('auth');

// ─── Extend Express Request ───────────────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      auth: AuthToken;
      storeId: string;
    }
  }
}

// ─── JWT Utilities ────────────────────────────────────────────────────────────

export function signToken(payload: Omit<AuthToken, 'iat' | 'exp'>): string {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN,
    algorithm: 'HS256',
  });
}

export function signRefreshToken(payload: { sub: string; sessionId: string }): string {
  return jwt.sign(payload, config.JWT_REFRESH_SECRET, {
    expiresIn: config.JWT_REFRESH_EXPIRES_IN,
    algorithm: 'HS256',
  });
}

export async function verifyToken(token: string): Promise<AuthToken> {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as AuthToken;

    // Check token is not revoked
    const revoked = await redis.get(`revoked_token:${decoded.sessionId}`);
    if (revoked) throw new AppError('TOKEN_REVOKED', 'Token has been revoked', 401);

    return decoded;
  } catch (err) {
    if (err instanceof AppError) throw err;
    const error = err as Error;
    if (error.name === 'TokenExpiredError') {
      throw new AppError('TOKEN_EXPIRED', 'Token has expired', 401);
    }
    throw new AppError('TOKEN_INVALID', 'Invalid token', 401);
  }
}

// ─── Middleware: Require JWT Auth ─────────────────────────────────────────────

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError('UNAUTHORIZED', 'Authorization header required', 401);
  }

  const token = authHeader.slice(7);

  verifyToken(token)
    .then((decoded) => {
      req.auth = decoded;
      req.storeId = decoded.storeId;
      next();
    })
    .catch(next);
}

// ─── Middleware: Require Permission ───────────────────────────────────────────

export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      return next(new AppError('UNAUTHORIZED', 'Not authenticated', 401));
    }

    const hasPermission = permissions.every(p => req.auth.permissions.includes(p));
    if (!hasPermission) {
      logger.warn({
        employeeId: req.auth.sub,
        required: permissions,
        actual: req.auth.permissions,
      }, 'Permission denied');
      return next(new AppError('FORBIDDEN', 'Insufficient permissions', 403));
    }

    next();
  };
}

// ─── Middleware: Require Role ─────────────────────────────────────────────────

export function requireRole(...roles: EmployeeRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      return next(new AppError('UNAUTHORIZED', 'Not authenticated', 401));
    }

    if (!roles.includes(req.auth.role as EmployeeRole)) {
      return next(new AppError('FORBIDDEN', 'Role not authorized', 403));
    }

    next();
  };
}

// ─── Auth Routes Handler ──────────────────────────────────────────────────────

export async function loginHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, password, storeId } = req.body as {
      email: string;
      password: string;
      storeId: string;
    };

    if (!email || !password || !storeId) {
      throw new AppError('VALIDATION_ERROR', 'Email, password and storeId are required', 400);
    }

    const employee = await db('employees')
      .where({ store_id: storeId, email: email.toLowerCase(), is_active: true })
      .whereNull('deleted_at')
      .first();

    if (!employee) {
      // Use same error to prevent user enumeration
      throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
    }

    // Verify password (employees use bcrypt, POS uses separate PIN)
    const isValid = await bcrypt.compare(password, employee.pin_hash);
    if (!isValid) {
      logger.warn({ email, storeId }, 'Failed login attempt');
      throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
    }

    // Generate session ID for token revocation support
    const sessionId = crypto.randomUUID();
    const permissions = ROLE_PERMISSIONS[employee.role as EmployeeRole];

    const accessToken = signToken({
      sub: employee.id,
      storeId,
      role: employee.role,
      permissions,
      sessionId,
    });

    const refreshToken = signRefreshToken({ sub: employee.id, sessionId });

    // Store session in DB
    await db('employee_sessions').insert({
      employee_id: employee.id,
      store_id: storeId,
      token_hash: await bcrypt.hash(refreshToken, 10),
      ip_address: req.ip,
      device_info: JSON.stringify({ userAgent: req.headers['user-agent'] }),
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    });

    // Update last login
    await db('employees').where({ id: employee.id }).update({ last_login_at: new Date() });

    // Audit log
    await db('audit_logs').insert({
      store_id: storeId,
      employee_id: employee.id,
      action: 'LOGIN',
      resource_type: 'employee',
      resource_id: employee.id,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
    });

    res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        employee: {
          id: employee.id,
          firstName: employee.first_name,
          lastName: employee.last_name,
          email: employee.email,
          role: employee.role,
          permissions,
        },
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function pinLoginHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { pin, storeId, posTerminalId } = req.body as {
      pin: string;
      storeId: string;
      posTerminalId: string;
    };

    if (!pin || !storeId || !posTerminalId) {
      throw new AppError('VALIDATION_ERROR', 'PIN, storeId and posTerminalId are required', 400);
    }

    if (!/^\d{4}$/.test(pin)) {
      throw new AppError('VALIDATION_ERROR', 'PIN must be 4 digits', 400);
    }

    // Load all active employees for this store (brute-force protection via rate limiter)
    const employees = await db('employees')
      .where({ store_id: storeId, is_active: true })
      .whereNull('deleted_at');

    // Find matching PIN
    let matchedEmployee = null;
    for (const emp of employees) {
      const match = await bcrypt.compare(pin, emp.pin_hash);
      if (match) {
        matchedEmployee = emp;
        break;
      }
    }

    if (!matchedEmployee) {
      throw new AppError('INVALID_PIN', 'Invalid PIN', 401);
    }

    const permissions = ROLE_PERMISSIONS[matchedEmployee.role as EmployeeRole];
    const sessionId = crypto.randomUUID();

    // Short-lived POS session token (8 hours)
    const posToken = jwt.sign(
      {
        sub: matchedEmployee.id,
        storeId,
        role: matchedEmployee.role,
        permissions,
        sessionId,
        posTerminalId,
        type: 'pos',
      },
      config.JWT_SECRET,
      { expiresIn: '8h' }
    );

    // Cache POS session in Redis for fast lookup
    await redis.setex(
      `pos_session:${posToken.slice(-20)}`,
      8 * 3600,
      JSON.stringify({ employeeId: matchedEmployee.id, storeId, role: matchedEmployee.role, permissions })
    );

    res.json({
      success: true,
      data: {
        token: posToken,
        employee: {
          id: matchedEmployee.id,
          firstName: matchedEmployee.first_name,
          lastName: matchedEmployee.last_name,
          role: matchedEmployee.role,
          permissions,
        },
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function refreshTokenHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { refreshToken } = req.body as { refreshToken: string };
    if (!refreshToken) throw new AppError('VALIDATION_ERROR', 'Refresh token required', 400);

    const decoded = jwt.verify(refreshToken, config.JWT_REFRESH_SECRET) as {
      sub: string;
      sessionId: string;
    };

    // Find session
    const sessions = await db('employee_sessions')
      .where({ employee_id: decoded.sub })
      .where('expires_at', '>', new Date())
      .whereNull('revoked_at');

    // Find matching session by token hash
    let session = null;
    for (const s of sessions) {
      const match = await bcrypt.compare(refreshToken, s.token_hash);
      if (match) { session = s; break; }
    }

    if (!session) throw new AppError('TOKEN_INVALID', 'Invalid refresh token', 401);

    const employee = await db('employees')
      .where({ id: decoded.sub, is_active: true })
      .first();

    if (!employee) throw new AppError('UNAUTHORIZED', 'Employee not found', 401);

    const permissions = ROLE_PERMISSIONS[employee.role as EmployeeRole];
    const newSessionId = crypto.randomUUID();

    const accessToken = signToken({
      sub: employee.id,
      storeId: session.store_id,
      role: employee.role,
      permissions,
      sessionId: newSessionId,
    });

    // Revoke old session
    await db('employee_sessions').where({ id: session.id }).update({ revoked_at: new Date() });

    // Issue new refresh token and session
    const newRefreshToken = signRefreshToken({ sub: employee.id, sessionId: newSessionId });
    await db('employee_sessions').insert({
      employee_id: employee.id,
      store_id: session.store_id,
      token_hash: await bcrypt.hash(newRefreshToken, 10),
      ip_address: req.ip,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    res.json({
      success: true,
      data: { accessToken, refreshToken: newRefreshToken },
    });
  } catch (err) {
    next(err);
  }
}

export async function logoutHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.auth) {
      // Revoke token in Redis (TTL = remaining token lifetime)
      const remainingTtl = req.auth.exp - Math.floor(Date.now() / 1000);
      if (remainingTtl > 0) {
        await redis.setex(`revoked_token:${req.auth.sessionId}`, remainingTtl, '1');
      }

      // Revoke session in DB
      await db('employee_sessions')
        .where({ employee_id: req.auth.sub })
        .update({ revoked_at: new Date() });

      await db('audit_logs').insert({
        store_id: req.auth.storeId,
        employee_id: req.auth.sub,
        action: 'LOGOUT',
        resource_type: 'employee',
        resource_id: req.auth.sub,
        ip_address: req.ip,
      });
    }

    res.json({ success: true, data: null });
  } catch (err) {
    next(err);
  }
}
