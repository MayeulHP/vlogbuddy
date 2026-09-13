"use client";

import {
  WORKSPACE_TABS,
  WORKSPACE_TAB_BLURBS,
  WORKSPACE_TAB_LABELS,
  WORKSPACE_TAB_REELS,
  type VlogState,
  type WorkspaceTab,
} from "@vlogbuddy/shared";
import { cn } from "@/lib/cn";

/**
 * Three reels, not six gates.
 *
 * Dropping, discovering, voting and shortlisting all happen on one page — they
 * feed each other, and splitting them into tabs only hid the consequences of a
 * vote from the person casting it. So the rail names the rooms that are
 * genuinely different: the floor, the bench, the screen.
 *
 * Which room you're in is your own business — it lives in your browser, so one
 * friend can be voting while another trims the cut, and nobody waits for the
 * creator to "close voting". The only vlog-wide state left is a render, which
 * does lock everyone out.
 *
 * Two shapes, same rail. On a desk it sits under the masthead where a magazine
 * would put its contents. On a phone the masthead is already eating the top of
 * a small screen and the thumb is at the bottom, so the same three rooms become
 * a bottom bar — see `variant`.
 */
export function WorkspaceNav({
  tab,
  onTab,
  state,
  counts,
  variant = "rail",
}: {
  tab: WorkspaceTab;
  onTab: (tab: WorkspaceTab) => void;
  state: VlogState;
  counts: { clips: number; unrated: number; hasRender: boolean };
  /** `rail` under the masthead (desktop), `bar` fixed to the bottom (phone). */
  variant?: "rail" | "bar";
}) {
  const rendering = state === "export";
  const locked = rendering || state === "published";
  const lockReason = rendering
    ? "Locked while the film renders"
    : "This cut is locked — reopen it from Final Cut to keep working";

  const badge: Record<WorkspaceTab, string | undefined> = {
    gather: counts.unrated > 0 ? `${counts.unrated} to mark` : undefined,
    edit: counts.clips > 0 ? String(counts.clips) : undefined,
    watch: rendering ? "···" : state === "published" ? "✓" : undefined,
  };

  const visible = WORKSPACE_TABS.filter(
    // The screening room only exists once there's something to screen.
    (candidate) => candidate !== "watch" || counts.hasRender || state === "published",
  );

  function choose(candidate: WorkspaceTab, disabled: boolean) {
    if (disabled) return;
    onTab(candidate);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (variant === "bar") {
    return (
      <nav
        aria-label="Production"
        className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-[color:var(--hair-strong)] bg-paper-50/95 backdrop-blur md:hidden"
      >
        {rendering && (
          <p className="flex items-center justify-center gap-2 border-b border-[color:var(--hair)] bg-signal-100 px-3 py-1.5 font-mono text-2xs uppercase tracking-label text-signal-700">
            <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-signal-600" />
            Rendering — the cutting room is locked
          </p>
        )}
        <div className="flex items-stretch">
          {visible.map((candidate) => {
            const active = candidate === tab;
            const disabled = locked && candidate !== "watch";
            const mark = badge[candidate];

            return (
              <button
                key={candidate}
                onClick={() => choose(candidate, disabled)}
                disabled={disabled}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2",
                  disabled && "cursor-not-allowed opacity-30",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-x-3 top-0 h-[2px]",
                    active ? "bg-signal-600" : "bg-transparent",
                  )}
                />
                <span
                  className={cn(
                    "font-mono text-[9px] uppercase tracking-label",
                    active ? "text-signal-600" : "text-ink-400",
                  )}
                >
                  {WORKSPACE_TAB_REELS[candidate]}
                </span>
                <span
                  className={cn(
                    "display-sm text-[1.05rem] leading-none",
                    active ? "text-ink-900" : "text-ink-500",
                  )}
                >
                  {WORKSPACE_TAB_LABELS[candidate]}
                </span>
                {mark && (
                  <span
                    className={cn(
                      "mt-0.5 border px-1 font-mono text-[9px] uppercase leading-[1.4] tracking-label",
                      active
                        ? "border-signal-600/40 bg-signal-100 text-signal-700"
                        : "border-[color:var(--hair)] bg-paper-200 text-ink-500",
                    )}
                  >
                    {mark}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </nav>
    );
  }

  return (
    <nav aria-label="Production" className="relative">
      <div className="scrollbar-thin touch-scroll-x -mx-1 flex items-stretch overflow-x-auto">
        {visible.map((candidate) => {
          const active = candidate === tab;
          const disabled = locked && candidate !== "watch";
          const mark = badge[candidate];

          return (
            <button
              key={candidate}
              onClick={() => choose(candidate, disabled)}
              disabled={disabled}
              aria-current={active ? "page" : undefined}
              title={disabled ? lockReason : WORKSPACE_TAB_BLURBS[candidate]}
              className={cn(
                "group relative flex shrink-0 items-baseline gap-2 px-2 pb-2.5 pt-1.5 sm:px-3",
                disabled && "cursor-not-allowed opacity-30",
              )}
            >
              <span
                className={cn(
                  "font-mono text-2xs uppercase tracking-label",
                  active ? "text-signal-600" : "text-ink-400",
                )}
              >
                {WORKSPACE_TAB_REELS[candidate]}
              </span>
              <span
                className={cn(
                  "display-sm whitespace-nowrap text-[1.3rem] leading-none",
                  active ? "text-ink-900" : "text-ink-500 group-hover:text-ink-800",
                )}
              >
                {WORKSPACE_TAB_LABELS[candidate]}
              </span>

              {mark && (
                <span
                  className={cn(
                    "ml-0.5 border px-1 font-mono text-2xs uppercase leading-[1.4] tracking-label",
                    active
                      ? "border-signal-600/40 bg-signal-100 text-signal-700"
                      : "border-[color:var(--hair)] bg-paper-200 text-ink-500",
                  )}
                >
                  {mark}
                </span>
              )}

              {/* Grease-pencil underline on the room you're in. */}
              <span
                aria-hidden
                className={cn(
                  "absolute inset-x-1 bottom-0 h-[2px] origin-left transition-transform duration-300",
                  active ? "scale-x-100 bg-signal-600" : "scale-x-0 bg-ink-400",
                  !active && "group-hover:scale-x-100",
                )}
              />
            </button>
          );
        })}
      </div>

      {rendering && (
        <p className="mt-2 flex items-center gap-2 font-mono text-2xs uppercase tracking-label text-signal-700">
          <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-signal-600" />
          Rendering — the cutting room is locked until it finishes
        </p>
      )}
    </nav>
  );
}
