"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  audioTrackSpan,
  clipStartTimes,
  formatDuration,
  layersInPaintOrder,
  timelineDuration,
  type AudioTrack,
  type LayerClip,
  type TimelineDoc,
} from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import { cn } from "@/lib/cn";

/**
 * Preview of the assembled cut. Plays the low-res proxies clip by clip, holds
 * photos for their duration, stacks the layers over the top and runs the audio
 * stack underneath — close enough to judge pacing and placement without
 * rendering anything. The real output comes from FFmpeg server-side.
 */
export function PreviewPlayer({
  timeline,
  mediaById,
  musicById,
  durations,
  playheadTime,
  onTimeChange,
  selectedClipId,
  onSelectClip,
}: {
  timeline: TimelineDoc;
  mediaById: Map<string, MediaItemView>;
  musicById: Map<string, MusicItemView>;
  durations: Record<string, number | null>;
  playheadTime: number;
  onTimeChange: (t: number) => void;
  selectedClipId: string | null;
  onSelectClip: (id: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef<number | null>(null);
  /**
   * Every <audio> in the stack, so the play button can start them from inside
   * the click. Browsers only hand an element permission to make sound during a
   * user gesture; an effect that runs a tick later is already too late, and the
   * rejection is silent — which is exactly what "the music doesn't play" looks
   * like.
   */
  const audioEls = useRef(new Map<string, HTMLAudioElement>());
  const [audioBlocked, setAudioBlocked] = useState(false);

  const registerAudio = useCallback((id: string, el: HTMLAudioElement | null) => {
    if (el) audioEls.current.set(id, el);
    else audioEls.current.delete(id);
  }, []);

  const togglePlay = useCallback(() => {
    const next = !playing;
    setPlaying(next);
    if (!next) return;

    setAudioBlocked(false);
    for (const el of audioEls.current.values()) {
      // Silent for this instant; the per-track effect sets the real level and
      // pauses anything the playhead hasn't reached yet.
      el.volume = 0;
      const started = el.play();
      if (started) {
        started.catch((err: unknown) => {
          // Pausing a track that shouldn't be audible yet rejects too — only an
          // outright refusal means the browser is holding the sound back.
          if (err instanceof DOMException && err.name === "NotAllowedError") {
            setAudioBlocked(true);
          }
        });
      }
    }
  }, [playing]);

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

  const visibleLayers = useMemo(
    () =>
      layersInPaintOrder(timeline).filter(
        (l) => playheadTime >= l.startAt && playheadTime < l.startAt + l.duration,
      ),
    [timeline, playheadTime],
  );

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
      <div className="flex aspect-video items-center justify-center border border-[color:var(--hair-dark)] bg-ink-950 bg-hatch">
        <p className="eyebrow-light">No picture yet</p>
      </div>
    );
  }

  const src = activeMedia
    ? active?.clip.kind === "video"
      ? activeMedia.proxyUrl ?? activeMedia.originalUrl
      : activeMedia.originalUrl ?? activeMedia.thumbnailUrl
    : null;

  return (
    <div className="border border-[color:var(--hair-dark)] bg-ink-950">
      {/* Clipped, because FFmpeg crops a layer at the frame edge and the
          preview has to agree — a tall portrait inset otherwise spills out
          over the transport. */}
      <div className="relative aspect-video overflow-hidden bg-black">
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
          <div className="flex h-full items-center justify-center font-mono text-2xs uppercase tracking-label text-ink-500">
            Developing…
          </div>
        )}

        {/* Layers, in the same paint order the renderer uses. */}
        {visibleLayers.map((layer) => (
          <LayerView
            key={layer.id}
            layer={layer}
            media={mediaById.get(layer.mediaItemId) ?? null}
            playheadTime={playheadTime}
            playing={playing}
          />
        ))}

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

      {/* The audio stack. Nothing to look at — it just has to be audible. */}
      {timeline.audio.map((track) => (
        <TrackAudio
          key={track.id}
          track={track}
          src={audioSrcFor(track, mediaById, musicById)}
          span={audioTrackSpan(track, total)}
          playheadTime={playheadTime}
          playing={playing}
          onElement={registerAudio}
        />
      ))}

      {/* Transport */}
      <div className="flex items-center gap-3 border-t border-[color:var(--hair-dark)] bg-ink-900 px-3 py-2">
        <button
          onClick={togglePlay}
          className="shrink-0 border border-[color:var(--hair-dark)] px-2 py-1 font-mono text-[11px] text-paper-100 transition-colors hover:border-paper-200 hover:bg-paper-100 hover:text-ink-900"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "❙❙" : "▶"}
        </button>

        <span className="timecode shrink-0 text-2xs text-ink-300">
          {formatDuration(playheadTime)}
          <span className="mx-1 text-ink-500">/</span>
          {formatDuration(total)}
        </span>

        <input
          type="range"
          min={0}
          max={Math.max(0.1, total)}
          step={0.05}
          value={playheadTime}
          onChange={(e) => seek(Number(e.target.value))}
          className="slider slider-dark flex-1"
          aria-label="Playhead"
        />

        {visibleLayers.length > 0 && (
          <span className="shrink-0 font-mono text-2xs uppercase tracking-label text-tape-400">
            +{visibleLayers.length} layer{visibleLayers.length === 1 ? "" : "s"}
          </span>
        )}

        {active && (
          <button
            onClick={() => onSelectClip(active.clip.id)}
            className="shrink-0 font-mono text-2xs uppercase tracking-label text-ink-400 transition-colors hover:text-paper-100"
          >
            Shot {String(active.index + 1).padStart(2, "0")}
          </button>
        )}
      </div>

      {audioBlocked && (
        <p className="border-t border-[color:var(--hair-dark)] bg-ink-900 px-3 py-2 text-[13px] leading-relaxed text-ink-300">
          Your browser is holding the sound back. Press play once more and it&apos;ll come
          through.
        </p>
      )}
    </div>
  );
}

