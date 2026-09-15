"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  estimatedClipDuration,
  formatDayShort,
  formatDuration,
  type ReactionTier,
} from "@vlogbuddy/shared";
import { isInCut, type Standing } from "@/lib/is-in-cut";
import { useIsCompact, useIsTouch } from "@/hooks/use-media-query";
import type { MediaItemView } from "@/lib/queries";
import { setCutLineAction } from "@/lib/actions/cut";
import { SectionHead } from "../brand";
import { MediaCard } from "./media-card";
import { cn } from "@/lib/cn";

/**
 * The plot is drawn at absolute pixel offsets, so the phone layout is a second
 * set of numbers rather than a set of classes: narrower slots, shorter plot,
 * and a left gutter that doesn't eat a third of a 375px screen.
 */
const METRICS = {
  wide: { slot: 116, cardW: 100, plotH: 430, minCardH: 72, maxCardH: 132, gutter: 56 },
  compact: { slot: 88, cardW: 78, plotH: 290, minCardH: 58, maxCardH: 100, gutter: 40 },
} as const;

/**
 * Ways to narrow the pile. Chronology is the table's spine, but on a big trip
 * the question is rarely "what happened on Tuesday" — it's "what haven't I
 * looked at yet", and that needs a lens rather than a scroll.
 */
type Lens = "all" | "unmarked" | "mine" | "video" | "photo";

const LENSES: {
  id: Lens;
  label: string;
  match: (item: MediaItemView, memberId: string) => boolean;
}[] = [
  { id: "all", label: "Everything", match: () => true },
  // Not "unmarked": a shot you passed on has no marks either, and it is
  // emphatically not something you still owe the crew a look at.
  { id: "unmarked", label: "Not seen", match: (item) => item.reactions.mine === null },
  { id: "mine", label: "Mine", match: (item, memberId) => item.uploaderId === memberId },
  { id: "video", label: "Videos", match: (item) => item.kind === "video" },
  { id: "photo", label: "Photos", match: (item) => item.kind === "photo" },
];

/** The same three numbers the cut engine weighs, read off a loaded item. */
function standingOf(item: MediaItemView): Standing {
  return {
    rank: item.reactions.rank,
    seen: item.reactions.count,
    supporters: item.reactions.supporters,
  };
}

function chronoSort(a: MediaItemView, b: MediaItemView) {
  const at = a.capturedAt ? new Date(a.capturedAt).getTime() : Number.MAX_SAFE_INTEGER;
  const bt = b.capturedAt ? new Date(b.capturedAt).getTime() : Number.MAX_SAFE_INTEGER;
  if (at !== bt) return at - bt;
  return a.uploadIndex - b.uploadIndex;
}

function dayLabel(value: Date | string | null) {
  return formatDayShort(value) ?? "No date";
}

/**
 * The light table.
 *
 * Every frame in the film laid out left to right by when it was shot, floating
 * higher the more of the crew marked it up. The red line across it is the cut:
 * drag it and the film below reassembles itself. It's one gesture for the
 * question "how much of this trip do we actually want to sit through".
 */
