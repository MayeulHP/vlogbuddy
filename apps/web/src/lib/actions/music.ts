"use server";

import { revalidatePath } from "next/cache";
import { and, db, eq, musicItems } from "@vlogbuddy/db";
import {
  addMusicSchema,
  canExtractAudio,
  isWorkingState,
  moveMusicSchema,
  oembedEndpoint,
  parseMusicLink,
} from "@vlogbuddy/shared";
import { requireMemberBySlug } from "../session";
import { emitToVlog } from "../realtime";
import { syncCut } from "../cut";
import { enqueueExtractAudio } from "../queue";

/** Best-effort metadata lookup — a missing title shouldn't block adding a track. */
async function fetchOembed(endpoint: string) {
  try {
    const res = await fetch(endpoint, {
      headers: { "User-Agent": "VlogBuddy/0.1 (self-hosted)" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    return {
      title: data.title ?? null,
      artist: data.author_name ?? null,
      thumbnailUrl: data.thumbnail_url ?? null,
    };
  } catch {
    return null;
  }
}

export async function addMusicAction(
  slug: string,
  input: { url: string; timelinePosition?: number },
) {
  try {
    const session = await requireMemberBySlug(slug);

    if (!isWorkingState(session.vlog.state)) {
      return { ok: false as const, error: "This vlog is rendering — the soundtrack is locked" };
    }

    const parsed = addMusicSchema.safeParse({
      url: input.url,
      timelinePosition: input.timelinePosition ?? 0.5,
    });
    if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0].message };

    const link = parseMusicLink(parsed.data.url);
    if (!link) {
      return { ok: false as const, error: "Couldn't read that link — paste a YouTube track URL" };
    }

    /**
     * Only YouTube audio can reach the export. A Spotify or Deezer link would
     * sit in the lane collecting votes and then be silent in the finished film,
     * so it's kinder to say no at the door than to explain the silence later.
     */
    if (!canExtractAudio(link.source)) {
      return {
        ok: false as const,
        error: "That one's locked down and would come out silent — paste a YouTube link instead",
      };
    }

    const [existing] = await db
      .select()
      .from(musicItems)
      .where(
        and(
          eq(musicItems.vlogId, session.vlog.id),
          eq(musicItems.source, link.source),
          eq(musicItems.externalId, link.externalId),
        ),
      )
      .limit(1);

    if (existing) return { ok: false as const, error: "That track is already in the pile" };

    const endpoint = oembedEndpoint(link);
    const meta = endpoint ? await fetchOembed(endpoint) : null;

    const [item] = await db
      .insert(musicItems)
      .values({
        vlogId: session.vlog.id,
        addedById: session.member.id,
        source: link.source,
        externalId: link.externalId,
        url: link.url,
        embedUrl: link.embedUrl,
        title: meta?.title ?? null,
        artist: meta?.artist ?? null,
        thumbnailUrl: meta?.thumbnailUrl ?? null,
        timelinePosition: parsed.data.timelinePosition,
        status: "pending",
      })
      .returning();

    /**
     * A track parked at "pending" with nothing queued behind it never gets a
     * file, so the bed is silent in the preview and dry in the render. Queue
     * the fetch here rather than waiting for someone to ask for it.
     */
    try {
      await enqueueExtractAudio({ musicItemId: item.id, vlogId: session.vlog.id });
    } catch (err) {
      console.error("[music] could not queue audio extraction:", err);
      await db
        .update(musicItems)
        .set({
          status: "failed",
          error: "Couldn't start fetching the sound — try again in a moment",
        })
        .where(eq(musicItems.id, item.id));
    }

    // The first track added becomes the music bed on its own.
    await syncCut(session.vlog.id, session.member.id);

    emitToVlog(session.vlog.id, "music:added", { musicItemId: item.id });
    revalidatePath(`/v/${slug}`);

    return { ok: true as const, musicItemId: item.id };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Couldn't add track" };
  }
}

/** Drag a music pin along the rough timeline in the dump view. */
export async function moveMusicAction(
  slug: string,
  input: { musicItemId: string; timelinePosition: number },
) {
  try {
    const session = await requireMemberBySlug(slug);

    const parsed = moveMusicSchema.safeParse(input);
    if (!parsed.success) return { ok: false as const, error: "Invalid position" };

    await db
      .update(musicItems)
      .set({ timelinePosition: parsed.data.timelinePosition })
      .where(
        and(
          eq(musicItems.id, parsed.data.musicItemId),
          eq(musicItems.vlogId, session.vlog.id),
        ),
      );

    // Dragging the bed along the lane moves where it kicks in.
    await syncCut(session.vlog.id, session.member.id, { resyncBedStart: true });

    emitToVlog(session.vlog.id, "music:moved", {
      musicItemId: parsed.data.musicItemId,
      timelinePosition: parsed.data.timelinePosition,
    });

    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Move failed" };
  }
}

export async function deleteMusicAction(slug: string, musicItemId: string) {
  try {
    const session = await requireMemberBySlug(slug);

    const [item] = await db
      .select()
      .from(musicItems)
      .where(and(eq(musicItems.id, musicItemId), eq(musicItems.vlogId, session.vlog.id)))
      .limit(1);

    if (!item) return { ok: false as const, error: "Track not found" };

    const canDelete = item.addedById === session.member.id || session.member.role === "creator";
    if (!canDelete) return { ok: false as const, error: "You can only remove tracks you added" };

    await db.delete(musicItems).where(eq(musicItems.id, musicItemId));

    // Hands the bed to the next-best track if this one was it.
    await syncCut(session.vlog.id, session.member.id);

    emitToVlog(session.vlog.id, "music:removed", { musicItemId });
    revalidatePath(`/v/${slug}`);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Delete failed" };
  }
}

/**
 * Pull the audio for a chosen track so it can be muxed into the render. Runs
 * on its own when a track is added; this is the retry for the ones that didn't
 * come through. See the warning in .env.example about the ToS implications.
 */
export async function requestAudioExtractionAction(slug: string, musicItemId: string) {
  try {
    const session = await requireMemberBySlug(slug);

    const [item] = await db
      .select()
      .from(musicItems)
      .where(and(eq(musicItems.id, musicItemId), eq(musicItems.vlogId, session.vlog.id)))
      .limit(1);

    if (!item) return { ok: false as const, error: "Track not found" };
    if (!canExtractAudio(item.source)) {
      // Only reachable for tracks added before the door closed on these.
      return {
        ok: false as const,
        error: "That track is locked down — upload an audio file to use it in the film instead.",
      };
    }
    if (item.extractedAudioKey) return { ok: true as const, alreadyDone: true };

    await db.update(musicItems).set({ status: "pending" }).where(eq(musicItems.id, item.id));
    await enqueueExtractAudio({ musicItemId: item.id, vlogId: session.vlog.id });

    revalidatePath(`/v/${slug}`);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Extraction failed" };
  }
}
