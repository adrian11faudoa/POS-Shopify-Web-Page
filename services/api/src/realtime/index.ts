// services/api/src/realtime/index.ts
// Production Socket.IO server with room-based multi-tenant isolation

import { Server as SocketIOServer, type Socket } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { verifyToken } from '../lib/jwt';
import { verifyPosPin } from '../services/auth.service';
import { db } from '../lib/database';
import { eventBus } from '../lib/event-bus';
import { createLogger } from '../lib/logger';
import { config } from '../config';
import type { RealtimeEvent, AuthToken } from '@snackpos/types';

const logger = createLogger('realtime');

// ─── Room Naming ──────────────────────────────────────────────────────────────
const rooms = {
  store: (storeId: string) => `store:${storeId}`,
  orders: (storeId: string) => `store:${storeId}:orders`,
  kds: (storeId: string) => `store:${storeId}:kds`,
  pos: (storeId: string, terminalId: string) => `store:${storeId}:pos:${terminalId}`,
  admin: (storeId: string) => `store:${storeId}:admin`,
};

// ─── Extended Socket Type ─────────────────────────────────────────────────────
interface AuthenticatedSocket extends Socket {
  storeId: string;
  employeeId: string;
  role: string;
  posTerminalId?: string;
  clientType: 'pos' | 'kds' | 'admin' | 'customer';
}

