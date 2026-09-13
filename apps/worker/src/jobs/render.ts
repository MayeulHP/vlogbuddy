import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  db,
  eq,
  getRenderSettings,
  mediaItems,
  musicItems,
  renderJobs,
  vlogs,
  type MediaItem,
} from "@vlogbuddy/db";
import {
  XFADE_FOR,
  audioTrackSpan,
  clipDuration,
  overlapsPrevious,
  layerWindow,
  layersInPaintOrder,
  normalizeTimeline,
  timelineDuration,
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
 * either a straight concat (all cuts) or a chain of xfades (anything else).
 * Layers are composited over the result, and every audio track is mixed under
 * it.
 */
export async function renderVlog(job: RenderJobPayload): Promise<void> {
  const { renderJobId } = job;

  const [render] = await db.select().from(renderJobs).where(eq(renderJobs.id, renderJobId)).limit(1);
  if (!render) {
    console.warn(`[render] ${renderJobId} vanished, skipping`);
    return;
  }

  if (!render.timelineSnapshot) {
    await fail(renderJobId, render.vlogId, "There's nothing on the timeline");
    return;
  }

  // Snapshots taken before multi-track have no layers and no track ids.
  const timeline = normalizeTimeline(render.timelineSnapshot);
  if (timeline.clips.length === 0) {
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
    // Owned by the admin page, not the environment, so the operator can dial
    // the format down after watching one render crawl on a small machine.
    const settings = await getRenderSettings();
    const height = settings.renderHeight;
    const fps = settings.renderFps;
    // Even dimensions are required by H.264; 16:9 at the configured height.
    const width = Math.round((height * 16) / 9 / 2) * 2;

    // --- Fetch every source the timeline references -----------------------
    // Layers pull in media the base track may not use at all.
    const mediaIds = Array.from(
      new Set([
        ...timeline.clips.map((c) => c.mediaItemId),
        ...timeline.layers.map((l) => l.mediaItemId),
      ]),
    );
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

    // --- Audio stack ------------------------------------------------------
    // One file per track, keyed by track id. A track whose source can't be
    // muxed (a streaming link with no extracted audio) simply drops out —
    // rendering silent beats failing the whole job.
    const audioPaths = new Map<string, string>();
    const musicRows = timeline.audio.some((t) => t.musicItemId)
      ? await db.select().from(musicItems).where(eq(musicItems.vlogId, render.vlogId))
      : [];
    const musicById = new Map(musicRows.map((m) => [m.id, m]));

    for (const [index, track] of timeline.audio.entries()) {
      if (track.muted) continue;

      if (track.mediaItemId) {
        const item = mediaById.get(track.mediaItemId);
        if (!item) continue;
        const local = path.join(
          workDir,
          `audio-${index}${path.extname(item.originalFilename) || ".mp3"}`,
        );
        await downloadToFile(item.storageKey, local);
        audioPaths.set(track.id, local);
      } else if (track.musicItemId) {
        const music = musicById.get(track.musicItemId);
        if (music?.extractedAudioKey) {
          const local = path.join(workDir, `audio-${index}.m4a`);
          await downloadToFile(music.extractedAudioKey, local);
          audioPaths.set(track.id, local);
        } else {
          // Streaming links can't be muxed — render silent rather than fail.
          console.warn(`[render] no audio file for music item ${track.musicItemId}`);
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
      audioPaths,
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
      "-preset", settings.renderPreset,
      "-crf", String(settings.renderCrf),
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
  /** Downloaded file per audio track, keyed by `AudioTrack.id`. */
  audioPaths: Map<string, string>;
  width: number;
  height: number;
  fps: number;
  /** False when the FFmpeg build lacks drawtext — titles are skipped. */
  allowTitles?: boolean;
  /** Explicit font for drawtext; required on Alpine. */
  fontFile?: string | null;
}

const AUDIO_FORMAT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

/** H.264 needs even dimensions, and so does every scale target we hand it. */
function evenPx(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/** Exported for testing — this graph is the trickiest part of the pipeline. */
export function buildFilterGraph(opts: GraphOptions) {
  const {
    timeline,
    mediaById,
    localPaths,
    hasAudio,
    audioPaths,
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

  // Ducking is about whether anything is actually going to play under the
  // shots, so it has to be settled before the clip chains are built.
  const musicTracks = timeline.audio.filter((t) => !t.muted && audioPaths.has(t.id));
  const duck = timeline.duckClipAudio && musicTracks.length > 0;

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
        // Pin the timebase explicitly. `concat` hands its output back at
        // 1/1000000 whatever went in, and `xfade` refuses two inputs whose
        // timebases disagree — which is exactly what a cut followed by a
        // dissolve produces. See the settb after the concat below.
        `settb=1/${fps}`,
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
      const volume = duck ? clip.volume * 0.35 : clip.volume;
      filters.push(
        `[${idx}:a]${AUDIO_FORMAT},` +
          `atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=${volume.toFixed(2)}[${aLabel}]`,
      );
    }
    audioLabels.push(aLabel);
  });

  if (videoLabels.length === 0) throw new Error("No usable clips in the timeline");

  const usesTransition = timeline.clips.some((c, i) => i > 0 && overlapsPrevious(c.transitionIn));

  let finalVideo: string;
  let finalAudio: string;
  /** Length of the finished picture, transition overlaps already subtracted. */
  let videoLength: number;

  if (usesTransition && videoLabels.length > 1) {
    // Chain xfades; each one pulls the next clip back by its own duration.
    let currentV = videoLabels[0];
    let currentA = audioLabels[0];
    let offset = clipDurations[0];

    for (let i = 1; i < videoLabels.length; i++) {
      const clip = timeline.clips[i];
      // The one place a transition name reaches FFmpeg. Everything else in the
      // codebase asks `overlapsPrevious` and never needs to know the spelling.
      const xfadeName = XFADE_FOR[clip.transitionIn];
      const isFade = xfadeName !== null;
      const fadeDuration = isFade ? Math.min(clip.transitionDuration, clipDurations[i] * 0.9) : 0;

      const outV = `xv${i}`;
      const outA = `xa${i}`;

      if (isFade && fadeDuration > 0) {
        const transitionStart = Math.max(0, offset - fadeDuration);
        filters.push(
          `[${currentV}][${videoLabels[i]}]xfade=transition=${xfadeName}:duration=${fadeDuration}:offset=${transitionStart.toFixed(3)}[${outV}]`,
        );
        filters.push(
          `[${currentA}][${audioLabels[i]}]acrossfade=d=${fadeDuration}:c1=tri:c2=tri[${outA}]`,
        );
        offset = offset - fadeDuration + clipDurations[i];
      } else {
        // Back to the clip timebase, so the next xfade in the chain — if this
        // run of hard cuts ends at a scene break — can accept this as an input.
        filters.push(`[${currentV}][${videoLabels[i]}]concat=n=2:v=1:a=0,settb=1/${fps}[${outV}]`);
        filters.push(`[${currentA}][${audioLabels[i]}]concat=n=2:v=0:a=1[${outA}]`);
        offset += clipDurations[i];
      }

      currentV = outV;
      currentA = outA;
    }

    finalVideo = currentV;
    finalAudio = currentA;
    videoLength = offset;
  } else {
    const vIn = videoLabels.map((l) => `[${l}]`).join("");
    const aIn = audioLabels.map((l) => `[${l}]`).join("");
    filters.push(`${vIn}concat=n=${videoLabels.length}:v=1:a=0[outv]`);
    filters.push(`${aIn}concat=n=${audioLabels.length}:v=0:a=1[outa]`);
    finalVideo = "outv";
    finalAudio = "outa";
    videoLength = clipDurations.reduce((a, b) => a + b, 0);
  }

  // --- Picture layers ---------------------------------------------------
  // Composited bottom-up, each one shifted onto its slot in the finished
  // picture with setpts so overlay can line it up by timestamp. `repeatlast=0`
  // is what stops a layer freezing on screen once its own input runs out.
  const layerAudioLabels: string[] = [];

  layersInPaintOrder(timeline).forEach((layer, n) => {
    const media = mediaById.get(layer.mediaItemId);
    const local = localPaths.get(layer.mediaItemId);
    if (!media || !local) return;

    const window = layerWindow(layer, videoLength);
    if (window.duration <= 0.05) return;

    const idx = inputIndex++;
    if (layer.kind === "photo") {
      inputs.push("-loop", "1", "-t", String(window.duration), "-i", local);
    } else {
      inputs.push("-ss", String(layer.trimStart), "-t", String(window.duration), "-i", local);
    }

    const boxWidth = evenPx(layer.width * width);
    const x = Math.round(layer.x * width);
    const y = Math.round(layer.y * height);

    const fadeIn = Math.min(layer.fadeIn, window.duration / 2);
    const fadeOut = Math.min(layer.fadeOut, window.duration / 2);

    const chain = [
      // -2 keeps the source aspect while staying even-numbered for H.264.
      `scale=${boxWidth}:-2`,
      `setsar=1`,
      `fps=${fps}`,
      // Alpha is what makes fades and opacity possible at all.
      `format=yuva420p`,
      ...(fadeIn > 0.01 ? [`fade=t=in:st=0:d=${fadeIn.toFixed(2)}:alpha=1`] : []),
      ...(fadeOut > 0.01
        ? [`fade=t=out:st=${(window.duration - fadeOut).toFixed(2)}:d=${fadeOut.toFixed(2)}:alpha=1`]
        : []),
      ...(layer.opacity < 0.999 ? [`colorchannelmixer=aa=${layer.opacity.toFixed(3)}`] : []),
      `setpts=PTS-STARTPTS+${window.start.toFixed(3)}/TB`,
    ].join(",");

    const lLabel = `lv${n}`;
    filters.push(`[${idx}:v]${chain}[${lLabel}]`);

    const outLabel = `ov${n}`;
    filters.push(
      `[${finalVideo}][${lLabel}]overlay=x=${x}:y=${y}:eof_action=pass:repeatlast=0:format=auto[${outLabel}]`,
    );
    finalVideo = outLabel;

    if (layer.kind === "video" && !layer.muted && clipHasAudio(media, hasAudio)) {
      const aLabel = `la${n}`;
      const delayMs = Math.round(window.start * 1000);
      filters.push(
        `[${idx}:a]${AUDIO_FORMAT},` +
          `atrim=duration=${window.duration},asetpts=PTS-STARTPTS,` +
          `volume=${layer.volume.toFixed(2)}` +
          (delayMs > 0 ? `,adelay=${delayMs}:all=1` : "") +
          `[${aLabel}]`,
      );
      layerAudioLabels.push(aLabel);
    }
  });

  // --- The audio stack --------------------------------------------------
  const musicLabels: string[] = [];

  musicTracks.forEach((track, n) => {
    const file = audioPaths.get(track.id);
    if (!file) return;

    const span = audioTrackSpan(track, videoLength);
    if (span <= 0.05) return;

    // `-stream_loop` is the only honest way to repeat a short track; `apad`
    // (what this used to do) pads with silence, which is not the same thing.
    if (track.loop) inputs.push("-stream_loop", "-1");
    inputs.push("-i", file);
    const idx = inputIndex++;

    const fadeIn = Math.min(track.fadeIn, span / 2);
    const fadeOut = Math.min(track.fadeOut, span / 2);
    const delayMs = Math.round(track.startAt * 1000);

    const chain = [
      AUDIO_FORMAT,
      ...(track.offset > 0 ? [`atrim=start=${track.offset}`] : []),
      `asetpts=PTS-STARTPTS`,
      // A short track that isn't looping stops early; pad so the fade-out
      // still lands where the timeline says it does.
      `apad`,
      `atrim=duration=${span.toFixed(3)}`,
      `volume=${track.volume.toFixed(2)}`,
      ...(fadeIn > 0.01 ? [`afade=t=in:st=0:d=${fadeIn.toFixed(2)}`] : []),
      ...(fadeOut > 0.01
        ? [`afade=t=out:st=${(span - fadeOut).toFixed(2)}:d=${fadeOut.toFixed(2)}`]
        : []),
      ...(delayMs > 0 ? [`adelay=${delayMs}:all=1`] : []),
    ].join(",");

    const label = `mus${n}`;
    filters.push(`[${idx}:a]${chain}[${label}]`);
    musicLabels.push(label);
  });

  const mixInputs = [finalAudio, ...musicLabels, ...layerAudioLabels];
  let audioLabel: string;

  if (mixInputs.length === 1) {
    audioLabel = `[${finalAudio}]`;
  } else {
    // `normalize=0`: every level on the timeline was dialled in by hand, and
    // amix's default would quietly divide them all by the number of tracks —
    // adding a second track would duck the first. The limiter is the price of
    // that: it catches the summed peaks instead of letting them clip.
    filters.push(
      `${mixInputs.map((l) => `[${l}]`).join("")}` +
        `amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0,` +
        `alimiter=limit=0.95:level=disabled[mixa]`,
    );
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
  await db.update(vlogs).set({ state: "open" }).where(eq(vlogs.id, vlogId));

  await notifyRenderProgress(vlogId, {
    renderJobId,
    status: "failed",
    progress: 0,
    error: message.slice(0, 1000),
  });
}
