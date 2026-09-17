import {
  and,
  db,
  eq,
  mediaItems,
  musicItems,
  reactions,
  selections,
  sql,
  timelines,
  vlogs,
} from "@vlogbuddy/db";
import {
  DEFAULT_BED_DUCK,
  emptyTimeline,
  normalizeTimeline,
  pruneTimelineReferences,
  rankScore,
  reconcileClips,
  runDirector,
  timelineDuration,
  beatGridInFilmTime,
  type AudioTrack,
  type BeatGrid,
  type CutEntry,
  type TimelineDoc,
} from "@vlogbuddy/shared";
import { isInCut } from "./is-in-cut";

/**
 * The cut engine.
 *
 * No `server-only` marker here on purpose: apps/web/server.ts needs to call
 * this outside Next's module graph, when the worker reports that an Immich
 * import has landed. Application code should import `./cut` instead, which
 * adds the guard back.
 *
 * There is exactly one description of the final cut — the timeline document —
 * and this file keeps it honest. Votes move the cut line, the cut line decides
 * what's in, humans overrule the line item by item, and every one of those
 * changes flows through `syncCut`, which rebuilds the running order and
 * reconciles the timeline without discarding anyone's trims or titles.
 *
 * That's what lets Gather and Edit be two views of the same live document
 * rather than two phases a creator has to shepherd people between.
 *
 * Broadcasting is injected rather than imported: the custom server calls this
 * from outside Next's module graph, where `server-only` (and the realtime
 * helper that imports it) can't resolve. `./cut` wires up the normal one.
 */

interface MediaRow {
  id: string;
  kind: "photo" | "video" | "audio";
  capturedAt: Date | null;
  uploadIndex: number;
  durationSeconds: number | null;
  status: "pending" | "processing" | "ready" | "failed";
  cutOverride: "include" | "exclude" | null;
  /** Where it was shot, for the auto-cut's scene breaks. Never leaves here. */
  latitude: number | null;
  longitude: number | null;
  /** Audio uploads only: the beat grid the worker measured. */
  bpm: number | null;
  beatOffsetSeconds: number | null;
  beatTimes: number[] | null;
  beatConfidence: number | null;
}

function chronoCompare(a: MediaRow, b: MediaRow) {
  const at = a.capturedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const bt = b.capturedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (at !== bt) return at - bt;
  return a.uploadIndex - b.uploadIndex;
}

/**
 * Merges newly-included items into an order people may have rearranged by
 * hand. Manual order is sacred; a newcomer lands after the last clip it
 * chronologically follows, which is where you'd expect to find it.
 */
function mergeIntoOrder(
  previousOrder: string[],
  included: MediaRow[],
  chronoRank: Map<string, number>,
): string[] {
  const includedIds = new Set(included.map((m) => m.id));
  const order = previousOrder.filter((id) => includedIds.has(id));
  const present = new Set(order);

  for (const item of [...included].sort(chronoCompare)) {
    if (present.has(item.id)) continue;
    const rank = chronoRank.get(item.id) ?? 0;
    let insertAt = 0;
    order.forEach((id, i) => {
      if ((chronoRank.get(id) ?? 0) < rank) insertAt = i + 1;
    });
    order.splice(insertAt, 0, item.id);
    present.add(item.id);
  }

  return order;
}

/**
 * Picks the music bed: whatever was chosen and is still in, otherwise the
 * best-voted track. Nobody has to make this decision for the vlog to render.
 */
function chooseBed(
  tracks: { id: string; rank: number; included: boolean }[],
  currentlyChosen: string | null,
): string | null {
  if (currentlyChosen && tracks.some((t) => t.id === currentlyChosen && t.included)) {
    return currentlyChosen;
  }
  const best = tracks
    .filter((t) => t.included)
    .sort((a, b) => b.rank - a.rank)[0];
  return best?.id ?? null;
}

/**
 * A grid measured off a track nobody could hear a pulse in would retime the
 * whole film on a guess. The analyser already refuses the hopeless cases; this
 * is the second gate, on the value that survives in the row.
 */
const MIN_BEAT_CONFIDENCE = 0.2;

interface BeatSource {
  bpm: number | null;
  beatOffsetSeconds: number | null;
  beatTimes: number[] | null;
  beatConfidence: number | null;
}

/**
 * The music bed's beats, moved onto the film's clock — the bed's own start on
 * the timeline and its offset into the track are both taken out here, so the
 * director never has to know a bed exists.
 *
 * Null whenever there's nothing to snap to: no bed, an unanalysed track, or a
 * tempo we don't believe. All three mean the cut is timed exactly as it was
 * before any of this existed.
 */
function beatGridForBed(
  doc: TimelineDoc,
  media: (BeatSource & { id: string })[],
  music: (BeatSource & { id: string })[],
): BeatGrid | null {
  const bed = doc.audio.find((t) => t.role === "bed");
  if (!bed) return null;

  const source = bed.mediaItemId
    ? media.find((m) => m.id === bed.mediaItemId)
    : bed.musicItemId
      ? music.find((m) => m.id === bed.musicItemId)
      : undefined;

  if (!source || source.bpm === null) return null;
  if ((source.beatConfidence ?? 0) < MIN_BEAT_CONFIDENCE) return null;

  return beatGridInFilmTime(source, { startAt: bed.startAt, offset: bed.offset });
}