// ─── Initialize ───────────────────────────────────────────────────────────────
export async function initializeRealtime(httpServer: HTTPServer): Promise<SocketIOServer> {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.ALLOWED_ORIGINS,
      credentials: true,
    },
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
      skipMiddlewares: true,
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 30000,
    pingInterval: 25000,
  });

  // ─── Redis Adapter (for horizontal scaling) ─────────────────────────────────
  const pubClient = createClient({ url: config.REDIS_URL });
  const subClient = pubClient.duplicate();

  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));

  logger.info('Socket.IO Redis adapter connected');

  // ─── Authentication Middleware ──────────────────────────────────────────────
  io.use(async (socket: Socket, next) => {
    const { token, pinToken, storeId, clientType, posTerminalId } = socket.handshake.auth;

    const authedSocket = socket as AuthenticatedSocket;

    try {
      if (token) {
        // JWT auth (admin, manager)
        const decoded = await verifyToken(token) as AuthToken;
        authedSocket.storeId = decoded.storeId;
        authedSocket.employeeId = decoded.sub;
        authedSocket.role = decoded.role;
        authedSocket.clientType = clientType ?? 'admin';
      } else if (pinToken && storeId && posTerminalId) {
        // PIN auth (cashier POS, KDS)
        const session = await verifyPosPin(pinToken);
        authedSocket.storeId = session.storeId;
        authedSocket.employeeId = session.employeeId;
        authedSocket.role = session.role;
        authedSocket.posTerminalId = posTerminalId;
        authedSocket.clientType = clientType ?? 'pos';
      } else {
        return next(new Error('Authentication required'));
      }

      // Verify store exists and is active
      const store = await db('stores')
        .where({ id: authedSocket.storeId, is_active: true })
        .first();

      if (!store) return next(new Error('Store not found or inactive'));

      next();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Socket auth failed');
      next(new Error('Invalid credentials'));
    }
  });

  // ─── Connection Handling ───────────────────────────────────────────────────
  io.on('connection', (socket: Socket) => {
    const s = socket as AuthenticatedSocket;

    logger.info({
      socketId: s.id,
      storeId: s.storeId,
      employeeId: s.employeeId,
      clientType: s.clientType,
    }, 'Client connected');

    // Auto-join rooms based on client type
    s.join(rooms.store(s.storeId));

    switch (s.clientType) {
      case 'admin':
        s.join(rooms.admin(s.storeId));
        s.join(rooms.orders(s.storeId));
        break;
      case 'pos':
        s.join(rooms.orders(s.storeId));
        if (s.posTerminalId) {
          s.join(rooms.pos(s.storeId, s.posTerminalId));
        }
        break;
      case 'kds':
        s.join(rooms.kds(s.storeId));
        break;
    }

    // ─── POS Events ──────────────────────────────────────────────────────────

    // Client subscribes to specific order updates
    s.on('order:subscribe', ({ orderId }: { orderId: string }) => {
      s.join(`order:${orderId}`);
    });

    s.on('order:unsubscribe', ({ orderId }: { orderId: string }) => {
      s.leave(`order:${orderId}`);
    });

    // KDS: Mark item as being prepared
    s.on('kds:item_preparing', async ({ orderId, itemId }: { orderId: string; itemId: string }) => {
      try {
        await db('order_items')
          .where({ id: itemId, order_id: orderId })
          .update({ status: 'PREPARING' });

        // Notify the specific order room and POS
        io.to(rooms.orders(s.storeId)).emit('order_item:status_changed', {
          type: 'order_item:status_changed',
          storeId: s.storeId,
          orderId,
          itemId,
          newStatus: 'PREPARING',
        });
      } catch (err) {
        logger.error({ err, orderId, itemId }, 'KDS item preparing error');
        s.emit('error', { message: 'Failed to update item status' });
      }
    });

    // KDS: Mark item as ready
    s.on('kds:item_ready', async ({ orderId, itemId }: { orderId: string; itemId: string }) => {
      try {
        await db('order_items')
          .where({ id: itemId, order_id: orderId })
          .update({ status: 'READY', prepared_at: new Date() });

        // Check if all items are ready
        const allItems = await db('order_items')
          .where({ order_id: orderId })
          .whereNot({ status: 'CANCELLED' });

        const allReady = allItems.every(i => ['READY', 'SERVED'].includes(i.status));

        io.to(rooms.orders(s.storeId)).emit('order_item:status_changed', {
          type: 'order_item:status_changed',
          storeId: s.storeId,
          orderId,
          itemId,
          newStatus: 'READY',
        });

        if (allReady) {
          // Auto-transition order to READY
          await db('orders')
            .where({ id: orderId })
            .update({ status: 'READY', ready_at: new Date() });

          io.to(rooms.orders(s.storeId)).emit('order:status_changed', {
            type: 'order:status_changed',
            storeId: s.storeId,
            orderId,
            newStatus: 'READY',
            timestamp: new Date(),
          });
        }
      } catch (err) {
        logger.error({ err, orderId, itemId }, 'KDS item ready error');
        s.emit('error', { message: 'Failed to update item status' });
      }
    });

    // POS: Heartbeat / keepalive
    s.on('pos:heartbeat', (data: { posTerminalId: string; cashRegisterId?: string }) => {
      // Update terminal last-seen in Redis
      void db.raw(
        'UPDATE stores SET settings = jsonb_set(settings, $1, $2) WHERE id = $3',
        [
          `{terminalStatus,${data.posTerminalId}}`,
          JSON.stringify({ lastSeen: new Date().toISOString(), socketId: s.id }),
          s.storeId,
        ]
      );
      s.emit('pos:heartbeat_ack', { serverTime: new Date().toISOString() });
    });

    // Offline queue sync
    s.on('offline_queue:sync', async (events: OfflineQueueEvent[]) => {
      logger.info({
        storeId: s.storeId,
        count: events.length,
        socketId: s.id,
      }, 'Processing offline queue');

      const results: Array<{ id: string; success: boolean; error?: string }> = [];

      for (const event of events) {
        try {
          // Check idempotency
          const existing = await db('offline_queue')
            .where({ idempotency_key: event.idempotencyKey })
            .first();

          if (existing?.processed_at) {
            results.push({ id: event.id, success: true });
            continue;
          }

          await processOfflineEvent(event, s.storeId, s.employeeId);

          await db('offline_queue')
            .insert({
              store_id: s.storeId,
              pos_terminal_id: s.posTerminalId ?? 'unknown',
              operation_type: event.type,
              payload: JSON.stringify(event.payload),
              idempotency_key: event.idempotencyKey,
              processed_at: new Date(),
            })
            .onConflict('idempotency_key')
            .merge({ processed_at: new Date() });

          results.push({ id: event.id, success: true });
        } catch (err) {
          const error = err as Error;
          logger.error({ err, eventId: event.id }, 'Failed to process offline event');
          results.push({ id: event.id, success: false, error: error.message });

          await db('offline_queue')
            .insert({
              store_id: s.storeId,
              pos_terminal_id: s.posTerminalId ?? 'unknown',
              operation_type: event.type,
              payload: JSON.stringify(event.payload),
              idempotency_key: event.idempotencyKey,
              failed_at: new Date(),
              retry_count: 1,
              error: error.message,
            })
            .onConflict('idempotency_key')
            .merge({ retry_count: db.raw('offline_queue.retry_count + 1'), error: error.message });
        }
      }

      s.emit('offline_queue:sync_result', { results });
    });

    // ─── Disconnect ──────────────────────────────────────────────────────────
    s.on('disconnect', (reason) => {
      logger.info({
        socketId: s.id,
        storeId: s.storeId,
        employeeId: s.employeeId,
        reason,
      }, 'Client disconnected');
    });
  });

  // ─── Internal Event Bus → Socket.IO Bridge ─────────────────────────────────
  eventBus.on('order:created', (event: { storeId: string; order: unknown }) => {
    io.to(rooms.orders(event.storeId)).emit('order:created', event);
    io.to(rooms.kds(event.storeId)).emit('kds:order', {
      type: 'kds:order',
      storeId: event.storeId,
      order: event.order,
    });
  });

  eventBus.on('order:status_changed', (event) => {
    io.to(rooms.orders(event.storeId)).emit('order:status_changed', event);
    io.to(`order:${event.orderId}`).emit('order:status_changed', event);
  });

  eventBus.on('order_item:status_changed', (event) => {
    io.to(rooms.orders(event.storeId)).emit('order_item:status_changed', event);
  });

  eventBus.on('inventory:updated', (event) => {
    io.to(rooms.store(event.storeId)).emit('inventory:updated', event);
  });

  eventBus.on('pos:notification', (event) => {
    io.to(rooms.store(event.storeId)).emit('pos:notification', event);
  });

  logger.info('Socket.IO server initialized');
  return io;
}

// ─── Offline Event Processor ──────────────────────────────────────────────────
interface OfflineQueueEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  timestamp: string;
}

async function processOfflineEvent(
  event: OfflineQueueEvent,
  storeId: string,
  employeeId: string
): Promise<void> {
  const { orderService } = await import('../services/order.service');

  switch (event.type) {
    case 'order:create':
      await orderService.createOrder(
        { ...event.payload as Parameters<typeof orderService.createOrder>[0], storeId },
        employeeId
      );
      break;

    case 'order:status_change':
      await orderService.updateOrderStatus(
        event.payload.orderId as string,
        { status: event.payload.status as string },
        employeeId
      );
      break;

    default:
      logger.warn({ eventType: event.type }, 'Unknown offline event type');
  }
}
