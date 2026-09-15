"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  MIN_CLIP_SPAN,
  applyTimelineOp,
  clipDuration,
  clipStartTimes,
  formatDuration,
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
import { KBD_HINT } from "./kbd";
import { ClipInspector } from "./clip-inspector";
import { LayerInspector } from "./layer-inspector";
import { AudioInspector, type SoundState } from "./audio-inspector";
import { LayerPicker, SoundPicker, BedSettings } from "./stack-panels";
import { DirectorPanel, DirectorRecut } from "./director-panel";
import { FormatPanel } from "./format-panel";
import { PileDrawer } from "./pile-drawer";
import { ADD_KINDS, TimelineTracks, audioTrackLabel, type AddKind } from "./timeline-tracks";
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
  /**
   * The settings that belong to the film rather than to a shot. A sheet at
   * every width — the ⚙ on the phone's tool row and the ⚙ on the desk toolbar
   * open the same thing — because these are a handful of decisions you settle
   * once, and a tab is a thing you're meant to keep coming back to.
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [playheadTime, setPlayheadTime] = useState(0);
  /**
   * Which add-picker is open, if any. It lives here rather than on the strip
   * because the same three pickers are a popover anchored to their button on
   * `md` and up and a bottom sheet below it — the sheet hangs off the bench,
   * not off a toolbar that scrolls.
   *
   * The phone lane reads this too: `addOpen && asSheet` is the hook for the
   * sheet, with `addPicker(addOpen)` for its body.
   */
  const [addOpen, setAddOpen] = useState<AddKind | null>(null);
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

  // The side column is the inspector and nothing else now, so picking something
  // has nowhere to switch to — it just shows up.
  const choose = useCallback((next: Selection) => {
    setSelection(next);
    setSheetOpen(next.kind !== "none");
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

  /**
   * Taking the selected thing out of the film. Two ways in — the Delete key and
   * the phone sheet's footer — and one body, because "back from Trip" and the
   * bed falling back to dry have to happen whichever one you used.
   */
  function dropSelected() {
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
  }

  useEditorShortcuts({
    togglePlay: () => togglePlayRef.current?.(),
    nudge: (seconds) =>
      setPlayheadTime((t) => Math.max(0, Math.min(totalDuration, t + seconds))),
    toStart: () => setPlayheadTime(0),
    toEnd: () => setPlayheadTime(totalDuration),
    undo,
    redo,
    removeSelected: dropSelected,
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

  /** What's sitting out of the film — the number on the Pile tab. */
  const clipMediaIds = useMemo(
    () => new Set(timeline.clips.map((c) => c.mediaItemId)),
    [timeline],
  );
  /**
   * The three pickers the strip toolbar opens, built here so the popover on a
   * desk and the sheet on a phone are the same component with the same state.
   */
  const addPicker = useCallback(
    (kind: AddKind, done: () => void) => {
      if (kind === "shot") {
        return (
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
            onAdd={(mediaItemId, after) => {
              addFromPile(mediaItemId, after);
              done();
            }}
          />
        );
      }
      if (kind === "layer") {
        return (
          <LayerPicker
            timeline={timeline}
            media={media}
            playheadTime={playheadTime}
            onDispatch={dispatch}
            onDone={done}
          />
        );
      }
      return (
        <SoundPicker
          music={music}
          media={media}
          playheadTime={playheadTime}
          onDispatch={dispatch}
          onDone={done}
        />
      );
    },
    [
      media,
      music,
      clipMediaIds,
      selectedClip,
      timeline,
      adding,
      rendering,
      addFromPile,
      playheadTime,
      dispatch,
    ],
  );

  /**
   * What the side column is about, in words that don't move. The label used to
   * be a tab that renamed itself Shot / Layer / Track / Nothing, so the same
   * place on screen read as four different things; the column only ever holds
   * the inspector now, so it can say so once and put what's selected after it.
   */
  const selectedLine =
    selection.kind === "clip" && selectedClip
      ? `Shot ${String(timeline.clips.findIndex((c) => c.id === selectedClip.id) + 1).padStart(2, "0")} of ${timeline.clips.length}`
      : selection.kind === "layer" && selected && "layer" in selected
        ? `Layer ${selected.layer}`
        : selection.kind === "audio" && selected && "role" in selected
          ? selected.role === "bed"
            ? "Music"
            : "Sound"
          : "Nothing yet";

  /**
   * The film's own settings, in the order you'd settle them: what shape it is,
   * how it plays, what's underneath it — then the one button that throws the
   * cut away, pinned to the footer rather than sitting in the middle of the
   * list.
   *
   * Written once and opened from two ⚙s, the phone's tool row and the desk
   * toolbar, because two copies of a settings panel is two copies to forget to
   * change.
   */
  const filmSettings = (
    <>
      <FormatPanel
        slug={slug}
        format={format}
        shortEdge={renderShortEdge}
        layers={timeline.layers.length}
        locked={rendering}
      />
      <div className="border-t border-[color:var(--hair-dark)]">
        <DirectorPanel
          slug={slug}
          timeline={timeline}
          mediaById={mediaById}
          beat={beat}
          locked={rendering}
        />
      </div>
      {/* The bed is the crew's, not the cutter's — it comes off the vote on the
          floor — so it sits with the settings rather than with the verbs on the
          strip. */}
      <div className="border-t border-[color:var(--hair-dark)]">
        <BedSettings
          timeline={timeline}
          music={music}
          media={media}
          onDispatch={dispatch}
          onChooseBedMusic={chooseBedMusic}
        />
      </div>
    </>
  );

  /** What the sheet's footer offers to take out, named for what's selected. */
  const dropLabel =
    selection.kind === "clip"
      ? "Take this shot out"
      : selection.kind === "layer"
        ? "Take this layer out"
        : selection.kind === "audio"
          ? "Take this track out"
          : null;

  /**
   * The bench's whole chrome, on one slim row over the picture — and across the
   * whole column, not just the picture's width, so the one action that changes
   * the world sits at the right edge of the room rather than floating mid-page.
   * There is no masthead here any more: on a fixed-viewport bench every line of
   * preamble is a line of strip you can't see, and the room already says which
   * one it is. Leaving the room is the rail's job, not the toolbar's — the only
   * "back" left is the one in the empty strip, where there's nothing else to do.
   */
  const toolbar = (
    <div className="mb-2 flex items-center gap-2">
      <button
        type="button"
        onClick={undo}
        disabled={!history.canUndo}
        aria-label="Undo"
        title="Undo (⌘Z)"
        className="btn-quiet-dark shrink-0 disabled:opacity-40"
      >
        ↩<span className="ml-1.5 hidden md:inline">Undo</span>
        <kbd className={KBD_HINT}>⌘Z</kbd>
      </button>
      <button
        type="button"
        onClick={redo}
        disabled={!history.canRedo}
        aria-label="Redo"
        title="Redo (⌘⇧Z)"
        className="btn-quiet-dark shrink-0 disabled:opacity-40"
      >
        ↪<span className="ml-1.5 hidden md:inline">Redo</span>
        <kbd className={KBD_HINT}>⌘⇧Z</kbd>
      </button>
      {/* The keys, where the hands already are. A card rather than a page:
          nobody leaves the bench to look up a shortcut. Hidden on a phone,
          which has no keys to press. */}
      <div className="relative hidden shrink-0 md:block">
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
      {/* How long the film is and how many shots it's made of — the two numbers
          anyone cutting keeps glancing at. On the toolbar rather than buried in
          the transport, where the running time was competing with the playhead
          clock for the same glance. */}
      <span className="timecode shrink-0 text-2xs text-ink-300">
        {formatDuration(totalDuration)}
        <span className="mx-1.5 text-ink-500">·</span>
        {timeline.clips.length} shot{timeline.clips.length === 1 ? "" : "s"}
      </span>
      {/* The film's settings, next to the numbers they change and a step short
          of the one button that prints. A sheet rather than a tab in the side
          column: shape, pace and score are settled once, and the column is
          needed for the shot you're actually cutting. The phone has the same
          button on its own row under the picture. */}
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        aria-expanded={settingsOpen}
        title="Film settings"
        className="btn-quiet-dark hidden shrink-0 md:inline-flex"
      >
        <span aria-hidden>⚙</span>
        <span className="ml-1.5 hidden lg:inline">Film settings</span>
      </button>
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
    /*
      `touch-bench` is the grown-up sizing for a fingertip: the bench is full of
      hand-rolled 24px buttons that `.btn`'s touch rule never reached, and one
      class on the room is better than thirty scattered guards. See globals.css.

      `h-full` at every width now, not just `md:` — below `md` the bench is the
      same fixed viewport it is on a desk: picture, tool row, strip, and the
      bottom bar. Nothing under the fold, because on a phone the fold is most of
      the page.
    */
    <div className="touch-bench flex h-full min-h-0 flex-col gap-2 md:gap-3">
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
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_300px] md:gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        {/*
          Picture over strip, and neither one allowed to push the other off the
          screen: the picture is capped by its own height and the strip takes
          what's left, scrolling inside itself if its lanes need more. Before
          this the strip stretched to match the side column and most of it was
          void.
        */}
        <div className="flex min-h-0 min-w-0 flex-col gap-2 md:gap-3">
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
            /*
             * On a phone: 40dvh and not a pixel more. The picture is the thing
             * you look at but the strip is the thing you work on, and at 56vh
             * the strip had nowhere to be but below the fold. `dvh` rather than
             * `vh` because a mobile browser's toolbars come and go, and a
             * picture measured against the *large* viewport overflows the small
             * one the moment the address bar slides back in.
             */
            heightCap={asSheet ? "40dvh" : "max(180px, min(45vh, 100dvh - 470px))"}
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

          {/*
            The film's own settings, on a phone. The three verbs that add to the
            strip already sit on the strip's toolbar just below this, where the
            thing they add lands; what has no home on a phone is the side
            column's Film tab, so it gets the fourth seat on the tool row and
            opens as a sheet like everything else here.
          */}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex min-h-[44px] shrink-0 items-center gap-2 border border-[color:var(--hair-dark)] bg-ink-850 px-3 font-mono text-2xs uppercase tracking-label text-ink-300 md:hidden"
          >
            <span aria-hidden>⚙</span> Film settings
          </button>

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
            addOpen={addOpen}
            onAddOpenChange={setAddOpen}
            renderAddPicker={addPicker}
            anchoredPickers={!asSheet}
            /*
             * Content height, capped at whatever the picture left over. Not
             * `flex-1`: the lanes are ~170px and a strip stretched to 900px is
             * 700px of nothing between you and the rest of the bench.
             */
            className="min-h-0 flex-1 md:max-h-full md:flex-none"
          />
        </div>

        {/*
          The side column is the inspector, full stop. It used to be a tab strip
          whose first tab renamed itself after the selection and whose last one
          held the film's settings — a navigation the size of the smallest type
          on the page, in front of one panel anybody actually reads. The
          settings are a sheet now and nothing else takes turns in this box, so
          what's left is a header that says what you're looking at and the thing
          itself.
        */}
        {/* Below `md` this column doesn't exist: the inspector is the sheet, so
            a stacked copy here would be the screen-and-a-half of scroll the
            sheet was built to replace. */}
        <aside className="hidden min-h-0 flex-col border border-[color:var(--hair-dark)] bg-ink-850 md:flex md:overflow-hidden">
          <div className="flex min-h-[40px] shrink-0 items-center gap-2 border-b border-[color:var(--hair-dark)] px-3 py-2">
            <span className="eyebrow-light shrink-0 text-xs">Selected</span>
            <span aria-hidden className="text-ink-600">
              ·
            </span>
            <span className="timecode min-w-0 flex-1 truncate text-xs text-paper-100">
              {selectedLine}
            </span>
          </div>

          <div className="scrollbar-thin scrollbar-dark min-h-0 flex-1 md:overflow-y-auto">
            {/* On a phone this same inspector arrives as a sheet instead. */}
            {inspector}
          </div>
        </aside>
      </div>

      {/*
        The phone's whole second storey. Nothing below the fold, because there
        is no fold: the bench is a fixed viewport and everything that isn't the
        picture, the tool row or the strip arrives over it in the same sheet,
        with the same way out in the same corner.
      */}
      {asSheet && sheetOpen && selection.kind !== "none" && (
        <BenchSheet
          title={selectedLine}
          onClose={() => setSheetOpen(false)}
          footer={
            dropLabel && (
              <button
                onClick={() => {
                  dropSelected();
                  setSheetOpen(false);
                }}
                className="btn-outline-dark w-full border-signal-700/50 text-signal-300 hover:border-signal-500 hover:bg-signal-900/40 hover:text-signal-200"
              >
                {dropLabel}
              </button>
            )
          }
        >
          {inspector}
        </BenchSheet>
      )}

      {/* The three pickers, as sheets. The strip's own buttons hold the state;
          on a desk the same `addPicker` hangs off them as a popover instead. */}
      {asSheet && addOpen && (
        <BenchSheet
          title={ADD_KINDS.find((k) => k.kind === addOpen)?.label ?? "Add"}
          onClose={() => setAddOpen(null)}
        >
          {addPicker(addOpen, () => setAddOpen(null))}
        </BenchSheet>
      )}

      {/* The one sheet that exists at every width: on a phone it comes up from
          the bottom like the rest, on a desk it slides over the side column at
          the column's own width, so the picture and the strip never move. */}
      {settingsOpen && (
        <BenchSheet
          title="Film settings"
          onClose={() => setSettingsOpen(false)}
          side
          footer={<DirectorRecut slug={slug} timeline={timeline} locked={rendering} />}
        >
          {filmSettings}
        </BenchSheet>
      )}
    </div>
  );
}

/**
 * Every secondary panel, on a phone.
 *
 * A 320px side panel doesn't exist at 375px — stacked under a timeline it ends
 * up a screen and a half below the thing it's describing, which is the one
 * place it can't be. So on a phone the bench keeps only the picture, the tool
 * row and the strip, and everything else comes up over it in this one sheet:
 * the inspector (tied to the selection — pick a shot and it's there), the three
 * "+" pickers, and the film's settings. One shape for all of them, so the way
 * out is always the same word in the same corner.
 *
 * The body scrolls, the header and the footer don't: the action that ends the
 * errand — "Take this shot out", "Done" — has to be reachable without first
 * reading to the bottom of a panel that is taller than the sheet.
 */
function BenchSheet({
  title,
  onClose,
  footer,
  side = false,
  children,
}: {
  title: string;
  onClose: () => void;
  /** The one action the sheet is for, pinned where a thumb already is. */
  footer?: React.ReactNode;
  /**
   * Also exists on a desk, anchored to the right edge at the side column's
   * width. Everything else here is a phone-only stand-in for the column, so
   * `md:hidden` is the default.
   */
  side?: boolean;
  children: React.ReactNode;
}) {
  // Escape, the scroll lock and putting focus back on the strip all come from
  // the hook, so the sheet keeps the same manners as the lightbox and the deck.
  const ref = useDialog<HTMLDivElement>(onClose);

  return (
    <div
      className={cn(
        "fixed inset-x-0 bottom-0 z-50",
        side
          ? "md:inset-y-0 md:left-auto md:right-0 md:bottom-0 md:w-[300px] xl:w-[320px]"
          : "md:hidden",
      )}
    >
      {/* Clicking off it is the same "I'm done" as Escape — but only where the
          sheet is a panel beside the work, not over it. */}
      {side && (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          onClick={onClose}
          className="fixed inset-0 -z-10 hidden cursor-default bg-ink-900/40 md:block"
        />
      )}
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          "pb-safe flex max-h-[72dvh] animate-slide-up flex-col border-t border-[color:var(--hair-dark)] bg-ink-900 shadow-deck focus:outline-none",
          side && "md:h-full md:max-h-none md:border-l md:border-t-0",
        )}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-[color:var(--hair-dark)] bg-ink-900 px-3 py-2">
          <span aria-hidden className="h-1 w-8 shrink-0 bg-ink-600" />
          <p className="eyebrow-light min-w-0 flex-1 truncate">{title}</p>
          <button onClick={onClose} className="btn-outline-dark px-3" aria-label="Close">
            Done
          </button>
        </div>
        <div className="scrollbar-thin scrollbar-dark min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {children}
        </div>
        {footer && (
          <div className="shrink-0 border-t border-[color:var(--hair-dark)] bg-ink-900 px-3 py-2">
            {footer}
          </div>
        )}
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


