/**
 * Integration check for the render filter graph. Builds real graphs and runs
 * FFmpeg against generated test media. Not part of the app — run manually:
 *   pnpm --filter @vlogbuddy/worker exec tsx src/render-check.ts <mediaDir>
 */
import path from "node:path";
import { spawn } from "node:child_process";
import type { MediaItem } from "@vlogbuddy/db";
import { timelineDocSchema, type TimelineDoc } from "@vlogbuddy/shared";
import { buildFilterGraph } from "./jobs/render.js";
import { supportsDrawText } from "./ffmpeg.js";

const DIR = process.argv[2] ?? "/tmp/vbrender";

// The timeline schema requires real UUIDs for media references.
const ID = {
  p1: "11111111-1111-4111-8111-111111111111",
  p2: "22222222-2222-4222-8222-222222222222",
  v1: "33333333-3333-4333-8333-333333333333",
  v2: "44444444-4444-4444-8444-444444444444",
} as const;
const OUT = path.join(DIR, "out");

let failures = 0;

function media(id: string, kind: "photo" | "video", file: string, duration: number | null): MediaItem {
  return {
    id,
    vlogId: "v",
    uploaderId: null,
    kind,
    originalFilename: file,
    contentType: kind === "photo" ? "image/jpeg" : "video/mp4",
    sizeBytes: 1000,
    storageKey: file,
    proxyKey: null,
    thumbnailKey: null,
    width: null,
    height: null,
    durationSeconds: duration,
    capturedAt: null,
    uploadIndex: 0,
    status: "ready",
    error: null,
    createdAt: new Date(),
  } as MediaItem;
}

type Clip = TimelineDoc["clips"][number];

function clip(over: Partial<Clip> & Pick<Clip, "id" | "mediaItemId">): Clip {
  return {
    kind: "photo",
    trimStart: 0,
    trimEnd: null,
    duration: 3,
    transitionIn: "cut",
    transitionDuration: 0.5,
    volume: 1,
    muted: false,
    titles: [],
    ...over,
  };
}

async function runCase(
  name: string,
  timeline: TimelineDoc,
  mediaList: MediaItem[],
  files: Record<string, string>,
  audioPath: string | null,
) {
  const mediaById = new Map(mediaList.map((m) => [m.id, m]));
  const localPaths = new Map(Object.entries(files).map(([id, f]) => [id, path.join(DIR, f)]));

  const outFile = path.join(OUT, `${name}.mp4`);

  try {
    const { args, outputLabel, audioLabel } = buildFilterGraph({
      timeline,
      mediaById,
      localPaths,
      audioPath: audioPath ? path.join(DIR, audioPath) : null,
      width: 1280,
      height: 720,
      fps: 30,
      allowTitles: await supportsDrawText(),
      fontFile: process.env.FONT_PATH || null,
    });

    const full = [
      "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
      ...args,
      "-map", outputLabel,
      ...(audioLabel ? ["-map", audioLabel] : []),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p", "-r", "30",
      ...(audioLabel ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"]),
      "-movflags", "+faststart",
      outFile,
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", full, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(stderr.slice(-1500))),
      );
      child.on("error", reject);
    });

    // Verify the output actually decodes and has the expected streams.
    const probe = await new Promise<string>((resolve, reject) => {
      const child = spawn("ffprobe", [
        "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", outFile,
      ]);
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("close", () => resolve(out));
      child.on("error", reject);
    });

    const info = JSON.parse(probe);
    const v = info.streams?.find((s: { codec_type: string }) => s.codec_type === "video");
    const a = info.streams?.find((s: { codec_type: string }) => s.codec_type === "audio");
    const duration = Number(info.format?.duration ?? 0);

    const okDims = v?.width === 1280 && v?.height === 720;
    const okAudio = audioLabel ? Boolean(a) : true;

    console.log(
      `✓ ${name.padEnd(28)} ${v?.width}x${v?.height} ${duration.toFixed(2)}s ` +
        `${a ? "a/v" : "video-only"}${okDims ? "" : "  ⚠ WRONG DIMS"}${okAudio ? "" : "  ⚠ NO AUDIO"}`,
    );

    if (!okDims || !okAudio) failures++;
    return duration;
  } catch (err) {
    console.log(`✗ ${name.padEnd(28)}`);
    console.log((err as Error).message.split("\n").filter(Boolean).slice(-6).map((l) => `    ${l}`).join("\n"));
    failures++;
    return 0;
  }
}

