import "server-only";
import {
  and,
  asc,
  db,
  eq,
  mediaItems,
  members,
  musicItems,
  reactions,
  renderJobs,
  selections,
  sql,
  timelines,
  type MediaItem,
  type MusicItem,
  type Vlog,
} from "@vlogbuddy/db";
import { desc } from "drizzle-orm";
import {
  DEFAULT_REACTIONS,
  emptyTimeline,
  normalizeTimeline,
  rankScore,
  type ReactionTier,
  type TimelineDoc,
} from "@vlogbuddy/shared";
import { presignDownload } from "./storage";

export interface ReactionTotals {
  count: number;
  sum: number;
  average: number;
  /** Vote tally per tier, e.g. { 1: 2, 2: 5, 3: 1 }. */
  breakdown: Record<number, number>;
  /** The current viewer's own score, if they've voted. */
  mine: number | null;
  /** Blended ranking score that drives dump-view ordering. */
  rank: number;
}

/**
 * Everything on the row except where it was taken. Coordinates are read off a
 * file's EXIF and kept for the cut's own use; nothing the browser renders needs
 * them, and this is a view that gets serialised into the page for every member
 * of the vlog. Dropped here rather than at each call site so it stays dropped.
 */
export interface MediaItemView extends Omit<MediaItem, "latitude" | "longitude"> {
  uploaderName: string | null;
  thumbnailUrl: string | null;
  proxyUrl: string | null;
  originalUrl: string | null;
  reactions: ReactionTotals;
  selected: boolean;
  orderIndex: number | null;
}

export interface MusicItemView extends MusicItem {
  addedByName: string | null;
  reactions: ReactionTotals;
  selected: boolean;
  orderIndex: number | null;
  audioUrl: string | null;
}

function emptyTotals(): ReactionTotals {
  return { count: 0, sum: 0, average: 0, breakdown: {}, mine: null, rank: 0 };
}

/** Aggregates every reaction in a vlog in one query. */
async function loadReactionTotals(vlogId: string, viewerMemberId: string | null) {
  const rows = await db
    .select({
      targetType: reactions.targetType,
      targetId: reactions.targetId,
      score: reactions.score,
      memberId: reactions.memberId,
    })
    .from(reactions)
    .where(eq(reactions.vlogId, vlogId));

  const map = new Map<string, ReactionTotals>();
  for (const row of rows) {
    const key = `${row.targetType}:${row.targetId}`;
    let totals = map.get(key);
    if (!totals) {
      totals = emptyTotals();
      map.set(key, totals);
    }
    totals.count += 1;
    totals.sum += row.score;
    totals.breakdown[row.score] = (totals.breakdown[row.score] ?? 0) + 1;
    if (viewerMemberId && row.memberId === viewerMemberId) totals.mine = row.score;
  }
  for (const totals of map.values()) {
    totals.average = totals.count ? totals.sum / totals.count : 0;
    totals.rank = rankScore(totals.sum, totals.count);
  }
  return map;
}

async function loadSelections(vlogId: string) {
  const rows = await db.select().from(selections).where(eq(selections.vlogId, vlogId));
  const map = new Map<string, number>();
  for (const row of rows) map.set(`${row.targetType}:${row.targetId}`, row.orderIndex);
  return map;
}

export function reactionTiersFor(vlog: Vlog): ReactionTier[] {
  const tiers = vlog.reactionTiers;
  if (Array.isArray(tiers) && tiers.length === 3) return tiers;
  return DEFAULT_REACTIONS;
}

