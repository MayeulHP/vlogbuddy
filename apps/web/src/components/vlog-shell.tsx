"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RenderJob } from "@vlogbuddy/db";
import {
  VLOG_STATES,
  VLOG_STATE_LABELS,
  isWorkingState,
  type ReactionTier,
  type TimelineDoc,
  type VideoFormat,
  type VlogState,
  type WorkspaceTab,
} from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import type { PublicImmichConnection } from "@/lib/immich";
import { useSocketEvent, useVlogSocket } from "@/hooks/use-vlog-socket";
import { cn } from "@/lib/cn";
import { GatherView } from "./gather/gather-view";
import { EditorView } from "./editor/editor-view";
import { RenderView } from "./render/render-view";
import { ShareBar } from "./share-bar";
import { WorkspaceNav } from "./workspace-nav";
import { PresenceBar } from "./presence-bar";
import { Wordmark } from "./brand";

export interface VlogShellProps {
  vlog: {
    id: string;
    title: string;
    description: string | null;
    shareSlug: string;
    state: VlogState;
    scoreThreshold: number;
    /** The shape it prints at — the bench previews against it. */
    format: VideoFormat;
  };
  member: { id: string; displayName: string; role: "creator" | "friend" };
  members: { id: string; displayName: string; role: "creator" | "friend" }[];
  media: MediaItemView[];
  music: MusicItemView[];
  timeline: TimelineDoc;
  timelineRevision: number;
  reactionTiers: ReactionTier[];
  latestRender: RenderJob | null;
  publishedRender: (RenderJob & { url: string; downloadUrl: string }) | null;
  shareUrl: string;
  immichConnection: PublicImmichConnection | null;
  /** The operator's render size, read as the frame's shorter edge. */
  renderShortEdge: number;
}

