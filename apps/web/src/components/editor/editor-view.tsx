"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import {
  applyTimelineOp,
  clipDuration,
  formatDuration,
  timelineDuration,
  type Clip,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type TimelineDoc,
  type TimelineOp,
} from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import { startRenderAction } from "@/lib/actions/timeline";
import { useSocketEvent } from "@/hooks/use-vlog-socket";
import { ClipInspector } from "./clip-inspector";
import { TimelineStrip } from "./timeline-strip";
import { PreviewPlayer } from "./preview-player";
import { cn } from "@/lib/cn";

interface EditorViewProps {
  slug: string;
  vlogId: string;
  media: MediaItemView[];
  music: MusicItemView[];
  timeline: TimelineDoc;
  revision: number;
  socket: React.MutableRefObject<Socket<ServerToClientEvents, ClientToServerEvents> | null>;
  isCreator: boolean;
  memberId: string;
}

/**
 * The v1 editor: reorder, trim, title, pick the music bed. Deliberately small —
 * the vlog arrives here already assembled from the vote, so this is about
 * tightening it up rather than building from scratch.
 *
 * Edits are sent as ops over the socket. The server applies them to the
 * authoritative doc and rebroadcasts; we apply optimistically so it feels
 * instant. Multi-track and true CRDT merging are v2 (see TODO.md).
 */
