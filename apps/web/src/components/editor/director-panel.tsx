"use client";

import { useState, useTransition } from "react";
import {
  CLIP_FITS,
  FIT_BLURBS,
  FIT_LABELS,
  PACE_BLURBS,
  PACE_LABELS,
  PACE_PRESETS,
  detectScenes,
  type CutEntry,
  type Pace,
  type TimelineDoc,
} from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import type { BeatStatus } from "@/lib/beat-status";
import { runDirectorAction } from "@/lib/actions/timeline";
import { cn } from "@/lib/cn";

/**
 * A blurb that only costs a line when someone asks for it.
 *
 * The settings sheet is a column of decisions, and two lines of explanation
 * under each one turns five decisions into a scroll. The sentence is still
 * there — it just waits behind the mark next to the thing it explains.
 */
export function Blurb({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          // Some of these sit inside a <label>, where a plain click would tick
          // the box it's explaining.
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-label={`What ${label} does`}
        title={`What ${label} does`}
        className="ml-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-[color:var(--hair-dark)] align-middle font-mono text-[10px] leading-none text-ink-400 transition-colors hover:border-ink-400 hover:text-paper-100"
      >
        ?
      </button>
      {open && (
        <span className="mt-2 block text-2xs normal-case leading-relaxed tracking-normal text-ink-400">
          {children}
        </span>
      )}
    </>
  );
}

/**
 * The auto-cut's controls.
 *
 * Deliberately not in `stack-panels.tsx`: that file exists to draw a line
 * around the two hand-built stacks the vote has no opinion about, and this is
 * precisely the vote's opinion about the base track.
 *
 * Everything here goes through a server action rather than the socket, because
 * changing the pace has to be followed by a re-sync and the two can't race.
 *
 * "Re-cut from scratch" used to live at the foot of this panel, which put a
 * destructive control in the middle of the settings sheet. It's `DirectorRecut`
 * below now, pinned to the sheet's footer where the one action that ends the
 * errand belongs.
 */
