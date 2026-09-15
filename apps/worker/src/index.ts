import PgBoss from "pg-boss";
import { db, eq, getRenderSettings, renderJobs, vlogs } from "@vlogbuddy/db";
import { mkdir } from "node:fs/promises";
import { notifyRenderProgress } from "./notify";
import { env } from "./env";
import { processMedia, type ProcessMediaJob } from "./jobs/process-media";
import { extractAudio, type ExtractAudioJob } from "./jobs/extract-audio";
import { renderVlog, type RenderJobPayload } from "./jobs/render";
import { immichImport, type ImmichImportJob } from "./jobs/immich-import";
import { immichExport, type ImmichExportJob } from "./jobs/immich-export";
import {
  ALL_QUEUES,
  QUEUE_EXTRACT_AUDIO,
  QUEUE_IMMICH_EXPORT,
  QUEUE_IMMICH_IMPORT,
  QUEUE_PROCESS_MEDIA,
  QUEUE_RENDER,
  setBoss,
} from "./queue";

/**
 * Unsticks renders that were in flight when this process last died.
 *
 * A render job writes its own failure, which it cannot do if it was killed
 * rather than thrown — the container restarted, the box lost power, the OOM
 * killer picked the worker instead of FFmpeg. The row stays `rendering` and the
 * vlog stays in `export`, which locks every room but the screening one and makes
 * `startRenderAction` refuse ("a render is already in progress"). Nobody can get
 * out of that from the app, which is the worst shape a failure can take.
 *
 * This assumes one worker, which is what compose runs: a second worker booting
 * would call a live render abandoned.
 */
async function reclaimAbandonedRenders() {
  const stuck = await db
    .update(renderJobs)
    .set({
      status: "failed",
      message: "Failed",
      error: "The lab restarted while this was printing. Nothing was lost — send it again.",
      finishedAt: new Date(),
    })
    .where(eq(renderJobs.status, "rendering"))
    .returning({ id: renderJobs.id, vlogId: renderJobs.vlogId });

  for (const job of stuck) {
    await db.update(vlogs).set({ state: "open" }).where(eq(vlogs.id, job.vlogId));
    // The browser is told the same way a live failure is, so anyone still
    // watching the dial sees it stop rather than spin forever.
    await notifyRenderProgress(job.vlogId, {
      renderJobId: job.id,
      status: "failed",
      progress: 0,
      error: "The lab restarted while this was printing. Nothing was lost — send it again.",
    });
    console.warn(`[worker] reclaimed abandoned render ${job.id}`);
  }
}

async function main() {
  const e = env();

  await mkdir(e.TMP_DIR, { recursive: true });

  const boss = new PgBoss({
    connectionString: e.DATABASE_URL,
    schema: "pgboss",
    max: 5,
  });

  boss.on("error", (err) => console.error("[worker] queue error:", err));

  await boss.start();
  setBoss(boss);

  // pg-boss v10 requires queues to exist before send()/work() — without this,
  // jobs are silently dropped and nothing ever processes.
  for (const queue of ALL_QUEUES) {
    try {
      await boss.createQueue(queue);
    } catch (err) {
      // Already exists — fine, this runs on every boot.
      if (!/already exists/i.test((err as Error).message)) throw err;
    }
  }

  console.log("[worker] connected to queue");

  await reclaimAbandonedRenders();

  // Media processing is IO-heavy but light on CPU; a few in parallel is fine.
  await boss.work<ProcessMediaJob>(
    QUEUE_PROCESS_MEDIA,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async ([job]) => {
      console.log(`[worker] process-media ${job.data.mediaItemId}`);
      await processMedia(job.data);
    },
  );

  await boss.work<ExtractAudioJob>(
    QUEUE_EXTRACT_AUDIO,
    { batchSize: 1, pollingIntervalSeconds: 3 },
    async ([job]) => {
      console.log(`[worker] extract-audio ${job.data.musicItemId}`);
      await extractAudio(job.data);
    },
  );

  // Renders are CPU-bound — keep concurrency low so the host stays usable.
  await boss.work<RenderJobPayload>(
    QUEUE_RENDER,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async ([job]) => {
      console.log(`[worker] render ${job.data.renderJobId}`);
      await renderVlog(job.data);
    },
  );

  /**
   * Immich transfers are network-bound and can run for a long time on a big
   * album, so they get their own workers rather than queueing behind a render.
   */
  await boss.work<ImmichImportJob>(
    QUEUE_IMMICH_IMPORT,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async ([job]) => {
      console.log(`[worker] immich-import ${job.data.transferId}`);
      await immichImport(job.data);
    },
  );

  await boss.work<ImmichExportJob>(
    QUEUE_IMMICH_EXPORT,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async ([job]) => {
      console.log(`[worker] immich-export ${job.data.transferId}`);
      await immichExport(job.data);
    },
  );

  const format = await getRenderSettings();
  console.log(
    `[worker] ready — render ${format.renderHeight}p short edge @${format.renderFps} ` +
      `(crf ${format.renderCrf}, ${format.renderPreset}; change it on /admin), ` +
      `yt-audio ${e.ENABLE_YT_AUDIO ? "ENABLED" : "disabled"}`,
  );

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, finishing current jobs…`);
    try {
      await boss.stop({ graceful: true, timeout: 30_000 });
    } catch (err) {
      console.error("[worker] shutdown error:", err);
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
