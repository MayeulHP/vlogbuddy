"use client";

import { useCallback, useRef, useState } from "react";
import type { Clip, LayerClip, TimelineDoc, TimelineOp } from "@vlogbuddy/shared";

/**
 * Undo/redo for the bench, per browser.
 *
 * Deliberately *local*: the document is shared, but a stack of "what I just
 * did" isn't. Undoing somebody else's edit because it happened to be the most
 * recent one is never what the button means, so only ops this client
 * dispatched go on the stack — remote `timeline:op` and `timeline:sync` pass it
 * by entirely.
 *
 * Nothing here rolls a document back. An undo is computed as an *inverse op*
 * against the document as it stood before the edit, and then dispatched down
 * the ordinary path, so it broadcasts, persists and reconciles exactly like a
 * hand edit. That also means an inverse can arrive after the thing it was
 * about has gone — the reducer no-ops on ids it can't find, which is the
 * behaviour we want: a stale undo does nothing rather than resurrecting
 * something.
 */

/**
 * One half of a history entry, in the terms the editor can actually perform.
 *
 * Three flavours because the bench has three ways of changing the cut:
 *
 *  - `ops` goes through the editor's own `dispatch`, so `clip.move` still
 *    routes to `reorderCutAction` and everything else down the socket.
 *  - `rawOps` skips that routing and writes the document directly. Only
 *    un-splitting needs it: dropping the second half of a split is a document
 *    edit, not a lift, and routing it through the cut actions would exclude the
 *    whole source file from the film.
 *  - `restore` is the inverse of a lift. A lift is `cutOverride: "exclude"` on
 *    the media item, so putting it back is the same "bring it back" the floor
 *    uses — hand it to the votes again.
 */
export type HistoryAction =
  | { kind: "ops"; ops: TimelineOp[] }
  | { kind: "rawOps"; ops: TimelineOp[] }
  | { kind: "restore"; mediaItemId: string };

export interface HistoryEntry {
  /** Replayed on redo. */
  redo: HistoryAction;
  /** Replayed on undo. */
  undo: HistoryAction;
}

/** Deep enough — a longer memory than this is a document history, not an undo. */
const MAX_DEPTH = 100;

/**
 * Picks the old values of exactly the keys a patch touched, plus `auto`.
 *
 * `auto` rides along because `applyTimelineOp` clears the flags a patch
 * overruled: trimming a shot by hand takes `"timing"` off it for good. Undoing
 * the trim has to give the auto-cut its claim back, or "undo" would quietly
 * leave the shot pinned.
 */
function oldValues<T extends object>(before: T, patch: object): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    out[key] = (before as Record<string, unknown>)[key];
  }
  return out as Partial<T>;
}

/** The whole clip as a patch — everything but its identity. */
function clipAsPatch(clip: Clip): Partial<Omit<Clip, "id">> {
  const { id: _id, ...rest } = clip;
  return rest;
}

function layerAsPatch(layer: LayerClip): Partial<Omit<LayerClip, "id">> {
  const { id: _id, ...rest } = layer;
  return rest;
}

/**
 * The inverse of an op, computed against the document as it stood *before* the
 * op was applied. `null` means "not undoable" — the entry is simply never
 * recorded, and the stack keeps whatever was under it.
 */
