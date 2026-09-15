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
import { planRender, type RenderPlan } from "./jobs/render.js";
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

/**
 * Dimensions default to null, which is what an item looks like between the
 * upload and the probe — and what makes `auto` resolve to bars. The fit cases
 * below pass the real ones, because that is the only way `auto` ever reaches
 * the film's policy.
 */
function media(
  id: string,
  kind: "photo" | "video",
  file: string,
  duration: number | null,
  dims: { width: number; height: number } | null = null,
  /** Degrees clockwise, as a person would say it — the manual correction. */
  rotation = 0,
): MediaItem {
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
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    rotation,
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
    fit: "auto",
    speed: 1,
    look: "none",
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

/**
 * Runs a plan the way the worker does: write its files, then every pass in
 * order. A pass that fails takes its label with it — "shot 3 of 14" is a far
 * better start than a filtergraph error on its own.
 */
async function runPlan(plan: RenderPlan): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.dirname(plan.outputPath), { recursive: true });
  for (const file of plan.files) await writeFile(file.path, file.contents);

  for (const pass of plan.passes) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "ffmpeg",
        ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", ...pass.args],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (code, signal) =>
        code === 0
          ? resolve()
          : reject(new Error(`${pass.label} — ${signal ?? `exit ${code}`}\n${stderr.slice(-1200)}`)),
      );
      child.on("error", reject);
    });
  }
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
  /** The output frame. Defaults to the 16:9 shape most cases here render in. */
  frame: { width: number; height: number } = { width: 1280, height: 720 },
  /** When set, assert the fit actually changed the picture at this timestamp. */
  expectFitAt?: number,
  /** When set, assert the manual rotation actually turned the picture. */
  expectRotationAt?: number,
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

  /**
   * Each render gets its own working directory, because a plan leaves its
   * pieces next to the film it made and two cases would otherwise join each
   * other's reels.
   */
  const planFor = async (
    suffix: string,
    variant: TimelineDoc,
    allowTitles: boolean,
    variantMedia: Map<string, MediaItem> = mediaById,
  ) =>
    planRender({
      timeline: variant,
      mediaById: variantMedia,
      localPaths,
      hasAudio,
      audioPaths,
      width: frame.width,
      height: frame.height,
      fps: 30,
      allowTitles,
      fontFile: process.env.FONT_PATH || null,
      workDir: path.join(OUT, suffix ? `${name}.${suffix}` : name),
      // Fast and rough: what's under test is the graph, not the picture.
      encode: { crf: 28, preset: "ultrafast", threads: 0 },
    });

  try {
    const main = await planFor("", timeline, await supportsDrawText());
    await runPlan(main);
    const outFile = main.outputPath;

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

    const okDims = v?.width === frame.width && v?.height === frame.height;
    // Every film gets a sound track, even a silent one — the base track's own
    // audio is built whether or not anything in the cut can be heard.
    const okAudio = Boolean(a);

    /**
     * A valid MP4 isn't proof anything was drawn: drawtext can silently render
     * nothing, and a layer whose timestamps are wrong is simply never
     * composited. Re-render the same timeline with the feature removed and
     * compare a frame — matching bytes mean it never appeared.
     */
    async function renderVariant(
      suffix: string,
      variant: TimelineDoc,
      allowTitles: boolean,
      /** Rotation lives on the media, so one variant has to vary that instead. */
      variantMedia: Map<string, MediaItem> = mediaById,
    ) {
      const plan = await planFor(suffix, variant, allowTitles, variantMedia);
      // A variant that won't build is a failure of the comparison, not of the
      // case: the frame check below reports it as "could not compare".
      await runPlan(plan).catch(() => {});
      return plan.outputPath;
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

    /**
     * A fill or a blur that silently fell back to bars still makes a valid
     * MP4 of the right size. The only proof is the picture: render the same
     * film with every shot pinned to bars and demand the frames differ.
     */
    if (expectFitAt !== undefined) {
      const bars = await renderVariant(
        "bars",
        {
          ...timeline,
          clips: timeline.clips.map((c) => ({ ...c, fit: "bars" as const })),
          director: { ...timeline.director, fitPolicy: "bars" as const },
        },
        await supportsDrawText(),
      );
      const problem = await assertDiffers(bars, expectFitAt, "FIT", 2);
      if (problem) {
        drewOk = false;
        notes += problem;
      } else {
        notes += "  fit applied ✓";
      }
    }

    /**
     * A transpose that never made it into the graph leaves a perfectly good
     * MP4 of a sideways shot. Re-render with every file's rotation cleared and
     * demand the picture changed — which also pins the other half of the
     * contract: with rotation at 0 the graph must be the one it always was.
     */
    if (expectRotationAt !== undefined) {
      const straight = new Map(
        [...mediaById].map(([id, m]) => [id, { ...m, rotation: 0 } as MediaItem]),
      );
      const upright = await renderVariant(
        "unrotated", timeline, await supportsDrawText(), straight,
      );
      const problem = await assertDiffers(upright, expectRotationAt, "ROTATION", 2);
      if (problem) {
        drewOk = false;
        notes += problem;
      } else {
        notes += "  rotation applied ✓";
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

  /**
   * The same two landscape sources, but probed — so `auto` can see they point
   * the other way to an upright frame. Same files, same ids: only what the
   * database knows about them differs.
   */
  const probed = {
    p1: media(ID.p1, "photo", "photo1.jpg", null, { width: 1920, height: 1080 }),
    v1: media(ID.v1, "video", "video1.mp4", 6, { width: 1280, height: 720 }),
  };
  /**
   * The same landscape photo, declared sideways — a file whose rotation
   * metadata lies, which is the only reason this feature exists.
   */
  const turned = {
    p1: media(ID.p1, "photo", "photo1.jpg", null, { width: 1920, height: 1080 }, 90),
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

  /**
   * 4b. A title on a shot that is dissolved into.
   *
   * A title's times are relative to its own clip, but the dissolve is printed as
   * a piece of its own covering the head of that clip, so the shot's own piece
   * starts 0.8s in and its `t` starts again at zero. A title that hasn't moved
   * with the piece therefore comes up 0.8s late — or not at all, if the clip
   * ends first.
   *
   * The film is a(2) + dissolve(0.8) + b: the dissolve runs 1.2 → 2.0 and b's
   * own piece from 2.0. The title is set 1s into b, which is 2.2s into the film,
   * so it must be on screen at 2.5 — and would not be without the shift.
   */
  await runCase(
    "title-after-dissolve",
    doc({
      clips: [
        clip({ id: "a", mediaItemId: ID.p1, duration: 2 }),
        clip({
          id: "b", mediaItemId: ID.p2, duration: 2,
          transitionIn: "crossfade", transitionDuration: 0.8,
          titles: [
            { id: "t", text: "Still here", start: 1, duration: 1, position: "center", fontSize: 64, color: "#ffffff" },
          ],
        }),
      ],
    }),
    [m.p1, m.p2], files, null,
    2.5,
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
    settings: { enabled: true, pace: "snappy", sceneText: true, beatSnap: false, fitPolicy: "blur" },
  });
  await runCase("director-output", directed, [m.p1, m.v1, m.p2, m.v2], files, null);

  /**
   * 20. The same film in an upright frame. Nothing in the graph is written for
   * a shape, but that's easy to say and hard to believe: this mixes landscape
   * stills, a landscape video and a portrait video into 720×1280, with a layer
   * over the top whose geometry is fractions of a frame that is now taller than
   * it is wide.
   */
  await runCase(
    "portrait-frame",
    doc({
      clips: [
        clip({ id: "a", mediaItemId: ID.p1, duration: 1.5 }),
        clip({ id: "b", mediaItemId: ID.v1, kind: "video", trimStart: 0, trimEnd: 2 }),
        clip({ id: "c", mediaItemId: ID.v2, kind: "video", trimStart: 0, trimEnd: 2, transitionIn: "crossfade", transitionDuration: 0.5 }),
      ],
      layers: [layer({ id: "l1", mediaItemId: ID.p2, startAt: 0.5, duration: 2, x: 0.55, y: 0.05, width: 0.4 })],
    }),
    [m.p1, m.v1, m.v2, m.p2], files, null,
    undefined,
    1.2,
    { width: 720, height: 1280 },
  );

  // 21. And square, where neither dimension is the long one.
  await runCase(
    "square-frame",
    doc({
      clips: [
        clip({ id: "a", mediaItemId: ID.p2, duration: 1.5 }),
        clip({ id: "b", mediaItemId: ID.v1, kind: "video", trimStart: 0, trimEnd: 2, transitionIn: "dipblack", transitionDuration: 0.5 }),
      ],
    }),
    [m.p2, m.v1], files, null,
    undefined,
    undefined,
    { width: 1080, height: 1080 },
  );

  /**
   * 22. Landscape footage in an upright frame, cropped to fill it. Explicit
   * per-shot fits, so this is the override path: what somebody gets when they
   * press Fill on a shot regardless of what the film does by default.
   */
  await runCase(
    "fit-fill-portrait",
    doc({
      clips: [
        clip({ id: "a", mediaItemId: ID.p1, duration: 1.5, fit: "fill" }),
        clip({ id: "b", mediaItemId: ID.v1, kind: "video", trimStart: 0, trimEnd: 2, fit: "fill" }),
      ],
    }),
    [probed.p1, probed.v1], files, null,
    undefined,
    undefined,
    { width: 720, height: 1280 },
    1,
  );

  /**
   * 23. The same footage and frame, left on `auto` with the film's policy set
   * to blur — the default path, and the one that has to survive both a hard
   * cut and a dissolve, since blur builds a split/overlay graph per shot and
   * xfade is unforgiving about what it's handed.
   */
  await runCase(
    "fit-blur-portrait",
    doc({
      director: { ...emptyTimeline().director, fitPolicy: "blur" },
      clips: [
        clip({ id: "a", mediaItemId: ID.p1, duration: 1.5 }),
        clip({ id: "b", mediaItemId: ID.v1, kind: "video", trimStart: 0, trimEnd: 2 }),
        clip({
          id: "c",
          mediaItemId: ID.p1,
          duration: 1.5,
          transitionIn: "crossfade",
          transitionDuration: 0.5,
        }),
      ],
    }),
    [probed.p1, probed.v1], files, null,
    undefined,
    undefined,
    { width: 720, height: 1280 },
    1,
  );

  /**
   * 24. A file that lies about which way up it is, put right by hand. The
   * turn has to reach the picture — and, because it swaps the shot's
   * orientation, it also has to reach the fit: this is a landscape file
   * declared sideways, so what the frame gets is a portrait shot.
   */
  await runCase(
    "rotate-photo",
    doc({
      clips: [clip({ id: "a", mediaItemId: ID.p1, duration: 2 })],
    }),
    [turned.p1], files, null,
    undefined,
    undefined,
    undefined,
    undefined,
    1,
  );

  /**
   * 25. Speed and a look on the same shot. The speed is the interesting half:
   * the input is asked for `length * speed` seconds of file and `setpts` has
   * to squeeze exactly that back into the piece the plan measured, or the
   * picture and the sound part company for the rest of the film. Both the
   * fast and the slow side, because the atempo chain is different code.
   */
  await runCase(
    "speed-and-look",
    doc({
      clips: [
        clip({ id: "a", mediaItemId: ID.v1, kind: "video", trimStart: 0, trimEnd: 4, speed: 2, look: "warm" }),
        clip({ id: "b", mediaItemId: ID.v2, kind: "video", trimStart: 0, trimEnd: 1, speed: 0.5, look: "mono" }),
        clip({ id: "c", mediaItemId: ID.p1, duration: 1.5, look: "faded" }),
      ],
    }),
    [m.v1, m.v2, m.p1], files, null,
  );

  /**
   * 26. A sped-up shot followed by a dissolve — case 18's timebase trap, but
   * now the piece feeding `xfade` has been through `setpts` as well. The
   * resample happens before `fps`/`settb`, so the timebase should still be the
   * one the join and the dissolve both insist on.
   */
  await runCase(
    "speed-then-dissolve",
    doc({
      clips: [
        clip({ id: "a", mediaItemId: ID.p1, duration: 1.5 }),
        clip({ id: "b", mediaItemId: ID.v1, kind: "video", trimStart: 0, trimEnd: 4, speed: 2, transitionIn: "cut" }),
        clip({ id: "c", mediaItemId: ID.p2, duration: 2, transitionIn: "crossfade", transitionDuration: 0.6 }),
      ],
    }),
    [m.p1, m.v1, m.p2], files, null,
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
