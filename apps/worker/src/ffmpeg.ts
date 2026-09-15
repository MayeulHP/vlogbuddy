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
  /**
   * The file's own display rotation, degrees clockwise on 0/90/180/270 — the
   * turn FFmpeg already applies on decode, which is why `width`/`height` above
   * are reported after it. This is *not* `media_items.rotation`, which is the
   * manual correction for files whose flag lies.
   */
  rotation: number;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; tags?: Record<string, string> };
}

/**
 * The last few lines of stderr that mean anything.
 *
 * FFmpeg writes its progress counter to stderr as carriage-returned chunks, so
 * the naive tail of a long run is a wall of `frame= … speed=` and nothing else:
 * whatever it said about the actual failure scrolled past minutes ago. Drop the
 * progress lines and keep the rest, which is where the reason lives.
 */
function meaningfulStderr(stderr: string, lines = 12): string {
  const kept = stderr
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(frame|size)=/.test(line));
  return kept.slice(-lines).join("\n");
}

/**
 * What to tell a human when the process didn't exit cleanly.
 *
 * A signal is not an exit code, and reporting it as one ("exited with code
 * null") throws away the single most useful fact about the failure. SIGKILL in
 * particular is almost never FFmpeg's own doing — on a box running other things
 * it means the kernel's OOM killer picked the biggest process, which FFmpeg
 * always is.
 */
function exitMessage(
  bin: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const detail = meaningfulStderr(stderr);
  const tail = detail ? `\n${detail}` : "";

  if (signal === "SIGKILL") {
    return (
      `${bin} was killed by the system (SIGKILL) — it ran out of memory. ` +
      `Lowering the export size or frame rate on /admin makes each pass cheaper.${tail}`
    );
  }
  if (signal) return `${bin} was stopped by ${signal}${tail}`;
  return `${bin} exited with code ${code}${tail}`;
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
    child.on("close", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(exitMessage(bin, code, signal, stderr)));
    });
  });
}

/**
 * How far the file says it is turned, in degrees clockwise.
 *
 * `side_data_list` is a list and the Display Matrix is not reliably first in
 * it: an iPhone HDR or recent Samsung clip carries Ambient Viewing Environment,
 * Content Light Level and Mastering Display entries ahead of it. Reading index
 * 0 therefore found no rotation at all on exactly the modern phone footage that
 * needed it, and the portrait clip was stored as 1920×1080 — which then made
 * `resolveFit` treat it as landscape and skip the fit policy entirely. Match on
 * the entry that actually carries the field instead of on its position.
 *
 * ffprobe reports the display matrix angle counter-clockwise (a portrait phone
 * clip is -90); the older `tags.rotate` spelling is already clockwise. Both are
 * normalised onto the same four quarter turns here.
 */
