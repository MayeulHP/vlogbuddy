"use client";

import { useState, useTransition } from "react";
import { VLOG_STATES, VLOG_STATE_LABELS, type VlogState } from "@vlogbuddy/shared";
import { setVlogStateAction } from "@/lib/actions/vlog";
import { buildTimelineFromSelectionAction } from "@/lib/actions/timeline";
import { cn } from "@/lib/cn";

const PHASE_ICONS: Record<VlogState, string> = {
  open: "📥",
  curate: "⭐",
  edit: "✂️",
  export: "⚙️",
  published: "🎉",
};

export function PhaseNav({
  slug,
  current,
  isCreator,
  counts,
}: {
  slug: string;
  current: VlogState;
  isCreator: boolean;
  counts: { media: number; music: number };
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const currentIndex = VLOG_STATES.indexOf(current);
  // Rendering and publishing are driven by the render job, not this nav.
  const nextPhase = currentIndex < 2 ? VLOG_STATES[currentIndex + 1] : null;

  function advance(to: VlogState) {
    setError(null);
    startTransition(async () => {
      // Moving into the editor assembles the first draft from the selection.
      if (to === "edit") {
        const built = await buildTimelineFromSelectionAction(slug);
        if (!built.ok) {
          setError(built.error);
          return;
        }
      }
      const result = await setVlogStateAction(slug, to);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {VLOG_STATES.map((phase, i) => {
          const isCurrent = phase === current;
          const isDone = i < currentIndex;
          return (
            <div key={phase} className="flex items-center gap-1.5">
              <div
                className={cn(
                  "chip border",
                  isCurrent && "border-brand-500/50 bg-brand-500/15 text-brand-300",
                  isDone && "border-ink-700 bg-ink-850 text-ink-400",
                  !isCurrent && !isDone && "border-ink-800 bg-transparent text-ink-600",
                )}
              >
                <span className={cn(!isCurrent && !isDone && "opacity-50")}>
                  {isDone ? "✓" : PHASE_ICONS[phase]}
                </span>
                {VLOG_STATE_LABELS[phase]}
              </div>
              {i < VLOG_STATES.length - 1 && (
                <span className={cn("text-xs", isDone ? "text-ink-600" : "text-ink-800")}>→</span>
              )}
            </div>
          );
        })}

        {isCreator && nextPhase && (
          <button
            onClick={() => advance(nextPhase)}
            disabled={pending || (current === "open" && counts.media === 0)}
            className="btn-primary ml-auto text-xs"
            title={
              current === "open" && counts.media === 0
                ? "Upload something first"
                : `Move everyone to ${VLOG_STATE_LABELS[nextPhase]}`
            }
          >
            {pending ? "Working…" : `${PHASE_ICONS[nextPhase]} ${nextPhaseLabel(nextPhase)}`}
          </button>
        )}

        {isCreator && currentIndex > 0 && currentIndex < 3 && (
          <button
            onClick={() => advance(VLOG_STATES[currentIndex - 1])}
            disabled={pending}
            className="btn-ghost text-xs"
          >
            ← Back
          </button>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

function nextPhaseLabel(phase: VlogState): string {
  switch (phase) {
    case "curate":
      return "Close voting";
    case "edit":
      return "Start editing";
    default:
      return VLOG_STATE_LABELS[phase];
  }
}
