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
export const QUEUE_IMMICH_IMPORT = "immich-import";
export const QUEUE_IMMICH_EXPORT = "immich-export";

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

export interface ImmichImportJob {
  transferId: string;
  vlogId: string;
  memberId: string;
  albumId: string;
  albumName: string;
  /** Empty means the whole album. */
  assetIds: string[];
}

export interface ImmichExportJob {
  transferId: string;
  vlogId: string;
  memberId: string;
  albumName: string;
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

      // pg-boss v10 drops jobs sent to queues that don't exist yet. The worker
      // creates these too, but whichever process starts first must win.
      for (const queue of [
        QUEUE_PROCESS_MEDIA,
        QUEUE_EXTRACT_AUDIO,
        QUEUE_RENDER,
        QUEUE_IMMICH_IMPORT,
        QUEUE_IMMICH_EXPORT,
      ]) {
        try {
          await instance.createQueue(queue);
        } catch (err) {
          if (!/already exists/i.test((err as Error).message)) {
            console.error(`[queue] could not create '${queue}':`, err);
          }
        }
      }

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

/**
 * Immich copies talk to somebody else's server over the internet, so they get
 * a long expiry and only one retry — a half-finished import is resumable by
 * pressing the button again (already-copied assets are skipped by checksum),
 * which is friendlier than a silent retry storm against their instance.
 */
export async function enqueueImmichImport(job: ImmichImportJob) {
  const b = await getBoss();
  return b.send(QUEUE_IMMICH_IMPORT, job, {
    retryLimit: 1,
    expireInMinutes: 360,
    singletonKey: `immich-import:${job.memberId}`,
  });
}

export async function enqueueImmichExport(job: ImmichExportJob) {
  const b = await getBoss();
  return b.send(QUEUE_IMMICH_EXPORT, job, {
    retryLimit: 1,
    expireInMinutes: 360,
    singletonKey: `immich-export:${job.memberId}`,
  });
}
