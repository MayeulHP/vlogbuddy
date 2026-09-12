import type { TimelineDoc, TimelineOp } from "./timeline";
import type { ProcessingStatus, RenderStatus, VlogState } from "./constants";

/**
 * Socket.IO contract. One room per vlog (`vlog:<id>`); the DB stays the source
 * of truth and these events just keep everyone's screen fresh.
 */

export interface PresenceMember {
  memberId: string;
  displayName: string;
  color: string;
}

export interface MediaReadyPayload {
  mediaItemId: string;
  status: ProcessingStatus;
  thumbnailKey: string | null;
  proxyKey: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  capturedAt: string | null;
  error?: string | null;
}

export interface ReactionPayload {
  targetType: "media" | "music";
  targetId: string;
  memberId: string;
  score: 1 | 2 | 3 | null;
  totals: { count: number; sum: number; average: number };
}

export interface RenderProgressPayload {
  renderJobId: string;
  status: RenderStatus;
  progress: number; // 0..100
  message?: string;
  outputUrl?: string | null;
  error?: string | null;
}

export interface ServerToClientEvents {
  "presence:sync": (members: PresenceMember[]) => void;
  "member:joined": (member: PresenceMember) => void;
  "member:left": (payload: { memberId: string }) => void;

  "media:added": (payload: { mediaItemId: string }) => void;
  "media:updated": (payload: MediaReadyPayload) => void;
  "media:removed": (payload: { mediaItemId: string }) => void;

  "music:added": (payload: { musicItemId: string }) => void;
  "music:moved": (payload: { musicItemId: string; timelinePosition: number }) => void;
  "music:removed": (payload: { musicItemId: string }) => void;

  "reaction:updated": (payload: ReactionPayload) => void;
  "selection:updated": (payload: {
    targetType: "media" | "music";
    targetId: string;
    selected: boolean;
    orderIndex: number | null;
  }) => void;
  "selection:reordered": (payload: { order: string[] }) => void;

  "vlog:state": (payload: { state: VlogState }) => void;

  "timeline:sync": (payload: { timeline: TimelineDoc; revision: number }) => void;
  "timeline:op": (payload: { op: TimelineOp; revision: number; byMemberId: string }) => void;

  "render:progress": (payload: RenderProgressPayload) => void;

  error: (payload: { message: string }) => void;
}

export interface ClientToServerEvents {
  "room:join": (payload: { vlogId: string }, ack?: (ok: boolean) => void) => void;
  "room:leave": (payload: { vlogId: string }) => void;
  "timeline:op": (
    payload: { vlogId: string; op: TimelineOp; revision: number },
    ack?: (result: { ok: boolean; revision?: number; timeline?: TimelineDoc; error?: string }) => void,
  ) => void;
  "timeline:request": (payload: { vlogId: string }) => void;
}

export const roomForVlog = (vlogId: string) => `vlog:${vlogId}`;

/** Stable per-member colour for presence cursors/avatars. */
export function colorForMember(memberId: string): string {
  const palette = [
    "#ef4444", "#f97316", "#f59e0b", "#84cc16", "#22c55e",
    "#14b8a6", "#06b6d4", "#3b82f6", "#6366f1", "#a855f7",
    "#ec4899", "#f43f5e",
  ];
  let hash = 0;
  for (let i = 0; i < memberId.length; i++) {
    hash = (hash * 31 + memberId.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}
