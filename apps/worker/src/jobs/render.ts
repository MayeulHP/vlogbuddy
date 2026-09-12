import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  db,
  eq,
  mediaItems,
  musicItems,
  renderJobs,
  vlogs,
  type MediaItem,
} from "@vlogbuddy/db";
import {
  clipDuration,
  timelineDuration,
  type Clip,
  type TimelineDoc,
} from "@vlogbuddy/shared";
import { env } from "../env";
import { buildStorageKey, downloadToFile, uploadFile } from "../storage";
import { escapeDrawText, ffmpeg, probe, supportsDrawText } from "../ffmpeg";
import { notifyRenderProgress } from "../notify";

export interface RenderJobPayload {
  renderJobId: string;
  vlogId: string;
}

/**
 * Compiles the timeline into a single FFmpeg invocation.
 *
 * Every clip is normalised to the same resolution/fps/SAR first — mixing phone
 * portrait video with DSLR landscape stills otherwise makes concat and xfade
 * fall over. Photos become timed video segments; videos get trimmed. Then it's
 * either a straight concat (all cuts) or a chain of xfades (any crossfade).
 */
export async function renderVlog(job: RenderJobPayload): Promise<void> {
  const { renderJobId } = job;

  const [render] = await db.select().from(renderJobs).where(eq(renderJobs.id, renderJobId)).limit(1);
  if (!render) {
    console.warn(`[render] ${renderJobId} vanished, skipping`);
    return;
  }

  const timeline = render.timelineSnapshot;
  if (!timeline || timeline.clips.length === 0) {
    await fail(renderJobId, render.vlogId, "There's nothing on the timeline");
    return;
  }

  await db
    .update(renderJobs)
    .set({ status: "rendering", progress: 0, startedAt: new Date(), message: "Preparing…" })
    .where(eq(renderJobs.id, renderJobId));

  await notifyRenderProgress(render.vlogId, {
    renderJobId,
    status: "rendering",
    progress: 0,
    message: "Preparing…",
  });

  const workDir = await mkdtemp(path.join(env().TMP_DIR ?? tmpdir(), "render-"));

  try {
    const height = env().RENDER_HEIGHT;
    const fps = env().RENDER_FPS;
    // Even dimensions are required by H.264; 16:9 at the configured height.
    const width = Math.round((height * 16) / 9 / 2) * 2;

    // --- Fetch every source the timeline references -----------------------
    const mediaIds = Array.from(new Set(timeline.clips.map((c) => c.mediaItemId)));
    const mediaRows = await db.select().from(mediaItems).where(eq(mediaItems.vlogId, render.vlogId));
    const mediaById = new Map<string, MediaItem>(mediaRows.map((m) => [m.id, m]));

    const localPaths = new Map<string, string>();
    const hasAudio = new Map<string, boolean>();

    for (const [index, mediaId] of mediaIds.entries()) {
      const item = mediaById.get(mediaId);
      if (!item) throw new Error(`Clip references a missing item (${mediaId})`);

      const ext = path.extname(item.originalFilename) || ".bin";
      const local = path.join(workDir, `src-${index}${ext}`);
      await downloadToFile(item.storageKey, local);
      localPaths.set(mediaId, local);

      // Plenty of real videos carry no audio track (screen recordings, muted
      // captures, action-cam modes). Referencing [n:a] for those makes the whole
      // filtergraph fail, so probe rather than assume.
      if (item.kind === "video") {
        const info = await probe(local).catch(() => null);
        hasAudio.set(mediaId, info?.hasAudio ?? false);
      } else {
        hasAudio.set(mediaId, false);
      }

      const pct = ((index + 1) / mediaIds.length) * 15;
      await progress(renderJobId, render.vlogId, pct, "Fetching your clips…");
    }

    // --- Audio bed --------------------------------------------------------
    let audioPath: string | null = null;
    const audioTrack = timeline.audio[0] ?? null;

    if (audioTrack) {
      if (audioTrack.mediaItemId) {
        const item = mediaById.get(audioTrack.mediaItemId);
        if (item) {
          audioPath = path.join(workDir, `music${path.extname(item.originalFilename) || ".mp3"}`);
          await downloadToFile(item.storageKey, audioPath);
        }
      } else if (audioTrack.musicItemId) {
        const [music] = await db
          .select()
          .from(musicItems)
          .where(eq(musicItems.id, audioTrack.musicItemId))
          .limit(1);

        if (music?.extractedAudioKey) {
          audioPath = path.join(workDir, "music.m4a");
          await downloadToFile(music.extractedAudioKey, audioPath);
        } else {
          // Streaming links can't be muxed — render silent rather than fail.
          console.warn(`[render] no audio file for music item ${audioTrack.musicItemId}`);
        }
      }
    }

    await progress(renderJobId, render.vlogId, 18, "Building the cut…");

    // --- Build the filter graph ------------------------------------------
    const durations: Record<string, number | null> = {};
    for (const [id, item] of mediaById) durations[id] = item.durationSeconds;

    const total = timelineDuration(timeline, durations);
    const allowTitles = await supportsDrawText();

    const { args, outputLabel, audioLabel } = buildFilterGraph({
      timeline,
      mediaById,
      localPaths,
      hasAudio,
      audioPath,
      width,
      height,
      fps,
      allowTitles,
      fontFile: env().FONT_PATH || null,
    });

    const outputPath = path.join(workDir, "vlog.mp4");

    const ffmpegArgs = [
      ...args,
      "-map", outputLabel,
      ...(audioLabel ? ["-map", audioLabel] : []),
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-r", String(fps),
      ...(audioLabel ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      "-movflags", "+faststart",
      outputPath,
    ];

    await ffmpeg(ffmpegArgs, {
      totalDuration: total,
      onProgress: (fraction) => {
        // Encoding spans 20% → 92% of the overall job.
        void progress(renderJobId, render.vlogId, 20 + fraction * 72, "Rendering…");
      },
    });

    await progress(renderJobId, render.vlogId, 94, "Uploading…");

    const outputKey = buildStorageKey(render.vlogId, "render", renderJobId, "vlog.mp4");
    await uploadFile(outputKey, outputPath, "video/mp4");

    const fileStat = await stat(outputPath);

    await db
      .update(renderJobs)
      .set({
        status: "done",
        progress: 100,
        outputKey,
        durationSeconds: total,
        sizeBytes: fileStat.size,
        finishedAt: new Date(),
        message: "Done",
      })
      .where(eq(renderJobs.id, renderJobId));

    await db.update(vlogs).set({ state: "published" }).where(eq(vlogs.id, render.vlogId));

    await notifyRenderProgress(render.vlogId, {
      renderJobId,
      status: "done",
      progress: 100,
      message: "Your vlog is ready",
    });

    console.log(`[render] ${renderJobId} done (${(fileStat.size / 1e6).toFixed(1)} MB)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[render] ${renderJobId} failed:`, message);
    await fail(renderJobId, render.vlogId, message);
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface GraphOptions {
  timeline: TimelineDoc;
  mediaById: Map<string, MediaItem>;
  localPaths: Map<string, string>;
  /** Whether each source actually carries an audio stream. */
  hasAudio?: Map<string, boolean>;
  audioPath: string | null;
  width: number;
  height: number;
  fps: number;
  /** False when the FFmpeg build lacks drawtext — titles are skipped. */
  allowTitles?: boolean;
  /** Explicit font for drawtext; required on Alpine. */
  fontFile?: string | null;
}

/** Exported for testing — this graph is the trickiest part of the pipeline. */
export function buildFilterGraph(opts: GraphOptions) {
  const {
    timeline,
    mediaById,
    localPaths,
    hasAudio,
    audioPath,
    width,
    height,
    fps,
    allowTitles = true,
    fontFile = null,
  } = opts;

  const inputs: string[] = [];
  const filters: string[] = [];
  const videoLabels: string[] = [];
  const audioLabels: string[] = [];
  const clipDurations: number[] = [];

  let inputIndex = 0;

  timeline.clips.forEach((clip, i) => {
    const media = mediaById.get(clip.mediaItemId);
    const local = localPaths.get(clip.mediaItemId);
    if (!media || !local) return;

    const duration = clipDuration(clip, media.durationSeconds);
    clipDurations.push(duration);

    const isPhoto = clip.kind === "photo";

    if (isPhoto) {
      // Loop the still into a fixed-length segment.
      inputs.push("-loop", "1", "-t", String(duration), "-i", local);
    } else {
      inputs.push("-ss", String(clip.trimStart), "-t", String(duration), "-i", local);
    }

    const idx = inputIndex++;
    const vLabel = `v${i}`;

    // Normalise everything: scale into the frame, pad, fix SAR and fps.
    // The input label attaches directly to the first filter — no comma.
    const videoChain =
      `[${idx}:v]` +
      [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        `setsar=1`,
        `fps=${fps}`,
        `format=yuv420p`,
      ].join(",");

    const titleChain = (allowTitles ? clip.titles : [])
      .map((title) => {
        const y =
          title.position === "top"
            ? "h*0.08"
            : title.position === "center"
              ? "(h-text_h)/2"
              : "h*0.88-text_h";
        return [
          `drawtext=text='${escapeDrawText(title.text)}'`,
          // Render the text literally. Without this, drawtext treats `%` and
          // `%{...}` as expansion syntax — a title containing "50% off" would
          // silently render as nothing, and users could inject `%{pts}`.
          `expansion=none`,
          // Explicit font file: Alpine has no fontconfig defaults, so drawtext
          // would otherwise fail with "Cannot find a valid font".
          ...(fontFile ? [`fontfile=${fontFile}`] : []),
          `fontsize=${title.fontSize}`,
          `fontcolor=${title.color}`,
          `x=(w-text_w)/2`,
          `y=${y}`,
          `shadowcolor=black@0.7`,
          `shadowx=2`,
          `shadowy=2`,
          `enable='between(t,${title.start},${title.start + title.duration})'`,
        ].join(":");
      })
      .join(",");

    filters.push(`${videoChain}${titleChain ? "," + titleChain : ""}[${vLabel}]`);
    videoLabels.push(vLabel);

    // Audio: photos and muted clips contribute silence of the right length.
    const aLabel = `a${i}`;
    if (isPhoto || clip.muted || !clipHasAudio(media, hasAudio)) {
      filters.push(
        `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration},asetpts=PTS-STARTPTS[${aLabel}]`,
      );
    } else {
      const volume = timeline.duckClipAudio && audioPath ? clip.volume * 0.35 : clip.volume;
      filters.push(
        `[${idx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
          `atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=${volume.toFixed(2)}[${aLabel}]`,
      );
    }
    audioLabels.push(aLabel);
  });

  if (videoLabels.length === 0) throw new Error("No usable clips in the timeline");

  const usesCrossfade = timeline.clips.some((c, i) => i > 0 && c.transitionIn === "crossfade");

  let finalVideo: string;
  let finalAudio: string;

  if (usesCrossfade && videoLabels.length > 1) {
    // Chain xfades; each one pulls the next clip back by its own duration.
    let currentV = videoLabels[0];
    let currentA = audioLabels[0];
    let offset = clipDurations[0];

    for (let i = 1; i < videoLabels.length; i++) {
      const clip = timeline.clips[i];
      const isFade = clip.transitionIn === "crossfade";
      const fadeDuration = isFade ? Math.min(clip.transitionDuration, clipDurations[i] * 0.9) : 0;

      const outV = `xv${i}`;
      const outA = `xa${i}`;

      if (isFade && fadeDuration > 0) {
        const transitionStart = Math.max(0, offset - fadeDuration);
        filters.push(
          `[${currentV}][${videoLabels[i]}]xfade=transition=fade:duration=${fadeDuration}:offset=${transitionStart.toFixed(3)}[${outV}]`,
        );
        filters.push(
          `[${currentA}][${audioLabels[i]}]acrossfade=d=${fadeDuration}:c1=tri:c2=tri[${outA}]`,
        );
        offset = offset - fadeDuration + clipDurations[i];
      } else {
        filters.push(`[${currentV}][${videoLabels[i]}]concat=n=2:v=1:a=0[${outV}]`);
        filters.push(`[${currentA}][${audioLabels[i]}]concat=n=2:v=0:a=1[${outA}]`);
        offset += clipDurations[i];
      }

      currentV = outV;
      currentA = outA;
    }

    finalVideo = currentV;
    finalAudio = currentA;
  } else {
    const vIn = videoLabels.map((l) => `[${l}]`).join("");
    const aIn = audioLabels.map((l) => `[${l}]`).join("");
    filters.push(`${vIn}concat=n=${videoLabels.length}:v=1:a=0[outv]`);
    filters.push(`${aIn}concat=n=${audioLabels.length}:v=0:a=1[outa]`);
    finalVideo = "outv";
    finalAudio = "outa";
  }

  // --- Music bed --------------------------------------------------------
  let audioLabel: string | null = `[${finalAudio}]`;

  if (audioPath) {
    const musicIdx = inputIndex++;
    const track = timeline.audio[0];
    inputs.push("-i", audioPath);

    const totalLength = clipDurations.reduce((a, b) => a + b, 0);
    const fadeOutStart = Math.max(0, totalLength - (track?.fadeOut ?? 2));

    filters.push(
      `[${musicIdx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `atrim=start=${track?.offset ?? 0},asetpts=PTS-STARTPTS,` +
        // Loop short tracks so the bed covers the whole video.
        `apad,atrim=duration=${totalLength},` +
        `volume=${(track?.volume ?? 0.8).toFixed(2)},` +
        `afade=t=in:st=0:d=${track?.fadeIn ?? 1},` +
        `afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${track?.fadeOut ?? 2}[music]`,
    );

    filters.push(`[${finalAudio}][music]amix=inputs=2:duration=first:dropout_transition=0[mixa]`);
    audioLabel = "[mixa]";
  }

  return {
    args: [...inputs, "-filter_complex", filters.join(";")],
    outputLabel: `[${finalVideo}]`,
    audioLabel,
  };
}

/**
 * Whether a source contributes an audio stream. Prefers the probe result; falls
 * back to the conservative assumption that only videos might have audio.
 */
function clipHasAudio(media: MediaItem, probed?: Map<string, boolean>): boolean {
  const known = probed?.get(media.id);
  if (known !== undefined) return known;
  return media.kind === "video";
}

async function progress(
  renderJobId: string,
  vlogId: string,
  value: number,
  message: string,
): Promise<void> {
  const clamped = Math.max(0, Math.min(100, value));
  await db
    .update(renderJobs)
    .set({ progress: clamped, message })
    .where(eq(renderJobs.id, renderJobId));

  await notifyRenderProgress(vlogId, {
    renderJobId,
    status: "rendering",
    progress: clamped,
    message,
  });
}

async function fail(renderJobId: string, vlogId: string, message: string): Promise<void> {
  await db
    .update(renderJobs)
    .set({
      status: "failed",
      error: message.slice(0, 4000),
      finishedAt: new Date(),
      message: "Failed",
    })
    .where(eq(renderJobs.id, renderJobId));

  // Drop back to the editor so it can be fixed and retried.
  await db.update(vlogs).set({ state: "edit" }).where(eq(vlogs.id, vlogId));

  await notifyRenderProgress(vlogId, {
    renderJobId,
    status: "failed",
    progress: 0,
    error: message.slice(0, 1000),
  });
}
