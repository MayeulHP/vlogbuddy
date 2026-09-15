"use client";

import { useState } from "react";
import { rotateMediaAction } from "@/lib/actions/media";
import { cn } from "@/lib/cn";

/**
 * Turns a sideways shot upright, a quarter at a time.
 *
 * One button rather than four choices on purpose: when a file's rotation flag
 * is right — which is nearly always — this is a control nobody should have to
 * read. Four radio buttons would put a decision on screen for a defect that
 * usually isn't there; one button that goes round is something you tap until
 * the picture looks right, and the same control undoes itself.
 *
 * It lives wherever somebody actually notices, which is full screen while
 * voting. In the deck that means stopping the pointer here: the frame behind
 * is a swipe target and a tap on this must not read as the start of a verdict.
 */
export function RotateButton({
  slug,
  mediaItemId,
  className,
  compact,
}: {
  slug: string;
  mediaItemId: string;
  className?: string;
  /** Glyph only — for places where a word of chrome is a word too many. */
  compact?: boolean;
}) {
  const [turning, setTurning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function turn() {
    if (turning) return;
    setTurning(true);
    setError(null);
    const res = await rotateMediaAction(slug, mediaItemId);
    if (!res.ok) setError(res.error);
    setTurning(false);
  }

  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation();
          void turn();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        disabled={turning}
        className={cn("disabled:opacity-60", className)}
        title="Turn this shot a quarter to the right"
        aria-label={compact ? "Turn this shot a quarter to the right" : undefined}
      >
        <span aria-hidden>↻</span>
        {!compact && <span className="ml-1">Turn</span>}
      </button>
      {error && (
        <span role="alert" className="text-[11px] leading-tight text-signal-300">
          {error}
        </span>
      )}
    </>
  );
}
