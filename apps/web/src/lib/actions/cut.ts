"use server";

import { revalidatePath } from "next/cache";
import { and, db, eq, mediaItems, musicItems, selections, vlogs } from "@vlogbuddy/db";
import {
  cutOverrideSchema,
  isWorkingState,
  reorderSelectionSchema,
  scoreThresholdSchema,
} from "@vlogbuddy/shared";
import { requireMemberBySlug, type VlogSession } from "../session";
import { emitToVlog } from "../realtime";
import { syncCut } from "../cut";

/**
 * Everything on the Gather page writes through here. All of it is open to any
 * member while the vlog is being worked on — the cut belongs to the group, not
 * to whoever created the link.
 */

function requireWorking(session: VlogSession) {
  if (!isWorkingState(session.vlog.state)) {
    throw new Error("This vlog is rendering — nothing can change until that finishes");
  }
}

/** Drag the cut line: everything above it is in, everything below is out. */
export async function setCutLineAction(slug: string, threshold: number) {
  try {
    const session = await requireMemberBySlug(slug);
    requireWorking(session);

    const parsed = scoreThresholdSchema.safeParse({ threshold });
    if (!parsed.success) return { ok: false as const, error: "Invalid cut line" };

    await db
      .update(vlogs)
      .set({ scoreThreshold: parsed.data.threshold, updatedAt: new Date() })
      .where(eq(vlogs.id, session.vlog.id));

    const result = await syncCut(session.vlog.id, session.member.id);

    emitToVlog(session.vlog.id, "vlog:threshold", { threshold: parsed.data.threshold });
    revalidatePath(`/v/${slug}`);
    return { ok: true as const, clips: result.clips };
  } catch (err) {
    return { ok: false as const, error: message(err, "Couldn't move the cut line") };
  }
}

/**
 * Overrule the cut line for one item. `null` hands it back to the votes, which
 * is the escape hatch that keeps the line from feeling like a trap.
 */
export async function setCutOverrideAction(
  slug: string,
  input: { targetType: "media" | "music"; targetId: string; override: "include" | "exclude" | null },
) {
  try {
    const session = await requireMemberBySlug(slug);
    requireWorking(session);

    const parsed = cutOverrideSchema.safeParse(input);
    if (!parsed.success) return { ok: false as const, error: "Invalid change" };

    const { targetType, targetId, override } = parsed.data;

    if (targetType === "media") {
      await db
        .update(mediaItems)
        .set({ cutOverride: override })
        .where(and(eq(mediaItems.id, targetId), eq(mediaItems.vlogId, session.vlog.id)));
    } else {
      await db
        .update(musicItems)
        .set({ cutOverride: override })
        .where(and(eq(musicItems.id, targetId), eq(musicItems.vlogId, session.vlog.id)));
    }

    await syncCut(session.vlog.id, session.member.id);

    emitToVlog(session.vlog.id, "selection:updated", {
      targetType,
      targetId,
      selected: override !== "exclude",
      orderIndex: null,
    });
    revalidatePath(`/v/${slug}`);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: message(err, "Couldn't change the cut") };
  }
}

/** Choose which track plays under the cut. */
export async function setMusicBedAction(slug: string, musicItemId: string | null) {
  try {
    const session = await requireMemberBySlug(slug);
    requireWorking(session);

    await db.transaction(async (tx) => {
      await tx
        .delete(selections)
        .where(and(eq(selections.vlogId, session.vlog.id), eq(selections.targetType, "music")));

      if (musicItemId) {
        // Picking a track un-excludes it, so one tap always does what it looks like.
        await tx
          .update(musicItems)
          .set({ cutOverride: null })
          .where(and(eq(musicItems.id, musicItemId), eq(musicItems.vlogId, session.vlog.id)));
        await tx.insert(selections).values({
          vlogId: session.vlog.id,
          targetType: "music",
          targetId: musicItemId,
          orderIndex: 0,
          selectedById: session.member.id,
        });
      } else {
        // "No music" means every track sits out.
        await tx
          .update(musicItems)
          .set({ cutOverride: "exclude" })
          .where(eq(musicItems.vlogId, session.vlog.id));
      }
    });

    await syncCut(session.vlog.id, session.member.id);
    revalidatePath(`/v/${slug}`);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: message(err, "Couldn't set the music") };
  }
}

/**
 * Put a track in the film, or take it out again.
 *
 * The soundtrack is a queue, not a slot: what's in plays in the order it was
 * added, each track picking up where the one before it ends. `syncCut` builds
 * that chain — all this does is say which tracks are in it.
 */
