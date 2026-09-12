"use client";

import { useOptimistic, useTransition } from "react";
import type { ReactionTier } from "@vlogbuddy/shared";
import { reactAction } from "@/lib/actions/reactions";
import { cn } from "@/lib/cn";

interface ReactionBarProps {
  slug: string;
  targetType: "media" | "music";
  targetId: string;
  tiers: ReactionTier[];
  mine: number | null;
  breakdown: Record<number, number>;
  size?: "sm" | "md";
}

/**
 * Three emoji, three scores. Clicking the tier you already picked clears it, so
 * voting stays a single tap either way.
 */
export function ReactionBar({
  slug,
  targetType,
  targetId,
  tiers,
  mine,
  breakdown,
  size = "md",
}: ReactionBarProps) {
  const [, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(
    { mine, breakdown },
    (state, next: number | null) => {
      const nextBreakdown = { ...state.breakdown };
      if (state.mine) nextBreakdown[state.mine] = Math.max(0, (nextBreakdown[state.mine] ?? 1) - 1);
      if (next) nextBreakdown[next] = (nextBreakdown[next] ?? 0) + 1;
      return { mine: next, breakdown: nextBreakdown };
    },
  );

  function react(score: 1 | 2 | 3) {
    const next = optimistic.mine === score ? null : score;
    startTransition(async () => {
      setOptimistic(next);
      await reactAction(slug, { targetType, targetId, score: next });
    });
  }

  return (
    <div className="flex items-center gap-1">
      {tiers.map((tier) => {
        const count = optimistic.breakdown[tier.score] ?? 0;
        const isMine = optimistic.mine === tier.score;
        return (
          <button
            key={tier.score}
            onClick={(e) => {
              e.stopPropagation();
              react(tier.score);
            }}
            title={`${tier.label}${count ? ` — ${count} vote${count === 1 ? "" : "s"}` : ""}`}
            className={cn(
              "flex items-center gap-0.5 rounded-full border transition-all active:scale-95",
              size === "sm" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs",
              isMine
                ? "border-brand-400/60 bg-brand-500/25 text-white"
                : "border-white/10 bg-black/40 text-ink-300 hover:border-white/25 hover:bg-black/60",
            )}
          >
            <span className={cn(isMine && "animate-pop")}>{tier.emoji}</span>
            {count > 0 && <span className="font-medium tabular-nums">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
