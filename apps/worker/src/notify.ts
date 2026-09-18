import { getSqlClient } from "@vlogbuddy/db";
import type {
  ImmichTransferPayload,
  MediaReadyPayload,
  RenderProgressPayload,
} from "@vlogbuddy/shared";

/**
 * The worker is a separate process, so it can't reach the web app's Socket.IO
 * server directly. It publishes on a Postgres NOTIFY channel instead; the web
 * process LISTENs and rebroadcasts to the right room. No extra broker needed.
 */

export const NOTIFY_CHANNEL = "vlogbuddy_events";

type WorkerEvent =
  | { type: "media:updated"; vlogId: string; payload: MediaReadyPayload }
  | { type: "render:progress"; vlogId: string; payload: RenderProgressPayload }
  | { type: "immich:transfer"; vlogId: string; payload: ImmichTransferPayload }
  /**
   * Reuses the "a track appeared" event: the browser only has to re-read the
   * row to pick up the freshly extracted audio and its presigned URL.
   */
  | { type: "music:added"; vlogId: string; payload: { musicItemId: string } }
  /**
   * Not a browser event: the web process intercepts this one and re-runs the
   * cut engine. The worker can't do it itself — the engine lives in the web
   * app — and media that appeared without it would never join the cut.
   */
  | { type: "cut:resync"; vlogId: string; payload: { memberId: string } };

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

export async function notifyImmichTransfer(
  vlogId: string,
  payload: ImmichTransferPayload,
): Promise<void> {
  await publish({ type: "immich:transfer", vlogId, payload });
}

/** Nudges every open browser to re-read a track whose audio just changed. */
export async function notifyMusicUpdated(vlogId: string, musicItemId: string): Promise<void> {
  await publish({ type: "music:added", vlogId, payload: { musicItemId } });
}

/** Asks the web process to rebuild the cut after media appeared out of band. */
export async function notifyCutResync(vlogId: string, memberId: string): Promise<void> {
  await publish({ type: "cut:resync", vlogId, payload: { memberId } });
}

/**
 * The same request, coalesced per vlog.
 *
 * `process-media` is fan-out by design — a drop of thirty photos is thirty
 * jobs — and every one of them ends with a duration and a capture time the cut
 * engine wants to see. Sending a resync per job would ask the web process to
 * rebuild the whole document thirty times over, each rebuild a revision that
 * yanks the document out from under anyone editing. So the last request in a
 * burst wins: the timer restarts on each call, and `MAX_WAIT` stops a long
 * queue of uploads from starving the cut of any update at all while it drains.
 *
 * Which member gets the credit is the latest one to finish — it only lands in
 * `updated_by_id`, and the alternative is a resync each.
 */
const RESYNC_QUIET_MS = 1500;
const RESYNC_MAX_WAIT_MS = 8000;

interface PendingResync {
  timer: ReturnType<typeof setTimeout>;
  memberId: string;
  firstRequestedAt: number;
}

const pendingResyncs = new Map<string, PendingResync>();

export function requestCutResync(vlogId: string, memberId: string): void {
  const existing = pendingResyncs.get(vlogId);
  if (existing) clearTimeout(existing.timer);

  const firstRequestedAt = existing?.firstRequestedAt ?? Date.now();
  const waited = Date.now() - firstRequestedAt;
  const delay = Math.max(0, Math.min(RESYNC_QUIET_MS, RESYNC_MAX_WAIT_MS - waited));

  const timer = setTimeout(() => {
    const entry = pendingResyncs.get(vlogId);
    pendingResyncs.delete(vlogId);
    if (entry) void notifyCutResync(vlogId, entry.memberId);
  }, delay);

  // A pending nicety must never hold the process open on its way out.
  timer.unref?.();

  pendingResyncs.set(vlogId, { timer, memberId, firstRequestedAt });
}

export async function notifyRenderProgress(
  vlogId: string,
  payload: RenderProgressPayload,
): Promise<void> {
  await publish({ type: "render:progress", vlogId, payload });
}
