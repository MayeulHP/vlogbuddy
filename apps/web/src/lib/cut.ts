import "server-only";
import { emitToVlog } from "./realtime";
import { syncCut as syncCutCore, type SyncCutOptions, type SyncCutResult } from "./cut-core";

/**
 * The cut engine, wired for the app: guarded against reaching a client bundle,
 * and broadcasting timeline changes over Socket.IO.
 *
 * The implementation lives in `./cut-core` because the custom server has to
 * call it from outside Next's module graph. Everything in the app imports it
 * from here.
 */
export async function syncCut(
  vlogId: string,
  memberId: string,
  options: SyncCutOptions = {},
): Promise<SyncCutResult> {
  return syncCutCore(vlogId, memberId, {
    ...options,
    onTimelineSync: (payload) => emitToVlog(vlogId, "timeline:sync", payload),
  });
}

export type { SyncCutOptions, SyncCutResult };