export function EditorView({
  slug,
  vlogId,
  media,
  music,
  timeline: initialTimeline,
  revision: initialRevision,
  socket,
  isCreator,
  memberId,
}: EditorViewProps) {
  const [timeline, setTimeline] = useState<TimelineDoc>(initialTimeline);
  const [revision, setRevision] = useState(initialRevision);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(
    initialTimeline.clips[0]?.id ?? null,
  );
  const [playheadTime, setPlayheadTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);

  const mediaById = useMemo(() => {
    const map = new Map<string, MediaItemView>();
    for (const item of media) map.set(item.id, item);
    return map;
  }, [media]);

  const durations = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const item of media) out[item.id] = item.durationSeconds;
    return out;
  }, [media]);

  const totalDuration = useMemo(
    () => timelineDuration(timeline, durations),
    [timeline, durations],
  );

  // Remote edits from other people in the room.
  useSocketEvent(
    socket,
    "timeline:op",
    useCallback(
      ({ op, revision: rev, byMemberId }: { op: TimelineOp; revision: number; byMemberId: string }) => {
        if (byMemberId === memberId) return; // already applied locally
        setTimeline((prev) => applyTimelineOp(prev, op));
        setRevision(rev);
      },
      [memberId],
    ),
  );

  useSocketEvent(
    socket,
    "timeline:sync",
    useCallback(({ timeline: doc, revision: rev }: { timeline: TimelineDoc; revision: number }) => {
      setTimeline(doc);
      setRevision(rev);
    }, []),
  );

  useEffect(() => {
    socket.current?.emit("timeline:request", { vlogId });
  }, [socket, vlogId]);

  /** Apply locally for instant feedback, then let the server confirm. */
  const dispatch = useCallback(
    (op: TimelineOp) => {
      setTimeline((prev) => applyTimelineOp(prev, op));
      setError(null);

      const s = socket.current;
      if (!s?.connected) {
        setError("Disconnected — your change wasn't saved. Reconnecting…");
        return;
      }

      s.emit("timeline:op", { vlogId, op, revision }, (result) => {
        if (!result?.ok) {
          setError(result?.error ?? "That edit didn't stick");
          // Server rejected it — resync to the truth.
          s.emit("timeline:request", { vlogId });
          return;
        }
        if (result.revision) setRevision(result.revision);
        // Server's doc wins if we drifted.
        if (result.timeline) setTimeline(result.timeline);
      });
    },
    [socket, vlogId, revision],
  );

  const selectedClip = timeline.clips.find((c) => c.id === selectedClipId) ?? null;

  async function render() {
    setRendering(true);
    setError(null);
    const res = await startRenderAction(slug);
    if (!res.ok) {
      setError(res.error);
      setRendering(false);
    }
    // On success the phase flips to `export` and the shell swaps the view.
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">Final cut</h2>
          <p className="text-xs text-ink-500">
            {timeline.clips.length} clips · {formatDuration(totalDuration)} · everyone edits together
          </p>
        </div>

        {isCreator && (
          <button
            onClick={render}
            disabled={rendering || timeline.clips.length === 0}
            className="btn-primary text-xs"
          >
            {rendering ? "Starting…" : "🎬 Render the vlog"}
          </button>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-4">
          <PreviewPlayer
            timeline={timeline}
            mediaById={mediaById}
            durations={durations}
            playheadTime={playheadTime}
            onTimeChange={setPlayheadTime}
            selectedClipId={selectedClipId}
            onSelectClip={setSelectedClipId}
          />

          <TimelineStrip
            timeline={timeline}
            mediaById={mediaById}
            durations={durations}
            selectedClipId={selectedClipId}
            onSelectClip={setSelectedClipId}
            onDispatch={dispatch}
          />
        </div>

        <aside className="space-y-4">
          {selectedClip ? (
            <ClipInspector
              clip={selectedClip}
              media={mediaById.get(selectedClip.mediaItemId) ?? null}
              index={timeline.clips.findIndex((c) => c.id === selectedClip.id)}
              total={timeline.clips.length}
              onDispatch={dispatch}
            />
          ) : (
            <div className="card p-4 text-center text-xs text-ink-600">
              Pick a clip to trim it, add a title, or change how it transitions in.
            </div>
          )}

          <MusicBed
            timeline={timeline}
            music={music}
            media={media}
            onDispatch={dispatch}
          />
        </aside>
      </div>
    </div>
  );
}

/** Chooses the audio bed: a voted streaming track, or an uploaded audio file. */
function MusicBed({
  timeline,
  music,
  media,
  onDispatch,
}: {
  timeline: TimelineDoc;
  music: MusicItemView[];
  media: MediaItemView[];
  onDispatch: (op: TimelineOp) => void;
}) {
  const track = timeline.audio[0] ?? null;
  const audioUploads = media.filter((m) => m.contentType.startsWith("audio/"));

  return (
    <section className="card p-4">
      <h3 className="mb-1 text-sm font-semibold text-white">Music bed</h3>
      <p className="mb-3 text-xs text-ink-500">
        Plays under the whole cut.
      </p>

      <div className="space-y-1.5">
        <button
          onClick={() => onDispatch({ type: "audio.remove", index: 0 })}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border p-2 text-left text-xs transition-colors",
            !track ? "border-brand-500/60 bg-brand-500/10 text-white" : "border-ink-800 text-ink-400 hover:border-ink-700",
          )}
        >
          <span>🔇</span> No music
        </button>

        {audioUploads.map((item) => {
          const active = track?.mediaItemId === item.id;
          return (
            <button
              key={item.id}
              onClick={() =>
                onDispatch({
                  type: "audio.set",
                  index: 0,
                  track: {
                    musicItemId: null,
                    mediaItemId: item.id,
                    offset: 0,
                    startAt: 0,
                    volume: 0.8,
                    fadeIn: 1,
                    fadeOut: 2,
                  },
                })
              }
              className={cn(
                "flex w-full items-center gap-2 rounded-lg border p-2 text-left text-xs transition-colors",
                active
                  ? "border-brand-500/60 bg-brand-500/10 text-white"
                  : "border-ink-800 text-ink-300 hover:border-ink-700",
              )}
            >
              <span>🎧</span>
              <span className="min-w-0 flex-1 truncate">{item.originalFilename}</span>
              <span className="shrink-0 text-[10px] text-emerald-400">uploaded</span>
            </button>
          );
        })}

        {music.map((item) => {
          const active = track?.musicItemId === item.id;
          const hasAudio = Boolean(item.extractedAudioKey);
          return (
            <button
              key={item.id}
              onClick={() =>
                onDispatch({
                  type: "audio.set",
                  index: 0,
                  track: {
                    musicItemId: item.id,
                    mediaItemId: null,
                    offset: 0,
                    startAt: 0,
                    volume: 0.8,
                    fadeIn: 1,
                    fadeOut: 2,
                  },
                })
              }
              className={cn(
                "flex w-full items-center gap-2 rounded-lg border p-2 text-left text-xs transition-colors",
                active
                  ? "border-brand-500/60 bg-brand-500/10 text-white"
                  : "border-ink-800 text-ink-300 hover:border-ink-700",
              )}
              title={
                hasAudio
                  ? "Audio ready to mux"
                  : "No audio file for this track — it won't be in the render"
              }
            >
              <span>🎵</span>
              <span className="min-w-0 flex-1 truncate">{item.title ?? item.url}</span>
              <span
                className={cn(
                  "shrink-0 text-[10px]",
                  hasAudio ? "text-emerald-400" : "text-amber-400",
                )}
              >
                {hasAudio ? "ready" : "no audio"}
              </span>
            </button>
          );
        })}
      </div>

      {track && (
        <div className="mt-3 space-y-2 border-t border-ink-800 pt-3">
          <label className="block">
            <span className="text-[11px] text-ink-400">Volume — {Math.round(track.volume * 100)}%</span>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={track.volume}
              onChange={(e) =>
                onDispatch({
                  type: "audio.set",
                  index: 0,
                  track: { ...track, volume: Number(e.target.value) },
                })
              }
              className="mt-1 h-1 w-full cursor-pointer appearance-none rounded-full bg-ink-700 accent-brand-500"
            />
          </label>

          <label className="flex items-center gap-2 text-[11px] text-ink-400">
            <input
              type="checkbox"
              checked={timeline.duckClipAudio}
              onChange={(e) =>
                onDispatch({
                  type: "settings.update",
                  patch: { duckClipAudio: e.target.checked },
                })
              }
              className="accent-brand-500"
            />
            Quieten clip audio under the music
          </label>
        </div>
      )}
    </section>
  );
}
