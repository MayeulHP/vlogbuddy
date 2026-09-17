import { createHash } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { and, db, desc, eq, isNotNull, mediaItems, renderJobs, vlogs } from "@vlogbuddy/db";
import {
  addAssetsToAlbum,
  bulkUploadCheck,
  createAlbum,
  uploadAsset,
  type ImmichCredentials,
} from "@vlogbuddy/shared";
import type { MediaItem, RenderJob } from "@vlogbuddy/db";
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
 * Copies the whole pile — and the finished film — into one person's Immich,
 * as an album.
 *
 * This is the half Immich itself doesn't do: two people with their own servers
 * have no way to merge libraries. Here, whoever brought the photos, everyone
 * who's connected can pull the complete set of originals down into their own
 * instance — so the vlog isn't the only surviving copy of the trip. The film
 * goes last, because it's the thing people came for and the originals are the
 * raw material behind it.
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

    const film = await latestFinishedRender(vlogId);

    if (items.length === 0 && !film) {
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

    // The film counts towards the bar like anything else, so the numbers people
    // watch tick up match what actually gets moved.
    const attempts = toUpload.length + (film ? 1 : 0);

    let done = 0;
    let failed = 0;
    let skipped = items.length - toUpload.length;

    await reportTransfer(transferId, {
      total: attempts,
      skipped,
      message: startMessage(toUpload.length, items.length, film !== null),
    });

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

    /** A clause for the summary, so people can tell what happened to the film. */
    let filmNote = "nothing rendered yet, so no film";

    if (film) {
      await reportTransfer(transferId, { message: "Copying the finished film over…" });
      try {
        const result = await exportFilm(film, creds, workDir, {
          filename: filmFilename(albumName),
          capturedAt: filmCapturedAt(items, film),
        });
        if (result.assetId) knownAssetIds.add(result.assetId);
        if (result.alreadyThere) {
          skipped++;
          filmNote = "the film was already there";
        } else {
          done++;
          filmNote = "including the finished film";
        }
      } catch (err) {
        failed++;
        filmNote = "the film didn't make it";
        console.error(`[immich-export] film ${film.id} failed:`, (err as Error).message);
      }

      await reportTransfer(transferId, { done, skipped, failed });
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

    const allFailed = attempts > 0 && failed === attempts;

    await reportTransfer(transferId, {
      status: allFailed ? "failed" : "done",
      finishedAt: new Date(),
      remoteAlbumId,
      message: summarise(done, skipped, failed, remoteAlbumId !== null, filmNote),
      error: allFailed ? "Every upload failed" : null,
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

/**
 * Pushes the rendered MP4 itself.
 *
 * Renders carry no stored checksum — the file is written once and never read
 * back — so the hash comes from the copy we had to pull down anyway, which
 * still lets us ask before spending the upload. Re-rendering makes a new file
 * with a new hash, so pressing the button after a re-cut sends the new film and
 * leaves the old one alone.
 */
async function exportFilm(
  film: RenderJob,
  creds: ImmichCredentials,
  workDir: string,
  as: { filename: string; capturedAt: Date },
): Promise<{ assetId: string | null; alreadyThere: boolean }> {
  const local = path.join(workDir, `film-${film.id}.mp4`);
  await downloadToFile(film.outputKey as string, local);

  try {
    const checksum = await hashFile(local);
    const existing = (await bulkUploadCheck(creds, [checksum])).existing.get(checksum);
    if (existing) return { assetId: existing, alreadyThere: true };

    const data = await openAsBlob(local, { type: "video/mp4" });
    const result = await uploadAsset(creds, {
      data,
      filename: as.filename,
      fileCreatedAt: as.capturedAt,
      durationMs: film.durationSeconds != null ? film.durationSeconds * 1000 : null,
    });

    return { assetId: result.id, alreadyThere: result.status === "duplicate" };
  } finally {
    await rm(local, { force: true }).catch(() => {});
  }
}

/** The newest render that actually produced a file. */
async function latestFinishedRender(vlogId: string): Promise<RenderJob | null> {
  const [row] = await db
    .select()
    .from(renderJobs)
    .where(
      and(
        eq(renderJobs.vlogId, vlogId),
        eq(renderJobs.status, "done"),
        isNotNull(renderJobs.outputKey),
      ),
    )
    // By submission time, not finish time: renders are serialised one per vlog,
    // and `finished_at` can be null on rows written before it was recorded —
    // which Postgres sorts *first* under DESC.
    .orderBy(desc(renderJobs.createdAt))
    .limit(1);

  return row ?? null;
}

/**
 * The film lands in their timeline at the last moment it contains, not on the
 * day the render happened — so it sits at the end of the trip it's made of
 * rather than months later among unrelated photos.
 */
function filmCapturedAt(items: MediaItem[], film: RenderJob): Date {
  let latest: Date | null = null;
  for (const item of items) {
    if (item.capturedAt && (!latest || item.capturedAt > latest)) latest = item.capturedAt;
  }
  return latest ?? film.finishedAt ?? film.createdAt;
}

/** A name that reads properly in a photo library, not a storage key. */
function filmFilename(title: string): string {
  const safe = title
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${safe || "VlogBuddy"}.mp4`;
}

function startMessage(toUpload: number, inPile: number, withFilm: boolean): string {
  if (inPile === 0) return "Copying the finished film over…";
  if (toUpload === 0) {
    return withFilm
      ? "You already have the photos — just the film to go"
      : "You already have all of it — just filing it into an album";
  }
  return withFilm
    ? `Uploading ${toUpload} of ${inPile}, then the film…`
    : `Uploading ${toUpload} of ${inPile}…`;
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

function summarise(
  done: number,
  skipped: number,
  failed: number,
  filed: boolean,
  filmNote: string,
): string {
  const parts: string[] = [];
  if (done > 0) parts.push(`${done} added to your Immich`);
  if (skipped > 0) parts.push(`${skipped} you already had`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (parts.length === 0) parts.push("Nothing to copy");
  parts.push(filmNote);
  if (filed) parts.push("filed into an album");
  return parts.join(" · ");
}
