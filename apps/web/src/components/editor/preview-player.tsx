"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clipDuration,
  clipStartTimes,
  formatDuration,
  timelineDuration,
  type TimelineDoc,
} from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { cn } from "@/lib/cn";

/**
 * Preview of the assembled cut. Plays the low-res proxies clip by clip and
 * holds photos for their duration — close enough to judge pacing without
 * rendering anything. The real output comes from FFmpeg server-side.
 */
export function PreviewPlayer({
  timeline,
  mediaById,
  durations,
  playheadTime,
  onTimeChange,
  selectedClipId,
  onSelectClip,
}: {
  timeline: TimelineDoc;
  mediaById: Map<string, MediaItemView>;
  durations: Record<string, number | null>;
  playheadTime: number;
  onTimeChange: (t: number) => void;
  selectedClipId: string | null;
  onSelectClip: (id: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef<number | null>(null);

  const total = useMemo(() => timelineDuration(timeline, durations), [timeline, durations]);
  const starts = useMemo(() => clipStartTimes(timeline, durations), [timeline, durations]);

  /** Which clip is under the playhead, and how far into it we are. */
  const active = useMemo(() => {
    for (let i = timeline.clips.length - 1; i >= 0; i--) {
      const clip = timeline.clips[i];
      const start = starts[clip.id] ?? 0;
      if (playheadTime >= start - 0.0001) {
        return { clip, index: i, offset: playheadTime - start };
      }
    }
    const first = timeline.clips[0];
    return first ? { clip: first, index: 0, offset: 0 } : null;
  }, [timeline.clips, starts, playheadTime]);

  const activeMedia = active ? mediaById.get(active.clip.mediaItemId) ?? null : null;

  // Drive playback: video elements advance themselves, photos need a timer.
  useEffect(() => {
    if (!playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    let last = performance.now();
    const tick = (now: number) => {
      const delta = (now - last) / 1000;
      last = now;

      onTimeChange(Math.min(total, playheadTime + delta));
      if (playheadTime + delta >= total) setPlaying(false);
      else rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, playheadTime, total, onTimeChange]);

  // Keep the <video> in sync with the playhead.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !active || active.clip.kind !== "video") return;

    const target = active.clip.trimStart + active.offset;
    if (Math.abs(video.currentTime - target) > 0.35) {
      video.currentTime = Math.max(0, target);
    }

    if (playing && video.paused) void video.play().catch(() => {});
    if (!playing && !video.paused) video.pause();
  }, [active, playing]);

  // Selecting a clip in the timeline jumps the playhead to it.
  useEffect(() => {
    if (!selectedClipId) return;
    const start = starts[selectedClipId];
    if (start !== undefined && Math.abs(start - playheadTime) > 0.5) {
      onTimeChange(start);
    }
    // Only react to an explicit selection change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClipId]);

  const seek = useCallback(
    (t: number) => {
      onTimeChange(Math.max(0, Math.min(total, t)));
    },
    [onTimeChange, total],
  );

  if (timeline.clips.length === 0) {
    return (
      <div className="flex aspect-video items-center justify-center rounded-xl border border-ink-800 bg-ink-900">
        <p className="text-sm text-ink-600">Nothing to preview yet</p>
      </div>
    );
  }

  const src = activeMedia
    ? active?.clip.kind === "video"
      ? activeMedia.proxyUrl ?? activeMedia.originalUrl
      : activeMedia.originalUrl ?? activeMedia.thumbnailUrl
    : null;

  return (
    <div className="overflow-hidden rounded-xl border border-ink-800 bg-black">
      <div className="relative aspect-video bg-black">
        {src ? (
          active?.clip.kind === "video" ? (
            <video
              ref={videoRef}
              key={active.clip.id}
              src={src}
              className="h-full w-full object-contain"
              playsInline
              muted={active.clip.muted}
              onEnded={() => {
                // Roll into the next clip.
                const next = timeline.clips[active.index + 1];
                if (next) seek(starts[next.id] ?? playheadTime);
                else setPlaying(false);
              }}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt="" className="h-full w-full object-contain" />
          )
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-ink-600">
            Still processing…
          </div>
        )}

        {/* Title overlays, positioned as they'll appear in the render. */}
        {active &&
          active.clip.titles
            .filter(
              (t) => active.offset >= t.start && active.offset <= t.start + t.duration,
            )
            .map((title) => (
              <div
                key={title.id}
                className={cn(
                  "pointer-events-none absolute inset-x-0 flex justify-center px-8",
                  title.position === "top" && "top-[8%]",
                  title.position === "center" && "top-1/2 -translate-y-1/2",
                  title.position === "bottom" && "bottom-[8%]",
                )}
              >
                <span
                  className="text-center font-bold drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]"
                  style={{
                    color: title.color,
                    // Scale to the preview box, roughly matching a 1080p render.
                    fontSize: `${(title.fontSize / 1080) * 100}cqh`,
                  }}
                >
                  {title.text}
                </span>
              </div>
            ))}
      </div>

      {/* Transport */}
      <div className="flex items-center gap-3 border-t border-ink-800 bg-ink-900 px-3 py-2">
        <button
          onClick={() => setPlaying((p) => !p)}
          className="btn-ghost px-2 py-1 text-base"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "⏸" : "▶"}
        </button>

        <span className="shrink-0 text-[11px] tabular-nums text-ink-400">
          {formatDuration(playheadTime)} / {formatDuration(total)}
        </span>

        <input
          type="range"
          min={0}
          max={Math.max(0.1, total)}
          step={0.05}
          value={playheadTime}
          onChange={(e) => seek(Number(e.target.value))}
          className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-ink-700 accent-brand-500"
        />

        {active && (
          <button
            onClick={() => onSelectClip(active.clip.id)}
            className="shrink-0 text-[11px] text-ink-500 hover:text-ink-300"
          >
            Clip {active.index + 1}
          </button>
        )}
      </div>
    </div>
  );
}
