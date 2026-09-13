import {
  AUTO_FIELDS,
  DEFAULT_TRANSITION_DURATION,
  overlapsPrevious,
  type Pace,
} from "./constants";
import type { Transition } from "./constants";
import { clipDuration } from "./timeline";
import type { Clip, CutEntry, DirectorSettings, TimelineDoc, TitleOverlay } from "./timeline";

/**
 * The auto-cut: the opinion that turns a pile of phone footage into something
 * shaped like a film.
 *
 * The vote decides *what* is in the cut and in what order. This decides *how*
 * it plays — how long each shot holds, where the dissolves go, which snatches
 * of ambience are too short to be worth hearing. Without it the default
 * timeline is a concatenation: every video at full length, every still held
 * for a flat three seconds, hard cuts throughout. Twenty clips off a weekend
 * become twenty-five minutes nobody watches.
 *
 * Three rules from the cutting room, and one from the data:
 *
 *   - Screen time is a *budget*, not whatever the camera happened to record.
 *     A shot earns its length from the crew's marks, and gives it back when it
 *     stops earning it.
 *   - Cut within a scene, dissolve between them. A dissolve has meant "time
 *     passed" since the 1920s, and capture timestamps hand us the scene breaks
 *     for free.
 *   - Vary the rhythm. Shots of identical length read as a slideshow.
 *   - Cut on the beat, when there is one. The music bed's measured beats are a
 *     grid the budgeted lengths are *rounded off to* — a quarter of a shot's
 *     length at most, so the marks still decide how long it holds and the
 *     music only decides exactly where the cut falls.
 *   - And: never overrule a person. Every value here is written only while the
 *     matching `auto` flag is still on the clip.
 *
 * Everything in this file is a pure function of its arguments — no `Date.now`,
 * no `Math.random`, no clock, no I/O. `syncCut` calls it after every vote and
 * relies on it returning the *identical object* when nothing moved; a single
 * stray non-determinism here would churn a timeline revision on every reaction
 * and yank the document out from under whoever is editing.
 */

// --- The opinion, in numbers ------------------------------------------------
// These are deliberately not settings. The pace preset is the only knob; the
// rest is the film-making judgement that makes this feature worth having.

/** A capture gap this long means the crew went and did something else. */
const SCENE_GAP_MS = 20 * 60 * 1000;

/** Base screen time in seconds, per pace, per tier of the crew's marks. */
const BUDGET: Record<Pace, Record<RankTier, number>> = {
  snappy: { keep: 1.8, strong: 2.8, hero: 4.5 },
  standard: { keep: 2.6, strong: 4.0, hero: 6.5 },
  relaxed: { keep: 3.8, strong: 5.5, hero: 9.0 },
};

/** Stills read fast, and we have no Ken Burns — a long static frame is dead. */
const PHOTO_FACTOR = 0.75;
const PHOTO_MAX = 4;

const MIN_HOLD = 1.2;
const MAX_HOLD = 12;

/** The last shot gets a beat to land on. */
const LAST_CLIP_BONUS = 0.7;

/** ±12%, so the cut has a pulse instead of a metronome. */
const JITTER = 0.12;

/** People raise the phone, then start recording. And lower it after. */
const HEAD_TRIM = 0.8;
const TAIL_TRIM = 1.2;
const TRIM_FRACTION = 0.15;

/**
 * Where in the usable span to take the window from. Just before the middle:
 * the subject usually does the thing shortly after the frame settles, and the
 * tail is where someone is walking back to stop the recording.
 */
const WINDOW_CENTRE = 0.45;

/**
 * How far a cut may slide to land on a beat: a quarter of the budgeted hold,
 * and never more than two thirds of a second. The beat grid *quantises* the
 * budget the marks bought; it never replaces it, so a shot can't be stretched
 * by a bar because the tempo is slow.
 */
const BEAT_PULL_FRACTION = 0.25;
const BEAT_PULL_MAX = 0.65;

/** Outside this the number came from a bad analysis, not from the music. */
const MIN_BPM = 50;
const MAX_BPM = 210;

const SCENE_CROSSFADE = 0.6;
const DAY_CROSSFADE = 0.8;

/** Below this, a clip's own audio is a click rather than a sound. */
const MUTE_BELOW = 1.8;

