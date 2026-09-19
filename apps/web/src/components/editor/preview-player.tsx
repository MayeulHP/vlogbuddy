"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MOTION_ZOOM,
  TRANSITION_EFFECT,
  audioTrackSpan,
  clipDuration,
  clipSpeed,
  clipStartTimes,
  formatDuration,
  frameAspectCss,
  isGraded,
  layersInPaintOrder,
  movesFrame,
  overlapsPrevious,
  previewFrame,
  transitionOverlap,
  timelineDuration,
  type AudioTrack,
  type Clip,
  type LayerClip,
  type TimelineDoc,
  type TransitionEffect,
  type VideoFormat,
} from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import { cn } from "@/lib/cn";

/**
 * Preview of the assembled cut. Plays the low-res proxies clip by clip, holds
 * photos for their duration, stacks the layers over the top and runs the audio
 * stack underneath — close enough to judge pacing and placement without
 * rendering anything. The real output comes from FFmpeg server-side.
 */

/**
 * The grade, as far as CSS can carry it.
 *
 * An approximation on purpose, and the two places it bends: FFmpeg's `eq`
 * brightness is *added* to each sample where the CSS filter multiplies, and
 * `gblur`'s sigma is in render pixels where the preview box is whatever width
 * the browser gave it. Close enough to judge a look by; the render is the
 * authority, as it is for the transitions below.
 */
function gradeStyle(clip: Clip): string | undefined {
  if (!isGraded(clip)) return undefined;
  const parts: string[] = [];
  if (clip.brightness !== 0) parts.push(`brightness(${(1 + clip.brightness).toFixed(3)})`);
  if (clip.contrast !== 1) parts.push(`contrast(${clip.contrast.toFixed(3)})`);
  if (clip.saturation !== 1) parts.push(`saturate(${clip.saturation.toFixed(3)})`);
  if (clip.hue !== 0) parts.push(`hue-rotate(${clip.hue.toFixed(1)}deg)`);
  if (clip.blur > 0) parts.push(`blur(${(clip.blur / 3).toFixed(2)}px)`);
  return parts.join(" ");
}

/** Where the Ken Burns move has got to, as a scale factor. */
function motionScale(clip: Clip, offset: number, duration: number): number | undefined {
  if (!movesFrame(clip.motion) || duration <= 0) return undefined;
  const progress = Math.max(0, Math.min(1, offset / duration));
  return clip.motion === "punchin"
    ? 1 + (MOTION_ZOOM - 1) * progress
    : MOTION_ZOOM - (MOTION_ZOOM - 1) * progress;
}

/**
 * A `circle()` radius is a percentage of the box's diagonal over √2, so 70.8%
 * reaches the corners whatever the aspect ratio. A hair over, so the last
 * frame of an iris is unambiguously clear of them.
 */
const IRIS_RADIUS = 72;

/** How soft `pixelize` goes at its midpoint. See `TRANSITION_EFFECT`. */
const PIXELIZE_BLUR = 10;

/**
 * How long the preview takes to push the score down, and to let it back up.
 *
 * The render ducks with `sidechaincompress`, which follows the *envelope* of
 * the shots' own sound — down on the front of a word, back up in the pause
 * after it, on a 20 ms attack and a 350 ms release. This follows only whether
 * an audible shot is on screen, so it's a rectangle where the export has a
 * waveform: the depth is right and the breathing isn't. The slew is here
 * because a step change in an element's `volume` clicks, and symmetric because
 * a preview has no envelope to be asymmetric about.
 */
const DUCK_RAMP = 0.15;

/**
 * Does this shot lean on the score?
 *
 * A video with no audio stream at all — a screen capture, a camera in a silent
 * mode — never opens the duck in the render, because `render.ts` feeds silence
 * in its place. Nothing readable from a `<video>` answers that before the shot
 * has played, so the answer comes from the row: `process-media` probed it while
 * the file was on disk.
 *
 * `hasAudio` is null on anything processed before that column existed. Null is
 * treated as "assume it has sound", which is the old behaviour and errs towards
 * ducking music that didn't need it — a wrong level for a moment, rather than a
 * preview that silently stops ducking every older shot in the pile.
 */
function opensTheDuck(clip: Clip, media: MediaItemView | undefined): boolean {
  if (clip.kind !== "video" || clip.muted || clip.volume <= 0 || !clip.duckMusic) return false;
  return media?.hasAudio !== false;
}

