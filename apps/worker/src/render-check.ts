/**
 * Integration check for the render filter graph. Builds real graphs and runs
 * FFmpeg against generated test media. Not part of the app — run manually:
 *   pnpm --filter @vlogbuddy/worker exec tsx src/render-check.ts <mediaDir>
 *
 * Generate the fixtures into that directory first (any real media of the right
 * shapes works; these are just deterministic):
 *
 *   D=/tmp/vbrender; mkdir -p $D/out; cd $D
 *   ffmpeg -y -f lavfi -i "testsrc=size=1920x1080:duration=1:rate=1" -frames:v 1 photo1.jpg
 *   ffmpeg -y -f lavfi -i "smptebars=size=1080x1440:duration=1:rate=1" -frames:v 1 photo2.jpg
 *   ffmpeg -y -f lavfi -i "testsrc=size=1280x720:duration=6:rate=30" \
 *          -f lavfi -i "sine=frequency=440:duration=6" \
 *          -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest video1.mp4
 *   ffmpeg -y -f lavfi -i "testsrc=size=720x1280:duration=5:rate=30" \
 *          -f lavfi -i "sine=frequency=320:duration=5" \
 *          -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest video2_portrait.mp4
 *   ffmpeg -y -f lavfi -i "testsrc=size=640x480:duration=4:rate=30" \
 *          -c:v libx264 -pix_fmt yuv420p -an video_silent.mp4
 *   ffmpeg -y -f lavfi -i "sine=frequency=220:duration=8" -c:a aac music.m4a
 *
 * The portrait and silent sources are not incidental: they are the two shapes
 * that break a filter graph written against the happy path.
 */
import path from "node:path";
import { spawn } from "node:child_process";
import type { MediaItem } from "@vlogbuddy/db";
import {
  TRANSITIONS,
  audioTrackSchema,
  emptyTimeline,
  layerClipSchema,
  reconcileClips,
  runDirector,
  timelineDocSchema,
  type CutEntry,
  type TimelineDoc,
} from "@vlogbuddy/shared";
import { buildFilterGraph } from "./jobs/render.js";
import { probe, supportsDrawText } from "./ffmpeg.js";

const DIR = process.argv[2] ?? "/tmp/vbrender";

// The timeline schema requires real UUIDs for media references.
const ID = {
  p1: "11111111-1111-4111-8111-111111111111",
  p2: "22222222-2222-4222-8222-222222222222",
  v1: "33333333-3333-4333-8333-333333333333",
  v2: "44444444-4444-4444-8444-444444444444",
  vs: "55555555-5555-4555-8555-555555555555", // video with NO audio track
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
type Layer = TimelineDoc["layers"][number];
type Track = TimelineDoc["audio"][number];

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
    auto: [],
    ...over,
  };
}

function layer(over: Partial<Layer> & Pick<Layer, "id" | "mediaItemId">): Layer {
  return layerClipSchema.parse({ kind: "photo", ...over });
}

function track(over: Partial<Track> = {}): Track {
  return audioTrackSchema.parse({ role: "bed", ...over });
}

/** Extracts a single frame as raw bytes, for comparing two renders. */
async function frameBytes(video: string, atSecond: number): Promise<Buffer | null> {
  const frame = `${video}.f${atSecond}.bmp`;
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(atSecond),
       "-i", video, "-frames:v", "1", frame],
      { stdio: "ignore" },
    );
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
  if (!ok) return null;

  const { readFile, unlink } = await import("node:fs/promises");
  try {
    const buf = await readFile(frame);
    await unlink(frame).catch(() => {});
    return buf;
  } catch {
    return null;
  }
}

/** Mean absolute difference between two frames of identical dimensions. */
function meanByteDelta(a: Buffer, b: Buffer): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / length;
}