/** A scene name needs room to be read, and a shot long enough to hold it. */
const TITLE_START = 0.35;
const TITLE_DURATION = 2.2;
const TITLE_MIN_HOLD = 1.6;
const TITLE_FONT_SIZE = 44;

// --- Small pure helpers -----------------------------------------------------

/**
 * Values round-trip through jsonb and are compared by identity to decide
 * whether the timeline changed at all. Rounding at the point of generation is
 * what stops `0.30000000000000004` flipping that comparison forever.
 */
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export type RankTier = "keep" | "strong" | "hero";

/**
 * Bands the crew's marks into the same three tiers they voted with.
 *
 * Absolute, against the vlog's cut line — deliberately *not* a percentile of
 * the pile. A percentile is relative to the set, so one new reaction anywhere
 * would re-time every other shot; a band means a vote changes the length of
 * the shot it was cast on, and nothing else.
 */
export function rankTier(rank: number, threshold: number): RankTier {
  const base = Math.max(threshold, 0.8);
  if (rank >= base * 2) return "hero";
  if (rank >= base * 1.25) return "strong";
  return "keep";
}

/** Stable pseudo-random in [-1, 1] from an id. FNV-1a; same answer forever. */
export function jitterFor(mediaItemId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < mediaItemId.length; i++) {
    h ^= mediaItemId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 2001) / 1000 - 1;
}

// --- Scenes -----------------------------------------------------------------

/** A run of clips shot in one sitting, in one place, without a long break. */
export interface Scene {
  startIndex: number;
  /** Inclusive. */
  endIndex: number;
  /** Epoch ms of the first clip that has a capture time, or null. */
  startedAt: number | null;
  /** Which scene of its day this is, counting from 1. */
  ordinalInDay: number;
  /** True when this scene starts on a different day from the one before. */
  newDay: boolean;
}

function utcDayOf(ms: number): number {
  return Math.floor(ms / 86_400_000);
}

/**
 * Breaks the running order into scenes at long capture gaps and day
 * boundaries. Items with no capture time join whatever scene they land next
 * to — we know nothing about them, so we don't claim anything.
 */
