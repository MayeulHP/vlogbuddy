"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  applyTimelineOp,
  formatDuration,
  timelineDuration,
  type AudioTrack,
  type TimelineDoc,
  type TimelineOp,
} from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import { startRenderAction } from "@/lib/actions/timeline";
import { setMusicBedAction } from "@/lib/actions/cut";
import { useSocketEvent, type VlogSocket } from "@/hooks/use-vlog-socket";
import { useMediaQuery } from "@/hooks/use-media-query";
import { ClipInspector } from "./clip-inspector";
import { LayerInspector } from "./layer-inspector";
import { AudioInspector, type SoundState } from "./audio-inspector";
import { LayerPanel, SoundPanel } from "./stack-panels";
import { DirectorPanel } from "./director-panel";
import { TimelineTracks, audioTrackLabel } from "./timeline-tracks";
import { PreviewPlayer } from "./preview-player";
import { NO_SELECTION, type Selection } from "./selection";
import { SectionHead } from "../brand";

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
 * The editor: reorder, trim, title, layer and score. Deliberately small — the
 * vlog is always already assembled from the vote (the cut engine keeps it that
 * way), so this is about tightening it up rather than building from scratch.
 * You can hop back to Gather at any time; both views edit the same live
 * document.
 *
 * The base track belongs to the crew. Layers and extra sound are yours: they
 * hang off the clock rather than off a shot, which is why the bench is a stack
 * of lanes on one shared ruler.
 *
 * Edits are sent as ops over the socket. The server applies them to the
 * authoritative doc and rebroadcasts; we apply optimistically so it feels
 * instant. True CRDT merging is still v2 (see TODO.md).
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
  const [selection, setSelection] = useState<Selection>(
    initialTimeline.clips[0] ? { kind: "clip", id: initialTimeline.clips[0].id } : NO_SELECTION,
  );
  /**
   * The phone sheet opens on a deliberate pick, not on whatever happened to be
   * selected when the bench loaded — otherwise the first thing you see on a
   * phone is a panel covering the strip it describes.
   */
  const [sheetOpen, setSheetOpen] = useState(false);
  const [playheadTime, setPlayheadTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [, startTransition] = useTransition();

  const mediaById = useMemo(() => {
    const map = new Map<string, MediaItemView>();
    for (const item of media) map.set(item.id, item);
    return map;
  }, [media]);

  const musicById = useMemo(() => {
    const map = new Map<string, MusicItemView>();
    for (const item of music) map.set(item.id, item);
    return map;
  }, [music]);

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

  // A layer or track can vanish under you when someone else pulls it, or when
  // the cut engine prunes a swept source.
  const selected = useMemo(() => {
    if (selection.kind === "clip") {
      return timeline.clips.find((c) => c.id === selection.id) ?? null;
    }
    if (selection.kind === "layer") {
      return timeline.layers.find((l) => l.id === selection.id) ?? null;
    }
    if (selection.kind === "audio") {
      return timeline.audio.find((t) => t.id === selection.id) ?? null;
    }
    return null;
  }, [selection, timeline]);

  const choose = useCallback((next: Selection) => {
    setSelection(next);
    setSheetOpen(next.kind !== "none");
  }, []);

  function chooseBedMusic(musicItemId: string | null) {
    startTransition(() => {
      void setMusicBedAction(slug, musicItemId);
    });
  }

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

  /**
   * Below `md` the side panel has nowhere to be, so the inspector comes up over
   * the bench as a sheet instead. Same element either way — only where it hangs
   * changes.
   */
  const asSheet = useMediaQuery("(max-width: 767px)");

  const inspector =
    selection.kind === "clip" && selected && "titles" in selected ? (
      <ClipInspector
        clip={selected}
        media={mediaById.get(selected.mediaItemId) ?? null}
        index={timeline.clips.findIndex((c) => c.id === selected.id)}
        total={timeline.clips.length}
        onDispatch={dispatch}
      />
    ) : selection.kind === "layer" && selected && "opacity" in selected ? (
      <LayerInspector
        layer={selected}
        media={mediaById.get(selected.mediaItemId) ?? null}
        totalDuration={totalDuration}
        onDispatch={dispatch}
      />
    ) : selection.kind === "audio" && selected && "role" in selected ? (
      <AudioInspector
        track={selected}
        label={audioTrackLabel(selected, mediaById, musicById)}
        totalDuration={totalDuration}
        sound={soundStateFor(selected, mediaById, musicById)}
        onDispatch={dispatch}
        onRemove={() => {
          dispatch({ type: "audio.remove", trackId: selected.id });
          if (selected.role === "bed") chooseBedMusic(null);
          setSelection(NO_SELECTION);
        }}
      />
    ) : (
      <div className="border border-[color:var(--hair-dark)] bg-ink-850 p-5 text-center">
        <p className="eyebrow-light">Nothing selected</p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-300">
          Pick a shot on the strip to trim it, a layer to move it around the frame, or a track
          to ride its level.
        </p>
      </div>
    );

  const sheetTitle =
    selection.kind === "clip"
      ? "The shot"
      : selection.kind === "layer"
        ? "The layer"
        : selection.kind === "audio"
          ? "The track"
          : "Inspector";

  return (
    <div className="space-y-5">
      <SectionHead
        tone="ink"
        eyebrow="Beat 05 · Cut"
        title="The cutting bench"
        note="Already assembled from the crew's marks — this is where you tighten it. Trim, retime, layer, score. Everyone edits the same strip, live."
        right={
          <div className="flex flex-wrap items-stretch gap-2 sm:gap-3">
            <button onClick={onBackToGather} className="btn-quiet-dark order-3 sm:order-none sm:self-end">
              ← Back to the floor
            </button>
            <div className="order-1 border border-[color:var(--hair-dark)] bg-ink-850 px-3 py-2 text-right sm:order-none">
              <p className="eyebrow-light">Running time</p>
              <p className="timecode mt-0.5 text-lg leading-none text-paper-100">
                {formatDuration(totalDuration)}
              </p>
              <p className="eyebrow-light mt-1">
                {timeline.clips.length} shot{timeline.clips.length === 1 ? "" : "s"}
                {timeline.layers.length > 0 && ` · ${timeline.layers.length} layer${timeline.layers.length === 1 ? "" : "s"}`}
              </p>
            </div>
            {isCreator && (
              <button
                onClick={render}
                disabled={rendering || timeline.clips.length === 0}
                className="btn-signal order-2 flex-1 sm:order-none sm:flex-none sm:self-stretch"
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

      {/*
        `grid-cols-1` rather than the implicit single column: an implicit `auto`
        track is sized by its widest item's min-content, so one stubborn panel
        was making the whole page wider than the phone it was on.
      */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-4">
          <PreviewPlayer
            timeline={timeline}
            mediaById={mediaById}
            musicById={musicById}
            durations={durations}
            playheadTime={playheadTime}
            onTimeChange={setPlayheadTime}
            selectedClipId={selection.kind === "clip" ? selection.id : null}
            onSelectClip={(id) => choose({ kind: "clip", id })}
          />

          <TimelineTracks
            timeline={timeline}
            mediaById={mediaById}
            music={music}
            durations={durations}
            totalDuration={totalDuration}
            selection={selection}
            onSelect={choose}
            onDispatch={dispatch}
            playheadTime={playheadTime}
            onSeek={setPlayheadTime}
            onBackToGather={onBackToGather}
          />
        </div>

        <aside className="space-y-4">
          {/* On a phone this same inspector arrives as a sheet instead. */}
          {!asSheet && inspector}

          <DirectorPanel slug={slug} timeline={timeline} locked={rendering} />

          <LayerPanel
            timeline={timeline}
            media={media}
            mediaById={mediaById}
            playheadTime={playheadTime}
            selection={selection}
            onSelect={choose}
            onDispatch={dispatch}
          />

          <SoundPanel
            timeline={timeline}
            music={music}
            media={media}
            mediaById={mediaById}
            musicById={musicById}
            totalDuration={totalDuration}
            playheadTime={playheadTime}
            selection={selection}
            onSelect={choose}
            onDispatch={dispatch}
            onChooseBedMusic={chooseBedMusic}
          />
        </aside>
      </div>

      {asSheet && sheetOpen && selection.kind !== "none" && (
        <InspectorSheet title={sheetTitle} onClose={() => setSheetOpen(false)}>
          {inspector}
        </InspectorSheet>
      )}
    </div>
  );
}

/**
 * The inspector, on a phone.
 *
 * A 320px side panel doesn't exist at 375px — stacked under a timeline it ends
 * up a screen and a half below the thing it's describing, which is the one
 * place it can't be. So on a phone it comes up over the bench as a sheet, tied
 * to the selection: pick a shot and it's there, close it and the selection is
 * cleared.
 */
function InspectorSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 md:hidden">
      <div className="pb-safe max-h-[72dvh] animate-slide-up overflow-y-auto overscroll-contain border-t border-[color:var(--hair-dark)] bg-ink-900 shadow-deck">
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-[color:var(--hair-dark)] bg-ink-900 px-3 py-2">
          <span aria-hidden className="h-1 w-8 shrink-0 bg-ink-600" />
          <p className="eyebrow-light min-w-0 flex-1 truncate">{title}</p>
          <button onClick={onClose} className="btn-outline-dark px-3" aria-label="Close">
            Done
          </button>
        </div>
        <div className="p-2">{children}</div>
      </div>
    </div>
  );
}


/**
 * What the inspector needs to explain a silent track: whether there is a file
 * behind it yet, and if not, how far along the fetch is.
 */
function soundStateFor(
  track: AudioTrack,
  mediaById: Map<string, MediaItemView>,
  musicById: Map<string, MusicItemView>,
): SoundState | undefined {
  if (track.mediaItemId) {
    const item = mediaById.get(track.mediaItemId);
    if (!item) return undefined;
    return {
      playable: Boolean(item.originalUrl),
      status: item.status,
      error: item.error,
      fromLink: false,
    };
  }
  if (track.musicItemId) {
    const item = musicById.get(track.musicItemId);
    if (!item) return undefined;
    return {
      playable: Boolean(item.audioUrl),
      status: item.status,
      error: item.error,
      fromLink: true,
    };
  }
  return undefined;
}
