import { z } from "zod";
import { DEFAULT_PHOTO_DURATION, DEFAULT_TRANSITION_DURATION } from "./constants";

/**
 * The timeline document: the single authoritative description of the final cut.
 *
 * Kept deliberately flat for v1 — one video track, one music track, titles as
 * overlays on clips. The editor mutates it through ops, the renderer compiles it
 * into an FFmpeg filter graph. Multi-track lives in v2 (see TODO.md).
 */

export const transitionSchema = z.enum(["cut", "crossfade"]);
export type Transition = z.infer<typeof transitionSchema>;

export const titleOverlaySchema = z.object({
  id: z.string(),
  text: z.string().max(200),
  /** Seconds from the start of the parent clip. */
  start: z.number().min(0).default(0),
  duration: z.number().positive().default(2),
  position: z.enum(["top", "center", "bottom"]).default("bottom"),
  fontSize: z.number().int().min(8).max(200).default(48),
  color: z.string().default("#ffffff"),
});
export type TitleOverlay = z.infer<typeof titleOverlaySchema>;

export const clipSchema = z.object({
  id: z.string(),
  mediaItemId: z.string().uuid(),
  kind: z.enum(["photo", "video"]),
  /** Seconds into the source file. Photos ignore trims and use `duration`. */
  trimStart: z.number().min(0).default(0),
  trimEnd: z.number().min(0).nullable().default(null),
  /** Photos only: how long the still holds on screen. */
  duration: z.number().positive().default(DEFAULT_PHOTO_DURATION),
  /** Transition *into* this clip from the previous one. */
  transitionIn: transitionSchema.default("cut"),
  transitionDuration: z.number().min(0).max(5).default(DEFAULT_TRANSITION_DURATION),
  /** Original-clip audio level, 0 = mute. Music bed usually wins. */
  volume: z.number().min(0).max(2).default(1),
  muted: z.boolean().default(false),
  titles: z.array(titleOverlaySchema).default([]),
});
export type Clip = z.infer<typeof clipSchema>;

export const audioTrackSchema = z.object({
  /** Points at a music_items row (YouTube/Spotify/Deezer) ... */
  musicItemId: z.string().uuid().nullable().default(null),
  /** ... or at an uploaded audio media_items row. Uploads win if both set. */
  mediaItemId: z.string().uuid().nullable().default(null),
  /** Seconds into the audio file where playback begins. */
  offset: z.number().min(0).default(0),
  /** Seconds into the finished video where this track starts. */
  startAt: z.number().min(0).default(0),
  volume: z.number().min(0).max(2).default(0.8),
  fadeIn: z.number().min(0).default(1),
  fadeOut: z.number().min(0).default(2),
});
export type AudioTrack = z.infer<typeof audioTrackSchema>;

export const timelineDocSchema = z.object({
  version: z.literal(1).default(1),
  clips: z.array(clipSchema).default([]),
  audio: z.array(audioTrackSchema).default([]),
  /** Ducks original clip audio while a music track plays. */
  duckClipAudio: z.boolean().default(true),
  updatedAt: z.string().datetime().optional(),
});
export type TimelineDoc = z.infer<typeof timelineDocSchema>;

export function emptyTimeline(): TimelineDoc {
  return timelineDocSchema.parse({ version: 1, clips: [], audio: [] });
}

/** Effective on-screen duration of a clip, accounting for trims. */
export function clipDuration(clip: Clip, sourceDuration?: number | null): number {
  if (clip.kind === "photo") return clip.duration;
  const end = clip.trimEnd ?? sourceDuration ?? null;
  if (end === null) return clip.duration;
  return Math.max(0.05, end - clip.trimStart);
}

/**
 * Total video length. Crossfades overlap, so each one shortens the result by
 * its own duration.
 */
export function timelineDuration(
  timeline: TimelineDoc,
  durations: Record<string, number | null | undefined> = {},
): number {
  let total = 0;
  timeline.clips.forEach((clip, index) => {
    total += clipDuration(clip, durations[clip.mediaItemId]);
    if (index > 0 && clip.transitionIn === "crossfade") {
      total -= Math.min(clip.transitionDuration, total);
    }
  });
  return Math.max(0, total);
}

