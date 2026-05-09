// apps/pos/src/hooks/useSocket.ts
// Socket.IO client with auto-reconnect, exponential backoff, and offline detection

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';

type ClientType = 'pos' | 'kds' | 'admin';

interface UseSocketReturn {
  socket: Socket | null;
  isConnected: boolean;
  connectionError: string | null;
  reconnectAttempt: number;
}

const SOCKET_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const MAX_RECONNECT_ATTEMPTS = Infinity;

export function useSocket(
  storeId: string,
  posTerminalId: string,
  clientType: ClientType = 'pos'
): UseSocketReturn {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  useEffect(() => {
    const token = localStorage.getItem('pos_token') ?? '';
    const pinToken = localStorage.getItem('pos_pin_token') ?? '';

    const socket = io(SOCKET_URL, {
      auth: {
        token: token || undefined,
        pinToken: pinToken || undefined,
        storeId,
        posTerminalId,
        clientType,
      },
      reconnectionAttempts: MAX_RECONNECT_ATTEMPTS,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      randomizationFactor: 0.5,
      transports: ['websocket', 'polling'],
      withCredentials: true,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      setConnectionError(null);
      setReconnectAttempt(0);
      console.log('[Socket] Connected:', socket.id);
    });

    socket.on('disconnect', (reason) => {
      setIsConnected(false);
      console.log('[Socket] Disconnected:', reason);
    });

    socket.on('connect_error', (err) => {
      setConnectionError(err.message);
      console.error('[Socket] Connection error:', err.message);
    });

    socket.on('reconnect_attempt', (attempt) => {
      setReconnectAttempt(attempt);
    });

    socket.on('reconnect', () => {
      setIsConnected(true);
      setConnectionError(null);
    });

    // Heartbeat
    const heartbeatInterval = setInterval(() => {
      if (socket.connected) {
        socket.emit('pos:heartbeat', { posTerminalId });
      }
    }, 30000);

    return () => {
      clearInterval(heartbeatInterval);
      socket.disconnect();
    };
  }, [storeId, posTerminalId, clientType]);

  return {
    socket: socketRef.current,
    isConnected,
    connectionError,
    reconnectAttempt,
  };
}