function displayRotation(video: FfprobeStream | undefined): number {
  const matrix = video?.side_data_list?.find(
    (entry) => typeof entry?.rotation === "number",
  );

  const degrees =
    matrix?.rotation !== undefined
      ? -matrix.rotation
      : Number(video?.tags?.rotate ?? video?.tags?.Rotate ?? 0);

  if (!Number.isFinite(degrees)) return 0;
  const quarters = Math.round(degrees / 90);
  return (((quarters % 4) + 4) % 4) * 90;
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

  const rotation = displayRotation(video);
  const sideways = rotation % 180 !== 0;

  return {
    durationSeconds: duration && Number.isFinite(duration) ? duration : null,
    // Swap dimensions when the video is rotated so portrait stays portrait.
    width: sideways ? video?.height ?? null : video?.width ?? null,
    height: sideways ? video?.width ?? null : video?.height ?? null,
    hasAudio,
    capturedAt,
    rotation,
  };
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
    : [
        "-i", input,
        "-vf", "scale=640:-2:force_original_aspect_ratio=decrease",
        "-q:v", "4",
        output,
      ];

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
 * Flatten a still into a JPEG a browser can paint.
 *
 * Tries FFmpeg first, because where the build has a HEIF demuxer this is one
 * process and no extra dependency. Alpine's ffmpeg does not, so it falls back
 * to `heif-convert` from libheif-tools — installed in the worker image for
 * exactly this. Both are best-effort: the caller treats "no still" as a photo
 * it cannot show, which is the honest outcome.
 *
 * `maxEdge` rather than a fixed width: these are phone photos in either
 * orientation, and a portrait shot scaled to a landscape width comes out
 * enormous.
 */
export async function generateDisplayImage(
  input: string,
  output: string,
  maxEdge = 2048,
): Promise<void> {
  const scale = `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease`;
  try {
    await ffmpeg(["-i", input, "-vf", scale, "-q:v", "3", output]);
    return;
  } catch (err) {
    try {
      await run("heif-convert", ["-q", "90", input, output]);
    } catch {
      // Report the original failure: "heif-convert not found" is a symptom,
      // and the ffmpeg error says what it actually made of the file.
      throw err;
    }
  }
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

/**
 * The contact sheet a video shows on the strip.
 *
 * One sprite rather than N files because the strip paints it as a repeating
 * background: the browser gets one request and one decode however far you zoom
 * in, and the mapping from time to pixels is arithmetic the CSS can do on its
 * own. `fps=1/interval` puts frame *i* at exactly `i * interval` seconds, which
 * is the contract the strip relies on to stay aligned while a shot is trimmed.
 */
export const FILMSTRIP_FRAME_HEIGHT = 160;
const FILMSTRIP_MAX_FRAMES = 40;

export interface FilmstripPlan {
  frames: number;
  intervalSeconds: number;
}

/**
 * How often to grab a frame, and how many.
 *
 * Never tighter than a second — a strip of near-identical frames costs the same
 * as a useful one — and never more than forty, so a two-hour clip doesn't turn
 * into a sprite nothing can decode.
 */
export function planFilmstrip(durationSeconds: number | null): FilmstripPlan | null {
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  const interval = Math.max(1, durationSeconds / FILMSTRIP_MAX_FRAMES);
  const frames = Math.max(1, Math.min(FILMSTRIP_MAX_FRAMES, Math.ceil(durationSeconds / interval)));
  return { frames, intervalSeconds: Math.round(interval * 1000) / 1000 };
}

export async function generateFilmstrip(
  input: string,
  output: string,
  plan: FilmstripPlan,
): Promise<void> {
  await ffmpeg([
    "-i", input,
    "-vf",
    `fps=1/${plan.intervalSeconds},scale=-2:${FILMSTRIP_FRAME_HEIGHT},tile=${plan.frames}x1`,
    "-frames:v", "1",
    "-q:v", "5",
    output,
  ]);
}

/** Peaks per second of audio. Six is dense enough to read as a shape at a glance. */
export const PEAKS_PER_SECOND = 6;

/** Mono at 8kHz is far more than a 30px-tall lane can show, and decodes fast. */
const PEAK_SAMPLE_RATE = 8000;

/**
 * The shape of a track, as a 0..1 envelope.
 *
 * Decoded to raw little-endian PCM and reduced here rather than read off
 * `astats`, because astats reports per-window statistics in a text format that
 * would have to be parsed and re-bucketed anyway — and the raw route gives
 * exactly the bucket size the lane wants.
 */
export async function audioPeaks(input: string): Promise<number[] | null> {
  const perBucket = Math.round(PEAK_SAMPLE_RATE / PEAKS_PER_SECOND);

  let pcm: Buffer;
  try {
    pcm = await runBinary(ffmpegBin(), [
      "-hide_banner", "-nostdin",
      "-i", input,
      "-vn",
      "-ac", "1",
      "-ar", String(PEAK_SAMPLE_RATE),
      "-f", "s16le",
      "-",
    ]);
  } catch (err) {
    console.warn(`[ffmpeg] peaks failed: ${(err as Error).message.split("\n")[0]}`);
    return null;
  }

  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  if (samples.length === 0) return null;

  const peaks: number[] = [];
  for (let i = 0; i < samples.length; i += perBucket) {
    let max = 0;
    for (let j = i; j < i + perBucket && j < samples.length; j++) {
      const value = Math.abs(samples[j]);
      if (value > max) max = value;
    }
    // 3dp, at the point of generation: these go into jsonb and a value that
    // doesn't round-trip would make every read look like a change.
    peaks.push(Math.round((max / 32768) * 1000) / 1000);
  }
  return peaks;
}

/** Like `run`, but for a process whose stdout is bytes rather than text. */
function runBinary(bin: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 100_000) stderr = stderr.slice(-50_000);
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(exitMessage(bin, code, signal, stderr)));
    });
  });
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
