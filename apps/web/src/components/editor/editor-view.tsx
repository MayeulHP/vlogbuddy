"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  applyTimelineOp,
  clipSpeed,
  clipStartTimes,
  formatDuration,
  timelineDuration,
  type AudioTrack,
  type TimelineDoc,
  type TimelineOp,
} from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import { startRenderAction } from "@/lib/actions/timeline";
import { reorderCutAction, setCutOverrideAction, setMusicBedAction } from "@/lib/actions/cut";
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
import { PanelEmpty, PanelTabs, type PanelTab } from "./panel-tabs";
import { KEYMAP, KEY_SECTIONS, type KeyAction } from "./keymap";
import { useEditorKeys } from "./use-editor-keys";
import { useDialog } from "@/hooks/use-dialog";
import { cn } from "@/lib/cn";

interface EditorViewProps {
  slug: string;
  vlogId: string;
  media: MediaItemView[];
  music: MusicItemView[];
  timeline: TimelineDoc;
  revision: number;
  socket: VlogSocket | null;
  /** Whether the room is live; the bench shows its own dot, having no footer. */
  connected: boolean;
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
  connected,
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
  const [panelTab, setPanelTab] = useState<PanelTab>("shot");
  const [playing, setPlaying] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
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
    // The panels follow the work: picking a shot opens Shot, a layer opens
    // Layers. A tab somebody switched to by hand stands until they pick
    // something else — the strip is what moves the panel, not the other way.
    if (next.kind === "clip") setPanelTab("shot");
    else if (next.kind === "layer") setPanelTab("layers");
    else if (next.kind === "audio") setPanelTab("sound");
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

  const shotPanel =
    selection.kind === "clip" && selected && "titles" in selected ? (
      <ClipInspector
        clip={selected}
        media={mediaById.get(selected.mediaItemId) ?? null}
        index={timeline.clips.findIndex((c) => c.id === selected.id)}
        total={timeline.clips.length}
        onDispatch={dispatch}
        onReorder={(toIndex) => reorderClip(selected.id, toIndex)}
        onLiftOut={() => liftClipOut(selected.id)}
      />
    ) : (
      <PanelEmpty>Pick a shot on the strip to trim it, retime it, or write over it.</PanelEmpty>
    );

  const layerDetail =
    selection.kind === "layer" && selected && "opacity" in selected ? (
      <LayerInspector
        layer={selected}
        media={mediaById.get(selected.mediaItemId) ?? null}
        totalDuration={totalDuration}
        onDispatch={dispatch}
      />
    ) : null;

  const audioDetail =
    selection.kind === "audio" && selected && "role" in selected ? (
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
    ) : null;

  /** The phone's sheet shows the thing you just tapped, not the whole rack. */
  const clipStarts = useMemo(() => clipStartTimes(timeline, durations), [timeline, durations]);

  /** A frame, near enough — the render's fps isn't on the client. */
  const FRAME = 1 / 30;
  /** The least a shot can be left holding after a trim. */
  const MIN_HOLD = 0.2;
  const round3 = (value: number) => Math.round(value * 1000) / 1000;

  /**
   * Reordering and lifting out go through the floor's own actions rather than
   * the document.
   *
   * `syncCut` rebuilds the running order from the `selections` table and keys
   * clips by their media, so a `clip.move` from the bench was quietly undone
   * by the next vote, and a `clip.remove` came back at the next sync as a
   * fresh clip with its trims and titles gone. The floor has always done this
   * properly; the bench just wasn't asking the same way.
   */
  function reorderClip(clipId: string, toIndex: number) {
    const from = timeline.clips.findIndex((c) => c.id === clipId);
    const to = Math.max(0, Math.min(timeline.clips.length - 1, toIndex));
    if (from === -1 || from === to) return;
    const ids = timeline.clips.map((c) => c.mediaItemId);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);

    /**
     * Move it now, ask afterwards. The strip otherwise sits at the old order
     * for a whole round trip — long enough to drag a shot twice. `syncCut`
     * broadcasts the document it writes, so the authoritative version lands
     * on top of this; only the op must *not* also be emitted, or the same
     * change would be applied twice and race that document.
     */
    setTimeline((prev) => applyTimelineOp(prev, { type: "clip.move", clipId, toIndex: to }));
    setError(null);

