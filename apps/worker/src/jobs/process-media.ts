import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { db, eq, mediaItems } from "@vlogbuddy/db";
import { env } from "../env";
import { buildStorageKey, downloadToFile, uploadFile } from "../storage";
import { generateProxy, generateThumbnail, probe } from "../ffmpeg";
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
    }

    // Prefer the real capture time from the file over the client's guess.
    const capturedAt = info?.capturedAt ?? item.capturedAt ?? null;

    await db
      .update(mediaItems)
      .set({
        status: "ready",
        thumbnailKey,
        proxyKey,
        width: info?.width ?? null,
        height: info?.height ?? null,
        durationSeconds: info?.durationSeconds ?? null,
        capturedAt,
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
