import {
  AUTO_FIELDS,
  DEFAULT_TRANSITION_DURATION,
  SCENE_AUTO_FIELDS,
  movesFrame,
  overlapsPrevious,
  type Pace,
} from "./constants";
import type { Motion, Transition } from "./constants";
import { clipDuration, clipSpeed } from "./timeline";
import type {
  Clip,
  CutEntry,
  DirectorSettings,
  Scene,
  TimelineDoc,
  TitleOverlay,
} from "./timeline";

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
 *     for free — as do the coordinates, when the crew has moved on.
 *   - Vary the rhythm. Shots of identical length read as a slideshow.
 *   - Cut on the beat, when there is one. The music bed's measured beats are a
 *     grid the budgeted lengths are *rounded off to* — a quarter of a shot's
 *     length at most, so the marks still decide how long it holds and the
 *     music only decides exactly where the cut falls.
 *   - And: never overrule a person. Every value here is written only while the
 *     matching `auto` flag is still on the clip — or, for what a scene is
 *     called, on the scene.
 *
 * Scenes are the one thing this pass *keeps* rather than works out afresh. The
 * breaks are read off when and where each shot was taken every time, but the
 * scenes they land on live on the document, because the name of one is a person's to change and a
 * derived name would forget it on the next reaction. See `reconcileScenes`.
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

/**
 * And this far from where the scene started means they went somewhere else.
 *
 * Half a kilometre is a park, a beach, a few city blocks — wide enough to hold
 * a place and all the wandering around inside it, so a walk to the far end of
 * the market doesn't become a second scene. It is also more than an order of
 * magnitude above the tens of metres a stationary phone's fix drifts by, and
 * above the couple of hundred a poor indoor fix can invent, so jitter can't
 * manufacture a break on its own. Anything the crew would call somewhere else
 * — the next village, the other side of town — clears it without trying.
 */
const SCENE_MOVE_METRES = 500;

/** Base screen time in seconds, per pace, per tier of the crew's marks. */
const BUDGET: Record<Pace, Record<RankTier, number>> = {
  snappy: { keep: 1.8, strong: 2.8, hero: 4.5 },
  standard: { keep: 2.6, strong: 4.0, hero: 6.5 },
  relaxed: { keep: 3.8, strong: 5.5, hero: 9.0 },
};

/**
 * Stills read faster than footage, so a photo gets less than its tier's budget
 * and is capped besides — a static frame is dead long before a shot is.
 *
 * A photo that *moves* is a different animal. The slow push holds an eye about
 * as well as footage does, so it keeps nearly all of its budget and is allowed
 * to run most of twice as long. This is the whole point of the move: not
 * decoration, but screen time the pile's best photographs had no way to earn.
 */
const PHOTO_FACTOR_STILL = 0.75;
const PHOTO_FACTOR_MOVING = 0.95;
const PHOTO_MAX_STILL = 4;
const PHOTO_MAX_MOVING = 7;

function photoLimits(moving: boolean): { factor: number; max: number } {
  return moving
    ? { factor: PHOTO_FACTOR_MOVING, max: PHOTO_MAX_MOVING }
    : { factor: PHOTO_FACTOR_STILL, max: PHOTO_MAX_STILL };
}

/**
 * Which way a still moves. Taken from the item's own id, not its position, so
 * that reordering the cut doesn't restage every photograph in it — and so that
 * a run of stills alternates instead of marching.
 */
function motionFor(entry: CutEntry, jitter: number): Motion {
  if (entry.kind !== "photo") return "none";
  return jitter < 0 ? "pullout" : "punchin";
}

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

/**
 * Where the running order breaks, as read off when and where the shots were
 * taken on this pass.
 *
 * Positional and therefore disposable: it describes *this* arrangement of the
 * cut and stops being true the moment somebody drags a shot. The durable thing
 * is `Scene` on the document, which these are reconciled against.
 */