export function invertOp(before: TimelineDoc, op: TimelineOp): HistoryAction | null {
  switch (op.type) {
    case "clip.add":
      return { kind: "rawOps", ops: [{ type: "clip.remove", clipId: op.clip.id }] };

    case "clip.remove": {
      // A lift is a vote override, not a document edit, so its inverse is one
      // too. The shot comes back rebuilt from the cut rather than with its old
      // trims — the same deal the floor's "bring it back" offers.
      const clip = before.clips.find((c) => c.id === op.clipId);
      return clip ? { kind: "restore", mediaItemId: clip.mediaItemId } : null;
    }

    case "clip.move": {
      const from = before.clips.findIndex((c) => c.id === op.clipId);
      if (from === -1) return null;
      return { kind: "ops", ops: [{ type: "clip.move", clipId: op.clipId, toIndex: from }] };
    }

    case "clip.update": {
      const clip = before.clips.find((c) => c.id === op.clipId);
      if (!clip) return null;
      return {
        kind: "ops",
        ops: [
          {
            type: "clip.update",
            clipId: op.clipId,
            patch: { ...oldValues(clip, op.patch), auto: clip.auto },
          },
        ],
      };
    }

    case "clip.split": {
      // No generic inverse exists for a split, so the entry carries the whole
      // shot as it was: drop the tail, then write the head back verbatim.
      const clip = before.clips.find((c) => c.id === op.clipId);
      if (!clip) return null;
      return {
        kind: "rawOps",
        ops: [
          { type: "clip.remove", clipId: op.newClipId },
          { type: "clip.update", clipId: op.clipId, patch: clipAsPatch(clip) },
        ],
      };
    }

    case "title.add": {
      const clip = before.clips.find((c) => c.id === op.clipId);
      return {
        kind: "ops",
        ops: [
          { type: "title.remove", clipId: op.clipId, titleId: op.title.id },
          ...(clip ? restoreAuto(clip) : []),
        ],
      };
    }

    case "title.remove": {
      const clip = before.clips.find((c) => c.id === op.clipId);
      const title = clip?.titles.find((t) => t.id === op.titleId);
      if (!clip || !title) return null;
      return {
        kind: "ops",
        ops: [{ type: "title.add", clipId: op.clipId, title }, ...restoreAuto(clip)],
      };
    }

    case "title.update": {
      const clip = before.clips.find((c) => c.id === op.clipId);
      const title = clip?.titles.find((t) => t.id === op.titleId);
      if (!clip || !title) return null;
      return {
        kind: "ops",
        ops: [
          {
            type: "title.update",
            clipId: op.clipId,
            titleId: op.titleId,
            patch: oldValues(title, op.patch),
          },
          ...restoreAuto(clip),
        ],
      };
    }

    case "layer.add":
      return { kind: "ops", ops: [{ type: "layer.remove", layerId: op.layer.id }] };

    case "layer.remove": {
      const layer = before.layers.find((l) => l.id === op.layerId);
      return layer ? { kind: "ops", ops: [{ type: "layer.add", layer }] } : null;
    }

    case "layer.update": {
      const layer = before.layers.find((l) => l.id === op.layerId);
      if (!layer) return null;
      return {
        kind: "ops",
        ops: [{ type: "layer.update", layerId: op.layerId, patch: oldValues(layer, op.patch) }],
      };
    }

    case "audio.add":
      return { kind: "ops", ops: [{ type: "audio.remove", trackId: op.track.id }] };

    case "audio.remove": {
      const track = before.audio.find((t) => t.id === op.trackId);
      return track ? { kind: "ops", ops: [{ type: "audio.add", track }] } : null;
    }

    case "audio.update": {
      const track = before.audio.find((t) => t.id === op.trackId);
      if (!track) return null;
      return {
        kind: "ops",
        ops: [{ type: "audio.update", trackId: op.trackId, patch: oldValues(track, op.patch) }],
      };
    }

    case "settings.update": {
      const patch: { duckClipAudio?: boolean; director?: Partial<TimelineDoc["director"]> } = {};
      if (op.patch.duckClipAudio !== undefined) patch.duckClipAudio = before.duckClipAudio;
      if (op.patch.director) patch.director = oldValues(before.director, op.patch.director);
      return { kind: "ops", ops: [{ type: "settings.update", patch }] };
    }

    /**
     * "Start again" hands every shot back to the auto-cut. It is the one edit
     * that means to lose hand work, and the panel says so — inventing an undo
     * for it would make that promise a lie in one direction and a surprise in
     * the other.
     */
    case "director.recut":
      return null;
  }
}

/** Puts a clip's auto-cut claims back, when an inverse would otherwise drop them. */
function restoreAuto(clip: Clip): TimelineOp[] {
  return clip.auto.length === 0
    ? []
    : [{ type: "clip.update", clipId: clip.id, patch: { auto: clip.auto } }];
}

export interface TimelineHistory {
  /** Records a locally dispatched op, if it has an inverse. */
  record: (before: TimelineDoc, op: TimelineOp) => void;
  /** Pops the last entry and hands back what to run; `null` when empty. */
  takeUndo: () => HistoryEntry | null;
  takeRedo: () => HistoryEntry | null;
  canUndo: boolean;
  canRedo: boolean;
}

export function useTimelineHistory(): TimelineHistory {
  const past = useRef<HistoryEntry[]>([]);
  const future = useRef<HistoryEntry[]>([]);
  // Only the two booleans are state — the stacks themselves are refs so that
  // recording an edit doesn't re-render the whole bench.
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const sync = useCallback(() => {
    setCanUndo(past.current.length > 0);
    setCanRedo(future.current.length > 0);
  }, []);

  const record = useCallback(
    (before: TimelineDoc, op: TimelineOp) => {
      const undo = invertOp(before, op);
      if (!undo) return;
      // Redo is simply the edit again, down the same path it took the first
      // time — including the cut actions, for a lift or a reorder.
      past.current.push({ undo, redo: { kind: "ops", ops: [op] } });
      if (past.current.length > MAX_DEPTH) past.current.shift();
      // A new edit is a new branch; whatever was ahead of it is gone.
      future.current = [];
      sync();
    },
    [sync],
  );

  const takeUndo = useCallback(() => {
    const entry = past.current.pop();
    if (!entry) return null;
    future.current.push(entry);
    sync();
    return entry;
  }, [sync]);

  const takeRedo = useCallback(() => {
    const entry = future.current.pop();
    if (!entry) return null;
    past.current.push(entry);
    sync();
    return entry;
  }, [sync]);

  return { record, takeUndo, takeRedo, canUndo, canRedo };
}