/** Absolute start time of each clip, keyed by clip id. */
export function clipStartTimes(
  timeline: TimelineDoc,
  durations: Record<string, number | null | undefined> = {},
): Record<string, number> {
  const starts: Record<string, number> = {};
  let cursor = 0;
  timeline.clips.forEach((clip, index) => {
    if (index > 0 && clip.transitionIn === "crossfade") {
      cursor -= Math.min(clip.transitionDuration, cursor);
    }
    starts[clip.id] = cursor;
    cursor += clipDuration(clip, durations[clip.mediaItemId]);
  });
  return starts;
}

// --- Editor operations ------------------------------------------------------
// Broadcast over Socket.IO. The server applies them to the stored doc and
// rebroadcasts, so everyone converges (last-writer-wins per element in v1).

export const timelineOpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("clip.add"), clip: clipSchema, index: z.number().int().min(0).optional() }),
  z.object({ type: z.literal("clip.remove"), clipId: z.string() }),
  z.object({ type: z.literal("clip.move"), clipId: z.string(), toIndex: z.number().int().min(0) }),
  z.object({ type: z.literal("clip.update"), clipId: z.string(), patch: clipSchema.partial().omit({ id: true }) }),
  z.object({ type: z.literal("title.add"), clipId: z.string(), title: titleOverlaySchema }),
  z.object({ type: z.literal("title.remove"), clipId: z.string(), titleId: z.string() }),
  z.object({
    type: z.literal("title.update"),
    clipId: z.string(),
    titleId: z.string(),
    patch: titleOverlaySchema.partial().omit({ id: true }),
  }),
  z.object({ type: z.literal("audio.set"), index: z.number().int().min(0), track: audioTrackSchema }),
  z.object({ type: z.literal("audio.remove"), index: z.number().int().min(0) }),
  z.object({ type: z.literal("settings.update"), patch: z.object({ duckClipAudio: z.boolean().optional() }) }),
  z.object({ type: z.literal("timeline.replace"), timeline: timelineDocSchema }),
]);
export type TimelineOp = z.infer<typeof timelineOpSchema>;

/** Pure reducer — same logic runs on the server and optimistically on clients. */
export function applyTimelineOp(doc: TimelineDoc, op: TimelineOp): TimelineDoc {
  const next: TimelineDoc = {
    ...doc,
    clips: doc.clips.map((c) => ({ ...c, titles: [...c.titles] })),
    audio: [...doc.audio],
  };

  switch (op.type) {
    case "clip.add": {
      const index = op.index ?? next.clips.length;
      next.clips.splice(Math.min(index, next.clips.length), 0, op.clip);
      break;
    }
    case "clip.remove": {
      next.clips = next.clips.filter((c) => c.id !== op.clipId);
      break;
    }
    case "clip.move": {
      const from = next.clips.findIndex((c) => c.id === op.clipId);
      if (from === -1) break;
      const [clip] = next.clips.splice(from, 1);
      next.clips.splice(Math.max(0, Math.min(op.toIndex, next.clips.length)), 0, clip);
      break;
    }
    case "clip.update": {
      next.clips = next.clips.map((c) => (c.id === op.clipId ? { ...c, ...op.patch } : c));
      break;
    }
    case "title.add": {
      next.clips = next.clips.map((c) =>
        c.id === op.clipId ? { ...c, titles: [...c.titles, op.title] } : c,
      );
      break;
    }
    case "title.remove": {
      next.clips = next.clips.map((c) =>
        c.id === op.clipId ? { ...c, titles: c.titles.filter((t) => t.id !== op.titleId) } : c,
      );
      break;
    }
    case "title.update": {
      next.clips = next.clips.map((c) =>
        c.id === op.clipId
          ? {
              ...c,
              titles: c.titles.map((t) => (t.id === op.titleId ? { ...t, ...op.patch } : t)),
            }
          : c,
      );
      break;
    }
    case "audio.set": {
      if (op.index >= next.audio.length) next.audio.push(op.track);
      else next.audio[op.index] = op.track;
      break;
    }
    case "audio.remove": {
      next.audio.splice(op.index, 1);
      break;
    }
    case "settings.update": {
      if (op.patch.duckClipAudio !== undefined) next.duckClipAudio = op.patch.duckClipAudio;
      break;
    }
    case "timeline.replace": {
      return { ...op.timeline, updatedAt: new Date().toISOString() };
    }
  }

  next.updatedAt = new Date().toISOString();
  return next;
}
