/**
 * Fills in what the strip needs for footage that predates it.
 *
 * Every video uploaded before the filmstrip existed still shows one thumbnail
 * stretched across its block, and every audio row still draws a flat bar. Both
 * are derived from files we already hold, so nothing has to be re-uploaded —
 * each item comes down through the worker's own S3 client to a temp dir, the
 * same way `process-media` gets one, and goes back up as a sprite or a column
 * of numbers.
 *
 * Only rows that are missing the asset are touched, so this is safe to re-run
 * and cheap the second time.
 *
 *   pnpm --filter @vlogbuddy/worker exec tsx src/backfill-strip-assets.ts [--dry-run]
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, db, eq, isNull, mediaItems, musicItems } from "@vlogbuddy/db";
import { env } from "./env.js";
import { audioPeaks, generateFilmstrip, planFilmstrip, probe } from "./ffmpeg.js";
import { buildStorageKey, downloadToFile, uploadFile } from "./storage.js";

const dryRun = process.argv.includes("--dry-run");

async function withTempFile<T>(
  storageKey: string,
  filename: string,
  fn: (localPath: string) => Promise<T>,
): Promise<T> {
  const workDir = await mkdtemp(path.join(env().TMP_DIR ?? tmpdir(), "strip-"));
  try {
    const local = path.join(workDir, filename);
    await downloadToFile(storageKey, local);
    return await fn(local);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function backfillFilmstrips() {
  const rows = (
    await db
      .select()
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.kind, "video"),
          eq(mediaItems.status, "ready"),
          isNull(mediaItems.prunedAt),
        ),
      )
  ).filter((row) => row.filmstripKey === null);

  console.log(`[backfill-strip-assets] ${rows.length} video${rows.length === 1 ? "" : "s"} without a filmstrip`);

  let done = 0;
  let failed = 0;

  for (const item of rows) {
    try {
      await withTempFile(item.storageKey, `original${path.extname(item.originalFilename) || ".mp4"}`, async (local) => {
        // The stored duration is usually right, but a row written before the
        // probe worked has none — and the plan is the whole geometry.
        const duration = item.durationSeconds ?? (await probe(local)).durationSeconds;
        const plan = planFilmstrip(duration);
        if (!plan) {
          console.warn(`  ? ${item.id} — no duration, can't place frames`);
          return;
        }

        console.log(
          `  ${dryRun ? "would build" : "building"} ${item.id} (${item.originalFilename}): ` +
            `${plan.frames} frames every ${plan.intervalSeconds}s`,
        );
        if (dryRun) {
          done++;
          return;
        }

        const stripPath = path.join(path.dirname(local), "filmstrip.jpg");
        await generateFilmstrip(local, stripPath, plan);
        const key = buildStorageKey(item.vlogId, "filmstrip", item.id, "filmstrip.jpg");
        await uploadFile(key, stripPath, "image/jpeg");
        await db
          .update(mediaItems)
          .set({
            filmstripKey: key,
            filmstripFrames: plan.frames,
            filmstripIntervalSeconds: plan.intervalSeconds,
          })
          .where(eq(mediaItems.id, item.id));
        done++;
      });
    } catch (err) {
      failed++;
      console.warn(`  ! ${item.id} — ${(err as Error).message.split("\n")[0]}`);
    }
  }

  return { done, failed };
}

async function backfillMediaPeaks() {
  const rows = (
    await db
      .select()
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.kind, "audio"),
          eq(mediaItems.status, "ready"),
          isNull(mediaItems.prunedAt),
        ),
      )
  ).filter((row) => row.peaks === null);

  console.log(`[backfill-strip-assets] ${rows.length} audio upload${rows.length === 1 ? "" : "s"} without peaks`);

  let done = 0;
  let failed = 0;

  for (const item of rows) {
    try {
      await withTempFile(item.storageKey, `original${path.extname(item.originalFilename) || ".mp3"}`, async (local) => {
        const peaks = await audioPeaks(local);
        if (!peaks) {
          console.warn(`  ? ${item.id} — nothing decodable`);
          return;
        }
        console.log(
          `  ${dryRun ? "would write" : "writing"} ${item.id} (${item.originalFilename}): ${peaks.length} peaks`,
        );
        if (dryRun) {
          done++;
          return;
        }
        await db.update(mediaItems).set({ peaks }).where(eq(mediaItems.id, item.id));
        done++;
      });
    } catch (err) {
      failed++;
      console.warn(`  ! ${item.id} — ${(err as Error).message.split("\n")[0]}`);
    }
  }

  return { done, failed };
}

async function backfillMusicPeaks() {
  const rows = (
    await db.select().from(musicItems).where(eq(musicItems.status, "ready"))
  ).filter((row) => row.extractedAudioKey !== null && row.peaks === null);

  console.log(`[backfill-strip-assets] ${rows.length} track${rows.length === 1 ? "" : "s"} with audio but no peaks`);

  let done = 0;
  let failed = 0;

  for (const item of rows) {
    try {
      await withTempFile(item.extractedAudioKey!, "audio.m4a", async (local) => {
        const peaks = await audioPeaks(local);
        if (!peaks) {
          console.warn(`  ? ${item.id} — nothing decodable`);
          return;
        }
        console.log(
          `  ${dryRun ? "would write" : "writing"} ${item.id} (${item.title ?? item.url}): ${peaks.length} peaks`,
        );
        if (dryRun) {
          done++;
          return;
        }
        await db.update(musicItems).set({ peaks }).where(eq(musicItems.id, item.id));
        done++;
      });
    } catch (err) {
      failed++;
      console.warn(`  ! ${item.id} — ${(err as Error).message.split("\n")[0]}`);
    }
  }

  return { done, failed };
}

async function main() {
  if (dryRun) console.log("[backfill-strip-assets] dry run — nothing will be written");

  const strips = await backfillFilmstrips();
  const audio = await backfillMediaPeaks();
  const music = await backfillMusicPeaks();

  const done = strips.done + audio.done + music.done;
  const failed = strips.failed + audio.failed + music.failed;
  console.log(
    `[backfill-strip-assets] ${done} ${dryRun ? "would be filled" : "filled"}, ${failed} could not be read`,
  );

  /**
   * Nothing re-syncs the cut: these are display assets read at page load, not
   * anything the timeline document holds. The next render and the next reload
   * pick them up without touching a revision.
   */
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
