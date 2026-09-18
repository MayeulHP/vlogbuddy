import { z } from "zod";
import {
  AUTO_FIELDS,
  DEFAULT_BED_DUCK,
  DEFAULT_PHOTO_DURATION,
  DEFAULT_TRANSITION_DURATION,
  MAX_SPEED,
  MIN_SPEED,
  MOTIONS,
  PACE_PRESETS,
  SCENE_AUTO_FIELDS,
  TRANSITION_MAX_SHARE,
  TRANSITIONS,
  overlapsPrevious,
  type AutoField,
  type SceneAutoField,
} from "./constants";

/**
 * The timeline document: the single authoritative description of the final cut.
 *
 * Three kinds of thing live on it:
 *
 *   - `clips` — the base video track. Owned by the cut engine: the vote decides
 *     what's in it and in what order, so it's a sequence, not free-floating.
 *   - `layers` — video and stills composited *over* the base track, each pinned
 *     to an absolute time and a rectangle in the frame. Hand-placed, never
 *     touched by the vote.
 *   - `audio` — a stack of audio tracks mixed under the whole thing, each with
 *     its own in-point, level and fades. One of them is the `bed` the cut
 *     engine keeps in step with the soundtrack lane; the rest are hand-placed.
 *   - `scenes` — the stretches of trip the base track breaks into. Derived from
 *     the capture times, but *stored*, because the name of one is a person's to
 *     change and a derived name would forget it on the next vote.
 *
 * The base track sets the running time. Layers and audio are clipped to it —
 * nothing hanging off the end of the picture can make the film longer.
 *
 * It is mutated only through `TimelineOp` values fed to `applyTimelineOp`,
 * which runs optimistically in the browser, authoritatively in the socket
 * handler, and again in server actions. The worker compiles the result into an
 * FFmpeg filter graph.
 */

export const transitionSchema = z.enum(TRANSITIONS);
export const motionSchema = z.enum(MOTIONS);

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

/**
 * Which of a clip's decisions the auto-cut still owns.
 *
 * The moment somebody trims a shot by hand, `"timing"` comes off and no
 * re-cut will ever touch that shot's length again. Documents written before
 * the auto-cut existed parse with an empty array, which is exactly right:
 * nothing in them was ever a machine's decision.
 */
export const autoFieldSchema = z.enum(AUTO_FIELDS);

export const directorSettingsSchema = z.object({
  /**
   * Off to begin with, and relaxed when it's switched on.
   *
   * A film that arrives at the lengths people actually filmed is the honest
   * starting point: nothing has been taken away before anyone has looked at
   * it. Turning the auto-cut on is then a thing the crew chooses once they
   * want the pile tightened, rather than a thing they discover has already
   * happened to their forty-second shot.
   */
  enabled: z.boolean().default(false),
  pace: z.enum(PACE_PRESETS).default("relaxed"),
  /** Burn the scene name over the first shot of each scene. */
  sceneText: z.boolean().default(false),
  /**
   * Round each cut off to the nearest beat of the music bed, where the worker
   * managed to measure one. Off by default: it only does anything once a
   * track has been analysed, and a cut that suddenly retimes itself when
   * somebody drops in music is a surprise nobody asked for.
   */
  beatSnap: z.boolean().default(false),
});
export type DirectorSettings = z.infer<typeof directorSettingsSchema>;

export const sceneAutoFieldSchema = z.enum(SCENE_AUTO_FIELDS);

/**
 * A stretch of the trip shot in one sitting: the run of shots between two long
 * gaps in the capture times, and the thing the dissolve in the finished cut is
 * announcing the end of.
 *
 * Stored rather than worked out afresh on every read, because the name is only
 * a first guess. The auto-cut proposes "Tuesday morning" off a timestamp;
 * somebody who was there calls it "the walk up to the hut", and that has to
 * outlive every vote cast afterwards.
 *
 * Which shots are in it stays derived — that's the camera's word rather than
 * anyone's opinion — so the name is the only thing here a person owns.
 */
export const sceneSchema = z.object({
  id: z.string(),
  /** Empty when nothing in the scene knows when it was taken. */
  name: z.string().max(80).default(""),
  /** Epoch ms of the first shot in it with a capture time; where the guess came from. */
  startedAt: z.number().nullable().default(null),
  /** True when this scene opens a day the one before it didn't. */
  newDay: z.boolean().default(false),
  /** Decisions still owned by the auto-cut. See `SCENE_AUTO_FIELDS`. */
  auto: z.array(sceneAutoFieldSchema).default([]),
});
export type Scene = z.infer<typeof sceneSchema>;

