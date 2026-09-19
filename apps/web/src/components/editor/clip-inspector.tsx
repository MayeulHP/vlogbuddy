"use client";

import {
  CLIP_FIT_CHOICES,
  FIT_BLURBS,
  FIT_LABELS,
  MOTIONS,
  MOTION_GLYPHS,
  MOTION_LABELS,
  SPEED_PRESETS,
  TRANSITIONS,
  TRANSITION_GLYPHS,
  TRANSITION_LABELS,
  canSplitAt,
  clipDuration,
  clipSourceSpan,
  formatDuration,
  isGraded,
  overlapsPrevious,
  previewFrame,
  resolveFit,
  type Clip,
  type ClipFit,
  type TimelineOp,
  type VideoFormat,
} from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { cn } from "@/lib/cn";

/**
 * The grade, as the inspector offers it. Each row carries its own neutral so
 * "is this dialled in?" is one comparison rather than five special cases.
 */
const GRADE_ROWS = [
  { key: "brightness", label: "Brightness", min: -1, max: 1, step: 0.02, neutral: 0 },
  { key: "contrast", label: "Contrast", min: 0, max: 3, step: 0.05, neutral: 1 },
  { key: "saturation", label: "Colour", min: 0, max: 3, step: 0.05, neutral: 1 },
  { key: "hue", label: "Hue", min: -180, max: 180, step: 1, neutral: 0 },
  { key: "blur", label: "Blur", min: 0, max: 20, step: 0.5, neutral: 0 },
] as const satisfies readonly {
  key: keyof Clip;
  label: string;
  min: number;
  max: number;
  step: number;
  neutral: number;
}[];

const NEUTRAL_GRADE = {
  brightness: 0,
  contrast: 1,
  saturation: 1,
  hue: 0,
  blur: 0,
} as const;

