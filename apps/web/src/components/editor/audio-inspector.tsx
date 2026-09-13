"use client";

import {
  audioTrackSpan,
  formatDuration,
  type AudioTrack,
  type TimelineOp,
} from "@vlogbuddy/shared";

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
      : "The sound didn't come through. Try adding the track again, or drop an audio file on the floor instead.";
  }
  return sound.fromLink
    ? "This link sets the mood, but there's no audio file behind it — so it stays quiet here and in the finished film. Drop an audio file on the floor to hear it."
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
  onDispatch,
  onRemove,
}: {
  track: AudioTrack;
  label: string;
  totalDuration: number;
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

  function patch(p: Partial<Omit<AudioTrack, "id">>) {
    onDispatch({ type: "audio.update", trackId: track.id, patch: p });
  }

  return (
    <section className="border border-[color:var(--hair-dark)] bg-ink-850">
      <div className="border-b border-[color:var(--hair-dark)] px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="eyebrow-light">{track.role === "bed" ? "The bed" : "Sound"}</p>
          <p className="timecode text-sm text-paper-100">{formatDuration(span)}</p>
        </div>
        <p className="timecode mt-1 truncate text-2xs text-ink-400" title={label}>
          {label}
        </p>
        {track.role === "bed" && (
          <p className="mt-1 font-mono text-2xs text-ink-500">
            Whatever the crew voted up. Swap it on the floor.
          </p>
        )}
      </div>

      {note && (
        <p className="border-b border-[color:var(--hair-dark)] bg-ink-900 px-4 py-3 text-[13px] leading-relaxed text-ink-300">
          {note}
        </p>
      )}

      <div className="space-y-4 px-4 py-4">
        <label className="block">
          <span className="eyebrow-light">Level — {Math.round(track.volume * 100)}%</span>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.05}
            value={track.volume}
            onChange={(e) => patch({ volume: Number(e.target.value) })}
            className="slider slider-dark mt-1.5"
          />
        </label>

        <label className="block">
          <span className="timecode text-2xs text-ink-300">
            Comes in at {formatDuration(track.startAt)}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(0.5, totalDuration)}
            step={0.05}
            value={Math.min(track.startAt, totalDuration)}
            onChange={(e) => patch({ startAt: Number(e.target.value) })}
            className="slider slider-dark mt-1.5"
          />
        </label>

        <div>
          <label className="flex items-center gap-2 font-mono text-2xs uppercase tracking-label text-ink-300">
            <input
              type="checkbox"
              checked={track.duration === null}
              onChange={(e) => patch({ duration: e.target.checked ? null : span })}
              className="check check-dark"
            />
            Run to the end
          </label>
          {track.duration !== null && (
            <label className="mt-2 block">
              <span className="timecode text-2xs text-ink-300">
                Plays for {formatDuration(track.duration)}
              </span>
              <input
                type="range"
                min={0.2}
                max={Math.max(1, totalDuration)}
                step={0.1}
                value={track.duration}
                onChange={(e) => patch({ duration: Number(e.target.value) })}
                className="slider slider-dark mt-1.5"
              />
            </label>
          )}
        </div>

        <label className="block">
          <span className="timecode text-2xs text-ink-300">
            Skip {formatDuration(track.offset)} into the file
          </span>
          <input
            type="range"
            min={0}
            max={120}
            step={0.5}
            value={track.offset}
            onChange={(e) => patch({ offset: Number(e.target.value) })}
            className="slider slider-dark mt-1.5"
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="eyebrow-light">Fade in {track.fadeIn.toFixed(1)}s</span>
            <input
              type="range"
              min={0}
              max={6}
              step={0.1}
              value={track.fadeIn}
              onChange={(e) => patch({ fadeIn: Number(e.target.value) })}
              className="slider slider-dark mt-1.5"
            />
          </label>
          <label className="block">
            <span className="eyebrow-light">Fade out {track.fadeOut.toFixed(1)}s</span>
            <input
              type="range"
              min={0}
              max={6}
              step={0.1}
              value={track.fadeOut}
              onChange={(e) => patch({ fadeOut: Number(e.target.value) })}
              className="slider slider-dark mt-1.5"
            />
          </label>
        </div>

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
            Hold it out of the mix
          </label>
        </div>

        <button
          onClick={onRemove}
          className="btn border-signal-700/50 bg-signal-900/30 w-full text-signal-300 hover:border-signal-500 hover:bg-signal-900/60"
        >
          {track.role === "bed" ? "Play it dry" : "Pull this track"}
        </button>
      </div>
    </section>
  );
}
