"use server";

import { revalidatePath } from "next/cache";
import { and, db, eq, reactions, selections, sql } from "@vlogbuddy/db";
import { rankScore, reactSchema, selectItemSchema, reorderSelectionSchema } from "@vlogbuddy/shared";
import { requireCreator, requireMemberBySlug } from "../session";
import { emitToVlog } from "../realtime";

/**
 * One reaction per member per item. Re-reacting with the same tier clears it
 * (toggle), a different tier replaces it. This keeps the ranking honest without
 * anyone needing to understand the scoring.
 */
export async function reactAction(
  slug: string,
  input: { targetType: "media" | "music"; targetId: string; score: 1 | 2 | 3 | null },
) {
  try {
    const session = await requireMemberBySlug(slug);

    const parsed = reactSchema.safeParse(input);
    if (!parsed.success) return { ok: false as const, error: "Invalid reaction" };

    const { targetType, targetId, score } = parsed.data;

    if (score === null) {
      await db
        .delete(reactions)
        .where(
          and(
            eq(reactions.memberId, session.member.id),
            eq(reactions.targetType, targetType),
            eq(reactions.targetId, targetId),
          ),
        );
    } else {
      await db
        .insert(reactions)
        .values({
          vlogId: session.vlog.id,
          memberId: session.member.id,
          targetType,
          targetId,
          score,
        })
        .onConflictDoUpdate({
          target: [reactions.memberId, reactions.targetType, reactions.targetId],
          set: { score, updatedAt: new Date() },
        });
    }

    const [totals] = await db
      .select({
        count: sql<number>`count(*)::int`,
        sum: sql<number>`coalesce(sum(${reactions.score}), 0)::int`,
      })
      .from(reactions)
      .where(and(eq(reactions.targetType, targetType), eq(reactions.targetId, targetId)));

    const count = totals?.count ?? 0;
    const sum = totals?.sum ?? 0;

    emitToVlog(session.vlog.id, "reaction:updated", {
      targetType,
      targetId,
      memberId: session.member.id,
      score,
      totals: { count, sum, average: count ? sum / count : 0 },
    });

    revalidatePath(`/v/${slug}`);
    return { ok: true as const, count, sum, rank: rankScore(sum, count) };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Reaction failed" };
  }
}

/** Mark an item as a finalist for the final cut. */
export async function toggleSelectionAction(
  slug: string,
  input: { targetType: "media" | "music"; targetId: string; selected: boolean },
) {
  try {
    const session = await requireMemberBySlug(slug);

    if (!["curate", "edit"].includes(session.vlog.state)) {
      return { ok: false as const, error: "Selection is only open during the curate phase" };
    }

    const parsed = selectItemSchema.safeParse(input);
    if (!parsed.success) return { ok: false as const, error: "Invalid selection" };

    const { targetType, targetId, selected } = parsed.data;
    let orderIndex: number | null = null;

    if (selected) {
      const [{ nextIndex }] = await db
        .select({ nextIndex: sql<number>`coalesce(max(${selections.orderIndex}), -1) + 1` })
        .from(selections)
        .where(eq(selections.vlogId, session.vlog.id));

      orderIndex = nextIndex;

      await db
        .insert(selections)
        .values({
          vlogId: session.vlog.id,
          targetType,
          targetId,
          orderIndex: nextIndex,
          selectedById: session.member.id,
        })
        .onConflictDoNothing();
    } else {
      await db
        .delete(selections)
        .where(
          and(
            eq(selections.vlogId, session.vlog.id),
            eq(selections.targetType, targetType),
            eq(selections.targetId, targetId),
          ),
        );
    }

    emitToVlog(session.vlog.id, "selection:updated", {
      targetType,
      targetId,
      selected,
      orderIndex,
    });

    revalidatePath(`/v/${slug}`);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Selection failed" };
  }
}

/** Persist the curated running order after a drag-and-drop reorder. */
export async function reorderSelectionAction(slug: string, order: string[]) {
  try {
    const session = await requireMemberBySlug(slug);

    const parsed = reorderSelectionSchema.safeParse({ order });
    if (!parsed.success) return { ok: false as const, error: "Invalid order" };

    await db.transaction(async (tx) => {
      for (let i = 0; i < parsed.data.order.length; i++) {
        await tx
          .update(selections)
          .set({ orderIndex: i })
          .where(
            and(
              eq(selections.vlogId, session.vlog.id),
              eq(selections.targetId, parsed.data.order[i]),
            ),
          );
      }
    });

    emitToVlog(session.vlog.id, "selection:reordered", { order: parsed.data.order });
    revalidatePath(`/v/${slug}`);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Reorder failed" };
  }
}

/**
 * Convenience for the curate phase: auto-select the top N items by vote rank,
 * so a vlog can get moving without anyone clicking through everything.
 */
export async function autoSelectTopAction(slug: string, limit = 20) {
  try {
    const session = await requireMemberBySlug(slug);
    requireCreator(session);

    const ranked = await db.execute<{ target_id: string; target_type: "media" | "music" }>(sql`
      SELECT r.target_id, r.target_type
      FROM reactions r
      WHERE r.vlog_id = ${session.vlog.id} AND r.target_type = 'media'
      GROUP BY r.target_id, r.target_type
      ORDER BY
        ((SUM(r.score) + 2 * 1.6) / (COUNT(*) + 2)) * LOG(2, COUNT(*) + 1) DESC
      LIMIT ${limit}
    `);

    const rows = Array.from(ranked as Iterable<{ target_id: string; target_type: "media" | "music" }>);
    if (rows.length === 0) {
      return { ok: false as const, error: "No votes yet — react to a few items first" };
    }

    await db.transaction(async (tx) => {
      await tx.delete(selections).where(eq(selections.vlogId, session.vlog.id));
      await tx.insert(selections).values(
        rows.map((row, i) => ({
          vlogId: session.vlog.id,
          targetType: row.target_type,
          targetId: row.target_id,
          orderIndex: i,
          selectedById: session.member.id,
        })),
      );
    });

    revalidatePath(`/v/${slug}`);
    return { ok: true as const, count: rows.length };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Auto-select failed" };
  }
}