/** Drops the flag a rename has just overruled. Same object if it was already off. */
export function clearSceneAutoFor(scene: Scene, field: SceneAutoField): Scene {
  if (!scene.auto.includes(field)) return scene;
  return { ...scene, auto: scene.auto.filter((f) => f !== field) };
}

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
  /**
   * Photos only: the slow push or pull that keeps a still alive. Videos carry
   * their own movement, so the field is ignored for them rather than forbidden
   * — a photo swapped for a video shouldn't fail to parse.
   */
  motion: motionSchema.default("none"),
  /**
   * Videos only. 1 is real time, 2 is double speed, 0.5 is half. It divides
   * the clip's on-screen length, which is why `clipDuration` is the single
   * place it's applied — every timing helper in the app derives from that one
   * function, and a second opinion about it would desynchronise the lot.
   */
  speed: z.number().min(MIN_SPEED).max(MAX_SPEED).default(1),
  /**
   * The grade. Neutral by default, and every value is compared against its
   * neutral before a filter is emitted, so an untouched clip compiles to
   * exactly the chain it compiled to before any of this existed.
   */
  brightness: z.number().min(-1).max(1).default(0),
  contrast: z.number().min(0).max(3).default(1),
  saturation: z.number().min(0).max(3).default(1),
  hue: z.number().min(-180).max(180).default(0),
  blur: z.number().min(0).max(20).default(0),
  /** Original-clip audio level, 0 = mute. Music bed usually wins. */
  volume: z.number().min(0).max(2).default(1),
  muted: z.boolean().default(false),
  /**
   * Does this shot push the score down while it plays? On by default, because
   * the usual reason a shot has sound is that somebody is talking. The way out
   * is for the shots where that isn't true — wind, traffic, a crowd — which
   * would otherwise hold the music flat for their whole length.
   *
   * A silent or muted shot ducks nothing whatever this says: the duck is keyed
   * off the audio itself, so there's nothing to open it.
   */
  duckMusic: z.boolean().default(true),
  titles: z.array(titleOverlaySchema).default([]),
  /**
   * Which scene this shot is part of (`TimelineDoc.scenes`).
   *
   * An id rather than the scene carrying a range of positions: a range means
   * the wrong thing the instant anybody drags a shot somewhere else, and
   * reconciling the cut already works by following media from one running
   * order to the next. Null on a shot the auto-cut has never had a say over.
   */
  sceneId: z.string().nullable().default(null),
  /** Decisions still owned by the auto-cut. See `autoFieldSchema`. */
  auto: z.array(autoFieldSchema).default([]),
});
export type Clip = z.infer<typeof clipSchema>;

/**
 * Which auto-cut decision each clip field belongs to. Typed as a total map so
 * that adding a field to `clipSchema` fails the typecheck until somebody says
 * whether the auto-cut is allowed to set it.
 */
export const AUTO_FIELD_FOR: Record<keyof Omit<Clip, "id" | "auto">, AutoField | null> = {
  mediaItemId: null,
  kind: null,
  trimStart: "timing",
  trimEnd: "timing",
  duration: "timing",
  transitionIn: "transition",
  transitionDuration: "transition",
  motion: "motion",
  // The auto-cut never sets a speed, but retiming a shot by hand is a timing
  // decision in every sense that matters: if it kept re-trimming afterwards
  // it would be fighting the person who slowed the shot down.
  speed: "timing",
  brightness: null,
  contrast: null,
  saturation: null,
  hue: null,
  blur: null,
  volume: "audio",
  muted: "audio",
  // Deliberately nobody's: the auto-cut has no opinion about the score, and
  // filing it under "audio" would mean that saying "let the music ride over
  // this one" also froze the director's decision about whether the shot is
  // heard at all — two unrelated questions, one flag.
  duckMusic: null,
  titles: "title",
  // Nobody's, because there is no hand edit for it to lose to: scene breaks
  // come off the capture times, and `clip.update` doesn't carry the field at
  // all. The auto-cut writes it as bookkeeping whenever it still has any say
  // over the shot, and a shot handed back entirely keeps the scene it was in.
  sceneId: null,
};

