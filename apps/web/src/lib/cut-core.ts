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
import { isInCut, type Standing } from "./is-in-cut";

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
 * The soundtrack, in the order it plays: whatever the crew put in the film and
 * hasn't taken out again. Nobody has to make this decision for the vlog to
 * render — an untouched pile falls back to its best-marked track, which is how
 * a film gets music before anyone has thought about music.
 */
function chooseSoundtrack(
  tracks: { id: string; rank: number; included: boolean }[],
  chosen: string[],
): string[] {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const kept = chosen.filter((id) => byId.get(id)?.included);
  if (kept.length > 0) return kept;
  const best = tracks.filter((t) => t.included).sort((a, b) => b.rank - a.rank)[0];
  return best ? [best.id] : [];
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
          audioDurationSeconds: musicItems.audioDurationSeconds,
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
          // Everyone who marked it rather than everyone who looked: a pass is
          // a verdict, so it lands in `count` and pulls the average down, but
          // it must never read as evidence *for* the shot.
          supporters: sql<number>`count(*) filter (where ${reactions.score} >= 1)::int`,
        })
        .from(reactions)
        .where(eq(reactions.vlogId, vlogId))
        .groupBy(reactions.targetType, reactions.targetId),
      db.select().from(selections).where(eq(selections.vlogId, vlogId)),
      db.select().from(vlogs).where(eq(vlogs.id, vlogId)).limit(1),
      db.select().from(timelines).where(eq(timelines.vlogId, vlogId)).limit(1),
    ]);

  const threshold = vlogRow[0]?.scoreThreshold ?? 0;

  const standingOf = new Map<string, Standing>();
  for (const row of reactionRows) {
    standingOf.set(`${row.targetType}:${row.targetId}`, {
      rank: rankScore(row.sum, row.count, row.supporters),
      seen: row.count,
      supporters: row.supporters,
    });
  }

  /** Nobody has looked at it yet — which is not the same as everyone passing. */
  const NO_STANDING: Standing = { rank: 0, seen: 0, supporters: 0 };
  const standing = (key: string) => standingOf.get(key) ?? NO_STANDING;
  const rankOf = (key: string) => standing(key).rank;

  // --- footage ---------------------------------------------------------------

  // Audio uploads are the music bed, not clips; a file we couldn't process
  // can't be rendered, so it never joins the cut however popular it is.
  const footage = (mediaRows as MediaRow[]).filter(
    (m) => m.kind !== "audio" && m.status !== "failed",
  );
  const chronoRank = new Map<string, number>();
  [...footage].sort(chronoCompare).forEach((m, i) => chronoRank.set(m.id, i));

  const included = footage.filter((m) =>
    isInCut(m.cutOverride, standing(`media:${m.id}`), threshold),
  );

  const previousOrder = selectionRows
    .filter((s) => s.targetType === "media")
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((s) => s.targetId);

  const order = mergeIntoOrder(previousOrder, included, chronoRank);

  // --- soundtrack ------------------------------------------------------------

  const trackState = musicRows.map((t) => ({
    id: t.id,
    rank: rankOf(`music:${t.id}`),
    included: t.cutOverride !== "exclude",
    timelinePosition: t.timelinePosition,
    seconds: t.audioDurationSeconds,
  }));

  const previousSoundtrack = selectionRows
    .filter((s) => s.targetType === "music")
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((s) => s.targetId);
  const soundtrack = chooseSoundtrack(trackState, previousSoundtrack);
  const bedMusicId = soundtrack[0] ?? null;

  // --- persist the running order --------------------------------------------

  const orderChanged =
    order.length !== previousOrder.length ||
    order.some((id, i) => id !== previousOrder[i]) ||
    soundtrack.length !== previousSoundtrack.length ||
    soundtrack.some((id, i) => id !== previousSoundtrack[i]);

  if (orderChanged) {
    const rows = [
      ...order.map((targetId, i) => ({
        vlogId,
        targetType: "media" as const,
        targetId,
        orderIndex: i,
        selectedById: memberId,
      })),
      ...soundtrack.map((targetId, i) => ({
        vlogId,
        targetType: "music" as const,
        targetId,
        orderIndex: i,
        selectedById: memberId,
      })),
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
        rank: rankOf(`media:${item.id}`),
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
  const stateById = new Map(trackState.map((t) => [t.id, t]));
  const bedPosition = stateById.get(bedMusicId ?? "")?.timelinePosition ?? 0;
  const nextAudio = reconcileSoundtrack(
    next.audio,
    soundtrack.map((id) => ({ musicItemId: id, seconds: stateById.get(id)?.seconds ?? null })),
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
 * Keeps the soundtrack in step with what the crew chose.
 *
 * The tracks play back to back: the first is the bed and starts where the
 * needle on the cut puts it, and each one after it picks up where the one
 * before it ends. That chain is rebuilt on every sync rather than written down
 * once, because a track's length arrives minutes after the link does — a queue
 * built before the sound landed corrects itself the moment it has.
 *
 * Everything else in the stack is left alone: an uploaded audio bed somebody
 * chose on the bench wins outright, and a hand-placed cue is nobody's business
 * but the person who placed it. The one thing this does claim is a track the
 * soundtrack also holds — the same music can't be both the queue's and yours.
 */
interface SoundtrackEntry {
  musicItemId: string;
  /** How long the file runs, once we've heard it. */
  seconds: number | null;
}

function reconcileSoundtrack(
  audio: AudioTrack[],
  chain: SoundtrackEntry[],
  startAt: number,
  resyncStart: boolean,
): AudioTrack[] {
  const existingBed = audio.find((t) => t.role === "bed") ?? null;
  if (existingBed?.mediaItemId) return audio; // an uploaded file wins; leave it alone.

  const claimed = new Set(chain.map((e) => e.musicItemId));
  const handPlaced = audio.filter(
    (t) => t.role !== "bed" && !(t.musicItemId && claimed.has(t.musicItemId)),
  );

  if (chain.length === 0) {
    return handPlaced.length === audio.length ? audio : handPlaced;
  }

  const byMusicId = new Map<string, AudioTrack>();
  for (const track of audio) if (track.musicItemId) byMusicId.set(track.musicItemId, track);

  const queued: AudioTrack[] = [];
  let cursor = Math.max(0, startAt);

  chain.forEach((entry, index) => {
    const existing = byMusicId.get(entry.musicItemId) ?? null;
    const isLast = index === chain.length - 1;

    // The bed keeps the start it was given until the needle moves; the rest
    // follow the track in front of them, so the music runs without a seam.
    const from =
      index === 0 && existing?.role === "bed" && !resyncStart ? existing.startAt : cursor;

    // A track with something after it stops when that one starts. The last runs
    // to the end of the picture, which is what a null duration means.
    const span = entry.seconds && entry.seconds > 0 ? round3(entry.seconds) : null;
    const duration = isLast ? (existing?.duration ?? null) : span;

    const track: AudioTrack = {
      id: existing?.id ?? globalThis.crypto.randomUUID(),
      role: index === 0 ? "bed" : "extra",
      musicItemId: entry.musicItemId,
      mediaItemId: null,
      offset: existing?.offset ?? 0,
      startAt: round3(Math.max(0, from)),
      duration,
      volume: existing?.volume ?? 0.8,
      duck: existing?.duck ?? DEFAULT_BED_DUCK,
      fadeIn: existing?.fadeIn ?? 1,
      fadeOut: existing?.fadeOut ?? 2,
      muted: existing?.muted ?? false,
      loop: existing?.loop ?? false,
    };

    queued.push(existing && sameTrack(existing, track) ? existing : track);
    cursor = track.startAt + (span ?? 0);
  });

  const next = [...queued, ...handPlaced];
  const unchanged =
    next.length === audio.length && next.every((track, i) => track === audio[i]);
  return unchanged ? audio : next;
}

/** Three decimal places, so a chain of starts can't churn a revision. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Whether the reconciled track says anything the existing one didn't. Identity
 * is the contract `syncCut` writes against: an unchanged document is not
 * written at all, so a track rebuilt into the same values has to come back as
 * the same object or every vote would churn a revision.
 */
function sameTrack(a: AudioTrack, b: AudioTrack): boolean {
  return (
    a.role === b.role &&
    a.musicItemId === b.musicItemId &&
    a.mediaItemId === b.mediaItemId &&
    a.offset === b.offset &&
    a.startAt === b.startAt &&
    a.duration === b.duration &&
    a.volume === b.volume &&
    a.duck === b.duck &&
    a.fadeIn === b.fadeIn &&
    a.fadeOut === b.fadeOut &&
    a.muted === b.muted &&
    a.loop === b.loop
  );
}
