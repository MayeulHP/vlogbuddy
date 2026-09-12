"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { RenderJob } from "@vlogbuddy/db";
import {
  VLOG_STATES,
  VLOG_STATE_LABELS,
  type ReactionTier,
  type TimelineDoc,
  type VlogState,
} from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import { useSocketEvent, useVlogSocket } from "@/hooks/use-vlog-socket";
import { cn } from "@/lib/cn";
import { DumpView } from "./dump/dump-view";
import { CurateView } from "./curate/curate-view";
import { EditorView } from "./editor/editor-view";
import { RenderView } from "./render/render-view";
import { ShareBar } from "./share-bar";
import { PhaseNav } from "./phase-nav";
import { PresenceBar } from "./presence-bar";

export interface VlogShellProps {
  vlog: {
    id: string;
    title: string;
    description: string | null;
    shareSlug: string;
    state: VlogState;
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
  ytAudioEnabled: boolean;
}

export function VlogShell(props: VlogShellProps) {
  const { vlog, member, media, music, reactionTiers, shareUrl } = props;
  const router = useRouter();
  const { socket, connected, presence } = useVlogSocket(vlog.id);
  const [state, setState] = useState<VlogState>(vlog.state);

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

  useSocketEvent(
    socket,
    "vlog:state",
    useCallback(
      ({ state: next }: { state: VlogState }) => {
        setState(next);
        router.refresh();
      },
      [router],
    ),
  );

  const isCreator = member.role === "creator";

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-ink-800 bg-ink-950/85 backdrop-blur-md">
        <div className="mx-auto max-w-[1600px] px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="text-xl">🎬</span>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold leading-tight text-white">
                  {vlog.title}
                </h1>
                <p className="text-xs text-ink-500">
                  {media.length} item{media.length === 1 ? "" : "s"} · {music.length} track
                  {music.length === 1 ? "" : "s"} · {props.members.length} friend
                  {props.members.length === 1 ? "" : "s"}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <PresenceBar presence={presence} connected={connected} selfId={member.id} />
              <ShareBar shareUrl={shareUrl} />
            </div>
          </div>

          <div className="mt-3">
            <PhaseNav
              slug={vlog.shareSlug}
              current={state}
              isCreator={isCreator}
              counts={{ media: media.length, music: music.length }}
            />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 sm:px-6">
        {state === "open" && (
          <DumpView
            slug={vlog.shareSlug}
            vlogId={vlog.id}
            media={media}
            music={music}
            reactionTiers={reactionTiers}
            memberId={member.id}
            socket={socket}
            ytAudioEnabled={props.ytAudioEnabled}
          />
        )}

        {state === "curate" && (
          <CurateView
            slug={vlog.shareSlug}
            media={media}
            music={music}
            reactionTiers={reactionTiers}
            isCreator={isCreator}
          />
        )}

        {state === "edit" && (
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
          />
        )}

        {(state === "export" || state === "published") && (
          <RenderView
            slug={vlog.shareSlug}
            state={state}
            latestRender={props.latestRender}
            publishedRender={props.publishedRender}
            socket={socket}
            isCreator={isCreator}
          />
        )}
      </main>

      <footer className="border-t border-ink-800 px-4 py-3 text-center text-xs text-ink-600 sm:px-6">
        <span className={cn("inline-flex items-center gap-1.5", connected && "text-ink-500")}>
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              connected ? "bg-emerald-400" : "bg-ink-600",
            )}
          />
          {connected ? "Live — everyone sees changes instantly" : "Reconnecting…"}
        </span>
      </footer>
    </div>
  );
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
