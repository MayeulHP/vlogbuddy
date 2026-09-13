/**
 * End-to-end pipeline check against live Postgres + object storage.
 * Creates a vlog, uploads a real video, enqueues processing, and waits for the
 * worker to produce a thumbnail, proxy and metadata. Then queues a render of a
 * two-clip timeline and waits for the finished MP4.
 *
 * Run with the stack up:
 *   docker compose exec worker pnpm --filter @vlogbuddy/worker exec tsx src/e2e-check.ts
 */
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import PgBoss from "pg-boss";
import {
  db,
  eq,
  mediaItems,
  members,
  renderJobs,
  timelines,
  vlogs,
} from "@vlogbuddy/db";
import { emptyTimeline, generateSlug, generateToken } from "@vlogbuddy/shared";
import { env } from "./env.js";
import { buildStorageKey, uploadFile } from "./storage.js";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

let failures = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? "✓" : "✗"} ${m}`);
  if (!c) failures++;
};

function sh(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: "ignore" });
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed`))));
    c.on("error", reject);
  });
}

async function objectExists(key: string): Promise<boolean> {
  const e = env();
  const s3 = new S3Client({
    region: e.S3_REGION,
    endpoint: e.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: e.S3_ACCESS_KEY, secretAccessKey: e.S3_SECRET_KEY },
  });
  try {
    await s3.send(new GetObjectCommand({ Bucket: e.S3_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = 180_000,
): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`  (timed out waiting for ${label})`);
  return null;
}

async function main() {
  const boss = new PgBoss({ connectionString: env().DATABASE_URL, schema: "pgboss" });
  await boss.start();

  const workDir = await mkdtemp("/tmp/e2e-");

  console.log("\n--- setting up a vlog ---");
  const [vlog] = await db
    .insert(vlogs)
    .values({ title: "E2E test trip", shareSlug: generateSlug(), state: "open" })
    .returning();
  const [member] = await db
    .insert(members)
    .values({
      vlogId: vlog.id,
      displayName: "Tester",
      sessionToken: generateToken(),
      role: "creator",
    })
    .returning();
  await db.insert(timelines).values({ vlogId: vlog.id, doc: emptyTimeline(), revision: 0 });
  ok(Boolean(vlog.id && member.id), `vlog created (/v/${vlog.shareSlug})`);

  // --- media pipeline -------------------------------------------------------
  console.log("\n--- media pipeline ---");
  const clipA = path.join(workDir, "clipA.mp4");
  const clipB = path.join(workDir, "clipB.mp4");
  await sh("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=1920x1080:duration=4:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    "-metadata", "creation_time=2026-02-14T10:30:00Z", clipA]);
  await sh("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=720x1280:duration=3:rate=30",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", clipB]);

  const created: string[] = [];
  for (const [i, local] of [clipA, clipB].entries()) {
    const id = crypto.randomUUID();
    const key = buildStorageKey(vlog.id, "original", id, `clip${i}.mp4`);
    await uploadFile(key, local, "video/mp4");

    const [row] = await db
      .insert(mediaItems)
      .values({
        id,
        vlogId: vlog.id,
        uploaderId: member.id,
        kind: "video",
        originalFilename: `clip${i}.mp4`,
        contentType: "video/mp4",
        storageKey: key,
        uploadIndex: i,
        status: "pending",
      })
      .returning();
    created.push(row.id);
    await boss.send("process-media", { mediaItemId: row.id, vlogId: vlog.id });
  }
  ok(created.length === 2, "2 videos uploaded to storage + queued");

  const processed = await waitFor("media processing", async () => {
    const rows = await db.select().from(mediaItems).where(eq(mediaItems.vlogId, vlog.id));
    const done = rows.filter((r) => r.status === "ready" || r.status === "failed");
    return done.length === 2 ? rows : null;
  });

  if (!processed) {
    ok(false, "media processing finished");
  } else {
    for (const row of processed) {
      ok(row.status === "ready", `${row.originalFilename}: status=${row.status}`);
      ok(Boolean(row.thumbnailKey) && (await objectExists(row.thumbnailKey!)), "  thumbnail in storage");
      ok(Boolean(row.proxyKey) && (await objectExists(row.proxyKey!)), "  proxy in storage");
      ok(row.durationSeconds !== null, `  duration probed (${row.durationSeconds?.toFixed(2)}s)`);
      ok(row.width !== null && row.height !== null, `  dimensions ${row.width}x${row.height}`);
    }
    const withDate = processed.find((r) => r.originalFilename === "clip0.mp4");
    ok(
      withDate?.capturedAt?.toISOString().startsWith("2026-02-14") ?? false,
      `  capture time read from metadata (${withDate?.capturedAt?.toISOString() ?? "none"})`,
    );
  }

  // --- render ---------------------------------------------------------------
  console.log("\n--- render pipeline ---");
  const ready = (processed ?? []).filter((r) => r.status === "ready");
  if (ready.length < 2) {
    ok(false, "need 2 processed clips to render");
  } else {
    const doc = {
      version: 2 as const,
      clips: ready.map((r, i) => ({
        id: crypto.randomUUID(),
        mediaItemId: r.id,
        kind: "video" as const,
        trimStart: 0,
        trimEnd: Math.min(2, r.durationSeconds ?? 2),
        duration: 2,
        transitionIn: i === 0 ? ("cut" as const) : ("crossfade" as const),
        transitionDuration: 0.5,
        volume: 1,
        muted: false,
        titles:
          i === 0
            ? [{
                id: crypto.randomUUID(),
                text: "E2E: 100% working",
                start: 0,
                duration: 1.5,
                position: "bottom" as const,
                fontSize: 48,
                color: "#ffffff",
              }]
            : [],
        auto: [],
      })),
      // One layer over the second shot, so the whole multi-track path — extra
      // input, overlay, clipping to the picture — is exercised for real.
      layers: [
        {
          id: crypto.randomUUID(),
          mediaItemId: ready[1].id,
          kind: "video" as const,
          layer: 1,
          startAt: 1.5,
          trimStart: 0,
          duration: 1.5,
          x: 0.6,
          y: 0.08,
          width: 0.3,
          opacity: 0.9,
          fadeIn: 0.3,
          fadeOut: 0.3,
          volume: 1,
          muted: true,
        },
      ],
      audio: [],
      duckClipAudio: true,
      director: { enabled: true, pace: "standard" as const, sceneText: false, beatSnap: false },
    };

    await db.update(timelines).set({ doc, revision: 1 }).where(eq(timelines.vlogId, vlog.id));
    const [job] = await db
      .insert(renderJobs)
      .values({ vlogId: vlog.id, requestedById: member.id, status: "queued", timelineSnapshot: doc })
      .returning();
    await db.update(vlogs).set({ state: "export" }).where(eq(vlogs.id, vlog.id));
    await boss.send("render-vlog", { renderJobId: job.id, vlogId: vlog.id });
    ok(true, "render queued");

    const finished = await waitFor("render", async () => {
      const [r] = await db.select().from(renderJobs).where(eq(renderJobs.id, job.id)).limit(1);
      return r && (r.status === "done" || r.status === "failed") ? r : null;
    }, 300_000);

    if (!finished) {
      ok(false, "render finished");
    } else {
      ok(finished.status === "done", `render status=${finished.status}${finished.error ? ` — ${finished.error.slice(0, 200)}` : ""}`);
      if (finished.status === "done") {
        ok(Boolean(finished.outputKey) && (await objectExists(finished.outputKey!)), "  output MP4 in storage");
        ok((finished.sizeBytes ?? 0) > 10_000, `  size ${((finished.sizeBytes ?? 0) / 1024).toFixed(0)} KB`);
        ok(Math.abs((finished.durationSeconds ?? 0) - 3.5) < 0.6, `  duration ${finished.durationSeconds?.toFixed(2)}s (expected ~3.5 with crossfade)`);
        const [v] = await db.select().from(vlogs).where(eq(vlogs.id, vlog.id)).limit(1);
        ok(v.state === "published", `  vlog advanced to '${v.state}'`);
      }
    }
  }

  // --- cleanup --------------------------------------------------------------
  await db.delete(vlogs).where(eq(vlogs.id, vlog.id));
  await boss.stop({ graceful: false });

  console.log(failures === 0 ? "\n✅ End-to-end pipeline works.\n" : `\n❌ ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