async function main() {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(OUT, { recursive: true });

  const m = {
    p1: media(ID.p1, "photo", "photo1.jpg", null),
    p2: media(ID.p2, "photo", "photo2.jpg", null),
    v1: media(ID.v1, "video", "video1.mp4", 6),
    v2: media(ID.v2, "video", "video2_portrait.mp4", 5),
  };
  const files = {
    [ID.p1]: "photo1.jpg",
    [ID.p2]: "photo2.jpg",
    [ID.v1]: "video1.mp4",
    [ID.v2]: "video2_portrait.mp4",
  };

  const doc = (over: Partial<TimelineDoc>) =>
    timelineDocSchema.parse({ version: 1, clips: [], audio: [], duckClipAudio: true, ...over });

  console.log(`\nRendering test cases into ${OUT}\n`);

  // 1. Photos only, straight cuts.
  await runCase(
    "photos-cuts",
    doc({ clips: [clip({ id: "a", mediaItemId: ID.p1, duration: 2 }), clip({ id: "b", mediaItemId: ID.p2, duration: 2 })] }),
    [m.p1, m.p2], files, null,
  );

  // 2. Mixed photo + landscape + portrait video — the letterboxing path.
  await runCase(
    "mixed-orientation",
    doc({
      clips: [
        clip({ id: "a", mediaItemId: ID.p1, duration: 1.5 }),
        clip({ id: "b", mediaItemId: ID.v1, kind: "video", trimStart: 1, trimEnd: 3 }),
        clip({ id: "c", mediaItemId: ID.v2, kind: "video", trimStart: 0, trimEnd: 2 }),
      ],
    }),
    [m.p1, m.v1, m.v2], files, null,
  );

  // 3. Crossfades between everything.
  await runCase(
    "crossfades",
    doc({
      clips: [
        clip({ id: "a", mediaItemId: ID.p1, duration: 2 }),
        clip({ id: "b", mediaItemId: ID.v1, kind: "video", trimStart: 0, trimEnd: 3, transitionIn: "crossfade", transitionDuration: 1 }),
        clip({ id: "c", mediaItemId: ID.p2, duration: 2, transitionIn: "crossfade", transitionDuration: 0.5 }),
      ],
    }),
    [m.p1, m.v1, m.p2], files, null,
  );

  // 4. Titles burned in.
  await runCase(
    "titles",
    doc({
      clips: [
        clip({
          id: "a", mediaItemId: ID.p1, duration: 3,
          titles: [
            { id: "t1", text: "Ski trip 2026", start: 0, duration: 2, position: "bottom", fontSize: 56, color: "#ffffff" },
            { id: "t2", text: "Day 1: it's cold", start: 1, duration: 2, position: "top", fontSize: 36, color: "#ffdd00" },
          ],
        }),
        clip({ id: "b", mediaItemId: ID.v1, kind: "video", trimStart: 0, trimEnd: 2 }),
      ],
    }),
    [m.p1, m.v1], files, null,
  );

  // 5. Music bed mixed over clip audio, with ducking.
  await runCase(
    "music-bed-ducked",
    doc({
      clips: [
        clip({ id: "a", mediaItemId: ID.v1, kind: "video", trimStart: 0, trimEnd: 3 }),
        clip({ id: "b", mediaItemId: ID.p1, duration: 2 }),
      ],
      audio: [{ musicItemId: null, mediaItemId: null, offset: 0, startAt: 0, volume: 0.8, fadeIn: 1, fadeOut: 2 }],
      duckClipAudio: true,
    }),
    [m.v1, m.p1], files, "music.m4a",
  );

  // 6. Music shorter than the video — apad must cover the tail.
  await runCase(
    "music-plus-crossfade",
    doc({
      clips: [
        clip({ id: "a", mediaItemId: ID.p1, duration: 2 }),
        clip({ id: "b", mediaItemId: ID.v2, kind: "video", trimStart: 0, trimEnd: 3, transitionIn: "crossfade", transitionDuration: 0.8 }),
      ],
      audio: [{ musicItemId: null, mediaItemId: null, offset: 5, startAt: 0, volume: 0.6, fadeIn: 0.5, fadeOut: 1 }],
    }),
    [m.p1, m.v2], files, "music.m4a",
  );

  // 7. Muted clip.
  await runCase(
    "muted-clip",
    doc({ clips: [clip({ id: "a", mediaItemId: ID.v1, kind: "video", trimStart: 0, trimEnd: 2, muted: true })] }),
    [m.v1], files, null,
  );

  // 8. Single clip (no concat at all).
  await runCase(
    "single-clip",
    doc({ clips: [clip({ id: "a", mediaItemId: ID.p1, duration: 2 })] }),
    [m.p1], files, null,
  );

  // 9. Text with characters that break drawtext if unescaped.
  await runCase(
    "title-escaping",
    doc({
      clips: [
        clip({
          id: "a", mediaItemId: ID.p1, duration: 2,
          titles: [{ id: "t", text: "50% off: it's \"great\", right?", start: 0, duration: 2, position: "center", fontSize: 40, color: "#ffffff" }],
        }),
      ],
    }),
    [m.p1], files, null,
  );

  console.log(
    failures === 0
      ? "\nAll render cases produced valid MP4s.\n"
      : `\n${failures} render case(s) FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
