/**
 * Lifecycle of a vlog. Three states, because only three things are true of it:
 * it's being worked on, it's rendering, or it's been printed.
 *
 * The old `curate` and `edit` phases were gates the creator had to open before
 * anyone could vote or cut. Nothing gates anything now — everyone can drop,
 * vote and trim at the same time — so they're gone (migration 0004 rewrites
 * any surviving rows to `open`).
 */
export const VLOG_STATES = [
  "open", // friends upload, vote, arrange and edit — the whole workshop
  "export", // rendering
  "published", // done, downloadable
] as const;
export type VlogState = (typeof VLOG_STATES)[number];

export const VLOG_STATE_LABELS: Record<VlogState, string> = {
  open: "In production",
  export: "Rendering",
  published: "Locked",
};

/** Is the vlog still editable? Only a render takes that away. */
export function isWorkingState(state: VlogState): boolean {
  return state === "open";
}

/**
 * The three rooms of ROLLCALL: the floor (footage, votes, shortlist), the
 * bench (the cut) and the screening room (the final cut).
 *
 * Which one you're in is a *personal* choice held in the browser, not
 * vlog-wide state — one friend can be voting while another trims the cut.
 */
export const WORKSPACE_TABS = ["gather", "edit", "watch"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export const WORKSPACE_TAB_LABELS: Record<WorkspaceTab, string> = {
  gather: "The Floor",
  edit: "The Cut",
  watch: "Final Cut",
};

/** Reel numbers stand in for icons — this is a film, not a toolbar. */
export const WORKSPACE_TAB_REELS: Record<WorkspaceTab, string> = {
  gather: "R1",
  edit: "R2",
  watch: "R3",
};

export const WORKSPACE_TAB_BLURBS: Record<WorkspaceTab, string> = {
  gather: "Drop footage, mark it up, and watch the shortlist build itself",
  edit: "Trim, retime, title and score the cut",
  watch: "Screen the film, download it, send it round",
};

/**
 * The six beats of making the film, for the cover. Four of them happen on the
 * floor, stacked down one page, so voting and its consequences are never
 * separated — which is why the rail only names three rooms.
 */
export const FLOW_STAGES = [
  { id: "drop", label: "Drop", blurb: "Empty the camera roll into the pile" },
  { id: "discover", label: "Discover", blurb: "See everyone's footage on one light table" },
  { id: "vote", label: "Vote", blurb: "One frame at a time, mark what's worth keeping" },
  { id: "shortlist", label: "Shortlist", blurb: "What the crew kept, in order, as a rough cut" },
  { id: "cut", label: "Cut", blurb: "Trim, retime, title, score" },
  { id: "final", label: "Final Cut", blurb: "Screen it, download it, send it round" },
] as const satisfies readonly { id: string; label: string; blurb: string }[];

export type FlowStageId = (typeof FLOW_STAGES)[number]["id"];

/** How an item was forced in or out of the cut, overriding the cut line. */
export const CUT_OVERRIDES = ["include", "exclude"] as const;
export type CutOverride = (typeof CUT_OVERRIDES)[number];

/**
 * Reactions double as a score. Three tiers, ascending, so the dump view can
 * rank items organically without anyone doing bookkeeping.
 */
export const REACTION_SCORES = [1, 2, 3] as const;
export type ReactionScore = (typeof REACTION_SCORES)[number];

/**
 * Seen it, and it's not for me.
 *
 * A pass is stored like any other verdict rather than deleted, because "what
 * haven't you looked at yet" and "what did you decline" are different
 * questions and a missing row only answers the first. While they shared one
 * value the deck kept re-serving shots people had already turned down, and the
 * only way to stop being asked was to award a mark you didn't mean — which is
 * how a pile of default Keeps got into the film.
 */
export const PASS_SCORE = 0;

/**
 * What one member said about one item: a mark, or a pass. `null` isn't a
 * verdict at all — it means they haven't looked.
 */
export type Verdict = ReactionScore | typeof PASS_SCORE;

export interface ReactionTier {
  score: ReactionScore;
  emoji: string;
  label: string;
}

/**
 * Grease-pencil marks, not emoji and not karma: one mark means keep it, three
 * means it's the shot everyone will talk about. The glyph is a tally, so a
 * vote reads as a judgement about the footage rather than a score on a person.
 */
export const DEFAULT_REACTIONS: ReactionTier[] = [
  { score: 1, emoji: "\u25CF", label: "Keep" },
  { score: 2, emoji: "\u25CF\u25CF", label: "Strong" },
  { score: 3, emoji: "\u25CF\u25CF\u25CF", label: "Hero" },
];

export const MEDIA_KINDS = ["photo", "video"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MUSIC_SOURCES = ["youtube", "spotify", "deezer"] as const;
export type MusicSource = (typeof MUSIC_SOURCES)[number];

export const PROCESSING_STATUSES = [
  "pending",
  "processing",
  "ready",
  "failed",
] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

export const RENDER_STATUSES = [
  "queued",
  "rendering",
  "done",
  "failed",
] as const;
export type RenderStatus = (typeof RENDER_STATUSES)[number];

/**
 * How one shot gives way to the next.
 *
 * A curated set, not the whole of `xfade` — FFmpeg offers thirty-odd and most
 * of them belong in a 2004 slideshow. These are the ones with an actual
 * editorial meaning, named the way an editor would name them rather than the
 * way the filter does.
 */
export const TRANSITIONS = [
  "cut",
  "crossfade",
  "dipblack",
  "dipwhite",
  "wipeleft",
  "wiperight",
  "pushleft",
  "pushright",
  "irisopen",
  "irisclose",
  "pixelize",
] as const;
export type Transition = (typeof TRANSITIONS)[number];

export const TRANSITION_LABELS: Record<Transition, string> = {
  cut: "Cut",
  crossfade: "Dissolve",
  dipblack: "Dip to black",
  dipwhite: "Dip to white",
  wipeleft: "Wipe left",
  wiperight: "Wipe right",
  pushleft: "Push left",
  pushright: "Push right",
  irisopen: "Iris open",
  irisclose: "Iris close",
  pixelize: "Pixelate",
};

/** One glyph each, for the badge on a shot in the strip. */
export const TRANSITION_GLYPHS: Record<Transition, string> = {
  cut: "|",
  crossfade: "\u21C4",
  dipblack: "\u25D0",
  dipwhite: "\u25D1",
  wipeleft: "\u25C0",
  wiperight: "\u25B6",
  pushleft: "\u00AB",
  pushright: "\u00BB",
  irisopen: "\u25CB",
  irisclose: "\u25CF",
  pixelize: "\u25A6",
};

/**
 * What each one compiles to in FFmpeg's `xfade` filter. `cut` is the only
 * value with no transition at all — everything else overlaps its predecessor
 * by `transitionDuration`, which is why so much of the timing code asks this
 * question rather than comparing against `"crossfade"`.
 */
export const XFADE_FOR: Record<Transition, string | null> = {
  cut: null,
  crossfade: "fade",
  dipblack: "fadeblack",
  dipwhite: "fadewhite",
  wipeleft: "wipeleft",
  wiperight: "wiperight",
  pushleft: "slideleft",
  pushright: "slideright",
  irisopen: "circleopen",
  irisclose: "circleclose",
  pixelize: "pixelize",
};

/** Does this transition overlap the shot before it? */
export function overlapsPrevious(transition: Transition): boolean {
  return XFADE_FOR[transition] !== null;
}

/**
 * The same eleven, described in terms a browser can act on.
 *
 * The preview has no compositor, so it stacks the outgoing and incoming shots
 * as two DOM layers and animates them; this map says *what* to animate and the
 * player works out the CSS. It is deliberately a separate map from `XFADE_FOR`
 * rather than a richer value in it: no FFmpeg spelling belongs anywhere near a
 * browser bundle, and the DOM version is an impression of the filter, not a
 * translation of it.
 *
 * `blur` is the honest admission. CSS cannot pixelate — `image-rendering` only
 * bites when a bitmap is scaled up — so `pixelize` is played as a dissolve that
 * goes soft in the middle. It hits the same beat (the picture falls apart and
 * reassembles) and looks nothing like the render, which stays the authority.
 */
export type TransitionEffect =
  | { kind: "none" }
  | { kind: "dissolve" }
  | { kind: "dip"; colour: string }
  | { kind: "wipe"; towards: "left" | "right" }
  | { kind: "push"; towards: "left" | "right" }
  | { kind: "iris"; circle: "incoming" | "outgoing" }
  | { kind: "blur" };

export const TRANSITION_EFFECT: Record<Transition, TransitionEffect> = {
  cut: { kind: "none" },
  crossfade: { kind: "dissolve" },
  dipblack: { kind: "dip", colour: "#000" },
  dipwhite: { kind: "dip", colour: "#fff" },
  // The name says where the boundary travels, so the incoming shot arrives
  // from the far side.
  wipeleft: { kind: "wipe", towards: "left" },
  wiperight: { kind: "wipe", towards: "right" },
  pushleft: { kind: "push", towards: "left" },
  pushright: { kind: "push", towards: "right" },
  // Open grows a hole in the incoming shot; close shrinks the outgoing one
  // away. Which frame carries the circle is the whole difference.
  irisopen: { kind: "iris", circle: "incoming" },
  irisclose: { kind: "iris", circle: "outgoing" },
  pixelize: { kind: "blur" },
};

/**
 * How a still moves under the camera.
 *
 * Named after the documentarian who made it a house style: a photograph that
 * drifts reads as film, a photograph that sits there reads as a stall. It is
 * what buys a still more than a few seconds of screen time.
 *
 * A push or a pull, and nothing else. Both scale the frame about its centre,
 * which is the only move that is safe whatever shape the photo is — a pan
 * across a portrait letterboxed into 16:9 would travel over the black bars
 * rather than the picture, and fixing that means the timeline learning to say
 * "fill the frame", which is a bigger decision than a filter.
 */
export const MOTIONS = ["none", "punchin", "pullout"] as const;
export type Motion = (typeof MOTIONS)[number];

export const MOTION_LABELS: Record<Motion, string> = {
  none: "Hold still",
  punchin: "Push in",
  pullout: "Pull out",
};

export const MOTION_GLYPHS: Record<Motion, string> = {
  none: "\u25A1",
  punchin: "\u25E8",
  pullout: "\u25E7",
};

/**
 * How far a move travels by the last frame. Small on purpose: the shot should
 * feel alive, not zoom. 12% over four seconds is about a centimetre a second
 * at arm's length, which is the speed the eye reads as "breathing".
 */
export const MOTION_ZOOM = 1.12;

/** Does this move the frame at all? */
export function movesFrame(motion: Motion): boolean {
  return motion !== "none";
}

/**
 * Speed multipliers offered in the inspector. Free-form would be worse: these
 * are the ones with a name in the cutting room, and the range is what `atempo`
 * can chain without the sound turning to mush.
 */
export const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4] as const;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

/**
 * The shortest anything on the bench is allowed to be.
 *
 * Lives here because the bench enforces it in three places that must agree —
 * a handle dragged to nothing, a trim typed to nothing and the inspector's
 * grow buttons — and three copies of a number whose whole job is to match is a
 * bug waiting for someone to tune one of them.
 */
export const MIN_CLIP_SPAN = 0.2;

/** Photos have no intrinsic duration; this is how long they hold on screen. */
export const DEFAULT_PHOTO_DURATION = 3;
export const DEFAULT_TRANSITION_DURATION = 0.5;

/**
 * The most of a shot a transition into it may consume. `xfade` fails outright
 * when asked to fade for longer than its inputs last, so the render has always
 * capped the fade against the incoming clip — this is that cap, named, so the
 * bench and the preview can reach the same number instead of guessing at it.
 */
export const TRANSITION_MAX_SHARE = 0.9;

/**
 * How hard the auto-cut cuts. The only knob the crew gets: everything else
 * about the default cut is a film-making opinion, and an opinion you can turn
 * off isn't one.
 */
export const PACE_PRESETS = ["snappy", "standard", "relaxed"] as const;
export type Pace = (typeof PACE_PRESETS)[number];

export const PACE_LABELS: Record<Pace, string> = {
  snappy: "Snappy",
  standard: "Standard",
  relaxed: "Relaxed",
};

export const PACE_BLURBS: Record<Pace, string> = {
  snappy: "Cut hard. Nothing outstays its welcome.",
  standard: "Room to breathe, but keep moving.",
  relaxed: "Let the good shots run.",
};

/**
 * The parts of a clip the auto-cut owns until somebody touches them by hand.
 * A flag survives on a clip only while nobody has overruled that decision, so
 * re-running the cut never walks over anyone's work.
 */
export const AUTO_FIELDS = ["timing", "transition", "title", "audio", "motion"] as const;
export type AutoField = (typeof AUTO_FIELDS)[number];

/**
 * The same bargain for a scene, and there is only one clause in it: the name.
 *
 * Where a scene starts and stops is read off the capture times, and nobody is
 * arguing with the camera about when they took the photograph. What the stretch
 * of trip is *called* is a different kind of claim — "Tuesday morning" is a
 * guess made from a timestamp, and the person who was there knows better.
 */
export const SCENE_AUTO_FIELDS = ["name"] as const;
export type SceneAutoField = (typeof SCENE_AUTO_FIELDS)[number];

export const ACCEPTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/avif",
];

