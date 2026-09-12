"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  PresenceMember,
  ServerToClientEvents,
} from "@vlogbuddy/shared";

export type VlogSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * One socket per vlog. Keeps presence in state and hands the raw socket back so
 * feature components can subscribe to whatever events they care about.
 *
 * The socket is state, not a ref, and that matters: React runs child effects
 * before the parent's, so a ref would still be null when a nested component
 * tried to subscribe and it would silently never hear anything. Holding it in
 * state re-renders the children the moment it exists, and their subscriptions
 * bind for real.
 */
export function useVlogSocket(vlogId: string) {
  const [socket, setSocket] = useState<VlogSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [presence, setPresence] = useState<PresenceMember[]>([]);

  useEffect(() => {
    const socket: VlogSocket = io({
      path: "/api/socket",
      auth: { vlogId },
      withCredentials: true,
      transports: ["websocket", "polling"],
    });

    setSocket(socket);

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (err) => {
      console.warn("[socket] connection error:", err.message);
      setConnected(false);
    });

    socket.on("presence:sync", (list) => setPresence(list));
    socket.on("member:joined", (m) =>
      setPresence((prev) => (prev.some((p) => p.memberId === m.memberId) ? prev : [...prev, m])),
    );
    socket.on("member:left", ({ memberId }) =>
      setPresence((prev) => prev.filter((p) => p.memberId !== memberId)),
    );

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      setSocket(null);
    };
  }, [vlogId]);

  return { socket, connected, presence };
}

/**
 * Subscribe to a single server event for the lifetime of the component.
 *
 * The handler is held in a ref so a fresh closure on every render doesn't tear
 * the listener down and rebuild it — only the socket or the event name does.
 */
export function useSocketEvent<E extends keyof ServerToClientEvents>(
  socket: VlogSocket | null,
  event: E,
  handler: ServerToClientEvents[E],
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!socket) return;

    const listener = (...args: unknown[]) => {
      (handlerRef.current as (...a: unknown[]) => void)(...args);
    };

    // socket.io's event-name generics don't survive this indirection.
    const emitter = socket as unknown as {
      on: (e: string, fn: (...a: unknown[]) => void) => void;
      off: (e: string, fn: (...a: unknown[]) => void) => void;
    };

    emitter.on(event as string, listener);
    return () => {
      emitter.off(event as string, listener);
    };
  }, [socket, event]);
}