/**
 * One layer over the picture. Geometry is stored as fractions of the frame, so
 * percentages here land in the same place FFmpeg will put them.
 */
function LayerView({
  layer,
  media,
  playheadTime,
  playing,
}: {
  layer: LayerClip;
  media: MediaItemView | null;
  playheadTime: number;
  playing: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const offset = playheadTime - layer.startAt;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.min(1, layer.volume);
    const target = layer.trimStart + offset;
    if (Math.abs(video.currentTime - target) > 0.35) video.currentTime = Math.max(0, target);
    if (playing && video.paused) void video.play().catch(() => {});
    if (!playing && !video.paused) video.pause();
  }, [offset, playing, layer.trimStart, layer.volume]);

  if (!media) return null;

  // Match the renderer's alpha fades so a layer doesn't pop in the preview and
  // dissolve in the export.
  const fadeIn = Math.min(layer.fadeIn, layer.duration / 2);
  const fadeOut = Math.min(layer.fadeOut, layer.duration / 2);
  const fade =
    fadeIn > 0.01 && offset < fadeIn
      ? offset / fadeIn
      : fadeOut > 0.01 && offset > layer.duration - fadeOut
        ? Math.max(0, (layer.duration - offset) / fadeOut)
        : 1;

  const src = layer.kind === "video" ? media.proxyUrl ?? media.originalUrl : media.originalUrl;
  if (!src) return null;

  const style: React.CSSProperties = {
    left: `${layer.x * 100}%`,
    top: `${layer.y * 100}%`,
    width: `${layer.width * 100}%`,
    opacity: layer.opacity * fade,
  };

  return layer.kind === "video" ? (
    <video
      ref={videoRef}
      key={layer.id}
      src={src}
      style={style}
      className="pointer-events-none absolute"
      playsInline
      muted={layer.muted}
    />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" style={style} className="pointer-events-none absolute" />
  );
}

/**
 * An audio track, kept in step with the playhead — the same clock the picture
 * runs on, so scrubbing, playing and pausing can't drift apart. Fades and
 * looping are mirrored from the renderer so the preview doesn't lie about the
 * mix.
 */
function TrackAudio({
  track,
  src,
  span,
  playheadTime,
  playing,
  onElement,
}: {
  track: AudioTrack;
  src: string | null;
  span: number;
  playheadTime: number;
  playing: boolean;
  onElement: (id: string, el: HTMLAudioElement | null) => void;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  // The file's length only lands once metadata loads, and looping needs it.
  const [metadataSeq, setMetadataSeq] = useState(0);

  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;

    const within =
      span > 0 && playheadTime >= track.startAt && playheadTime < track.startAt + span;
    if (!within || track.muted) {
      audio.volume = 0;
      if (!audio.paused) audio.pause();
      return;
    }

    const elapsed = playheadTime - track.startAt;

    // Same fade shape the filter graph builds, clamped so a long fade on a
    // short track doesn't swallow the whole thing.
    const fadeIn = Math.min(track.fadeIn, span / 2);
    const fadeOut = Math.min(track.fadeOut, span / 2);
    const fade =
      fadeIn > 0.01 && elapsed < fadeIn
        ? elapsed / fadeIn
        : fadeOut > 0.01 && elapsed > span - fadeOut
          ? Math.max(0, (span - elapsed) / fadeOut)
          : 1;
    audio.volume = Math.max(0, Math.min(1, track.volume * fade));

    const fileDuration =
      Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;

    let target = track.offset + elapsed;
    if (fileDuration !== null && target >= fileDuration) {
      if (!track.loop) {
        // The file ran out before the picture did.
        if (!audio.paused) audio.pause();
        return;
      }
      const window = Math.max(0.1, fileDuration - track.offset);
      target = track.offset + ((target - track.offset) % window);
    }

    if (Math.abs(audio.currentTime - target) > 0.35) {
      // Seeking before the media is ready throws in some browsers; the
      // loadedmetadata bump below runs this again.
      try {
        audio.currentTime = Math.max(0, target);
      } catch {
        /* not seekable yet */
      }
    }

    if (playing && audio.paused) void audio.play().catch(() => {});
    if (!playing && !audio.paused) audio.pause();
  }, [
    playheadTime,
    playing,
    span,
    metadataSeq,
    track.muted,
    track.offset,
    track.startAt,
    track.volume,
    track.fadeIn,
    track.fadeOut,
    track.loop,
  ]);

  // Hand the element to the player so the play button can start it from inside
  // the click, and drop it again when the track or its source goes away.
  const id = track.id;
  useEffect(() => {
    const audio = ref.current;
    onElement(id, audio);
    return () => onElement(id, null);
  }, [id, src, onElement]);

  if (!src) return null;
  return (
    <audio
      ref={ref}
      src={src}
      preload="auto"
      className="hidden"
      onLoadedMetadata={() => setMetadataSeq((n) => n + 1)}
    />
  );
}

function audioSrcFor(
  track: AudioTrack,
  mediaById: Map<string, MediaItemView>,
  musicById: Map<string, MusicItemView>,
): string | null {
  if (track.mediaItemId) return mediaById.get(track.mediaItemId)?.originalUrl ?? null;
  if (track.musicItemId) return musicById.get(track.musicItemId)?.audioUrl ?? null;
  return null;
}
