"use client";

import { useOptimistic, useTransition } from "react";
import { PASS_SCORE, type ReactionTier, type Verdict } from "@vlogbuddy/shared";
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
  /**
   * Offer the pass cell up front. Where it's off — a 78px frame on the light
   * table has no room for a fourth cell — a pass you've already given still
   * shows, because a verdict you can't see is one you'll be asked for again.
   */
  pass?: boolean;
}

/**
 * Marking up footage, not scoring it.
 *
 * Three grease-pencil marks: keep it, it's strong, it's the shot. Your own
 * mark is filled in; everyone else's shows as a tint
 * rising through the cell and a small tally, read against the size of the crew
 * — so the question is always "did we like this", never "how many points did
 * it get". Clicking your own mark rubs it out again.
 *
 * A pass sits to their left, deliberately unlit: it's a verdict, not an
 * endorsement, and it should never look like the cheap fourth mark. It counts
 * towards how many of the crew have looked and against the shot's average,
 * and it buys the shot nothing.
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
  pass = true,
}: ReactionBarProps) {
  const [, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(
    { mine, breakdown },
    (state, next: Verdict | null) => {
      const nextBreakdown = { ...state.breakdown };
      // A pass is 0, which is falsy — these have to ask whether a verdict
      // exists, not whether it's worth anything.
      if (state.mine !== null) {
        nextBreakdown[state.mine] = Math.max(0, (nextBreakdown[state.mine] ?? 1) - 1);
      }
      if (next !== null) nextBreakdown[next] = (nextBreakdown[next] ?? 0) + 1;
      return { mine: next, breakdown: nextBreakdown };
    },
  );

  function react(score: Verdict) {
    const next = optimistic.mine === score ? null : score;
    startTransition(async () => {
      setOptimistic(next);
      await reactAction(slug, { targetType, targetId, score: next });
    });
  }

  const marked = tiers.reduce((acc, t) => acc + (optimistic.breakdown[t.score] ?? 0), 0);
  const passed = optimistic.breakdown[PASS_SCORE] ?? 0;
  const seen = marked + passed;
  const iPassed = optimistic.mine === PASS_SCORE;
  const crewSize = Math.max(crew ?? 0, seen, 1);

  const idle =
    tone === "media"
      ? "border-paper-100/25 bg-ink-950/55 text-paper-200 hover:border-paper-100/70 hover:bg-ink-950/80"
      : tone === "dark"
        ? "border-[color:var(--hair-dark)] bg-ink-850 text-ink-300 hover:border-paper-200/60 hover:text-paper-100"
        : "border-[color:var(--hair-strong)] bg-paper-50 text-ink-600 hover:border-ink-900 hover:text-ink-900";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-stretch gap-px" role="group" aria-label="Mark this footage">
        {(pass || iPassed) && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              react(PASS_SCORE);
            }}
            aria-pressed={iPassed}
            aria-label={
              passed > 0
                ? `Pass — ${passed} of ${crewSize} of the crew passed`
                : "Pass — nobody yet"
            }
            title="Not for me — clears it from your dailies"
            className={cn(
              "relative inline-flex items-center justify-center border font-mono leading-none tracking-tight transition-all active:translate-y-px",
              size === "sm" ? "mark-sm" : "mark-md",
              iPassed
                ? tone === "paper"
                  ? "border-ink-400 bg-ink-200 text-ink-700"
                  : "border-ink-500 bg-ink-700 text-paper-200"
                : cn(idle, "opacity-70"),
            )}
          >
            <span className={cn(iPassed && "animate-punch")}>{"\u2014"}</span>
          </button>
        )}

        {tiers.map((tier) => {
          const count = optimistic.breakdown[tier.score] ?? 0;
          const isMine = optimistic.mine === tier.score;
          const share = Math.min(1, count / crewSize);
          /*
           * A screen reader gets nothing useful out of "check mark" or "black
           * four pointed star". The tier's name and where the crew stands are
           * what a sighted person reads off the glyph and the fill, so the
           * label has to carry both — the same sentence the tooltip already
           * gives the mouse.
           */
          const standing =
            count > 0
              ? `${tier.label} — ${count} of ${crewSize} of the crew`
              : `${tier.label} — nobody yet`;

          return (
            <button
              key={tier.score}
              onClick={(e) => {
                e.stopPropagation();
                react(tier.score);
              }}
              aria-pressed={isMine}
              aria-label={standing}
              title={standing}
              className={cn(
                "relative inline-flex items-center justify-center overflow-hidden border font-mono leading-none tracking-tight transition-all active:translate-y-px",
                size === "sm" ? "mark-sm" : "mark-md",
                isMine ? "border-signal-500 bg-signal-600 text-paper-50" : idle,
              )}
            >
              {/*
                How much of the crew is behind this mark — a tint flooding the
                cell from the bottom rather than the 3px rule it replaces,
                which on a 78px contact-sheet frame was a hairline nobody saw.
                A floor of 18% keeps one lone vote visible.
              */}
              {count > 0 && !isMine && (
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-x-0 bottom-0 transition-[height] duration-300",
                    tone === "paper" ? "bg-signal-600/25" : "bg-signal-500/35",
                  )}
                  style={{ height: `${Math.max(18, share * 100)}%` }}
                />
              )}

              <span
                className={cn(
                  "relative z-10 inline-flex items-center gap-1",
                  isMine && "animate-punch",
                )}
              >
                <span aria-hidden>{tier.emoji}</span>
                {/* Where there's room, the mark says what it means. */}
                {size === "md" && (
                  <span aria-hidden className="text-[9px] uppercase tracking-label">
                    {tier.label}
                  </span>
                )}
              </span>

              {/* The tally, once anyone but you is behind it. */}
              {count > 0 && !isMine && (
                <span
                  aria-hidden
                  className={cn(
                    "absolute right-px top-px z-10 text-[8px] leading-none",
                    tone === "paper" ? "text-ink-600" : "text-paper-200/85",
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {!quiet && (
        <p
          className={cn(
            "font-mono text-2xs uppercase tracking-label",
            tone === "paper" ? "text-ink-600" : "text-paper-200/75",
          )}
        >
          {/*
            Three states, not two. "Unmarked" used to cover both a shot nobody
            had opened and one the whole crew had turned down, which is the
            confusion the pass exists to end.
          */}
          {seen === 0
            ? "Nobody's looked yet"
            : marked === 0
              ? crew
                ? `Passed by ${passed} of ${crew}`
                : `Passed by ${passed}`
              : crew
                ? `Marked by ${marked} of ${crew}`
                : `Marked by ${marked}`}
        </p>
      )}
    </div>
  );
}
