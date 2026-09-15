"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  audioTrackSpan,
  formatDuration,
  type AudioTrack,
  type TimelineOp,
} from "@vlogbuddy/shared";
import { getAudioSourceLengthAction } from "@/lib/actions/audio-trim";
import { AudioTrim } from "./audio-trim";
import { Section } from "./section";
import { SliderField } from "./slider-field";
import type { PreviewTransport } from "./preview-player";

export interface SoundState {
  /** True once there's a file the preview and the render can actually play. */
  playable: boolean;
  status: "pending" | "processing" | "ready" | "failed";
  error?: string | null;
  /** A pasted link, as opposed to an uploaded audio file. */
  fromLink: boolean;
}

/** Plain words for why a track isn't making any noise yet. */
function soundNote(sound: SoundState): string | null {
  if (sound.playable) return null;
  if (sound.status === "pending" || sound.status === "processing") {
    return "We're still fetching the sound for this one. It'll start playing here as soon as it lands — give it a minute.";
  }
  if (sound.status === "failed") {
    return sound.error
      ? `The sound didn't come through: ${sound.error}`
      : "The sound didn't come through. Try adding the track again, or drop an audio file on the Trip page instead.";
  }
  return sound.fromLink
    ? "This link sets the mood, but there's no audio file behind it — so it stays quiet here and in the finished film. Drop an audio file on the Trip page to hear it."
    : "There's no audio file behind this track yet, so it plays silent.";
}

/**
 * One track in the stack. The bed is the crew's — it follows whatever the
 * soundtrack lane picked — so its source is read-only here while everything
 * about how it plays is not.
 */