export function DumpVoteTimeline({
  slug,
  media,
  memberId,
  crew,
  reactionTiers,
  threshold: savedThreshold,
  onOpen,
  onReview,
}: {
  slug: string;
  media: MediaItemView[];
  memberId: string;
  crew?: number;
  reactionTiers: ReactionTier[];
  threshold: number;
  onOpen: (item: MediaItemView) => void;
  onReview?: () => void;
}) {
  const compact = useIsCompact();
  const touch = useIsTouch();
  const m = compact ? METRICS.compact : METRICS.wide;

  const items = useMemo(
    () => media.filter((m2) => m2.kind !== "audio").sort(chronoSort),
    [media],
  );

  /*
   * The line is a property of the film, not of whatever you happen to be
   * looking at: both the scale it's measured on and the selects it produces
   * come from the whole pile, so putting a lens on can never move the line
   * under everyone else.
   */
  const maxRank = useMemo(
    () => Math.max(0.001, ...items.map((m) => m.reactions.rank), savedThreshold),
    [items, savedThreshold],
  );

  const [threshold, setThreshold] = useState(savedThreshold);
  const [dragging, setDragging] = useState(false);
  const [lens, setLens] = useState<Lens>("all");
  const draggingRef = useRef(false);
  const plotRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!dragging) setThreshold(savedThreshold);
  }, [savedThreshold, dragging]);

  const selected = useMemo(
    () => items.filter((item) => isInCut(item.cutOverride, standingOf(item), threshold)),
    [items, threshold],
  );

  const expectedSeconds = useMemo(
    () =>
      selected.reduce(
        (acc, item) =>
          acc +
          estimatedClipDuration(item.kind, item.durationSeconds, {
            rank: item.reactions.rank,
            threshold,
            mediaItemId: item.id,
          }),
        0,
      ),
    [selected, threshold],
  );

  const counts = useMemo(() => {
    const tally = {} as Record<Lens, number>;
    for (const l of LENSES) tally[l.id] = items.filter((item) => l.match(item, memberId)).length;
    return tally;
  }, [items, memberId]);

  const plotted = useMemo(() => {
    const active = LENSES.find((l) => l.id === lens);
    if (!active || lens === "all") return items;
    return items.filter((item) => active.match(item, memberId));
  }, [items, lens, memberId]);

  function persist(next: number) {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      void setCutLineAction(slug, next);
    }, 280);
  }

  function setCut(next: number, commit: boolean) {
    const clamped = Math.max(0, Math.min(maxRank, next));
    setThreshold(clamped);
    if (commit) persist(clamped);
  }

  function beginDrag(clientY: number, target: HTMLElement, pointerId: number) {
    draggingRef.current = true;
    setDragging(true);
    target.setPointerCapture(pointerId);
    setCut(scoreFromClientY(clientY), false);
  }

  function moveDrag(clientY: number) {
    if (!draggingRef.current) return;
    setCut(scoreFromClientY(clientY), false);
  }

  function endDrag(clientY: number) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    setCut(scoreFromClientY(clientY), true);
  }

  function scoreFromClientY(clientY: number) {
    const el = plotRef.current;
    if (!el) return threshold;
    const rect = el.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
    return ((rect.height - y) / rect.height) * maxRank;
  }

  const innerWidth = Math.max(plotted.length * m.slot, compact ? 300 : 640);
  const linePct = (threshold / maxRank) * 100;
  // Slots are spread across the plot's content box, which is the strip minus
  // both gutters — the same number the cards' `left` percentages resolve to.
  const step = plotted.length > 1 ? (innerWidth - m.gutter * 2) / (plotted.length - 1) : 0;

  /*
   * Windowing. Every frame on the table is a MediaCard with its own reaction
   * bar and optimistic state; a nine-hundred-photo pile is a hundred metres of
   * strip and nine hundred live subtrees to show the twenty on screen. So the
   * spacer keeps its full width — the scrollbar and the day slugs have to stay
   * honest — and only the slots near the viewport are mounted.
   */
  const [view, setView] = useState({ left: 0, width: 0 });
  // A lens can empty the table — and emptying it throws away the element the
  // measurements are attached to, so they have to be taken again when it's back.
  const hasStrip = plotted.length > 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setView((prev) => {
        const width = el.clientWidth;
        // A screen either side is already mounted, so re-windowing before the
        // strip has travelled half a screen only re-renders the same cards.
        if (width === prev.width && Math.abs(el.scrollLeft - prev.left) < width / 2) return prev;
        return { left: el.scrollLeft, width };
      });
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [hasStrip]);

  // A new lens is a new table: start it at the top of the trip rather than
  // wherever the last one happened to be parked.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
    setView((prev) => (prev.left === 0 ? prev : { ...prev, left: 0 }));
  }, [lens]);

  const visible = useMemo(() => {
    const count = plotted.length;
    if (count === 0 || step === 0) return { from: 0, to: count };
    // Server-rendered and first-paint, before the strip has been measured:
    // assume a laptop's worth and let the effect correct it.
    const vw = view.width || 1200;
    const first = Math.floor((view.left - vw - m.gutter) / step);
    const last = Math.ceil((view.left + vw * 2 - m.gutter) / step);
    return { from: Math.max(0, first), to: Math.min(count, last + 1) };
  }, [plotted.length, step, view, m.gutter]);

  const dayMarks = useMemo(() => {
    const marks: { index: number; label: string }[] = [];
    let last = "";
    plotted.forEach((item, index) => {
      const label = dayLabel(item.capturedAt);
      if (label !== last) {
        marks.push({ index, label });
        last = label;
      }
    });
    return marks;
  }, [plotted]);

  if (items.length === 0) return null;

  // On touch the plot is purely something you scroll, so the slider in the
  // head is the entire cut control and has to look like it.
  const sliderLeads = touch || compact;

  return (
    <section>
      <SectionHead
        eyebrow="Beat 02 · Discover"
        title="The light table"
        size="sm"
        note={
          touch
            ? "Left to right is when it happened. Frames rise as the crew marks them. Swipe the table to travel the trip; the Cut slider sets where the line falls."
            : "Left to right is when it happened. Frames rise as the crew marks them. Drag the red line — everything above it is in the film."
        }
        right={
          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:gap-3">
            {onReview && (
              <button onClick={onReview} className="btn-outline order-2 sm:order-none sm:self-end">
                Mark up →
              </button>
            )}
            <div className="order-1 border border-[color:var(--hair-strong)] bg-paper-50 px-3 py-2 sm:order-none">
              <p className="eyebrow">Selects · Running time</p>
              <p className="timecode mt-0.5 text-lg leading-none">
                {String(selected.length).padStart(2, "0")}
                <span className="mx-1.5 text-ink-400">/</span>
                {formatDuration(expectedSeconds)}
              </p>
              {/*
                Where the line can't be dragged, this is the only way to move
                it — so it gets the full width, a name and its own reading
                rather than sitting as a stub beside the timecode.
              */}
              <label className={cn("mt-2", sliderLeads ? "block" : "flex items-center gap-2")}>
                <span className="eyebrow block">How much of the trip makes the film</span>
                {/*
                  A slide is a drag by another name, so it borrows `dragging`:
                  it lights the line on the table, and it stops a revalidation
                  landing mid-gesture from yanking the handle back to the last
                  value the server heard.
                */}
                <input
                  type="range"
                  min={0}
                  max={maxRank}
                  step={maxRank / 200}
                  value={threshold}
                  onChange={(e) => setCut(Number(e.target.value), false)}
                  onPointerDown={() => setDragging(true)}
                  onPointerUp={(e) => {
                    setDragging(false);
                    persist(Number((e.target as HTMLInputElement).value));
                  }}
                  onPointerCancel={() => setDragging(false)}
                  onBlur={() => setDragging(false)}
                  onKeyUp={(e) => persist(Number((e.target as HTMLInputElement).value))}
                  className={cn("slider", sliderLeads ? "mt-1.5 w-full" : "w-full sm:w-32")}
                  aria-label="How much of the trip makes the film"
                  aria-valuetext={`${selected.length} of ${items.length} shots, ${formatDuration(
                    expectedSeconds,
                  )}`}
                />
                {/*
                  The ends of the slider say what moving it does; underneath,
                  what it has done. Nobody has to know the word "threshold".
                */}
                <span
                  aria-hidden
                  className="mt-1 flex items-baseline justify-between gap-3 font-mono text-2xs uppercase tracking-label text-ink-600"
                >
                  <span>Shorter</span>
                  <span className="text-signal-700">
                    {selected.length} shots · {formatDuration(expectedSeconds)}
                  </span>
                  <span>Longer</span>
                </span>
              </label>
            </div>
          </div>
        }
      />

      {/* Lenses on the pile. The line and its reading stay on the whole film. */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="eyebrow mr-1 hidden sm:inline">Show</span>
        {LENSES.map((l) => (
          <button
            key={l.id}
            onClick={() => setLens(l.id)}
            disabled={counts[l.id] === 0 && l.id !== lens}
            className={cn(lens === l.id ? "btn-ink" : "btn-outline")}
            aria-pressed={lens === l.id}
          >
            {l.label}
            <span className={cn("tabular-nums", lens === l.id ? "text-ink-400" : "text-ink-600")}>
              {counts[l.id]}
            </span>
          </button>
        ))}
        {lens !== "all" && (
          <button onClick={() => setLens("all")} className="btn-quiet">
            Clear ×
          </button>
        )}
      </div>

      {lens !== "all" && (
        <p className="mt-2 font-mono text-2xs uppercase tracking-label text-ink-600">
          Showing {plotted.length} of {items.length} · the line and the running time still count
          the whole pile
        </p>
      )}

      {!hasStrip ? (
        <div className="lighttable mt-4 border border-[color:var(--hair)] px-6 py-10 text-center">
          <p className="text-[13px] leading-relaxed text-ink-600">
            Nothing in the pile fits that one. Clear it and the whole trip comes back.
          </p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="scrollbar-thin touch-scroll-x mt-4 overflow-x-auto border border-[color:var(--hair)] lighttable"
        >
          <div
            className="relative pb-4 pt-7"
            style={{ minWidth: innerWidth, paddingLeft: m.gutter, paddingRight: m.gutter }}
          >
            {/* Day slugs along the top, with a tick each. */}
            <div
              className="pointer-events-none absolute top-2 h-4"
              style={{ left: m.gutter, right: m.gutter }}
            >
              {dayMarks.map((mark) => {
                const pct = plotted.length === 1 ? 0 : mark.index / (plotted.length - 1);
                return (
                  <span
                    key={`${mark.label}-${mark.index}`}
                    className="absolute flex items-center gap-1 whitespace-nowrap font-mono text-2xs uppercase tracking-label text-ink-600"
                    style={{ left: `${pct * 100}%` }}
                  >
                    <span aria-hidden className="h-2 w-px bg-[color:var(--hair-strong)]" />
                    {mark.label}
                  </span>
                );
              })}
            </div>

            <div
              ref={plotRef}
              /*
               * Nothing here claims a touch. A finger on the table is
               * travelling the trip — sideways through the days, or down the
               * page — and the browser does both better than we can.
               */
              className="relative"
              /*
               * Explicit, because every frame on it is absolutely positioned:
               * with nothing to give it height this collapses to zero, the
               * whole trip stacks up on one line, and the drag maths divides
               * by a zero-height rect.
               */
              style={{ height: m.plotH }}
              onPointerDown={(e) => {
                if (e.pointerType !== "mouse") return;
                if ((e.target as HTMLElement).closest("[data-media-card]")) return;
                beginDrag(e.clientY, e.currentTarget, e.pointerId);
              }}
              onPointerMove={(e) => moveDrag(e.clientY)}
              onPointerUp={(e) => endDrag(e.clientY)}
            >
              {/* The selected region — a wash of signal above the line. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 bg-signal-500/[0.07] transition-[bottom] duration-150"
                style={{ bottom: `${linePct}%` }}
              />

              <div
                className="pointer-events-none absolute inset-y-0 flex flex-col justify-between py-1 text-right font-mono text-2xs uppercase tracking-label text-ink-400"
                style={{ left: -(m.gutter - 4), width: m.gutter - 8 }}
              >
                <span>In the film</span>
                <span>Left out</span>
              </div>

              {/*
                The cut line. It spans the whole strip, so on touch it has to be
                inert or every sideways swipe that starts on it would set the
                cut instead of scrolling — and it would swallow taps on the
                frames it crosses. There it's a reading; the slider is the
                control. A mouse still grabs it: it's the best gesture in the
                app on a desk.
              */}
              <div
                className={cn(
                  "absolute inset-x-0 z-20 flex h-5 -translate-y-1/2 items-center justify-end",
                  touch ? "pointer-events-none" : "cursor-ns-resize",
                  dragging && "z-30",
                )}
                style={{ bottom: `${linePct}%` }}
                onPointerDown={(e) => {
                  if (e.pointerType !== "mouse") return;
                  e.stopPropagation();
                  beginDrag(e.clientY, e.currentTarget, e.pointerId);
                }}
                onPointerMove={(e) => moveDrag(e.clientY)}
                onPointerUp={(e) => endDrag(e.clientY)}
                onPointerCancel={(e) => endDrag(e.clientY)}
              >
                <div
                  className={cn(
                    "absolute inset-x-0 top-1/2 h-0 border-t border-signal-600",
                    // Dashes read as "grab me"; where there is nothing to grab
                    // the line is just the edge of the film, so it's plain.
                    touch ? "opacity-70" : dragging ? "border-t-2" : "border-dashed",
                  )}
                />
                <div
                  className="absolute top-1/2 flex -translate-y-1/2 items-center bg-signal-600 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-label text-paper-50"
                  style={{ left: -m.gutter }}
                >
                  {touch ? "Line" : "Cut"}
                </div>
                {/*
                  Sticky, not pinned to the end of the band: the band is as
                  long as the trip, so a reading parked at its right edge is
                  only ever visible to someone who has scrolled to the last
                  day of the holiday.
                */}
                <div
                  className={cn(
                    "pointer-events-none sticky right-0 bg-paper-100 px-1.5 font-mono text-2xs uppercase tracking-label text-signal-700 transition-opacity",
                    dragging ? "opacity-100" : "opacity-0",
                  )}
                >
                  {selected.length} selects · {formatDuration(expectedSeconds)}
                </div>
              </div>

              {/*
                Cards mounted by scrolling don't animate into place: a CSS
                transition needs a previous computed value and a node that has
                just been inserted has none. So the windowing needs no first-
                mount suppression, and the 500ms is still there for the move a
                vote causes.
              */}
              {plotted.slice(visible.from, visible.to).map((item, offset) => {
                const index = visible.from + offset;
                const pct = plotted.length === 1 ? 0 : index / (plotted.length - 1);
                const yRatio = item.reactions.rank / maxRank;
                const cardH = m.minCardH + yRatio * (m.maxCardH - m.minCardH);
                const above = isInCut(item.cutOverride, standingOf(item), threshold);
                const maxBottom = m.plotH - cardH;
                const bottom = yRatio * maxBottom;

                return (
                  <div
                    key={item.id}
                    data-media-card
                    className="absolute z-10 transition-[bottom,height] duration-500 ease-out hover:z-30"
                    style={{
                      left: `calc(${pct * 100}% - ${m.cardW / 2}px)`,
                      bottom,
                      width: m.cardW,
                      height: cardH,
                    }}
                  >
                    <MediaCard
                      slug={slug}
                      item={item}
                      tiers={reactionTiers}
                      memberId={memberId}
                      crew={crew}
                      prominence={yRatio}
                      fill
                      dimmed={!above}
                      selected={above}
                      onOpen={onOpen}
                    />
                    {item.cutOverride && (
                      <span
                        className="pointer-events-none absolute -right-1 -top-1 border border-ink-900 bg-paper-50 px-1 font-mono text-2xs uppercase tracking-label text-ink-900"
                        title={
                          item.cutOverride === "include"
                            ? "Forced into the cut by hand"
                            : "Pulled from the cut by hand"
                        }
                      >
                        {item.cutOverride === "include" ? "In" : "Out"}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