/**
 * The transition, as two stacked DOM layers.
 *
 * The outgoing shot is opaque underneath and the incoming one is composited
 * over it, which is what makes the plain dissolve exact: an incoming layer at
 * opacity p over an opaque outgoing layer is the same sum `xfade=fade`
 * computes. Everything else is an impression — a wipe has no soft edge, a dip
 * fades to a flat sheet rather than through the filter's curve — but the
 * shape, direction and timing of the move are right, which is what the preview
 * is for.
 */
function transitionStyles(
  effect: TransitionEffect,
  progress: number,
): {
  outgoing: React.CSSProperties;
  incoming: React.CSSProperties;
  /** A sheet of colour behind both layers, for the dips. */
  veil: string | null;
  /** An iris that closes belongs on top; everything else reads bottom-up. */
  outgoingOnTop: boolean;
} {
  const p = Math.max(0, Math.min(1, progress));
  const base = { outgoing: {}, incoming: {}, veil: null, outgoingOnTop: false };
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

  switch (effect.kind) {
    case "none":
      return base;
    case "dissolve":
      return { ...base, incoming: { opacity: p } };
    case "dip":
      // Out to the colour over the first half, in from it over the second —
      // the two halves `fadeblack`/`fadewhite` play.
      return {
        ...base,
        veil: effect.colour,
        outgoing: { opacity: Math.max(0, 1 - p * 2) },
        incoming: { opacity: Math.max(0, p * 2 - 1) },
      };
    case "wipe":
      return {
        ...base,
        incoming: {
          clipPath:
            effect.towards === "left"
              ? `inset(0 0 0 ${pct(1 - p)})`
              : `inset(0 ${pct(1 - p)} 0 0)`,
        },
      };
    case "push": {
      const away = effect.towards === "left" ? -1 : 1;
      return {
        ...base,
        outgoing: { transform: `translateX(${pct(away * p)})` },
        incoming: { transform: `translateX(${pct(-away * (1 - p))})` },
      };
    }
    case "iris":
      return effect.circle === "incoming"
        ? {
            ...base,
            incoming: { clipPath: `circle(${(p * IRIS_RADIUS).toFixed(2)}% at 50% 50%)` },
          }
        : {
            ...base,
            outgoingOnTop: true,
            outgoing: {
              clipPath: `circle(${((1 - p) * IRIS_RADIUS).toFixed(2)}% at 50% 50%)`,
            },
          };
    case "blur": {
      // Softest in the middle, where the render is at its blockiest.
      const soft = PIXELIZE_BLUR * (1 - Math.abs(1 - p * 2));
      const filter = `blur(${soft.toFixed(2)}px)`;
      return { ...base, outgoing: { filter }, incoming: { filter, opacity: p } };
    }
  }
}

/** How often playback tells the rest of the bench where it is. */
const PUBLISH_INTERVAL = 1 / 30;