export function detectScenes(cut: CutEntry[]): Scene[] {
  if (cut.length === 0) return [];

  const bounds: number[] = [0];
  let previousAt: number | null = cut[0].capturedAt;

  for (let i = 1; i < cut.length; i++) {
    const at = cut[i].capturedAt;
    if (at !== null && previousAt !== null) {
      const gap = at - previousAt;
      if (gap >= SCENE_GAP_MS || utcDayOf(at) !== utcDayOf(previousAt)) bounds.push(i);
    }
    if (at !== null) previousAt = at;
  }

  const scenes: Scene[] = [];
  let previousDay: number | null = null;
  let ordinal = 0;

  bounds.forEach((startIndex, n) => {
    const endIndex = (bounds[n + 1] ?? cut.length) - 1;
    let startedAt: number | null = null;
    for (let i = startIndex; i <= endIndex; i++) {
      if (cut[i].capturedAt !== null) {
        startedAt = cut[i].capturedAt;
        break;
      }
    }

    const day = startedAt === null ? null : utcDayOf(startedAt);
    const newDay = day !== null && previousDay !== null && day !== previousDay;
    ordinal = day !== null && day === previousDay ? ordinal + 1 : 1;
    if (day !== null) previousDay = day;

    scenes.push({ startIndex, endIndex, startedAt, ordinalInDay: ordinal, newDay });
  });

  return scenes;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function partOfDay(hour: number): string {
  if (hour < 5) return "night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";
  return "night";
}

/**
 * What to call a scene. A new day earns its name; a later stretch of the same
 * day just says so.
 *
 * Read in UTC on purpose: this runs server-side inside `syncCut` and again in
 * the browser for the scene bands on the floor, and the two must never
 * disagree. The cost is that a trip a few time zones away can read a few hours
 * off — worth it for a name that's the same for everyone looking at it.
 */
export function sceneLabel(scene: Scene, index: number): string | null {
  if (scene.startedAt === null) return null;
  const d = new Date(scene.startedAt);
  if (index === 0 || scene.newDay) {
    return `${WEEKDAYS[d.getUTCDay()]} ${partOfDay(d.getUTCHours())}`;
  }
  return scene.ordinalInDay >= 3 ? "Later on" : "Later that day";
}

// --- Timing -----------------------------------------------------------------

/** How long a shot should hold, before the source is consulted. */
export function holdFor(opts: {
  kind: "photo" | "video";
  tier: RankTier;
  pace: Pace;
  isLast: boolean;
  jitter: number;
}): number {
  let hold = BUDGET[opts.pace][opts.tier];
  if (opts.kind === "photo") hold = Math.min(hold * PHOTO_FACTOR, PHOTO_MAX);
  hold *= 1 + opts.jitter * JITTER;
  if (opts.isLast) hold += LAST_CLIP_BONUS;
  return round(clamp(hold, MIN_HOLD, opts.kind === "photo" ? PHOTO_MAX : MAX_HOLD));
}

/**
 * Which stretch of the source to actually use.
 *
 * Trim off the raise at the head and the lowering at the tail, then take the
 * budget out of what's left, just before the middle. A clip too short to
 * survive that gets used whole rather than shaved down to nothing.
 */
export function trimWindow(
  sourceDuration: number | null,
  hold: number,
): { trimStart: number; trimEnd: number | null; duration: number } {
  // Still processing: leave the out-point open and revisit when probing lands.
  if (sourceDuration === null || !Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    return { trimStart: 0, trimEnd: null, duration: hold };
  }

  const head = Math.min(HEAD_TRIM, sourceDuration * TRIM_FRACTION);
  const tail = Math.min(TAIL_TRIM, sourceDuration * TRIM_FRACTION);
  const usableStart = head;
  const usableEnd = sourceDuration - tail;
  const usable = usableEnd - usableStart;

  if (usable < MIN_HOLD) {
    const duration = round(sourceDuration);
    return { trimStart: 0, trimEnd: duration, duration };
  }

  if (usable <= hold) {
    return {
      trimStart: round(usableStart),
      trimEnd: round(usableEnd),
      duration: round(usable),
    };
  }

  const centre = usableStart + usable * WINDOW_CENTRE;
  const trimStart = round(clamp(centre - hold / 2, usableStart, usableEnd - hold));
  return { trimStart, trimEnd: round(trimStart + hold), duration: round(hold) };
}

// --- The beat ---------------------------------------------------------------

/**
 * Where the music's beats fall, in *film* seconds — the bed's own start and
 * offset are already taken out by the time this reaches the director, so a
 * beat at `firstBeat` is a beat you'd hear at that moment of the finished cut.
 *
 * `beats` is what the worker measured; the periodic grid implied by `bpm` and
 * `firstBeat` covers everything past the end of the analysed stretch, which is
 * usually only the first couple of minutes of the track.
 */
export interface BeatGrid {
  bpm: number;
  firstBeat: number;
  /** Ascending, in film seconds. Optional — bpm plus a phase is enough. */
  beats?: number[];
}

/**
 * Rejects a grid we can't trust rather than letting a bogus tempo retime the
 * whole film. Returns the grid unchanged when it's usable, `null` otherwise.
 */
export function usableBeatGrid(grid: BeatGrid | null | undefined): BeatGrid | null {
  if (!grid) return null;
  if (!Number.isFinite(grid.bpm) || grid.bpm < MIN_BPM || grid.bpm > MAX_BPM) return null;
  if (!Number.isFinite(grid.firstBeat)) return null;
  return grid;
}

/**
 * Moves a track's own beat times onto the film's clock. A bed that starts 20s
 * in, 8s into the song, puts the song's 8s beat at the film's 20s.
 */
export function beatGridInFilmTime(
  track: { bpm: number | null; beatOffsetSeconds: number | null; beatTimes?: number[] | null },
  placement: { startAt: number; offset: number },
): BeatGrid | null {
  if (track.bpm === null || !Number.isFinite(track.bpm)) return null;
  const shift = placement.startAt - placement.offset;
  const beats = track.beatTimes
    ?.filter((t) => Number.isFinite(t))
    .map((t) => round(t + shift));
  return usableBeatGrid({
    bpm: track.bpm,
    firstBeat: round((track.beatOffsetSeconds ?? 0) + shift),
    beats: beats && beats.length > 1 ? beats : undefined,
  });
}

/** The measured beat nearest `time`, falling back to the periodic grid. */
export function nearestBeat(time: number, grid: BeatGrid): number {
  const period = 60 / grid.bpm;
  const beats = grid.beats;

  if (beats && beats.length > 0 && time >= beats[0] - period && time <= beats[beats.length - 1] + period) {
    let lo = 0;
    let hi = beats.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] < time) lo = mid + 1;
      else hi = mid;
    }
    const after = beats[lo];
    const before = beats[Math.max(0, lo - 1)];
    return time - before <= after - time ? before : after;
  }

  return round(grid.firstBeat + Math.round((time - grid.firstBeat) / period) * period);
}

