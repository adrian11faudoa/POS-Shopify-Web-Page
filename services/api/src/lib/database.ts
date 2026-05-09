// services/api/src/lib/database.ts
// Knex database client with connection pooling and health monitoring

import Knex from 'knex';
import { config } from '../config';
import { createLogger } from './logger';

const logger = createLogger('database');

export const db = Knex({
  client: 'postgresql',
  connection: config.DATABASE_URL,
  pool: {
    min: parseInt(process.env.DATABASE_POOL_MIN ?? '2', 10),
    max: parseInt(process.env.DATABASE_POOL_MAX ?? '20', 10),
    acquireTimeoutMillis: 60000,
    idleTimeoutMillis: 600000,
    reapIntervalMillis: 1000,
    createTimeoutMillis: 30000,
    createRetryIntervalMillis: 200,
    propagateCreateError: false,
  },
  acquireConnectionTimeout: 60000,
  migrations: {
    tableName: 'knex_migrations',
    directory: '../../../packages/database/migrations',
  },
  searchPath: ['public'],
  debug: config.NODE_ENV === 'development' && process.env.DB_DEBUG === 'true',
  log: {
    warn(message: string) { logger.warn(message); },
    error(message: string) { logger.error(message); },
    deprecate(message: string) { logger.warn({ deprecation: true }, message); },
    debug(message: string) { logger.debug(message); },
  },
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await db.destroy();
  logger.info('Database pool closed');
});

// ─── services/api/src/lib/redis.ts ─────────────────────────────────────────

import { createClient } from 'redis';

const redisClient = createClient({
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  socket: {
    reconnectStrategy: (retries: number) => {
      if (retries > 10) return new Error('Redis max retries reached');
      return Math.min(retries * 100, 3000);
    },
    connectTimeout: 10000,
  },
});

redisClient.on('error', (err) => {
  const log = createLogger('redis');
  log.error({ err }, 'Redis client error');
});

redisClient.on('connect', () => {
  const log = createLogger('redis');
  log.info('Redis connected');
});

redisClient.on('reconnecting', () => {
  const log = createLogger('redis');
  log.warn('Redis reconnecting');
});

// Connect on startup
redisClient.connect().catch((err) => {
  const log = createLogger('redis');
  log.error({ err }, 'Redis initial connection failed');
});

export const redis = redisClient;

// ─── services/api/src/lib/logger.ts ────────────────────────────────────────

import pino from 'pino';

const baseLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(process.env.NODE_ENV === 'development' ? {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  } : {}),
  base: {
    service: 'snackpos-api',
    env: process.env.NODE_ENV,
  },
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

export function createLogger(name: string) {
  return baseLogger.child({ component: name });
}

// ─── services/api/src/lib/event-bus.ts ─────────────────────────────────────

import { EventEmitter } from 'events';

class TypedEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }
}

export const eventBus = new TypedEventBus();

// ─── services/api/src/config.ts ─────────────────────────────────────────────

import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().default('4000').transform(Number),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('1h'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000').transform(s => s.split(',')),
  TRUST_PROXY: z.string().default('1').transform(v => v === 'true' || v === '1'),
  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().default('2024-01'),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

function loadConfig() {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment configuration:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