/** Drops the flags a patch has just overruled. Same object if none applied. */
export function clearAutoFor(clip: Clip, patched: readonly string[]): Clip {
  if (clip.auto.length === 0) return clip;
  const lost = new Set<AutoField>();
  for (const key of patched) {
    const field = AUTO_FIELD_FOR[key as keyof typeof AUTO_FIELD_FOR];
    if (field) lost.add(field);
  }
  if (lost.size === 0) return clip;
  const auto = clip.auto.filter((f) => !lost.has(f));
  return auto.length === clip.auto.length ? clip : { ...clip, auto };
}

/** How many video layers can sit over the base track. */
export const MAX_LAYERS = 4;

/**
 * A picture layer: a photo or a stretch of video composited over the base
 * track — a reaction shot in the corner, a map, a full-frame flash of
 * something.
 *
 * Geometry is stored as fractions of the frame rather than pixels, so a
 * timeline laid out against the 720p preview renders identically at 1080p.
 */
export const layerClipSchema = z.object({
  id: z.string(),
  mediaItemId: z.string().uuid(),
  kind: z.enum(["photo", "video"]),
  /** Stacking order. The base track is 0; higher numbers sit on top. */
  layer: z.number().int().min(1).max(MAX_LAYERS).default(1),
  /** Seconds into the finished film where this layer appears. */
  startAt: z.number().min(0).default(0),
  /** Seconds into the source file where playback begins. Photos ignore it. */
  trimStart: z.number().min(0).default(0),
  /** How long it stays on screen. */
  duration: z.number().positive().default(3),
  /** Top-left corner, as a fraction of the frame. */
  x: z.number().min(0).max(1).default(0.62),
  y: z.number().min(0).max(1).default(0.06),
  /** Width as a fraction of the frame; height follows the source aspect. */
  width: z.number().min(0.05).max(1).default(0.32),
  opacity: z.number().min(0).max(1).default(1),
  fadeIn: z.number().min(0).max(5).default(0.3),
  fadeOut: z.number().min(0).max(5).default(0.3),
  /** Layer audio is off by default — a corner inset shouldn't shout. */
  volume: z.number().min(0).max(2).default(1),
  muted: z.boolean().default(true),
});
export type LayerClip = z.infer<typeof layerClipSchema>;

export const audioTrackSchema = z.object({
  id: z.string().default(() => globalThis.crypto.randomUUID()),
  /**
   * The bed is the cut engine's track — it follows whatever the soundtrack
   * lane picked. Everything else is hand-placed and left alone.
   */
  role: z.enum(["bed", "extra"]).default("bed"),
  /** Points at a music_items row (YouTube/Spotify/Deezer) ... */
  musicItemId: z.string().uuid().nullable().default(null),
  /** ... or at an uploaded audio media_items row. Uploads win if both set. */
  mediaItemId: z.string().uuid().nullable().default(null),
  /** Seconds into the audio file where playback begins. */
  offset: z.number().min(0).default(0),
  /** Seconds into the finished video where this track starts. */
  startAt: z.number().min(0).default(0),
  /** How long it plays for; null runs it to the end of the picture. */
  duration: z.number().positive().nullable().default(null),
  volume: z.number().min(0).max(2).default(0.8),
  /**
   * How far this track drops while the shots have sound of their own — 0 leaves
   * it sitting where the level says, 1 buries it under a voice.
   *
   * It lives on the track being ducked rather than on each shot because that's
   * the thing the depth is a property of: one dial for "how much does my music
   * get out of the way", not a dial per shot that only means anything relative
   * to the bed's level. Shots opt *out* (`Clip.duckMusic`); they don't each
   * carry their own amount.
   */
  duck: z.number().min(0).max(1).default(DEFAULT_BED_DUCK),
  fadeIn: z.number().min(0).default(1),
  fadeOut: z.number().min(0).default(2),
  muted: z.boolean().default(false),
  /** Repeat a short track instead of letting it run out. */
  loop: z.boolean().default(false),
});
export type AudioTrack = z.infer<typeof audioTrackSchema>;