export function AudioInspector({
  track,
  label,
  totalDuration,
  sound,
  src,
  transportRef,
  onDispatch,
  onRemove,
}: {
  track: AudioTrack;
  label: string;
  totalDuration: number;
  /**
   * The file this track plays, so it can be heard on its own. Auditioning one
   * track means hearing it *without* the rest of the mix, which the shared
   * transport can't do without lying about what the film sounds like — so this
   * room gets its own element, and gives way the moment the transport starts.
   */
  src?: string | null;
  /** Watched, not driven: the film playing is this audition's cue to stop. */
  transportRef?: React.MutableRefObject<PreviewTransport | null>;
  /**
   * Where this track's actual file is up to. A link pointing at a fetch that
   * hasn't finished has nothing to play, and silence on its own is impossible
   * to tell apart from a bug.
   */
  sound?: SoundState;
  onDispatch: (op: TimelineOp) => void;
  /** The bed is dropped through the cut engine, not by editing the document. */
  onRemove: () => void;
}) {
  const span = audioTrackSpan(track, totalDuration);
  const note = sound ? soundNote(sound) : null;

  /**
   * The bench holds the document, which knows which file a track points at but
   * not how long it runs — and there's no window to trim without the length of
   * the thing it's cut from. The slug comes off the route because the inspector
   * is only ever mounted inside one vlog.
   */
  const { slug } = useParams<{ slug: string }>();
  // `undefined` while it's being read — a bar drawn from "no length yet" and
  // one drawn from "there is no length" say very different things.
  const [sourceDuration, setSourceDuration] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setSourceDuration(undefined);
    if (!slug) return;
    void getAudioSourceLengthAction(slug, track.id).then((res) => {
      if (live && res.ok) setSourceDuration(res.sourceDuration);
    });
    return () => {
      live = false;
    };
    // The source itself can change under a track: the cut engine re-points the
    // bed whenever the crew votes up a different record.
  }, [slug, track.id, track.musicItemId, track.mediaItemId]);

  /** The solo player: this track's file, nothing under it. */
  const auditionRef = useRef<HTMLAudioElement>(null);
  const [auditioning, setAuditioning] = useState(false);

  function stopAudition() {
    const el = auditionRef.current;
    if (el && !el.paused) el.pause();
    setAuditioning(false);
  }

  // Two tracks auditioning at once, or one left playing under a film that has
  // since started, would both be the panel talking over the transport.
  useEffect(() => {
    return () => stopAudition();
  }, [track.id, src]);

  useEffect(() => {
    const transport = transportRef?.current;
    if (!transport) return;
    return transport.subscribe(({ playing }) => {
      if (playing) stopAudition();
    });
  }, [transportRef]);

  function toggleAudition() {
    const el = auditionRef.current;
    if (!el) return;
    if (auditioning) {
      stopAudition();
      return;
    }
    // The transport owns the sound while it's running; this takes it over.
    transportRef?.current?.stop();
    el.currentTime = track.offset;
    el.volume = Math.min(1, track.volume);
    setAuditioning(true);
    void el.play().catch(() => setAuditioning(false));
  }

  /** Drop the needle where the handle is, so a drag is heard and not guessed. */
  function scrubAudio(seconds: number) {
    const el = auditionRef.current;
    if (!el) return;
    try {
      el.currentTime = Math.max(0, seconds);
    } catch {
      // Before the file's metadata lands there's nowhere to seek to; the next
      // press of play starts from the offset anyway.
    }
  }

  function patch(p: Partial<Omit<AudioTrack, "id">>) {
    onDispatch({ type: "audio.update", trackId: track.id, patch: p });
  }

  /** What a folded-up section is hiding — see the clip inspector's note. */
  const trimSummary = track.duration === null ? null : formatDuration(track.duration);
  const levelSummary =
    [
      track.volume !== 1 ? `${Math.round(track.volume * 100)}%` : null,
      track.startAt > 0 ? `in at ${formatDuration(track.startAt)}` : null,
      track.fadeIn > 0 || track.fadeOut > 0
        ? `${track.fadeIn.toFixed(1)}s / ${track.fadeOut.toFixed(1)}s`
        : null,
    ]
      .filter(Boolean)
      .join(" · ") || null;
  const optionsSummary =
    [track.muted ? "Muted" : null, track.loop ? "Loops" : null].filter(Boolean).join(" · ") ||
    null;

  return (
    <section className="border border-[color:var(--hair-dark)] bg-ink-850">
      <div className="border-b border-[color:var(--hair-dark)] px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="eyebrow-light">{track.role === "bed" ? "Music" : "Sound"}</p>
          <p className="timecode text-sm text-paper-100">{formatDuration(span)}</p>
        </div>
        <p className="timecode mt-1 truncate text-2xs text-ink-400" title={label}>
          {label}
        </p>
        {track.role === "bed" && (
          <p className="mt-1 font-mono text-2xs text-ink-400">
            Whatever the crew voted up. Swap it on the Trip page.
          </p>
        )}
      </div>

      {note && (
        <p className="border-b border-[color:var(--hair-dark)] bg-ink-900 px-4 py-3 text-[13px] leading-relaxed text-ink-300">
          {note}
        </p>
      )}

      <div className="px-4 pb-4">
        <Section storageKey="audio.trim" title="Trim & audition" summary={trimSummary} defaultOpen>
          <div>
            {sourceDuration === undefined ? (
              <p className="font-mono text-2xs text-ink-400">Measuring the track…</p>
            ) : (
              <AudioTrim
                offset={track.offset}
                duration={track.duration}
                sourceDuration={sourceDuration}
                onChange={patch}
                onScrub={scrubAudio}
              />
            )}

            {src && (
              <div className="mt-2.5">
                <button
                  onClick={toggleAudition}
                  className="btn-outline-dark px-2.5 font-sans text-2xs normal-case tracking-normal"
                >
                  {auditioning ? "❙❙ Stop" : "▶ Play this track"}
                </button>
                <p className="mt-1.5 text-2xs leading-relaxed text-ink-400">
                  Just this one, on its own — the film stays where it is.
                </p>
                <audio
                  ref={auditionRef}
                  src={src}
                  preload="metadata"
                  className="hidden"
                  onTimeUpdate={(e) => {
                    // Lift the needle where the out point is, the same place the
                    // mix would.
                    if (track.duration === null) return;
                    if (e.currentTarget.currentTime >= track.offset + track.duration)
                      stopAudition();
                  }}
                  onEnded={() => setAuditioning(false)}
                />
              </div>
            )}
          </div>
        </Section>

        <Section storageKey="audio.level" title="Level & fades" summary={levelSummary}>
          <SliderField
            label={<span className="eyebrow-light">Level — {Math.round(track.volume * 100)}%</span>}
            value={track.volume}
            min={0}
            max={1.5}
            step={0.05}
            onChange={(v) => patch({ volume: v })}
            ariaLabel="Track level"
          />

          <SliderField
            label={
              <span className="timecode text-2xs text-ink-300">
                Comes in at {formatDuration(track.startAt)}
              </span>
            }
            value={Math.min(track.startAt, totalDuration)}
            min={0}
            max={Math.max(0.5, totalDuration)}
            step={0.05}
            onChange={(v) => patch({ startAt: v })}
            ariaLabel="Where the track comes in, in seconds"
          />

          <div className="grid grid-cols-2 gap-2">
            <SliderField
              label={<span className="eyebrow-light">Fade in {track.fadeIn.toFixed(1)}s</span>}
              value={track.fadeIn}
              min={0}
              max={6}
              step={0.1}
              decimals={1}
              onChange={(v) => patch({ fadeIn: v })}
              ariaLabel="Track fade in, in seconds"
            />
            <SliderField
              label={<span className="eyebrow-light">Fade out {track.fadeOut.toFixed(1)}s</span>}
              value={track.fadeOut}
              min={0}
              max={6}
              step={0.1}
              decimals={1}
              onChange={(v) => patch({ fadeOut: v })}
              ariaLabel="Track fade out, in seconds"
            />
          </div>
        </Section>

        <Section storageKey="audio.options" title="Options" summary={optionsSummary}>
          <div className="space-y-2">
            <label className="flex items-center gap-2 font-mono text-2xs uppercase tracking-label text-ink-300">
              <input
                type="checkbox"
                checked={track.loop}
                onChange={(e) => patch({ loop: e.target.checked })}
                className="check check-dark"
              />
              Loop it if it runs short
            </label>
            <label className="flex items-center gap-2 font-mono text-2xs uppercase tracking-label text-ink-300">
              <input
                type="checkbox"
                checked={track.muted}
                onChange={(e) => patch({ muted: e.target.checked })}
                className="check check-dark"
              />
              Mute it
            </label>
          </div>
        </Section>

        {/*
          The same verb as the other two inspectors — except for the bed, which
          can't be taken out: the cut engine puts one back the moment the crew
          has a favourite record. What you can do is run the film without it.
        */}
        <div className="border-t border-[color:var(--hair-dark)] pt-4">
          <button
            onClick={onRemove}
            className="btn border-signal-700/50 bg-signal-900/30 w-full text-signal-300 hover:border-signal-500 hover:bg-signal-900/60"
          >
            {track.role === "bed" ? "Play it dry" : "Take this track out"}
          </button>
          <p className="mt-1 text-2xs text-ink-400">
            {track.role === "bed"
              ? "Runs the film with no music under it. Vote up a record on the Trip page to get the music back."
              : "Lifts it out of the mix. The track stays on the Trip page."}
          </p>
        </div>
      </div>
    </section>
  );
}
