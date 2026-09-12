import { createHash } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { and, db, eq, mediaItems, vlogs } from "@vlogbuddy/db";
import {
  addAssetsToAlbum,
  bulkUploadCheck,
  createAlbum,
  uploadAsset,
  type ImmichCredentials,
} from "@vlogbuddy/shared";
import type { MediaItem } from "@vlogbuddy/db";
import { env } from "../env";
import { downloadToFile } from "../storage";
import { credentialsForMember, reportTransfer } from "../immich-connection";

export interface ImmichExportJob {
  transferId: string;
  vlogId: string;
  memberId: string;
  albumName: string;
}

/**
 * Copies the whole pile into one person's Immich, as an album.
 *
 * This is the half Immich itself doesn't do: two people with their own servers
 * have no way to merge libraries. Here, whoever brought the photos, everyone
 * who's connected can pull the complete set of originals down into their own
 * instance — so the vlog isn't the only surviving copy of the trip.
 *
 * Safe to run twice. Immich is asked up front which files it already has (by
 * content hash), so a second run uploads only what arrived since, and the
 * duplicates it does find still get added to the album.
 */
export async function immichExport(job: ImmichExportJob): Promise<void> {
  const { transferId, vlogId, memberId, albumName } = job;

  await reportTransfer(transferId, {
    status: "running",
    startedAt: new Date(),
    message: "Asking your Immich what it already has…",
  });

  const workDir = await mkdtemp(path.join(env().TMP_DIR, "immich-out-"));

  try {
    const creds = await credentialsForMember(memberId);

    const items = await db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.vlogId, vlogId), eq(mediaItems.status, "ready")));

    if (items.length === 0) {
      await reportTransfer(transferId, {
        status: "done",
        finishedAt: new Date(),
        message: "There's nothing in the pile yet",
      });
      return;
    }

    /**
     * Anything the worker has hashed can be checked before we move a byte.
     * Items without a hash (uploaded before this feature existed) get sent and
     * let Immich's own duplicate detection sort them out.
     */
    const hashed = items.filter((i) => i.checksumSha1);
    const unhashed = items.filter((i) => !i.checksumSha1);

    const check = await bulkUploadCheck(
      creds,
      hashed.map((i) => i.checksumSha1 as string),
    );

    const toUpload = [
      ...hashed.filter((i) => !check.existing.has(i.checksumSha1 as string)),
      ...unhashed,
    ];
    /** Assets their server already had — still ours to put in the album. */
    const knownAssetIds = new Set(check.existing.values());

    await reportTransfer(transferId, {
      total: toUpload.length,
      skipped: items.length - toUpload.length,
      message:
        toUpload.length === 0
          ? "You already have all of it — just filing it into an album"
          : `Uploading ${toUpload.length} of ${items.length}…`,
    });

    let done = 0;
    let failed = 0;

    for (const item of toUpload) {
      try {
        const assetId = await exportOne(item, creds, workDir);
        if (assetId) knownAssetIds.add(assetId);
        done++;
      } catch (err) {
        failed++;
        console.error(
          `[immich-export] ${item.id} (${item.originalFilename}) failed:`,
          (err as Error).message,
        );
      }

      await reportTransfer(transferId, {
        done,
        failed,
        message: `${done} of ${toUpload.length} uploaded`,
      });
    }

    // The album is the point — it's what makes this a copy of *the vlog*
    // rather than a pile of loose photos in their timeline.
    let remoteAlbumId: string | null = null;
    if (knownAssetIds.size > 0) {
      await reportTransfer(transferId, { message: "Filing everything into an album…" });
      try {
        const album = await createAlbum(creds, {
          albumName,
          description: "Imported from VlogBuddy",
        });
        remoteAlbumId = album.id;
        await addAssetsToAlbum(creds, album.id, Array.from(knownAssetIds));
      } catch (err) {
        // The media is safely in their library; only the tidying failed.
        console.warn(`[immich-export] album step failed:`, (err as Error).message);
      }
    }

    await reportTransfer(transferId, {
      status: failed === toUpload.length && toUpload.length > 0 ? "failed" : "done",
      finishedAt: new Date(),
      remoteAlbumId,
      message: summarise(done, items.length - toUpload.length, failed, remoteAlbumId !== null),
      error: failed === toUpload.length && toUpload.length > 0 ? "Every upload failed" : null,
    });

    console.log(`[immich-export] ${transferId}: ${done} uploaded, ${failed} failed`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[immich-export] ${transferId} failed:`, message);
    await reportTransfer(transferId, {
      status: "failed",
      finishedAt: new Date(),
      error: message.slice(0, 500),
      message: null,
    });
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Returns the asset id on the far side, whether it was new or a duplicate. */
async function exportOne(
  item: MediaItem,
  creds: ImmichCredentials,
  workDir: string,
): Promise<string | null> {
  const local = path.join(workDir, `out-${item.id}${path.extname(item.originalFilename) || ""}`);
  await downloadToFile(item.storageKey, local);

  try {
    // A file-backed Blob: the bytes go from disk to the socket without the
    // whole video sitting in the heap.
    const data = await openAsBlob(local, { type: item.contentType });

    const result = await uploadAsset(creds, {
      data,
      filename: item.originalFilename,
      fileCreatedAt: item.capturedAt ?? item.createdAt,
      durationMs: item.durationSeconds != null ? item.durationSeconds * 1000 : null,
    });

    // Backfill the hash so the next export can skip this one without asking.
    if (!item.checksumSha1) {
      const checksum = await hashFile(local);
      await db.update(mediaItems).set({ checksumSha1: checksum }).where(eq(mediaItems.id, item.id));
    }

    return result.id;
  } finally {
    await rm(local, { force: true }).catch(() => {});
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

/** The vlog's title makes the album name; falls back to something readable. */
export async function albumNameForVlog(vlogId: string): Promise<string> {
  const [vlog] = await db.select().from(vlogs).where(eq(vlogs.id, vlogId)).limit(1);
  return vlog?.title?.trim() || "VlogBuddy import";
}

function summarise(done: number, skipped: number, failed: number, filed: boolean): string {
  const parts: string[] = [];
  if (done > 0) parts.push(`${done} added to your Immich`);
  if (skipped > 0) parts.push(`${skipped} you already had`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (parts.length === 0) parts.push("Nothing to copy");
  if (filed) parts.push("filed into an album");
  return parts.join(" · ");
}