export async function setMusicInCutAction(slug: string, musicItemId: string, inCut: boolean) {
  try {
    const session = await requireMemberBySlug(slug);
    requireWorking(session);

    await db.transaction(async (tx) => {
      const [track] = await tx
        .select({ id: musicItems.id })
        .from(musicItems)
        .where(and(eq(musicItems.id, musicItemId), eq(musicItems.vlogId, session.vlog.id)))
        .limit(1);
      if (!track) throw new Error("Track not found");

      const chosen = await tx
        .select()
        .from(selections)
        .where(and(eq(selections.vlogId, session.vlog.id), eq(selections.targetType, "music")));

      if (inCut) {
        // Choosing a track un-excludes it, so one tap always does what it looks like.
        await tx
          .update(musicItems)
          .set({ cutOverride: null })
          .where(eq(musicItems.id, musicItemId));

        if (chosen.some((s) => s.targetId === musicItemId)) return;
        await tx.insert(selections).values({
          vlogId: session.vlog.id,
          targetType: "music",
          targetId: musicItemId,
          orderIndex: chosen.reduce((next, s) => Math.max(next, s.orderIndex + 1), 0),
          selectedById: session.member.id,
        });
        return;
      }

      await tx
        .delete(selections)
        .where(
          and(
            eq(selections.vlogId, session.vlog.id),
            eq(selections.targetType, "music"),
            eq(selections.targetId, musicItemId),
          ),
        );

      /**
       * Taking a track out has to stick. An empty queue falls back to the
       * best-marked track — which is how a film gets music without anyone
       * choosing, and which would otherwise hand the film straight back to the
       * track just removed. Emptying the queue therefore means silence, and
       * everything sits out until somebody picks again.
       */
      const emptied = chosen.filter((s) => s.targetId !== musicItemId).length === 0;
      await tx
        .update(musicItems)
        .set({ cutOverride: "exclude" })
        .where(
          emptied
            ? eq(musicItems.vlogId, session.vlog.id)
            : and(eq(musicItems.id, musicItemId), eq(musicItems.vlogId, session.vlog.id)),
        );
    });

    await syncCut(session.vlog.id, session.member.id);
    revalidatePath(`/v/${slug}`);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: message(err, "Couldn't change the soundtrack") };
  }
}

/** Persist a hand-arranged running order. */
export async function reorderCutAction(slug: string, order: string[]) {
  try {
    const session = await requireMemberBySlug(slug);
    requireWorking(session);

    const parsed = reorderSelectionSchema.safeParse({ order });
    if (!parsed.success) return { ok: false as const, error: "Invalid order" };

    /**
     * One row per shot, however many clips point at it.
     *
     * `selections` tracks media, not clips, so an order carrying the same id
     * twice would write two different indices to one row and leave the
     * positions between them unused. Nothing can send a duplicate today —
     * the cut holds one clip per media item — but a shot split in two would,
     * and the failure is a running order that quietly rearranges itself.
     */
    const unique = Array.from(new Set(parsed.data.order));

    await db.transaction(async (tx) => {
      for (let i = 0; i < unique.length; i++) {
        await tx
          .update(selections)
          .set({ orderIndex: i })
          .where(
            and(
              eq(selections.vlogId, session.vlog.id),
              eq(selections.targetType, "media"),
              eq(selections.targetId, unique[i]),
            ),
          );
      }
    });

    await syncCut(session.vlog.id, session.member.id);

    emitToVlog(session.vlog.id, "selection:reordered", { order: parsed.data.order });
    revalidatePath(`/v/${slug}`);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: message(err, "Couldn't reorder the cut") };
  }
}

/** Forget every manual decision and let the votes speak again. */
export async function resetCutAction(slug: string) {
  try {
    const session = await requireMemberBySlug(slug);
    requireWorking(session);

    await db.transaction(async (tx) => {
      await tx
        .update(mediaItems)
        .set({ cutOverride: null })
        .where(eq(mediaItems.vlogId, session.vlog.id));
      await tx
        .update(musicItems)
        .set({ cutOverride: null })
        .where(eq(musicItems.vlogId, session.vlog.id));
      // Dropping the order rows makes syncCut re-derive it chronologically.
      await tx.delete(selections).where(eq(selections.vlogId, session.vlog.id));
    });

    const result = await syncCut(session.vlog.id, session.member.id);
    revalidatePath(`/v/${slug}`);
    return { ok: true as const, clips: result.clips };
  } catch (err) {
    return { ok: false as const, error: message(err, "Couldn't reset the cut") };
  }
}

function message(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}
