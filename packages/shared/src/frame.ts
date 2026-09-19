import { z } from "zod";

/**
 * The shape of the finished film.
 *
 * Landscape is what the app assumed everywhere until now; portrait and square
 * exist because most of the footage arrives from a phone held upright and a
 * letterboxed 16:9 crop of it is mostly black.
 *
 * Format belongs to the vlog, not to the box: one server can be printing a
 * holiday film for a telly and a gig reel for a phone in the same afternoon.
 * Resolution stays the operator's (`app_settings.renderHeight`) — that's a
 * question about the machine, not about the film.
 */
export const VIDEO_FORMATS = ["landscape", "portrait", "square"] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];

export const DEFAULT_VIDEO_FORMAT: VideoFormat = "landscape";

export const videoFormatSchema = z.enum(VIDEO_FORMATS);

export const FORMAT_LABELS: Record<VideoFormat, string> = {
  landscape: "Wide",
  portrait: "Tall",
  square: "Square",
};

export const FORMAT_RATIOS: Record<VideoFormat, string> = {
  landscape: "16:9",
  portrait: "9:16",
  square: "1:1",
};

export const FORMAT_BLURBS: Record<VideoFormat, string> = {
  landscape: "For a telly or a laptop. The usual shape of a film.",
  portrait: "For a phone, held the way most of this was probably filmed.",
  square: "Splits the difference — fine anywhere, and nothing is badly out of shape.",
};

/** H.264 needs both dimensions even, and rounding down never overshoots the box. */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * The pixel frame for a format at the operator's chosen size.
 *
 * `renderHeight` used to be literally the frame height. It is read here as the
 * **shorter edge**, which leaves landscape exactly where it was (1080 → 1920×1080)
 * and gives the other two something sane rather than a portrait film that is
 * secretly 1.8× the pixels of the widescreen one: 1080 → 1080×1920 and 1080×1080.
 * The number still means "how hard is this box going to have to work", which is
 * the only reason the operator ever touches it.
 */
export function frameFor(format: VideoFormat, shortEdge: number): {
  width: number;
  height: number;
} {
  const short = even(shortEdge);
  const long = even((shortEdge * 16) / 9);
  switch (format) {
    case "portrait":
      return { width: short, height: long };
    case "square":
      return { width: short, height: short };
    default:
      return { width: long, height: short };
  }
}

/**
 * The frame the preview draws against: the same proportions the lab will use,
 * at a nominal 1080 short edge. The preview has never known the operator's
 * resolution — it only ever needed the shape, and a title's size is a fraction
 * of the frame either way.
 */
export function previewFrame(format: VideoFormat) {
  return frameFor(format, 1080);
}

/** `aspect-ratio` for the preview box, so CSS and FFmpeg agree on the shape. */
export function frameAspectCss(format: VideoFormat): string {
  const { width, height } = previewFrame(format);
  return `${width} / ${height}`;
}

/** "1080×1920 · tall" — the format as a consequence rather than a label. */
export function formatSummary(format: VideoFormat, shortEdge: number): string {
  const { width, height } = frameFor(format, shortEdge);
  return `${width}×${height} · ${FORMAT_LABELS[format].toLowerCase()}`;
}

/**
 * What a shot does when it isn't the shape of the film.
 *
 * Four friends' phones is the ordinary case here, not the edge one, so a
 * mismatch has to look like a decision rather than a fault.
 */
export const CLIP_FITS = ["bars", "fill", "blur"] as const;
export type ClipFit = (typeof CLIP_FITS)[number];

/**
 * What a clip *asks* for. `auto` is the default and is deliberately never
 * resolved into the document: `process-media` writes width and height some
 * seconds after the upload, so a clip can be in the cut before anyone knows
 * its shape. Baking a fit in at that moment would flip it when the probe
 * lands and churn a revision for every viewer. The document carries the
 * intent; `resolveFit` answers the question where the real dimensions are in
 * hand — in the render, and in the preview.
 */
export const CLIP_FIT_CHOICES = ["auto", ...CLIP_FITS] as const;
export type ClipFitChoice = (typeof CLIP_FIT_CHOICES)[number];

export const DEFAULT_FIT_POLICY: ClipFit = "blur";

export const FIT_LABELS: Record<ClipFitChoice, string> = {
  auto: "Follow the film",
  bars: "Black bars",
  fill: "Crop to fill",
  blur: "Blur the edges",
};

