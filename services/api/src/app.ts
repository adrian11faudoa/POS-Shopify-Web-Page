// services/api/src/app.ts
// Production-ready Express API with clean architecture

import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { rateLimit } from 'express-rate-limit';
import { createServer } from 'http';
import { json, urlencoded } from 'body-parser';
import { pinoHttp } from 'pino-http';
import { createLogger } from './lib/logger';
import { errorHandler } from './middleware/error-handler';
import { notFoundHandler } from './middleware/not-found';
import { requestId } from './middleware/request-id';
import { tenantResolver } from './middleware/tenant-resolver';
import { initializeRealtime } from './realtime';
import { registerRoutes } from './routes';
import { config } from './config';
import { db } from './lib/database';
import { redis } from './lib/redis';

const logger = createLogger('app');

export async function createApp(): Promise<{ app: Application; httpServer: ReturnType<typeof createServer> }> {
  const app = express();
  const httpServer = createServer(app);

  // ─── Trust Proxy (for Railway/Render/Fly.io/K8s) ────────────────────────────
  app.set('trust proxy', config.TRUST_PROXY);

  // ─── Logging ────────────────────────────────────────────────────────────────
  app.use(pinoHttp({
    logger,
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  }));

  // ─── Security ───────────────────────────────────────────────────────────────
  app.use(helmet({
    contentSecurityPolicy: config.NODE_ENV === 'production',
    crossOriginEmbedderPolicy: false,
  }));

  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || config.ALLOWED_ORIGINS.includes(origin)) {
        cb(null, true);
      } else {
        cb(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Store-ID'],
  }));

  // ─── Rate Limiting ──────────────────────────────────────────────────────────
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    skipSuccessfulRequests: true,
    message: { success: false, error: { code: 'RATE_LIMIT', message: 'Too many auth attempts' } },
  });

  app.use('/api', globalLimiter);
  app.use('/api/auth', authLimiter);

  // ─── Body Parsing ───────────────────────────────────────────────────────────
  // Webhooks need raw body for HMAC verification
  app.use('/api/webhooks', express.raw({ type: '*/*', limit: '1mb' }));
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));

  // ─── Compression ────────────────────────────────────────────────────────────
  app.use(compression());

  // ─── Request Metadata ───────────────────────────────────────────────────────
  app.use(requestId);
  app.use(tenantResolver);

  // ─── Health Checks ──────────────────────────────────────────────────────────
  app.get('/health', async (_req: Request, res: Response) => {
    const checks = await Promise.allSettled([
      db.raw('SELECT 1'),
      redis.ping(),
    ]);

    const [dbCheck, redisCheck] = checks;
    const healthy = checks.every(c => c.status === 'fulfilled');

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      services: {
        database: dbCheck.status === 'fulfilled' ? 'ok' : 'error',
        redis: redisCheck.status === 'fulfilled' ? 'ok' : 'error',
      },
    });
  });

  app.get('/ready', (_req: Request, res: Response) => {
    res.json({ status: 'ready' });
  });

  // ─── Routes ─────────────────────────────────────────────────────────────────
  registerRoutes(app);

  // ─── Error Handlers ─────────────────────────────────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  // ─── Initialize Realtime ────────────────────────────────────────────────────
  await initializeRealtime(httpServer);

  return { app, httpServer };
}