export interface SyncCutOptions {
  /** Re-derive the music bed's start from its position on the lane. */
  resyncBedStart?: boolean;
  /** Called only when the document actually changed. */
  onTimelineSync?: (payload: { timeline: TimelineDoc; revision: number }) => void;
}

export interface SyncCutResult {
  order: string[];
  bedMusicId: string | null;
  clips: number;
}

/**
 * Recomputes the cut for a vlog and reconciles the timeline with it.
 *
 * Cheap enough to call after any vote — it bails out of the timeline write
 * when nothing actually moved, so a flurry of reactions doesn't churn
 * revisions or yank the document out from under someone who's editing.
 */
export async function syncCut(
  vlogId: string,
  memberId: string,
  options: SyncCutOptions = {},
): Promise<SyncCutResult> {
  const [mediaRows, musicRows, reactionRows, selectionRows, vlogRow, timelineRow] =
    await Promise.all([
      db
        .select({
          id: mediaItems.id,
          kind: mediaItems.kind,
          capturedAt: mediaItems.capturedAt,
          uploadIndex: mediaItems.uploadIndex,
          durationSeconds: mediaItems.durationSeconds,
          status: mediaItems.status,
          cutOverride: mediaItems.cutOverride,
          latitude: mediaItems.latitude,
          longitude: mediaItems.longitude,
          bpm: mediaItems.bpm,
          beatOffsetSeconds: mediaItems.beatOffsetSeconds,
          beatTimes: mediaItems.beatTimes,
          beatConfidence: mediaItems.beatConfidence,
        })
        .from(mediaItems)
        .where(eq(mediaItems.vlogId, vlogId)),
      db
        .select({
          id: musicItems.id,
          timelinePosition: musicItems.timelinePosition,
          cutOverride: musicItems.cutOverride,
          bpm: musicItems.bpm,
          beatOffsetSeconds: musicItems.beatOffsetSeconds,
          beatTimes: musicItems.beatTimes,
          beatConfidence: musicItems.beatConfidence,
        })
        .from(musicItems)
        .where(eq(musicItems.vlogId, vlogId)),
      db
        .select({
          targetType: reactions.targetType,
          targetId: reactions.targetId,
          count: sql<number>`count(*)::int`,
          sum: sql<number>`coalesce(sum(${reactions.score}), 0)::int`,
        })
        .from(reactions)
        .where(eq(reactions.vlogId, vlogId))
        .groupBy(reactions.targetType, reactions.targetId),
      db.select().from(selections).where(eq(selections.vlogId, vlogId)),
      db.select().from(vlogs).where(eq(vlogs.id, vlogId)).limit(1),
      db.select().from(timelines).where(eq(timelines.vlogId, vlogId)).limit(1),
    ]);

  const threshold = vlogRow[0]?.scoreThreshold ?? 0;

  const rankOf = new Map<string, number>();
  for (const row of reactionRows) {
    rankOf.set(`${row.targetType}:${row.targetId}`, rankScore(row.sum, row.count));
  }

  // --- footage ---------------------------------------------------------------

  // Audio uploads are the music bed, not clips; a file we couldn't process
  // can't be rendered, so it never joins the cut however popular it is.
  const footage = (mediaRows as MediaRow[]).filter(
    (m) => m.kind !== "audio" && m.status !== "failed",
  );
  const chronoRank = new Map<string, number>();
  [...footage].sort(chronoCompare).forEach((m, i) => chronoRank.set(m.id, i));

  const included = footage.filter((m) =>
    isInCut(m.cutOverride, rankOf.get(`media:${m.id}`) ?? 0, threshold),
  );

  const previousOrder = selectionRows
    .filter((s) => s.targetType === "media")
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((s) => s.targetId);

  const order = mergeIntoOrder(previousOrder, included, chronoRank);

  // --- soundtrack ------------------------------------------------------------

  const trackState = musicRows.map((t) => ({
    id: t.id,
    rank: rankOf.get(`music:${t.id}`) ?? 0,
    included: t.cutOverride !== "exclude",
    timelinePosition: t.timelinePosition,
  }));

  const previousBed = selectionRows.find((s) => s.targetType === "music")?.targetId ?? null;
  const bedMusicId = chooseBed(trackState, previousBed);

  // --- persist the running order --------------------------------------------

  const orderChanged =
    order.length !== previousOrder.length ||
    order.some((id, i) => id !== previousOrder[i]) ||
    bedMusicId !== previousBed;

  if (orderChanged) {
    const rows = [
      ...order.map((targetId, i) => ({
        vlogId,
        targetType: "media" as const,
        targetId,
        orderIndex: i,
        selectedById: memberId,
      })),
      ...(bedMusicId
        ? [
            {
              vlogId,
              targetType: "music" as const,
              targetId: bedMusicId,
              orderIndex: 0,
              selectedById: memberId,
            },
          ]
        : []),
    ];

    await db.transaction(async (tx) => {
      await tx.delete(selections).where(eq(selections.vlogId, vlogId));
      if (rows.length > 0) await tx.insert(selections).values(rows);
    });
  }

  // --- reconcile the timeline ------------------------------------------------

  const byId = new Map(footage.map((m) => [m.id, m]));
  const cut: CutEntry[] = order.flatMap((id) => {
    const item = byId.get(id);
    if (!item) return [];
    return [
      {
        mediaItemId: item.id,
        kind: item.kind === "video" ? ("video" as const) : ("photo" as const),
        durationSeconds: item.durationSeconds,
        capturedAt: item.capturedAt?.getTime() ?? null,
        latitude: item.latitude,
        longitude: item.longitude,
        rank: rankOf.get(`media:${item.id}`) ?? 0,
      },
    ];
  });

  const current: TimelineDoc = timelineRow[0]
    ? normalizeTimeline(timelineRow[0].doc)
    : emptyTimeline();

  // Layers and hand-placed tracks aren't in the cut, but they do point at
  // media — a photo swept from the pile can't stay pinned over shot four.
  let next = pruneTimelineReferences(current, {
    mediaIds: new Set(mediaRows.map((m) => m.id)),
    musicIds: new Set(musicRows.map((m) => m.id)),
  });
  next = reconcileClips(next, cut);

  // The auto-cut runs *before* the running time is measured: the music bed's
  // start is a fraction of that total, so it has to see the shot lengths the
  // director just chose rather than the raw source durations.
  //
  // Which means the beat grid is read off the bed *as it currently stands*.
  // A bed that has only just been chosen has no placement yet, so the first
  // sync snaps against a grid starting at zero and the next one — after
  // `reconcileAudio` has parked it on the lane — settles. Two revisions, then
  // stable; reading the placement we're about to compute would be a loop.
  next = runDirector(next, {
    cut,
    threshold,
    settings: next.director,
    beats: beatGridForBed(next, mediaRows as MediaRow[], musicRows),
  });

  const totalDuration = timelineDuration(
    next,
    Object.fromEntries(footage.map((m) => [m.id, m.durationSeconds])),
  );
  const bedPosition = trackState.find((t) => t.id === bedMusicId)?.timelinePosition ?? 0;
  const nextAudio = reconcileAudio(
    next.audio,
    bedMusicId,
    bedPosition * totalDuration,
    options.resyncBedStart ?? false,
  );
  if (nextAudio !== next.audio) {
    next = { ...next, audio: nextAudio, updatedAt: new Date().toISOString() };
  }

  if (next !== current) {
    const revision = (timelineRow[0]?.revision ?? 0) + 1;
    const [saved] = await db
      .insert(timelines)
      .values({ vlogId, doc: next, revision, updatedById: memberId })
      .onConflictDoUpdate({
        target: timelines.vlogId,
        set: { doc: next, revision, updatedAt: new Date(), updatedById: memberId },
      })
      .returning();

    options.onTimelineSync?.({ timeline: saved.doc, revision: saved.revision });
  }

  return { order, bedMusicId, clips: cut.length };
}