export const timelineDocSchema = z.object({
  /** 1 was single-track; 2 added layers and the audio stack. */
  version: z.union([z.literal(1), z.literal(2)]).default(2),
  clips: z.array(clipSchema).default([]),
  layers: z.array(layerClipSchema).default([]),
  audio: z.array(audioTrackSchema).default([]),
  /**
   * The stretches of trip the base track breaks into, in running order. The
   * auto-cut owns the list — it detects the breaks and reconciles them against
   * what's here — and a person owns the names.
   */
  scenes: z.array(sceneSchema).default([]),
  /**
   * The master switch for ducking: off, and the music sits at its own level
   * whatever the shots are doing. How *far* it ducks is per-track
   * (`AudioTrack.duck`), and which shots push it down is per-clip
   * (`Clip.duckMusic`).
   *
   * The name is a fossil — it used to attenuate the shots rather than the
   * score — and it keeps it because it's a key in stored jsonb: renaming means
   * a shim in `normalizeTimeline` for a word nobody sees.
   */
  duckClipAudio: z.boolean().default(true),
  /** How the auto-cut paces the base track. */
  director: directorSettingsSchema.default({}),
  updatedAt: z.string().datetime().optional(),
});
export type TimelineDoc = z.infer<typeof timelineDocSchema>;

export function emptyTimeline(): TimelineDoc {
  return timelineDocSchema.parse({ version: 2, clips: [], layers: [], audio: [] });
}

/**
 * Brings a stored document up to the current shape.
 *
 * Documents written before multi-track have no `layers` and their audio tracks
 * have no ids — the schema's defaults fill both in. Every read of
 * `timelines.doc` goes through here, because the column is typed but not
 * validated and the rest of the code assumes the arrays exist.
 *
 * Documents written before scenes come back with none, and this deliberately
 * doesn't invent them: the breaks are read off capture times, which aren't in
 * the document. The cut engine fills them in on the next sync — and for a film
 * whose every shot has been cut by hand it never will, which is the right
 * answer. A document that took the auto-cut's flags away is not asking for a
 * fresh opinion about where its days begin.
 */
export function normalizeTimeline(doc: unknown): TimelineDoc {
  const parsed = timelineDocSchema.parse(doc);
  return parsed.version === 2 ? parsed : { ...parsed, version: 2 };
}

/** A clip's speed, which only ever means anything for video. */
export function clipSpeed(clip: Clip): number {
  return clip.kind === "photo" ? 1 : clip.speed;
}

/**
 * How many seconds of the *source* a clip consumes — its length before speed
 * is applied. This is what the trim window measures and what FFmpeg has to be
 * told to read; `clipDuration` is what the audience experiences.
 */
export function clipSourceSpan(clip: Clip, sourceDuration?: number | null): number {
  if (clip.kind === "photo") return clip.duration;
  const end = clip.trimEnd ?? sourceDuration ?? null;
  if (end === null) return clip.duration;
  return Math.max(0.05, end - clip.trimStart);
}

/**
 * Effective on-screen duration of a clip, accounting for trims and speed.
 *
 * The one place speed is divided out. Rounded to 3dp, and only when a speed is
 * actually set, so that a clip nobody has retimed returns the identical number
 * it always did — the auto-cut compares documents by value to decide whether
 * to write, and a float that won't round-trip through jsonb would churn a
 * revision on every vote forever.
 */
export function clipDuration(clip: Clip, sourceDuration?: number | null): number {
  const span = clipSourceSpan(clip, sourceDuration);
  const speed = clipSpeed(clip);
  if (speed === 1) return span;
  return Math.max(0.05, Math.round((span / speed) * 1000) / 1000);
}

/** Does this clip ask for anything the plain normalise chain doesn't do? */
export function isGraded(clip: Clip): boolean {
  return (
    clip.brightness !== 0 ||
    clip.contrast !== 1 ||
    clip.saturation !== 1 ||
    clip.hue !== 0 ||
    clip.blur > 0
  );
}

/**
 * How far a clip's transition pulls it back over the one before it.
 *
 * The single opinion on the subject. `transitionDuration` is what the clip
 * *asks* for; this is what it actually gets, because a fade can be no longer
 * than the shot it fades into (`TRANSITION_MAX_SHARE`) nor than the film that
 * exists in front of it. The renderer, the bench and the preview all ask here
 * — they used to clamp separately and disagreed about the running time of any
 * shot briefer than its own dissolve.
 *
 * `available` is how much timeline precedes this clip; the first one has none
 * and so overlaps nothing.
 */
export function transitionOverlap(clip: Clip, clipLength: number, available: number): number {
  if (!overlapsPrevious(clip.transitionIn)) return 0;
  return Math.max(
    0,
    Math.min(clip.transitionDuration, clipLength * TRANSITION_MAX_SHARE, available),
  );
}

