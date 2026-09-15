"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  MIN_CLIP_SPAN,
  applyTimelineOp,
  clipDuration,
  clipStartTimes,
  timelineDuration,
  type AudioTrack,
  type TimelineDoc,
  type TimelineOp,
  type VideoFormat,
} from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import {
  addToCutAction,
  reorderCutAction,
  setCutOverrideAction,
  setMusicBedAction,
} from "@/lib/actions/cut";
import { useSocketEvent, type VlogSocket } from "@/hooks/use-vlog-socket";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useTimelineHistory, type HistoryAction } from "@/hooks/use-timeline-history";
import { SHORTCUT_LEGEND, useEditorShortcuts } from "@/hooks/use-editor-shortcuts";
import { round2 } from "./trim-bar";
import { ClipInspector } from "./clip-inspector";
import { LayerInspector } from "./layer-inspector";
import { AudioInspector, type SoundState } from "./audio-inspector";
import { LayerPanel, SoundPanel } from "./stack-panels";
import { DirectorPanel } from "./director-panel";
import { FormatPanel } from "./format-panel";
import { PileDrawer, pileCandidates } from "./pile-drawer";
import { TimelineTracks, audioTrackLabel } from "./timeline-tracks";
import { PreviewPlayer, audioSrcFor, type PreviewTransport } from "./preview-player";
import { NO_SELECTION, type Selection } from "./selection";
import { PrintFilmButton } from "../print-film-button";
import { cn } from "@/lib/cn";
import { useDialog } from "@/hooks/use-dialog";
import { beatStatus } from "@/lib/beat-status";

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
  /** The shape this film prints in — the preview has to match the lab. */
  format: VideoFormat;
  /** The operator's render size, read as the film's shorter edge. */
  renderShortEdge: number;
  /** The rate the lab prints at, so a one-frame nudge is really one frame. */
  renderFps: number;
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
  format,
  renderShortEdge,
  renderFps,
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
  /**
   * Which panel the side column is showing. A tab strip rather than a stack of
   * folds: the inspector has to keep the same place on screen when you pick a
   * shot, and anything that opens above it moves it.
   */
  const [panel, setPanel] = useState<PanelId>("inspector");
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [, startTransition] = useTransition();
  /** Local, per browser — see the hook for why it isn't shared. */
  const history = useTimelineHistory();
  /** The transport, borrowed from the picture so Space can reach it. */
  const togglePlayRef = useRef<(() => void) | null>(null);
  /** The same transport, for the inspectors auditioning what they're cutting. */
  const playRangeRef = useRef<PreviewTransport | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);

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

  /**
   * One reading of the bed's tempo for the whole bench, so the ticks on the
   * ruler and the switch that put them there can't tell different stories.
   */
  const beat = useMemo(() => beatStatus(timeline, media, music), [timeline, media, music]);

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

  /**
   * Straight down the socket: a document edit, with none of the cut-engine
   * routing below. Undo reaches for this when it has to put a *document* back
   * — dropping the second half of a split is not a lift, and sending it
   * through the cut actions would throw the whole source file out of the film.
   */
  const sendOp = useCallback(
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

  /** Apply locally for instant feedback, then let the server confirm. */
  const routeOp = useCallback(
    (op: TimelineOp) => {
      /**
       * Running order and membership belong to the cut engine, not to the
       * document: `syncCut` rebuilds the base track's order from `selections`
       * and its membership from `media_items.cutOverride`, so a `clip.move` or
       * `clip.remove` written only to `timelines.doc` is quietly undone by the
       * next vote, upload, cut-line drag or render. These two go through the
       * cut actions instead — and *only* there. `syncCut` broadcasts the
       * document it wrote as `timeline:sync`, so also emitting the op would
       * apply the same change twice and race the authoritative doc; the local
       * apply below covers the instant feedback and the sync lands on top.
       */
      if (op.type === "clip.move" || op.type === "clip.remove") {
        const lifted =
          op.type === "clip.remove"
            ? (timeline.clips.find((c) => c.id === op.clipId)?.mediaItemId ?? null)
            : null;
        const next = applyTimelineOp(timeline, op);
        setTimeline(next);
        setError(null);

        startTransition(async () => {
          const res =
            op.type === "clip.move"
              ? await reorderCutAction(
                  slug,
                  next.clips.map((c) => c.mediaItemId),
                )
              : lifted
                ? await setCutOverrideAction(slug, {
                    targetType: "media",
                    targetId: lifted,
                    override: "exclude",
                  })
                : { ok: true as const, error: undefined };
          if (!res.ok) {
            setError(res.error ?? "That edit didn't stick");
            socket?.emit("timeline:request", { vlogId });
          }
        });
        return;
      }

      sendOp(op);
    },
    [socket, vlogId, slug, timeline, sendOp],
  );

  /**
   * The door everything on the bench goes through. Same routing as before,
   * with the edit written down first so it can be taken back — from the
   * document as it stands *now*, which is the only moment the old values still
   * exist.
   */
  const dispatch = useCallback(
    (op: TimelineOp) => {
      history.record(timeline, op);
      routeOp(op);
    },
    [history, timeline, routeOp],
  );

  /** Replays one half of a history entry. Never recorded — undo isn't an edit. */
  const runAction = useCallback(
    (action: HistoryAction) => {
      if (action.kind === "restore") {
        // The same "bring it back" the floor offers: hand the item to the
        // votes again rather than forcing it in.
        startTransition(async () => {
          const res = await setCutOverrideAction(slug, {
            targetType: "media",
            targetId: action.mediaItemId,
            override: null,
          });
          if (!res.ok) setError(res.error ?? "Couldn't bring that shot back");
        });
        return;
      }
      for (const op of action.ops) {
        if (action.kind === "rawOps") sendOp(op);
        else routeOp(op);
      }
    },
    [slug, sendOp, routeOp],
  );

  const undo = useCallback(() => {
    const entry = history.takeUndo();
    if (entry) runAction(entry.undo);
  }, [history, runAction]);

  const redo = useCallback(() => {
    const entry = history.takeRedo();
    if (entry) runAction(entry.redo);
  }, [history, runAction]);

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
    // Picking something is a request to look at it, whichever panel was up.
    if (next.kind !== "none") setPanel("inspector");
  }, []);

  /**
   * Adding from the pile: the cut engine owns membership and order, so the
   * shot arrives on the `timeline:sync` it broadcasts rather than from an
   * optimistic op. We remember what we asked for and select it when it turns
   * up, which is the only moment the clip has an id.
   */
  const [awaitingMediaId, setAwaitingMediaId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const addFromPile = useCallback(
    (mediaItemId: string, afterMediaItemId: string | null) => {
      setAwaitingMediaId(mediaItemId);
      setAdding(true);
      startTransition(async () => {
        const res = await addToCutAction(slug, mediaItemId, afterMediaItemId);
        setAdding(false);
        if (!res.ok) {
          setAwaitingMediaId(null);
          setError(res.error ?? "Couldn't add that shot");
        }
      });
    },
    [slug],
  );

  useEffect(() => {
    if (!awaitingMediaId) return;
    const landed = timeline.clips.find((c) => c.mediaItemId === awaitingMediaId);
    if (!landed) return;
    setAwaitingMediaId(null);
    setSelection({ kind: "clip", id: landed.id });
  }, [awaitingMediaId, timeline]);

  function chooseBedMusic(musicItemId: string | null) {
    startTransition(() => {
      void setMusicBedAction(slug, musicItemId);
    });
  }

  const starts = useMemo(() => clipStartTimes(timeline, durations), [timeline, durations]);

  /**
   * The keyboard.
   *
   * Everything here goes through the same ops the panels dispatch — the point
   * is to reach the existing edits faster, not to open a second way of making
   * them. Anything the playhead isn't over, or that would leave a flash frame,
   * is simply ignored: a key that does nothing is better than one that does
   * something you didn't aim at.
   */
  const selectedClip =
    selection.kind === "clip" && selected && "titles" in selected ? selected : null;
  const clipStart = selectedClip ? starts[selectedClip.id] ?? 0 : 0;
  const clipSpan = selectedClip
    ? clipDuration(selectedClip, durations[selectedClip.mediaItemId])
    : 0;
  /** Where the playhead sits inside the selected shot, or null if it's outside. */
  const offsetInClip =
    selectedClip && playheadTime > clipStart && playheadTime < clipStart + clipSpan
      ? round2(playheadTime - clipStart)
      : null;

  useEditorShortcuts({
    togglePlay: () => togglePlayRef.current?.(),
    nudge: (seconds) =>
      setPlayheadTime((t) => Math.max(0, Math.min(totalDuration, t + seconds))),
    toStart: () => setPlayheadTime(0),
    toEnd: () => setPlayheadTime(totalDuration),
    undo,
    redo,
    removeSelected: () => {
      if (selection.kind === "clip" && selectedClip) {
        dispatch({ type: "clip.remove", clipId: selectedClip.id });
        setSelection(NO_SELECTION);
      } else if (selection.kind === "layer" && selected && "opacity" in selected) {
        dispatch({ type: "layer.remove", layerId: selected.id });
        setSelection(NO_SELECTION);
      } else if (selection.kind === "audio" && selected && "role" in selected) {
        dispatch({ type: "audio.remove", trackId: selected.id });
        if (selected.role === "bed") chooseBedMusic(null);
        setSelection(NO_SELECTION);
      }
    },
    trimIn: () => {
      // A photo has no source to trim into — its head is wherever the shot
      // before it ends — so `[` has nothing to say about one.
      if (!selectedClip || offsetInClip === null || selectedClip.kind !== "video") return;
      const end = selectedClip.trimEnd ?? durations[selectedClip.mediaItemId] ?? null;
      const trimStart = round2(selectedClip.trimStart + offsetInClip);
      if (end !== null && end - trimStart < MIN_CLIP_SPAN) return;
      dispatch({ type: "clip.update", clipId: selectedClip.id, patch: { trimStart } });
    },
    trimOut: () => {
      if (!selectedClip || offsetInClip === null) return;
      if (offsetInClip < MIN_CLIP_SPAN) return;
      if (selectedClip.kind === "photo") {
        dispatch({
          type: "clip.update",
          clipId: selectedClip.id,
          patch: { duration: offsetInClip },
        });
        return;
      }
      dispatch({
        type: "clip.update",
        clipId: selectedClip.id,
        patch: { trimEnd: round2(selectedClip.trimStart + offsetInClip) },
      });
    },
    splitAtPlayhead: () => {
      if (!selectedClip || offsetInClip === null) return;
      // The same test the inspector's button greys out on.
      if (offsetInClip < MIN_CLIP_SPAN || clipSpan - offsetInClip < MIN_CLIP_SPAN) return;
      if (selectedClip.kind === "video" && selectedClip.trimEnd === null) return;
      const newClipId = globalThis.crypto.randomUUID();
      dispatch({ type: "clip.split", clipId: selectedClip.id, at: offsetInClip, newClipId });
      choose({ kind: "clip", id: newClipId });
    },
    shuttle: (rate) => playRangeRef.current?.setRate(rate),
    // A frame means the film's real frame, not a guess: the nudge keys land on
    // the same grid the lab prints on.
  }, { fps: renderFps });

  /**
   * Below `md` the side panel has nowhere to be, so the inspector comes up over
   * the bench as a sheet instead. Same element either way — only where it hangs
   * changes.
   */
  const asSheet = useMediaQuery("(max-width: 767px)");

  const inspector =
    selection.kind === "clip" && selected && "titles" in selected ? (
      <ClipInspector
        slug={slug}
        clip={selected}
        media={mediaById.get(selected.mediaItemId) ?? null}
        index={timeline.clips.findIndex((c) => c.id === selected.id)}
        total={timeline.clips.length}
        format={format}
        fitPolicy={timeline.director.fitPolicy}
        playheadTime={playheadTime}
        clipStart={starts[selected.id] ?? 0}
        transportRef={playRangeRef}
        onSeek={setPlayheadTime}
        onSelectClip={(id) => choose({ kind: "clip", id })}
        onDispatch={dispatch}
      />
    ) : selection.kind === "layer" && selected && "opacity" in selected ? (
      <LayerInspector
        layer={selected}
        media={mediaById.get(selected.mediaItemId) ?? null}
        totalDuration={totalDuration}
        playheadTime={playheadTime}
        onDispatch={dispatch}
      />
    ) : selection.kind === "audio" && selected && "role" in selected ? (
      <AudioInspector
        track={selected}
        label={audioTrackLabel(selected, mediaById, musicById)}
        totalDuration={totalDuration}
        sound={soundStateFor(selected, mediaById, musicById)}
        src={audioSrcFor(selected, mediaById, musicById)}
        transportRef={playRangeRef}
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

  /** What's sitting out of the film — the number on the Pile tab. */
  const clipMediaIds = useMemo(
    () => new Set(timeline.clips.map((c) => c.mediaItemId)),
    [timeline],
  );
  const pileCount = useMemo(
    () => pileCandidates(media, clipMediaIds).length,
    [media, clipMediaIds],
  );

  /**
   * The inspector's tab is named after what's selected, so the column says what
   * it's about to show you rather than what kind of thing it is. On a phone the
   * inspector is the sheet instead, so it isn't offered here at all.
   *
   * Five tabs, because five is what fits in a 300px column without a scroll —
   * and a strip that scrolls with no hint of it is a strip whose last tab
   * doesn't exist. The two you set once and leave — how the auto-cut plays and
   * what shape it prints in — share one "Film" tab, stacked; the three you
   * reach for while cutting each keep their own.
   */
  const tabs: { id: PanelId; label: string; count?: number }[] = [
    ...(asSheet ? [] : [{ id: "inspector" as const, label: inspectorLabel(selection) }]),
    { id: "pile", label: "Pile", count: pileCount },
    { id: "layers", label: "Layers", count: timeline.layers.length },
    { id: "sound", label: "Mix", count: timeline.audio.length },
    { id: "film", label: "Film" },
  ];

  const activePanel = tabs.some((t) => t.id === panel) ? panel : "film";

  /**
   * The bench's whole chrome, on one slim row over the picture. There is no
   * masthead here any more: on a fixed-viewport bench every line of preamble is
   * a line of strip you can't see, and the room already says which one it is.
   */
  const toolbar = (
    <div className="mb-2 flex items-center gap-2">
      <button onClick={onBackToGather} className="btn-quiet-dark shrink-0">
        ← Back to the floor
      </button>
      <button
        type="button"
        onClick={undo}
        disabled={!history.canUndo}
        aria-label="Undo"
        title="Undo (⌘Z)"
        className="btn-quiet-dark shrink-0 disabled:opacity-40"
      >
        ↩
      </button>
      <button
        type="button"
        onClick={redo}
        disabled={!history.canRedo}
        aria-label="Redo"
        title="Redo (⌘⇧Z)"
        className="btn-quiet-dark shrink-0 disabled:opacity-40"
      >
        ↪
      </button>
      {/* The keys, where the hands already are. A card rather than a page:
          nobody leaves the bench to look up a shortcut. */}
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => setLegendOpen((open) => !open)}
          aria-expanded={legendOpen}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts"
          className="btn-quiet-dark"
        >
          ?
        </button>
        {legendOpen && (
          <div className="absolute left-0 top-full z-40 mt-1 w-64 border border-[color:var(--hair-dark)] bg-ink-900 p-3 shadow-deck">
            <p className="eyebrow-light mb-2">Keys</p>
            <dl className="space-y-1.5">
              {SHORTCUT_LEGEND.map((row) => (
                <div key={row.keys} className="flex items-baseline gap-2">
                  <dt className="w-20 shrink-0 font-mono text-2xs text-paper-100">{row.keys}</dt>
                  <dd className="min-w-0 flex-1 text-[11px] leading-snug text-ink-300">
                    {row.what}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
      <span className="min-w-0 flex-1" />
      {/* The same trigger sits at the foot of the rough cut on the floor;
          the director's panel locks while the film is on its way. */}
      {isCreator && (
        <PrintFilmButton
          slug={slug}
          disabled={timeline.clips.length === 0}
          onPendingChange={setRendering}
          className="shrink-0"
        />
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-4 md:h-full md:min-h-0 md:gap-3">
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
      <div className="grid min-h-0 grid-cols-1 gap-4 md:flex-1 md:grid-cols-[minmax(0,1fr)_300px] md:gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        {/*
          Picture over strip, and neither one allowed to push the other off the
          screen: the picture is capped by its own height and the strip takes
          what's left, scrolling inside itself if its lanes need more. Before
          this the strip stretched to match the side column and most of it was
          void.
        */}
        <div className="flex min-w-0 flex-col gap-3 md:min-h-0">
          <PreviewPlayer
            toolbar={toolbar}
            /*
             * 45vh of picture, but never so much that the strip is left with
             * nothing: on a 720px screen 45vh plus the chrome is the whole
             * window, and what falls off the bottom is the lanes. The subtracted
             * figure is the rest of the bench — masthead, footer, transport and
             * a strip tall enough to show its picture lane — so the picture
             * gives way first and both stay on screen.
             */
            heightCap={asSheet ? "56vh" : "max(180px, min(45vh, 100dvh - 470px))"}
            timeline={timeline}
            format={format}
            mediaById={mediaById}
            musicById={musicById}
            durations={durations}
            playheadTime={playheadTime}
            onTimeChange={setPlayheadTime}
            selectedClipId={selection.kind === "clip" ? selection.id : null}
            onSelectClip={(id) => choose({ kind: "clip", id })}
            selectedLayerId={selection.kind === "layer" ? selection.id : null}
            onSelectLayer={(id) => choose({ kind: "layer", id })}
            onDispatch={dispatch}
            togglePlayRef={togglePlayRef}
            playRangeRef={playRangeRef}
          />

          <TimelineTracks
            timeline={timeline}
            mediaById={mediaById}
            music={music}
            beat={beat}
            durations={durations}
            totalDuration={totalDuration}
            selection={selection}
            onSelect={choose}
            onDispatch={dispatch}
            playheadTime={playheadTime}
            onSeek={setPlayheadTime}
            onBackToGather={onBackToGather}
            /*
             * Content height, capped at whatever the picture left over. Not
             * `flex-1`: the lanes are ~170px and a strip stretched to 900px is
             * 700px of nothing between you and the rest of the bench.
             */
            className="min-h-0 md:max-h-full"
          />
        </div>

        {/*
          The side column, as tabs rather than a stack of folds. The inspector
          is the one panel that has to hold still — you pick a shot on the strip
          and read it here — so nothing is allowed to open above it and shove it
          down the page. Everything else takes its turn in the same box, and
          picking anything brings the inspector straight back.
        */}
        <aside className="flex min-h-0 flex-col border border-[color:var(--hair-dark)] bg-ink-850 md:overflow-hidden">
          <div
            role="tablist"
            aria-label="Bench panels"
            className="flex shrink-0 items-stretch border-b border-[color:var(--hair-dark)]"
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                type="button"
                aria-selected={activePanel === t.id}
                onClick={() => setPanel(t.id)}
                className={cn(
                  // Equal shares of the column rather than natural widths, so
                  // the row ends exactly where the column does at any size and
                  // nothing can hide past the edge. 40px tall for a thumb.
                  "flex min-h-[42px] min-w-0 flex-1 items-center justify-center gap-1 border-r border-[color:var(--hair-dark)] px-0.5 py-2 font-mono text-2xs uppercase tracking-label transition-colors last:border-r-0",
                  activePanel === t.id
                    ? "bg-paper-100 text-ink-900"
                    : "text-ink-400 hover:bg-ink-800 hover:text-paper-100",
                )}
              >
                <span className="truncate">{t.label}</span>
                {t.count !== undefined && t.count > 0 && (
                  <span className="shrink-0 tabular-nums opacity-60">{t.count}</span>
                )}
              </button>
            ))}
          </div>

          <div className="scrollbar-thin scrollbar-dark min-h-0 flex-1 md:overflow-y-auto">
            {/* On a phone this same inspector arrives as a sheet instead. */}
            {activePanel === "inspector" && inspector}

            {activePanel === "pile" && (
              <PileDrawer
                media={media}
                clipMediaIds={clipMediaIds}
                currentMediaItemId={selectedClip?.mediaItemId ?? null}
                currentLabel={
                  selectedClip
                    ? `shot ${timeline.clips.findIndex((c) => c.id === selectedClip.id) + 1}`
                    : null
                }
                busy={adding || rendering}
                onAdd={addFromPile}
              />
            )}

            {activePanel === "layers" && (
              <LayerPanel
                timeline={timeline}
                media={media}
                mediaById={mediaById}
                playheadTime={playheadTime}
                selection={selection}
                onSelect={choose}
                onDispatch={dispatch}
                bare
              />
            )}

            {activePanel === "sound" && (
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
                bare
              />
            )}

            {/* How the film plays and what shape it plays in, stacked in the
                order you'd settle them. Both are the whole crew's: printing is
                the creator's alone, but what the film looks like isn't. */}
            {activePanel === "film" && (
              <>
                <DirectorPanel
                  slug={slug}
                  timeline={timeline}
                  mediaById={mediaById}
                  beat={beat}
                  locked={rendering}
                  bare
                />
                <div className="border-t border-[color:var(--hair-dark)]">
                  <FormatPanel
                    slug={slug}
                    format={format}
                    shortEdge={renderShortEdge}
                    fitPolicy={timeline.director.fitPolicy}
                    layers={timeline.layers.length}
                    locked={rendering}
                    bare
                  />
                </div>
              </>
            )}
          </div>
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
  // Escape, the scroll lock and putting focus back on the strip all come from
  // the hook, so the sheet keeps the same manners as the lightbox and the deck.
  const ref = useDialog<HTMLDivElement>(onClose);

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 md:hidden">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="pb-safe max-h-[72dvh] animate-slide-up overflow-y-auto overscroll-contain border-t border-[color:var(--hair-dark)] bg-ink-900 shadow-deck focus:outline-none"
      >
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


/** The panels the side column can show — one at a time, same box. */
type PanelId = "inspector" | "pile" | "film" | "layers" | "sound";

/** What the inspector is currently about, as a tab can say it. */
function inspectorLabel(selection: Selection): string {
  return selection.kind === "clip"
    ? "Shot"
    : selection.kind === "layer"
      ? "Layer"
      : selection.kind === "audio"
        ? "Track"
        : // Short on purpose: the strip divides the column evenly, so the
          // longest label sets how narrow every tab has to survive.
          "Nothing";
}
