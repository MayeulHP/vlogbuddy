import PgBoss from "pg-boss";
import { getRenderSettings } from "@vlogbuddy/db";
import { mkdir } from "node:fs/promises";
import { env } from "./env";
import { processMedia, type ProcessMediaJob } from "./jobs/process-media";
import { extractAudio, type ExtractAudioJob } from "./jobs/extract-audio";
import { renderVlog, type RenderJobPayload } from "./jobs/render";
import { immichImport, type ImmichImportJob } from "./jobs/immich-import";
import { immichExport, type ImmichExportJob } from "./jobs/immich-export";
import { ensureQueues } from "@vlogbuddy/shared/queues";
import {
  QUEUE_EXTRACT_AUDIO,
  QUEUE_IMMICH_EXPORT,
  QUEUE_IMMICH_IMPORT,
  QUEUE_PROCESS_MEDIA,
  QUEUE_RENDER,
  setBoss,
} from "./queue";

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
  // jobs are silently dropped and nothing ever processes. This also corrects
  // the policy of a queue created before the policies were set, which is what
  // makes `singletonKey` mean anything at all.
  await ensureQueues(boss);

  console.log("[worker] connected to queue");

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
    `[worker] ready — render ${format.renderHeight}p@${format.renderFps} ` +
      `(crf ${format.renderCrf}, ${format.renderPreset}; change it on /admin)`,
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
