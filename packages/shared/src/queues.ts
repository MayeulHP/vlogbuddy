/**
 * The job queues, and the concurrency policy each one runs under.
 *
 * Both apps create these at boot — whichever process starts first wins — so
 * the policy has to be stated in one place or the two would disagree about
 * what a queue means depending on who got there first.
 *
 * This is a subpath export (`@vlogbuddy/shared/queues`) rather than part of
 * the barrel: the queue names are wanted by the worker's boot, which runs
 * outside Next's module graph, and pulling the whole of `index.ts` in for two
 * string constants drags the timeline model along with it.
 */

/**
 * pg-boss queue policies, as of v10.
 *
 * The important and easily-missed part: `singletonKey` on a `send()` is only
 * enforced by a partial unique index, and each of those indexes is conditioned
 * on the queue's policy. Under `standard` — the default when `createQueue` is
 * called with no options — **no index applies and `singletonKey` is silently
 * ignored**. It looks like it works right up until two of something run at once.
 */
export const QUEUE_POLICY = {
  /** No constraint. Many jobs, many keys, all of them run. */
  standard: "standard",
  /** At most one job *waiting* per key. A second send while one is queued is dropped. */
  short: "short",
  /** At most one job *running* per key. More may queue behind it. */
  singleton: "singleton",
  /** At most one waiting and one running per key. */
  stately: "stately",
} as const;

export type QueuePolicy = (typeof QUEUE_POLICY)[keyof typeof QUEUE_POLICY];

export const QUEUE_PROCESS_MEDIA = "process-media";
export const QUEUE_EXTRACT_AUDIO = "extract-audio";
export const QUEUE_RENDER = "render-vlog";
export const QUEUE_IMMICH_IMPORT = "immich-import";
export const QUEUE_IMMICH_EXPORT = "immich-export";

/**
 * Why each queue is what it is.
 *
 * `stately` for the three that carry a `singletonKey`: one running plus one
 * waiting is the shape people actually want. Pressing Render again while a
 * render is going should mean "and then do it again", not "run a second
 * encode on the same box" — and certainly not a pile of twelve.
 *
 * `standard` for the two that don't. Media processing is fan-out by nature
 * (a whole album at once) and the backfill script leans on that; constraining
 * it would serialise an import to one photo at a time.
 */
export const QUEUE_POLICIES: Record<string, QueuePolicy> = {
  [QUEUE_PROCESS_MEDIA]: QUEUE_POLICY.standard,
  [QUEUE_EXTRACT_AUDIO]: QUEUE_POLICY.standard,
  [QUEUE_RENDER]: QUEUE_POLICY.stately,
  [QUEUE_IMMICH_IMPORT]: QUEUE_POLICY.stately,
  [QUEUE_IMMICH_EXPORT]: QUEUE_POLICY.stately,
};

export const ALL_QUEUES = Object.keys(QUEUE_POLICIES);

/**
 * Bring every queue into existence with its policy, and correct the policy of
 * any that is already there.
 *
 * The correction is the point, and it has to run unconditionally.
 * `create_queue` inserts `ON CONFLICT DO NOTHING` and returns without
 * complaint, so a call against an existing queue is a silent no-op — it does
 * *not* raise "already exists", and code that only reconciles in a catch block
 * would never reconcile anything. An instance running since before the
 * policies were set would keep `standard`, and keep silently ignoring every
 * `singletonKey`, forever.
 *
 * Changing the policy is enough on its own: the partial unique indexes that do
 * the enforcing are created on each queue's partition table when the queue is
 * made, whatever its policy, and a job copies its queue's policy at insert
 * time. So an update here starts constraining the next send without touching
 * the jobs already in flight.
 *
 * Typed structurally rather than against `PgBoss` so this file stays free of
 * the dependency; both callers pass their own instance.
 */
export async function ensureQueues(boss: {
  createQueue(name: string, options?: { policy?: QueuePolicy }): Promise<void>;
  updateQueue(name: string, options?: { policy?: QueuePolicy }): Promise<void>;
  getQueue(name: string): Promise<{ policy?: string } | null>;
}): Promise<void> {
  for (const [name, policy] of Object.entries(QUEUE_POLICIES)) {
    // pg-boss v10 drops jobs sent to a queue that doesn't exist yet, so this
    // has to succeed before anything is sent. Both apps do it; first one wins.
    await boss.createQueue(name, { policy });

    try {
      // Only write when it's actually wrong, so an ordinary boot doesn't issue
      // an UPDATE per queue for no reason.
      const existing = await boss.getQueue(name);
      if (existing && existing.policy !== policy) {
        await boss.updateQueue(name, { policy });
        console.log(`[queue] '${name}' policy ${existing.policy} → ${policy}`);
      }
    } catch (err) {
      // A queue whose policy can't be reconciled still works — it just keeps
      // the old one. Worth a line in the log, not worth refusing to boot.
      console.error(`[queue] could not reconcile '${name}':`, err);
    }
  }
}