/**
 * Image types a browser will actually paint.
 *
 * HEIC is the odd one out and it matters more than its share of the list: it
 * is what every recent iPhone shoots by default, and outside Safari nothing
 * can decode it. A HEIC original handed straight to an <img> is a broken
 * image, so anything in this gap needs a JPEG stand-in made for it server-side
 * before a single person can judge the shot.
 */
export const BROWSER_SAFE_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
];

/** Does this photo need a stand-in before a browser can show it? */
export function needsDisplayCopy(mime: string): boolean {
  return mime.startsWith("image/") && !BROWSER_SAFE_IMAGE_TYPES.includes(mime);
}

export const ACCEPTED_VIDEO_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/x-msvideo",
  "video/mpeg",
  "video/3gpp",
];

export const ACCEPTED_AUDIO_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
  "audio/mp4",
];

export const ACCEPTED_UPLOAD_TYPES = [
  ...ACCEPTED_IMAGE_TYPES,
  ...ACCEPTED_VIDEO_TYPES,
  ...ACCEPTED_AUDIO_TYPES,
];

export function kindForMimeType(mime: string): MediaKind | "audio" | null {
  if (ACCEPTED_IMAGE_TYPES.includes(mime)) return "photo";
  if (ACCEPTED_VIDEO_TYPES.includes(mime)) return "video";
  if (ACCEPTED_AUDIO_TYPES.includes(mime)) return "audio";
  return null;
}

