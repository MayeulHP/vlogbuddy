import { getSqlClient } from "@vlogbuddy/db";
import type { MediaReadyPayload, RenderProgressPayload } from "@vlogbuddy/shared";

/**
 * The worker is a separate process, so it can't reach the web app's Socket.IO
 * server directly. It publishes on a Postgres NOTIFY channel instead; the web
 * process LISTENs and rebroadcasts to the right room. No extra broker needed.
 */

export const NOTIFY_CHANNEL = "vlogbuddy_events";

type WorkerEvent =
  | { type: "media:updated"; vlogId: string; payload: MediaReadyPayload }
  | { type: "render:progress"; vlogId: string; payload: RenderProgressPayload };

async function publish(event: WorkerEvent): Promise<void> {
  try {
    const sql = getSqlClient();
    // NOTIFY payloads are capped at 8000 bytes.
    const json = JSON.stringify(event).slice(0, 7900);
    await sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${json})`;
  } catch (err) {
    // Realtime is a nicety — the UI still refreshes on its own.
    console.warn("[notify] failed to publish:", (err as Error).message);
  }
}

export async function notifyMediaUpdated(
  vlogId: string,
  payload: MediaReadyPayload,
): Promise<void> {
  await publish({ type: "media:updated", vlogId, payload });
}

export async function notifyRenderProgress(
  vlogId: string,
  payload: RenderProgressPayload,
): Promise<void> {
  await publish({ type: "render:progress", vlogId, payload });
}