export function VlogShell(props: VlogShellProps) {
  const { vlog, member, media, music, reactionTiers, shareUrl } = props;
  const router = useRouter();
  const { socket, connected, presence } = useVlogSocket(vlog.id);
  const [state, setState] = useState<VlogState>(vlog.state);
  const [tab, setTab] = useTabPreference(vlog.shareSlug, vlog.state);

  useEffect(() => setState(vlog.state), [vlog.state]);

  /**
   * Server components own the data, so realtime events just trigger a refresh.
   * Debounced because a burst of uploads or votes would otherwise thrash it.
   */
  const refresh = useDebouncedRefresh(router.refresh, 250);

  useSocketEvent(socket, "media:added", refresh);
  useSocketEvent(socket, "media:updated", refresh);
  useSocketEvent(socket, "media:removed", refresh);
  useSocketEvent(socket, "music:added", refresh);
  useSocketEvent(socket, "music:removed", refresh);
  useSocketEvent(socket, "reaction:updated", refresh);
  useSocketEvent(socket, "selection:updated", refresh);
  useSocketEvent(socket, "selection:reordered", refresh);
  useSocketEvent(socket, "music:moved", refresh);
  useSocketEvent(socket, "vlog:threshold", refresh);
  // The shape lives on the vlog row, so the server components own it like
  // everything else — a refresh is the whole of the handling.
  useSocketEvent(socket, "vlog:format", refresh);
  // The cut engine rebuilds the timeline whenever a vote moves the line.
  useSocketEvent(socket, "timeline:sync", refresh);

  useSocketEvent(
    socket,
    "vlog:state",
    useCallback(
      ({ state: next }: { state: VlogState }) => {
        setState(next);
        // A render locks everything, so take everyone to the screening room.
        if (!isWorkingState(next)) setTab("watch");
        router.refresh();
      },
      [router, setTab],
    ),
  );

  const isCreator = member.role === "creator";
  const working = isWorkingState(state);

  const unrated = useMemo(
    () =>
      media.filter(
        (m) => m.kind !== "audio" && m.status === "ready" && m.reactions.mine === null,
      ).length,
    [media],
  );

  // Rendering locks the workshop; nudge anyone still in it over to Watch.
  const effectiveTab: WorkspaceTab = working ? tab : "watch";

  const dark = effectiveTab !== "gather";
  /**
   * The cutting bench is the one room that owns the whole window: an editor
   * you have to scroll is an editor whose picture and strip are never both in
   * front of you. It takes the viewport from `xl` up, which is where the
   * inspector column exists — below that the page scrolls as every other room
   * does, because a 240px panel wedged into a laptop's remaining height is
   * worse than a scroll.
   */
  const fitsViewport = effectiveTab === "edit";

  return (
    <div
      className={cn(
        "flex min-h-screen flex-col",
        dark ? "bg-ink-900" : "bg-paper-100",
        fitsViewport &&
          "xl:grid xl:h-[100dvh] xl:min-h-0 xl:grid-rows-[auto_minmax(0,1fr)] xl:overflow-hidden",
      )}
    >
      {/* ---------- masthead: always paper, whatever room you're in ---------- */}
      <header className="pt-safe px-safe sticky top-0 z-30 border-b border-[color:var(--hair-strong)] bg-paper-100/95 backdrop-blur">
        <div className="mx-auto max-w-[1600px] px-4 sm:px-7">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 pt-2.5 sm:pt-3">
            <div className="flex min-w-0 flex-1 items-baseline gap-2 sm:gap-3">
              <Wordmark size="sm" className="hidden shrink-0 sm:inline-flex" />
              <span
                aria-hidden
                className="hidden h-4 w-px shrink-0 bg-[color:var(--hair-strong)] sm:block"
              />
              <div className="min-w-0 flex-1">
                <h1 className="headline truncate text-lg leading-none sm:text-2xl">
                  {vlog.title}
                </h1>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2 sm:gap-3">
              <PresenceBar presence={presence} connected={connected} selfId={member.id} />
              <ShareBar shareUrl={shareUrl} />
            </div>
          </div>

          {/* Slate line — the numbers, in mono, never shouting. */}
          <div className="scrollbar-thin touch-scroll-x -mx-4 mt-1.5 flex items-center gap-x-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:flex-wrap sm:gap-y-1 sm:overflow-visible sm:px-0 sm:pb-0">
            {[
              `${media.length} clip${media.length === 1 ? "" : "s"}`,
              `${music.length} track${music.length === 1 ? "" : "s"}`,
              `${props.members.length} crew`,
              VLOG_STATE_LABELS[state],
            ].map((bit, i) => (
              <span key={bit} className="flex shrink-0 items-center gap-3">
                {i > 0 && <span aria-hidden className="h-2.5 w-px bg-[color:var(--hair)]" />}
                <span className="eyebrow whitespace-nowrap">{bit}</span>
              </span>
            ))}
          </div>

          {/* On a phone the same three rooms live in the bottom bar instead. */}
          <div className="mt-2 hidden md:block">
            <WorkspaceNav
              tab={effectiveTab}
              onTab={setTab}
              state={state}
              counts={{
                clips: props.timeline.clips.length,
                unrated,
                hasRender: Boolean(props.latestRender),
              }}
            />
          </div>
        </div>
      </header>

      <main
        className={cn(
          "mx-auto w-full max-w-[1600px] flex-1 px-4 py-5 sm:px-7 sm:py-7",
          fitsViewport && "xl:min-h-0 xl:px-4 xl:py-3",
        )}
      >
        {effectiveTab === "gather" && (
          <GatherView
            slug={vlog.shareSlug}
            media={media}
            music={music}
            timeline={props.timeline}
            reactionTiers={reactionTiers}
            memberId={member.id}
            crew={props.members.length}
            scoreThreshold={vlog.scoreThreshold}
            immichConnection={props.immichConnection}
            socket={socket}
          />
        )}

        {effectiveTab === "edit" && (
          <EditorView
            slug={vlog.shareSlug}
            vlogId={vlog.id}
            media={media}
            music={music}
            timeline={props.timeline}
            revision={props.timelineRevision}
            socket={socket}
            connected={connected}
            isCreator={isCreator}
            memberId={member.id}
            format={vlog.format}
            renderShortEdge={props.renderShortEdge}
            onBackToGather={() => setTab("gather")}
          />
        )}

        {effectiveTab === "watch" && (
          <RenderView
            slug={vlog.shareSlug}
            title={vlog.title}
            crew={props.members.length}
            clips={props.timeline.clips.length}
            state={state}
            latestRender={props.latestRender}
            publishedRender={props.publishedRender}
            socket={socket}
            isCreator={isCreator}
            onBackToEdit={() => setTab("edit")}
          />
        )}
      </main>

      <footer
        className={cn(
          "pb-rail border-t px-4 py-3 sm:px-7",
          // The bench carries its own sync dot in the toolbar; a second one
          // below the fold would cost the strip a row of height for nothing.
          fitsViewport && "xl:hidden",
          dark ? "border-[color:var(--hair-dark)]" : "border-[color:var(--hair)]",
        )}
      >
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2">
          <span
            className={cn(
              "flex items-center gap-2 font-mono text-2xs uppercase tracking-label",
              dark ? "text-ink-400" : "text-ink-500",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                connected ? "animate-pulse-dot bg-leader-500" : "bg-signal-600",
              )}
            />
            {connected ? "Synced — the whole crew sees this live" : "Reconnecting…"}
          </span>
          <span
            className={cn(
              "font-mono text-2xs uppercase tracking-label",
              dark ? "text-ink-500" : "text-ink-400",
            )}
          >
            ROLLCALL · {vlog.shareSlug}
          </span>
        </div>
      </footer>

      {/* The phone's rail: thumb-height, always there, never scrolls away. */}
      <WorkspaceNav
        variant="bar"
        tab={effectiveTab}
        onTab={setTab}
        state={state}
        counts={{
          clips: props.timeline.clips.length,
          unrated,
          hasRender: Boolean(props.latestRender),
        }}
      />
    </div>
  );
}

/**
 * Which room you're in is personal and sticky — come back tomorrow and you're
 * where you left off, without having changed anything for anyone else.
 */
function useTabPreference(slug: string, state: VlogState) {
  const initial: WorkspaceTab = isWorkingState(state) ? "gather" : "watch";
  const [tab, setTab] = useState<WorkspaceTab>(initial);

  useEffect(() => {
    if (!isWorkingState(state)) return;
    const stored = window.localStorage.getItem(`vb_tab_${slug}`);
    if (stored === "gather" || stored === "edit" || stored === "watch") setTab(stored);
  }, [slug, state]);

  const choose = useCallback(
    (next: WorkspaceTab) => {
      setTab(next);
      try {
        window.localStorage.setItem(`vb_tab_${slug}`, next);
      } catch {
        // Private browsing — the tab just won't be remembered.
      }
    },
    [slug],
  );

  return [tab, choose] as const;
}

/**
 * Coalesces bursts of realtime events into a single router refresh.
 *
 * The timer lives in a ref, not in state: rescheduling it isn't something the
 * page renders, and doing it inside a state updater made the updater impure —
 * React is free to call one twice, and in development it does, which left a
 * stray timer behind on every event and fired the refresh twice.
 */
function useDebouncedRefresh(fn: () => void, delay: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(fn);
  latest.current = fn;

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current(), delay);
  }, [delay]);
}

export { VLOG_STATES, VLOG_STATE_LABELS };