/**
 * How far the score gets out of the way when a shot has sound of its own.
 *
 * This is a *depth*, not a level: the music is pushed down only while somebody
 * is talking and comes back up in the gaps, which is the whole difference
 * between a mix and the flat attenuation this replaced.
 */
export const DEFAULT_BED_DUCK = 0.6;

/**
 * The parts of the duck nobody should have to think about, in FFmpeg's units.
 *
 * Only the depth is on the timeline. These are the settings that make a duck
 * sound like a duck rather than a tremolo, and a slider for any of them would
 * be a slider for a problem the person doesn't have.
 */
export const DUCK_SIDECHAIN = {
  /** Linear, ≈ -30 dBFS: quiet enough that ordinary speech opens it. */
  threshold: 0.03,
  /** ms. Fast enough to catch the front of a word, slow enough not to click. */
  attack: 20,
  /** ms. Long enough to ride over the pauses between syllables. */
  release: 350,
  /** The hardest squeeze the slider can ask for; 1 would be no duck at all. */
  maxRatio: 12,
} as const;

/**
 * Depth (0–1) as a compression ratio. Rounded at the point of generation like
 * every other number that reaches a filter graph, so two renders of the same
 * timeline produce byte-identical arguments.
 */
export function duckRatio(depth: number): number {
  const clamped = Math.max(0, Math.min(1, depth));
  return Math.round((1 + clamped * (DUCK_SIDECHAIN.maxRatio - 1)) * 1000) / 1000;
}
