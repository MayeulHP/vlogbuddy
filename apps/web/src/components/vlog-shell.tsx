"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  /** The operator's render size, read as the film's shorter edge. */
  renderShortEdge: number;
  /** The rate the lab prints at — the bench's frame-sized nudges use it. */
  renderFps: number;
  ytAudioEnabled: boolean;
  immichConnection: PublicImmichConnection | null;
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
  // Changing the shape re-proportions every bench in the room.
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
   * The bench is a fixed-viewport room: picture, strip and inspector all on
   * screen at once, nothing below the fold. The page itself stops scrolling and
   * the column flex hands the editor whatever the (sticky, and therefore
   * self-measuring) masthead and the footer leave behind — no header height is
   * written down anywhere, so it can't go stale.
   *
   * Phones too, now. A stacked bench on a phone was a 1713px scroll whose
   * panels started below the fold, which is the one place a panel about the
   * shot you just tapped can't be; the room is the same fixed viewport there,
   * with the picture capped and the strip taking the rest. The sync footer goes
   * — it is a status line, and on a phone the bottom bar is already sitting
   * where it would be — so `main` carries the bar's clearance itself.
   */
  const fixed = effectiveTab === "edit";

  return (
    <div
      className={cn(
        "flex min-h-screen flex-col",
        fixed && "h-dvh min-h-0 overflow-hidden",
        dark ? "bg-ink-900" : "bg-paper-100",
      )}
    >
      {/* ---------- masthead: always paper, whatever room you're in ---------- */}
      <header className="pt-safe px-safe sticky top-0 z-30 border-b border-[color:var(--hair-strong)] bg-paper-100/95 backdrop-blur">
        <div className="mx-auto max-w-[1600px] px-4 sm:px-7">
          {/*
            The same masthead in every room. The bench once collapsed it to a
            single row to buy strip height, but a rail that moves is a rail
            you lose — going back to Trip should be the same reach from
            anywhere.
          */}
          <div
            className={cn(
              "flex flex-wrap items-center justify-between gap-x-6 gap-y-2 pt-2.5 sm:pt-3",
            )}
          >
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
          <div className={cn("scrollbar-thin touch-scroll-x -mx-4 mt-1.5 flex items-center gap-x-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:flex-wrap sm:gap-y-1 sm:overflow-visible sm:px-0 sm:pb-0")}>
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
          fixed && "min-h-0 overflow-hidden md:py-4",
          // The bottom bar is fixed, so it takes no room in the flow; below
          // `md` the bench's own last pixel would otherwise sit under it.
          fixed && "max-md:px-2 max-md:py-2 max-md:pb-[calc(56px+env(safe-area-inset-bottom,0px))]",
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
            onOpenEditor={() => setTab("edit")}
            scoreThreshold={vlog.scoreThreshold}
            ytAudioEnabled={props.ytAudioEnabled}
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
            isCreator={isCreator}
            memberId={member.id}
            format={vlog.format}
            renderShortEdge={props.renderShortEdge}
            renderFps={props.renderFps}
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
          fixed && "max-md:hidden",
          dark ? "border-[color:var(--hair-dark)]" : "border-[color:var(--hair)]",
        )}
      >
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2">
          <span
            className={cn(
              "flex items-center gap-2 font-mono text-2xs uppercase tracking-label",
              dark ? "text-ink-400" : "text-ink-600",
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
              dark ? "text-ink-400" : "text-ink-600",
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

/** Coalesces bursts of realtime events into a single router refresh. */
function useDebouncedRefresh(fn: () => void, delay: number) {
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer) clearTimeout(timer); }, [timer]);

  return useCallback(() => {
    setTimer((prev) => {
      if (prev) clearTimeout(prev);
      return setTimeout(() => fn(), delay);
    });
  }, [fn, delay]);
}

export { VLOG_STATES, VLOG_STATE_LABELS };