/**
 * Total video length — the base track's, since layers and audio are clipped to
 * the picture. Crossfades overlap, so each one shortens the result by however
 * much of it `transitionOverlap` allows.
 */
export function timelineDuration(
  timeline: TimelineDoc,
  durations: Record<string, number | null | undefined> = {},
): number {
  let total = 0;
  timeline.clips.forEach((clip, index) => {
    const length = clipDuration(clip, durations[clip.mediaItemId]);
    if (index > 0) total -= transitionOverlap(clip, length, total);
    total += length;
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
    const length = clipDuration(clip, durations[clip.mediaItemId]);
    if (index > 0) cursor -= transitionOverlap(clip, length, cursor);
    starts[clip.id] = cursor;
    cursor += length;
  });
  return starts;
}

/** How long an audio track actually sounds for, clipped to the picture. */
export function audioTrackSpan(track: AudioTrack, videoLength: number): number {
  const available = Math.max(0, videoLength - track.startAt);
  if (track.duration === null) return available;
  return Math.max(0, Math.min(track.duration, available));
}

/** A layer's visible window, clipped to the picture. */
export function layerWindow(
  layer: LayerClip,
  videoLength: number,
): { start: number; end: number; duration: number } {
  const start = Math.min(layer.startAt, videoLength);
  const end = Math.min(layer.startAt + layer.duration, videoLength);
  return { start, end, duration: Math.max(0, end - start) };
}

/** Layers in paint order: lowest stacking level first, ties broken by time. */
export function layersInPaintOrder(timeline: TimelineDoc): LayerClip[] {
  return [...timeline.layers].sort((a, b) => a.layer - b.layer || a.startAt - b.startAt);
}

export function defaultLayerFor(
  entry: { mediaItemId: string; kind: "photo" | "video"; durationSeconds: number | null },
  startAt: number,
  layer = 1,
): LayerClip {
  return layerClipSchema.parse({
    id: globalThis.crypto.randomUUID(),
    mediaItemId: entry.mediaItemId,
    kind: entry.kind,
    layer,
    startAt: Math.max(0, startAt),
    duration:
      entry.kind === "video"
        ? Math.min(entry.durationSeconds ?? 4, 8)
        : DEFAULT_PHOTO_DURATION,
  });
}

export function defaultAudioTrack(
  ref: { musicItemId?: string | null; mediaItemId?: string | null },
  startAt = 0,
): AudioTrack {
  return audioTrackSchema.parse({
    role: "extra",
    musicItemId: ref.musicItemId ?? null,
    mediaItemId: ref.mediaItemId ?? null,
    startAt: Math.max(0, startAt),
    volume: 0.8,
    fadeIn: 0.5,
    fadeOut: 1,
  });
}

/**
 * Drops anything pointing at media or music that no longer exists — a layer
 * over a deleted photo, a stray track for a swept upload. Returns the *same
 * object* when nothing needed dropping.
 */
export function pruneTimelineReferences(
  doc: TimelineDoc,
  valid: { mediaIds: Set<string>; musicIds: Set<string> },
): TimelineDoc {
  const layers = doc.layers.filter((l) => valid.mediaIds.has(l.mediaItemId));
  const audio = doc.audio.filter((t) => {
    if (t.mediaItemId) return valid.mediaIds.has(t.mediaItemId);
    if (t.musicItemId) return valid.musicIds.has(t.musicItemId);
    // A track pointing at nothing is the empty bed; the cut engine owns it.
    return true;
  });

  if (layers.length === doc.layers.length && audio.length === doc.audio.length) return doc;
  return { ...doc, layers, audio, updatedAt: new Date().toISOString() };
}

/**
 * The cut, as decided on the Gather page: which media are in, and in what
 * order. Reconciling turns that list into clips without throwing away work —
 * a clip that survives keeps its trims, titles, volume and transition.
 *
 * Built in `syncCut` from the media rows and read by the auto-cut, and it goes
 * nowhere else: no component renders one, no server action returns one and no
 * socket payload carries one. That's what makes it safe to put the columns
 * below on it.
 */
