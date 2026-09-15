"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FORMAT_LABELS,
  FORMAT_RATIOS,
  LOOK_CSS,
  audioTrackSpan,
  clipSpeed,
  clipStartTimes,
  formatDuration,
  layersInPaintOrder,
  normalizeRotation,
  previewFrame,
  resolveFit,
  rotatedDimensions,
  timelineDuration,
  frameAspectCss,
  type AudioTrack,
  type LayerClip,
  type TimelineDoc,
  type TimelineOp,
  type TitleOverlay,
  type VideoFormat,
} from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import { previewSrc } from "@/lib/preview-src";
import { RotatedMedia } from "@/lib/rotated-media";
import { SNAP_TOLERANCE_PX } from "@/lib/snap";
import { cn } from "@/lib/cn";

/** Fractions live in the document at 3dp, here as everywhere else. */
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** The lane magnets of `makeSnap`, in a plane instead of along a clock. */
function snapTo(value: number, magnets: number[], tolerance: number): number {
  for (const magnet of magnets) {
    if (Math.abs(magnet - value) <= tolerance) return magnet;
  }
  return value;
}

/**
 * Where a title's box sits in the frame, as a fraction. The renderer puts the
 * top of the text at 8% and its bottom at 88% (see `titleFilters` in
 * render.ts); the middles below are what the hand aims at when dragging, so
 * the three anchors are spread far enough apart to pick between.
 */
const TITLE_ANCHORS: { position: TitleOverlay["position"]; at: number }[] = [
  { position: "top", at: 0.12 },
  { position: "center", at: 0.5 },
  { position: "bottom", at: 0.86 },
];

/**
 * The transport, as something another panel can drive.
 *
 * Auditioning a trim is the same playback as the play button — same clock, same
 * audio stack, same picture — only it stops at the out point instead of at the
 * end of the film. That makes it a mode of the one transport rather than a
 * second player, which is the only way the two can't contradict each other.
 *
 * The object handed out is stable for the life of the player and forwards to
 * whatever the current render closed over, so a panel may hold on to it and
 * subscribe to it without being re-subscribed on every state change.
 */
export interface PreviewTransport {
  /** Play `start`→`end` in film seconds, then stop — or go round again. */
  playRange(start: number, end: number, opts?: { loop?: boolean }): void;
  /** Stop the transport, range or not. */
  stop(): void;
  /**
   * Shuttle: run the clock at `rate` — negative for backwards, 0 to pause.
   * Anything but 1× is a scrub rather than playback, so the picture steps and
   * nothing makes a sound; reverse audio isn't a thing a browser will do, and a
   * silent shuttle is the behaviour every cutting room already has.
   */
  setRate(rate: number): void;
  /** Told whenever the transport starts or stops, so a button can follow it. */
  subscribe(listener: (state: { playing: boolean; ranged: boolean }) => void): () => void;
}

function nearestTitlePosition(fraction: number): TitleOverlay["position"] {
  let best = TITLE_ANCHORS[0];
  for (const anchor of TITLE_ANCHORS) {
    if (Math.abs(anchor.at - fraction) < Math.abs(best.at - fraction)) best = anchor;
  }
  return best.position;
}

/**
 * Preview of the assembled cut. Plays the low-res proxies clip by clip, holds
 * photos for their duration, stacks the layers over the top and runs the audio
 * stack underneath — close enough to judge pacing and placement without
 * rendering anything. The real output comes from FFmpeg server-side.
 */
