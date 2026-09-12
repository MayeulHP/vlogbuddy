"use client";

import { useState } from "react";
import {
  clipDuration,
  formatDuration,
  type TimelineDoc,
  type TimelineOp,
} from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { cn } from "@/lib/cn";

/**
 * The strip on the bench. Shot width is proportional to duration, so the shape
 * of the cut — where it races, where it lingers — is readable at a glance.
 * Drag to reorder.
 */
export function TimelineStrip({
  timeline,
  mediaById,
  durations,
  selectedClipId,
  onSelectClip,
  onDispatch,
  onBackToGather,
}: {
  timeline: TimelineDoc;
  mediaById: Map<string, MediaItemView>;
  durations: Record<string, number | null>;
  selectedClipId: string | null;
  onSelectClip: (id: string) => void;
  onDispatch: (op: TimelineOp) => void;
  onBackToGather?: () => void;
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
      <div className="border border-[color:var(--hair-dark)] bg-ink-850 bg-hatch px-6 py-12 text-center">
        <p className="eyebrow-light">Empty strip</p>
        <p className="headline mt-2 text-2xl text-paper-100">Nothing has made the cut</p>
        <p className="mx-auto mt-2 max-w-xs text-[13px] leading-relaxed text-ink-400">
          The film builds itself out of the crew&apos;s marks. Go and mark some footage, or drag
          the cut line down to let more in.
        </p>
        {onBackToGather && (
          <button onClick={onBackToGather} className="btn-outline-dark mt-4">
            Back to the floor
          </button>
        )}
      </div>
    );
  }

  return (
    <section className="border border-[color:var(--hair-dark)] bg-ink-850">
      <div className="flex items-center justify-between border-b border-[color:var(--hair-dark)] px-3 py-2">
        <p className="eyebrow-light">Reel 02 · Strip</p>
        <p className="eyebrow-light">Drag to reorder</p>
      </div>

      <div className="scrollbar-thin scrollbar-dark overflow-x-auto">
        <div className="perf-strip flex items-stretch px-2 py-[13px]">
          {timeline.clips.map((clip, index) => {
            const media = mediaById.get(clip.mediaItemId);
            const duration = clipDuration(clip, durations[clip.mediaItemId]);
            const isSelected = clip.id === selectedClipId;

            return (
              <div key={clip.id} className="flex shrink-0 items-stretch">
                {/* Insertion rule */}
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverIndex(index);
                  }}
                  onDrop={() => handleDrop(index)}
                  className={cn(
                    "w-1.5 shrink-0 transition-colors",
                    dragOverIndex === index && draggingId ? "bg-signal-500" : "bg-transparent",
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
                    "group relative h-20 overflow-hidden border transition-all",
                    isSelected
                      ? "border-signal-500 ring-1 ring-signal-500"
                      : "border-ink-700 hover:border-paper-200/60",
                    draggingId === clip.id && "opacity-25",
                  )}
                >
                  {media?.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={media.thumbnailUrl}
                      alt=""
                      className="print-tone h-full w-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <div className="h-full w-full bg-ink-800 bg-hatch" />
                  )}

                  <span className="absolute left-0 top-0 bg-ink-950/80 px-1 font-mono text-2xs tabular-nums text-paper-200">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="absolute bottom-0 right-0 bg-ink-950/80 px-1 font-mono text-2xs tabular-nums text-paper-200">
                    {formatDuration(duration)}
                  </span>

                  <span className="absolute bottom-0 left-0 flex gap-px">
                    {clip.transitionIn === "crossfade" && index > 0 && (
                      <span
                        className="bg-ink-950/80 px-1 font-mono text-2xs text-paper-200"
                        title="Crossfades in"
                      >
                        ⇄
                      </span>
                    )}
                    {clip.muted && (
                      <span
                        className="bg-ink-950/80 px-1 font-mono text-2xs text-ink-300"
                        title="Silent"
                      >
                        ✕♪
                      </span>
                    )}
                    {clip.titles.length > 0 && (
                      <span
                        className="bg-tape-500 px-1 font-mono text-2xs text-ink-900"
                        title="Has a title"
                      >
                        T
                      </span>
                    )}
                  </span>
                </button>
              </div>
            );
          })}

          {/* Drop target for the end of the strip */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverIndex(timeline.clips.length);
            }}
            onDrop={() => handleDrop(timeline.clips.length)}
            className={cn(
              "w-7 shrink-0 transition-colors",
              dragOverIndex === timeline.clips.length && draggingId
                ? "bg-signal-500/40"
                : "bg-transparent",
            )}
          />
        </div>
      </div>
    </section>
  );
}