/**
 * Keeps the music bed in step with the soundtrack lane — but never touches an
 * uploaded audio bed someone deliberately chose in the editor, preserves the
 * volume and fades they dialled in for a track that's staying, and leaves
 * every hand-placed track alone. Only the one track marked `bed` belongs to
 * the vote.
 */
function reconcileAudio(
  audio: AudioTrack[],
  bedMusicId: string | null,
  startAt: number,
  resyncStart: boolean,
): AudioTrack[] {
  const index = audio.findIndex((t) => t.role === "bed");
  const existing = index === -1 ? null : audio[index];
  if (existing?.mediaItemId) return audio; // an uploaded file wins; leave it alone.

  if (!bedMusicId) {
    if (!existing) return audio;
    return audio.filter((_, i) => i !== index);
  }

  if (existing?.musicItemId === bedMusicId) {
    // Same track as before — keep whatever was dialled in for it in the editor,
    // unless someone just dragged it along the soundtrack lane.
    if (!resyncStart || Math.abs(existing.startAt - startAt) < 0.05) return audio;
    const next = [...audio];
    next[index] = { ...existing, startAt: Math.max(0, startAt) };
    return next;
  }

  const bed: AudioTrack = {
    id: existing?.id ?? globalThis.crypto.randomUUID(),
    role: "bed",
    musicItemId: bedMusicId,
    mediaItemId: null,
    offset: 0,
    // A track parked halfway along the soundtrack lane kicks in halfway through.
    startAt: Math.max(0, startAt),
    duration: existing?.duration ?? null,
    volume: existing?.volume ?? 0.8,
    duck: existing?.duck ?? DEFAULT_BED_DUCK,
    fadeIn: existing?.fadeIn ?? 1,
    fadeOut: existing?.fadeOut ?? 2,
    muted: existing?.muted ?? false,
    loop: existing?.loop ?? false,
  };

  if (index === -1) return [bed, ...audio];
  const next = [...audio];
  next[index] = bed;
  return next;
}