/**
 * The same hold, rounded off to whichever beat is nearest the moment the cut
 * would have landed — but only if that beat is inside the pull, and only if
 * the result is still a length the banding logic would have allowed.
 */
export function snapHold(start: number, hold: number, maxHold: number, grid: BeatGrid): number {
  const target = start + hold;
  const beat = nearestBeat(target, grid);
  const pull = Math.min(hold * BEAT_PULL_FRACTION, BEAT_PULL_MAX);
  if (Math.abs(beat - target) > pull) return hold;

  const snapped = round(beat - start);
  if (snapped < MIN_HOLD || snapped > maxHold) return hold;
  return snapped;
}

// --- The pass ---------------------------------------------------------------

export interface DirectorInput {
  /** The cut, in running order — 1:1 by index with `doc.clips`. */
  cut: CutEntry[];
  /** The vlog's cut line, which sets the scale the marks are read against. */
  threshold: number;
  settings: DirectorSettings;
  /**
   * The music bed's beats, on the film's clock. Optional in every sense: no
   * bed, no analysis, or beat-snapping switched off all mean the timing is
   * exactly what it was before this existed.
   */
  beats?: BeatGrid | null;
}

interface Plan {
  trimStart: number;
  trimEnd: number | null;
  duration: number;
  transitionIn: Transition;
  transitionDuration: number;
  muted: boolean;
  title: TitleOverlay | null;
}

/**
 * A dissolve says time passed; a dip to black says the day ended. Worth
 * spending the stronger punctuation only where it means something.
 *
 * Split out from the rest of the plan because the layout pass needs to know
 * whether a shot overlaps its predecessor *before* it can say where the shot
 * starts, and that has to be the same answer the plan will give.
 */
function transitionFor(index: number, scene: Scene): Transition {
  if (index !== scene.startIndex || index === 0) return "cut";
  return scene.newDay ? "dipblack" : "crossfade";
}

function transitionDurationFor(index: number, scene: Scene): number {
  if (index !== scene.startIndex || index === 0) return DEFAULT_TRANSITION_DURATION;
  return scene.newDay ? DAY_CROSSFADE : SCENE_CROSSFADE;
}

function planClip(
  entry: CutEntry,
  index: number,
  cut: CutEntry[],
  scene: Scene,
  sceneIndex: number,
  input: DirectorInput,
  /** Where this shot's first frame lands in the finished film. */
  startsAt: number,
  grid: BeatGrid | null,
): Plan {
  const tier = rankTier(entry.rank, input.threshold);
  const budget = holdFor({
    kind: entry.kind,
    tier,
    pace: input.settings.pace,
    isLast: index === cut.length - 1,
    jitter: jitterFor(entry.mediaItemId),
  });

  // The beat grid quantises the budget; it never sets it. A shot still gets
  // the length its marks bought, rounded off to where the music lands.
  const hold = grid
    ? snapHold(startsAt, budget, entry.kind === "photo" ? PHOTO_MAX : MAX_HOLD, grid)
    : budget;

  const window =
    entry.kind === "photo"
      ? { trimStart: 0, trimEnd: null, duration: hold }
      : trimWindow(entry.durationSeconds, hold);

  const opensScene = index === scene.startIndex;

  return {
    ...window,
    transitionIn: transitionFor(index, scene),
    transitionDuration: transitionDurationFor(index, scene),
    muted: entry.kind === "video" && window.duration < MUTE_BELOW,
    title: titleFor(scene, sceneIndex, opensScene, window.duration, input),
  };
}

