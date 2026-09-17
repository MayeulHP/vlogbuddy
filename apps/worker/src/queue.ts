import type PgBoss from "pg-boss";
import {
  ALL_QUEUES,
  QUEUE_EXTRACT_AUDIO,
  QUEUE_IMMICH_EXPORT,
  QUEUE_IMMICH_IMPORT,
  QUEUE_PROCESS_MEDIA,
  QUEUE_RENDER,
} from "@vlogbuddy/shared/queues";

/**
 * Jobs that need to enqueue follow-up work reach the queue through here.
 *
 * The worker owns one pg-boss instance, created at boot; handing it around
 * through every call signature would be noise, so index.ts registers it once.
 *
 * The names and policies come from `@vlogbuddy/shared/queues` because both
 * apps create these queues and the first one to boot decides what they mean.
 */

export {
  ALL_QUEUES,
  QUEUE_EXTRACT_AUDIO,
  QUEUE_IMMICH_EXPORT,
  QUEUE_IMMICH_IMPORT,
  QUEUE_PROCESS_MEDIA,
  QUEUE_RENDER,
};

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
