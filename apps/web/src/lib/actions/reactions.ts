"use server";

import { revalidatePath } from "next/cache";
import { and, db, eq, reactions, sql } from "@vlogbuddy/db";
import { isWorkingState, rankScore, reactSchema } from "@vlogbuddy/shared";
import { requireMemberBySlug } from "../session";
import { emitToVlog } from "../realtime";
import { syncCut } from "../cut";

/**
 * One reaction per member per item. Re-reacting with the same tier clears it
 * (toggle), a different tier replaces it. This keeps the ranking honest without
 * anyone needing to understand the scoring.
 *
 * A vote can change what's above the cut line, so the running order and the
 * timeline are reconciled straight away — the final cut on screen is always
 * the one that would render.
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

    if (isWorkingState(session.vlog.state)) {
      await syncCut(session.vlog.id, session.member.id);
    }

    revalidatePath(`/v/${slug}`);
    return { ok: true as const, count, sum, rank: rankScore(sum, count) };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Reaction failed" };
  }
}