export const FIT_BLURBS: Record<ClipFitChoice, string> = {
  auto: "Whatever the rest of the film does with shots that aren't its shape.",
  bars: "Keeps the whole shot, with black down the empty sides.",
  fill: "Fills the frame by cropping in — you lose the edges of the shot.",
  blur: "Keeps the whole shot, with a soft blown-up copy of it filling the sides.",
};

/**
 * Turning footage the right way up.
 *
 * A defect correction, not an effect: WhatsApp strips the rotation flag, some
 * Android cameras never wrote one, a screen recording claims a shape it isn't.
 * Degrees clockwise, the way a person would say it.
 *
 * This belongs to the file, never to a clip. Trimming is a decision about one
 * appearance of a shot; "this one is sideways" is true of the shot everywhere
 * it turns up — as a clip, as a layer, and as the thumbnail on the light
 * table, which is where anybody actually notices.
 */
export const MEDIA_ROTATIONS = [0, 90, 180, 270] as const;
export type MediaRotation = (typeof MEDIA_ROTATIONS)[number];

export const mediaRotationSchema = z.union([
  z.literal(0),
  z.literal(90),
  z.literal(180),
  z.literal(270),
]);

/**
 * Whatever the column holds, brought back onto the four quarter turns. The
 * database column is a plain integer — nothing stops an older row, or a
 * hand-written UPDATE, from carrying something else.
 */
export function normalizeRotation(value: number | null | undefined): MediaRotation {
  const quarters = Math.round((value ?? 0) / 90);
  return MEDIA_ROTATIONS[((quarters % 4) + 4) % 4];
}

/** The next quarter turn clockwise — the whole of the control. */
export function nextRotation(value: number | null | undefined): MediaRotation {
  return normalizeRotation(normalizeRotation(value) + 90);
}

/**
 * What the shot measures once it is the right way up.
 *
 * A quarter turn swaps a shot's orientation, and orientation is what decides
 * bars against blur, how a layer's box proportions itself, and which way the
 * preview has to stand a picture up. One answer, so the lab and the bench
 * can't reach different ones.
 */
export function rotatedDimensions(
  width: number | null | undefined,
  height: number | null | undefined,
  rotation: number | null | undefined,
): { width: number | null | undefined; height: number | null | undefined } {
  return normalizeRotation(rotation) % 180 === 0 ? { width, height } : { width: height, height: width };
}

type Orientation = "landscape" | "portrait" | "square";

/**
 * A shot within 2% of square counts as square. Rotation metadata and a
 * "square" crop from a phone rarely land on exactly 1:1, and a one-pixel
 * difference deciding between a no-op and a blurred backdrop would be absurd.
 */
function orientationOf(width: number, height: number): Orientation {
  const ratio = width / height;
  if (ratio > 1.02) return "landscape";
  if (ratio < 0.98) return "portrait";
  return "square";
}

/**
 * Which fit a clip actually gets.
 *
 * An explicit choice always wins. `auto` asks one question — is this shot
 * pointing the same way as the film? — and answers `bars` when it is, because
 * bars on a matching shot cost nothing and touching the picture would be
 * gratuitous. Only a genuine mismatch is worth the film's policy.
 *
 * Unknown dimensions mean the probe hasn't landed yet, and the honest answer
 * to "what shape is this" is then "no idea": `bars` shows the whole frame and
 * crops nothing, so it's the one answer that can't be wrong in a way anybody
 * loses footage over.
 */
export function resolveFit(input: {
  clipWidth: number | null | undefined;
  clipHeight: number | null | undefined;
  /**
   * The file's manual rotation. Taken here rather than left to the callers,
   * because a quarter turn inverts the only question this function asks and
   * three separate call sites remembering to swap first is three chances for
   * an upright shot to get a blurred backdrop it doesn't need.
   */
  clipRotation?: number | null;
  frameWidth: number;
  frameHeight: number;
  fit: ClipFitChoice;
  policy: ClipFit;
}): ClipFit {
  if (input.fit !== "auto") return input.fit;

  const { width: clipWidth, height: clipHeight } = rotatedDimensions(
    input.clipWidth,
    input.clipHeight,
    input.clipRotation,
  );
  if (!clipWidth || !clipHeight || clipWidth <= 0 || clipHeight <= 0) return "bars";

  const clip = orientationOf(clipWidth, clipHeight);
  const frame = orientationOf(input.frameWidth, input.frameHeight);
  return clip === frame ? "bars" : input.policy;
}