export interface CutEntry {
  mediaItemId: string;
  kind: "photo" | "video";
  durationSeconds: number | null;
  /**
   * Capture time as epoch milliseconds rather than a `Date`, because the
   * auto-cut subtracts and compares these and two `Date`s for one instant are
   * never equal.
   */
  capturedAt: number | null;
  /**
   * Where it was taken, decimal degrees, WGS 84 — null for the very common
   * case of a file with no GPS block. The auto-cut breaks a scene when these
   * say the crew has moved on.
   *
   * **These must not reach a browser.** `MediaItemView` drops the same two
   * columns off the row it serialises into the page for every member; this
   * type is the server-side path that still needs them, and it stays one.
   */
  latitude: number | null;
  longitude: number | null;
  /** The crew's `rankScore` for this item — what the auto-cut budgets from. */
  rank: number;
}

export function defaultClipFor(entry: CutEntry): Clip {
  const isVideo = entry.kind === "video";
  return {
    id: globalThis.crypto.randomUUID(),
    mediaItemId: entry.mediaItemId,
    kind: entry.kind,
    trimStart: 0,
    trimEnd: isVideo ? entry.durationSeconds : null,
    duration: isVideo ? entry.durationSeconds ?? 5 : DEFAULT_PHOTO_DURATION,
    transitionIn: "cut",
    transitionDuration: DEFAULT_TRANSITION_DURATION,
    motion: "none",
    speed: 1,
    brightness: 0,
    contrast: 1,
    saturation: 1,
    hue: 0,
    blur: 0,
    volume: 1,
    muted: false,
    duckMusic: true,
    titles: [],
    // Filled in by the auto-cut's scene pass, which runs right after this.
    sceneId: null,
    // A clip arriving from the vote is entirely the auto-cut's to shape, until
    // somebody on the bench says otherwise.
    auto: [...AUTO_FIELDS],
  };
}

/**
 * Rebuilds `clips` to match `cut`, reusing the existing clip for any media that
 * is still in. Returns the *same object* when nothing would change, so callers
 * can skip a write and avoid churning revisions on every vote.
 *
 * Only the base track is reconciled — the same photo can be in the cut *and*
 * pinned over a later shot as a layer, and the vote has no opinion about the
 * second one.
 */
export function reconcileClips(doc: TimelineDoc, cut: CutEntry[]): TimelineDoc {
  const existing = new Map<string, Clip>();
  for (const clip of doc.clips) {
    if (!existing.has(clip.mediaItemId)) existing.set(clip.mediaItemId, clip);
  }

  const clips = cut.map((entry) => existing.get(entry.mediaItemId) ?? defaultClipFor(entry));

  const unchanged =
    clips.length === doc.clips.length && clips.every((clip, i) => clip === doc.clips[i]);
  if (unchanged) return doc;

  return { ...doc, clips, updatedAt: new Date().toISOString() };
}

// --- Editor operations ------------------------------------------------------
// Broadcast over Socket.IO. The server applies them to the stored doc and
// rebroadcasts, so everyone converges (last-writer-wins per element in v1).

export const timelineOpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("clip.add"), clip: clipSchema, index: z.number().int().min(0).optional() }),
  z.object({ type: z.literal("clip.remove"), clipId: z.string() }),
  z.object({ type: z.literal("clip.move"), clipId: z.string(), toIndex: z.number().int().min(0) }),
  // `sceneId` is off the patch on purpose: it isn't an editorial decision, it's
  // where the auto-cut filed the shot, and the only thing a person changes
  // about a scene is what it's called.
  z.object({ type: z.literal("clip.update"), clipId: z.string(), patch: clipSchema.partial().omit({ id: true, sceneId: true }) }),
  z.object({ type: z.literal("title.add"), clipId: z.string(), title: titleOverlaySchema }),
  z.object({ type: z.literal("title.remove"), clipId: z.string(), titleId: z.string() }),
  z.object({
    type: z.literal("title.update"),
    clipId: z.string(),
    titleId: z.string(),
    patch: titleOverlaySchema.partial().omit({ id: true }),
  }),
  z.object({ type: z.literal("layer.add"), layer: layerClipSchema }),
  z.object({ type: z.literal("layer.remove"), layerId: z.string() }),
  z.object({
    type: z.literal("layer.update"),
    layerId: z.string(),
    patch: layerClipSchema.partial().omit({ id: true }),
  }),
  z.object({ type: z.literal("audio.add"), track: audioTrackSchema }),
  z.object({
    type: z.literal("audio.update"),
    trackId: z.string(),
    patch: audioTrackSchema.partial().omit({ id: true }),
  }),
  z.object({ type: z.literal("audio.remove"), trackId: z.string() }),
  z.object({
    type: z.literal("settings.update"),
    patch: z.object({
      duckClipAudio: z.boolean().optional(),
      director: directorSettingsSchema.partial().optional(),
    }),
  }),
  /**
   * Rename a scene.
   *
   * Its own op rather than a generic `scene.update` carrying a partial patch —
   * which is how per-clip fields ride `clip.update` — because a scene has
   * exactly one field a person owns. Everything else on it (where it starts,
   * whether it opens a new day, whether the auto-cut still names it) is the
   * director's bookkeeping, and a patch op would hand a client the `auto` array
   * that this very op exists to clear.
   */
  z.object({
    type: z.literal("scene.rename"),
    sceneId: z.string(),
    name: z.string().trim().min(1).max(80),
  }),
  /**
   * Hand every clip back to the auto-cut. Destructive of hand work by design —
   * it's the "start again" button — which is also why it's an op rather than a
   * document write: it converges to every open browser like any other edit.
   */
  z.object({ type: z.literal("director.recut") }),
]);
export type TimelineOp = z.infer<typeof timelineOpSchema>;

