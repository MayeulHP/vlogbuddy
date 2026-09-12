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

  const rotation = Math.abs(video?.side_data_list?.[0]?.rotation ?? 0) % 180;

  return {
    durationSeconds: duration && Number.isFinite(duration) ? duration : null,
    // Swap dimensions when the video is rotated so portrait stays portrait.
    width: rotation === 90 ? video?.height ?? null : video?.width ?? null,
    height: rotation === 90 ? video?.width ?? null : video?.height ?? null,
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
