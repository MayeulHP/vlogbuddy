"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * A range slider with the number written next to it, editable.
 *
 * A slider is the right control for "a bit more than that" and the wrong one
 * for "exactly 0.6" — on a 260px panel a tenth of a second can be a pixel, and
 * two layers that should agree can't be made to. The box is the exact answer
 * and the slider is the feel of it; they're the same value, so one moves with
 * the other. It's hidden below `sm` because a phone has neither the width for
 * it nor a keyboard worth typing into.
 *
 * The box keeps its own text while it's being typed in: a half-typed "0." is
 * not a number, and pushing every keystroke through the reducer would fight
 * the person holding the keyboard. The value is committed on change of the
 * slider, and on blur or Enter for the box.
 */
export function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  ariaLabel,
  decimals = 2,
  className,
}: {
  /** The line above the control — usually the value read out in words. */
  label: React.ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  /** Digits the box shows; sliders here carry anything from 0.05 to whole %. */
  decimals?: number;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  // Someone else's edit (an undo, a recut, another browser) has to land in the
  // box too — but not while it's being typed in.
  useEffect(() => setDraft(null), [value]);

  function commit(text: string) {
    setDraft(null);
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(max, Math.max(min, parsed));
    if (clamped !== value) onChange(clamped);
  }

  const shown = draft ?? String(Number(value.toFixed(decimals)));

  return (
    <div className={cn("block", className)}>
      {label}
      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="slider slider-dark min-w-0 flex-1"
          aria-label={ariaLabel}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(e.currentTarget.value);
            }
          }}
          className="field-dark timecode hidden w-14 shrink-0 py-0.5 text-2xs sm:block"
          aria-label={ariaLabel}
        />
      </div>
    </div>
  );
}
