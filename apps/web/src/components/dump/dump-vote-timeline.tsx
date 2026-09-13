"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  estimatedClipDuration,
  formatDayShort,
  formatDuration,
  type ReactionTier,
} from "@vlogbuddy/shared";
import { isInCut } from "@/lib/is-in-cut";
import type { MediaItemView } from "@/lib/queries";
import { setCutLineAction } from "@/lib/actions/cut";
import { SectionHead } from "../brand";
import { MediaCard } from "./media-card";
import { cn } from "@/lib/cn";

const SLOT = 116;
const CARD_W = 100;
const PLOT_H = 430;
const MIN_CARD_H = 72;
const MAX_CARD_H = 132;

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
  const items = useMemo(
    () => media.filter((m) => m.kind !== "audio").sort(chronoSort),
    [media],
  );

  const maxRank = useMemo(
    () => Math.max(0.001, ...items.map((m) => m.reactions.rank), savedThreshold),
    [items, savedThreshold],
  );

  const [threshold, setThreshold] = useState(savedThreshold);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const plotRef = useRef<HTMLDivElement>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!dragging) setThreshold(savedThreshold);
  }, [savedThreshold, dragging]);

  const selected = useMemo(
    () => items.filter((item) => isInCut(item.cutOverride, item.reactions.rank, threshold)),
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

  const innerWidth = Math.max(items.length * SLOT, 640);
  const linePct = (threshold / maxRank) * 100;

  const dayMarks = useMemo(() => {
    const marks: { index: number; label: string }[] = [];
    let last = "";
    items.forEach((item, index) => {
      const label = dayLabel(item.capturedAt);
      if (label !== last) {
        marks.push({ index, label });
        last = label;
      }
    });
    return marks;
  }, [items]);

  if (items.length === 0) return null;

  return (
    <section>
      <SectionHead
        eyebrow="Beat 02 · Discover"
        title="The light table"
        note="Left to right is when it happened. Frames rise as the crew marks them. Drag the red line — everything above it is in the film."
        right={
          <div className="flex items-stretch gap-3">
            {onReview && (
              <button onClick={onReview} className="btn-outline self-end">
                Mark up →
              </button>
            )}
            <div className="border border-[color:var(--hair-strong)] bg-paper-50 px-3 py-2">
              <p className="eyebrow">Selects · Running time</p>
              <p className="timecode mt-0.5 text-lg leading-none">
                {String(selected.length).padStart(2, "0")}
                <span className="mx-1.5 text-ink-400">/</span>
                {formatDuration(expectedSeconds)}
              </p>
              <label className="mt-2 flex items-center gap-2">
                <span className="eyebrow">Cut</span>
                <input
                  type="range"
                  min={0}
                  max={maxRank}
                  step={maxRank / 200}
                  value={threshold}
                  onChange={(e) => setCut(Number(e.target.value), false)}
                  onMouseUp={(e) => persist(Number((e.target as HTMLInputElement).value))}
                  onTouchEnd={(e) => persist(Number((e.target as HTMLInputElement).value))}
                  className="slider w-32"
                  aria-label="Cut line"
                />
              </label>
            </div>
          </div>
        }
      />

      <div className="scrollbar-thin mt-4 overflow-x-auto border border-[color:var(--hair)] lighttable">
        <div className="relative px-14 pb-4 pt-7" style={{ minWidth: innerWidth }}>
          {/* Day slugs along the top, with a tick each. */}
          <div className="pointer-events-none absolute inset-x-14 top-2 h-4">
            {dayMarks.map((mark) => {
              const pct = items.length === 1 ? 0 : mark.index / (items.length - 1);
              return (
                <span
                  key={`${mark.label}-${mark.index}`}
                  className="absolute flex items-center gap-1 whitespace-nowrap font-mono text-2xs uppercase tracking-label text-ink-500"
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
            className="relative touch-none"
            style={{ height: PLOT_H }}
            onPointerDown={(e) => {
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

            <div className="pointer-events-none absolute inset-y-0 -left-11 flex w-9 flex-col justify-between py-1 text-right font-mono text-2xs uppercase tracking-label text-ink-400">
              <span>Kept</span>
              <span>Quiet</span>
            </div>

            {/* The cut line. */}
            <div
              className={cn(
                "absolute inset-x-0 z-20 h-5 -translate-y-1/2 cursor-ns-resize",
                dragging && "z-30",
              )}
              style={{ bottom: `${linePct}%` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                beginDrag(e.clientY, e.currentTarget, e.pointerId);
              }}
              onPointerMove={(e) => moveDrag(e.clientY)}
              onPointerUp={(e) => endDrag(e.clientY)}
            >
              <div
                className={cn(
                  "absolute inset-x-0 top-1/2 h-0 border-t border-signal-600",
                  dragging ? "border-t-2" : "border-dashed",
                )}
              />
              <div className="absolute -left-14 top-1/2 flex -translate-y-1/2 items-center bg-signal-600 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-label text-paper-50">
                Cut
              </div>
              <div
                className={cn(
                  "pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 bg-paper-100 px-1.5 font-mono text-2xs uppercase tracking-label text-signal-700 transition-opacity",
                  dragging ? "opacity-100" : "opacity-0",
                )}
              >
                {selected.length} selects · {formatDuration(expectedSeconds)}
              </div>
            </div>

            {items.map((item, index) => {
              const pct = items.length === 1 ? 0 : index / (items.length - 1);
              const yRatio = item.reactions.rank / maxRank;
              const cardH = MIN_CARD_H + yRatio * (MAX_CARD_H - MIN_CARD_H);
              const above = isInCut(item.cutOverride, item.reactions.rank, threshold);
              const maxBottom = PLOT_H - cardH;
              const bottom = yRatio * maxBottom;

              return (
                <div
                  key={item.id}
                  data-media-card
                  className="absolute z-10 transition-[bottom,height] duration-500 ease-out hover:z-30"
                  style={{
                    left: `calc(${pct * 100}% - ${CARD_W / 2}px)`,
                    bottom,
                    width: CARD_W,
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
    </section>
  );
}
