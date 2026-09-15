"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * A collapsible group inside an inspector.
 *
 * The inspectors grew one control at a time into a single flat column, which
 * reads as a list of everything rather than an order of work. Grouping them is
 * only half of it: the other half is that a *collapsed* group still has to say
 * whether anything is going on inside it, or folding one away hides a decision
 * someone made. So a section whose contents have moved off their defaults
 * carries a dot and a one-line summary in its own header.
 *
 * Open/closed is a per-browser preference, not part of the document: two people
 * on the same vlog are doing different jobs, and the film shouldn't gain a
 * revision because one of them folded up Sound.
 */
export function Section({
  storageKey,
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  /** Stable per-inspector id; the open state is remembered under it. */
  storageKey: string;
  title: string;
  /**
   * What's non-default inside, in a few words ("Dissolve · 0.6s"). `null` means
   * everything in here is still as it came, so there's nothing to flag.
   */
  summary?: string | null;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  // Read after mount: localStorage isn't there for the server render, and a
  // section that flips open on hydration is worse than one that opens a frame
  // late.
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    try {
      const saved = globalThis.localStorage?.getItem(`vb.section.${storageKey}`);
      if (saved === "1" || saved === "0") setOpen(saved === "1");
    } catch {
      // Private browsing, or storage turned off. The default stands.
    }
  }, [storageKey]);

  function toggle() {
    setOpen((wasOpen) => {
      const next = !wasOpen;
      try {
        globalThis.localStorage?.setItem(`vb.section.${storageKey}`, next ? "1" : "0");
      } catch {
        // As above — the preference just doesn't outlive the page.
      }
      return next;
    });
  }

  return (
    <div className="border-t border-[color:var(--hair-dark)] first:border-t-0">
      {/* 40px tall and 12px type: this is the handle for every fold in the
          inspector, and it was the smallest text on the page. */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex min-h-[40px] w-full items-center gap-2 py-2.5 text-left transition-colors hover:text-paper-100"
      >
        <span aria-hidden className="shrink-0 font-mono text-xs text-ink-400">
          {open ? "▾" : "▸"}
        </span>
        <span className="eyebrow-light shrink-0 text-xs">{title}</span>
        {!open && summary && (
          <span className="ml-auto flex min-w-0 items-center gap-1.5">
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 bg-signal-500" />
            <span className="timecode truncate text-2xs text-ink-300">{summary}</span>
          </span>
        )}
      </button>
      <div className={cn("space-y-4 pb-4", !open && "hidden")}>{children}</div>
    </div>
  );
}