async function runCase(
  name: string,
  timeline: TimelineDoc,
  mediaList: MediaItem[],
  files: Record<string, string>,
  audioPath: string | null,
  /** When set, assert that title text is actually visible at this timestamp. */
  expectTextAt?: number,
  /** When set, assert that a layer actually changes the frame at this timestamp. */
  expectLayerAt?: number,
) {
  const mediaById = new Map(mediaList.map((m) => [m.id, m]));
  const localPaths = new Map(Object.entries(files).map(([id, f]) => [id, path.join(DIR, f)]));

  // The real render probes each source for an audio stream; do the same here so
  // this exercises the same code path.
  const hasAudio = new Map<string, boolean>();
  for (const m of mediaList) {
    const local = localPaths.get(m.id);
    if (!local || m.kind !== "video") {
      hasAudio.set(m.id, false);
      continue;
    }
    const info = await probe(local).catch(() => null);
    hasAudio.set(m.id, info?.hasAudio ?? false);
  }

  // Every track in these fixtures points at the same generated file — what's
  // under test is the graph, not where the bytes came from.
  const audioPaths = new Map<string, string>();
  if (audioPath) {
    for (const t of timeline.audio) audioPaths.set(t.id, path.join(DIR, audioPath));
  }

  const outFile = path.join(OUT, `${name}.mp4`);

  try {
    const { args, outputLabel, audioLabel } = buildFilterGraph({
      timeline,
      mediaById,
      localPaths,
      hasAudio,
      audioPaths,
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

    /**
     * A valid MP4 isn't proof anything was drawn: drawtext can silently render
     * nothing, and a layer whose timestamps are wrong is simply never
     * composited. Re-render the same timeline with the feature removed and
     * compare a frame — matching bytes mean it never appeared.
     */
    async function renderVariant(suffix: string, variant: TimelineDoc, allowTitles: boolean) {
      const file = path.join(OUT, `${name}.${suffix}.mp4`);
      const g = buildFilterGraph({
        timeline: variant, mediaById, localPaths, hasAudio, audioPaths,
        width: 1280, height: 720, fps: 30,
        allowTitles,
        fontFile: process.env.FONT_PATH || null,
      });
      await new Promise<void>((resolve) => {
        const c = spawn("ffmpeg", [
          "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
          ...g.args, "-map", g.outputLabel,
          ...(g.audioLabel ? ["-map", g.audioLabel] : []),
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
          "-pix_fmt", "yuv420p", "-r", "30",
          ...(g.audioLabel ? ["-c:a", "aac"] : ["-an"]),
          file,
        ], { stdio: "ignore" });
        c.on("close", () => resolve());
        c.on("error", () => resolve());
      });
      return file;
    }

    async function assertDiffers(bare: string, at: number, what: string, minDelta = 0) {
      const [before, after] = await Promise.all([frameBytes(outFile, at), frameBytes(bare, at)]);
      if (!before || !after) return `  ⚠ COULD NOT COMPARE FRAMES`;
      // Byte equality is the right test when the two graphs are otherwise
      // identical (titles). Adding an overlay changes the encoder's decisions
      // everywhere, though, so a layer needs a threshold: without one, x264
      // noise alone would pass a layer that never drew.
      if (minDelta > 0) {
        if (meanByteDelta(before, after) < minDelta) return `  ⚠ ${what} NOT RENDERED`;
      } else if (before.equals(after)) {
        return `  ⚠ ${what} NOT RENDERED`;
      }
      return null;
    }

    let notes = "";
    let drewOk = true;

    if (expectTextAt !== undefined && (await supportsDrawText())) {
      const bare = await renderVariant("notitle", timeline, false);
      const problem = await assertDiffers(bare, expectTextAt, "TITLE");
      if (problem) {
        drewOk = false;
        notes += problem;
      } else {
        notes += "  title drawn ✓";
      }
    }

    if (expectLayerAt !== undefined) {
      const bare = await renderVariant("nolayer", { ...timeline, layers: [] }, await supportsDrawText());
      const problem = await assertDiffers(bare, expectLayerAt, "LAYER", 2);
      if (problem) {
        drewOk = false;
        notes += problem;
      } else {
        notes += "  layer composited ✓";
      }
    }

    console.log(
      `${drewOk ? "✓" : "✗"} ${name.padEnd(28)} ${v?.width}x${v?.height} ${duration.toFixed(2)}s ` +
        `${a ? "a/v" : "video-only"}${okDims ? "" : "  ⚠ WRONG DIMS"}` +
        `${okAudio ? "" : "  ⚠ NO AUDIO"}${notes}`,
    );

    if (!okDims || !okAudio || !drewOk) failures++;
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
    vs: media(ID.vs, "video", "video_silent.mp4", 4),
  };
  const files = {
    [ID.p1]: "photo1.jpg",
    [ID.p2]: "photo2.jpg",
    [ID.v1]: "video1.mp4",
    [ID.v2]: "video2_portrait.mp4",
    [ID.vs]: "video_silent.mp4",
  };

  const doc = (over: Partial<TimelineDoc>) =>
    timelineDocSchema.parse({ clips: [], layers: [], audio: [], duckClipAudio: true, ...over });

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
    1.2, // assert the title is actually visible here
  );

  // 5. Music bed mixed over clip audio, with ducking.
  await runCase(
    "music-bed-ducked",
    doc({
      clips: [
        clip({ id: "a", mediaItemId: ID.v1, kind: "video", trimStart: 0, trimEnd: 3 }),
        clip({ id: "b", mediaItemId: ID.p1, duration: 2 }),
      ],
      audio: [track({ volume: 0.8, fadeIn: 1, fadeOut: 2 })],
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
      audio: [track({ offset: 5, volume: 0.6, fadeIn: 0.5, fadeOut: 1 })],
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
    1.0, // "50% off: it's \"great\", right?" must actually render
  );

  // 10. Video with no audio track — must not break the graph.
  await runCase(
    "silent-video",
    doc({ clips: [clip({ id: "a", mediaItemId: ID.vs, kind: "video", trimStart: 0, trimEnd: 2 })] }),
    [m.vs], files, null,
  );

  // 11. Silent + audio video together, with a music bed over the top.
  await runCase(
    "silent-mixed-with-audio",
    doc({
      clips: [
        clip({ id: "a", mediaItemId: ID.vs, kind: "video", trimStart: 0, trimEnd: 2 }),
        clip({ id: "b", mediaItemId: ID.v1, kind: "video", trimStart: 0, trimEnd: 2, transitionIn: "crossfade", transitionDuration: 0.5 }),
      ],
      audio: [track({ volume: 0.7, fadeIn: 0.5, fadeOut: 1 })],
    }),
    [m.vs, m.v1], files, "music.m4a",
  );


  // 12. A still pinned over a video — the plain picture-in-picture path.
  await runCase(
    "layer-photo-over-video",
    doc({
      clips: [clip({ id: "a", mediaItemId: ID.v1, kind: "video", trimStart: 0, trimEnd: 4 })],
      layers: [
        layer({ id: "l1", mediaItemId: ID.p1, startAt: 1, duration: 2, x: 0.6, y: 0.08, width: 0.3 }),
      ],
    }),
    [m.v1, m.p1], files, null,
    undefined,
    2, // the still must actually be on screen here
  );

  // 13. Two layers at once, stacked, one of them half-transparent and
  //     full-frame — the compositing order has to survive both.
  await runCase(
    "layers-stacked",
    doc({
      clips: [clip({ id: "a", mediaItemId: ID.p2, duration: 4 })],
      layers: [
        layer({ id: "l1", mediaItemId: ID.v2, kind: "video", layer: 1, startAt: 0.5, duration: 2.5, x: 0.05, y: 0.5, width: 0.4 }),
        layer({ id: "l2", mediaItemId: ID.p1, layer: 2, startAt: 0, duration: 4, x: 0, y: 0, width: 1, opacity: 0.4, fadeIn: 0.5, fadeOut: 0.5 }),
      ],
    }),
    [m.p2, m.v2, m.p1], files, null,
    undefined,
    1.5,
  );

  // 14. An audible video layer over a video with its own sound, under a bed:
  //     three things in the mix at once.
  await runCase(
    "layer-audio-in-mix",
    doc({
      clips: [clip({ id: "a", mediaItemId: ID.v1, kind: "video", trimStart: 0, trimEnd: 5 })],
      layers: [
        layer({ id: "l1", mediaItemId: ID.v2, kind: "video", startAt: 1, duration: 2, muted: false, volume: 0.9 }),
      ],
      audio: [track({ volume: 0.5, fadeIn: 0.5, fadeOut: 1 })],
    }),
    [m.v1, m.v2], files, "music.m4a",
  );

  // 15. Two music cues, the second starting partway in and stopping early.
  await runCase(
    "two-audio-cues",
    doc({
      clips: [
        clip({ id: "a", mediaItemId: ID.p1, duration: 3 }),
        clip({ id: "b", mediaItemId: ID.p2, duration: 3 }),
      ],
      audio: [
        track({ volume: 0.5, fadeIn: 0.5, fadeOut: 1, loop: true }),
        track({ role: "extra", startAt: 2.5, duration: 2, offset: 1, volume: 0.7, fadeIn: 0.3, fadeOut: 0.5 }),
      ],
    }),
    [m.p1, m.p2], files, "music.m4a",
  );

  // 16. A layer hanging off the end of the picture — it has to be clipped, not
  //     allowed to stretch the film.
  await runCase(
    "layer-past-the-end",
    doc({
      clips: [clip({ id: "a", mediaItemId: ID.p1, duration: 2 })],
      layers: [layer({ id: "l1", mediaItemId: ID.p2, startAt: 1.5, duration: 6, width: 0.5 })],
    }),
    [m.p1, m.p2], files, null,
    undefined,
    1.8, // still inside the clipped window
  );

  // 17. Every transition in the library, chained. The point is not the
  // pictures — it's that each name in XFADE_FOR is a filter FFmpeg actually
  // has. A typo there fails only at render time, on a real vlog.
  await runCase(
    "transition-library",
    doc({
      clips: TRANSITIONS.map((transitionIn, i) =>
        clip({
          id: `t${i}`,
          mediaItemId: i % 2 === 0 ? ID.p1 : ID.p2,
          duration: 1.2,
          transitionIn,
          transitionDuration: 0.4,
        }),
      ),
    }),
    [m.p1, m.p2], files, null,
  );

  // 18. A hard cut followed by a dissolve — the auto-cut's basic grammar, and
  // a graph shape nothing else here produced. `concat` returns its output at
  // timebase 1/1000000, and `xfade` rejects inputs whose timebases disagree,
  // so this fails outright without the `settb` in the clip chain.
  await runCase(
    "cut-then-dissolve",
    doc({
      clips: [
        clip({ id: "a", mediaItemId: ID.p1, duration: 1.5 }),
        clip({ id: "b", mediaItemId: ID.v1, kind: "video", trimStart: 0.8, trimEnd: 3, transitionIn: "cut" }),
        clip({ id: "c", mediaItemId: ID.p2, duration: 2, transitionIn: "crossfade", transitionDuration: 0.6 }),
      ],
    }),
    [m.p1, m.v1, m.p2], files, null,
  );

  // 19. The auto-cut's own output, end to end. The graph this produces is the
  // one most renders will actually use — short holds, a scene dissolve, a
  // sub-2s clip muted by the director — so it has to build for real rather
  // than only in the unit sense.
  const T0 = Date.UTC(2026, 5, 13, 9, 30);
  const autoCut: CutEntry[] = [
    { mediaItemId: ID.p1, kind: "photo", durationSeconds: null, capturedAt: T0, rank: 0 },
    { mediaItemId: ID.v1, kind: "video", durationSeconds: 6, capturedAt: T0 + 60_000, rank: 3.5 },
    { mediaItemId: ID.p2, kind: "photo", durationSeconds: null, capturedAt: T0 + 120_000, rank: 0 },
    // Hours later: a new scene, so the director dissolves into it.
    { mediaItemId: ID.v2, kind: "video", durationSeconds: 5, capturedAt: T0 + 5 * 3600_000, rank: 0 },
  ];
  const directed = runDirector(reconcileClips(emptyTimeline(), autoCut), {
    cut: autoCut,
    threshold: 0,
    settings: { enabled: true, pace: "snappy", sceneText: true },
  });
  await runCase("director-output", directed, [m.p1, m.v1, m.p2, m.v2], files, null);

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
