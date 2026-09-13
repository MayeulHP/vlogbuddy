import "server-only";
import { and, db, desc, eq, isNull, mediaItems, members, renderJobs, sql, vlogs } from "@vlogbuddy/db";
import type { VlogState } from "@vlogbuddy/shared";

/**
 * What the admin page needs to decide what to delete.
 *
 * Sizes come from the numbers we already recorded at upload and render time
 * rather than by walking the bucket: a listing over a few thousand objects on
 * a spinning disk is slow, and being a few kilobytes out doesn't change any
 * decision the page is asking you to make.
 */

export interface VlogStorageRow {
  id: string;
  title: string;
  shareSlug: string;
  state: VlogState;
  createdAt: Date;
  members: number;
  /** Photos and videos still holding their source files. */
  liveMedia: number;
  /** Rows whose source files have already been swept. */
  prunedMedia: number;
  sourceBytes: number;
  renderBytes: number;
  /** A finished render exists, so the sources are safe to sweep. */
  hasPublishedRender: boolean;
  renderCount: number;
}

export async function listVlogStorage(): Promise<VlogStorageRow[]> {
  const rows = await db
    .select({
      id: vlogs.id,
      title: vlogs.title,
      shareSlug: vlogs.shareSlug,
      state: vlogs.state,
      createdAt: vlogs.createdAt,
      members: sql<number>`(
        select count(*)::int from ${members} where ${members.vlogId} = ${vlogs.id}
      )`,
      liveMedia: sql<number>`(
        select count(*)::int from ${mediaItems}
        where ${mediaItems.vlogId} = ${vlogs.id} and ${mediaItems.prunedAt} is null
      )`,
      prunedMedia: sql<number>`(
        select count(*)::int from ${mediaItems}
        where ${mediaItems.vlogId} = ${vlogs.id} and ${mediaItems.prunedAt} is not null
      )`,
      sourceBytes: sql<number>`(
        select coalesce(sum(${mediaItems.sizeBytes}), 0)::bigint from ${mediaItems}
        where ${mediaItems.vlogId} = ${vlogs.id} and ${mediaItems.prunedAt} is null
      )`,
      renderBytes: sql<number>`(
        select coalesce(sum(${renderJobs.sizeBytes}), 0)::bigint from ${renderJobs}
        where ${renderJobs.vlogId} = ${vlogs.id} and ${renderJobs.outputKey} is not null
      )`,
      renderCount: sql<number>`(
        select count(*)::int from ${renderJobs}
        where ${renderJobs.vlogId} = ${vlogs.id} and ${renderJobs.outputKey} is not null
      )`,
      doneRenders: sql<number>`(
        select count(*)::int from ${renderJobs}
        where ${renderJobs.vlogId} = ${vlogs.id} and ${renderJobs.status} = 'done'
          and ${renderJobs.outputKey} is not null
      )`,
    })
    .from(vlogs)
    .orderBy(desc(vlogs.createdAt));

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    shareSlug: r.shareSlug,
    state: r.state,
    createdAt: r.createdAt,
    members: Number(r.members),
    liveMedia: Number(r.liveMedia),
    prunedMedia: Number(r.prunedMedia),
    sourceBytes: Number(r.sourceBytes),
    renderBytes: Number(r.renderBytes),
    renderCount: Number(r.renderCount),
    hasPublishedRender: Number(r.doneRenders) > 0,
  }));
}

/** Every storage key belonging to a vlog's source media, for a bulk sweep. */
export async function sourceKeysForVlog(vlogId: string) {
  return db
    .select({
      id: mediaItems.id,
      storageKey: mediaItems.storageKey,
      proxyKey: mediaItems.proxyKey,
      thumbnailKey: mediaItems.thumbnailKey,
    })
    .from(mediaItems)
    .where(and(eq(mediaItems.vlogId, vlogId), isNull(mediaItems.prunedAt)));
}

/**
 * Render outputs that aren't the one on show — every finished job bar the most
 * recent, plus anything that failed with a file already written.
 */
export async function supersededRenderKeys(vlogId: string) {
  const rows = await db
    .select({ id: renderJobs.id, outputKey: renderJobs.outputKey, status: renderJobs.status })
    .from(renderJobs)
    .where(eq(renderJobs.vlogId, vlogId))
    .orderBy(desc(renderJobs.createdAt));

  const withFiles = rows.filter((r) => r.outputKey);
  const newestDone = withFiles.find((r) => r.status === "done");
  return withFiles.filter((r) => r.id !== newestDone?.id);
}
