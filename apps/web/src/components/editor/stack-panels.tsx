"use client";

import {
  MAX_LAYERS,
  defaultAudioTrack,
  defaultLayerFor,
  type TimelineDoc,
  type TimelineOp,
} from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import { RotatedMedia } from "@/lib/rotated-media";
import { cn } from "@/lib/cn";

/**
 * The two stacks either side of the picture: what's laid over it, and what's
 * playing under it. Both are hand-built — the vote has no opinion about
 * either, beyond which track it made the bed.
 *
 * These used to be panels with a list and an "+ Add" fold. The lanes on the
 * strip *are* the list, so only the picker half survived: it opens from
 * "+ Layer" / "+ Sound" on the strip toolbar, where the thing being added
 * lands. What the vote has a say in — which track is the bed — moved to the
 * Film tab with the rest of the settings the whole crew shares.
 */

export function LayerPicker({
  timeline,
  media,
  playheadTime,
  onDispatch,
  onDone,
}: {
  timeline: TimelineDoc;
  media: MediaItemView[];
  playheadTime: number;
  onDispatch: (op: TimelineOp) => void;
  /** Adding closes the popover — one pick is the whole errand. */
  onDone: () => void;
}) {
  const footage = media.filter((m) => m.kind !== "audio" && m.status === "ready");

  /** New layers go on the lowest empty shelf, so they don't hide each other. */
  function nextLane(): number {
    const used = new Set(timeline.layers.map((l) => l.layer));
    for (let n = 1; n <= MAX_LAYERS; n++) if (!used.has(n)) return n;
    return 1;
  }

  return (
    <section>
      <div className="border-b border-[color:var(--hair-dark)] px-4 py-2">
        <p className="font-mono text-2xs uppercase tracking-label text-ink-400">
          Goes over the picture at the playhead
        </p>
      </div>

      <div className="max-h-72 overflow-y-auto">
        {footage.length === 0 ? (
          <p className="px-4 py-3 font-mono text-2xs text-ink-400">
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
                onDone();
              }}
              className="flex min-h-[44px] w-full items-center gap-2 border-b border-[color:var(--hair-dark)] px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-ink-800"
            >
              {item.thumbnailUrl ? (
                <RotatedMedia rotation={item.rotation} className="h-8 w-12 shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                </RotatedMedia>
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
    </section>
  );
}

export function SoundPicker({
  music,
  media,
  playheadTime,
  onDispatch,
  onDone,
}: {
  music: MusicItemView[];
  media: MediaItemView[];
  playheadTime: number;
  onDispatch: (op: TimelineOp) => void;
  onDone: () => void;
}) {
  const audioUploads = media.filter((m) => m.contentType.startsWith("audio/"));

  return (
    <section>
      <div className="border-b border-[color:var(--hair-dark)] px-4 py-2">
        <p className="font-mono text-2xs uppercase tracking-label text-ink-400">
          Plays under the cut, from the playhead
        </p>
      </div>

      <div className="max-h-72 overflow-y-auto">
        {audioUploads.length === 0 && music.length === 0 ? (
          <p className="px-4 py-3 font-mono text-2xs text-ink-400">
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
                  onDone();
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
                  onDone();
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
    </section>
  );
}

/**
 * The music under the whole film, and whether the shots duck for it.
 *
 * Not a picker and not a list: it's one choice the whole crew shares, which
 * is why it sits in Film settings beside the shape and the pace rather than
 * on the strip with the verbs.
 */
export function BedSettings({
  timeline,
  music,
  media,
  onDispatch,
  onChooseBedMusic,
}: {
  timeline: TimelineDoc;
  music: MusicItemView[];
  media: MediaItemView[];
  onDispatch: (op: TimelineOp) => void;
  /** Streaming beds go through the cut engine so the floor agrees with us. */
  onChooseBedMusic: (musicItemId: string | null) => void;
}) {
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
        track: {
          ...defaultAudioTrack({ mediaItemId }),
          role: "bed",
          volume: 0.8,
          fadeIn: 1,
          fadeOut: 2,
        },
      });
    }
  }

  function playDry() {
    if (bed) onDispatch({ type: "audio.remove", trackId: bed.id });
    onChooseBedMusic(null);
  }

  return (
    <section>
      <div>
        <p className="eyebrow-light px-4 pt-3">The music under it all</p>
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
              onDispatch({
                type: "settings.update",
                patch: { duckClipAudio: e.target.checked },
              })
            }
            className="check check-dark"
          />
          Duck the shots under the score
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
