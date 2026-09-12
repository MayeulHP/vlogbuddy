import "server-only";
import PgBoss from "pg-boss";
import { env } from "./env";

/**
 * pg-boss runs the job queue on the Postgres we already have — no Redis.
 * The web app only enqueues; apps/worker consumes.
 */

export const QUEUE_PROCESS_MEDIA = "process-media";
export const QUEUE_EXTRACT_AUDIO = "extract-audio";
export const QUEUE_RENDER = "render-vlog";

export interface ProcessMediaJob {
  mediaItemId: string;
  vlogId: string;
}

export interface ExtractAudioJob {
  musicItemId: string;
  vlogId: string;
}

export interface RenderJobPayload {
  renderJobId: string;
  vlogId: string;
}

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  if (!starting) {
    starting = (async () => {
      const instance = new PgBoss({
        connectionString: env().DATABASE_URL,
        schema: "pgboss",
        max: 4,
      });
      instance.on("error", (err) => console.error("[queue] error:", err));
      await instance.start();
      boss = instance;
      return instance;
    })();
  }
  return starting;
}

export async function enqueueProcessMedia(job: ProcessMediaJob) {
  const b = await getBoss();
  return b.send(QUEUE_PROCESS_MEDIA, job, {
    retryLimit: 3,
    retryDelay: 10,
    retryBackoff: true,
    expireInMinutes: 120,
  });
}

export async function enqueueExtractAudio(job: ExtractAudioJob) {
  const b = await getBoss();
  return b.send(QUEUE_EXTRACT_AUDIO, job, {
    retryLimit: 2,
    retryDelay: 15,
    expireInMinutes: 30,
  });
}

export async function enqueueRender(job: RenderJobPayload) {
  const b = await getBoss();
  return b.send(QUEUE_RENDER, job, {
    retryLimit: 1,
    expireInMinutes: 360,
    // One render at a time per vlog.
    singletonKey: job.vlogId,
  });
}
