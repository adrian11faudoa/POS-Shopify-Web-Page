// services/api/src/lib/errors.ts

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 500,
    public readonly details?: Record<string, string[]>
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

// services/api/src/middleware/error-handler.ts
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors';
import { createLogger } from '../lib/logger';

const logger = createLogger('error-handler');

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({ err, url: req.url, method: req.method }, 'Application error');
    } else {
      logger.warn({ code: err.code, message: err.message, url: req.url }, 'Client error');
    }

    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  // Knex / database errors
  const dbErr = err as { code?: string; constraint?: string; detail?: string };
  if (dbErr.code === '23505') {
    // Unique constraint violation
    res.status(409).json({
      success: false,
      error: {
        code: 'DUPLICATE_ENTRY',
        message: 'A record with these values already exists',
        details: dbErr.detail ? { constraint: [dbErr.detail] } : undefined,
      },
    });
    return;
  }

  if (dbErr.code === '23503') {
    // Foreign key violation
    res.status(400).json({
      success: false,
      error: { code: 'REFERENCE_ERROR', message: 'Referenced record does not exist' },
    });
    return;
  }

  // JWT errors (passed through as Error instances)
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    res.status(401).json({
      success: false,
      error: {
        code: err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
        message: 'Authentication failed',
      },
    });
    return;
  }

  // Zod validation errors
  if (err.name === 'ZodError') {
    const zodErr = err as { errors: Array<{ path: string[]; message: string }> };
    const details: Record<string, string[]> = {};
    for (const issue of zodErr.errors) {
      const key = issue.path.join('.');
      details[key] = [...(details[key] ?? []), issue.message];
    }
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details },
    });
    return;
  }

  // Unknown errors
  logger.error({ err, url: req.url, method: req.method }, 'Unhandled error');

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred'
        : err.message,
    },
  });
}

// services/api/src/middleware/not-found.ts
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Cannot ${req.method} ${req.path}`,
    },
  });
}

// services/api/src/middleware/request-id.ts
import { randomUUID } from 'crypto';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = req.headers['x-request-id'] as string ?? randomUUID();
  req.headers['x-request-id'] = id;
  res.setHeader('X-Request-ID', id);
  next();
}

// services/api/src/middleware/tenant-resolver.ts
export function tenantResolver(req: Request, res: Response, next: NextFunction): void {
  // Allow storeId from header, auth token, or query param
  const storeId =
    req.headers['x-store-id'] as string ??
    req.query.storeId as string ??
    null;

  if (storeId) {
    (req as Record<string, unknown>).resolvedStoreId = storeId;
  }

  next();
}

// services/api/src/middleware/validate.ts
import { type ZodSchema } from 'zod';

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(result.error);
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(result.error);
    }
    (req as Record<string, unknown>).validatedQuery = result.data;
    next();
  };
}