export function PreviewPlayer({
  timeline,
  mediaById,
  musicById,
  durations,
  playheadTime,
  onTimeChange,
  selectedClipId,
  onSelectClip,
  playing,
  onPlayingChange: setPlaying,
  format,
}: {
  timeline: TimelineDoc;
  mediaById: Map<string, MediaItemView>;
  musicById: Map<string, MusicItemView>;
  durations: Record<string, number | null>;
  playheadTime: number;
  onTimeChange: (t: number) => void;
  selectedClipId: string | null;
  onSelectClip: (id: string) => void;
  /**
   * Playback is held by the bench, not here: Space has to reach it from
   * wherever focus happens to be, and a transport that owns its own state
   * can't be told anything from outside.
   */
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  /**
   * The shape of the finished film.
   *
   * Not decoration: a layer is stored as a rectangle in *fractions of the
   * frame*, so a preview that isn't the render's shape puts an inset
   * somewhere the render won't — and someone would lay a title out against
   * a lie.
   */
  format: VideoFormat;
}) {

  const rafRef = useRef<number | null>(null);

  /**
   * The playhead as playback sees it, at full frame rate. `playheadTime` is
   * the same number published to the rest of the bench a few times a second;
   * this is the one the media is kept in step with.
   */
  const clockRef = useRef(playheadTime);
  /** The last value we sent up, so a seek from outside can be told apart. */
  const publishedRef = useRef(playheadTime);
  const onTimeChangeRef = useRef(onTimeChange);
  onTimeChangeRef.current = onTimeChange;

  const publish = useCallback((time: number) => {
    publishedRef.current = time;
    onTimeChangeRef.current(time);
  }, []);

  // A seek — the scrubber, a key, clicking a shot — moves the clock. Our own
  // publishes come back through here too, and must not rewind it.
  useEffect(() => {
    if (playheadTime !== publishedRef.current) {
      clockRef.current = playheadTime;
      publishedRef.current = playheadTime;
    }
  }, [playheadTime]);
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

  /**
   * Space starts playback from anywhere on the bench, so it never passes
   * through the button above — and the sound has to be started by something.
   *
   * The button still does it inside the click, because the very first play of
   * a session needs the gesture itself; once the page has been interacted
   * with, the activation is sticky and this is late enough. Starting a track
   * twice is harmless; never starting it is silence nobody can explain.
   */
  useEffect(() => {
    if (!playing) return;
    for (const el of audioEls.current.values()) {
      const started = el.play();
      if (started) {
        started.catch((err: unknown) => {
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

  /**
   * The shot the active clip is coming out of, while the playhead is still
   * inside the overlap.
   *
   * The length has to be the renderer's, or the preview shows a move of a
   * different weight to the one that gets exported — so it asks
   * `transitionOverlap` with the film-so-far, which is the same call
   * `render.ts` makes with its `offset`.
   */
  const transition = useMemo(() => {
    if (!active || active.index === 0) return null;
    const clip = active.clip;
    if (!overlapsPrevious(clip.transitionIn)) return null;

    const previous = timeline.clips[active.index - 1];
    if (!previous) return null;

    const previousStart = starts[previous.id] ?? 0;
    const previousDuration = clipDuration(previous, durations[previous.mediaItemId]);
    const duration = transitionOverlap(
      clip,
      clipDuration(clip, durations[clip.mediaItemId]),
      previousStart + previousDuration,
    );
    if (duration <= 0.02 || active.offset >= duration) return null;

    return {
      clip: previous,
      offset: playheadTime - previousStart,
      duration: previousDuration,
      effect: TRANSITION_EFFECT[clip.transitionIn],
      progress: active.offset / duration,
    };
  }, [active, timeline.clips, starts, durations, playheadTime]);

  /**
   * The stretches of film where a shot's own sound leans on the score.
   *
   * Merged as they're collected: two audible shots in a row are one continuous
   * duck, and the music lifting for the frame between them is the artefact the
   * renderer's release time exists to avoid.
   */
  const duckWindows = useMemo(() => {
    const windows: Array<[number, number]> = [];
    if (!timeline.duckClipAudio) return windows;
    for (const clip of timeline.clips) {
      if (!opensTheDuck(clip, mediaById.get(clip.mediaItemId))) continue;
      const start = starts[clip.id] ?? 0;
      const end = start + clipDuration(clip, durations[clip.mediaItemId]);
      const last = windows[windows.length - 1];
      if (last && start <= last[1] + 0.001) last[1] = Math.max(last[1], end);
      else windows.push([start, end]);
    }
    return windows;
  }, [timeline.duckClipAudio, timeline.clips, starts, durations, mediaById]);

  /**
   * How far the duck is in under the playhead: 0 leaves the score where its
   * level says, 1 is the full depth each track asks for. Read off the playhead
   * rather than a wall clock, so scrubbing lands on the same level playing
   * through does.
   */
  const duckAmount = useMemo(() => {
    let amount = 0;
    for (const [from, to] of duckWindows) {
      if (playheadTime <= from || playheadTime >= to + DUCK_RAMP) continue;
      const rampIn = (playheadTime - from) / DUCK_RAMP;
      const rampOut = (to + DUCK_RAMP - playheadTime) / DUCK_RAMP;
      amount = Math.max(amount, Math.min(1, rampIn, rampOut));
      if (amount >= 1) break;
    }
    return amount;
  }, [duckWindows, playheadTime]);

  const visibleLayers = useMemo(
    () =>
      layersInPaintOrder(timeline).filter(
        (l) => playheadTime >= l.startAt && playheadTime < l.startAt + l.duration,
      ),
    [timeline, playheadTime],
  );

  /**
   * Drive playback: video and audio advance themselves, the clock keeps up.
   *
   * The clock is a ref, and this effect deliberately doesn't watch it. Watching
   * it meant the loop was torn down and rebuilt on every frame, and each rebuild
   * reset `last` to the moment React finished committing — so a frame's delta
   * measured commit-to-frame instead of frame-to-frame and quietly lost the
   * render time out of every tick. The clock ran slow against the media, which
   * plays at its own honest rate, and once the two were 0.35s apart the sync
   * below hauled the element back to where the clock thought it was. That jerk,
   * every few seconds, was the stutter in both picture and sound.
   *
   * Published to React at 30Hz rather than every frame: the strip's playhead
   * has nothing to say at 60 that it can't say at 30, and the whole bench
   * re-renders on each one.
   */
  useEffect(() => {
    if (!playing) return;

    let last = performance.now();
    let sincePublish = 0;

    const tick = (now: number) => {
      const delta = (now - last) / 1000;
      last = now;
      sincePublish += delta;

      const next = Math.min(total, clockRef.current + delta);
      clockRef.current = next;

      if (next >= total) {
        publish(next);
        setPlaying(false);
        return;
      }
      if (sincePublish >= PUBLISH_INTERVAL) {
        sincePublish = 0;
        publish(next);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // `publish` and `setPlaying` are read through refs or are setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, total]);

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
      <div
        style={{ aspectRatio: frameAspectCss(format) }}
        className="flex items-center justify-center border border-[color:var(--hair-dark)] bg-ink-950 bg-hatch"
      >
        <p className="eyebrow-light">No picture yet</p>
      </div>
    );
  }

  const frame = previewFrame(format);
  const src = active ? pictureSrc(active.clip, activeMedia) : null;
  const fx = transition ? transitionStyles(transition.effect, transition.progress) : null;

  // Two layers during a transition, one the rest of the time. Painted in DOM
  // order, so the incoming shot sits over the outgoing one unless the effect
  // asks for the other way round.
  const stack = [
    transition && fx ? (
      <ClipView
        key={transition.clip.id}
        clip={transition.clip}
        media={mediaById.get(transition.clip.mediaItemId) ?? null}
        offset={transition.offset}
        duration={transition.duration}
        playing={playing}
        style={fx.outgoing}
        gain={1 - transition.progress}
      />
    ) : null,
    active && src ? (
      <ClipView
        key={active.clip.id}
        clip={active.clip}
        media={activeMedia}
        offset={active.offset}
        duration={clipDuration(active.clip, durations[active.clip.mediaItemId])}
        playing={playing}
        style={fx?.incoming}
        gain={transition ? transition.progress : 1}
        onEnded={() => {
          // Roll into the next clip.
          const next = timeline.clips[active.index + 1];
          if (next) seek(starts[next.id] ?? playheadTime);
          else setPlaying(false);
        }}
      />
    ) : null,
  ];
  if (fx?.outgoingOnTop) stack.reverse();

  return (
    <div className="flex min-h-0 flex-col border border-[color:var(--hair-dark)] bg-ink-950">
      {/*
        The picture fits the stage on both axes and keeps the film's shape
        doing it, because a layer is stored as a *fraction of the frame* — a
        preview box that isn't the render's shape puts an inset somewhere the
        render won't, and someone would lay a title out against a lie.

        Height-bound alone doesn't get there. `aspect-ratio` against a
        definite height hands `max-width` the width and nothing else: the
        clamp lands on one axis, the height stays where it was, and a 16:9
        film comes out 1.32:1 on a tall window. So the stage is made a size
        container and the box does the contain-fit arithmetic itself — the
        width is the lesser of the stage's width and the width the stage's
        height affords. Height still leads wherever there's room for it,
        which is the whole point of a bigger window giving a bigger picture.

        Below `xl` the page scrolls and there is no stage height to fit
        into, so the box stays width-bound as it has always been there.

        It is a query container in its own right as well: a title's size is
        a fraction of the *frame* (`cqh`, below), not of the stage the frame
        is floating in.

        Clipped, because FFmpeg crops a layer at the frame edge and the
        preview has to agree — a tall portrait inset otherwise spills out
        over the transport.
      */}
      <div className="flex min-h-0 flex-1 items-center justify-center xl:[container-type:size]">
      <div
        style={
          {
            aspectRatio: frameAspectCss(format),
            "--frame-w": frame.width,
            "--frame-h": frame.height,
          } as React.CSSProperties
        }
        className="relative w-full overflow-hidden bg-black [container-type:size] xl:w-[min(100cqw,100cqh*var(--frame-w)/var(--frame-h))]"
      >
        {fx?.veil && <div className="absolute inset-0" style={{ background: fx.veil }} />}

        {src ? (
          stack
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
          duck={duckAmount}
          playheadTime={playheadTime}
          playing={playing}
          onElement={registerAudio}
        />
      ))}

      {/* Transport */}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-[color:var(--hair-dark)] bg-ink-900 px-2 py-2 sm:gap-3 sm:px-3">
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
          className="slider slider-dark w-full min-w-0 flex-1"
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
            className="hidden shrink-0 font-mono text-2xs uppercase tracking-label text-ink-400 transition-colors hover:text-paper-100 sm:block"
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
 * The file a clip plays from. Photos take the proxy too when there is one —
 * an iPhone HEIC has no picture in it as far as a browser is concerned, and
 * the proxy is the JPEG that does.
 */
function pictureSrc(clip: Clip | LayerClip, media: MediaItemView | null): string | null {
  if (!media) return null;
  return media.proxyUrl ?? media.originalUrl ?? (clip.kind === "photo" ? media.thumbnailUrl : null);
}

/**
 * One shot of the base track, filling the frame.
 *
 * It exists as its own component because a transition needs two of them on
 * screen at once, each seeking its own source — the playhead stays the
 * player's, and this only ever follows it. `style` is the transition's; the
 * grade and the Ken Burns move stay on the picture inside, so a shot keeps
 * both while it dissolves.
 */
function ClipView({
  clip,
  media,
  offset,
  duration,
  playing,
  style,
  gain = 1,
  onEnded,
}: {
  clip: Clip;
  media: MediaItemView | null;
  offset: number;
  duration: number;
  playing: boolean;
  style?: React.CSSProperties;
  /** The transition's side of the `acrossfade` the renderer performs. */
  gain?: number;
  onEnded?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || clip.kind !== "video") return;

    video.volume = Math.max(0, Math.min(1, gain));

    // A retimed shot spends its source faster than it spends the playhead, so
    // the seek target is scaled as well as the rate — otherwise the picture
    // drifts further out of step the longer the shot runs.
    const speed = clipSpeed(clip);
    video.playbackRate = speed;

    const target = clip.trimStart + offset * speed;
    if (Math.abs(video.currentTime - target) > 0.35) {
      video.currentTime = Math.max(0, target);
    }

    if (playing && video.paused) void video.play().catch(() => {});
    if (!playing && !video.paused) video.pause();
  }, [clip, offset, playing, gain]);

  const src = pictureSrc(clip, media);
  if (!src) return null;

  const scale = motionScale(clip, offset, duration);
  const pictureStyle: React.CSSProperties = {
    filter: gradeStyle(clip),
    transform: scale === undefined ? undefined : `scale(${scale.toFixed(4)})`,
  };

  return (
    <div className="absolute inset-0" style={style}>
      {clip.kind === "video" ? (
        <video
          ref={videoRef}
          src={src}
          style={pictureStyle}
          className="h-full w-full object-contain"
          playsInline
          muted={clip.muted}
          onEnded={onEnded}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" style={pictureStyle} className="h-full w-full object-contain" />
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

  const src = pictureSrc(layer, media);
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
 * runs on, so scrubbing, playing and pausing can't drift apart. Fades,
 * looping and the duck are mirrored from the renderer so the preview doesn't
 * lie about the mix.
 */
function TrackAudio({
  track,
  src,
  span,
  duck,
  playheadTime,
  playing,
  onElement,
}: {
  track: AudioTrack;
  src: string | null;
  span: number;
  /** How far the shots are pushing the score down right now, 0–1. */
  duck: number;
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
    // The duck sits on top of whatever the fades are already doing: `duck` is
    // when the score gets out of the way, `track.duck` how far this particular
    // track answers it.
    audio.volume = Math.max(0, Math.min(1, track.volume * fade * (1 - track.duck * duck)));

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
    duck,
    metadataSeq,
    track.duck,
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
