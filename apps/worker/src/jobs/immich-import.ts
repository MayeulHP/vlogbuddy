import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { and, db, eq, isNotNull, mediaItems, sql } from "@vlogbuddy/db";
import {
  downloadAsset,
  listAlbumAssets,
  mediaKindForImmichAsset,
  mimeForImmichAsset,
  slugifyFilename,
  type ImmichAsset,
  type ImmichCredentials,
} from "@vlogbuddy/shared";
import { env } from "../env";
import { buildStorageKey, uploadFileStreaming } from "../storage";
import { credentialsForMember, reportTransfer } from "../immich-connection";
import { notifyCutResync } from "../notify";
import { enqueueProcessMedia } from "../queue";

export interface ImmichImportJob {
  transferId: string;
  vlogId: string;
  memberId: string;
  albumId: string;
  albumName: string;
  /** Empty means the whole album. */
  assetIds: string[];
}

/**
 * Pulls assets out of somebody's Immich and into the vlog's pile.
 *
 * The transfer is server-to-server: the browser never handles the bytes, so
 * importing a 400-photo album from a phone on mobile data costs nothing but
 * the tap. Each asset lands as a normal media item and goes through the same
 * thumbnail/proxy pipeline as a drag-and-drop upload, which is what keeps the
 * rest of the app from having to know where anything came from.
 */
export async function immichImport(job: ImmichImportJob): Promise<void> {
  const { transferId, vlogId, memberId, albumId, albumName } = job;

  await reportTransfer(transferId, {
    status: "running",
    startedAt: new Date(),
    message: "Asking Immich what's in the album…",
  });

  const workDir = await mkdtemp(path.join(env().TMP_DIR, "immich-in-"));

  try {
    const creds = await credentialsForMember(memberId);

    const wanted = new Set(job.assetIds);
    const all = await listAlbumAssets(creds, albumId);

    const candidates = all.filter((asset) => {
      if (asset.isTrashed) return false;
      if (wanted.size > 0 && !wanted.has(asset.id)) return false;
      return mediaKindForImmichAsset(asset) !== null;
    });

    /**
     * Two people importing the same shared album shouldn't double the pile.
     * Immich's checksum is a content hash, so this also catches the same photo
     * arriving from two different instances.
     */
    const seen = await existingChecksums(vlogId);
    const fresh = candidates.filter((a) => !a.checksum || !seen.has(a.checksum));
    const alreadyHere = candidates.length - fresh.length;

    await reportTransfer(transferId, {
      total: fresh.length,
      skipped: alreadyHere,
      message: fresh.length === 0 ? "Everything was already here" : "Copying…",
    });

    if (fresh.length === 0) {
      await reportTransfer(transferId, {
        status: "done",
        finishedAt: new Date(),
        message: `Nothing new — all ${candidates.length} were already in the pile`,
      });
      return;
    }

    let uploadIndex = await nextUploadIndex(vlogId);
    let done = 0;
    let failed = 0;

    for (const asset of fresh) {
      try {
        await importOne({
          asset,
          creds,
          vlogId,
          memberId,
          albumName,
          workDir,
          uploadIndex: uploadIndex++,
        });
        done++;
      } catch (err) {
        failed++;
        console.error(
          `[immich-import] ${asset.id} (${asset.originalFileName}) failed:`,
          (err as Error).message,
        );
      }

      // Cheap enough to report every asset, and the bar moving matters here.
      await reportTransfer(transferId, {
        done,
        failed,
        message: `${done} of ${fresh.length} copied`,
      });
    }

    // The pile changed; let the web app fold the new media into the cut.
    await notifyCutResync(vlogId, memberId);

    await reportTransfer(transferId, {
      status: failed === fresh.length ? "failed" : "done",
      finishedAt: new Date(),
      message: summarise(done, alreadyHere, failed),
      error: failed === fresh.length ? "Every asset failed to copy" : null,
    });

    console.log(`[immich-import] ${transferId}: ${done} copied, ${failed} failed`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[immich-import] ${transferId} failed:`, message);
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

async function importOne(input: {
  asset: ImmichAsset;
  creds: ImmichCredentials;
  vlogId: string;
  memberId: string;
  albumName: string;
  workDir: string;
  uploadIndex: number;
}): Promise<void> {
  const { asset, creds, vlogId, memberId, albumName, workDir, uploadIndex } = input;

  const kind = mediaKindForImmichAsset(asset);
  if (!kind) return;

  const filename = slugifyFilename(asset.originalFileName);
  const local = path.join(workDir, `asset-${asset.id}${path.extname(filename) || ""}`);

  // Stream Immich → disk, hashing as it goes so we never hold the file twice.
  const res = await downloadAsset(creds, asset.id);
  if (!res.body) throw new Error("Immich sent an empty response");

  const hash = createHash("sha1");
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on("data", (chunk: Buffer) => hash.update(chunk));
  await pipeline(source, createWriteStream(local));

  const checksum = hash.digest("base64");
  const contentType = mimeForImmichAsset(asset);
  const storageKey = buildStorageKey(vlogId, "original", asset.id, filename);
  const sizeBytes = await uploadFileStreaming(storageKey, local, contentType);

  const [item] = await db
    .insert(mediaItems)
    .values({
      vlogId,
      uploaderId: memberId,
      kind,
      originalFilename: asset.originalFileName.slice(0, 400),
      contentType,
      sizeBytes,
      storageKey,
      // Immich knows when the shutter actually fired; trust it over the file.
      capturedAt: parseDate(asset.localDateTime) ?? parseDate(asset.fileCreatedAt),
      uploadIndex,
      durationSeconds: asset.duration != null ? asset.duration / 1000 : null,
      width: asset.width,
      height: asset.height,
      status: "pending",
      checksumSha1: asset.checksum || checksum,
      immichAssetId: asset.id,
      immichAlbumName: albumName,
    })
    .returning();

  // Same pipeline as a browser upload: thumbnail, proxy, real capture time.
  await enqueueProcessMedia({ mediaItemId: item.id, vlogId });

  await rm(local, { force: true }).catch(() => {});
}

/** Every content hash already in this vlog, so we never import a twin. */
async function existingChecksums(vlogId: string): Promise<Set<string>> {
  const rows = await db
    .select({ checksum: mediaItems.checksumSha1 })
    .from(mediaItems)
    .where(and(eq(mediaItems.vlogId, vlogId), isNotNull(mediaItems.checksumSha1)));
  return new Set(rows.map((r) => r.checksum).filter((c): c is string => Boolean(c)));
}

async function nextUploadIndex(vlogId: string): Promise<number> {
  const [row] = await db
    .select({ next: sql<number>`coalesce(max(${mediaItems.uploadIndex}), 0) + 1` })
    .from(mediaItems)
    .where(eq(mediaItems.vlogId, vlogId));
  return row?.next ?? 1;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function summarise(done: number, skipped: number, failed: number): string {
  const parts = [`${done} copied`];
  if (skipped > 0) parts.push(`${skipped} already here`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}
