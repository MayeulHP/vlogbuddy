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
  gather: "Trip",
  edit: "Film",
  watch: "Watch",
};

/**
 * Reel numbers stand in for icons on the cover. The rail doesn't use them:
 * R1/R2/R3 is one more thing to decode before you can click the right room.
 */
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
  { id: "final", label: "Watch", blurb: "Screen it, download it, send it round" },
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
  /**
   * The mark itself. Still called `emoji` because it is a stored column shape
   * (`vlogs.reaction_tiers`) and renaming it would need a migration for no
   * gain — but it must never be one: a colour emoji renders differently on
   * every platform and carries a mood nobody chose. Text glyphs only.
   */
  emoji: string;
  label: string;
}

/**
 * Grease-pencil marks, not emoji and not karma.
 *
 * Three *kinds* of mark rather than a tally of one: a run of dots read as a
 * one-to-three star rating, and at thumbnail size ●● and ●●● were the same
 * smudge. A tick, a star and a burst are distinguishable at 9px, are text
 * glyphs in every system font, and still climb — the burst is the one you
 * only draw a few times on a reel.
 *
 * `\uFE0E` pins text presentation: a bare star is emoji-styled by some
 * Android and Windows fallbacks, which is exactly the platform drift the
 * earlier emoji version had.
 */
export const DEFAULT_REACTIONS: ReactionTier[] = [
  { score: 1, emoji: "\u2713\uFE0E", label: "Keep" },
  { score: 2, emoji: "\u2605\uFE0E", label: "Strong" },
  { score: 3, emoji: "\u2726\uFE0E", label: "Hero" },
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

/**
 * A grade, named for what it does to a holiday rather than for the filter that
 * makes it. Five is the whole list on purpose: a look is a decision taken in
 * two seconds from a row of chips, and a wall of forty is a colour suite.
 */
export const CLIP_LOOKS = ["none", "warm", "cool", "faded", "mono", "punchy"] as const;
export type ClipLook = (typeof CLIP_LOOKS)[number];

export const LOOK_LABELS: Record<ClipLook, string> = {
  none: "As shot",
  warm: "Warm",
  cool: "Cool",
  faded: "Faded",
  mono: "Mono",
  punchy: "Punchy",
};

export const LOOK_BLURBS: Record<ClipLook, string> = {
  none: "Whatever the camera made of it.",
  warm: "Late afternoon, everywhere.",
  cool: "Cold light. Morning, water, glass.",
  faded: "Lifted blacks, like an old print.",
  mono: "Black and white.",
  punchy: "Harder contrast, louder colour.",
};

/**
 * What each look compiles to in FFmpeg. The single place a colour filter name
 * is spelled — `LOOK_CSS` beside it is the browser's *approximation* of the
 * same grade for the preview, and the two will never match exactly (CSS has no
 * curves and its sepia isn't a colour balance). Close enough to choose by is
 * the bar; the print is the truth.
 */
export const LOOK_FILTERS: Record<ClipLook, string | null> = {
  none: null,
  warm: "eq=saturation=1.15,colorbalance=rs=0.08:gs=0.02:bs=-0.08",
  cool: "colorbalance=rs=-0.06:bs=0.10,eq=saturation=1.05",
  faded: "curves=all='0/0.06 0.5/0.5 1/0.95',eq=saturation=0.80:contrast=0.92",
  mono: "hue=s=0,eq=contrast=1.08",
  punchy: "eq=contrast=1.18:saturation=1.30:gamma=0.98",
};

/** The preview's stand-in for `LOOK_FILTERS`. An approximation — see above. */
export const LOOK_CSS: Record<ClipLook, string | null> = {
  none: null,
  warm: "saturate(1.15) sepia(0.18) hue-rotate(-8deg)",
  cool: "saturate(1.05) hue-rotate(8deg) brightness(1.02)",
  faded: "contrast(0.92) saturate(0.8) brightness(1.06)",
  mono: "grayscale(1) contrast(1.08)",
  punchy: "contrast(1.18) saturate(1.3)",
};

/**
 * How far a shot can be pushed either way. Beyond 4× a phone clip is a smear,
 * and below a quarter FFmpeg's `atempo` chain gets silly; both ends are also
 * what the schema clamps to.
 */
export const MIN_CLIP_SPEED = 0.25;
export const MAX_CLIP_SPEED = 4;

/** Does this transition overlap the shot before it? */
export function overlapsPrevious(transition: Transition): boolean {
  return XFADE_FOR[transition] !== null;
}

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
export const AUTO_FIELDS = ["timing", "transition", "title", "audio"] as const;
export type AutoField = (typeof AUTO_FIELDS)[number];

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
