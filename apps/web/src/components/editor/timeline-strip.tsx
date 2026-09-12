"use client";

import { useState } from "react";
import {
  clipDuration,
  formatDuration,
  type Clip,
  type TimelineDoc,
  type TimelineOp,
} from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { cn } from "@/lib/cn";

/**
 * Horizontal timeline. Clip width is proportional to duration, so the shape of
 * the cut is readable at a glance. Drag to reorder.
 */
export function TimelineStrip({
  timeline,
  mediaById,
  durations,
  selectedClipId,
  onSelectClip,
  onDispatch,
}: {
  timeline: TimelineDoc;
  mediaById: Map<string, MediaItemView>;
  durations: Record<string, number | null>;
  selectedClipId: string | null;
  onSelectClip: (id: string) => void;
  onDispatch: (op: TimelineOp) => void;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  function handleDrop(toIndex: number) {
    if (!draggingId) return;
    const fromIndex = timeline.clips.findIndex((c) => c.id === draggingId);
    if (fromIndex !== -1 && fromIndex !== toIndex) {
      onDispatch({ type: "clip.move", clipId: draggingId, toIndex });
    }
    setDraggingId(null);
    setDragOverIndex(null);
  }

  if (timeline.clips.length === 0) {
    return (
      <div className="card px-6 py-10 text-center">
        <p className="text-sm text-ink-400">The timeline is empty.</p>
        <p className="mt-1 text-xs text-ink-600">
          Step back to Curate and pick some clips.
        </p>
      </div>
    );
  }

  return (
    <section className="card p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-ink-500">Timeline</h3>
        <span className="text-[11px] text-ink-600">Drag to reorder</span>
      </div>

      <div className="flex gap-1 overflow-x-auto scrollbar-thin pb-2">
        {timeline.clips.map((clip, index) => {
          const media = mediaById.get(clip.mediaItemId);
          const duration = clipDuration(clip, durations[clip.mediaItemId]);
          const isSelected = clip.id === selectedClipId;

          return (
            <div key={clip.id} className="flex shrink-0 items-stretch">
              {/* Drop indicator */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverIndex(index);
                }}
                onDrop={() => handleDrop(index)}
                className={cn(
                  "w-1 shrink-0 rounded-full transition-colors",
                  dragOverIndex === index && draggingId ? "bg-brand-400" : "bg-transparent",
                )}
              />

              <button
                draggable
                onDragStart={() => setDraggingId(clip.id)}
                onDragEnd={() => {
                  setDraggingId(null);
                  setDragOverIndex(null);
                }}
                onClick={() => onSelectClip(clip.id)}
                style={{
                  // Proportional width, clamped so nothing becomes unclickable.
                  width: `${Math.max(64, Math.min(200, duration * 18))}px`,
                }}
                className={cn(
                  "group relative h-20 overflow-hidden rounded-md border transition-all",
                  isSelected
                    ? "border-brand-500 ring-2 ring-brand-500/40"
                    : "border-ink-700 hover:border-ink-500",
                  draggingId === clip.id && "opacity-40",
                )}
              >
                {media?.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={media.thumbnailUrl}
                    alt=""
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <div className="h-full w-full bg-ink-800" />
                )}

                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-1 pb-0.5 pt-3">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[9px] font-mono text-ink-400">{index + 1}</span>
                    <span className="text-[9px] tabular-nums text-white">
                      {formatDuration(duration)}
                    </span>
                  </div>
                </div>

                {clip.transitionIn === "crossfade" && index > 0 && (
                  <span
                    className="absolute left-0.5 top-0.5 rounded bg-black/70 px-1 text-[9px] text-cyan-300"
                    title="Crossfades in"
                  >
                    ⇄
                  </span>
                )}
                {clip.muted && (
                  <span className="absolute right-0.5 top-0.5 rounded bg-black/70 px-1 text-[9px]">
                    🔇
                  </span>
                )}
                {clip.titles.length > 0 && (
                  <span className="absolute right-0.5 top-0.5 rounded bg-black/70 px-1 text-[9px] text-amber-300">
                    T
                  </span>
                )}
              </button>
            </div>
          );
        })}

        {/* Drop target for the end of the timeline */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverIndex(timeline.clips.length);
          }}
          onDrop={() => handleDrop(timeline.clips.length)}
          className={cn(
            "w-6 shrink-0 rounded transition-colors",
            dragOverIndex === timeline.clips.length && draggingId
              ? "bg-brand-400/30"
              : "bg-transparent",
          )}
        />
      </div>
    </section>
  );
}
