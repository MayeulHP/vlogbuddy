import "server-only";
import PgBoss from "pg-boss";
import {
  QUEUE_EXTRACT_AUDIO,
  QUEUE_IMMICH_EXPORT,
  QUEUE_IMMICH_IMPORT,
  QUEUE_PROCESS_MEDIA,
  QUEUE_RENDER,
  ensureQueues,
} from "@vlogbuddy/shared/queues";
import { env } from "./env";

/**
 * pg-boss runs the job queue on the Postgres we already have — no Redis.
 * The web app only enqueues; apps/worker consumes.
 */

export {
  QUEUE_EXTRACT_AUDIO,
  QUEUE_IMMICH_EXPORT,
  QUEUE_IMMICH_IMPORT,
  QUEUE_PROCESS_MEDIA,
  QUEUE_RENDER,
};

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
      // creates these too, but whichever process starts first must win — which
      // is why the policies live in one shared place rather than here.
      await ensureQueues(instance);

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

/**
 * One render at a time per vlog, plus at most one waiting behind it.
 *
 * Enforced by the queue's `stately` policy, not by this key alone: under the
 * default `standard` policy pg-boss accepts a `singletonKey` and ignores it,
 * which is what it did here until the policies were set. **Returns null when
 * the constraint rejects the job** — callers have to handle that, or they
 * leave a render row queued against a job that does not exist.
 */
export async function enqueueRender(job: RenderJobPayload) {
  const b = await getBoss();
  return b.send(QUEUE_RENDER, job, {
    retryLimit: 1,
    expireInMinutes: 360,
    singletonKey: job.vlogId,
  });
}

/**
 * Immich copies talk to somebody else's server over the internet, so they get
 * a long expiry and only one retry — a half-finished import is resumable by
 * pressing the button again (already-copied assets are skipped by checksum),
 * which is friendlier than a silent retry storm against their instance.
 *
 * One at a time per member, by the same `stately` policy as renders, so that
 * "press it again" resumes rather than opening a second concurrent copy
 * against the same instance. Both return null when the constraint rejects.
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