export function DirectorPanel({
  slug,
  timeline,
  mediaById,
  beat,
  locked,
}: {
  slug: string;
  timeline: TimelineDoc;
  mediaById: Map<string, MediaItemView>;
  /** Whether there's a pulse to cut to, and the reason when there isn't. */
  beat: BeatStatus;
  locked: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const director = timeline.director;

  // The same scene detection the floor shows, so both rooms agree on where the
  // days break.
  const cut: CutEntry[] = timeline.clips.map((c) => {
    const media = mediaById.get(c.mediaItemId);
    return {
      mediaItemId: c.mediaItemId,
      kind: c.kind,
      durationSeconds: media?.durationSeconds ?? null,
      capturedAt: media?.capturedAt ? new Date(media.capturedAt).getTime() : null,
      rank: media?.reactions.rank ?? 0,
    };
  });
  const scenes = detectScenes(cut);

  function run(input: Parameters<typeof runDirectorAction>[1]) {
    setError(null);
    startTransition(async () => {
      const result = await runDirectorAction(slug, input);
      if (!result.ok) setError(result.error);
    });
  }

  const blurb =
    scenes.length > 1
      ? `${timeline.clips.length} shots across ${scenes.length} scenes, timed by the crew's marks.`
      : "Every shot timed by the crew's marks.";

  return (
    <section>
      <div className="border-b border-[color:var(--hair-dark)] px-4 py-3">
        <p className="text-[13px] leading-relaxed text-ink-300">{blurb}</p>
      </div>

      <div className="space-y-5 px-4 py-4">
        <div>
          <p className="eyebrow-light mb-2">Pace</p>
          <div className="grid grid-cols-3 gap-1">
            {PACE_PRESETS.map((pace: Pace) => (
              <button
                key={pace}
                type="button"
                disabled={locked || pending}
                onClick={() => run({ settings: { pace } })}
                className={cn(
                  "border px-2 py-2 text-xs transition-colors disabled:opacity-50",
                  director.pace === pace
                    ? "border-paper-100 bg-paper-100 text-ink-900"
                    : "border-[color:var(--hair-dark)] text-ink-300 hover:text-paper-100",
                )}
              >
                {PACE_LABELS[pace]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-2xs leading-relaxed text-ink-400">
            {PACE_BLURBS[director.pace]}
          </p>
        </div>

        {/*
          The default every shot of the wrong shape starts from, and open to
          anyone: you can already reframe any single shot from the inspector, so
          gating the default would be a lock with the door open. The frame, at
          the top of the same sheet, is open for exactly the same reason. It
          rides on the same open action as the pace above. This is the only
          place the policy is explained — the frame panel used to say it again
          in different words.
        */}
        <div>
          <p className="eyebrow-light mb-2">
            Shots of the wrong shape
            <Blurb label="the wrong-shape setting">
              {FIT_BLURBS[director.fitPolicy]} Shots already pointing the right way are left
              alone, and any one shot can be set its own way from the shot panel.
            </Blurb>
          </p>
          <div className="grid grid-cols-3 gap-1">
            {CLIP_FITS.map((option) => (
              <button
                key={option}
                type="button"
                disabled={locked || pending}
                onClick={() => run({ settings: { fitPolicy: option } })}
                className={cn(
                  "border px-2 py-2 text-xs transition-colors disabled:opacity-50",
                  director.fitPolicy === option
                    ? "border-paper-100 bg-paper-100 text-ink-900"
                    : "border-[color:var(--hair-dark)] text-ink-300 hover:text-paper-100",
                )}
              >
                {FIT_LABELS[option]}
              </button>
            ))}
          </div>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={director.sceneText}
            disabled={locked || pending}
            onChange={(e) => run({ settings: { sceneText: e.target.checked } })}
            className="mt-0.5 accent-paper-100"
          />
          <span>
            <span className="block text-[13px] text-paper-100">Name the scenes on screen</span>
            <span className="block text-2xs leading-relaxed text-ink-400">
              Burns the day and time over the first shot of each scene — &ldquo;Saturday
              morning&rdquo;.
            </span>
          </span>
        </label>

        {/*
          Offered only when there's something to cut to. A tickable box that
          provably changes nothing is a bug report waiting to happen, so when
          the bed has no pulse the box goes flat and says why instead.
        */}
        <label
          className={cn(
            "flex items-start gap-2.5",
            beat.grid ? "cursor-pointer" : "cursor-not-allowed",
          )}
        >
          <input
            type="checkbox"
            checked={director.beatSnap}
            disabled={locked || pending || !beat.grid}
            onChange={(e) => run({ settings: { beatSnap: e.target.checked } })}
            className="mt-0.5 accent-paper-100 disabled:opacity-50"
          />
          <span>
            <span className={cn("block text-[13px]", beat.grid ? "text-paper-100" : "text-ink-400")}>
              Cut on the beat
              {beat.grid && (
                <Blurb label="cutting on the beat">
                  Nudges each cut onto the nearest beat of the music —{" "}
                  {Math.round(beat.grid.bpm)} bpm, marked along the ruler. Shots keep the length
                  the crew&rsquo;s marks bought them; only the exact moment moves.
                </Blurb>
              )}
            </span>
            {/* When there's nothing to cut to, the reason isn't an aside — it's
                why the box is flat, so it stays on screen. */}
            {!beat.grid && (
              <span className="block text-2xs leading-relaxed text-ink-400">{beat.reason}</span>
            )}
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={director.enabled}
            disabled={locked || pending}
            onChange={(e) => run({ settings: { enabled: e.target.checked } })}
            className="mt-0.5 accent-paper-100"
          />
          <span>
            <span className="block text-[13px] text-paper-100">Let the vote set the lengths</span>
            <span className="block text-2xs leading-relaxed text-ink-400">
              Turn this off and new shots arrive at their full recorded length.
            </span>
          </span>
        </label>

        {error && <p className="text-2xs text-rust-400">{error}</p>}
      </div>
    </section>
  );
}

/**
 * "Start again", on its own.
 *
 * It's the settings sheet's footer rather than a row in the middle of it: the
 * one control here that throws work away shouldn't be something you scroll
 * past on the way to the pace buttons, and a sticky footer is where the action
 * that ends an errand already lives on this bench.
 */
export function DirectorRecut({
  slug,
  timeline,
  locked,
}: {
  slug: string;
  timeline: TimelineDoc;
  locked: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const handCut = timeline.clips.filter((c) => c.auto.length === 0).length;

  function recut() {
    setError(null);
    startTransition(async () => {
      const result = await runDirectorAction(slug, { recut: true });
      if (!result.ok) setError(result.error);
      else setConfirming(false);
    });
  }

  return (
    <div>
      {confirming ? (
        <div className="space-y-2">
          <p className="text-[13px] leading-relaxed text-paper-100">
            {handCut > 0
              ? `This puts all ${timeline.clips.length} shots back to the length the crew's marks suggest — including the ${handCut} ${handCut === 1 ? "you've" : "you've"} trimmed by hand. There's no undo.`
              : "This puts every shot back to the length the crew's marks suggest. There's no undo."}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={recut}
              className="flex-1 border border-rust-400 bg-rust-400 px-3 py-2 text-xs text-ink-900 disabled:opacity-50"
            >
              {pending ? "Re-cutting…" : "Yes, start again"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirming(false)}
              className="border border-[color:var(--hair-dark)] px-3 py-2 text-xs text-ink-300 hover:text-paper-100"
            >
              Keep my cut
            </button>
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            disabled={locked || pending || timeline.clips.length === 0}
            onClick={() => setConfirming(true)}
            className="w-full border border-[color:var(--hair-dark)] px-3 py-2 text-xs text-ink-300 transition-colors hover:text-paper-100 disabled:opacity-50"
          >
            Re-cut from scratch
          </button>
          {handCut > 0 && (
            <p className="mt-2 text-2xs leading-relaxed text-ink-400">
              {handCut} {handCut === 1 ? "shot is" : "shots are"} cut by hand — the auto-cut
              leaves {handCut === 1 ? "it" : "them"} alone.
            </p>
          )}
        </>
      )}
      {error && <p className="mt-2 text-2xs text-rust-400">{error}</p>}
    </div>
  );
}
