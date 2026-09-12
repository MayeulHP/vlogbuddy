import PgBoss from "pg-boss";
import { mkdir } from "node:fs/promises";
import { env } from "./env";
import { processMedia, type ProcessMediaJob } from "./jobs/process-media";
import { extractAudio, type ExtractAudioJob } from "./jobs/extract-audio";
import { renderVlog, type RenderJobPayload } from "./jobs/render";

const QUEUE_PROCESS_MEDIA = "process-media";
const QUEUE_EXTRACT_AUDIO = "extract-audio";
const QUEUE_RENDER = "render-vlog";

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

  // pg-boss v10 requires queues to exist before send()/work() — without this,
  // jobs are silently dropped and nothing ever processes.
  for (const queue of [QUEUE_PROCESS_MEDIA, QUEUE_EXTRACT_AUDIO, QUEUE_RENDER]) {
    try {
      await boss.createQueue(queue);
    } catch (err) {
      // Already exists — fine, this runs on every boot.
      if (!/already exists/i.test((err as Error).message)) throw err;
    }
  }

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

  console.log(
    `[worker] ready — render ${e.RENDER_HEIGHT}p@${e.RENDER_FPS}, ` +
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
