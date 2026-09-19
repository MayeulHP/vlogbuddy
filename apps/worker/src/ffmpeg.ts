import { spawn } from "node:child_process";

/**
 * Binary paths are read straight from the environment rather than through the
 * validated config, so this module stays usable without database/storage
 * settings — capability probes and the render-check tool don't need them.
 */
const ffmpegBin = () => process.env.FFMPEG_PATH || "ffmpeg";
const ffprobeBin = () => process.env.FFPROBE_PATH || "ffprobe";

export interface ProbeResult {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  /** From container/EXIF metadata — used for chronological ordering. */
  capturedAt: Date | null;
  /** Decimal degrees from the container's ISO 6709 tag, when it carries one. */
  latitude: number | null;
  longitude: number | null;
  rotation: number;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; tags?: Record<string, string> };
}

function run(
  bin: string,
  args: string[],
  onStderr?: (chunk: string) => void,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      onStderr?.(chunk);
      // Keep memory bounded on very long renders.
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin} exited with code ${code}\n${stderr.slice(-4000)}`));
    });
  });
}

export async function probe(filePath: string): Promise<ProbeResult> {
  const { stdout } = await run(ffprobeBin(), [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);

  const data = JSON.parse(stdout) as FfprobeOutput;
  const video = data.streams?.find((s) => s.codec_type === "video");
  const hasAudio = Boolean(data.streams?.some((s) => s.codec_type === "audio"));

  const duration = data.format?.duration ? Number(data.format.duration) : null;

  // Capture time hides in different tags depending on the camera/phone.
  const tags = { ...data.format?.tags, ...video?.tags };
  const dateString =
    tags?.creation_time ??
    tags?.["com.apple.quicktime.creationdate"] ??
    tags?.date ??
    tags?.DateTimeOriginal ??
    null;

  let capturedAt: Date | null = null;
  if (dateString) {
    const parsed = new Date(dateString);
    if (!Number.isNaN(parsed.getTime())) capturedAt = parsed;
  }

  /**
   * The Display Matrix is not reliably the first side-datum.
   *
   * A recent iPhone or Samsung files Ambient Viewing Environment ahead of it,
   * and reading `[0]` then finds no rotation at all — so a portrait clip is
   * stored as landscape, and every frame of it is letterboxed on its side for
   * the rest of the vlog's life. Match on the entry that carries the field.
   */
  const rotation =
    Math.abs(
      video?.side_data_list?.find((entry) => typeof entry.rotation === "number")?.rotation ?? 0,
    ) % 180;

  // An iPhone files the fix under the QuickTime key; everything else that
  // bothers writes the bare `©xyz` atom, which FFmpeg surfaces as `location`.
  const where = parseIso6709(
    tags?.["com.apple.quicktime.location.ISO6709"] ?? tags?.location ?? null,
  );

  return {
    durationSeconds: duration && Number.isFinite(duration) ? duration : null,
    // Swap dimensions when the video is rotated so portrait stays portrait.
    width: rotation === 90 ? video?.height ?? null : video?.width ?? null,
    height: rotation === 90 ? video?.width ?? null : video?.height ?? null,
    hasAudio,
    capturedAt,
    latitude: where?.latitude ?? null,
    longitude: where?.longitude ?? null,
    rotation,
  };
}

/**
 * ISO 6709 point strings, as QuickTime carries them: `+48.8582+002.2945/`,
 * optionally with an altitude and a CRS suffix.
 *
 * Each field is sign-prefixed and fixed-width, and the width is the only thing
 * that says whether the digits are degrees, degrees+minutes or
 * degrees+minutes+seconds — latitude takes 2 leading digits for plain degrees,
 * longitude 3. Apple only ever writes the plain form, but the sexagesimal
 * spellings are legal and cost two lines to honour.
 */
export function parseIso6709(
  value: string | null | undefined,
): { latitude: number; longitude: number } | null {
  if (!value) return null;

  const fields = value.match(/[+-]\d+(?:\.\d+)?/g);
  if (!fields || fields.length < 2) return null;

  const latitude = sexagesimalToDegrees(fields[0], 2);
  const longitude = sexagesimalToDegrees(fields[1], 3);
  if (latitude === null || longitude === null) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  return { latitude, longitude };
}

function sexagesimalToDegrees(field: string, degreeDigits: number): number | null {
  const sign = field.startsWith("-") ? -1 : 1;
  const digits = field.slice(1);
  const whole = digits.split(".")[0] ?? "";

  // Anything beyond the degrees field is packed minutes, then seconds.
  const minutes = whole.length >= degreeDigits + 2 ? degreeDigits : 0;
  const seconds = whole.length >= degreeDigits + 4 ? degreeDigits + 2 : 0;

  const d = Number(minutes ? digits.slice(0, degreeDigits) : digits);
  const m = minutes ? Number(seconds ? digits.slice(minutes, seconds) : digits.slice(minutes)) : 0;
  const s = seconds ? Number(digits.slice(seconds)) : 0;
  if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(s)) return null;

  return sign * (d + m / 60 + s / 3600);
}

/**
 * Runs FFmpeg, reporting progress as a 0..1 fraction parsed from its own
 * time output.
 */
export async function ffmpeg(
  args: string[],
  opts: { totalDuration?: number; onProgress?: (fraction: number) => void } = {},
): Promise<void> {
  const { totalDuration, onProgress } = opts;

  await run(ffmpegBin(), ["-hide_banner", "-nostdin", "-y", ...args], (chunk) => {
    if (!totalDuration || !onProgress) return;
    // e.g. "time=00:01:23.45"
    const match = chunk.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
    if (!match) return;
    const seconds =
      Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    onProgress(Math.max(0, Math.min(1, seconds / totalDuration)));
  });
}

/**
 * Scaling a still has to go through `-filter_complex`, not `-vf`.
 *
 * A HEIC is often stored as a grid of 512px tiles, and FFmpeg stitches those
 * with a complex filtergraph of its own making. `-vf` on a stream already fed
 * by one is a hard error ("Simple and complex filtering cannot be used
 * together"), so every iPhone photo written as a grid failed here. Stated as a
 * complex graph it works for tiled and untiled input alike, so there is no
 * reason to keep two spellings.
 */
function stillImageArgs(input: string, filter: string, quality: string, output: string): string[] {
  return [
    "-i", input,
    "-filter_complex", filter,
    "-frames:v", "1",
    // Without this the image2 muxer complains that the name has no sequence
    // pattern; it writes the frame anyway, but the warning is pure noise.
    "-update", "1",
    "-q:v", quality,
    output,
  ];
}

/** Single frame for the dump-view grid. */
export async function generateThumbnail(
  input: string,
  output: string,
  isVideo: boolean,
  atSecond = 1,
): Promise<void> {
  const args = isVideo
    ? [
        // Seek before input for speed; clamp so short clips still yield a frame.
        "-ss", String(atSecond),
        "-i", input,
        "-frames:v", "1",
        "-vf", "scale=640:-2:force_original_aspect_ratio=decrease",
        "-q:v", "4",
        output,
      ]
    : stillImageArgs(input, "scale=640:-2:force_original_aspect_ratio=decrease", "4", output);

  try {
    await ffmpeg(args);
  } catch (err) {
    // A video shorter than `atSecond` yields no frame — retry at the very start.
    if (isVideo && atSecond > 0) {
      await ffmpeg([
        "-i", input,
        "-frames:v", "1",
        "-vf", "scale=640:-2:force_original_aspect_ratio=decrease",
        "-q:v", "4",
        output,
      ]);
      return;
    }
    throw err;
  }
}

/**
 * Long edge of a photo proxy. Generous enough that a lightbox on a retina
 * screen still looks like the photograph, and about a twentieth of the pixels
 * of a 48MP original.
 */
export const PHOTO_PROXY_MAX_EDGE = 2560;

/**
 * A JPEG the browser can actually paint.
 *
 * Nothing but Safari renders HEIC, so an iPhone photo is invisible in the pile,
 * the editor and the preview until we hand it over as something else. The same
 * pass caps the frame, which is what keeps a 48MP original from being
 * downloaded whole into a preview that shows it 800px wide.
 *
 * `min(iw, …)` rather than a flat scale so this only ever shrinks: a small
 * photo is left at its own size instead of being blown up into a bigger file
 * than the original. `force_divisible_by=2` keeps the dimensions even, which
 * yuvj420p requires.
 */
export async function generatePhotoProxy(input: string, output: string): Promise<void> {
  const cap = PHOTO_PROXY_MAX_EDGE;
  await ffmpeg(
    stillImageArgs(
      input,
      `scale=w=min(iw\\,${cap}):h=min(ih\\,${cap}):` +
        "force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p",
      "3",
      output,
    ),
  );
}

/**
 * Low-res proxy so scrubbing in the editor doesn't stream multi-GB originals
 * to every browser.
 */
export async function generateProxy(input: string, output: string): Promise<void> {
  await ffmpeg([
    "-i", input,
    "-vf", "scale=-2:480",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "28",
    "-c:a", "aac",
    "-b:a", "96k",
    "-movflags", "+faststart",
    output,
  ]);
}

export async function extractAudioTrack(input: string, output: string): Promise<void> {
  await ffmpeg(["-i", input, "-vn", "-c:a", "aac", "-b:a", "192k", output]);
}

/**
 * drawtext needs FFmpeg built with libfreetype. Some builds (notably plain
 * Homebrew) omit it, which would otherwise fail an entire render just because
 * someone added a title. We detect it once and degrade gracefully instead.
 */
let drawTextSupport: boolean | null = null;

export async function supportsDrawText(): Promise<boolean> {
  if (drawTextSupport !== null) return drawTextSupport;

  try {
    const { stdout } = await run(ffmpegBin(), ["-hide_banner", "-filters"]);
    drawTextSupport = /\bdrawtext\b/.test(stdout);
    if (!drawTextSupport) {
      console.warn(
        "[ffmpeg] this build has no drawtext filter (missing libfreetype) — " +
          "titles will be skipped in renders",
      );
    }
  } catch (err) {
    // Don't let an unrelated failure masquerade as "no drawtext".
    drawTextSupport = false;
    console.warn(
      `[ffmpeg] could not probe filters (${(err as Error).message.split("\n")[0]}) — ` +
        "assuming no drawtext; titles will be skipped",
    );
  }

  return drawTextSupport;
}

/**
 * Escapes user text for drawtext, which is fussy about quoting.
 *
 * The result is wrapped in single quotes by the caller, which protects commas
 * and other filtergraph separators. Remaining concerns:
 *  - backslash and colon still need escaping inside the quotes
 *  - a literal `'` would terminate the quoted string, so we swap in a
 *    typographic apostrophe (visually identical, avoids the problem entirely)
 *
 * `%` is deliberately NOT escaped: the caller sets `expansion=none`, which
 * disables text expansion. Escaping it there would render a literal backslash.
 */
export function escapeDrawText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019")
    .replace(/[\r\n]+/g, " ");
}
