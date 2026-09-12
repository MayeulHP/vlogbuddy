"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  PresenceMember,
  ServerToClientEvents,
} from "@vlogbuddy/shared";

type VlogSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * One socket per vlog. Keeps presence in state and hands the raw socket back so
 * feature components can subscribe to whatever events they care about.
 */
export function useVlogSocket(vlogId: string) {
  const socketRef = useRef<VlogSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [presence, setPresence] = useState<PresenceMember[]>([]);

  useEffect(() => {
    const socket: VlogSocket = io({
      path: "/api/socket",
      auth: { vlogId },
      withCredentials: true,
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;

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
      socketRef.current = null;
    };
  }, [vlogId]);

  return { socket: socketRef, connected, presence };
}

/** Subscribe to a single server event for the lifetime of the component. */
export function useSocketEvent<E extends keyof ServerToClientEvents>(
  socketRef: React.MutableRefObject<VlogSocket | null>,
  event: E,
  handler: ServerToClientEvents[E],
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const socket = socketRef.current;
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
    // socketRef is stable; re-bind only if the event name changes.
  }, [socketRef, event]);
}