    startTransition(async () => {
      const result = await reorderCutAction(slug, ids);
      if (!result.ok) {
        setError(result.error);
        socket?.emit("timeline:request", { vlogId });
      }
    });
  }

  function liftClipOut(clipId: string) {
    const index = timeline.clips.findIndex((c) => c.id === clipId);
    const clip = timeline.clips[index];
    if (!clip) return;
    // Land on the next shot, or the one before it at the end of the strip —
    // never on nothing, which would close the panel you're working in.
    const next = timeline.clips[index + 1] ?? timeline.clips[index - 1] ?? null;
    choose(next ? { kind: "clip", id: next.id } : NO_SELECTION);

    // Gone from the strip immediately, for the same reason.
    setTimeline((prev) => applyTimelineOp(prev, { type: "clip.remove", clipId }));
    setError(null);

    startTransition(async () => {
      const result = await setCutOverrideAction(slug, {
        targetType: "media",
        targetId: clip.mediaItemId,
        override: "exclude",
      });
      if (!result.ok) {
        setError(result.error);
        socket?.emit("timeline:request", { vlogId });
      }
    });
  }

  /** Start or end the selected shot where the playhead is standing. */
  function markClip(edge: "in" | "out") {
    if (selection.kind !== "clip") return;
    const clip = timeline.clips.find((c) => c.id === selection.id);
    if (!clip || clip.kind === "photo") return;
    const offset = (playheadTime - (clipStarts[clip.id] ?? 0)) * clipSpeed(clip);
    if (offset <= 0) return;
    const at = clip.trimStart + offset;
    const sourceEnd = clip.trimEnd ?? durations[clip.mediaItemId] ?? null;
    if (edge === "in") {
      if (sourceEnd !== null && at > sourceEnd - MIN_HOLD) return;
      dispatch({ type: "clip.update", clipId: clip.id, patch: { trimStart: round3(at) } });
    } else {
      if (at < clip.trimStart + MIN_HOLD) return;
      dispatch({ type: "clip.update", clipId: clip.id, patch: { trimEnd: round3(at) } });
    }
  }

  function stepSelection(delta: -1 | 1) {
    if (timeline.clips.length === 0) return;
    const index =
      selection.kind === "clip" ? timeline.clips.findIndex((c) => c.id === selection.id) : -1;
    const at =
      index === -1
        ? delta === 1
          ? 0
          : timeline.clips.length - 1
        : Math.max(0, Math.min(timeline.clips.length - 1, index + delta));
    const clip = timeline.clips[at];
    if (!clip) return;
    choose({ kind: "clip", id: clip.id });
    setPlayheadTime(clipStarts[clip.id] ?? 0);
  }

  function nudgeSelected(seconds: number) {
    if (selection.kind === "layer" && selected && "opacity" in selected) {
      dispatch({
        type: "layer.update",
        layerId: selected.id,
        patch: { startAt: Math.max(0, round3(selected.startAt + seconds)) },
      });
    } else if (selection.kind === "audio" && selected && "role" in selected) {
      // The bed's start belongs to the floor's soundtrack lane, not to a key.
      if (selected.role === "bed") return;
      dispatch({
        type: "audio.update",
        trackId: selected.id,
        patch: { startAt: Math.max(0, round3(selected.startAt + seconds)) },
      });
    }
  }

  const onKeyAction = (action: KeyAction, event: KeyboardEvent) => {
    const big = event.shiftKey;
    const step = big ? 1 : FRAME;
    const index =
      selection.kind === "clip" ? timeline.clips.findIndex((c) => c.id === selection.id) : -1;

    switch (action) {
      case "play":
        setPlaying((p) => !p);
        break;
      case "stepBack":
        setPlayheadTime(Math.max(0, playheadTime - step));
        break;
      case "stepForward":
        setPlayheadTime(Math.min(totalDuration, playheadTime + step));
        break;
      case "toStart":
        setPlayheadTime(0);
        break;
      case "toEnd":
        setPlayheadTime(totalDuration);
        break;
      case "selectPrev":
        stepSelection(-1);
        break;
      case "selectNext":
        stepSelection(1);
        break;
      case "markIn":
        markClip("in");
        break;
      case "markOut":
        markClip("out");
        break;
      case "moveEarlier":
        if (selection.kind === "clip" && index !== -1) reorderClip(selection.id, big ? 0 : index - 1);
        else nudgeSelected(-step);
        break;
      case "moveLater":
        if (selection.kind === "clip" && index !== -1)
          reorderClip(selection.id, big ? timeline.clips.length - 1 : index + 1);
        else nudgeSelected(step);
        break;
      case "toggleMute":
        if (selection.kind === "clip" && selected && "titles" in selected)
          dispatch({ type: "clip.update", clipId: selected.id, patch: { muted: !selected.muted } });
        else if (selection.kind === "layer" && selected && "opacity" in selected)
          dispatch({ type: "layer.update", layerId: selected.id, patch: { muted: !selected.muted } });
        else if (selection.kind === "audio" && selected && "role" in selected)
          dispatch({ type: "audio.update", trackId: selected.id, patch: { muted: !selected.muted } });
        break;
      case "remove":
        if (selection.kind === "clip") liftClipOut(selection.id);
        else if (selection.kind === "layer" && selected && "opacity" in selected) {
          dispatch({ type: "layer.remove", layerId: selected.id });
          choose(NO_SELECTION);
        } else if (selection.kind === "audio" && selected && "role" in selected) {
          // The bed is the crew's; the Sound tab is the only way to drop it.
          if (selected.role === "bed") break;
          dispatch({ type: "audio.remove", trackId: selected.id });
          choose(NO_SELECTION);
        }
        break;
      case "escape":
        if (helpOpen) setHelpOpen(false);
        else if (sheetOpen) setSheetOpen(false);
        else choose(NO_SELECTION);
        break;
      case "help":
        setHelpOpen((open) => !open);
        break;
      case "panel1":
        setPanelTab("shot");
        break;
      case "panel2":
        setPanelTab("layers");
        break;
      case "panel3":
        setPanelTab("sound");
        break;
      case "panel4":
        setPanelTab("cut");
        break;
    }
  };

  useEditorKeys(!rendering, onKeyAction);

  const inspector =
    selection.kind === "clip"
      ? shotPanel
      : (selection.kind === "layer" && layerDetail) ||
        (selection.kind === "audio" && audioDetail) || (
          <PanelEmpty>
            Pick a shot on the strip to trim it, a layer to move it around the frame, or a
            track to ride its level.
          </PanelEmpty>
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
    <div className="space-y-5 xl:flex xl:h-full xl:min-h-0 xl:flex-col xl:gap-2 xl:space-y-0">
      {/*
        The bench's one row of chrome, in place of a section heading whose
        prose cost the picture ninety pixels. The room is named in the
        masthead; what an editor needs in front of it is the running time its
        edits are changing, and the way back.
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border border-[color:var(--hair-dark)] bg-ink-850 px-3 py-2 xl:h-11 xl:shrink-0 xl:flex-nowrap xl:py-0">
        <button onClick={onBackToGather} className="btn-quiet-dark shrink-0 px-2">
          ← The floor
        </button>

        <span className="timecode shrink-0 text-base leading-none text-paper-100">
          {formatDuration(totalDuration)}
        </span>
        <span className="eyebrow-light min-w-0 truncate">
          {timeline.clips.length} shot{timeline.clips.length === 1 ? "" : "s"}
          {timeline.layers.length > 0 &&
            ` · ${timeline.layers.length} layer${timeline.layers.length === 1 ? "" : "s"}`}
        </span>

        <button
          onClick={() => setHelpOpen(true)}
          className="btn-quiet-dark focus-ring-dark ml-auto hidden shrink-0 px-2 xl:inline-flex"
          title="The keys"
        >
          ?
        </button>

        <span className="flex shrink-0 items-center gap-1.5 font-mono text-2xs uppercase tracking-label text-ink-400 xl:ml-0">
          <span
            aria-hidden
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              connected ? "animate-pulse-dot bg-leader-500" : "bg-signal-600",
            )}
          />
          <span className="hidden sm:inline">{connected ? "Synced" : "Reconnecting…"}</span>
        </span>

        {isCreator && (
          <button
            onClick={render}
            disabled={rendering || timeline.clips.length === 0}
            className="btn-signal shrink-0"
          >
            {rendering ? "Loading…" : "Print the film"}
          </button>
        )}
      </div>

      {error && (
        <p className="border border-signal-500/40 bg-signal-900/30 px-3 py-2 font-mono text-[11px] text-signal-300">
          {error}
        </p>
      )}

      {helpOpen && <KeySheet onClose={() => setHelpOpen(false)} />}

      {/*
        `grid-cols-1` rather than the implicit single column: an implicit `auto`
        track is sized by its widest item's min-content, so one stubborn panel
        was making the whole page wider than the phone it was on.
      */}
      <div className="grid grid-cols-1 gap-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_320px] xl:gap-2">
        {/*
          Two rows, and only the first of them flexes: the picture takes
          whatever the strip doesn't need, so a tall monitor gets a bigger
          frame rather than a taller waveform.
        */}
        <div className="min-w-0 space-y-4 xl:grid xl:min-h-0 xl:grid-rows-[minmax(0,1fr)_auto] xl:gap-2 xl:space-y-0">
          <PreviewPlayer
            timeline={timeline}
            mediaById={mediaById}
            musicById={musicById}
            durations={durations}
            playheadTime={playheadTime}
            onTimeChange={setPlayheadTime}
            selectedClipId={selection.kind === "clip" ? selection.id : null}
            onSelectClip={(id) => choose({ kind: "clip", id })}
            playing={playing}
            onPlayingChange={setPlaying}
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
            onReorderClip={reorderClip}
            playheadTime={playheadTime}
            onSeek={setPlayheadTime}
            onBackToGather={onBackToGather}
          />
        </div>

        <aside className="min-h-0 xl:overflow-hidden">
          <PanelTabs
            active={panelTab}
            onChange={setPanelTab}
            cutHint={timeline.director.enabled ? "auto" : "by hand"}
            className="xl:h-full"
            panels={{
              shot: shotPanel,
              layers: (
                <>
                  <LayerPanel
                    timeline={timeline}
                    media={media}
                    mediaById={mediaById}
                    playheadTime={playheadTime}
                    selection={selection}
                    onSelect={choose}
                    onDispatch={dispatch}
                  />
                  {layerDetail && (
                    <div className="border-t border-[color:var(--hair-dark)]">{layerDetail}</div>
                  )}
                </>
              ),
              sound: (
                <>
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
                  {audioDetail && (
                    <div className="border-t border-[color:var(--hair-dark)]">{audioDetail}</div>
                  )}
                </>
              ),
              cut: <DirectorPanel slug={slug} timeline={timeline} locked={rendering} />,
            }}
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

/**
 * The keys, printed from the same list the handler runs — so this can't drift
 * into describing an editor that no longer exists.
 */
function KeySheet({ onClose }: { onClose: () => void }) {
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Keys"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4 outline-none"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80dvh] w-full max-w-lg overflow-y-auto border border-[color:var(--hair-dark)] bg-ink-900 shadow-deck"
      >
        <div className="flex items-center justify-between border-b border-[color:var(--hair-dark)] px-4 py-3">
          <p className="eyebrow-light">The keys</p>
          <button onClick={onClose} className="btn-quiet-dark focus-ring-dark px-2">
            Close
          </button>
        </div>
        <div className="p-4">
          <p className="mb-4 text-[13px] leading-relaxed text-ink-300">
            Arrows move time, brackets move the thing you picked, up and down move the pick.
            Hold Shift to go further. Nothing here fires while you&apos;re typing.
          </p>
          {KEY_SECTIONS.map((section) => (
            <div key={section} className="mb-4 last:mb-0">
              <p className="eyebrow-light mb-1.5">{section}</p>
              {KEYMAP.filter((entry) => entry.section === section).map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-baseline justify-between gap-4 border-b border-[color:var(--hair-dark)] py-1.5 last:border-b-0"
                >
                  <span className="timecode shrink-0 text-xs text-paper-200">{entry.keys}</span>
                  <span className="text-right text-[13px] text-ink-300">{entry.what}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
