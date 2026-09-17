"use client";

import { useState } from "react";
import {
  MAX_LAYERS,
  audioTrackSpan,
  defaultAudioTrack,
  defaultLayerFor,
  formatDuration,
  type TimelineDoc,
  type TimelineOp,
} from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import { cn } from "@/lib/cn";
import { audioTrackLabel } from "./timeline-tracks";
import type { Selection } from "./selection";

/**
 * The two stacks either side of the picture: what's laid over it, and what's
 * playing under it. Both are hand-built — the vote has no opinion about
 * either, beyond which track it made the bed.
 */

export function LayerPanel({
  timeline,
  media,
  mediaById,
  playheadTime,
  selection,
  onSelect,
  onDispatch,
}: {
  timeline: TimelineDoc;
  media: MediaItemView[];
  mediaById: Map<string, MediaItemView>;
  playheadTime: number;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onDispatch: (op: TimelineOp) => void;
}) {
  const [picking, setPicking] = useState(false);
  const footage = media.filter((m) => m.kind !== "audio" && m.status === "ready");

  /** New layers go on the lowest empty shelf, so they don't hide each other. */
  function nextLane(): number {
    const used = new Set(timeline.layers.map((l) => l.layer));
    for (let n = 1; n <= MAX_LAYERS; n++) if (!used.has(n)) return n;
    return 1;
  }

  const ordered = [...timeline.layers].sort(
    (a, b) => b.layer - a.layer || a.startAt - b.startAt,
  );

  return (
    <section className="border border-[color:var(--hair-dark)] bg-ink-850">
      <div className="flex items-start justify-between gap-2 border-b border-[color:var(--hair-dark)] px-4 py-3">
        <div>
          <p className="eyebrow-light">Over the top</p>
          <h3 className="headline mt-0.5 text-xl text-paper-100">Layers</h3>
          <p className="mt-1 font-mono text-2xs uppercase tracking-label text-ink-500">
            Pinned to the clock, not to a shot
          </p>
        </div>
        <button onClick={() => setPicking((p) => !p)} className="btn-quiet-dark shrink-0 px-0">
          {picking ? "Close" : "+ Add"}
        </button>
      </div>

      {picking && (
        <div className="max-h-56 overflow-y-auto border-b border-[color:var(--hair-dark)]">
          {footage.length === 0 ? (
            <p className="px-4 py-3 font-mono text-2xs text-ink-500">
              Nothing in the pile is ready yet.
            </p>
          ) : (
            footage.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  onDispatch({
                    type: "layer.add",
                    layer: defaultLayerFor(
                      {
                        mediaItemId: item.id,
                        kind: item.kind === "video" ? "video" : "photo",
                        durationSeconds: item.durationSeconds,
                      },
                      playheadTime,
                      nextLane(),
                    ),
                  });
                  setPicking(false);
                }}
                className="flex min-h-[44px] w-full items-center gap-2 border-b border-[color:var(--hair-dark)] px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-ink-800"
              >
                {item.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.thumbnailUrl} alt="" className="h-8 w-12 shrink-0 object-cover" />
                ) : (
                  <span className="h-8 w-12 shrink-0 bg-ink-800 bg-hatch" />
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-ink-200">
                  {item.originalFilename}
                </span>
                <span className="eyebrow-light shrink-0">{item.kind}</span>
              </button>
            ))
          )}
        </div>
      )}

      {ordered.length === 0 ? (
        <p className="px-4 py-3 text-[13px] leading-relaxed text-ink-400">
          Nothing over the picture yet. Add a shot here and it floats above the cut — a reaction in
          the corner, a still held over a wide.
        </p>
      ) : (
        <div className="divide-y divide-[color:var(--hair-dark)]">
          {ordered.map((layer) => {
            const item = mediaById.get(layer.mediaItemId);
            const active = selection.kind === "layer" && selection.id === layer.id;
            return (
              <button
                key={layer.id}
                onClick={() => onSelect({ kind: "layer", id: layer.id })}
                className={cn(
                  "flex min-h-[44px] w-full items-center gap-2 px-4 py-2.5 text-left text-xs transition-colors",
                  active
                    ? "bg-signal-900/40 text-paper-100"
                    : "text-ink-300 hover:bg-ink-800 hover:text-paper-200",
                )}
              >
                <span className="eyebrow-light w-6 shrink-0">L{layer.layer}</span>
                <span className="min-w-0 flex-1 truncate">
                  {item?.originalFilename ?? "Missing source"}
                </span>
                <span className="timecode shrink-0 text-2xs text-ink-400">
                  {formatDuration(layer.startAt)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function SoundPanel({
  timeline,
  music,
  media,
  mediaById,
  musicById,
  totalDuration,
  playheadTime,
  selection,
  onSelect,
  onDispatch,
  onChooseBedMusic,
}: {
  timeline: TimelineDoc;
  music: MusicItemView[];
  media: MediaItemView[];
  mediaById: Map<string, MediaItemView>;
  musicById: Map<string, MusicItemView>;
  totalDuration: number;
  playheadTime: number;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onDispatch: (op: TimelineOp) => void;
  /** Streaming beds go through the cut engine so the floor agrees with us. */
  onChooseBedMusic: (musicItemId: string | null) => void;
}) {
  const [picking, setPicking] = useState(false);
  const bed = timeline.audio.find((t) => t.role === "bed") ?? null;
  const audioUploads = media.filter((m) => m.contentType.startsWith("audio/"));

  function setUploadedBed(mediaItemId: string) {
    if (bed) {
      onDispatch({
        type: "audio.update",
        trackId: bed.id,
        patch: { mediaItemId, musicItemId: null, offset: 0 },
      });
    } else {
      onDispatch({
        type: "audio.add",
        track: { ...defaultAudioTrack({ mediaItemId }), role: "bed", volume: 0.8, fadeIn: 1, fadeOut: 2 },
      });
    }
  }

  function playDry() {
    if (bed) onDispatch({ type: "audio.remove", trackId: bed.id });
    onChooseBedMusic(null);
  }

  return (
    <section className="border border-[color:var(--hair-dark)] bg-ink-850">
      <div className="flex items-start justify-between gap-2 border-b border-[color:var(--hair-dark)] px-4 py-3">
        <div>
          <p className="eyebrow-light">Score</p>
          <h3 className="headline mt-0.5 text-xl text-paper-100">The mix</h3>
          <p className="mt-1 font-mono text-2xs uppercase tracking-label text-ink-500">
            A bed, plus anything you drop on top
          </p>
        </div>
        <button onClick={() => setPicking((p) => !p)} className="btn-quiet-dark shrink-0 px-0">
          {picking ? "Close" : "+ Add"}
        </button>
      </div>

      {picking && (
        <div className="max-h-56 overflow-y-auto border-b border-[color:var(--hair-dark)]">
          {audioUploads.length === 0 && music.length === 0 ? (
            <p className="px-4 py-3 font-mono text-2xs text-ink-500">
              No sound in the pile yet. Drop an audio file or paste a link on the floor.
            </p>
          ) : (
            <>
              {audioUploads.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    onDispatch({
                      type: "audio.add",
                      track: defaultAudioTrack({ mediaItemId: item.id }, playheadTime),
                    });
                    setPicking(false);
                  }}
                  className="flex min-h-[44px] w-full items-center gap-2 border-b border-[color:var(--hair-dark)] px-4 py-2 text-left text-xs text-ink-300 transition-colors last:border-b-0 hover:bg-ink-800 hover:text-paper-200"
                >
                  <span className="eyebrow-light w-10 shrink-0">File</span>
                  <span className="min-w-0 flex-1 truncate">{item.originalFilename}</span>
                </button>
              ))}
              {music.map((item) => (
                <button
                  key={item.id}
                  disabled={!item.extractedAudioKey}
                  onClick={() => {
                    onDispatch({
                      type: "audio.add",
                      track: defaultAudioTrack({ musicItemId: item.id }, playheadTime),
                    });
                    setPicking(false);
                  }}
                  className="flex min-h-[44px] w-full items-center gap-2 border-b border-[color:var(--hair-dark)] px-4 py-2 text-left text-xs text-ink-300 transition-colors last:border-b-0 hover:bg-ink-800 hover:text-paper-200 disabled:opacity-40 disabled:hover:bg-transparent"
                  title={item.extractedAudioKey ? undefined : "No audio file for this track yet"}
                >
                  <span className="eyebrow-light w-10 shrink-0">Link</span>
                  <span className="min-w-0 flex-1 truncate">{item.title ?? item.url}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {/* The stack itself */}
      <div className="divide-y divide-[color:var(--hair-dark)]">
        {timeline.audio.length === 0 && (
          <p className="px-4 py-3 text-[13px] leading-relaxed text-ink-400">
            Nothing playing under the cut.
          </p>
        )}
        {timeline.audio.map((track) => {
          const active = selection.kind === "audio" && selection.id === track.id;
          return (
            <button
              key={track.id}
              onClick={() => onSelect({ kind: "audio", id: track.id })}
              className={cn(
                "flex min-h-[44px] w-full items-center gap-2 px-4 py-2.5 text-left text-xs transition-colors",
                active
                  ? "bg-signal-900/40 text-paper-100"
                  : "text-ink-300 hover:bg-ink-800 hover:text-paper-200",
                track.muted && "opacity-50",
              )}
            >
              <span className="eyebrow-light w-10 shrink-0">
                {track.role === "bed" ? "Bed" : "Cue"}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {audioTrackLabel(track, mediaById, musicById)}
              </span>
              <span className="timecode shrink-0 text-2xs text-ink-400">
                {formatDuration(audioTrackSpan(track, totalDuration))}
              </span>
            </button>
          );
        })}
      </div>

      {/* Choosing the bed — the one track the whole crew has a say in */}
      <div className="border-t border-[color:var(--hair-dark)]">
        <p className="eyebrow-light px-4 pt-3">The bed</p>
        <div className="mt-1.5 divide-y divide-[color:var(--hair-dark)]">
          <BedChoice label="Dry" name="No score" active={!bed} onClick={playDry} />
          {audioUploads.map((item) => (
            <BedChoice
              key={item.id}
              label="File"
              name={item.originalFilename}
              active={bed?.mediaItemId === item.id}
              onClick={() => setUploadedBed(item.id)}
            />
          ))}
          {music.map((item) => (
            <BedChoice
              key={item.id}
              label="Link"
              name={item.title ?? item.url}
              note={item.extractedAudioKey ? "ready" : "no audio"}
              ready={Boolean(item.extractedAudioKey)}
              active={bed?.musicItemId === item.id}
              onClick={() => onChooseBedMusic(item.id)}
            />
          ))}
        </div>
      </div>

      <div className="border-t border-[color:var(--hair-dark)] px-4 py-3">
        <label className="flex items-center gap-2 font-mono text-2xs uppercase tracking-label text-ink-300">
          <input
            type="checkbox"
            checked={timeline.duckClipAudio}
            onChange={(e) =>
              onDispatch({ type: "settings.update", patch: { duckClipAudio: e.target.checked } })
            }
            className="check check-dark"
          />
          Duck the score under the shots
        </label>
      </div>
    </section>
  );
}

function BedChoice({
  label,
  name,
  note,
  ready = true,
  active,
  onClick,
}: {
  label: string;
  name: string;
  note?: string;
  ready?: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex min-h-[44px] w-full items-center gap-2 px-4 py-2.5 text-left text-xs transition-colors",
        active
          ? "bg-signal-900/40 text-paper-100"
          : "text-ink-400 hover:bg-ink-800 hover:text-paper-200",
      )}
      title={ready ? undefined : "No audio file for this track — it won't be in the render"}
    >
      <span className="eyebrow-light w-10 shrink-0">{label}</span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {note && (
        <span
          className={cn(
            "shrink-0 font-mono text-2xs uppercase tracking-label",
            ready ? "text-leader-400" : "text-tape-400",
          )}
        >
          {note}
        </span>
      )}
    </button>
  );
}
