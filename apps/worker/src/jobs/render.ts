import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
  CLIP_FITS,
  CLIP_FIT_CHOICES,
  DEFAULT_FIT_POLICY,
  DUCK_SIDECHAIN,
  MOTION_ZOOM,
  XFADE_FOR,
  audioTrackSpan,
  clipDuration,
  clipSourceSpan,
  clipSpeed,
  duckRatio,
  frameFor,
  isGraded,
  layerWindow,
  layersInPaintOrder,
  movesFrame,
  needsDisplayCopy,
  normalizeRotation,
  normalizeTimeline,
  resolveFit,
  transitionOverlap,
  type Clip,
  type ClipFit,
  type ClipFitChoice,
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
 * Compiles the timeline into a sequence of small FFmpeg invocations.
 *
 * It used to be one: every clip an input, the whole film a single filter graph.
 * That reads beautifully and cannot be made to work on a modest box. FFmpeg
 * opens every input at once and decodes them all from the start, while the
 * encoder is still on shot one; the frames nothing is ready to consume yet queue
 * up inside the graph, and those queues are unbounded, so memory climbs for as
 * long as the render runs. Measured on a 14-shot, 50-second cut at 1440p60:
 * 6 GB after a minute, at which point the kernel's OOM killer takes FFmpeg out
 * and the lab reports a print that failed for no visible reason.
 *
 * So the film is printed in pieces, each one its own process:
 *
 *  - one pass per shot, covering the part of it no dissolve reaches into;
 *  - one pass per dissolve, over just the two bits of footage it touches;
 *  - a join, which is a stream copy because every piece was encoded alike;
 *  - the sound in one pass of its own, where a hundred inputs cost nothing;
 *  - layers over the joined picture, only when somebody placed one;
 *  - a remux that puts picture and sound in one file.
 *
 * No pass holds more than two pieces of footage open, so what a render costs is
 * set by the size of the frame and not by the length of the film. It is slower
 * in wall-clock terms — more processes, and the dissolve regions get encoded a
 * second time — and it finishes, which the fast version didn't.
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
    const fps = settings.renderFps;

    /**
     * Shape is the vlog's, size is the operator's: `renderHeight` is read as
     * the shorter edge, so widescreen comes out exactly as it always did and an
     * upright film costs the same pixels rather than 1.8× them.
     *
     * Everything downstream is geometry-agnostic — clips are fitted into the
     * frame rather than assumed to match it, so a portrait frame pillarboxes
     * landscape footage without any further help.
     */
    const [vlog] = await db.select().from(vlogs).where(eq(vlogs.id, render.vlogId)).limit(1);
    const { width, height } = frameFor(vlog?.format ?? "landscape", settings.renderHeight);

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

      /**
       * A photo the browser couldn't decode has a JPEG stand-in under its
       * proxy key, and FFmpeg can't read the original either — so the film is
       * cut from the stand-in. Without this one HEIC in the cut takes the
       * whole render down, which is a spectacularly bad way to find out the
       * lab can't read iPhone photos.
       */
      const useDisplayCopy =
        item.kind !== "video" && item.proxyKey !== null && needsDisplayCopy(item.contentType);
      const source = useDisplayCopy ? item.proxyKey! : item.storageKey;
      const ext = useDisplayCopy ? ".jpg" : path.extname(item.originalFilename) || ".bin";
      const local = path.join(workDir, `src-${index}${ext}`);
      await downloadToFile(source, local);
      localPaths.set(mediaId, local);

      /*
       * Plenty of real videos carry no audio track (screen recordings, muted
       * captures, action-cam modes). Referencing [n:a] for those makes the
       * whole filtergraph fail, so this has to be known rather than assumed.
       *
       * `process-media` already probed it while the file was on disk, so the
       * stored answer is used where there is one. Null means the row predates
       * the column — fall back to probing, because being wrong here fails the
       * whole render, which is worth far more than the ffprobe it costs.
       */
      if (item.kind !== "video") {
        hasAudio.set(mediaId, false);
      } else if (item.hasAudio !== null) {
        hasAudio.set(mediaId, item.hasAudio);
      } else {
        const info = await probe(local).catch(() => null);
        hasAudio.set(mediaId, info?.hasAudio ?? false);
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

    const plan = planRender({
      timeline,
      mediaById,
      localPaths,
      hasAudio,
      audioPaths,
      width,
      height,
      fps,
      allowTitles: await supportsDrawText(),
      fontFile: env().FONT_PATH || null,
      workDir,
      encode: {
        crf: settings.renderCrf,
        preset: settings.renderPreset,
        threads: env().RENDER_THREADS,
      },
    });

    for (const file of plan.files) await writeFile(file.path, file.contents);

    console.log(
      `[render] ${renderJobId} ${plan.passes.length} passes for ` +
        `${plan.durationSeconds.toFixed(1)}s at ${width}x${height}@${fps}`,
    );

    /**
     * Encoding spans 20% → 92% of the job, shared out by how much work each
     * pass is rather than how many there are: a half-second dissolve and a
     * whole reel of picture are one pass each and nothing like the same wait.
     */
    const totalWeight = plan.passes.reduce((sum, pass) => sum + pass.weight, 0) || 1;
    let doneWeight = 0;

    for (const pass of plan.passes) {
      const before = doneWeight;
      await ffmpeg(pass.args, {
        totalDuration: pass.duration,
        onProgress: (fraction) => {
          const overall = (before + fraction * pass.weight) / totalWeight;
          void progress(renderJobId, render.vlogId, 20 + overall * 72, pass.label);
        },
      });
      doneWeight += pass.weight;
      await progress(renderJobId, render.vlogId, 20 + (doneWeight / totalWeight) * 72, pass.label);
    }

    await progress(renderJobId, render.vlogId, 94, "Uploading…");

    const outputKey = buildStorageKey(render.vlogId, "render", renderJobId, "vlog.mp4");
    await uploadFile(outputKey, plan.outputPath, "video/mp4");

    const fileStat = await stat(plan.outputPath);

    await db
      .update(renderJobs)
      .set({
        status: "done",
        progress: 100,
        outputKey,
        durationSeconds: plan.durationSeconds,
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

export interface EncodeSettings {
  crf: number;
  preset: string;
  /**
   * 0 leaves it to FFmpeg, which takes every core it can see. Anything else
   * caps both the encoder and the filters — the lever for a box that has other
   * jobs to do while the lab is busy.
   */
  threads: number;
}

export interface PlanOptions extends GraphOptions {
  /** Where the intermediate pieces live. The caller throws it away after. */
  workDir: string;
  encode: EncodeSettings;
}

/** One FFmpeg invocation. */
export interface RenderPass {
  /** Said out loud to whoever is watching the dial go round. */
  label: string;
  /** Complete arguments, minus the globals `ffmpeg()` adds itself. */
  args: string[];
  /** Length of this pass's own output — what its `time=` is measured against. */
  duration: number;
  /** Roughly what share of the job this pass is, in film-seconds. */
  weight: number;
}

export interface RenderPlan {
  /** Written before the passes run. The concat list, in practice. */
  files: { path: string; contents: string }[];
  passes: RenderPass[];
  /** The file the last pass writes. */
  outputPath: string;
  /** Length of the finished film, transition overlaps already subtracted. */
  durationSeconds: number;
}

const AUDIO_FORMAT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

/**
 * How much cloned tail every picture piece gets before it is trimmed to length.
 *
 * A source can run out a frame or two before the plan says it should — a clip
 * trimmed to the very end of a file whose last frame is short, or a container
 * whose duration lies. The piece would then be shorter than the plan, and since
 * the sound is built to the plan's lengths, everything after it would sit that
 * much early. Cloning the last frame and trimming back to the exact length is
 * the picture's version of the `apad` the sound has always had.
 */
const PICTURE_TAIL_PAD = 0.5;

/** Rounded where it's generated, so the same cut always plans the same passes. */
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** H.264 needs even dimensions, and so does every scale target we hand it. */
function evenPx(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * How much bigger than the output the frame is built before `zoompan` crops
 * it. zoompan steps its crop window by whole *input* pixels, so at 1:1 a slow
 * move judders once a second or so; at 2:1 each step is half an output pixel
 * and the move reads as smooth. Higher is smoother still and costs real time
 * on the machines this is built for — 2 is where it stops being visible.
 */
const MOTION_SUPERSAMPLE = 2;

/**
 * A clip's fit, and the film's policy.
 *
 * Both are on the document now, with `normalizeTimeline` filling in `auto` and
 * the default policy for anything written before they existed. The values are
 * still checked against the unions rather than trusted: a render reads a
 * *snapshot*, and `render_jobs.timeline_snapshot` is jsonb that nothing
 * re-validates between the job being queued and the lab picking it up.
 */
function fitOf(clip: Clip): ClipFitChoice {
  return CLIP_FIT_CHOICES.includes(clip.fit) ? clip.fit : "auto";
}

function policyOf(timeline: TimelineDoc): ClipFit {
  const asked = timeline.director.fitPolicy;
  return CLIP_FITS.includes(asked) ? asked : DEFAULT_FIT_POLICY;
}

/**
 * Straightening a file whose rotation metadata lies.
 *
 * FFmpeg already applies a well-formed display matrix on decode, so this is
 * only ever the correction on top of that — and an empty list when the file
 * was fine, which is what keeps every existing render byte-identical.
 *
 * 180 is two quarter turns rather than `hflip,vflip`: transpose twice is
 * exactly the same picture and costs nothing extra at these sizes, and one
 * filter name is one thing to get wrong.
 */
function rotationFilters(rotation: number | null | undefined): string[] {
  switch (normalizeRotation(rotation)) {
    case 90:
      return ["transpose=1"];
    case 180:
      return ["transpose=1", "transpose=1"];
    case 270:
      return ["transpose=2"];
    default:
      return [];
  }
}

/**
 * Gets one clip into the frame, whichever way it's pointing.
 *
 * Returns the filters that have to stand on their own (`pre`) plus the `head`
 * of the clip's chain — the part with the input label already attached, which
 * the caller continues with the normalisation every clip gets regardless
 * (`setsar`, `fps`, `settb`, `format`). Keeping that tail out here is what
 * makes the timebase pin apply to all three fits without repeating it.
 *
 * `bars` is deliberately the same two filters it has always been: a landscape
 * film of landscape footage must come out of the lab byte-identical to what it
 * did before fits existed.
 */
function fitChain(
  fit: ClipFit,
  input: string,
  width: number,
  height: number,
  /** Suffix for this branch's own labels; only has to be unique in one pass. */
  n: string,
): { pre: string[]; head: string } {
  switch (fit) {
    case "fill":
      return {
        pre: [],
        // `increase` is `decrease`'s mirror — cover the frame, then take the
        // middle. crop centres by default, which is where the subject of a
        // hand-held shot almost always is.
        head:
          `${input}scale=${width}:${height}:force_original_aspect_ratio=increase,` +
          `crop=${width}:${height}`,
      };
    case "blur": {
      // Sigma against the frame's short edge, so the backdrop is equally soft
      // at 480 and at 1080 — a fixed sigma would be a smear on one and a
      // slightly-out-of-focus picture on the other.
      const sigma = Math.max(8, Math.round(Math.min(width, height) / 40));

      /*
       * The backdrop is blurred small and then enlarged, rather than blurred at
       * full size.
       *
       * A gaussian costs pixels × radius, and this one runs on every frame of
       * every mismatched shot — at 1080 that was a sigma-27 blur over two
       * million pixels, which is most of the cost of the whole fit. Blurring a
       * quarter-size copy with a quarter of the sigma lands on the same image:
       * detail finer than the blur radius is exactly what the blur was going to
       * destroy, so there is nothing in those pixels to keep, and the bilinear
       * enlargement on the way back out smooths rather than sharpens.
       */
      const shrink = 4;
      const bw = evenPx(width / shrink);
      const bh = evenPx(height / shrink);
      const small = Math.max(1, Math.round(sigma / shrink));

      return {
        pre: [
          `${input}split=2[fbg${n}][ffg${n}]`,
          `[fbg${n}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,` +
            `crop=${bw}:${bh},gblur=sigma=${small},scale=${width}:${height}[fbb${n}]`,
          `[ffg${n}]scale=${width}:${height}:force_original_aspect_ratio=decrease[ffs${n}]`,
        ],
        head: `[fbb${n}][ffs${n}]overlay=(W-w)/2:(H-h)/2`,
      };
    }
    default:
      return {
        pre: [],
        head:
          `${input}scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      };
  }
}

/**
 * The Ken Burns move, as a `zoompan` call.
 *
 * Driven off `on`, the output frame counter, rather than the `time` variable —
 * `time` only exists in newer FFmpeg builds and this has to work on whatever
 * the distro shipped. `d=1` because the still has already been looped into a
 * stream of exactly `frames` frames, so zoompan emits one frame per frame
 * instead of multiplying them.
 *
 * The move belongs to the *clip*, not to the piece being printed: a still that
 * dissolves at either end is three passes, and a gesture that restarted in each
 * of them would jump backwards at every dissolve. So the progress is measured
 * against the whole clip, and each piece picks up where the last one left off.
 */
function motionFilter(
  clip: Clip,
  opts: {
    /** Frames of this clip already printed by an earlier piece. */
    startFrame: number;
    /** Frames in this piece. */
    frames: number;
    /** Frames in the whole clip — what the gesture is measured against. */
    totalFrames: number;
  },
  width: number,
  height: number,
  fps: number,
): string | null {
  if (!movesFrame(clip.motion) || opts.frames < 1 || opts.totalFrames < 2) return null;

  const travel = (MOTION_ZOOM - 1).toFixed(4);
  const span = opts.totalFrames - 1;
  const progress = opts.startFrame === 0 ? `on/${span}` : `(on+${opts.startFrame})/${span}`;
  const zoom =
    clip.motion === "punchin"
      ? `1+${travel}*(${progress})`
      : `${MOTION_ZOOM}-${travel}*(${progress})`;

  return [
    `zoompan=z='${zoom}'`,
    // Centred: the crop window is always the middle of the frame, whatever
    // the zoom, which is what keeps a letterboxed photo symmetrical.
    `x='iw/2-(iw/zoom/2)'`,
    `y='ih/2-(ih/zoom/2)'`,
    `d=1`,
    `s=${width}x${height}`,
    `fps=${fps}`,
  ].join(":");
}

/**
 * The grade. Each value is checked against its neutral, so an untouched clip
 * adds no filters at all and compiles to the same chain it always did.
 */
function gradeFilters(clip: Clip): string[] {
  if (!isGraded(clip)) return [];

  const out: string[] = [];
  const eq: string[] = [];
  if (clip.brightness !== 0) eq.push(`brightness=${clip.brightness.toFixed(3)}`);
  if (clip.contrast !== 1) eq.push(`contrast=${clip.contrast.toFixed(3)}`);
  if (clip.saturation !== 1) eq.push(`saturation=${clip.saturation.toFixed(3)}`);
  if (eq.length > 0) out.push(`eq=${eq.join(":")}`);
  if (clip.hue !== 0) out.push(`hue=h=${clip.hue.toFixed(1)}`);
  if (clip.blur > 0) out.push(`gblur=sigma=${clip.blur.toFixed(2)}`);
  return out;
}

/** A clip the render can actually open, with the lengths it measures. */
interface Shot {
  clip: Clip;
  media: MediaItem;
  local: string;
  /** Screen seconds — what the audience experiences. */
  duration: number;
  /** Source seconds — the pre-speed length FFmpeg's `-t` measures. */
  sourceSpan: number;
}

/** The span of a shot that is a piece of the film in its own right. */
interface Body {
  /** Seconds into the clip where it starts — its dissolve-in, if it has one. */
  start: number;
  length: number;
}

/**
 * Titles, moved onto the piece being printed.
 *
 * A title's times are relative to the start of its clip, but a piece may begin
 * partway in: the head of a shot belongs to the dissolve before it, not to the
 * shot's own pass. So the window shifts by however much of the clip this piece
 * starts after, and a title that falls entirely outside the piece isn't in it.
 */
function titleFilters(
  clip: Clip,
  opts: { allowTitles: boolean; fontFile: string | null; shift: number; length: number },
): string {
  const drawn = (opts.allowTitles ? clip.titles : []).flatMap((title) => {
    const start = round3(title.start - opts.shift);
    const end = round3(title.start + title.duration - opts.shift);
    if (end <= 0 || start >= opts.length) return [];

    const y =
      title.position === "top"
        ? "h*0.08"
        : title.position === "center"
          ? "(h-text_h)/2"
          : "h*0.88-text_h";

    return [
      [
        `drawtext=text='${escapeDrawText(title.text)}'`,
        // Render the text literally. Without this, drawtext treats `%` and
        // `%{...}` as expansion syntax — a title containing "50% off" would
        // silently render as nothing, and users could inject `%{pts}`.
        `expansion=none`,
        // Explicit font file: Alpine has no fontconfig defaults, so drawtext
        // would otherwise fail with "Cannot find a valid font".
        ...(opts.fontFile ? [`fontfile=${opts.fontFile}`] : []),
        `fontsize=${title.fontSize}`,
        `fontcolor=${title.color}`,
        `x=(w-text_w)/2`,
        `y=${y}`,
        `shadowcolor=black@0.7`,
        `shadowx=2`,
        `shadowy=2`,
        `enable='between(t,${Math.max(0, start)},${end})'`,
      ].join(":"),
    ];
  });

  return drawn.length > 0 ? `,${drawn.join(",")}` : "";
}

/**
 * The input arguments for one span of one shot.
 *
 * `offset` and `length` are seconds of the *film*; a ramped shot needs that
 * many times `speed` seconds of the *file* to fill them, and `setpts` in the
 * picture chain squeezes them back down. `clipSourceSpan` is the single
 * opinion about how much file the clip owns at all, so no piece is asked to
 * read past the out-point however the frame-snapping rounded — with the pad
 * beyond it coming from cloned frames instead of from the next shot's footage.
 */
function sourceInput(shot: Shot, offset: number, length: number): string[] {
  if (shot.clip.kind === "photo") {
    // Loop the still into a fixed-length segment.
    return ["-loop", "1", "-t", String(round3(length + PICTURE_TAIL_PAD)), "-i", shot.local];
  }
  const rate = clipSpeed(shot.clip);
  const from = round3(offset * rate);
  const wanted = length * rate + PICTURE_TAIL_PAD * rate;
  const span = round3(Math.max(1 / 1000, Math.min(wanted, shot.sourceSpan - from)));
  return [
    "-ss", String(round3(shot.clip.trimStart + from)),
    "-t", String(span),
    "-i", shot.local,
  ];
}

/**
 * `atempo` only takes 0.5–2.0, so anything further out is a chain of stages —
 * 4× is two doublings. Returns an empty list at 1×, where it would be a
 * pointless resample.
 */
function atempoChain(rate: number): string[] {
  const stages: string[] = [];
  let remaining = rate;
  while (remaining > 2.0001) {
    stages.push("atempo=2.0");
    remaining /= 2;
  }
  while (remaining < 0.4999) {
    stages.push("atempo=0.5");
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 0.0001) stages.push(`atempo=${round3(remaining)}`);
  return stages;
}

interface PictureContext {
  width: number;
  height: number;
  fps: number;
  policy: ClipFit;
  allowTitles: boolean;
  fontFile: string | null;
}

/**
 * One span of one shot, normalised into the frame and ending in `[label]`.
 *
 * The order is load-bearing: straighten before framing, never after, because
 * the fit scales and crops against the frame and doing that to a shot that is
 * still on its side fits the wrong edges. And `fps` before the move, so
 * zoompan is handed exactly the frames it is going to emit — its `on` counter
 * is what drives the whole gesture.
 */
function pictureFilters(
  shot: Shot,
  ctx: PictureContext,
  opts: {
    inputIndex: number;
    label: string;
    /** Seconds of the clip this piece starts after. Moves the titles. */
    shift: number;
    length: number;
  },
): string[] {
  const filters: string[] = [];

  // How this shot meets a frame it may not be the shape of. `auto` is resolved
  // here, against the dimensions the probe actually found, and never written
  // back to the document.
  const fit = resolveFit({
    clipWidth: shot.media.width,
    clipHeight: shot.media.height,
    clipRotation: shot.media.rotation,
    frameWidth: ctx.width,
    frameHeight: ctx.height,
    fit: fitOf(shot.clip),
    policy: ctx.policy,
  });

  const motion = motionFilter(
    shot.clip,
    {
      startFrame: Math.round(opts.shift * ctx.fps),
      frames: Math.round(opts.length * ctx.fps),
      totalFrames: Math.round(shot.duration * ctx.fps),
    },
    ctx.width,
    ctx.height,
    ctx.fps,
  );

  /*
   * A moving still is framed oversized and cropped back down by zoompan;
   * everything else is fitted straight into the frame. The fit has to happen
   * at the supersampled size or the move would be enlarging a picture that had
   * already been reduced to the output, which is where the mush comes from.
   */
  const canvas = motion ? MOTION_SUPERSAMPLE : 1;
  const canvasW = evenPx(ctx.width * canvas);
  const canvasH = evenPx(ctx.height * canvas);

  const turn = rotationFilters(shot.media.rotation);
  let source = `[${opts.inputIndex}:v]`;
  if (turn.length > 0) {
    // A run through its own label keeps `fitChain` — including the blur's
    // split — none the wiser.
    filters.push(`${source}${turn.join(",")}[rot${opts.label}]`);
    source = `[rot${opts.label}]`;
  }

  const framing = fitChain(fit, source, canvasW, canvasH, opts.label);
  filters.push(...framing.pre);

  const rate = clipSpeed(shot.clip);

  const chain =
    framing.head +
    "," +
    [
      // Before `fps`: the resample is what turns the stretched or squeezed
      // presentation times back into a piece of exactly the length the plan
      // asked for, at the frame rate every other piece was printed at.
      ...(rate === 1 ? [] : [`setpts=PTS/${round3(rate)}`]),
      `setsar=1`,
      `fps=${ctx.fps}`,
      // The picture's `apad`: a source that runs a frame short clones its last
      // one rather than handing back a piece shorter than the plan. `-t` on the
      // pass trims the surplus back off, so every piece is exactly its length.
      `tpad=stop_mode=clone:stop_duration=${PICTURE_TAIL_PAD}`,
      ...(motion ? [motion] : []),
      ...gradeFilters(shot.clip),
      // Pin the timebase explicitly. Pieces are joined by stream copy, and
      // `xfade` refuses two inputs whose timebases disagree, so every piece has
      // to leave its graph on the same one.
      `settb=1/${ctx.fps}`,
      `format=yuv420p`,
    ].join(",");

  filters.push(
    `${chain}${titleFilters(shot.clip, {
      allowTitles: ctx.allowTitles,
      fontFile: ctx.fontFile,
      shift: opts.shift,
      length: opts.length,
    })}[${opts.label}]`,
  );

  return filters;
}

/**
 * Plans the passes that print the film.
 *
 * Pure: the same cut plans the same argument lists. Exported because it is the
 * trickiest part of the pipeline and `render-check.ts` runs real plans against
 * real media.
 */
export function planRender(opts: PlanOptions): RenderPlan {
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
    workDir,
    encode,
  } = opts;

  const shots: Shot[] = timeline.clips.flatMap((clip) => {
    const media = mediaById.get(clip.mediaItemId);
    const local = localPaths.get(clip.mediaItemId);
    if (!media || !local) return [];
    return [
      {
        clip,
        media,
        local,
        duration: clipDuration(clip, media.durationSeconds),
        sourceSpan: clipSourceSpan(clip, media.durationSeconds),
      },
    ];
  });

  if (shots.length === 0) throw new Error("No usable clips in the timeline");

  /**
   * Piece lengths land on whole frames.
   *
   * A piece is a file, and a file can only hold frames, so FFmpeg rounds
   * whatever it's asked for up to the next one. Twenty pieces of half a rounded
   * frame each is a third of a second the film wasn't meant to have — and worse,
   * it accumulates in the picture and not in the sound, which is built as one
   * continuous thing. Asking for whole frames in the first place is what keeps
   * the two together.
   */
  const snap = (seconds: number) => round3(Math.max(1, Math.round(seconds * fps)) / fps);

  /**
   * How long each shot overlaps the one before it — 0 for a hard cut, and for
   * the first shot, which has nothing in front of it to dissolve out of.
   *
   * `transitionOverlap` is the single opinion on the subject, shared with the
   * bench and the preview, and it is asked with the same running `available`
   * that `timelineDuration` uses. What it can't know is that this renderer
   * prints each dissolve as a piece of its own: a shot dissolved at both ends
   * by more than its own length would leave no body between them, which is a
   * file with no frames in it and a length nobody can print. So a second clamp
   * holds the *previous* shot to at least one frame of its own. It bites only
   * where the single-graph renderer would have nested one dissolve inside the
   * other, and there the film runs a little longer than the bench predicts —
   * the one place the two models can't be made to agree.
   */
  const overlaps: number[] = [];
  let available = 0;
  shots.forEach((shot, i) => {
    if (i === 0) {
      overlaps.push(0);
      available = shot.duration;
      return;
    }
    const asked = transitionOverlap(shot.clip, shot.duration, available);
    const room = Math.max(0, shots[i - 1].duration - overlaps[i - 1] - 1 / fps);
    const want = Math.min(asked, room);
    // Under half a frame is not a dissolve, it is a hard cut with a rounding
    // error — and a piece FFmpeg would be asked to fill with nothing.
    overlaps.push(want * fps >= 0.5 ? snap(want) : 0);
    available = available - overlaps[i] + shot.duration;
  });

  const bodies: Body[] = shots.map((shot, i) => {
    const head = overlaps[i];
    const tail = overlaps[i + 1] ?? 0;
    return { start: head, length: snap(shot.duration - head - tail) };
  });

  // Each dissolve is a piece in its own right, so the film is the bodies plus
  // one overlap per dissolve — the same length the old single graph produced.
  const durationSeconds = round3(
    bodies.reduce((sum, body) => sum + body.length, 0) +
      overlaps.reduce((sum, overlap) => sum + overlap, 0),
  );

  const threaded = encode.threads > 0;
  const globals = threaded
    ? ["-filter_complex_threads", String(encode.threads), "-filter_threads", String(encode.threads)]
    : [];

  /** Every piece is encoded identically, which is what lets the join copy. */
  const videoOut = [
    ...(threaded ? ["-threads", String(encode.threads)] : []),
    "-c:v", "libx264",
    "-preset", encode.preset,
    "-crf", String(encode.crf),
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-an",
  ];

  const picture: PictureContext = {
    width,
    height,
    fps,
    policy: policyOf(timeline),
    allowTitles,
    fontFile,
  };

  const passes: RenderPass[] = [];
  const pieces: string[] = [];

  shots.forEach((shot, i) => {
    const body = bodies[i];
    const name = `piece-${String(i).padStart(3, "0")}`;

    const bodyFile = path.join(workDir, `${name}-shot.mp4`);
    passes.push({
      label: `Printing shot ${i + 1} of ${shots.length}`,
      duration: body.length,
      weight: body.length,
      args: [
        ...globals,
        ...sourceInput(shot, body.start, body.length),
        "-filter_complex",
        pictureFilters(shot, picture, {
          inputIndex: 0,
          label: "v",
          shift: body.start,
          length: body.length,
        }).join(";"),
        "-map", "[v]",
        ...videoOut,
        // Exactly the length the plan measured, whatever the source did.
        "-t", String(body.length),
        bodyFile,
      ],
    });
    pieces.push(bodyFile);

    // The dissolve into the *next* shot, which sits between the two bodies.
    const next = shots[i + 1];
    const overlap = overlaps[i + 1] ?? 0;
    if (!next || overlap <= 0) return;

    // The one place a transition name reaches FFmpeg. Everything else in the
    // codebase asks `overlapsPrevious` and never needs to know the spelling.
    const xfadeName = XFADE_FOR[next.clip.transitionIn];
    if (!xfadeName) return;

    const tailStart = round3(body.start + body.length);
    const transitionFile = path.join(workDir, `${name}-into.mp4`);

    passes.push({
      label: `Dissolving into shot ${i + 2}`,
      duration: overlap,
      weight: overlap,
      args: [
        ...globals,
        ...sourceInput(shot, tailStart, overlap),
        ...sourceInput(next, 0, overlap),
        "-filter_complex",
        [
          ...pictureFilters(shot, picture, {
            inputIndex: 0,
            label: "a",
            shift: tailStart,
            length: overlap,
          }),
          ...pictureFilters(next, picture, {
            inputIndex: 1,
            label: "b",
            shift: 0,
            length: overlap,
          }),
          // Both inputs are at least the overlap long, so the blend starts at
          // nought and is the whole piece.
          `[a][b]xfade=transition=${xfadeName}:duration=${overlap}:offset=0[v]`,
        ].join(";"),
        "-map", "[v]",
        ...videoOut,
        "-t", String(overlap),
        transitionFile,
      ],
    });
    pieces.push(transitionFile);
  });

  const files: RenderPlan["files"] = [];
  let picturePath = pieces[0];

  // --- Join the reel ----------------------------------------------------
  // A stream copy: every piece left the same encoder at the same size, rate and
  // timebase, so there is nothing to re-encode. One piece needs no join at all.
  if (pieces.length > 1) {
    const listPath = path.join(workDir, "pieces.txt");
    files.push({
      path: listPath,
      contents: `${pieces.map((file) => `file '${file}'`).join("\n")}\n`,
    });

    picturePath = path.join(workDir, "picture.mp4");
    passes.push({
      label: "Joining the reel",
      duration: durationSeconds,
      // A copy is nothing beside an encode, but it isn't quite nothing.
      weight: Math.max(0.5, durationSeconds * 0.02),
      args: ["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", picturePath],
    });
  }

  // --- Picture layers ---------------------------------------------------
  const layers = layerPass(picturePath, {
    timeline,
    mediaById,
    localPaths,
    width,
    height,
    fps,
    videoLength: durationSeconds,
    workDir,
    globals,
    videoOut,
  });
  if (layers) {
    passes.push(layers.pass);
    picturePath = layers.output;
  }

  /**
   * Where each shot's own sound sits in the finished film, measured off the
   * same snapped pieces the picture was printed from.
   *
   * This is the whole of the sync contract. The obvious version builds the
   * sound from `clipDuration` and the picture from the frame-snapped pieces;
   * the totals agree in exact arithmetic, but every picture piece is rounded to
   * a whole frame and the sound isn't, so each shot carries up to half a frame
   * of error and it accumulates — a couple of frames over twenty shots,
   * ten in the worst case. `-shortest` hides the difference in *length*, which
   * is not the same thing as the drift: the music bed is pinned to the sound
   * clock, so a film cut to a beat visibly slides off it.
   */
  const spans = shots.map((_, i) => ({
    start: round3(
      bodies.slice(0, i).reduce((sum, body) => sum + body.length, 0) +
        overlaps.slice(0, i).reduce((sum, overlap) => sum + overlap, 0),
    ),
    duration: round3(overlaps[i] + bodies[i].length + (overlaps[i + 1] ?? 0)),
  }));

  // --- The sound --------------------------------------------------------
  const sound = soundPass({
    shots,
    spans,
    overlaps,
    timeline,
    mediaById,
    localPaths,
    hasAudio,
    audioPaths,
    videoLength: durationSeconds,
    workDir,
    threads: encode.threads,
  });
  passes.push(sound.pass);

  // --- Into one file ----------------------------------------------------
  const outputPath = path.join(workDir, "vlog.mp4");
  passes.push({
    label: "Finishing the print",
    duration: durationSeconds,
    weight: Math.max(0.5, durationSeconds * 0.02),
    args: [
      "-i", picturePath,
      "-i", sound.output,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c", "copy",
      "-shortest",
      "-movflags", "+faststart",
      outputPath,
    ],
  });

  return { files, passes, outputPath, durationSeconds };
}

/**
 * Layers over the finished picture, in one more pass.
 *
 * They are pinned to absolute times in the film rather than to a shot, so they
 * can't be printed into the pieces — which is why this is a second encode of
 * the whole picture, and why it only happens when somebody actually placed one.
 */
function layerPass(
  picturePath: string,
  ctx: {
    timeline: TimelineDoc;
    mediaById: Map<string, MediaItem>;
    localPaths: Map<string, string>;
    width: number;
    height: number;
    fps: number;
    videoLength: number;
    workDir: string;
    globals: string[];
    videoOut: string[];
  },
): { pass: RenderPass; output: string } | null {
  const { timeline, mediaById, localPaths, width, height, fps, videoLength } = ctx;

  const inputs: string[] = ["-i", picturePath];
  const filters: string[] = [];
  let inputIndex = 1;
  let current = "base";

  // The picture is already the right size and rate; the timebase pin is what
  // overlay wants in order to line the layers up by timestamp.
  filters.push(`[0:v]settb=1/${fps}[base]`);

  // Composited bottom-up, each one shifted onto its slot in the finished
  // picture with setpts so overlay can line it up by timestamp.
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

    /**
     * Layer geometry is fractions of the frame, and it stays fractions when
     * the frame changes shape: a corner inset stays in that corner, and its
     * height goes on following the source's own aspect against the box width.
     * Changing format therefore re-proportions layers rather than preserving
     * them — the alternative, rewriting the stored fractions on every format
     * change, can't keep both the position and the size (a 0.9-wide inset has
     * nowhere to go when the frame narrows) and would quietly clamp one of
     * them. Re-proportioning is at least visible and reversible: switch back
     * and the layout is exactly as it was. Nothing can break the render —
     * x and y are ≤ 1 so a layer always starts inside the frame, and overlay
     * crops whatever hangs off the bottom.
     */
    const boxWidth = evenPx(layer.width * width);
    const x = Math.round(layer.x * width);
    const y = Math.round(layer.y * height);

    const fadeIn = Math.min(layer.fadeIn, window.duration / 2);
    const fadeOut = Math.min(layer.fadeOut, window.duration / 2);

    const chain = [
      // Before the scale, so the layer's width applies to the straightened
      // picture and the height that follows from it is the right one.
      ...rotationFilters(media.rotation),
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
    // `repeatlast=0` is what stops a layer freezing on screen once its own
    // input runs out.
    filters.push(
      `[${current}][${lLabel}]overlay=x=${x}:y=${y}:eof_action=pass:repeatlast=0:format=auto[${outLabel}]`,
    );
    current = outLabel;
  });

  if (current === "base") return null;

  const output = path.join(ctx.workDir, "layered.mp4");
  return {
    output,
    pass: {
      label: "Laying the pictures over it",
      duration: videoLength,
      weight: videoLength,
      args: [
        ...ctx.globals,
        ...inputs,
        "-filter_complex", filters.join(";"),
        "-map", `[${current}]`,
        ...ctx.videoOut,
        output,
      ],
    },
  };
}

/**
 * Every sound in the film, mixed down to one file in one pass.
 *
 * Audio frames are kilobytes, so the all-at-once graph that sinks a picture
 * render costs nothing here. The base track is assembled exactly the way the
 * picture was — a piece per shot, crossfaded wherever the picture dissolves,
 * and to the lengths the picture's own frame-snapped pieces came out at —
 * which is what keeps the two in step once they're muxed back together.
 */
function soundPass(ctx: {
  shots: Shot[];
  /** Where each shot sits and how long it sounds for, off the picture's pieces. */
  spans: { start: number; duration: number }[];
  /** The same overlaps the picture was cut on, or the sound slides off it. */
  overlaps: number[];
  timeline: TimelineDoc;
  mediaById: Map<string, MediaItem>;
  localPaths: Map<string, string>;
  hasAudio?: Map<string, boolean>;
  audioPaths: Map<string, string>;
  videoLength: number;
  workDir: string;
  threads: number;
}): { pass: RenderPass; output: string } {
  const { shots, spans, overlaps, timeline, mediaById, localPaths, hasAudio, audioPaths } = ctx;

  const inputs: string[] = [];
  const filters: string[] = [];
  const clipLabels: string[] = [];
  /** Per shot, in step with `spans`: is there anything to hear? */
  const clipAudible: boolean[] = [];
  let inputIndex = 0;

  shots.forEach((shot, i) => {
    const label = `a${i}`;
    const duration = spans[i].duration;
    const audible =
      shot.clip.kind !== "photo" && !shot.clip.muted && clipHasAudio(shot.media, hasAudio);

    if (!audible) {
      // Photos and muted clips contribute silence of the right length.
      filters.push(
        `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration},asetpts=PTS-STARTPTS[${label}]`,
      );
    } else {
      const rate = clipSpeed(shot.clip);
      // Same bargain as the picture: pull `duration * rate` seconds of file and
      // let `atempo` hand back `duration` seconds of film.
      inputs.push(
        "-ss", String(shot.clip.trimStart),
        "-t", String(round3(Math.min(duration * rate, shot.sourceSpan))),
        "-i", shot.local,
      );
      const idx = inputIndex++;
      const tempo = atempoChain(rate);
      /*
       * `apad` before the trim: a file whose sound runs out before its picture
       * does — a clip trimmed past the end of its audio stream, or a recording
       * with a short track — would otherwise hand back a piece shorter than the
       * shot, and every shot after it would sit that much earlier than the
       * picture it belongs to.
       *
       * Full level: the score is what moves out of the way now, not the shot.
       */
      filters.push(
        `[${idx}:a]${AUDIO_FORMAT},${tempo.map((t) => `${t},`).join("")}apad,atrim=duration=${duration},` +
          `asetpts=PTS-STARTPTS,volume=${shot.clip.volume.toFixed(2)}[${label}]`,
      );
    }
    clipLabels.push(label);
    clipAudible.push(audible);
  });

  let baseAudio = clipLabels[0];

  for (let i = 1; i < clipLabels.length; i++) {
    const out = `ja${i}`;
    if (overlaps[i] > 0) {
      filters.push(
        `[${baseAudio}][${clipLabels[i]}]acrossfade=d=${overlaps[i]}:c1=tri:c2=tri[${out}]`,
      );
    } else {
      filters.push(`[${baseAudio}][${clipLabels[i]}]concat=n=2:v=0:a=1[${out}]`);
    }
    baseAudio = out;
  }

  // --- Music and layer sound -------------------------------------------
  const musicTracks = timeline.audio.filter((t) => !t.muted && audioPaths.has(t.id));
  const musicLabels: string[] = [];
  /** Position in `musicLabels` → how far that track gets out of the way. */
  const duckDepths = new Map<number, number>();
  const layerLabels: string[] = [];

  musicTracks.forEach((track, n) => {
    const file = audioPaths.get(track.id);
    if (!file) return;

    const span = audioTrackSpan(track, ctx.videoLength);
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
    if (timeline.duckClipAudio && track.duck > 0.001) duckDepths.set(musicLabels.length, track.duck);
    musicLabels.push(label);
  });

  layersInPaintOrder(timeline).forEach((layer, n) => {
    const media = mediaById.get(layer.mediaItemId);
    const local = localPaths.get(layer.mediaItemId);
    if (!media || !local) return;
    if (layer.kind !== "video" || layer.muted || !clipHasAudio(media, hasAudio)) return;

    const window = layerWindow(layer, ctx.videoLength);
    if (window.duration <= 0.05) return;

    inputs.push("-ss", String(layer.trimStart), "-t", String(window.duration), "-i", local);
    const idx = inputIndex++;

    const label = `la${n}`;
    const delayMs = Math.round(window.start * 1000);
    filters.push(
      `[${idx}:a]${AUDIO_FORMAT},` +
        `atrim=duration=${window.duration},asetpts=PTS-STARTPTS,` +
        `volume=${layer.volume.toFixed(2)}` +
        (delayMs > 0 ? `,adelay=${delayMs}:all=1` : "") +
        `[${label}]`,
    );
    layerLabels.push(label);
  });

  // --- The duck ---------------------------------------------------------
  // The score is compressed against the shots' own sound, so it drops while
  // somebody is talking and comes back up in the gaps. The key is the finished
  // base track — everything the audience hears from the picture, already cut
  // and crossfaded — which is the only stream whose clock matches the music's.
  //
  // Nothing is emitted unless there's actually a voice to duck under: no
  // audible shot, or every audible shot opted out, and the graph is exactly the
  // one it was before any of this existed.
  const opensTheDuck = clipAudible.some((audible, i) => audible && shots[i].clip.duckMusic);
  const duckTargets = [...duckDepths.entries()];

  if (duckTargets.length > 0 && opensTheDuck) {
    filters.push(`[${baseAudio}]asplit=2[dckdry][dckraw]`);
    baseAudio = "dckdry";

    // Shots that opted out are cut out of the *key*, not the mix: their sound
    // still plays, it just doesn't lean on the music.
    const held = clipAudible
      .map((audible, i) => (audible && !shots[i].clip.duckMusic ? i : -1))
      .filter((i) => i >= 0);

    let key = "dckraw";
    if (held.length > 0) {
      const windows = held
        .map((i) => {
          const from = spans[i].start;
          const to = round3(from + spans[i].duration);
          return `between(t,${from.toFixed(3)},${to.toFixed(3)})`;
        })
        .join("+");
      filters.push(`[${key}]volume=0:enable='${windows}'[dckkey]`);
      key = "dckkey";
    }

    // One copy of the key per track being ducked; a single track takes it whole.
    const keys = duckTargets.length === 1 ? [key] : duckTargets.map((_, n) => `dckk${n}`);
    if (duckTargets.length > 1) {
      filters.push(`[${key}]asplit=${keys.length}${keys.map((l) => `[${l}]`).join("")}`);
    }

    duckTargets.forEach(([position, depth], n) => {
      const out = `dckm${n}`;
      filters.push(
        `[${musicLabels[position]}][${keys[n]}]` +
          `sidechaincompress=threshold=${DUCK_SIDECHAIN.threshold}` +
          `:ratio=${duckRatio(depth)}` +
          `:attack=${DUCK_SIDECHAIN.attack}` +
          `:release=${DUCK_SIDECHAIN.release}` +
          // Explicit rather than defaulted: `makeup` handing back the gain it
          // just took would undo the whole point, and builds have disagreed
          // about what it defaults to.
          `:makeup=1:level_sc=1[${out}]`,
      );
      musicLabels[position] = out;
    });
  }

  const extra = [...musicLabels, ...layerLabels];
  let output = `[${baseAudio}]`;
  if (extra.length > 0) {
    // `normalize=0`: every level on the timeline was dialled in by hand, and
    // amix's default would quietly divide them all by the number of tracks —
    // adding a second track would duck the first. The limiter is the price of
    // that: it catches the summed peaks instead of letting them clip.
    filters.push(
      `[${baseAudio}]${extra.map((l) => `[${l}]`).join("")}` +
        `amix=inputs=${extra.length + 1}:duration=first:dropout_transition=0:normalize=0,` +
        `alimiter=limit=0.95:level=disabled[mixa]`,
    );
    output = "[mixa]";
  }

  const file = path.join(ctx.workDir, "sound.m4a");

  return {
    output: file,
    pass: {
      label: "Laying the sound under it",
      duration: ctx.videoLength,
      // Sound encodes an order of magnitude faster than picture does.
      weight: Math.max(0.5, ctx.videoLength * 0.08),
      args: [
        ...(ctx.threads > 0 ? ["-filter_complex_threads", String(ctx.threads)] : []),
        ...inputs,
        "-filter_complex", filters.join(";"),
        "-map", output,
        "-vn",
        "-c:a", "aac",
        "-b:a", "192k",
        file,
      ],
    },
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
