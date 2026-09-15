/**
 * One-off repair for videos stored with the wrong width/height.
 *
 * `probe()` used to read rotation from `side_data_list[0]` only, so every clip
 * whose Display Matrix sat behind an HDR side-data entry came back unrotated
 * and was stored landscape — a portrait phone clip saved as 1920×1080, which
 * `resolveFit` then read as a landscape shot that needed no fit at all. The fix
 * is in `probe()`; this re-probes what the old one already wrote.
 *
 * Originals are private in object storage, so each file comes down through the
 * worker's own S3 client to a temp file, the same way `process-media` gets one.
 *
 *   pnpm --filter @vlogbuddy/worker exec tsx src/backfill-dimensions.ts [--dry-run]
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, db, eq, isNull, mediaItems } from "@vlogbuddy/db";
import { env } from "./env.js";
import { probe } from "./ffmpeg.js";
import { downloadToFile } from "./storage.js";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const rows = await db
    .select()
    .from(mediaItems)
    .where(
      and(
        eq(mediaItems.kind, "video"),
        eq(mediaItems.status, "ready"),
        isNull(mediaItems.prunedAt),
      ),
    );

  console.log(
    `[backfill-dimensions] ${rows.length} ready video${rows.length === 1 ? "" : "s"}` +
      `${dryRun ? " (dry run — nothing will be written)" : ""}`,
  );

  let changed = 0;
  let failed = 0;

  for (const item of rows) {
    const workDir = await mkdtemp(path.join(env().TMP_DIR ?? tmpdir(), "backfill-"));
    try {
      const ext = path.extname(item.originalFilename) || ".mp4";
      const local = path.join(workDir, `original${ext}`);
      await downloadToFile(item.storageKey, local);

      const info = await probe(local);
      if (info.width === null || info.height === null) {
        console.warn(`  ? ${item.id} — probe found no dimensions, leaving alone`);
        continue;
      }
      if (info.width === item.width && info.height === item.height) continue;

      changed++;
      console.log(
        `  ${dryRun ? "would fix" : "fixed"} ${item.id} (${item.originalFilename}): ` +
          `${item.width}×${item.height} → ${info.width}×${info.height} ` +
          `[file rotation ${info.rotation}°]`,
      );

      if (!dryRun) {
        await db
          .update(mediaItems)
          .set({ width: info.width, height: info.height })
          .where(eq(mediaItems.id, item.id));
      }
    } catch (err) {
      failed++;
      console.warn(`  ! ${item.id} — ${(err as Error).message}`);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  console.log(
    `[backfill-dimensions] ${changed} ${dryRun ? "would change" : "changed"}, ` +
      `${rows.length - changed - failed} already correct, ${failed} could not be read`,
  );

  /**
   * Nothing re-syncs the cut here: width/height feed `resolveFit`, which is
   * resolved at read time from the real dimensions rather than baked into the
   * timeline document, so a corrected row is picked up by the next render and
   * the next page load without touching a revision.
   */
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
