import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { db, eq, mediaItems } from "@vlogbuddy/db";
import { env } from "../env";
import { buildStorageKey, downloadToFile, uploadFile } from "../storage";
import { needsDisplayCopy } from "@vlogbuddy/shared";
import {
  audioPeaks,
  generateDisplayImage,
  generateFilmstrip,
  generateProxy,
  generateThumbnail,
  planFilmstrip,
  probe,
} from "../ffmpeg";
import { analyzeBeats } from "../beats";
import { notifyMediaUpdated } from "../notify";

export interface ProcessMediaJob {
  mediaItemId: string;
  vlogId: string;
}

/**
 * Post-upload pipeline: probe metadata, make a thumbnail for the dump view and
 * (for video) a low-res proxy for smooth editing. Capture time from the file
 * beats whatever the browser guessed, so chronological ordering is accurate.
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
    const isAudio = item.contentType.startsWith("audio/");

    const info = await probe(localOriginal).catch((err) => {
      console.warn(`[process-media] probe failed for ${item.id}:`, err.message);
      return null;
    });

    let thumbnailKey: string | null = null;
    let proxyKey: string | null = null;
    let filmstripKey: string | null = null;
    let filmstripFrames: number | null = null;
    let filmstripIntervalSeconds: number | null = null;

    // An uploaded track is as likely to end up the music bed as a YouTube
    // link, so it gets the same beat analysis. Best-effort: a file we can't
    // read a tempo off is simply a film the auto-cut won't cut to the music.
    const beats = isAudio ? await analyzeBeats(localOriginal) : null;

    // The envelope the audio lane draws. Same best-effort footing as the beat
    // grid: no peaks just means the lane stays the flat block it always was.
    const peaks = isAudio ? await audioPeaks(localOriginal) : null;

    /**
     * A photo a browser can't decode gets a JPEG stand-in, and everything
     * downstream derives from that rather than the original — including the
     * thumbnail, whose own decode would fail for the same reason.
     *
     * It lands under the proxy key. `proxyKey` was only ever used by video, it
     * is already presigned for every item, and "the browser-friendly version
     * of this file" is exactly what a proxy is — so an iPhone's HEIC becomes
     * viewable without a migration.
     */
    let still = localOriginal;
    if (!isAudio && !isVideo && needsDisplayCopy(item.contentType)) {
      const displayPath = path.join(workDir, "display.jpg");
      try {
        await generateDisplayImage(localOriginal, displayPath);
        proxyKey = buildStorageKey(item.vlogId, "proxy", item.id, "display.jpg");
        await uploadFile(proxyKey, displayPath, "image/jpeg");
        still = displayPath;
      } catch (err) {
        console.warn(`[process-media] display copy failed for ${item.id}:`, (err as Error).message);
      }
    }

    // Audio has no frames to show; the UI renders an icon instead.
    if (!isAudio) {
      const thumbPath = path.join(workDir, "thumb.jpg");
      try {
        const seekTo = isVideo ? Math.min(1, (info?.durationSeconds ?? 2) / 2) : 0;
        await generateThumbnail(still, thumbPath, isVideo, seekTo);
        thumbnailKey = buildStorageKey(item.vlogId, "thumb", item.id, "thumb.jpg");
        await uploadFile(thumbnailKey, thumbPath, "image/jpeg");
      } catch (err) {
        console.warn(`[process-media] thumbnail failed for ${item.id}:`, (err as Error).message);
      }
    }

    /**
     * A photo with no thumbnail and no stand-in is one nobody can see, and
     * marking it `ready` put a blank card in the pile that could never be
     * judged and never explained itself. Better to say so.
     */
    if (!isAudio && !isVideo && !thumbnailKey && !proxyKey) {
      const error = needsDisplayCopy(item.contentType)
        ? "This box can't read HEIC photos yet. Export it as a JPEG and drop it in again."
        : "We couldn't read this photo.";
      await db
        .update(mediaItems)
        .set({ status: "failed", error })
        .where(eq(mediaItems.id, item.id));
      // Same as any other failure: the pile updates without a reload.
      await notifyMediaUpdated(item.vlogId, {
        mediaItemId: item.id,
        status: "failed",
        thumbnailKey: null,
        proxyKey: null,
        durationSeconds: null,
        width: null,
        height: null,
        capturedAt: null,
        error,
      });
      return;
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

    // Prefer the real capture time from the file over the client's guess.
    const capturedAt = info?.capturedAt ?? item.capturedAt ?? null;

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
        width: info?.width ?? null,
        height: info?.height ?? null,
        durationSeconds: info?.durationSeconds ?? null,
        capturedAt,
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
      width: info?.width ?? null,
      height: info?.height ?? null,
      capturedAt: capturedAt ? capturedAt.toISOString() : null,
    });

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
