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

/**
 * Put a shot from the pile into the cut at a chosen spot.
 *
 * Two things have to be true for a shot to stay: `cutOverride = "include"`, or
 * the next vote drops it straight back out, and a row in `selections`, or
 * `mergeIntoOrder` files it chronologically rather than where it was asked
 * for. Both are written *before* one `syncCut` pass, so the engine sees a
 * running order that already has the newcomer in it and simply keeps it —
 * rather than a doc-only insert, which the next sync would undo.
 */
export async function addToCutAction(
  slug: string,
  mediaItemId: string,
  afterMediaItemId: string | null,
) {
  try {
    const session = await requireMemberBySlug(slug);
    requireWorking(session);

    const [item] = await db
      .select({
        id: mediaItems.id,
        kind: mediaItems.kind,
        status: mediaItems.status,
        prunedAt: mediaItems.prunedAt,
      })
      .from(mediaItems)
      .where(and(eq(mediaItems.id, mediaItemId), eq(mediaItems.vlogId, session.vlog.id)))
      .limit(1);

    if (!item) return { ok: false as const, error: "That shot isn't in this pile any more" };
    if (item.kind === "audio") {
      return { ok: false as const, error: "Music goes under the cut, not in it" };
    }
    if (item.prunedAt !== null) {
      return { ok: false as const, error: "That shot has been swept — the file is gone" };
    }
    if (item.status !== "ready") {
      return { ok: false as const, error: "That one's still being processed. Give it a moment." };
    }

    await db.transaction(async (tx) => {
      await tx
        .update(mediaItems)
        .set({ cutOverride: "include" })
        .where(and(eq(mediaItems.id, mediaItemId), eq(mediaItems.vlogId, session.vlog.id)));

      const rows = await tx
        .select({ targetId: selections.targetId, orderIndex: selections.orderIndex })
        .from(selections)
        .where(and(eq(selections.vlogId, session.vlog.id), eq(selections.targetType, "media")));

      const order = rows
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .map((r) => r.targetId)
        .filter((id) => id !== mediaItemId);

      const after = afterMediaItemId ? order.indexOf(afterMediaItemId) : -1;
      // "After the current shot" when that shot has no row yet — it can't
      // happen from the bench, but landing at the end beats landing first.
      const at = afterMediaItemId && after !== -1 ? after + 1 : order.length;
      order.splice(at, 0, mediaItemId);

      await tx
        .delete(selections)
        .where(and(eq(selections.vlogId, session.vlog.id), eq(selections.targetType, "media")));
      await tx.insert(selections).values(
        order.map((targetId, i) => ({
          vlogId: session.vlog.id,
          targetType: "media" as const,
          targetId,
          orderIndex: i,
          selectedById: session.member.id,
        })),
      );
    });

    // Broadcasts `timeline:sync`, which is how the bench learns the shot is in.
    const result = await syncCut(session.vlog.id, session.member.id);

    emitToVlog(session.vlog.id, "selection:updated", {
      targetType: "media",
      targetId: mediaItemId,
      selected: true,
      orderIndex: null,
    });
    revalidatePath(`/v/${slug}`);
    return { ok: true as const, clips: result.clips };
  } catch (err) {
    return { ok: false as const, error: message(err, "Couldn't add that shot") };
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

/** Persist a hand-arranged running order. */
export async function reorderCutAction(slug: string, order: string[]) {
  try {
    const session = await requireMemberBySlug(slug);
    requireWorking(session);

    // The base track can hold both halves of a split shot, which are the same
    // media item twice; `selections` is one row per item, so the first
    // appearance is the one that decides where the item sits.
    const parsed = reorderSelectionSchema.safeParse({ order: Array.from(new Set(order)) });
    if (!parsed.success) return { ok: false as const, error: "Invalid order" };

    await db.transaction(async (tx) => {
      for (let i = 0; i < parsed.data.order.length; i++) {
        await tx
          .update(selections)
          .set({ orderIndex: i })
          .where(
            and(
              eq(selections.vlogId, session.vlog.id),
              eq(selections.targetType, "media"),
              eq(selections.targetId, parsed.data.order[i]),
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
