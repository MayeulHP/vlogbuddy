/**
 * Re-runs the media pipeline over photos that predate the photo proxy, so an
 * iPhone's HEIC becomes visible and a 48MP original stops being downloaded
 * whole into an 800px preview.
 *
 *   pnpm --filter @vlogbuddy/worker backfill-photo-proxies            # dry run
 *   pnpm --filter @vlogbuddy/worker backfill-photo-proxies -- --go
 *
 * A script rather than a button on /admin. This is a one-off consequence of a
 * deploy, the person who needs it is the one person with a shell on the box,
 * and a button would have to be built, permissioned and then maintained
 * forever for a job that stops being interesting once every old pile has been
 * through it. It also wants a dry run, a limit and a scope, which is three
 * form controls nobody will ever touch again.
 *
 * It nominates; it does not decide. Whether a given photo actually needs a
 * JPEG standing in for it is `process-media`'s rule and its alone — it depends
 * on a fresh probe of the file, and a second opinion here would drift from it
 * the moment the format list or the size cap moved. So the query is a
 * deliberately coarse superset (a photo, still in storage, with no stand-in
 * yet) and the job itself throws back the ones that are fine as they are.
 */
import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import PgBoss from "pg-boss";
import { and, asc, db, eq, getSqlClient, isNull, mediaItems, vlogs } from "@vlogbuddy/db";
import { env } from "./env";
import { QUEUE_PROCESS_MEDIA } from "./queue";

interface Options {
  go: boolean;
  limit: number;
  batch: number;
  pauseMs: number;
  slug: string | null;
  again: boolean;
}

const USAGE = `
Backfill display proxies for photos already in the pile.

  --go            actually enqueue (without it, nothing is changed)
  --limit N       how many photos to hand over this run   (default 250)
  --batch N       how many to enqueue per batch           (default 25)
  --pause MS      wait between batches                    (default 1000)
  --vlog SLUG     only this vlog's pile
  --again         reconsider photos an earlier run already nominated
  --help
`;

function parseArgs(argv: string[]): Options | null {
  const opts: Options = { go: false, limit: 250, batch: 25, pauseMs: 1000, slug: null, again: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i];
    switch (arg) {
      // `pnpm run x -- --go` forwards the separator itself; swallow it.
      case "--": break;
      case "--go": opts.go = true; break;
      case "--again": opts.again = true; break;
      case "--limit": opts.limit = Number(value()); break;
      case "--batch": opts.batch = Number(value()); break;
      case "--pause": opts.pauseMs = Number(value()); break;
      case "--vlog": opts.slug = value(); break;
      case "--help": case "-h": return null;
      default:
        console.error(`Unknown argument: ${arg}`);
        return null;
    }
  }

  if (!Number.isFinite(opts.limit) || opts.limit < 1) opts.limit = 250;
  if (!Number.isFinite(opts.batch) || opts.batch < 1) opts.batch = 25;
  if (!Number.isFinite(opts.pauseMs) || opts.pauseMs < 0) opts.pauseMs = 0;
  return opts;
}

/**
 * Which photos this script has already handed over.
 *
 * `proxy_key IS NULL` on its own is enough to keep a fixed photo out of the
 * next run, but it can't tell a photo nobody has looked at from one the job
 * looked at and quite correctly left alone — that distinction is the rule we
 * refuse to restate here. A plain list of ids keeps the second run from
 * re-downloading every ordinary snap in the pile. Losing the file costs
 * nothing but a repeat of that wasted look, which is why it can live in the
 * scratch directory.
 */
function ledgerPath(): string {
  return path.join(env().TMP_DIR, "photo-proxy-backfill.ids");
}

