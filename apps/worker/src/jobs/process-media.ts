import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, asc, db, eq, mediaItems, members } from "@vlogbuddy/db";
import { env } from "../env";
import { buildStorageKey, downloadToFile, uploadFile } from "../storage";
import {
  audioPeaks,
  generateFilmstrip,
  generatePhotoProxy,
  generateProxy,
  generateThumbnail,
  planFilmstrip,
  probe,
  PHOTO_PROXY_MAX_EDGE,
  type ProbeResult,
} from "../ffmpeg";
import { analyzeBeats } from "../beats";
import { readPhotoExif } from "../exif";
import { notifyMediaUpdated, requestCutResync } from "../notify";

export interface ProcessMediaJob {
  mediaItemId: string;
  vlogId: string;
}

/**
 * Post-upload pipeline: probe metadata, make a thumbnail for the dump view and
 * a proxy for smooth editing — a low-res MP4 for video, a JPEG for a photo the
 * browser can't paint or can't afford. It also settles when and where the file
 * was taken, out of its own EXIF or container tags, because the browser's guess
 * at a capture time is what the auto-cut would otherwise build scenes from.
 */
export async function processMedia(job: ProcessMediaJob): Promise<void> {
  const { mediaItemId } = job;

  const [item] = await db.select().from(mediaItems).where(eq(mediaItems.id, mediaItemId)).limit(1);
  if (!item) {
    console.warn(`[process-media] ${mediaItemId} vanished, skipping`);
    return;
  }

  await db.update(mediaItems).set({ status: "processing" }).where(eq(mediaItems.id, item.id));

  const workDir = await mkdtemp(path.join(env().TMP_DIR ?? tmpdir(), "media-"));

  try {
    const ext = path.extname(item.originalFilename) || guessExtension(item.contentType);
    const localOriginal = path.join(workDir, `original${ext}`);

    await downloadToFile(item.storageKey, localOriginal);

    const isVideo = item.kind === "video";
    const isPhoto = item.kind === "photo";
    const isAudio = item.contentType.startsWith("audio/");

    const info = await probe(localOriginal).catch((err) => {
      console.warn(`[process-media] probe failed for ${item.id}:`, err.message);
      return null;
    });

    // ffprobe reads container tags and a photo keeps everything in its EXIF,
    // so a still needs a second opinion to say when and where it was taken.
    const exif = isPhoto ? await readPhotoExif(localOriginal) : null;

    let thumbnailKey: string | null = null;
    let proxyKey: string | null = null;
    let filmstripKey: string | null = null;
    let filmstripFrames: number | null = null;
    let filmstripIntervalSeconds: number | null = null;
    let width = info?.width ?? null;
    let height = info?.height ?? null;

    // An uploaded track is as likely to end up the music bed as a YouTube
    // link, so it gets the same beat analysis. Best-effort: a file we can't
    // read a tempo off is simply a film the auto-cut won't cut to the music.
    const beats = isAudio ? await analyzeBeats(localOriginal) : null;

    // The envelope the audio lane draws. Same best-effort footing as the beat
    // grid: no peaks just means the lane stays the flat block it always was.
    const peaks = isAudio ? await audioPeaks(localOriginal) : null;

    // Audio has no frames to show; the UI renders an icon instead.
    if (!isAudio) {
      const thumbPath = path.join(workDir, "thumb.jpg");
      try {
        const seekTo = isVideo ? Math.min(1, (info?.durationSeconds ?? 2) / 2) : 0;
        await generateThumbnail(localOriginal, thumbPath, isVideo, seekTo);
        thumbnailKey = buildStorageKey(item.vlogId, "thumb", item.id, "thumb.jpg");
        await uploadFile(thumbnailKey, thumbPath, "image/jpeg");
      } catch (err) {
        console.warn(`[process-media] thumbnail failed for ${item.id}:`, (err as Error).message);
      }
    }

    if (isVideo) {
      const proxyPath = path.join(workDir, "proxy.mp4");
      try {
        await generateProxy(localOriginal, proxyPath);
        proxyKey = buildStorageKey(item.vlogId, "proxy", item.id, "proxy.mp4");
        await uploadFile(proxyKey, proxyPath, "video/mp4");
      } catch (err) {
        console.warn(`[process-media] proxy failed for ${item.id}:`, (err as Error).message);
      }

      // The contact sheet the strip paints across the shot. Built from the
      // original rather than the proxy so it survives a proxy that failed.
      const plan = planFilmstrip(info?.durationSeconds ?? null);
      if (plan) {
        const stripPath = path.join(workDir, "filmstrip.jpg");
        try {
          await generateFilmstrip(localOriginal, stripPath, plan);
          filmstripKey = buildStorageKey(item.vlogId, "filmstrip", item.id, "filmstrip.jpg");
          await uploadFile(filmstripKey, stripPath, "image/jpeg");
          filmstripFrames = plan.frames;
          filmstripIntervalSeconds = plan.intervalSeconds;
        } catch (err) {
          filmstripKey = null;
          console.warn(`[process-media] filmstrip failed for ${item.id}:`, (err as Error).message);
        }
      }
    }

    if (isPhoto && needsDisplayProxy(item.contentType, info)) {
      const proxyPath = path.join(workDir, "proxy.jpg");
      try {
        await generatePhotoProxy(localOriginal, proxyPath);
        proxyKey = buildStorageKey(item.vlogId, "proxy", item.id, "proxy.jpg");
        await uploadFile(proxyKey, proxyPath, "image/jpeg");

        /**
         * A tiled HEIC probes as a single 512px tile, not as the photograph,
         * because each tile is its own stream. The proxy is a flattened decode,
         * so whenever it comes out bigger than the probe claimed, it is the one
         * telling the truth about the frame.
         */
        const proxyInfo = await probe(proxyPath).catch(() => null);
        if (proxyInfo?.width && proxyInfo.width > (width ?? 0)) {
          width = proxyInfo.width;
          height = proxyInfo.height;
        }
      } catch (err) {
        // Non-fatal, like every other derivative here: the photo is still in
        // the pile and still counts, it just won't preview outside Safari.
        const hint = isAppleStill(item.contentType)
          ? " (this FFmpeg build may be too old to read HEIC — 7.0 or newer decodes it)"
          : "";
        console.warn(
          `[process-media] photo proxy failed for ${item.id}${hint}:`,
          (err as Error).message,
        );
      }
    }

    /**
     * Capture time, ranked by how close the source sat to the shutter.
     *
     * Immich is the exception that outranks us: it has already read this
     * asset's EXIF, and it resolves the timezone a naive EXIF date is missing
     * from the asset's own location and the owner's settings. Re-deriving it
     * here would shift an imported photo by the worker's offset for no gain.
     * Otherwise the file's EXIF beats the container, which beats the browser's
     * `File.lastModified` — often no more than when the file was copied.
     */
    const immichDated = item.immichAssetId !== null && item.capturedAt !== null;
    const capturedAt = immichDated
      ? item.capturedAt
      : exif?.capturedAt ?? info?.capturedAt ?? item.capturedAt ?? null;

    // Same order of trust, and a failed read never erases what's on the row.
    const latitude = exif?.latitude ?? info?.latitude ?? item.latitude ?? null;
    const longitude = exif?.longitude ?? info?.longitude ?? item.longitude ?? null;

    /**
     * Photographs are silent by definition; everything else is whatever the
     * probe found. A probe that failed leaves this unknown rather than
     * claiming silence — the render has to reference `[n:a]` for a clip that
     * has sound and must not for one that hasn't, and guessing wrong either
     * loses the audio or fails the whole filter graph.
     */
    const hasAudio = isPhoto ? false : info?.hasAudio ?? item.hasAudio ?? null;

    /**
     * Content hash, in the same shape Immich uses. Computing it here — while
     * we already have the original on disk — is what lets someone later push
     * this pile into their own Immich without re-uploading what they have.
     */
    const checksumSha1 = item.checksumSha1 ?? (await hashFile(localOriginal));

    await db
      .update(mediaItems)
      .set({
        status: "ready",
        thumbnailKey,
        proxyKey,
        filmstripKey,
        filmstripFrames,
        filmstripIntervalSeconds,
        peaks,
        width,
        height,
        durationSeconds: info?.durationSeconds ?? null,
        capturedAt,
        latitude,
        longitude,
        hasAudio,
        checksumSha1,
        bpm: beats?.bpm ?? null,
        beatOffsetSeconds: beats?.beatOffsetSeconds ?? null,
        beatTimes: beats?.beatTimes ?? null,
        beatConfidence: beats?.confidence ?? null,
        error: null,
      })
      .where(eq(mediaItems.id, item.id));

    await notifyMediaUpdated(item.vlogId, {
      mediaItemId: item.id,
      status: "ready",
      thumbnailKey,
      proxyKey,
      durationSeconds: info?.durationSeconds ?? null,
      width,
      height,
      capturedAt: capturedAt ? capturedAt.toISOString() : null,
    });

    /**
     * The cut was built before any of this was known.
     *
     * An upload joins the film the moment it is confirmed, but at that point
     * nobody has opened the file: no duration, so the auto-cut has nothing to
     * budget and leaves the out-point open, and no capture time, so it can't
     * tell which day or which scene the shot belongs to. Now that probing has
     * landed, the engine has to look again — otherwise the running time and
     * the scene breaks stay wrong until some unrelated vote happens to
     * rebuild the document.
     *
     * The engine lives in the web app, so this goes over the same NOTIFY the
     * Immich import uses, and coalesced: see `requestCutResync`.
     */
    const attributeTo = item.uploaderId ?? (await creatorOf(item.vlogId));
    if (attributeTo) requestCutResync(item.vlogId, attributeTo);

    console.log(`[process-media] ${item.id} ready (${item.kind})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[process-media] ${item.id} failed:`, message);

    await db
      .update(mediaItems)
      .set({ status: "failed", error: message.slice(0, 1000) })
      .where(eq(mediaItems.id, item.id));

    await notifyMediaUpdated(item.vlogId, {
      mediaItemId: item.id,
      status: "failed",
      thumbnailKey: null,
      proxyKey: null,
      durationSeconds: null,
      width: null,
      height: null,
      capturedAt: null,
      error: message.slice(0, 500),
    });

    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Formats every browser can paint. Anything outside this set — HEIC and HEIF
 * from an iPhone, DNG from a camera roll that came in through Immich — is a
 * file the pile can hold but nobody can see, so it has to be handed over as
 * a JPEG instead.
 */
const BROWSER_SAFE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

function isAppleStill(contentType: string): boolean {
  return contentType === "image/heic" || contentType === "image/heif";
}

/**
 * Whether this photo needs a JPEG standing in for it.
 *
 * Two different reasons, deliberately kept to one decision. A format no browser
 * reads always needs one. A format they do read only needs one when it's
 * enormous: re-encoding an ordinary snap costs CPU and storage on a machine
 * that likely has little of either and buys nothing, but a 48MP original is a
 * picture the editor downloads in full to show at a fraction of the size.
 */
function needsDisplayProxy(contentType: string, info: ProbeResult | null): boolean {
  if (!BROWSER_SAFE_IMAGE_TYPES.has(contentType)) return true;
  return Math.max(info?.width ?? 0, info?.height ?? 0) > PHOTO_PROXY_MAX_EDGE;
}

/**
 * Somebody to sign the resync with. The uploader is the obvious answer, but
 * the column goes null when a member is removed, and a re-cut with nobody's
 * name on it would fail the foreign key rather than just look anonymous.
 */
async function creatorOf(vlogId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.vlogId, vlogId), eq(members.role, "creator")))
    .orderBy(asc(members.createdAt))
    .limit(1);
  return row?.id ?? null;
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha1");
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("base64")));
  });
}

function guessExtension(contentType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "image/avif": ".avif",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "video/x-msvideo": ".avi",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/aac": ".aac",
    "audio/ogg": ".ogg",
    "audio/flac": ".flac",
  };
  return map[contentType] ?? ".bin";
}