function titleFor(
  scene: Scene,
  sceneIndex: number,
  opensScene: boolean,
  hold: number,
  input: DirectorInput,
): TitleOverlay | null {
  if (!input.settings.sceneText || !opensScene || hold < TITLE_MIN_HOLD) return null;
  const text = sceneLabel(scene, sceneIndex);
  if (!text) return null;
  return {
    // Deterministic, so re-running produces a title that compares equal to the
    // one already on the clip instead of a fresh object every time.
    id: "auto-scene",
    text,
    start: TITLE_START,
    duration: round(Math.min(TITLE_DURATION, hold - TITLE_START - 0.2)),
    position: "bottom",
    fontSize: TITLE_FONT_SIZE,
    color: "#ffffff",
  };
}

function sameTitles(a: TitleOverlay[], b: TitleOverlay[]): boolean {
  return (
    a.length === b.length &&
    a.every((t, i) => {
      const o = b[i];
      return (
        t.id === o.id &&
        t.text === o.text &&
        t.start === o.start &&
        t.duration === o.duration &&
        t.position === o.position &&
        t.fontSize === o.fontSize &&
        t.color === o.color
      );
    })
  );
}

function applyToClip(clip: Clip, plan: Plan): Clip {
  if (clip.auto.length === 0) return clip;
  const owns = new Set(clip.auto);
  let next: Clip | null = null;

  const set = <K extends keyof Clip>(key: K, value: Clip[K]) => {
    if (Object.is((next ?? clip)[key], value)) return;
    next ??= { ...clip };
    next[key] = value;
  };

  if (owns.has("timing")) {
    set("trimStart", plan.trimStart);
    set("trimEnd", plan.trimEnd);
    set("duration", plan.duration);
  }
  if (owns.has("transition")) {
    set("transitionIn", plan.transitionIn);
    set("transitionDuration", plan.transitionDuration);
  }
  if (owns.has("audio")) set("muted", plan.muted);
  if (owns.has("title")) {
    const titles = plan.title ? [plan.title] : [];
    if (!sameTitles(titles, clip.titles)) {
      next ??= { ...clip };
      next.titles = titles;
    }
  }

  return next ?? clip;
}

/**
 * Runs the auto-cut over a reconciled document.
 *
 * Returns the *same document* when no auto-owned value moved, and the same
 * clip object for every shot that didn't move. `syncCut` leans on both to skip
 * the write — which is what lets this be called after every single vote.
 */
export function runDirector(doc: TimelineDoc, input: DirectorInput): TimelineDoc {
  if (!input.settings.enabled) return doc;
  if (doc.clips.length === 0 || doc.clips.length !== input.cut.length) return doc;

  const scenes = detectScenes(input.cut);
  const sceneOf: Scene[] = [];
  const sceneIndexOf: number[] = [];
  scenes.forEach((scene, n) => {
    for (let i = scene.startIndex; i <= scene.endIndex; i++) {
      sceneOf[i] = scene;
      sceneIndexOf[i] = n;
    }
  });

  const grid = input.settings.beatSnap ? usableBeatGrid(input.beats) : null;

  // Laid out as it will play, because snapping to a beat is a question about
  // *when* a cut lands, not how long a shot is. The cursor follows the clips
  // the pass actually produces — a hand-trimmed shot keeps its own length, and
  // everything downstream of it snaps against where that really leaves us.
  let cursor = 0;
  const clips = doc.clips.map((clip, i) => {
    const entry = input.cut[i];
    const scene = sceneOf[i];
    const owns = new Set(clip.auto);

    const transition = owns.has("transition")
      ? { kind: transitionFor(i, scene), duration: transitionDurationFor(i, scene) }
      : { kind: clip.transitionIn, duration: clip.transitionDuration };
    const overlap =
      i > 0 && overlapsPrevious(transition.kind) ? Math.min(transition.duration, cursor) : 0;
    const startsAt = round(cursor - overlap);

    const next = applyToClip(
      clip,
      planClip(entry, i, input.cut, scene, sceneIndexOf[i], input, startsAt, grid),
    );
    cursor = round(startsAt + clipDuration(next, entry.durationSeconds));
    return next;
  });

  if (clips.every((c, i) => c === doc.clips[i])) return doc;
  return { ...doc, clips, updatedAt: new Date().toISOString() };
}

/** Hands every clip back to the auto-cut. Used by the "re-cut" op and action. */
export function rearmAll(doc: TimelineDoc): TimelineDoc {
  return { ...doc, clips: doc.clips.map((c) => ({ ...c, auto: [...AUTO_FIELDS] })) };
}