/** Trim, title and transition controls for the selected shot. */
export function ClipInspector({
  clip,
  media,
  index,
  total,
  playheadTime,
  clipStart,
  format,
  fitPolicy,
  onDispatch,
  onReorder,
  onSplit,
  onLiftOut,
}: {
  clip: Clip;
  media: MediaItemView | null;
  index: number;
  total: number;
  /** Where the bench's playhead is, in film seconds. */
  playheadTime: number;
  /** Where this shot's first frame lands, so the playhead can be read against it. */
  clipStart: number;
  /** The shape of the film — half of the question this shot's fit answers. */
  format: VideoFormat;
  /** What the film does with a mismatch, which is what "follow the film" means. */
  fitPolicy: ClipFit;
  onDispatch: (op: TimelineOp) => void;
  /**
   * Where this shot sits in the running order, and whether it's in at all,
   * are the floor's to answer — `syncCut` rebuilds both from the selections
   * table, so a change made to the document here is undone by the next vote.
   */
  onReorder: (toIndex: number) => void;
  onSplit: () => void;
  onLiftOut: () => void;
}) {
  const sourceDuration = media?.durationSeconds ?? null;
  const effective = clipDuration(clip, sourceDuration);

  /**
   * Where a split would land, in seconds into this shot. The reducer refuses
   * anything that would leave a flash frame either side; the button greys out
   * on the very same test rather than letting the press do nothing.
   */
  const splitAt = Math.round((playheadTime - clipStart) * 1000) / 1000;
  const canSplit = canSplitAt(clip, splitAt);

  const trimmedAway = sourceDuration === null ? 0 : sourceDuration - effective;

  /**
   * What this shot does with a frame it doesn't match — and first, whether it
   * is even the wrong shape.
   *
   * The mismatch is asked through `resolveFit` with a policy that differs from
   * its no-mismatch answer, rather than by comparing ratios here: the rule for
   * what counts as "the same shape" (and which way round a rotated file
   * measures) lives in one place, and a second copy of it would drift.
   */
  const frame = previewFrame(format);
  const fitInput = {
    clipWidth: media?.width,
    clipHeight: media?.height,
    clipRotation: media?.rotation,
    frameWidth: frame.width,
    frameHeight: frame.height,
  };
  const mismatched = resolveFit({ ...fitInput, fit: "auto", policy: "fill" }) === "fill";
  const followed = FIT_LABELS[fitPolicy].toLowerCase();

  function patch(p: Partial<Omit<Clip, "id">>) {
    onDispatch({ type: "clip.update", clipId: clip.id, patch: p });
  }

  /** Opens the trim window by `seconds`, split either side, within the source. */
  function grow(seconds: number) {
    if (sourceDuration === null) return;
    const end = clip.trimEnd ?? sourceDuration;
    const half = seconds / 2;
    const trimStart = Math.max(0, Math.min(clip.trimStart - half, sourceDuration - 1.2));
    const trimEnd = Math.min(sourceDuration, Math.max(end + half, trimStart + 1.2));
    patch({ trimStart: Math.round(trimStart * 100) / 100, trimEnd: Math.round(trimEnd * 100) / 100 });
  }

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
          Reordering by dragging the strip needs a mouse — HTML5 drag events
          never fire under a fingertip. Two buttons move the shot one place
          either way, which is also the quieter way to do it on a desk.
        */}
        {total > 1 && (
          <div className="mt-2 flex items-center gap-1.5">
            <button
              onClick={() => onReorder(index - 1)}
              disabled={index === 0}
              className="btn-outline-dark px-2"
              title="Move this shot earlier"
            >
              ◀ Earlier
            </button>
            <button
              onClick={() => onReorder(index + 1)}
              disabled={index === total - 1}
              className="btn-outline-dark px-2"
              title="Move this shot later"
            >
              Later ▶
            </button>
          </div>
        )}
      </div>

      <div className="space-y-5 px-4 py-4">
        {/* Trim (video) or hold time (photo) */}
        {clip.kind === "video" && sourceDuration ? (
          <div>
            <p className="eyebrow-light mb-2">Trim</p>
            <div className="space-y-3">
              <label className="block">
                <span className="timecode text-2xs text-ink-300">
                  In — {formatDuration(clip.trimStart)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={sourceDuration}
                  step={0.1}
                  value={clip.trimStart}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    const end = clip.trimEnd ?? sourceDuration;
                    // Always leave at least a slice of shot.
                    patch({ trimStart: Math.min(value, end - 0.2) });
                  }}
                  className="slider slider-dark mt-1.5"
                />
              </label>

              <label className="block">
                <span className="timecode text-2xs text-ink-300">
                  Out — {formatDuration(clip.trimEnd ?? sourceDuration)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={sourceDuration}
                  step={0.1}
                  value={clip.trimEnd ?? sourceDuration}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    patch({ trimEnd: Math.max(value, clip.trimStart + 0.2) });
                  }}
                  className="slider slider-dark mt-1.5"
                />
              </label>

              {/*
                The auto-cut takes a few seconds out of the middle of a long
                clip, so "there's more where that came from" has to be visible
                and one press away — otherwise a trimmed shot reads as a lost
                one. Both buttons grow the window around its current centre.
              */}
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => grow(-5)}
                  disabled={effective <= 1.2}
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
          <label className="block">
            <p className="eyebrow-light mb-1.5">Hold for {clip.duration.toFixed(1)}s</p>
            <input
              type="range"
              min={0.5}
              max={10}
              step={0.5}
              value={clip.duration}
              onChange={(e) => patch({ duration: Number(e.target.value) })}
              className="slider slider-dark"
            />
          </label>
        )}

        {/*
          Trimming takes the ends off a shot; this is the only way to lose a
          stretch out of its middle, or to put its second half somewhere else.
          The playhead is the aim, so the only thing left to say is whether it
          is somewhere the cut can actually land.
        */}
        <div>
          <button onClick={onSplit} disabled={!canSplit} className="btn-outline-dark w-full">
            Split at the playhead
            <span className="ml-1.5 font-mono text-2xs text-ink-400" aria-hidden>
              S
            </span>
          </button>
          <p className="mt-1.5 font-mono text-2xs leading-relaxed text-ink-500">
            {canSplit
              ? `Cuts this shot in two ${formatDuration(splitAt)} in. Both halves stay in the cut, and you can move or take out either one.`
              : "Park the playhead inside this shot, clear of both ends, to cut it in two."}
          </p>
        </div>

        {/*
          What fills the frame around this shot, when it isn't the shape of
          the film. An override of the film's own answer rather than a setting
          of its own — most shots should never need touching, and one that says
          "follow the film" goes on following it if the shape changes later.
        */}
        <div>
          <p className="eyebrow-light mb-1.5">In the frame</p>
          <div className="grid grid-cols-3 gap-px border border-[color:var(--hair-dark)]">
            {CLIP_FIT_CHOICES.map((mode) => (
              <button
                key={mode}
                onClick={() => patch({ fit: mode })}
                className={cn(
                  "px-1 py-2 font-mono text-2xs uppercase tracking-label transition-colors",
                  // "Follow the film" is the answer for almost every shot, so
                  // it gets the full width and the three overrides share a row.
                  mode === "auto" && "col-span-3",
                  clip.fit === mode
                    ? "bg-signal-600 text-paper-50"
                    : "bg-ink-900 text-ink-300 hover:bg-ink-800 hover:text-paper-100",
                )}
              >
                {FIT_LABELS[mode]}
              </button>
            ))}
          </div>
          <p className="mt-1.5 font-mono text-2xs leading-relaxed text-ink-500">
            {!mismatched
              ? "This shot is already the shape of the film, so there's nothing to fill. Your pick here only starts to show if the film's shape changes."
              : clip.fit === "auto"
                ? `The film says ${followed}. ${FIT_BLURBS[fitPolicy]}`
                : FIT_BLURBS[clip.fit]}
          </p>
        </div>

        {/*
          The move, for stills only. A photograph that drifts holds an eye the
          way footage does — which is the only reason the auto-cut will let a
          still run past four seconds.
        */}
        {clip.kind === "photo" && (
          <div>
            <p className="eyebrow-light mb-1.5">Moves</p>
            <div className="grid grid-cols-3 gap-px border border-[color:var(--hair-dark)]">
              {MOTIONS.map((mode) => (
                <button
                  key={mode}
                  onClick={() => patch({ motion: mode })}
                  title={MOTION_LABELS[mode]}
                  className={cn(
                    "flex items-center justify-center gap-1.5 py-2 font-mono text-2xs uppercase tracking-label transition-colors",
                    clip.motion === mode
                      ? "bg-signal-600 text-paper-50"
                      : "bg-ink-900 text-ink-300 hover:bg-ink-800 hover:text-paper-100",
                  )}
                >
                  <span aria-hidden>{MOTION_GLYPHS[mode]}</span>
                  {MOTION_LABELS[mode]}
                </button>
              ))}
            </div>
            {clip.auto.includes("motion") && (
              <p className="mt-1.5 font-mono text-2xs text-ink-500">
                The auto-cut&apos;s pick. Choose one and it&apos;s yours.
              </p>
            )}
          </div>
        )}

        {/* Speed, for video. */}
        {clip.kind === "video" && sourceDuration ? (
          <div>
            <p className="eyebrow-light mb-1.5">Speed</p>
            <div className="grid grid-cols-6 gap-px border border-[color:var(--hair-dark)]">
              {SPEED_PRESETS.map((rate) => (
                <button
                  key={rate}
                  onClick={() => patch({ speed: rate })}
                  className={cn(
                    "py-2 font-mono text-2xs tracking-label transition-colors",
                    clip.speed === rate
                      ? "bg-signal-600 text-paper-50"
                      : "bg-ink-900 text-ink-300 hover:bg-ink-800 hover:text-paper-100",
                  )}
                >
                  {rate}×
                </button>
              ))}
            </div>
            {clip.speed !== 1 && (
              <p className="mt-1.5 font-mono text-2xs text-ink-500">
                {formatDuration(clipSourceSpan(clip, sourceDuration))} of footage,{" "}
                {formatDuration(effective)} on screen.
              </p>
            )}
          </div>
        ) : null}

        {/* The grade. */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="eyebrow-light">Look</p>
            {isGraded(clip) && (
              <button onClick={() => patch(NEUTRAL_GRADE)} className="btn-quiet-dark px-0">
                Reset
              </button>
            )}
          </div>
          <div className="space-y-2.5">
            {GRADE_ROWS.map((row) => {
              const value = clip[row.key] as number;
              return (
                <label key={row.key} className="block">
                  <span
                    className={cn(
                      "timecode text-2xs",
                      value === row.neutral ? "text-ink-400" : "text-paper-100",
                    )}
                  >
                    {row.label}
                    {value !== row.neutral && ` — ${value}`}
                  </span>
                  <input
                    type="range"
                    min={row.min}
                    max={row.max}
                    step={row.step}
                    value={value}
                    onChange={(e) => patch({ [row.key]: Number(e.target.value) })}
                    className="slider slider-dark mt-1"
                  />
                </label>
              );
            })}
          </div>
        </div>

        {/* Transition */}
        <div>
          <p className="eyebrow-light mb-1.5">Comes in on</p>
          <div className="grid grid-cols-2 gap-px border border-[color:var(--hair-dark)]">
            {TRANSITIONS.map((mode) => (
              <button
                key={mode}
                onClick={() => patch({ transitionIn: mode })}
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
          {index === 0 && (
            <p className="mt-1.5 font-mono text-2xs text-ink-500">
              The first shot has nothing to come in from.
            </p>
          )}
          {overlapsPrevious(clip.transitionIn) && index > 0 && (
            <label className="mt-2.5 block">
              <span className="timecode text-2xs text-ink-300">
                Over {clip.transitionDuration.toFixed(1)}s
              </span>
              <input
                type="range"
                min={0.2}
                max={2}
                step={0.1}
                value={clip.transitionDuration}
                onChange={(e) => patch({ transitionDuration: Number(e.target.value) })}
                className="slider slider-dark mt-1.5"
              />
            </label>
          )}
        </div>

        {/* Audio */}
        {clip.kind === "video" && (
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
              <>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={clip.volume}
                  onChange={(e) => patch({ volume: Number(e.target.value) })}
                  className="slider slider-dark mt-2.5"
                  aria-label="Shot level"
                />
                <label className="mt-2.5 flex items-center gap-2 font-mono text-2xs uppercase tracking-label text-ink-300">
                  <input
                    type="checkbox"
                    checked={clip.duckMusic}
                    onChange={(e) => patch({ duckMusic: e.target.checked })}
                    className="check check-dark"
                  />
                  Push the music down here
                </label>
                {!clip.duckMusic && (
                  <p className="mt-1 font-mono text-2xs text-ink-500">
                    The score stays where it is over this shot.
                  </p>
                )}
              </>
            )}
          </div>
        )}

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
                <div key={title.id} className="border border-[color:var(--hair-dark)] bg-ink-900 p-2">
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

        <button
          onClick={onLiftOut}
          className="btn border-signal-700/50 bg-signal-900/30 w-full text-signal-300 hover:border-signal-500 hover:bg-signal-900/60"
        >
          Lift this shot out
        </button>
      </div>
    </section>
  );
}
