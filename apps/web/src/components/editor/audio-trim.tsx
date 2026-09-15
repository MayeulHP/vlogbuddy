"use client";

import { MIN_CLIP_SPAN, formatDuration, formatFine } from "@vlogbuddy/shared";
import { TrimBar, clamp, round2 } from "./trim-bar";

/** The two fields that decide which stretch of a sound file gets used. */
export interface AudioTrimPatch {
  offset?: number;
  duration?: number | null;
}

/**
 * Which part of a track plays, as one bar.
 *
 * `offset` and `duration` are the same edit seen from two ends — where to drop
 * the needle, and when to lift it — but as two sliders they read as unrelated
 * numbers, and neither shows the one thing that matters: how much of the record
 * you're actually using. Here they're the in and out points of a window inside
 * the file, and the file is the bar.
 *
 * `duration: null` is a real setting, not a blank: the track keeps playing
 * until the picture runs out. So the window has no out handle then — it runs
 * off the right of the bar — rather than a handle parked at the end of the file
 * pretending someone chose it.
 */
export function AudioTrim({
  offset,
  duration,
  sourceDuration,
  tall = false,
  disabled = false,
  onChange,
  onScrub,
}: {
  offset: number;
  duration: number | null;
  /** How long the sound file runs, when we know. Null before it's extracted. */
  sourceDuration: number | null;
  tall?: boolean;
  disabled?: boolean;
  onChange: (patch: AudioTrimPatch) => void;
  /** Where a handle is inside the sound file, so the room can play from there. */
  onScrub?: (seconds: number) => void;
}) {
  if (sourceDuration === null || sourceDuration < MIN_CLIP_SPAN * 2) {
    return <BlindTrim offset={offset} duration={duration} disabled={disabled} onChange={onChange} />;
  }

  const source = sourceDuration;
  const inPoint = clamp(offset, 0, source - MIN_CLIP_SPAN);
  const openEnd = duration === null;
  const outPoint = openEnd ? source : clamp(inPoint + duration, inPoint + MIN_CLIP_SPAN, source);
  const untouched = offset === 0 && openEnd;

  return (
    <div className="space-y-2.5">
      <TrimBar
        source={source}
        start={inPoint}
        end={outPoint}
        openEnd={openEnd}
        tall={tall}
        onScrub={onScrub}
        onChange={(next) => {
          if (next.start !== undefined) {
            // Dragging the needle later shouldn't also make the track play
            // longer: the out point stays where it was put, so the window
            // shortens instead of sliding.
            onChange(
              openEnd
                ? { offset: next.start }
                : { offset: next.start, duration: round2(outPoint - next.start) },
            );
          }
          if (next.end !== undefined) onChange({ duration: round2(next.end - inPoint) });
        }}
      />

      <label className="flex items-center gap-2 font-mono text-2xs uppercase tracking-label text-ink-300">
        <input
          type="checkbox"
          checked={openEnd}
          disabled={disabled}
          onChange={(e) =>
            onChange({
              duration: e.target.checked
                ? null
                : // Lifting the needle has to start somewhere, and the rest of
                  // the file is the only answer that changes nothing audible.
                  round2(Math.max(MIN_CLIP_SPAN, source - inPoint)),
            })
          }
          className="check check-dark"
        />
        Let it play out
      </label>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onChange({ offset: 0, duration: null })}
          disabled={disabled || untouched}
          className="btn-outline-dark px-2.5 font-sans text-2xs normal-case tracking-normal text-ink-300 hover:text-paper-100"
        >
          Use all {formatDuration(source)}
        </button>
      </div>

      <p className="text-2xs leading-relaxed text-ink-400">
        {untouched
          ? `The whole ${formatDuration(source)}, from the top.`
          : openEnd
            ? `From ${formatFine(inPoint)} in, until the picture ends.`
            : `${formatDuration(outPoint - inPoint)} of ${formatDuration(source)}, starting ${formatFine(inPoint)} in.`}
      </p>
    </div>
  );
}

/**
 * Trimming a track whose file hasn't landed yet.
 *
 * There's no bar to draw without a length, and a bar drawn against a guess is
 * worse than none — so this falls back to stepping the needle by ear, which is
 * all anyone could do here anyway.
 */
function BlindTrim({
  offset,
  duration,
  disabled,
  onChange,
}: {
  offset: number;
  duration: number | null;
  disabled: boolean;
  onChange: (patch: AudioTrimPatch) => void;
}) {
  return (
    <div className="space-y-2.5">
      <p className="text-2xs leading-relaxed text-ink-400">
        We don&apos;t know how long this one runs yet, so there&apos;s nothing to trim against.
        You can still skip into it by ear.
      </p>

      <Stepper
        label="Starts"
        value={offset}
        disabled={disabled}
        onStep={(delta) => onChange({ offset: round2(Math.max(0, offset + delta)) })}
      />

      <label className="flex items-center gap-2 font-mono text-2xs uppercase tracking-label text-ink-300">
        <input
          type="checkbox"
          checked={duration === null}
          disabled={disabled}
          onChange={(e) => onChange({ duration: e.target.checked ? null : 30 })}
          className="check check-dark"
        />
        Let it play out
      </label>

      {duration !== null && (
        <Stepper
          label="Plays for"
          value={duration}
          disabled={disabled}
          onStep={(delta) =>
            onChange({ duration: round2(Math.max(MIN_CLIP_SPAN, duration + delta)) })
          }
        />
      )}
    </div>
  );
}

function Stepper({
  label,
  value,
  disabled,
  onStep,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onStep: (delta: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="timecode mr-auto text-2xs text-ink-300">
        {label} {formatFine(value)}
      </span>
      {[-5, -1, 1, 5].map((delta) => (
        <button
          key={delta}
          type="button"
          onClick={() => onStep(delta)}
          disabled={disabled || (delta < 0 && value <= 0)}
          aria-label={`${label} ${delta > 0 ? "later" : "earlier"} by ${Math.abs(delta)} seconds`}
          className="btn-outline-dark px-2.5 font-sans text-2xs normal-case tracking-normal text-ink-300 hover:text-paper-100 min-w-[34px]"
        >
          {delta > 0 ? `+${delta}` : delta}s
        </button>
      ))}
    </div>
  );
}
