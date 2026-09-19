"use server";

import { revalidatePath } from "next/cache";
import { and, db, eq, reactions, sql } from "@vlogbuddy/db";
import { isWorkingState, rankScore, reactSchema, type Verdict } from "@vlogbuddy/shared";
import { requireMemberBySlug } from "../session";
import { emitToVlog } from "../realtime";
import { syncCut } from "../cut";

/**
 * One verdict per member per item. Re-reacting with the same verdict clears it
 * (toggle), a different one replaces it. This keeps the ranking honest without
 * anyone needing to understand the scoring.
 *
 * `0` is a pass and gets stored like any mark. Only `null` deletes the row, and
 * it means one specific thing — this person hasn't looked — which is the
 * question the dailies queue asks. Passing used to delete too, so the deck kept
 * handing back shots people had already turned down and the cheapest way out
 * was a mark nobody meant.
 *
 * A vote can change what's above the cut line, so the running order and the
 * timeline are reconciled straight away — the final cut on screen is always
 * the one that would render.
 */
export async function reactAction(
  slug: string,
  input: { targetType: "media" | "music"; targetId: string; score: Verdict | null },
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
        supporters: sql<number>`count(*) filter (where ${reactions.score} >= 1)::int`,
      })
      .from(reactions)
      .where(and(eq(reactions.targetType, targetType), eq(reactions.targetId, targetId)));

    const count = totals?.count ?? 0;
    const sum = totals?.sum ?? 0;
    const supporters = totals?.supporters ?? 0;

    emitToVlog(session.vlog.id, "reaction:updated", {
      targetType,
      targetId,
      memberId: session.member.id,
      score,
      totals: { count, sum, supporters, average: count ? sum / count : 0 },
    });

    if (isWorkingState(session.vlog.state)) {
      await syncCut(session.vlog.id, session.member.id);
    }

    revalidatePath(`/v/${slug}`);
    return { ok: true as const, count, sum, rank: rankScore(sum, count, supporters) };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Reaction failed" };
  }
}