async function readLedger(): Promise<Set<string>> {
  try {
    const raw = await readFile(ledgerPath(), "utf8");
    return new Set(raw.split("\n").map((line) => line.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function appendLedger(ids: string[]): Promise<void> {
  await mkdir(path.dirname(ledgerPath()), { recursive: true });
  await appendFile(ledgerPath(), ids.map((id) => `${id}\n`).join(""));
}

/** Photos already sitting in the queue — a second run shouldn't double them up. */
async function queuedMediaItemIds(): Promise<Set<string>> {
  try {
    const rows = await getSqlClient()<{ media_item_id: string }[]>`
      SELECT data->>'mediaItemId' AS media_item_id
      FROM pgboss.job
      WHERE name = ${QUEUE_PROCESS_MEDIA}
        AND state IN ('created', 'active', 'retry')
    `;
    return new Set(rows.map((r) => r.media_item_id).filter(Boolean));
  } catch {
    // No pgboss schema yet means nothing has ever been queued.
    return new Set();
  }
}

function s3(): S3Client {
  const e = env();
  return new S3Client({
    region: e.S3_REGION,
    endpoint: e.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: e.S3_ACCESS_KEY, secretAccessKey: e.S3_SECRET_KEY },
  });
}

/**
 * `process-media` marks a row failed when it can't fetch the original, which
 * would turn a photo that looks fine today into a broken tile tomorrow. Swept
 * rows are excluded by the query; this catches the bytes that went missing some
 * other way, before we enqueue rather than after.
 */
async function originalsPresent(
  keys: { id: string; storageKey: string }[],
): Promise<Set<string>> {
  const client = s3();
  const bucket = env().S3_BUCKET;
  const present = new Set<string>();

  for (let i = 0; i < keys.length; i += 8) {
    const chunk = keys.slice(i, i + 8);
    await Promise.all(
      chunk.map(async ({ id, storageKey }) => {
        try {
          await client.send(new HeadObjectCommand({ Bucket: bucket, Key: storageKey }));
          present.add(id);
        } catch {
          // Absent or unreadable — either way, not something to hand the worker.
        }
      }),
    );
  }

  return present;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    console.log(USAGE);
    process.exit(0);
  }

  let vlogFilter: { id: string; title: string } | null = null;
  if (opts.slug) {
    const [row] = await db
      .select({ id: vlogs.id, title: vlogs.title })
      .from(vlogs)
      .where(eq(vlogs.shareSlug, opts.slug))
      .limit(1);
    if (!row) {
      console.error(`No vlog with the share link /v/${opts.slug}.`);
      process.exit(1);
    }
    vlogFilter = row;
  }

  /**
   * The superset: a photo, never swept, with nothing standing in for it yet,
   * and already through the pipeline once. A row still `pending` or
   * `processing` is on its way through under the current code anyway, and a
   * `failed` one broke for a reason this script can't see — pushing either back
   * into the queue would be guessing.
   */
  const rows = await db
    .select({
      id: mediaItems.id,
      vlogId: mediaItems.vlogId,
      storageKey: mediaItems.storageKey,
      filename: mediaItems.originalFilename,
      contentType: mediaItems.contentType,
      width: mediaItems.width,
      height: mediaItems.height,
      vlogTitle: vlogs.title,
    })
    .from(mediaItems)
    .innerJoin(vlogs, eq(vlogs.id, mediaItems.vlogId))
    .where(
      and(
        eq(mediaItems.kind, "photo"),
        eq(mediaItems.status, "ready"),
        isNull(mediaItems.prunedAt),
        isNull(mediaItems.proxyKey),
        ...(vlogFilter ? [eq(mediaItems.vlogId, vlogFilter.id)] : []),
      ),
    )
    .orderBy(asc(mediaItems.createdAt));

  const scope = vlogFilter ? `“${vlogFilter.title}”` : "every pile";
  console.log(`\nPhoto proxies — ${opts.go ? "backfill" : "dry run"}, ${scope}\n`);

  if (rows.length === 0) {
    console.log("  Every photo that could have a stand-in already does. Nothing to do.\n");
    return;
  }

  const ledger = opts.again ? new Set<string>() : await readLedger();
  const queued = await queuedMediaItemIds();

  const seenBefore = rows.filter((r) => ledger.has(r.id)).length;
  const inFlight = rows.filter((r) => !ledger.has(r.id) && queued.has(r.id)).length;
  const fresh = rows.filter((r) => !ledger.has(r.id) && !queued.has(r.id));

  const chosen = fresh.slice(0, opts.limit);
  const present = await originalsPresent(chosen);
  const missing = chosen.filter((r) => !present.has(r.id));
  const sendable = chosen.filter((r) => present.has(r.id));

  console.log(`  ${String(rows.length).padStart(6)}  photos with no stand-in`);
  if (seenBefore) console.log(`  ${String(seenBefore).padStart(6)}  looked at by an earlier run (--again to redo them)`);
  if (inFlight) console.log(`  ${String(inFlight).padStart(6)}  already waiting in the queue`);
  if (missing.length) console.log(`  ${String(missing.length).padStart(6)}  skipped — the original file is gone`);
  console.log(`  ${String(sendable.length).padStart(6)}  ${opts.go ? "going to the worker now" : "would go to the worker"}`);
  if (fresh.length > opts.limit) {
    console.log(`\n  Held back ${plural(fresh.length - opts.limit, "photo", "photos")} — raise --limit or run this again afterwards.`);
  }

  console.log(
    "\n  Not all of these will come back with one. The worker opens each file\n" +
      "  and decides for itself; an ordinary snap it can already show is left\n" +
      "  exactly as it is.",
  );

  if (sendable.length) {
    console.log("\n  A sample:");
    for (const r of sendable.slice(0, 8)) {
      const size = r.width && r.height ? `${r.width}×${r.height}` : "size unknown";
      console.log(`    ${r.filename}  —  ${r.contentType}, ${size}  —  ${r.vlogTitle}`);
    }
    if (sendable.length > 8) console.log(`    …and ${plural(sendable.length - 8, "other", "others")}`);
  }

  if (!opts.go) {
    console.log("\n  Nothing has been changed. To go ahead:");
    const extra = opts.slug ? ` --vlog ${opts.slug}` : "";
    console.log(`    pnpm --filter @vlogbuddy/worker backfill-photo-proxies -- --go${extra}\n`);
    return;
  }

  if (sendable.length === 0) {
    console.log("\n  Nothing to hand over.\n");
    return;
  }

  const boss = new PgBoss({ connectionString: env().DATABASE_URL, schema: "pgboss", max: 2 });
  boss.on("error", (err) => console.error("[backfill] queue error:", err));
  await boss.start();

  // pg-boss v10 drops jobs sent to a queue that doesn't exist yet. The worker
  // creates this one at boot, but the script mustn't assume it has ever run.
  try {
    await boss.createQueue(QUEUE_PROCESS_MEDIA);
  } catch (err) {
    if (!/already exists/i.test((err as Error).message)) throw err;
  }

  console.log("");
  let sent = 0;

  for (let i = 0; i < sendable.length; i += opts.batch) {
    const batch = sendable.slice(i, i + opts.batch);

    for (const row of batch) {
      /**
       * Negative priority is the whole anti-stampede measure: pg-boss fetches
       * by priority first, so however many thousand of these are waiting, a
       * photo somebody uploads a minute from now still goes next. One retry
       * rather than the usual three — a backfill that fails is a row to look
       * at by hand, not one to hammer the box over.
       */
      await boss.send(
        QUEUE_PROCESS_MEDIA,
        { mediaItemId: row.id, vlogId: row.vlogId },
        { priority: -100, retryLimit: 1, retryDelay: 60, expireInMinutes: 120 },
      );
      sent++;
    }

    await appendLedger(batch.map((r) => r.id));
    console.log(`  queued ${sent}/${sendable.length}`);

    if (opts.pauseMs && i + opts.batch < sendable.length) {
      await new Promise((r) => setTimeout(r, opts.pauseMs));
    }
  }

  await boss.stop({ graceful: true, timeout: 10_000 });

  console.log(
    `\n  Handed over ${plural(sent, "photo", "photos")}. The worker takes them one at a time and\n` +
      "  lets anything new jump the queue, so this may take a while on a slow box —\n" +
      "  `docker compose logs -f worker` if you want to watch.\n",
  );
}

main()
  .catch((err) => {
    // postgres.js reports a refused connection with a bare code and no message,
    // which reads as a blank failure unless we fall back to the error itself.
    const message = err instanceof Error && err.message ? err.message : String(err?.code ?? err);
    console.error(`\nBackfill failed: ${message}`);
    if (err?.code === "ECONNREFUSED") {
      console.error("Is the database up? `docker compose up -d postgres minio minio-init`");
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await getSqlClient().end({ timeout: 5 });
  });
