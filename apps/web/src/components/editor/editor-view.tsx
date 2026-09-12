"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  applyTimelineOp,
  formatDuration,
  timelineDuration,
  type TimelineDoc,
  type TimelineOp,
} from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import { startRenderAction } from "@/lib/actions/timeline";
import { setMusicBedAction } from "@/lib/actions/cut";
import { useSocketEvent, type VlogSocket } from "@/hooks/use-vlog-socket";
import { ClipInspector } from "./clip-inspector";
import { TimelineStrip } from "./timeline-strip";
import { PreviewPlayer } from "./preview-player";
import { SectionHead } from "../brand";
import { cn } from "@/lib/cn";

interface EditorViewProps {
  slug: string;
  vlogId: string;
  media: MediaItemView[];
  music: MusicItemView[];
  timeline: TimelineDoc;
  revision: number;
  socket: VlogSocket | null;
  isCreator: boolean;
  memberId: string;
  /** Jumps this viewer back to the Gather page — same document, other lane. */
  onBackToGather: () => void;
}

/**
 * The v1 editor: reorder, trim, title, pick the music bed. Deliberately small —
 * the vlog is always already assembled from the vote (the cut engine keeps it
 * that way), so this is about tightening it up rather than building from
 * scratch. You can hop back to Gather at any time; both views edit the same
 * live document.
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
  onBackToGather,
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
    socket?.emit("timeline:request", { vlogId });
  }, [socket, vlogId]);

  /** Apply locally for instant feedback, then let the server confirm. */
  const dispatch = useCallback(
    (op: TimelineOp) => {
      setTimeline((prev) => applyTimelineOp(prev, op));
      setError(null);

      const s = socket;
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
    <div className="space-y-5">
      <SectionHead
        tone="ink"
        eyebrow="Beat 05 · Cut"
        title="The cutting bench"
        note="Already assembled from the crew's marks — this is where you tighten it. Trim, retime, title, score. Everyone edits the same strip, live."
        right={
          <div className="flex items-stretch gap-3">
            <button onClick={onBackToGather} className="btn-quiet-dark self-end">
              ← Back to the floor
            </button>
            <div className="border border-[color:var(--hair-dark)] bg-ink-850 px-3 py-2 text-right">
              <p className="eyebrow-light">Running time</p>
              <p className="timecode mt-0.5 text-lg leading-none text-paper-100">
                {formatDuration(totalDuration)}
              </p>
              <p className="eyebrow-light mt-1">
                {timeline.clips.length} shot{timeline.clips.length === 1 ? "" : "s"}
              </p>
            </div>
            {isCreator && (
              <button
                onClick={render}
                disabled={rendering || timeline.clips.length === 0}
                className="btn-signal self-stretch"
              >
                {rendering ? "Loading…" : "Print the film"}
              </button>
            )}
          </div>
        }
      />

      {error && (
        <p className="border border-signal-500/40 bg-signal-900/30 px-3 py-2 font-mono text-[11px] text-signal-300">
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
            onBackToGather={onBackToGather}
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
            <div className="border border-[color:var(--hair-dark)] bg-ink-850 p-5 text-center">
              <p className="eyebrow-light">No shot selected</p>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-300">
                Pick a shot on the strip to trim it, lay a title over it, or change how it comes
                in.
              </p>
            </div>
          )}

          <MusicBed
            slug={slug}
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

/**
 * Chooses the audio bed: a voted streaming track, or an uploaded audio file.
 *
 * Streaming tracks go through the cut engine (same choice as the soundtrack
 * lane on the Gather page, so the two can't disagree). Uploaded audio is set
 * directly on the timeline — the cut engine leaves an uploaded bed alone.
 */
function MusicBed({
  slug,
  timeline,
  music,
  media,
  onDispatch,
}: {
  slug: string;
  timeline: TimelineDoc;
  music: MusicItemView[];
  media: MediaItemView[];
  onDispatch: (op: TimelineOp) => void;
}) {
  const [, startTransition] = useTransition();
  const track = timeline.audio[0] ?? null;
  const audioUploads = media.filter((m) => m.contentType.startsWith("audio/"));

  return (
    <section className="border border-[color:var(--hair-dark)] bg-ink-850">
      <div className="border-b border-[color:var(--hair-dark)] px-4 py-3">
        <p className="eyebrow-light">Score</p>
        <h3 className="headline mt-0.5 text-xl text-paper-100">The bed</h3>
        <p className="mt-1 font-mono text-2xs uppercase tracking-label text-ink-500">
          Runs under the whole cut
        </p>
      </div>

      <div className="divide-y divide-[color:var(--hair-dark)]">
        <button
          onClick={() =>
            startTransition(() => {
              onDispatch({ type: "audio.remove", index: 0 });
              return setMusicBedAction(slug, null).then(() => {});
            })
          }
          className={cn(
            "flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs transition-colors",
            !track
              ? "bg-signal-900/40 text-paper-100"
              : "text-ink-400 hover:bg-ink-800 hover:text-paper-200",
          )}
        >
          <span className="eyebrow-light w-10 shrink-0">Dry</span>
          <span className="min-w-0 flex-1 truncate">No score</span>
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
                "flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs transition-colors",
                active
                  ? "bg-signal-900/40 text-paper-100"
                  : "text-ink-300 hover:bg-ink-800 hover:text-paper-200",
              )}
            >
              <span className="eyebrow-light w-10 shrink-0">File</span>
              <span className="min-w-0 flex-1 truncate">{item.originalFilename}</span>
              <span className="shrink-0 font-mono text-2xs uppercase tracking-label text-leader-400">
                ready
              </span>
            </button>
          );
        })}

        {music.map((item) => {
          const active = track?.musicItemId === item.id;
          const hasAudio = Boolean(item.extractedAudioKey);
          return (
            <button
              key={item.id}
              onClick={() => startTransition(() => setMusicBedAction(slug, item.id).then(() => {}))}
              className={cn(
                "flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs transition-colors",
                active
                  ? "bg-signal-900/40 text-paper-100"
                  : "text-ink-300 hover:bg-ink-800 hover:text-paper-200",
              )}
              title={
                hasAudio
                  ? "Audio ready to mux"
                  : "No audio file for this track — it won't be in the render"
              }
            >
              <span className="eyebrow-light w-10 shrink-0">Link</span>
              <span className="min-w-0 flex-1 truncate">{item.title ?? item.url}</span>
              <span
                className={cn(
                  "shrink-0 font-mono text-2xs uppercase tracking-label",
                  hasAudio ? "text-leader-400" : "text-tape-400",
                )}
              >
                {hasAudio ? "ready" : "no audio"}
              </span>
            </button>
          );
        })}
      </div>

      {track && (
        <div className="space-y-3 border-t border-[color:var(--hair-dark)] px-4 py-3">
          <label className="block">
            <span className="eyebrow-light">Level — {Math.round(track.volume * 100)}%</span>
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
              className="slider slider-dark mt-1.5"
            />
          </label>

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
      )}
    </section>
  );
}
