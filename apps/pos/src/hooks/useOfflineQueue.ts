// apps/pos/src/hooks/useOfflineQueue.ts
// IndexedDB-backed offline queue with automatic sync on reconnect

import { useEffect, useRef, useState, useCallback } from 'react';
import type { Socket } from 'socket.io-client';

interface QueuedEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  timestamp: string;
  retryCount: number;
}

const DB_NAME = 'snackpos_offline';
const STORE_NAME = 'queue';
const DB_VERSION = 1;

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp');
        store.createIndex('type', 'type');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll(): Promise<QueuedEvent[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).index('timestamp').getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(event: QueuedEvent): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(event);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbCount(): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

interface UseOfflineQueueReturn {
  enqueue: (event: { type: string; payload: Record<string, unknown>; idempotencyKey: string }) => Promise<void>;
  pendingCount: number;
  isSyncing: boolean;
  forceSync: () => Promise<void>;
}

export function useOfflineQueue(socket: Socket | null): UseOfflineQueueReturn {
  const [pendingCount, setPendingCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const syncingRef = useRef(false);

  // Update pending count on mount
  useEffect(() => {
    idbCount().then(setPendingCount).catch(() => {});
  }, []);

  const enqueue = useCallback(async (event: {
    type: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }) => {
    const queuedEvent: QueuedEvent = {
      id: crypto.randomUUID(),
      type: event.type,
      payload: event.payload,
      idempotencyKey: event.idempotencyKey,
      timestamp: new Date().toISOString(),
      retryCount: 0,
    };

    await idbPut(queuedEvent);
    setPendingCount(c => c + 1);
    console.log('[OfflineQueue] Enqueued:', event.type, event.idempotencyKey);
  }, []);

  const sync = useCallback(async () => {
    if (syncingRef.current || !socket?.connected) return;

    const events = await idbGetAll();
    if (events.length === 0) return;

    syncingRef.current = true;
    setIsSyncing(true);

    console.log('[OfflineQueue] Syncing', events.length, 'events');

    return new Promise<void>((resolve) => {
      socket.emit('offline_queue:sync', events, async (results: Array<{ id: string; success: boolean; error?: string }>) => {
        for (const result of results) {
          if (result.success) {
            await idbDelete(result.id);
          } else {
            // Increment retry count
            const event = events.find(e => e.id === result.id);
            if (event) {
              await idbPut({ ...event, retryCount: event.retryCount + 1 });
            }
            console.error('[OfflineQueue] Failed to sync event:', result.id, result.error);
          }
        }

        const remaining = await idbCount();
        setPendingCount(remaining);
        syncingRef.current = false;
        setIsSyncing(false);
        resolve();
      });

      // Timeout: if no response in 30s, reset
      setTimeout(() => {
        if (syncingRef.current) {
          syncingRef.current = false;
          setIsSyncing(false);
          resolve();
        }
      }, 30000);
    });
  }, [socket]);

  // Auto-sync on socket reconnect
  useEffect(() => {
    if (!socket) return;

    socket.on('connect', () => {
      // Small delay to let connection stabilize
      setTimeout(() => sync(), 1000);
    });

    return () => {
      socket.off('connect');
    };
  }, [socket, sync]);

  // Periodic sync attempt every 60s when connected
  useEffect(() => {
    const interval = setInterval(() => {
      if (socket?.connected && pendingCount > 0) {
        sync();
      }
    }, 60000);

    return () => clearInterval(interval);
  }, [socket, pendingCount, sync]);

  return {
    enqueue,
    pendingCount,
    isSyncing,
    forceSync: sync,
  };
}
