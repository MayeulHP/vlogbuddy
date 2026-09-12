import type PgBoss from "pg-boss";

/**
 * Jobs that need to enqueue follow-up work reach the queue through here.
 *
 * The worker owns one pg-boss instance, created at boot; handing it around
 * through every call signature would be noise, so index.ts registers it once.
 */

export const QUEUE_PROCESS_MEDIA = "process-media";
export const QUEUE_EXTRACT_AUDIO = "extract-audio";
export const QUEUE_RENDER = "render-vlog";
export const QUEUE_IMMICH_IMPORT = "immich-import";
export const QUEUE_IMMICH_EXPORT = "immich-export";

export const ALL_QUEUES = [
  QUEUE_PROCESS_MEDIA,
  QUEUE_EXTRACT_AUDIO,
  QUEUE_RENDER,
  QUEUE_IMMICH_IMPORT,
  QUEUE_IMMICH_EXPORT,
];

let boss: PgBoss | null = null;

export function setBoss(instance: PgBoss) {
  boss = instance;
}

export async function enqueueProcessMedia(job: { mediaItemId: string; vlogId: string }) {
  if (!boss) throw new Error("Queue is not ready yet");
  return boss.send(QUEUE_PROCESS_MEDIA, job, {
    retryLimit: 3,
    retryDelay: 10,
    retryBackoff: true,
    expireInMinutes: 120,
  });
}