export function PreviewPlayer({
  timeline,
  format,
  mediaById,
  musicById,
  durations,
  playheadTime,
  onTimeChange,
  selectedClipId,
  onSelectClip,
  selectedLayerId = null,
  onSelectLayer,
  onDispatch,
  togglePlayRef,
  playRangeRef,
  heightCap = "72vh",
  toolbar,
}: {
  timeline: TimelineDoc;
  /** The shape the lab will print in — the picture box matches it exactly. */
  format: VideoFormat;
  mediaById: Map<string, MediaItemView>;
  musicById: Map<string, MusicItemView>;
  durations: Record<string, number | null>;
  playheadTime: number;
  onTimeChange: (t: number) => void;
  selectedClipId: string | null;
  onSelectClip: (id: string) => void;
  /** Which layer the inspector is showing, so the picture can ring it. */
  selectedLayerId?: string | null;
  onSelectLayer?: (id: string) => void;
  /**
   * Direct manipulation is editing, so the picture needs the same door into
   * the reducer the strip has. Left out — on a read-only preview — the frame
   * is simply a picture and nothing in it can be grabbed.
   */
  onDispatch?: (op: TimelineOp) => void;
  /**
   * A hole the bench's Space key reaches through. Transport state lives in
   * here — starting playback has to happen inside the user's gesture so the
   * audio stack is allowed to make sound — so the keyboard borrows the same
   * toggle the play button calls rather than lifting `playing` up a level.
   */
  togglePlayRef?: React.MutableRefObject<(() => void) | null>;
  /**
   * The same hole, widened: the inspectors audition a trim through this rather
   * than playing a copy of the footage of their own, so what you hear while you
   * cut is the mix the film actually has.
   */
  playRangeRef?: React.MutableRefObject<PreviewTransport | null>;
  /**
   * The tallest the picture may be, as a CSS length. The bench runs a fixed
   * viewport and has to keep the strip on screen under the picture, so it hands
   * down a much smaller cap than a page that can simply scroll.
   */
  heightCap?: string;
  /** A slim row above the picture — where the bench keeps its few buttons. */
  toolbar?: React.ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  /** The blurred copy behind the picture, when the shot is fitted that way. */
  const backdropRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef<number | null>(null);
  /**
   * The clock, as an anchor rather than an accumulator.
   *
   * This used to add a delta to `playheadTime` each frame, which meant the
   * playback effect had to depend on `playheadTime` — so it tore itself down
   * and re-read `performance.now()` on every single frame, and every gap
   * between the frame firing and React committing was time the clock simply
   * never counted. The picture element has no such problem: it plays at wall
   * clock. The two drifted apart at a steady rate until the sync below gave up
   * and yanked the video backwards, over and over.
   *
   * Anchoring to a wall-clock instant instead makes the playhead a pure
   * function of elapsed real time, so it cannot lose time and cannot drift.
   */
  const clockRef = useRef({ wall: 0, time: 0 });

  const reanchor = useCallback((time: number) => {
    clockRef.current = { wall: performance.now(), time };
  }, []);
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

  /**
   * The stretch being auditioned, when the transport is playing one rather than
   * the film. Null is the ordinary case: play to the end and stop there.
   */
  const [range, setRange] = useState<{ start: number; end: number; loop: boolean } | null>(null);

  /**
   * How fast the clock runs, and which way. 1 is playback; anything else is the
   * shuttle, and every media element is held paused and seeked frame by frame
   * instead — see `PreviewTransport.setRate`.
   */
  const [rate, setRate] = useState(1);

  /**
   * Whether the media elements are *playing* rather than being stepped. Only
   * true playback rolls them: a shuttle drives `currentTime` frame by frame, so
   * the picture still moves (in either direction) without asking a <video> to
   * do something it can't.
   */
  const rolling = playing && rate === 1;

  const startAudioStack = useCallback(() => {
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
  }, []);

  const togglePlay = useCallback(() => {
    const next = !playing;
    setPlaying(next);
    // The transport is the whole film again: pressing play (or pause) during an
    // audition — or during a shuttle — is how you get out of one.
    setRange(null);
    setRate(1);
    if (!next) return;

    reanchor(playheadTime);
    startAudioStack();
  }, [playing, playheadTime, reanchor, startAudioStack]);

  // Hand the current toggle out to whoever holds the ref — it closes over
  // `playing`, so it has to be re-published every time that changes.
  useEffect(() => {
    if (!togglePlayRef) return;
    togglePlayRef.current = togglePlay;
    return () => {
      togglePlayRef.current = null;
    };
  }, [togglePlayRef, togglePlay]);

  const total = useMemo(() => timelineDuration(timeline, durations), [timeline, durations]);
  const starts = useMemo(() => clipStartTimes(timeline, durations), [timeline, durations]);

  const playRange = useCallback(
    (start: number, end: number, opts?: { loop?: boolean }) => {
      const from = Math.max(0, Math.min(total, start));
      // A window with no width would stop on the frame it started on, which
      // reads as a button that does nothing.
      const to = Math.max(from + 0.05, Math.min(total, end));
      setRange({ start: from, end: to, loop: Boolean(opts?.loop) });
      setRate(1);
      reanchor(from);
      onTimeChange(from);
      setPlaying(true);
      // Still inside the click that asked for it, so the sound is allowed.
      startAudioStack();
    },
    [total, reanchor, onTimeChange, startAudioStack],
  );

  const stopTransport = useCallback(() => {
    setPlaying(false);
    setRange(null);
    setRate(1);
  }, []);

  /**
   * J/K/L, as one call. A rate of 0 is K — park the clock where it is; anything
   * else runs the shuttle from the playhead, out of whatever it was doing.
   */
  const shuttle = useCallback(
    (next: number) => {
      setRange(null);
      if (next === 0) {
        setPlaying(false);
        setRate(1);
        return;
      }
      setRate(next);
      reanchor(playheadTime);
      setPlaying(true);
      // 1× forward is ordinary playback, and it's the only shuttle speed that
      // has sound to start — still inside the keystroke, so it's allowed to.
      if (next === 1) startAudioStack();
    },
    [playheadTime, reanchor, startAudioStack],
  );

  /**
   * The two above, held where the published handle can reach the current pair
   * without the handle itself having to change identity.
   */
  const transportImpl = useRef({ playRange, stop: stopTransport, shuttle });
  useEffect(() => {
    transportImpl.current = { playRange, stop: stopTransport, shuttle };
  }, [playRange, stopTransport, shuttle]);

  const transportListeners = useRef(
    new Set<(state: { playing: boolean; ranged: boolean }) => void>(),
  );
  useEffect(() => {
    const state = { playing, ranged: range !== null };
    for (const listener of transportListeners.current) listener(state);
  }, [playing, range]);

  /**
   * Published during render, not from an effect.
   *
   * React runs a child's effects before its parent's and siblings' in render
   * order, so an inspector mounted above this one would subscribe to a ref that
   * is still null and never hear anything again — the same trap `useVlogSocket`
   * documents. The handle is stable and forwards through the ref above, so
   * handing it over early costs nothing and can't go stale.
   */
  const transportHandle = useRef<PreviewTransport | null>(null);
  if (!transportHandle.current) {
    transportHandle.current = {
      playRange: (start, end, opts) => transportImpl.current.playRange(start, end, opts),
      stop: () => transportImpl.current.stop(),
      setRate: (next) => transportImpl.current.shuttle(next),
      subscribe: (listener) => {
        const listeners = transportListeners.current;
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }
  if (playRangeRef) playRangeRef.current = transportHandle.current;

  useEffect(() => {
    if (!playRangeRef) return;
    return () => {
      playRangeRef.current = null;
    };
  }, [playRangeRef]);

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

  /**
   * The shot's own playback speed, and where that puts us in the file: the
   * playhead is in film seconds, the element's clock is in source seconds.
   *
   * `lookCss` is the browser's stand-in for the render's `LOOK_FILTERS` — an
   * approximation, and knowingly so. CSS has no curves and its sepia is not a
   * colour balance, so the preview is close enough to choose a look by and the
   * print is the one that counts.
   */
  const activeRate = active ? clipSpeed(active.clip) : 1;
  const activeSourceTime = active ? active.clip.trimStart + active.offset * activeRate : 0;
  const activeLookCss = (active && LOOK_CSS[active.clip.look]) || undefined;

  const visibleLayers = useMemo(
    () =>
      layersInPaintOrder(timeline).filter(
        (l) => playheadTime >= l.startAt && playheadTime < l.startAt + l.duration,
      ),
    [timeline, playheadTime],
  );

  /**
   * The picture box itself — the frame, exactly the rectangle the document's
   * fractions are fractions of. Every pointer number below is measured against
   * this rect and nothing else, which is what makes a layer dragged here land
   * where `layerPass` in render.ts puts it: same origin (top-left), same
   * fractions, only the multiplier differs.
   */
  const frameRef = useRef<HTMLDivElement>(null);

  /**
   * What the hand is doing right now, shown locally and never written until
   * the pointer is lifted — the same ghost the strip's drags use. A
   * `layer.update` per pointermove would put a revision (and a broadcast) on
   * the wire sixty times a second.
   */
  const [layerGhost, setLayerGhost] = useState<{
    id: string;
    x: number;
    y: number;
    width: number;
  } | null>(null);
  const [titleGhost, setTitleGhost] = useState<{
    id: string;
    position: TitleOverlay["position"];
  } | null>(null);

  /** Grabbing only makes sense on a held frame; playing, the picture is a picture. */
  const editable = Boolean(onDispatch) && !playing;

  const startLayerDrag = useCallback(
    (
      event: React.PointerEvent,
      layer: LayerClip,
      mode: "move" | "resize",
      boxRect: DOMRect,
    ) => {
      const frame = frameRef.current?.getBoundingClientRect();
      if (!frame || !onDispatch || frame.width < 1 || frame.height < 1) return;

      event.preventDefault();
      event.stopPropagation();
      const grabbed = event.currentTarget as HTMLElement;
      grabbed.setPointerCapture?.(event.pointerId);

      const originX = event.clientX;
      const originY = event.clientY;
      /** The box's own proportions, so the height a width implies is known. */
      const aspect = boxRect.width > 0 ? boxRect.height / boxRect.width : 1;
      const tolX = SNAP_TOLERANCE_PX / frame.width;
      const tolY = SNAP_TOLERANCE_PX / frame.height;

      let next = { id: layer.id, x: layer.x, y: layer.y, width: layer.width };

      const onMove = (e: PointerEvent) => {
        if (mode === "move") {
          const heightFraction = (layer.width * frame.width * aspect) / frame.height;
          const x = layer.x + (e.clientX - originX) / frame.width;
          const y = layer.y + (e.clientY - originY) / frame.height;
          next = {
            ...next,
            // Edges and centre — the three places a hand is usually aiming for.
            x: round3(clamp01(snapTo(x, [0, 0.5 - layer.width / 2, 1 - layer.width], tolX))),
            y: round3(clamp01(snapTo(y, [0, 0.5 - heightFraction / 2, 1 - heightFraction], tolY))),
          };
        } else {
          const width = layer.width + (e.clientX - originX) / frame.width;
          next = { ...next, width: round3(Math.min(1, Math.max(0.05, width))) };
        }
        setLayerGhost(next);
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        setLayerGhost(null);

        const patch =
          mode === "move"
            ? { x: next.x, y: next.y }
            : { width: next.width };
        const moved =
          mode === "move"
            ? next.x !== layer.x || next.y !== layer.y
            : next.width !== layer.width;
        if (moved) onDispatch({ type: "layer.update", layerId: layer.id, patch });
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [onDispatch],
  );

  const startTitleDrag = useCallback(
    (event: React.PointerEvent, clipId: string, title: TitleOverlay) => {
      const frame = frameRef.current?.getBoundingClientRect();
      if (!frame || !onDispatch || frame.height < 1) return;

      event.preventDefault();
      event.stopPropagation();
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);

      let position = title.position;

      const onMove = (e: PointerEvent) => {
        // Only three places exist in the schema, so the drag is a pick between
        // them rather than a free position — it follows the finger to the
        // nearest one and shows that.
        position = nearestTitlePosition((e.clientY - frame.top) / frame.height);
        setTitleGhost({ id: title.id, position });
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        setTitleGhost(null);
        if (position !== title.position) {
          onDispatch({ type: "title.update", clipId, titleId: title.id, patch: { position } });
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [onDispatch],
  );

  /** Which title is being typed into, if any. */
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);

  /**
   * Drive playback. Note what this effect deliberately does NOT depend on: the
   * playhead. It reads elapsed wall time off the anchor and writes the result
   * out, so it mounts once per play and survives every frame it causes.
   */
  useEffect(() => {
    if (!playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    // An audition stops at its out point; everything else stops at the end.
    const limit = range ? range.end : total;

    const tick = (now: number) => {
      const { wall, time } = clockRef.current;
      const next = time + ((now - wall) / 1000) * rate;

      // Running backwards, the wall the clock hits is the near end: the start
      // of the audition, or the top of the film. There's nothing to loop.
      if (rate < 0) {
        const floor = range ? range.start : 0;
        if (next <= floor) {
          onTimeChange(floor);
          setPlaying(false);
          setRange(null);
          setRate(1);
          return;
        }
        onTimeChange(next);
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      if (next >= limit) {
        if (range?.loop) {
          // Round again from the in point, re-anchoring on this very frame so
          // the lap doesn't inherit the overshoot of the last one.
          clockRef.current = { wall: now, time: range.start };
          onTimeChange(range.start);
          rafRef.current = requestAnimationFrame(tick);
          return;
        }
        onTimeChange(limit);
        setPlaying(false);
        setRange(null);
        setRate(1);
        return;
      }
      onTimeChange(next);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, total, range, rate, onTimeChange]);

  /**
   * Re-anchor when the playhead moves for a reason other than time passing —
   * the transport's scrub bar, a click on the ruler, picking a shot. Without
   * this the clock would keep counting from wherever it was and drag the
   * playhead straight back.
   *
   * A frame's worth of difference is the clock doing its job, so the threshold
   * only has to be wider than one frame and narrower than a deliberate move.
   */
  useEffect(() => {
    const { wall, time } = clockRef.current;
    const predicted = playing ? time + ((performance.now() - wall) / 1000) * rate : time;
    if (!playing || Math.abs(playheadTime - predicted) > 0.25) reanchor(playheadTime);
  }, [playheadTime, playing, rate, reanchor]);

  // Keep the <video> in sync with the playhead — and the blurred copy behind
  // it, which is the same footage and would otherwise drift out of step with
  // its own foreground.
  useEffect(() => {
    if (!active || active.clip.kind !== "video") return;

    for (const el of [videoRef.current, backdropRef.current]) {
      if (!el) continue;
      syncMediaTime(el, activeSourceTime, rolling, activeRate);

      if (rolling && el.paused) void el.play().catch(() => {});
      if (!rolling && !el.paused) el.pause();
    }
  }, [active, rolling, activeSourceTime, activeRate]);

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
      const next = Math.max(0, Math.min(total, t));
      reanchor(next);
      onTimeChange(next);
    },
    [onTimeChange, total, reanchor],
  );

  /**
   * An upright film is nearly twice as tall as it is wide, and the bench's
   * picture column is wider than it is tall — left alone, the preview would run
   * off the bottom of the screen and take the strip with it. Capping the
   * player's *width* by the height it would need keeps the frame's real shape
   * (no letterboxing the preview itself) and never binds in widescreen, where
   * the cap works out to more screen than anybody has.
   */
  const shape = previewFrame(format);
  const maxWidth = `calc(${heightCap} * ${shape.width} / ${shape.height})`;

  /**
   * The same question the renderer asks, answered the same way — the whole
   * point of the preview is that a shot framed here is framed there.
   */
  const fit = resolveFit({
    clipWidth: activeMedia?.width,
    clipHeight: activeMedia?.height,
    clipRotation: activeMedia?.rotation,
    frameWidth: shape.width,
    frameHeight: shape.height,
    fit: active?.clip.fit ?? "auto",
    policy: timeline.director.fitPolicy,
  });

  if (timeline.clips.length === 0) {
    return (
      <div className="mx-auto w-full" style={{ maxWidth }}>
        {toolbar}
        <div
          className="flex w-full items-center justify-center border border-[color:var(--hair-dark)] bg-ink-950 bg-hatch"
          style={{ aspectRatio: frameAspectCss(format) }}
        >
          <p className="eyebrow-light">No picture yet</p>
        </div>
      </div>
    );
  }

  const src = activeMedia ? previewSrc(activeMedia) : null;

  return (
    <div className="mx-auto w-full" style={{ maxWidth }}>
      {toolbar}
      <div className="border border-[color:var(--hair-dark)] bg-ink-950">
      {/* Clipped, because FFmpeg crops a layer at the frame edge and the
          preview has to agree — a tall portrait inset otherwise spills out
          over the transport. */}
      <div
        ref={frameRef}
        className="relative overflow-hidden bg-black"
        /*
         * `container-type: size` is what makes the title sizes below mean
         * anything: they're a fraction of the frame in `cqh`, and without a
         * query container that resolves against the viewport instead of the
         * picture.
         */
        style={{ aspectRatio: frameAspectCss(format), containerType: "size" }}
      >
        {/*
          The blurred backdrop, when that's how this shot fills the frame: a
          second copy of the very same source, blown up past the edges and
          thrown out of focus, with the whole shot sitting sharp on top. CSS
          blur and gblur aren't the same maths, and they don't need to be —
          what has to match is where the picture sits and what surrounds it.

          Absolutely positioned, so the picture above needs `relative` to keep
          painting over it.
        */}
        {src && fit === "blur" && (
          <RotatedMedia rotation={activeMedia?.rotation} className="absolute inset-0">
            {active?.clip.kind === "video" ? (
              <video
                ref={backdropRef}
                key={`backdrop-${active.clip.id}`}
                src={src}
                aria-hidden
                className="h-full w-full scale-110 object-cover blur-2xl"
                /* Inline `filter` wins outright over the class's blur, so the
                   blur has to be spelled out again alongside the look. */
                style={activeLookCss ? { filter: `${activeLookCss} blur(40px)` } : undefined}
                playsInline
                muted
                onLoadedMetadata={(e) =>
                  syncMediaTime(e.currentTarget, activeSourceTime, false, activeRate)
                }
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt=""
                aria-hidden
                className="h-full w-full scale-110 object-cover blur-2xl"
                style={activeLookCss ? { filter: `${activeLookCss} blur(40px)` } : undefined}
              />
            )}
          </RotatedMedia>
        )}

        {src ? (
          <RotatedMedia rotation={activeMedia?.rotation} className="relative">
            {active?.clip.kind === "video" ? (
              <video
                ref={videoRef}
                key={active.clip.id}
                src={src}
                className={cn(
                  "h-full w-full",
                  fit === "fill" ? "object-cover" : "object-contain",
                )}
                style={{ filter: activeLookCss }}
                playsInline
                muted={active.clip.muted}
                /*
                 * A clip change remounts this element (see `key`) at zero, and
                 * the sync effect can only correct it a frame later — long enough
                 * to show the head of the file before the trim point. Landing it
                 * as soon as the metadata arrives means the first frame drawn is
                 * already the right one.
                 */
                onLoadedMetadata={(e) =>
                  syncMediaTime(e.currentTarget, activeSourceTime, false, activeRate)
                }
                onEnded={() => {
                  // Roll into the next clip.
                  const next = timeline.clips[active.index + 1];
                  if (next) seek(starts[next.id] ?? playheadTime);
                  else setPlaying(false);
                }}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt=""
                className={cn(
                  "h-full w-full",
                  fit === "fill" ? "object-cover" : "object-contain",
                )}
                style={{ filter: activeLookCss }}
              />
            )}
          </RotatedMedia>
        ) : (
          <div className="flex h-full items-center justify-center font-mono text-2xs uppercase tracking-label text-ink-400">
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
            playing={rolling}
            editable={editable}
            selected={layer.id === selectedLayerId}
            ghost={layerGhost && layerGhost.id === layer.id ? layerGhost : null}
            onSelect={onSelectLayer}
            onGrab={startLayerDrag}
          />
        ))}

        {/* Title overlays, positioned as they'll appear in the render. */}
        {active &&
          active.clip.titles
            .filter(
              (t) => active.offset >= t.start && active.offset <= t.start + t.duration,
            )
            .map((title) => {
              const position =
                titleGhost && titleGhost.id === title.id ? titleGhost.position : title.position;
              const editing = editingTitleId === title.id;
              const clipId = active.clip.id;

              return (
                <div
                  key={title.id}
                  className={cn(
                    "absolute inset-x-0 flex justify-center px-8",
                    editable ? "pointer-events-auto" : "pointer-events-none",
                    position === "top" && "top-[8%]",
                    position === "center" && "top-1/2 -translate-y-1/2",
                    // The renderer lands the *bottom* of the text at 88% of the
                    // frame, so the preview has to as well — 8% up from the
                    // bottom edge was a title sitting lower here than there.
                    position === "bottom" && "bottom-[12%]",
                  )}
                >
                  <span
                    className={cn(
                      "text-center font-bold drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]",
                      editable && !editing && "cursor-grab touch-none active:cursor-grabbing",
                      editing && "cursor-text outline-dashed outline-2 outline-offset-4 outline-tape-400",
                    )}
                    style={{
                      color: title.color,
                      /*
                       * Title sizes are drawtext pixels, so they only mean
                       * something against a frame height — which is now the
                       * vlog's shape, not a fixed 1080. Still nominal: the
                       * preview has never known the operator's resolution, and
                       * doesn't need to, because the fraction is the same at
                       * every size.
                       */
                      fontSize: `${(title.fontSize / previewFrame(format).height) * 100}cqh`,
                    }}
                    contentEditable={editing}
                    suppressContentEditableWarning
                    onPointerDown={(e) => {
                      if (!editable || editing) return;
                      // A title belongs to a shot; grabbing one is a way of
                      // reaching that shot's inspector.
                      onSelectClip(clipId);
                      startTitleDrag(e, clipId, title);
                    }}
                    onDoubleClick={() => {
                      if (!editable) return;
                      setEditingTitleId(title.id);
                    }}
                    onBlur={(e) => {
                      if (!editing) return;
                      setEditingTitleId(null);
                      const text = (e.currentTarget.textContent ?? "").slice(0, 200);
                      if (text !== title.text) {
                        onDispatch?.({
                          type: "title.update",
                          clipId,
                          titleId: title.id,
                          patch: { text },
                        });
                      }
                    }}
                    onKeyDown={(e) => {
                      if (!editing) return;
                      if (e.key === "Enter") {
                        e.preventDefault();
                        e.currentTarget.blur();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        // Put the stored text back before the blur handler
                        // reads it, so Escape really does abandon the edit.
                        e.currentTarget.textContent = title.text;
                        e.currentTarget.blur();
                      }
                      // The bench binds single keys; typing mustn't trip them.
                      e.stopPropagation();
                    }}
                    ref={(el) => {
                      if (editing && el && document.activeElement !== el) {
                        el.textContent = title.text;
                        el.focus();
                        const range = document.createRange();
                        range.selectNodeContents(el);
                        window.getSelection()?.removeAllRanges();
                        window.getSelection()?.addRange(range);
                      }
                    }}
                  >
                    {/* While it's being typed into, the DOM text is the
                        user's; React owning it would wipe a keystroke on the
                        next render. The ref above seeds it. */}
                    {editing ? null : title.text}
                  </span>
                </div>
              );
            })}
      </div>

      {/* The audio stack. Nothing to look at — it just has to be audible. */}
      {timeline.audio.map((track) => (
        <TrackAudio
          key={track.id}
          track={track}
          src={audioSrcFor(track, mediaById, musicById)}
          span={audioTrackSpan(track, total)}
          playheadTime={playheadTime}
          playing={rolling}
          onElement={registerAudio}
        />
      ))}

      {/* Transport */}
      <div className="flex items-center gap-2 border-t border-[color:var(--hair-dark)] bg-ink-900 px-2 py-2 sm:gap-3 sm:px-3">
        <button
          onClick={togglePlay}
          className="shrink-0 border border-[color:var(--hair-dark)] px-2 py-1 font-mono text-[11px] text-paper-100 transition-colors hover:border-paper-200 hover:bg-paper-100 hover:text-ink-900"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "❙❙" : "▶"}
        </button>

        <span className="timecode shrink-0 text-2xs text-ink-300">
          {formatDuration(playheadTime)}
          <span className="mx-1 text-ink-400">/</span>
          {formatDuration(total)}
        </span>

        {/* What shape everyone is cutting for, said out loud next to the clock.
            Read-only — the Film tab is where it changes. */}
        <span
          className="hidden shrink-0 font-mono text-2xs uppercase tracking-label text-ink-400 sm:block"
          title={`This film prints ${FORMAT_LABELS[format].toLowerCase()}`}
        >
          {FORMAT_RATIOS[format]} · {FORMAT_LABELS[format]}
        </span>

        <input
          type="range"
          min={0}
          max={Math.max(0.1, total)}
          step={0.05}
          value={playheadTime}
          onChange={(e) => seek(Number(e.target.value))}
          className="slider slider-dark w-full min-w-0 flex-1"
          aria-label="Playhead"
        />

        {visibleLayers.length > 0 ? (
          <span className="shrink-0 font-mono text-2xs uppercase tracking-label text-tape-400">
            +{visibleLayers.length} layer{visibleLayers.length === 1 ? "" : "s"}
          </span>
        ) : (
          timeline.layers.length > 0 && (
            <span className="hidden shrink-0 font-mono text-2xs uppercase tracking-label text-ink-400 sm:block">
              {timeline.layers.length} layer{timeline.layers.length === 1 ? "" : "s"}
            </span>
          )
        )}

        {active && (
          <button
            onClick={() => onSelectClip(active.clip.id)}
            className="hidden shrink-0 font-mono text-2xs uppercase tracking-label text-ink-400 transition-colors hover:text-paper-100 sm:block"
          >
            Shot {String(active.index + 1).padStart(2, "0")}
            <span className="text-ink-500">/{timeline.clips.length}</span>
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
    </div>
  );
}

/**
 * Put a media element where the playhead says it should be.
 *
 * The preview runs one clock and slaves every element to it, so in steady
 * playback they can only disagree by decode jitter — but hard-seeking on every
 * disagreement is precisely the stutter this is meant to avoid, and a seek
 * mid-playback is the most visible thing a video element can do. So a small
 * drift is absorbed by running the element fractionally fast or slow, which is
 * imperceptible in both picture and sound, and only a genuine desync — a clip
 * change, a scrub, a stalled fetch — is worth the jump.
 *
 * Paused is the other way round: nothing is drifting, the playhead is being
 * dragged, and the only thing that matters is landing on the right frame.
 */
const DRIFT_IGNORE = 0.08;
const DRIFT_SEEK = 0.5;

/**
 * `rate` is the shot's own speed — the drift correction below is a *trim* on
 * top of it, never a replacement, or a ramped shot would snap back to 1× every
 * time the clock nudged it.
 */
function syncMediaTime(el: HTMLMediaElement, target: number, playing: boolean, rate = 1) {
  const safe = Math.max(0, target);
  const drift = safe - el.currentTime;

  if (!playing) {
    el.playbackRate = rate;
    if (Math.abs(drift) > 0.05) trySeek(el, safe);
    return;
  }

  if (Math.abs(drift) > DRIFT_SEEK) {
    el.playbackRate = rate;
    trySeek(el, safe);
    return;
  }

  // Behind the clock speeds up, ahead of it slows down. Capped at 8%, which is
  // under the threshold where a voice starts to sound wrong.
  el.playbackRate =
    rate *
    (Math.abs(drift) <= DRIFT_IGNORE ? 1 : Math.max(0.92, Math.min(1.08, 1 + drift * 0.5)));
}

function trySeek(el: HTMLMediaElement, time: number) {
  try {
    el.currentTime = time;
  } catch {
    // Seeking before the media is ready throws in some browsers; whatever
    // re-runs this on `loadedmetadata` will land it.
  }
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
  editable,
  selected,
  ghost,
  onSelect,
  onGrab,
}: {
  layer: LayerClip;
  media: MediaItemView | null;
  playheadTime: number;
  playing: boolean;
  /** Whether this layer can be grabbed — held frame, editable bench. */
  editable: boolean;
  selected: boolean;
  /** Where the hand has it right now, if it's being dragged. */
  ghost: { x: number; y: number; width: number } | null;
  onSelect?: (id: string) => void;
  onGrab?: (
    event: React.PointerEvent,
    layer: LayerClip,
    mode: "move" | "resize",
    boxRect: DOMRect,
  ) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const offset = playheadTime - layer.startAt;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.min(1, layer.volume);
    syncMediaTime(video, layer.trimStart + offset, playing);
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

  const src = previewSrc(media);
  if (!src) return null;

  /**
   * The renderer straightens a layer before it scales it to the declared
   * width, so the height that follows is the rotated one. Saying that in CSS
   * needs the box's proportions stated outright — and they can only be known
   * once the probe has landed, which is why an unmeasured file is left alone
   * here rather than given a box with no height at all.
   */
  const turned = normalizeRotation(media.rotation) !== 0 && Boolean(media.width && media.height);
  const box = rotatedDimensions(media.width, media.height, media.rotation);

  // While a drag is in flight the hand's numbers win; nothing is written to
  // the document until the pointer comes up.
  const geometry = ghost ?? layer;

  /**
   * The frame's own box. Left/top/width are the document's fractions applied
   * to the frame straight — the same arithmetic as `layerPass`, which does
   * `round(layer.x * width)` from the same top-left origin — and the height
   * follows the media, exactly as the renderer's scale does.
   */
  const wrapperStyle: React.CSSProperties = {
    left: `${geometry.x * 100}%`,
    top: `${geometry.y * 100}%`,
    width: `${geometry.width * 100}%`,
  };

  // The fade belongs to the picture, not to the ring around it — a layer
  // dragged during its own fade-in would otherwise have an invisible handle.
  const style: React.CSSProperties = {
    opacity: layer.opacity * fade,
    ...(turned ? { height: "auto", aspectRatio: `${box.width} / ${box.height}` } : null),
  };

  const grab = (mode: "move" | "resize") => (event: React.PointerEvent) => {
    if (!editable) return;
    onSelect?.(layer.id);
    const rect = boxRef.current?.getBoundingClientRect();
    if (rect) onGrab?.(event, layer, mode, rect);
  };

  return (
    <div
      ref={boxRef}
      className={cn(
        "absolute h-auto",
        editable
          ? "pointer-events-auto cursor-move touch-none"
          : "pointer-events-none",
        editable && !selected && "hover:outline hover:outline-1 hover:outline-paper-100/40",
        selected && editable && "outline outline-1 outline-tape-400",
      )}
      style={wrapperStyle}
      onPointerDown={grab("move")}
    >
      <RotatedMedia
      rotation={turned ? media.rotation : 0}
      className="pointer-events-none relative h-auto w-auto"
      style={style}
    >
      {layer.kind === "video" ? (
        <video
          ref={videoRef}
          key={layer.id}
          src={src}
          className="h-full w-full"
          playsInline
          muted={layer.muted}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full" />
      )}
      </RotatedMedia>

      {/* The corner grip. Only the selected layer wears one, so a frame full
          of insets isn't a frame full of handles. */}
      {selected && editable && (
        <div
          role="slider"
          aria-label="Layer size"
          aria-valuenow={Math.round(geometry.width * 100)}
          aria-valuemin={5}
          aria-valuemax={100}
          tabIndex={-1}
          onPointerDown={grab("resize")}
          className="absolute -bottom-1.5 -right-1.5 h-4 w-4 cursor-nwse-resize touch-none border border-ink-900 bg-tape-400"
        />
      )}
    </div>
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

    syncMediaTime(audio, target, playing);

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

/** Which file a track actually plays — an upload wins over a link, as in the render. */
export function audioSrcFor(
  track: AudioTrack,
  mediaById: Map<string, MediaItemView>,
  musicById: Map<string, MusicItemView>,
): string | null {
  if (track.mediaItemId) return mediaById.get(track.mediaItemId)?.originalUrl ?? null;
  if (track.musicItemId) return musicById.get(track.musicItemId)?.audioUrl ?? null;
  return null;
}
