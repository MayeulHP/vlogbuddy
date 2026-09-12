import "server-only";
import type { Server as SocketServer } from "socket.io";
import type { ServerToClientEvents } from "@vlogbuddy/shared";
import { roomForVlog } from "@vlogbuddy/shared";

/**
 * The Socket.IO server lives on the custom Node server (server.ts) and is
 * stashed on globalThis so server actions and route handlers can broadcast
 * without importing the HTTP layer.
 */

declare global {
  // eslint-disable-next-line no-var
  var __vlogbuddyIo: SocketServer | undefined;
}

export function setIo(io: SocketServer) {
  globalThis.__vlogbuddyIo = io;
}

export function getIo(): SocketServer | undefined {
  return globalThis.__vlogbuddyIo;
}

/** Broadcast to everyone currently viewing a vlog. No-op if IO isn't up yet. */
export function emitToVlog<E extends keyof ServerToClientEvents>(
  vlogId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
) {
  const io = getIo();
  if (!io) return;
  io.to(roomForVlog(vlogId)).emit(event as string, ...(args as unknown[]));
}