export async function getMediaItems(
  vlogId: string,
  viewerMemberId: string | null,
): Promise<MediaItemView[]> {
  const [rows, totals, selected] = await Promise.all([
    db
      .select({
        item: mediaItems,
        uploaderName: members.displayName,
      })
      .from(mediaItems)
      .leftJoin(members, eq(mediaItems.uploaderId, members.id))
      .where(eq(mediaItems.vlogId, vlogId))
      .orderBy(asc(mediaItems.capturedAt), asc(mediaItems.uploadIndex)),
    loadReactionTotals(vlogId, viewerMemberId),
    loadSelections(vlogId),
  ]);

  return Promise.all(
    rows.map(async ({ item, uploaderName }) => {
      const key = `media:${item.id}`;
      // A swept item keeps its row and its votes, but the bytes are gone —
      // presigning them would hand out links to 404s.
      const swept = item.prunedAt !== null;
      const [thumbnailUrl, proxyUrl, originalUrl] = await Promise.all([
        item.thumbnailKey && !swept ? presignDownload(item.thumbnailKey) : Promise.resolve(null),
        item.proxyKey && !swept ? presignDownload(item.proxyKey) : Promise.resolve(null),
        item.status === "ready" && !swept
          ? presignDownload(item.storageKey)
          : Promise.resolve(null),
      ]);
      const { latitude: _lat, longitude: _lon, ...shareable } = item;
      return {
        ...shareable,
        uploaderName,
        thumbnailUrl,
        proxyUrl,
        originalUrl,
        reactions: totals.get(key) ?? emptyTotals(),
        selected: selected.has(key),
        orderIndex: selected.get(key) ?? null,
      };
    }),
  );
}

export async function getMusicItems(
  vlogId: string,
  viewerMemberId: string | null,
): Promise<MusicItemView[]> {
  const [rows, totals, selected] = await Promise.all([
    db
      .select({ item: musicItems, addedByName: members.displayName })
      .from(musicItems)
      .leftJoin(members, eq(musicItems.addedById, members.id))
      .where(eq(musicItems.vlogId, vlogId))
      .orderBy(asc(musicItems.timelinePosition)),
    loadReactionTotals(vlogId, viewerMemberId),
    loadSelections(vlogId),
  ]);

  return Promise.all(
    rows.map(async ({ item, addedByName }) => {
      const key = `music:${item.id}`;
      const audioUrl = item.extractedAudioKey ? await presignDownload(item.extractedAudioKey) : null;
      return {
        ...item,
        addedByName,
        audioUrl,
        reactions: totals.get(key) ?? emptyTotals(),
        selected: selected.has(key),
        orderIndex: selected.get(key) ?? null,
      };
    }),
  );
}

export async function getVlogMembers(vlogId: string) {
  return db
    .select()
    .from(members)
    .where(eq(members.vlogId, vlogId))
    .orderBy(asc(members.createdAt));
}

export async function getTimeline(vlogId: string): Promise<{ doc: TimelineDoc; revision: number }> {
  const [row] = await db.select().from(timelines).where(eq(timelines.vlogId, vlogId)).limit(1);
  if (!row) return { doc: emptyTimeline(), revision: 0 };
  return { doc: normalizeTimeline(row.doc), revision: row.revision };
}

export async function getLatestRenderJob(vlogId: string) {
  const [row] = await db
    .select()
    .from(renderJobs)
    .where(eq(renderJobs.vlogId, vlogId))
    .orderBy(desc(renderJobs.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getPublishedRender(vlogId: string) {
  const [row] = await db
    .select()
    .from(renderJobs)
    .where(and(eq(renderJobs.vlogId, vlogId), eq(renderJobs.status, "done")))
    .orderBy(desc(renderJobs.finishedAt))
    .limit(1);
  if (!row?.outputKey) return null;
  return {
    ...row,
    url: await presignDownload(row.outputKey),
    downloadUrl: await presignDownload(row.outputKey, undefined, "vlog.mp4"),
  };
}

export async function countVlogContent(vlogId: string) {
  const [[media], [music]] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(mediaItems)
      .where(eq(mediaItems.vlogId, vlogId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(musicItems)
      .where(eq(musicItems.vlogId, vlogId)),
  ]);
  return { media: media?.n ?? 0, music: music?.n ?? 0 };
}
