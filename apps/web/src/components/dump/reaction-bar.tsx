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
  /** Crew size — a mark reads as "3 of 5 of us", never as a point total. */
  crew?: number;
  size?: "sm" | "md";
  tone?: "media" | "paper" | "dark";
  /** Hide the "marked by" line where space is tight. */
  quiet?: boolean;
}

/**
 * Marking up footage, not scoring it.
 *
 * Three grease-pencil marks: keep it, it's strong, it's the shot. Your own mark
 * is filled in; everyone else's shows as a weight under the cell, read against
 * the size of the crew — so the question is always "did we like this", never
 * "how many points did it get". Clicking your own mark rubs it out again.
 */
export function ReactionBar({
  slug,
  targetType,
  targetId,
  tiers,
  mine,
  breakdown,
  crew,
  size = "md",
  tone = "media",
  quiet,
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

  const marked = tiers.reduce((acc, t) => acc + (optimistic.breakdown[t.score] ?? 0), 0);
  const crewSize = Math.max(crew ?? 0, marked, 1);

  const idle =
    tone === "media"
      ? "border-paper-100/25 bg-ink-950/55 text-paper-200 hover:border-paper-100/70 hover:bg-ink-950/80"
      : tone === "dark"
        ? "border-[color:var(--hair-dark)] bg-ink-850 text-ink-300 hover:border-paper-200/60 hover:text-paper-100"
        : "border-[color:var(--hair-strong)] bg-paper-50 text-ink-600 hover:border-ink-900 hover:text-ink-900";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-stretch gap-px" role="group" aria-label="Mark this footage">
        {tiers.map((tier) => {
          const count = optimistic.breakdown[tier.score] ?? 0;
          const isMine = optimistic.mine === tier.score;
          const share = Math.min(1, count / crewSize);

          return (
            <button
              key={tier.score}
              onClick={(e) => {
                e.stopPropagation();
                react(tier.score);
              }}
              aria-pressed={isMine}
              title={
                count > 0
                  ? `${tier.label} — ${count} of ${crewSize} of the crew`
                  : `${tier.label} — nobody yet`
              }
              className={cn(
                "relative inline-flex items-center justify-center overflow-hidden border font-mono leading-none tracking-tight transition-all active:translate-y-px",
                size === "sm" ? "mark-sm" : "mark-md",
                isMine ? "border-signal-500 bg-signal-600 text-paper-50" : idle,
              )}
            >
              <span className={cn("relative z-10", isMine && "animate-punch")}>{tier.emoji}</span>

              {/* How much of the crew is behind this mark. */}
              {count > 0 && !isMine && (
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-x-0 bottom-0 h-[3px] transition-[width] duration-300",
                    tone === "paper" ? "bg-signal-600/70" : "bg-signal-500",
                  )}
                  style={{ width: `${Math.max(12, share * 100)}%` }}
                />
              )}
            </button>
          );
        })}
      </div>

      {!quiet && (
        <p
          className={cn(
            "font-mono text-2xs uppercase tracking-label",
            tone === "paper" ? "text-ink-500" : "text-paper-200/75",
          )}
        >
          {marked === 0
            ? "Unmarked"
            : crew
              ? `Marked by ${marked} of ${crew}`
              : `Marked by ${marked}`}
        </p>
      )}
    </div>
  );
}
