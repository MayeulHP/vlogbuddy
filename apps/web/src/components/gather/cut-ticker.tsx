"use client";

import { useEffect, useMemo, useState, type RefObject } from "react";
import { clipDuration, formatDuration, timelineDuration, type TimelineDoc } from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { RotatedMedia } from "@/lib/rotated-media";
import { cn } from "@/lib/cn";

/**
 * What the marking is adding up to, on screen while you mark.
 *
 * The rough cut is the last lane of a four-screen page, so the consequence of
 * a vote was always below the fold: you'd mark ten shots and never see the film
 * move. This is that lane's slate line, pinned to the bottom of the viewport —
 * the shot count, the running time, and the first few frames in order, so a
 * mark that changes the cut changes something you can actually see.
 *
 * It reports and it navigates; it never edits. The corrections all live in the
 * real strip, which is one tap away — duplicating them here would mean two
 * copies of the drag state and two ways for them to disagree.
 *
 * It hides itself once the real rough cut is on screen. Two running times a
 * thumb apart, both live, both the same number, is just noise — and being
 * fixed only while the thing it summarises is *off* screen is also what keeps
 * it from covering the last block on the page.
 */
export function CutTicker({
  timeline,
  media,
  /** The section holding the real rough cut — the ticker stands down for it. */
  watch,
  onOpen,
}: {
  timeline: TimelineDoc;
  media: MediaItemView[];
  watch: RefObject<HTMLElement | null>;
  onOpen: () => void;
}) {
  const covered = useIsOnScreen(watch);

  const byId = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);
  const durations = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const item of media) out[item.id] = item.durationSeconds;
    return out;
  }, [media]);

  const shots = timeline.clips.length;
  const total = timelineDuration(timeline, durations);

  // Enough frames to read as an order, few enough to stay one line on a phone.
  const frames = timeline.clips.slice(0, 8);

  if (shots === 0) return null;

  return (
    <div
      className={cn(
        // Above the phone's tab bar; hard to the bottom edge once that's gone.
        "px-safe fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)+4.75rem)] z-30 md:bottom-0",
        "transition-[opacity,transform] duration-200 motion-reduce:transition-none",
        covered
          ? "pointer-events-none translate-y-2 opacity-0"
          : "translate-y-0 opacity-100",
      )}
    >
      <div className="mx-auto max-w-[1600px] px-4 sm:px-7">
        <button
          onClick={onOpen}
          aria-hidden={covered}
          tabIndex={covered ? -1 : undefined}
          className="group flex w-full items-center gap-3 border border-ink-700 bg-ink-900/95 px-3 py-2 text-left shadow-print backdrop-blur md:border-b-0"
        >
          <span className="eyebrow-light hidden shrink-0 sm:inline">The rough cut</span>
          <span aria-hidden className="hidden h-4 w-px shrink-0 bg-ink-700 sm:block" />

          <span className="shrink-0 font-mono text-2xs uppercase tracking-label text-paper-200">
            {shots} shot{shots === 1 ? "" : "s"}
          </span>
          <span aria-hidden className="h-2.5 w-px shrink-0 bg-ink-700" />
          <span className="timecode shrink-0 text-sm leading-none text-paper-100">
            {formatDuration(total)}
          </span>

          {/* The order itself, so a mark that moves a shot moves something visible. */}
          <span className="hidden min-w-0 flex-1 items-center gap-px overflow-hidden sm:flex">
            {frames.map((clip) => {
              const item = byId.get(clip.mediaItemId);
              if (!item) return null;
              return (
                <span
                  key={clip.id}
                  style={{
                    width: `${Math.max(14, Math.min(44, clipDuration(clip, durations[item.id]) * 5))}px`,
                  }}
                  className="h-7 shrink-0 overflow-hidden border border-ink-800 bg-ink-850"
                >
                  {item.thumbnailUrl && (
                    <RotatedMedia rotation={item.rotation}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={item.thumbnailUrl}
                        alt=""
                        loading="lazy"
                        className="print-tone h-full w-full object-cover"
                      />
                    </RotatedMedia>
                  )}
                </span>
              );
            })}
            {shots > frames.length && (
              <span className="ml-1.5 shrink-0 font-mono text-2xs text-ink-400">
                +{shots - frames.length}
              </span>
            )}
          </span>

          <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-2xs uppercase tracking-label text-signal-400 sm:ml-0">
            <span aria-hidden className="text-sm leading-none">▶</span>
            <span className="hidden sm:inline">Open</span>
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * Whether an element is anywhere in the viewport.
 *
 * An observer rather than a scroll handler: the rough cut's height changes with
 * every vote, so a threshold measured once in pixels would drift out of date,
 * and reading offsets on scroll costs a layout on a phone.
 */
function useIsOnScreen(ref: RefObject<HTMLElement | null>) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      // A sliver counts: as soon as the real strip's top edge clears the
      // ticker, the ticker is the redundant one.
      { rootMargin: "0px 0px -72px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return visible;
}
