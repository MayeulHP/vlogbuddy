/** Lifecycle of a vlog. Phases move forward; the creator can step back one. */
export const VLOG_STATES = [
  "open", // friends upload, add music, react/vote
  "curate", // pick finalists + lock rough chronological order
  "edit", // collaborative assemble/trim editor
  "export", // rendering
  "published", // done, downloadable
] as const;
export type VlogState = (typeof VLOG_STATES)[number];

export const VLOG_STATE_LABELS: Record<VlogState, string> = {
  open: "Dump & vote",
  curate: "Curate",
  edit: "Edit",
  export: "Rendering",
  published: "Published",
};

/**
 * Reactions double as a score. Three tiers, ascending, so the dump view can
 * rank items organically without anyone doing bookkeeping.
 */
export const REACTION_SCORES = [1, 2, 3] as const;
export type ReactionScore = (typeof REACTION_SCORES)[number];

export interface ReactionTier {
  score: ReactionScore;
  emoji: string;
  label: string;
}

export const DEFAULT_REACTIONS: ReactionTier[] = [
  { score: 1, emoji: "🙂", label: "Good" },
  { score: 2, emoji: "🔥", label: "Great" },
  { score: 3, emoji: "🤩", label: "Excellent" },
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

/** Photos have no intrinsic duration; this is how long they hold on screen. */
export const DEFAULT_PHOTO_DURATION = 3;
export const DEFAULT_TRANSITION_DURATION = 0.5;

export const ACCEPTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/avif",
];

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