export interface SceneBreak {
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

interface Fix {
  latitude: number;
  longitude: number;
}

/**
 * A fix worth believing, or null.
 *
 * `(0, 0)` is a stretch of the Atlantic nobody is filming in and is what some
 * cameras write when the GPS never locked, so it is read as no fix rather than
 * as a shot 5,000km from everything else in the pile.
 */
function fixOf(entry: CutEntry): Fix | null {
  const { latitude, longitude } = entry;
  if (latitude === null || longitude === null) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
}

const EARTH_RADIUS_M = 6_371_000;

/**
 * Great-circle metres between two fixes. Haversine, which is accurate to a
 * fraction of a percent at any distance that matters here.
 *
 * Unrounded on purpose, and that is safe *because* the number never leaves
 * this file: it feeds one comparison and is then dropped. The 3dp rule exists
 * so values on the document round-trip through jsonb identically; a float that
 * is never written can't churn a revision.
 */
function metresBetween(a: Fix, b: Fix): number {
  const rad = Math.PI / 180;
  const lat1 = a.latitude * rad;
  const lat2 = b.latitude * rad;
  const dLat = lat2 - lat1;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Breaks the running order into scenes: at long capture gaps, at day
 * boundaries, and where the crew has plainly relocated. Items that know
 * neither when nor where they were taken join whatever scene they land next
 * to — we know nothing about them, so we don't claim anything.
 *
 * Distance is measured against an **anchor**, the first located shot of the
 * scene in progress, never against the shot before. Comparing neighbours fails
 * in both directions at once: a walk is a trickle of twenty-metre steps that
 * never adds up to a break however far it goes, and on the one step that does
 * cross the line, the next step measures from the new spot and the whole
 * afternoon shatters into fragments. The anchor asks the question a scene is
 * actually about — are we still roughly where this started? — so a stroll
 * stays one scene until it has covered the threshold as the crow flies, and
 * then starts a fresh one from wherever it got to. A wander that stays inside
 * the threshold is one scene however many kilometres of pavement it walked.
 *
 * An unlocated shot never moves the anchor and never breaks anything: the
 * anchor is carried across it untouched, so a photo with its EXIF stripped
 * sitting between two shots of the same room doesn't split the room in half.
 */
export function detectScenes(cut: CutEntry[]): SceneBreak[] {
  if (cut.length === 0) return [];

  const bounds: number[] = [0];
  let previousAt: number | null = cut[0].capturedAt;
  let anchor: Fix | null = fixOf(cut[0]);

  for (let i = 1; i < cut.length; i++) {
    const at = cut[i].capturedAt;
    const fix = fixOf(cut[i]);

    const elapsed =
      at !== null &&
      previousAt !== null &&
      (at - previousAt >= SCENE_GAP_MS || utcDayOf(at) !== utcDayOf(previousAt));
    const relocated =
      fix !== null && anchor !== null && metresBetween(anchor, fix) >= SCENE_MOVE_METRES;

    if (elapsed || relocated) {
      bounds.push(i);
      // A new scene is anchored where it begins, whatever the last one was
      // about. If it begins with an unlocated shot the anchor stays open for
      // the first shot along that does know where it was.
      anchor = fix;
    } else {
      anchor ??= fix;
    }

    if (at !== null) previousAt = at;
  }

  const scenes: SceneBreak[] = [];
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
 * The first guess at what to call a scene. A new day earns its name; a later
 * stretch of the same day just says so.
 *
 * Read in UTC on purpose. The name is generated once and then stored, so the
 * machine that happened to run the sync must not be able to change it: two
 * processes reading the same timestamps have to arrive at the same words, or a
 * re-cut on a differently-configured box would silently rewrite every scene
 * name in the film. The cost is that a trip a few time zones away can read a
 * few hours off — and that's what renaming is for.
 */
export function sceneLabel(scene: SceneBreak, index: number): string | null {
  if (scene.startedAt === null) return null;
  const d = new Date(scene.startedAt);
  if (index === 0 || scene.newDay) {
    return `${WEEKDAYS[d.getUTCDay()]} ${partOfDay(d.getUTCHours())}`;
  }
  return scene.ordinalInDay >= 3 ? "Later on" : "Later that day";
}

/**
 * An id for a scene nobody has seen before.
 *
 * Borrowed from a shot in it rather than generated, because `syncCut` decides
 * whether to write by comparing documents: a `randomUUID` here would produce a
 * different document on every pass and churn a revision on every reaction,
 * forever. Any shot in the scene would do — the first one that isn't already
 * lending its id to a scene that survived this pass, which only happens when a
 * scene splits and the other half kept the name.
 */
function freshSceneId(clips: Clip[], run: SceneBreak, used: Set<string>): string {
  const take = (id: string) => {
    used.add(id);
    return id;
  };
  for (let i = run.startIndex; i <= run.endIndex; i++) {
    const candidate = `sc-${clips[i].mediaItemId}`;
    if (!used.has(candidate)) return take(candidate);
  }
  const base = `sc-${clips[run.startIndex].mediaItemId}`;
  for (let n = 2; ; n++) {
    if (!used.has(`${base}-${n}`)) return take(`${base}-${n}`);
  }
}

/** Are these the same scene, down to the last field? */
function sameScene(a: Scene, b: Scene): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.startedAt === b.startedAt &&
    a.newDay === b.newDay &&
    a.auto.length === b.auto.length &&
    a.auto.every((f, i) => f === b.auto[i])
  );
}

/**
 * Carries the document's scenes across to a freshly detected set of breaks.
 *
 * This is the whole reason scenes are stored. Detection is positional, and a
 * vote can drop a shot out of the middle of the film at any moment; if the
 * answer were rebuilt from scratch each time, a name somebody typed would last
 * until the next reaction.
 *
 * **Two scenes are the same scene when they are made of the same shots.** That
 * is exactly the rule `reconcileClips` already uses to keep a trim attached to
 * its shot, widened from one item to a set: each stored scene goes to whichever
 * detected run holds the most of its shots. Positions are never compared, so
 * reordering the cut moves scenes around rather than renaming them, and a shot
 * dropped or added only shifts the count.
 *
 * A stored scene can be claimed once. Split a scene in two and the bigger half
 * keeps the name while the other half starts unnamed; merge two and the name
 * that was on more of the footage wins. Ties go to the earlier scene, so the
 * answer never depends on iteration order.
 *
 * Returns scene objects identical to the stored ones wherever nothing moved —
 * `runDirector` compares them by identity to decide whether to write at all.
 */
function reconcileScenes(doc: TimelineDoc, runs: SceneBreak[]): Scene[] {
  const stored = new Map(doc.scenes.map((s) => [s.id, s]));

  /** How many of each stored scene's shots landed in each detected run. */
  const claims: { run: number; id: string; count: number }[] = [];
  runs.forEach((run, n) => {
    const counts = new Map<string, number>();
    for (let i = run.startIndex; i <= run.endIndex; i++) {
      const id = doc.clips[i]?.sceneId;
      if (id && stored.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [id, count] of counts) claims.push({ run: n, id, count });
  });

  const inherits = new Array<string | null>(runs.length).fill(null);
  const used = new Set<string>();
  claims
    .sort((a, b) => b.count - a.count || a.run - b.run || (a.id < b.id ? -1 : 1))
    .forEach(({ run, id }) => {
      if (inherits[run] !== null || used.has(id)) return;
      inherits[run] = id;
      used.add(id);
    });

  return runs.map((run, n) => {
    const previous = inherits[n] === null ? null : stored.get(inherits[n]!) ?? null;
    const auto = previous ? previous.auto : [...SCENE_AUTO_FIELDS];
    const next: Scene = {
      id: previous?.id ?? freshSceneId(doc.clips, run, used),
      // The one place a person's word is protected: once the flag is off, the
      // name on the document is the name, whatever the timestamps now say.
      name: auto.includes("name") ? sceneLabel(run, n) ?? "" : previous?.name ?? "",
      startedAt: run.startedAt,
      newDay: run.newDay,
      auto,
    };
    return previous && sameScene(previous, next) ? previous : next;
  });
}

// --- Timing -----------------------------------------------------------------

/** How long a shot should hold, before the source is consulted. */
export function holdFor(opts: {
  kind: "photo" | "video";
  tier: RankTier;
  pace: Pace;
  isLast: boolean;
  jitter: number;
  /** Whether this still is going to move. Ignored for video. */
  moving?: boolean;
}): number {
  const photo = photoLimits(opts.moving ?? false);
  let hold = BUDGET[opts.pace][opts.tier];
  if (opts.kind === "photo") hold = Math.min(hold * photo.factor, photo.max);
  hold *= 1 + opts.jitter * JITTER;
  if (opts.isLast) hold += LAST_CLIP_BONUS;
  return round(clamp(hold, MIN_HOLD, opts.kind === "photo" ? photo.max : MAX_HOLD));
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
  motion: Motion;
  muted: boolean;
  title: TitleOverlay | null;
  sceneId: string;
}

/**
 * A dissolve says time passed; a dip to black says the day ended. Worth
 * spending the stronger punctuation only where it means something.
 *
 * Split out from the rest of the plan because the layout pass needs to know
 * whether a shot overlaps its predecessor *before* it can say where the shot
 * starts, and that has to be the same answer the plan will give.
 */
function transitionFor(index: number, scene: SceneBreak): Transition {
  if (index !== scene.startIndex || index === 0) return "cut";
  return scene.newDay ? "dipblack" : "crossfade";
}

function transitionDurationFor(index: number, scene: SceneBreak): number {
  if (index !== scene.startIndex || index === 0) return DEFAULT_TRANSITION_DURATION;
  return scene.newDay ? DAY_CROSSFADE : SCENE_CROSSFADE;
}

function planClip(
  entry: CutEntry,
  index: number,
  cut: CutEntry[],
  run: SceneBreak,
  scene: Scene,
  input: DirectorInput,
  /** Where this shot's first frame lands in the finished film. */
  startsAt: number,
  grid: BeatGrid | null,
  /** Already resolved against the clip's flags: what this shot *will* do. */
  shot: { motion: Motion; speed: number },
): Plan {
  const tier = rankTier(entry.rank, input.threshold);
  const moving = movesFrame(shot.motion);
  const maxHold = entry.kind === "photo" ? photoLimits(moving).max : MAX_HOLD;

  const budget = holdFor({
    kind: entry.kind,
    tier,
    pace: input.settings.pace,
    isLast: index === cut.length - 1,
    jitter: jitterFor(entry.mediaItemId),
    moving,
  });

  // The beat grid quantises the budget; it never sets it. A shot still gets
  // the length its marks bought, rounded off to where the music lands.
  const hold = grid ? snapHold(startsAt, budget, maxHold, grid) : budget;

  // The budget is screen time, and a retimed shot spends its source faster
  // than it spends the clock: two seconds on screen at double speed is four
  // seconds of footage. Take the window in source seconds, then read the
  // result back as the audience will see it.
  const window =
    entry.kind === "photo"
      ? { trimStart: 0, trimEnd: null, duration: hold }
      : trimWindow(entry.durationSeconds, shot.speed === 1 ? hold : round(hold * shot.speed));

  const onScreen = shot.speed === 1 ? window.duration : round(window.duration / shot.speed);
  const opensScene = index === run.startIndex;

  return {
    ...window,
    transitionIn: transitionFor(index, run),
    transitionDuration: transitionDurationFor(index, run),
    motion: shot.motion,
    muted: entry.kind === "video" && onScreen < MUTE_BELOW,
    // The burnt-in name comes off the scene on the document, not off the
    // timestamps: rename the scene and the words on screen follow.
    title: titleFor(scene.name, opensScene, onScreen, input),
    sceneId: scene.id,
  };
}

function titleFor(
  name: string,
  opensScene: boolean,
  hold: number,
  input: DirectorInput,
): TitleOverlay | null {
  if (!input.settings.sceneText || !opensScene || hold < TITLE_MIN_HOLD) return null;
  // A scene nothing in it could date has no name to burn in.
  if (!name) return null;
  return {
    // Deterministic, so re-running produces a title that compares equal to the
    // one already on the clip instead of a fresh object every time.
    id: "auto-scene",
    text: name,
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
  if (owns.has("motion")) set("motion", plan.motion);
  // Not behind a flag of its own: which scene a shot is in isn't an opinion
  // anybody can hold against the camera, so it's filed for every shot the
  // auto-cut still has any say over. A shot handed back entirely keeps the
  // scene it was in rather than being orphaned by an unrelated hand trim.
  set("sceneId", plan.sceneId);
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
  // Nothing in this film is ours any more. Stated outright rather than left to
  // fall out of the per-clip checks, because the scene pass would otherwise
  // hand the auto-cut an opinion about a document — one written before any of
  // this existed, or one cut entirely by hand — that has told it to keep away.
  if (doc.clips.every((c) => c.auto.length === 0)) return doc;

  const runs = detectScenes(input.cut);
  const scenes = reconcileScenes(doc, runs);
  const runOf: SceneBreak[] = [];
  const sceneOf: Scene[] = [];
  runs.forEach((run, n) => {
    for (let i = run.startIndex; i <= run.endIndex; i++) {
      runOf[i] = run;
      sceneOf[i] = scenes[n];
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
    const run = runOf[i];
    const owns = new Set(clip.auto);

    const transition = owns.has("transition")
      ? { kind: transitionFor(i, run), duration: transitionDurationFor(i, run) }
      : { kind: clip.transitionIn, duration: clip.transitionDuration };
    const overlap =
      i > 0 && overlapsPrevious(transition.kind) ? Math.min(transition.duration, cursor) : 0;
    const startsAt = round(cursor - overlap);

    // Resolved before the plan, because how long a still can hold depends on
    // whether it is going to move — and whether it moves depends on whether
    // anyone has taken that decision away from us.
    const shot = {
      motion: owns.has("motion") ? motionFor(entry, jitterFor(entry.mediaItemId)) : clip.motion,
      speed: clipSpeed(clip),
    };

    const next = applyToClip(
      clip,
      planClip(entry, i, input.cut, run, sceneOf[i], input, startsAt, grid, shot),
    );
    cursor = round(startsAt + clipDuration(next, entry.durationSeconds));
    return next;
  });

  const scenesMoved =
    scenes.length !== doc.scenes.length || scenes.some((s, i) => s !== doc.scenes[i]);
  if (!scenesMoved && clips.every((c, i) => c === doc.clips[i])) return doc;
  return {
    ...doc,
    clips,
    scenes: scenesMoved ? scenes : doc.scenes,
    updatedAt: new Date().toISOString(),
  };
}

/** Hands every clip and every scene name back to the auto-cut. */
export function rearmAll(doc: TimelineDoc): TimelineDoc {
  return {
    ...doc,
    clips: doc.clips.map((c) => ({ ...c, auto: [...AUTO_FIELDS] })),
    scenes: doc.scenes.map((s) => ({ ...s, auto: [...SCENE_AUTO_FIELDS] })),
  };
}
