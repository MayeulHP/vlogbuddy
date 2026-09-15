"use server";

import { revalidatePath } from "next/cache";
import { and, db, eq, mediaItems, musicItems, timelines } from "@vlogbuddy/db";
import {
  MIN_CLIP_SPAN,
  applyTimelineOp,
  isWorkingState,
  normalizeTimeline,
  type AudioTrack,
  type TimelineOp,
} from "@vlogbuddy/shared";
import { z } from "zod";
import { requireMemberBySlug } from "../session";
import { emitToVlog } from "../realtime";

/**
 * Trimming a track from outside the bench.
 *
 * The soundtrack lane on the floor edits `music_items` — which track is the
 * bed, where it sits on the lane — but where the needle drops lives on the
 * timeline document's audio track, and the document may only be moved by a
 * `TimelineOp` through the reducer. So the floor doesn't get to write it
 * directly: it sends what it wants here, and this turns it into the same
 * `audio.update` the bench dispatches over the socket, applied under the same
 * row lock and broadcast on the same event. Anyone with the bench open sees
 * the trim arrive as an ordinary edit.
 *
 * It deliberately does not call `syncCut`: a trim changes nothing about what's
 * in the film or in what order, and `reconcileAudio` already carries offset and
 * duration across a sync for a bed that's staying.
 */

/** What a trimming surface needs to know about a track, and nothing more. */
export interface AudioTrimState {
  trackId: string;
  offset: number;
  duration: number | null;
  /** Length of the sound file itself; null until it's been extracted. */
  sourceDuration: number | null;
}

/**
 * Spelled out rather than inferred: these cross a server-action boundary and
 * the caller narrows on `ok`, which only holds if the union stays a union.
 */
type TrimResult<T> = { ok: true; state: T } | { ok: false; error: string };

/** Ditto inside the transaction: either it wrote, or it has a reason it didn't. */
type TrimWrite =
  | { error: string }
  | { op: TimelineOp; revision: number; track: AudioTrack };

const trimInputSchema = z.object({
  musicItemId: z.string().uuid(),
  offset: z.number().min(0).optional(),
  duration: z.number().min(MIN_CLIP_SPAN).nullable().optional(),
});

/** Where the needle currently sits for a track on the soundtrack lane. */
export async function getMusicTrimAction(
  slug: string,
  musicItemId: string,
): Promise<TrimResult<AudioTrimState | null>> {
  try {
    const session = await requireMemberBySlug(slug);

    const [[row], [music]] = await Promise.all([
      db.select().from(timelines).where(eq(timelines.vlogId, session.vlog.id)).limit(1),
      db
        .select({ audioDurationSeconds: musicItems.audioDurationSeconds })
        .from(musicItems)
        .where(and(eq(musicItems.id, musicItemId), eq(musicItems.vlogId, session.vlog.id)))
        .limit(1),
    ]);

    const track = row
      ? (normalizeTimeline(row.doc).audio.find((t) => t.musicItemId === musicItemId) ?? null)
      : null;

    return {
      ok: true,
      state: track
        ? ({
            trackId: track.id,
            offset: track.offset,
            duration: track.duration,
            sourceDuration: music?.audioDurationSeconds ?? null,
          } satisfies AudioTrimState)
        : null,
    };
  } catch (err) {
    return { ok: false, error: message(err, "Couldn't read that track") };
  }
}

/**
 * How long the file behind a timeline audio track runs.
 *
 * The bench holds the document, not the sources' lengths, and there's no bar to
 * trim against without one.
 */
export async function getAudioSourceLengthAction(
  slug: string,
  trackId: string,
): Promise<{ ok: true; sourceDuration: number | null } | { ok: false; error: string }> {
  try {
    const session = await requireMemberBySlug(slug);

    const [row] = await db
      .select()
      .from(timelines)
      .where(eq(timelines.vlogId, session.vlog.id))
      .limit(1);

    const track = row ? normalizeTimeline(row.doc).audio.find((t) => t.id === trackId) : null;
    if (!track) return { ok: true, sourceDuration: null };

    // An upload wins over a link, the same way the render resolves it.
    if (track.mediaItemId) {
      const [item] = await db
        .select({ durationSeconds: mediaItems.durationSeconds })
        .from(mediaItems)
        .where(and(eq(mediaItems.id, track.mediaItemId), eq(mediaItems.vlogId, session.vlog.id)))
        .limit(1);
      return { ok: true, sourceDuration: item?.durationSeconds ?? null };
    }
    if (track.musicItemId) {
      const [item] = await db
        .select({ audioDurationSeconds: musicItems.audioDurationSeconds })
        .from(musicItems)
        .where(and(eq(musicItems.id, track.musicItemId), eq(musicItems.vlogId, session.vlog.id)))
        .limit(1);
      return { ok: true, sourceDuration: item?.audioDurationSeconds ?? null };
    }
    return { ok: true, sourceDuration: null };
  } catch (err) {
    return { ok: false, error: message(err, "Couldn't measure that track") };
  }
}

