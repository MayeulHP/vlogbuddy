"use client";

import { useEffect, useState } from "react";

import {
  CLIP_FIT_CHOICES,
  CLIP_LOOKS,
  FIT_BLURBS,
  FIT_LABELS,
  LOOK_BLURBS,
  LOOK_LABELS,
  MAX_CLIP_SPEED,
  MIN_CLIP_SPAN,
  MIN_CLIP_SPEED,
  TRANSITIONS,
  TRANSITION_GLYPHS,
  TRANSITION_LABELS,
  clipDuration,
  formatDuration,
  formatFine,
  overlapsPrevious,
  previewFrame,
  resolveFit,
  type Clip,
  type ClipFit,
  type TimelineOp,
  type VideoFormat,
} from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { RotateButton } from "@/components/rotate-button";
import { TrimBar, round2 } from "./trim-bar";
import { Section } from "./section";
import { KBD_HINT } from "./kbd";
import { SliderField } from "./slider-field";
import type { PreviewTransport } from "./preview-player";
import { cn } from "@/lib/cn";

/**
 * The speeds anyone actually asks for: half for the good bit, one for as shot,
 * and two or four for the walk back to the car. The slider covers the rest.
 */
const SPEED_CHIPS = [0.5, 1, 1.5, 2] as const;