/** Pure reducer — same logic runs on the server and optimistically on clients. */
export function applyTimelineOp(doc: TimelineDoc, op: TimelineOp): TimelineDoc {
  const next: TimelineDoc = {
    ...doc,
    clips: doc.clips.map((c) => ({ ...c, titles: [...c.titles] })),
    layers: [...doc.layers],
    audio: [...doc.audio],
    scenes: [...doc.scenes],
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
      const patched = Object.keys(op.patch);
      next.clips = next.clips.map((c) =>
        c.id === op.clipId ? clearAutoFor({ ...c, ...op.patch }, patched) : c,
      );
      break;
    }
    case "title.add": {
      next.clips = next.clips.map((c) =>
        c.id === op.clipId
          ? clearAutoFor({ ...c, titles: [...c.titles, op.title] }, ["titles"])
          : c,
      );
      break;
    }
    case "title.remove": {
      next.clips = next.clips.map((c) =>
        c.id === op.clipId
          ? clearAutoFor({ ...c, titles: c.titles.filter((t) => t.id !== op.titleId) }, ["titles"])
          : c,
      );
      break;
    }
    case "title.update": {
      next.clips = next.clips.map((c) =>
        c.id === op.clipId
          ? clearAutoFor(
              {
                ...c,
                titles: c.titles.map((t) => (t.id === op.titleId ? { ...t, ...op.patch } : t)),
              },
              ["titles"],
            )
          : c,
      );
      break;
    }
    case "layer.add": {
      if (next.layers.length >= 64) break; // a runaway client can't grow the doc without bound
      next.layers.push(op.layer);
      break;
    }
    case "layer.remove": {
      next.layers = next.layers.filter((l) => l.id !== op.layerId);
      break;
    }
    case "layer.update": {
      next.layers = next.layers.map((l) => (l.id === op.layerId ? { ...l, ...op.patch } : l));
      break;
    }
    case "audio.add": {
      if (next.audio.length >= 16) break;
      next.audio.push(op.track);
      break;
    }
    case "audio.update": {
      next.audio = next.audio.map((t) => (t.id === op.trackId ? { ...t, ...op.patch } : t));
      break;
    }
    case "audio.remove": {
      next.audio = next.audio.filter((t) => t.id !== op.trackId);
      break;
    }
    case "settings.update": {
      if (op.patch.duckClipAudio !== undefined) next.duckClipAudio = op.patch.duckClipAudio;
      if (op.patch.director) next.director = { ...next.director, ...op.patch.director };
      break;
    }
    case "scene.rename": {
      next.scenes = next.scenes.map((s) =>
        s.id === op.sceneId ? clearSceneAutoFor({ ...s, name: op.name }, "name") : s,
      );
      break;
    }
    case "director.recut": {
      next.clips = next.clips.map((c) => ({ ...c, auto: [...AUTO_FIELDS] }));
      // Scene names go back in the pot with everything else — this is the only
      // way a name somebody typed is ever taken off the document.
      next.scenes = next.scenes.map((s) => ({ ...s, auto: [...SCENE_AUTO_FIELDS] }));
      break;
    }
  }

  next.updatedAt = new Date().toISOString();
  return next;
}