/** Move the in or out point of the track a music item is playing on. */
export async function setMusicTrimAction(
  slug: string,
  input: unknown,
): Promise<TrimResult<AudioTrimState>> {
  try {
    const session = await requireMemberBySlug(slug);

    if (!isWorkingState(session.vlog.state)) {
      return { ok: false, error: "This vlog is rendering — nothing can change yet" };
    }

    const parsed = trimInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "That trim doesn't make sense" };
    const { musicItemId, offset, duration } = parsed.data;

    const [music] = await db
      .select({ audioDurationSeconds: musicItems.audioDurationSeconds })
      .from(musicItems)
      .where(and(eq(musicItems.id, musicItemId), eq(musicItems.vlogId, session.vlog.id)))
      .limit(1);
    if (!music) return { ok: false, error: "That track isn't on the floor any more" };

    const result: TrimWrite = await db.transaction(async (tx): Promise<TrimWrite> => {
      const [current] = await tx
        .select()
        .from(timelines)
        .where(eq(timelines.vlogId, session.vlog.id))
        .for("update")
        .limit(1);

      const doc = current ? normalizeTimeline(current.doc) : null;
      const track = doc?.audio.find((t) => t.musicItemId === musicItemId) ?? null;
      if (!doc || !track) {
        return {
          error:
            "This one isn't in the film yet — put it under the cut, then you can trim it.",
        };
      }

      const patch = clampWindow(track, music.audioDurationSeconds, { offset, duration });
      const op: TimelineOp = { type: "audio.update", trackId: track.id, patch };
      const nextDoc = applyTimelineOp(doc, op);
      const revision = (current?.revision ?? 0) + 1;

      const [saved] = await tx
        .insert(timelines)
        .values({
          vlogId: session.vlog.id,
          doc: nextDoc,
          revision,
          updatedById: session.member.id,
        })
        .onConflictDoUpdate({
          target: timelines.vlogId,
          set: {
            doc: nextDoc,
            revision,
            updatedAt: new Date(),
            updatedById: session.member.id,
          },
        })
        .returning();

      const next = normalizeTimeline(saved.doc).audio.find((t) => t.id === track.id) ?? track;
      return { op, revision: saved.revision, track: next };
    });

    if ("error" in result) return { ok: false, error: result.error };

    emitToVlog(session.vlog.id, "timeline:op", {
      op: result.op,
      revision: result.revision,
      byMemberId: session.member.id,
    });

    revalidatePath(`/v/${slug}`);
    return {
      ok: true,
      state: {
        trackId: result.track.id,
        offset: result.track.offset,
        duration: result.track.duration,
        sourceDuration: music.audioDurationSeconds,
      } satisfies AudioTrimState,
    };
  } catch (err) {
    return { ok: false, error: message(err, "Couldn't trim that track") };
  }
}

/**
 * The window the client asked for, held inside the file it's cut from. The
 * caller clamps too, but it's reading a length the browser was handed — a stale
 * one, or an invented one, must not be able to write a window past the end of
 * the record.
 */
function clampWindow(
  track: AudioTrack,
  sourceDuration: number | null,
  want: { offset?: number; duration?: number | null },
): Partial<Omit<AudioTrack, "id">> {
  const patch: Partial<Omit<AudioTrack, "id">> = {};
  const source = sourceDuration && sourceDuration > MIN_CLIP_SPAN ? sourceDuration : null;

  const offset =
    want.offset === undefined
      ? track.offset
      : source
        ? Math.min(Math.max(0, want.offset), source - MIN_CLIP_SPAN)
        : Math.max(0, want.offset);
  if (want.offset !== undefined) patch.offset = round2(offset);

  if (want.duration !== undefined) {
    patch.duration =
      want.duration === null
        ? null
        : round2(
            source
              ? Math.min(Math.max(MIN_CLIP_SPAN, want.duration), source - offset)
              : Math.max(MIN_CLIP_SPAN, want.duration),
          );
  }

  return patch;
}

/** The same 2dp grid the trim bar emits on; jsonb churn is the hazard here. */
function round2(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

function message(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}