/** Trim, title and transition controls for the selected shot. */
export function ClipInspector({
  slug,
  clip,
  media,
  index,
  total,
  format,
  fitPolicy,
  playheadTime,
  clipStart,
  transportRef,
  onSeek,
  onSelectClip,
  onDispatch,
}: {
  slug: string;
  clip: Clip;
  media: MediaItemView | null;
  index: number;
  total: number;
  /** The shape of the film — what this shot has to fit into. */
  format: VideoFormat;
  /** The film's answer for shots of the wrong shape, which Auto defers to. */
  fitPolicy: ClipFit;
  /** Where the bench's playhead is, in film seconds. */
  playheadTime: number;
  /** Where this shot's first frame lands, so the playhead can be read against it. */
  clipStart: number;
  /** The preview's transport, so a trim can be heard as well as measured. */
  transportRef?: React.MutableRefObject<PreviewTransport | null>;
  /** Move the bench's playhead — a handle under the hand is a frame to show. */
  onSeek?: (seconds: number) => void;
  onSelectClip: (clipId: string) => void;
  onDispatch: (op: TimelineOp) => void;
}) {
  const sourceDuration = media?.durationSeconds ?? null;
  const effective = clipDuration(clip, sourceDuration);

  const trimmedAway = sourceDuration === null ? 0 : sourceDuration - effective;

  /**
   * Where a split would land, in seconds into this shot. The reducer refuses
   * anything that would leave a flash frame either side; the button greys out
   * on the same test rather than letting the press do nothing.
   */
  const splitAt = round2(playheadTime - clipStart);
  const canSplit =
    splitAt >= MIN_CLIP_SPAN &&
    effective - splitAt >= MIN_CLIP_SPAN &&
    // A video still being probed has no out-point, so there's no second half
    // to describe yet.
    (clip.kind === "photo" || clip.trimEnd !== null);

  // Resolved here for the same reason it's resolved in the renderer: the
  // document holds the intent, never the answer.
  const frame = previewFrame(format);
  const resolvedFit = resolveFit({
    clipWidth: media?.width,
    clipHeight: media?.height,
    clipRotation: media?.rotation,
    frameWidth: frame.width,
    frameHeight: frame.height,
    fit: clip.fit,
    policy: fitPolicy,
  });
  const shapeKnown = Boolean(media?.width && media?.height);

  // A shot you've just picked shouldn't arrive with the picker hanging open
  // from the last one.
  const [pickingTransition, setPickingTransition] = useState(false);
  useEffect(() => setPickingTransition(false), [clip.id]);

  /**
   * Auditioning the kept window. The transport is the preview's — there is only
   * one player and one mix — so the button here only has to follow it: anything
   * that stops playback, including the transport's own play button, puts this
   * back to "play".
   */
  const [auditioning, setAuditioning] = useState(false);
  const [loop, setLoop] = useState(false);

  useEffect(() => {
    const transport = transportRef?.current;
    if (!transport) return;
    return transport.subscribe(({ playing, ranged }) => setAuditioning(playing && ranged));
  }, [transportRef]);

  // Picking another shot ends the audition with it; what's left playing would
  // be a window nothing on screen describes any more.
  useEffect(() => {
    return () => {
      transportRef?.current?.stop();
    };
  }, [clip.id, transportRef]);

  function toggleAudition() {
    const transport = transportRef?.current;
    if (!transport) return;
    if (auditioning) transport.stop();
    else transport.playRange(clipStart, clipStart + effective, { loop });
  }

  /**
   * Film time for a point in this shot's source, for the picture to follow.
   *
   * Held inside the shot as it currently stands: nothing is written until the
   * handle is let go, so the only frames the preview can actually draw are the
   * ones already in the window. A handle dragged outward parks on the last of
   * them rather than sliding into the next shot's footage.
   */
  function scrubToSource(seconds: number) {
    const at = clipStart + (seconds - clip.trimStart);
    onSeek?.(Math.min(Math.max(at, clipStart), clipStart + Math.max(0, effective - 0.05)));
  }

  function patch(p: Partial<Omit<Clip, "id">>) {
    onDispatch({ type: "clip.update", clipId: clip.id, patch: p });
  }

  /** Opens the trim window by `seconds`, split either side, within the source. */
  function grow(seconds: number) {
    if (sourceDuration === null) return;
    const end = clip.trimEnd ?? sourceDuration;
    const half = seconds / 2;
    const trimStart = Math.max(0, Math.min(clip.trimStart - half, sourceDuration - MIN_CLIP_SPAN));
    const trimEnd = Math.min(sourceDuration, Math.max(end + half, trimStart + MIN_CLIP_SPAN));
    patch({ trimStart: round2(trimStart), trimEnd: round2(trimEnd) });
  }

  /**
   * What each folded-up section would be hiding. A section stays silent when
   * everything inside it is still as it came, so a dot in a header always means
   * somebody — or the auto-cut — decided something in there.
   */
  const timingSummary =
    clip.kind === "video" && sourceDuration !== null
      ? trimmedAway >= 0.1
        ? `${formatDuration(effective)} of ${formatDuration(sourceDuration)}`
        : null
      : clip.auto.includes("timing")
        ? null
        : `Holds ${clip.duration.toFixed(1)}s`;

  const transitionSummary =
    clip.transitionIn === "cut" || index === 0
      ? null
      : [
          TRANSITION_LABELS[clip.transitionIn],
          overlapsPrevious(clip.transitionIn) ? `${clip.transitionDuration.toFixed(1)}s` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  const lookSummary =
    [
      clip.speed !== 1 ? `${Number(clip.speed.toFixed(2))}×` : null,
      clip.look !== "none" ? LOOK_LABELS[clip.look] : null,
      clip.fit !== "auto" ? FIT_LABELS[clip.fit] : null,
    ]
      .filter(Boolean)
      .join(" · ") || null;

  const soundSummary = clip.muted
    ? "Silent"
    : clip.volume !== 1
      ? `${Math.round(clip.volume * 100)}%`
      : null;

  const textSummary =
    clip.titles.length === 0
      ? null
      : clip.titles.length === 1
        ? "1 title"
        : `${clip.titles.length} titles`;

  return (
    <section className="border border-[color:var(--hair-dark)] bg-ink-850">
      <div className="border-b border-[color:var(--hair-dark)] px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="eyebrow-light">
            Shot {String(index + 1).padStart(2, "0")} of {String(total).padStart(2, "0")}
          </p>
          <p className="timecode text-sm text-paper-100">{formatDuration(effective)}</p>
        </div>
        {media && (
          <p
            className="timecode mt-1 truncate text-2xs text-ink-400"
            title={media.originalFilename}
          >
            {media.originalFilename}
          </p>
        )}

        {/*
          The strip is the fast way to reorder and these are the exact one:
          one place at a time, no aim required, and reachable from a keyboard.
        */}
        {total > 1 && (
          <div className="mt-2 flex items-center gap-1.5">
            <button
              onClick={() => onDispatch({ type: "clip.move", clipId: clip.id, toIndex: index - 1 })}
              disabled={index === 0}
              className="btn-outline-dark px-2"
              title="Move this shot earlier"
            >
              ◀ Earlier
            </button>
            <button
              onClick={() => onDispatch({ type: "clip.move", clipId: clip.id, toIndex: index + 1 })}
              disabled={index === total - 1}
              className="btn-outline-dark px-2"
              title="Move this shot later"
            >
              Later ▶
            </button>
          </div>
        )}
      </div>

      {/*
        The panel reads top to bottom in the order the work happens: how long
        the shot is, how it arrives, what it looks like, what it sounds like,
        what's written over it. Only Timing is open by default — it's the one
        every shot needs, and the only one most shots need at all.
      */}
      <div className="px-4 pb-4">
        <Section storageKey="clip.timing" title="Timing" summary={timingSummary} defaultOpen>
          {/* Trim (video) or hold time (photo) */}
          {clip.kind === "video" && sourceDuration ? (
            <div>
              <p className="eyebrow-light mb-2">Trim</p>
              <div className="space-y-3">
                <TrimBar
                  source={sourceDuration}
                  start={clip.trimStart}
                  end={clip.trimEnd ?? sourceDuration}
                  onChange={(next) =>
                    patch({
                      ...(next.start !== undefined && { trimStart: next.start }),
                      ...(next.end !== undefined && { trimEnd: next.end }),
                    })
                  }
                  onScrub={scrubToSource}
                />

                {transportRef && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={toggleAudition}
                      className="border border-[color:var(--hair-dark)] px-2 py-1 text-2xs text-paper-100 transition-colors hover:border-paper-200 hover:bg-paper-100 hover:text-ink-900"
                    >
                      {auditioning ? "❙❙ Stop" : "▶ Play this shot"}
                    </button>
                    <label className="flex items-center gap-2 font-mono text-2xs uppercase tracking-label text-ink-300">
                      <input
                        type="checkbox"
                        checked={loop}
                        onChange={(e) => {
                          setLoop(e.target.checked);
                          // Deciding mid-audition shouldn't mean stopping and
                          // pressing play again to find out.
                          if (auditioning) {
                            transportRef?.current?.playRange(clipStart, clipStart + effective, {
                              loop: e.target.checked,
                            });
                          }
                        }}
                        className="check check-dark"
                      />
                      Keep going round
                    </label>
                  </div>
                )}

                {/*
                The auto-cut takes a few seconds out of the middle of a long
                clip, so "there's more where that came from" has to be visible
                and one press away — otherwise a trimmed shot reads as a lost
                one. Both buttons grow the window around its current centre.
              */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => grow(-5)}
                    disabled={effective <= MIN_CLIP_SPAN}
                    className="border border-[color:var(--hair-dark)] px-2 py-1 text-2xs text-ink-300 transition-colors hover:text-paper-100 disabled:opacity-40"
                  >
                    − 5s
                  </button>
                  <button
                    onClick={() => grow(5)}
                    disabled={trimmedAway < 0.1}
                    className="border border-[color:var(--hair-dark)] px-2 py-1 text-2xs text-ink-300 transition-colors hover:text-paper-100 disabled:opacity-40"
                  >
                    + 5s
                  </button>
                  <button
                    onClick={() => patch({ trimStart: 0, trimEnd: sourceDuration })}
                    disabled={trimmedAway < 0.1}
                    className="border border-[color:var(--hair-dark)] px-2 py-1 text-2xs text-ink-300 transition-colors hover:text-paper-100 disabled:opacity-40"
                  >
                    Use all {formatDuration(sourceDuration)}
                  </button>
                </div>

                {trimmedAway >= 0.1 && (
                  <p className="text-2xs leading-relaxed text-ink-400">
                    Using {formatDuration(effective)} of {formatDuration(sourceDuration)}
                    {clip.auto.includes("timing")
                      ? " — the auto-cut's pick. Stretch it and it's yours."
                      : "."}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <SliderField
              label={<p className="eyebrow-light">Hold for {clip.duration.toFixed(1)}s</p>}
              value={clip.duration}
              min={0.5}
              max={10}
              step={0.5}
              decimals={1}
              onChange={(v) => patch({ duration: v })}
              ariaLabel="Hold time in seconds"
            />
          )}

          {/*
          Trimming takes off the ends; this is the one way to lose a stretch out
          of the middle, or to put the second half somewhere else entirely. The
          playhead is the aim, so the only thing to say is whether it's usable.
        */}
          <div>
            <button
              onClick={() => {
                const newClipId = globalThis.crypto.randomUUID();
                onDispatch({ type: "clip.split", clipId: clip.id, at: splitAt, newClipId });
                // Land on the new half: it's the piece you were reaching for, and
                // the one nothing else in the bench would point you at.
                onSelectClip(newClipId);
              }}
              disabled={!canSplit}
              className="btn-outline-dark w-full"
            >
              Split at the playhead
              <kbd className={KBD_HINT}>S</kbd>
            </button>
            <p className="mt-1 text-2xs leading-relaxed text-ink-400">
              {canSplit
                ? `Cuts this shot in two at ${formatDuration(splitAt)} in. Both halves stay in the cut, and you can move or take out either one.`
                : "Park the playhead inside this shot, clear of both ends, to cut it in two."}
            </p>
          </div>
        </Section>

        <Section storageKey="clip.transition" title="Transition" summary={transitionSummary}>
          {/*
          Eleven ways of not cutting is a wall of buttons for a decision that
          is "cut" almost every time. The current answer is the control; the
          grid is one press away for the times it isn't.
        */}
          <div>
            <p className="eyebrow-light mb-1.5">Comes in on</p>
            <button
              type="button"
              aria-expanded={pickingTransition}
              disabled={index === 0}
              onClick={() => setPickingTransition((p) => !p)}
              className="flex min-h-[38px] w-full items-center gap-2 border border-[color:var(--hair-dark)] bg-ink-900 px-3 py-2 text-left font-mono text-2xs uppercase tracking-label text-ink-200 transition-colors hover:bg-ink-800 hover:text-paper-100 disabled:opacity-30"
            >
              <span aria-hidden>{TRANSITION_GLYPHS[clip.transitionIn]}</span>
              <span className="min-w-0 flex-1 truncate">
                {TRANSITION_LABELS[clip.transitionIn]}
              </span>
              <span aria-hidden className="shrink-0 text-ink-400">
                {pickingTransition ? "▴" : "▾"}
              </span>
            </button>
            {pickingTransition && (
              <div className="mt-px grid grid-cols-2 gap-px border border-[color:var(--hair-dark)]">
                {TRANSITIONS.map((mode) => (
                  <button
                    key={mode}
                    onClick={() => {
                      patch({ transitionIn: mode });
                      setPickingTransition(false);
                    }}
                    disabled={index === 0}
                    title={TRANSITION_LABELS[mode]}
                    className={cn(
                      "flex items-center justify-center gap-1.5 py-2 font-mono text-2xs uppercase tracking-label transition-colors disabled:opacity-30",
                      // A cut is the norm, so it gets the full width and sits apart
                      // from the eleven ways of not cutting.
                      mode === "cut" && "col-span-2",
                      clip.transitionIn === mode
                        ? "bg-signal-600 text-paper-50"
                        : "bg-ink-900 text-ink-300 hover:bg-ink-800 hover:text-paper-100",
                    )}
                  >
                    <span aria-hidden>{TRANSITION_GLYPHS[mode]}</span>
                    {TRANSITION_LABELS[mode]}
                  </button>
                ))}
              </div>
            )}
            {index === 0 && (
              <p className="mt-1.5 font-mono text-2xs text-ink-500">
                The first shot has nothing to come in from.
              </p>
            )}
            {overlapsPrevious(clip.transitionIn) && index > 0 && (
              <SliderField
                className="mt-2.5"
                label={
                  <span className="timecode text-2xs text-ink-300">
                    Over {clip.transitionDuration.toFixed(1)}s
                  </span>
                }
                value={clip.transitionDuration}
                min={0.2}
                max={2}
                step={0.1}
                decimals={1}
                onChange={(v) => patch({ transitionDuration: v })}
                ariaLabel="Transition length in seconds"
              />
            )}
          </div>
        </Section>

        <Section storageKey="clip.look" title="Look" summary={lookSummary}>
          {/* How it fills the frame */}
          <div>
            <p className="eyebrow-light mb-1.5">Fills the frame by</p>
            <div className="grid grid-cols-4 gap-px border border-[color:var(--hair-dark)]">
              {CLIP_FIT_CHOICES.map((choice) => (
                <button
                  key={choice}
                  onClick={() => patch({ fit: choice })}
                  title={FIT_BLURBS[choice]}
                  className={cn(
                    "py-2 font-mono text-2xs uppercase tracking-label transition-colors",
                    clip.fit === choice
                      ? "bg-signal-600 text-paper-50"
                      : "bg-ink-900 text-ink-300 hover:bg-ink-800 hover:text-paper-100",
                  )}
                >
                  {FIT_LABELS[choice]}
                </button>
              ))}
            </div>
            {/*
            Auto is only trustworthy if it says what it's doing. A shot whose
            dimensions haven't come back from the lab yet is the one case
            where the answer will change on its own, so say that too rather
            than showing a setting that quietly moves.
          */}
            <p className="mt-1.5 text-2xs leading-relaxed text-ink-400">
              {clip.fit !== "auto"
                ? FIT_BLURBS[clip.fit]
                : !shapeKnown
                  ? "Auto, and this one is still being developed — until we know its shape it keeps the whole shot, black either side."
                  : resolvedFit === "bars"
                    ? "Auto — this shot already points the same way as the film, so nothing is done to it."
                    : `Auto — this shot points the other way to the film, so the film's answer applies: ${FIT_BLURBS[resolvedFit].toLowerCase()}`}
            </p>
          </div>

          {/*
          Look: the two cheap things that change how a shot feels. Speed sits
          with the grade rather than with the trim because it's the same kind
          of decision — what this shot is like — and because the trim is about
          the file while both of these are about the film.
        */}
          <div>
            <p className="eyebrow-light mb-1.5">Speed and colour</p>

            {clip.kind === "video" && (
              <div className="mb-3">
                <div className="grid grid-cols-4 gap-px border border-[color:var(--hair-dark)]">
                  {SPEED_CHIPS.map((chip) => (
                    <button
                      key={chip}
                      onClick={() => patch({ speed: chip })}
                      className={cn(
                        "py-2 font-mono text-2xs uppercase tracking-label transition-colors",
                        clip.speed === chip
                          ? "bg-signal-600 text-paper-50"
                          : "bg-ink-900 text-ink-300 hover:bg-ink-800 hover:text-paper-100",
                      )}
                    >
                      {chip}×
                    </button>
                  ))}
                </div>
                <SliderField
                  className="mt-2.5"
                  label={
                    <span className="timecode text-2xs text-ink-300">
                      Plays at {clip.speed.toFixed(2)}× — {formatDuration(effective)} on screen
                    </span>
                  }
                  value={clip.speed}
                  min={MIN_CLIP_SPEED}
                  max={MAX_CLIP_SPEED}
                  step={0.05}
                  onChange={(v) => patch({ speed: v })}
                  ariaLabel="Shot speed"
                />
                {clip.speed !== 1 && (
                  <p className="mt-1.5 text-2xs leading-relaxed text-ink-400">
                    The trim stays where you left it; the shot just gets through it
                    {clip.speed > 1 ? " faster" : " slower"}.
                  </p>
                )}
              </div>
            )}

            <div className="grid grid-cols-3 gap-px border border-[color:var(--hair-dark)]">
              {CLIP_LOOKS.map((choice) => (
                <button
                  key={choice}
                  onClick={() => patch({ look: choice })}
                  title={LOOK_BLURBS[choice]}
                  className={cn(
                    "py-2 font-mono text-2xs uppercase tracking-label transition-colors",
                    clip.look === choice
                      ? "bg-signal-600 text-paper-50"
                      : "bg-ink-900 text-ink-300 hover:bg-ink-800 hover:text-paper-100",
                  )}
                >
                  {LOOK_LABELS[choice]}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-2xs leading-relaxed text-ink-400">
              {LOOK_BLURBS[clip.look]}
              {clip.look !== "none" &&
                " The preview is a close guess; the print is the real thing."}
            </p>
          </div>

          {/*
          A correction rather than a choice, so it sits at the foot of the look
          controls rather than among them — and it's the file being fixed, not
          this shot: the same photo used as a layer comes up straight too.
        */}
          {media && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--hair-dark)] pt-3">
              <div className="min-w-0">
                <p className="eyebrow-light">The right way up</p>
                <p className="mt-1 text-2xs leading-relaxed text-ink-400">
                  For footage that arrived on its side. Turns it everywhere it appears.
                </p>
              </div>
              <RotateButton
                slug={slug}
                mediaItemId={media.id}
                className="btn-outline-dark px-2 py-1"
              />
            </div>
          )}
        </Section>

        {/* Audio */}
        {clip.kind === "video" && (
          <Section storageKey="clip.sound" title="Sound" summary={soundSummary}>
            <div>
              <label className="flex items-center gap-2 font-mono text-2xs uppercase tracking-label text-ink-300">
                <input
                  type="checkbox"
                  checked={!clip.muted}
                  onChange={(e) => patch({ muted: !e.target.checked })}
                  className="check check-dark"
                />
                Keep this shot&apos;s sound
              </label>
              {!clip.muted && (
                <SliderField
                  className="mt-2.5"
                  label={
                    <span className="timecode text-2xs text-ink-300">
                      Level — {Math.round(clip.volume * 100)}%
                    </span>
                  }
                  value={clip.volume}
                  min={0}
                  max={2}
                  step={0.05}
                  onChange={(v) => patch({ volume: v })}
                  ariaLabel="Shot level"
                />
              )}
            </div>
          </Section>
        )}

        <Section storageKey="clip.text" title="Text" summary={textSummary}>
          {/* Titles */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="eyebrow-light">Titles</p>
              <button
                onClick={() =>
                  onDispatch({
                    type: "title.add",
                    clipId: clip.id,
                    title: {
                      id: globalThis.crypto.randomUUID(),
                      text: "Say something",
                      start: 0,
                      duration: Math.min(2, effective),
                      position: "bottom",
                      fontSize: 48,
                      color: "#ffffff",
                    },
                  })
                }
                className="btn-quiet-dark px-0"
              >
                + Add
              </button>
            </div>

            {clip.titles.length === 0 ? (
              <p className="font-mono text-2xs text-ink-500">Nothing written over this shot.</p>
            ) : (
              <div className="space-y-2">
                {clip.titles.map((title) => (
                  <div
                    key={title.id}
                    className="border border-[color:var(--hair-dark)] bg-ink-900 p-2"
                  >
                    <div className="flex items-end gap-2">
                      <input
                        value={title.text}
                        onChange={(e) =>
                          onDispatch({
                            type: "title.update",
                            clipId: clip.id,
                            titleId: title.id,
                            patch: { text: e.target.value },
                          })
                        }
                        className="field-dark display-sm flex-1 py-1 text-base"
                        maxLength={200}
                        placeholder="Title text"
                      />
                      <button
                        onClick={() =>
                          onDispatch({ type: "title.remove", clipId: clip.id, titleId: title.id })
                        }
                        className="shrink-0 px-1 pb-1 font-mono text-2xs text-ink-400 hover:text-signal-400"
                      >
                        ✕
                      </button>
                    </div>

                    {/*
                    The schema has always carried these; only the UI didn't.
                    Kept tight — four boxes on two rows — because a title is
                    usually a word and a place, and the rest is fine tuning.
                    Seconds are from the head of this shot, which is why the
                    ceiling is the shot's own length.
                  */}
                    <div className="mt-2 grid grid-cols-4 gap-2">
                      <label className="block">
                        <span className="eyebrow-light">In (s)</span>
                        <input
                          type="number"
                          min={0}
                          max={round2(Math.max(0, effective))}
                          step={0.1}
                          value={round2(title.start)}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (!Number.isFinite(v)) return;
                            onDispatch({
                              type: "title.update",
                              clipId: clip.id,
                              titleId: title.id,
                              patch: { start: round2(Math.max(0, Math.min(effective, v))) },
                            });
                          }}
                          className="field-dark timecode mt-1 w-full py-1 text-sm"
                        />
                      </label>
                      <label className="block">
                        <span className="eyebrow-light">For (s)</span>
                        <input
                          type="number"
                          min={0.1}
                          max={round2(Math.max(0.1, effective))}
                          step={0.1}
                          value={round2(title.duration)}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (!Number.isFinite(v)) return;
                            onDispatch({
                              type: "title.update",
                              clipId: clip.id,
                              titleId: title.id,
                              patch: { duration: round2(Math.max(0.1, v)) },
                            });
                          }}
                          className="field-dark timecode mt-1 w-full py-1 text-sm"
                        />
                      </label>
                      <label className="block">
                        <span className="eyebrow-light">Size</span>
                        <input
                          type="number"
                          min={8}
                          max={200}
                          step={2}
                          value={title.fontSize}
                          onChange={(e) => {
                            const v = Math.round(Number(e.target.value));
                            if (!Number.isFinite(v)) return;
                            onDispatch({
                              type: "title.update",
                              clipId: clip.id,
                              titleId: title.id,
                              patch: { fontSize: Math.min(200, Math.max(8, v)) },
                            });
                          }}
                          className="field-dark timecode mt-1 w-full py-1 text-sm"
                        />
                      </label>
                      <label className="block">
                        <span className="eyebrow-light">Colour</span>
                        <input
                          type="color"
                          value={/^#[0-9a-fA-F]{6}$/.test(title.color) ? title.color : "#ffffff"}
                          onChange={(e) =>
                            onDispatch({
                              type: "title.update",
                              clipId: clip.id,
                              titleId: title.id,
                              patch: { color: e.target.value },
                            })
                          }
                          className="mt-1 h-[30px] w-full cursor-pointer border border-[color:var(--hair-dark)] bg-ink-850"
                          aria-label="Title colour"
                        />
                      </label>
                    </div>

                    <div className="mt-2 grid grid-cols-3 gap-px border border-[color:var(--hair-dark)]">
                      {(["top", "center", "bottom"] as const).map((pos) => (
                        <button
                          key={pos}
                          onClick={() =>
                            onDispatch({
                              type: "title.update",
                              clipId: clip.id,
                              titleId: title.id,
                              patch: { position: pos },
                            })
                          }
                          className={cn(
                            "py-1 font-mono text-2xs uppercase tracking-label transition-colors",
                            title.position === pos
                              ? "bg-paper-100 text-ink-900"
                              : "bg-ink-850 text-ink-400 hover:text-paper-100",
                          )}
                        >
                          {pos}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>

        {/*
          One verb for getting rid of something, in all three inspectors: you
          take it out. It sits outside the sections because it belongs to none
          of them — it's what you do instead of all of them.
        */}
        <div className="border-t border-[color:var(--hair-dark)] pt-4">
          <button
            onClick={() => onDispatch({ type: "clip.remove", clipId: clip.id })}
            className="btn border-signal-700/50 bg-signal-900/30 w-full text-signal-300 hover:border-signal-500 hover:bg-signal-900/60"
          >
            Take this shot out
            <kbd className={KBD_HINT}>⌫</kbd>
          </button>
          <p className="mt-1 text-2xs text-ink-400">
            Drops it from the cut. Nothing is deleted — bring it back from the Trip page.
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * The whole source as a bar, with the kept window sitting inside it.
 *
 * Two range sliders in two rows could never show a window: you read one number,
 * then the other, and the picture of "this much out of all that" never arrives
 * — and In could be pushed past Out, with only a clamp after the fact to say
 * otherwise. One bar carrying both handles is the same mental model as the
 * strip upstairs, where the same edit is made with a hand instead.
 *
 * The handles are focusable sliders rather than styled divs, because a div with
 * pointer handlers is unreachable without a pointer and trimming isn't an
 * optional part of an editor.
 */
