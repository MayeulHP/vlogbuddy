"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { RenderJob } from "@vlogbuddy/db";
import {
  formatBytes,
  formatDuration,
  type RenderProgressPayload,
  type VlogState,
} from "@vlogbuddy/shared";
import { setVlogStateAction } from "@/lib/actions/vlog";
import { useSocketEvent, type VlogSocket } from "@/hooks/use-vlog-socket";
import { SlateRow } from "../brand";
import { cn } from "@/lib/cn";

/**
 * The screening room.
 *
 * What comes out of the renderer is a rough cut, and it says so: a slate, a
 * running time, the crew who shot it. Nothing here pretends a machine made a
 * finished film — it assembled what the crew chose, in the order they chose.
 */
export function RenderView({
  slug,
  title,
  crew,
  clips,
  state,
  latestRender,
  publishedRender,
  socket,
  isCreator,
  onBackToEdit,
}: {
  slug: string;
  title: string;
  crew: number;
  clips: number;
  state: VlogState;
  latestRender: RenderJob | null;
  publishedRender: (RenderJob & { url: string; downloadUrl: string }) | null;
  socket: VlogSocket | null;
  isCreator: boolean;
  /** Reopens the cutting room for this viewer once the film is unlocked. */
  onBackToEdit: () => void;
}) {
  const router = useRouter();
  const [live, setLive] = useState<RenderProgressPayload | null>(null);

  /** Unlocks the film for everyone, then drops this viewer back on the bench. */
  function reopen() {
    void setVlogStateAction(slug, "open").then(() => {
      onBackToEdit();
      router.refresh();
    });
  }

  useSocketEvent(
    socket,
    "render:progress",
    useCallback(
      (payload: RenderProgressPayload) => {
        setLive(payload);
        // Pull the finished film (and the published state) from the server.
        if (payload.status === "done" || payload.status === "failed") {
          router.refresh();
        }
      },
      [router],
    ),
  );

  const status = live?.status ?? latestRender?.status ?? "queued";
  const progress = live?.progress ?? latestRender?.progress ?? 0;
  const message = live?.message ?? latestRender?.message ?? null;
  const error = live?.error ?? latestRender?.error ?? null;

  // ---------- printed ----------
  if (state === "published" && publishedRender) {
    return (
      <div className="mx-auto max-w-4xl">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[color:var(--hair-dark)] pb-3">
          <div className="min-w-0">
            <p className="eyebrow-light flex items-center gap-2">
              <span className="h-1 w-1 bg-signal-500" aria-hidden />
              Beat 06 · Final cut
            </p>
            <h2 className="headline-xl mt-1 truncate text-[clamp(2rem,5vw,3.2rem)] text-paper-50">
              {title}
            </h2>
          </div>
          <span className="tag-dark border-signal-600/60 text-signal-300">Rough cut · Print 01</span>
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_240px]">
          <div>
            <div className="border border-[color:var(--hair-dark)] bg-black p-1.5">
              <video src={publishedRender.url} controls playsInline className="w-full" />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <a
                href={publishedRender.downloadUrl}
                className="btn-signal w-full sm:w-auto"
                download
              >
                ↓ Download MP4
              </a>
              {isCreator && (
                <button onClick={reopen} className="btn-outline-dark w-full sm:w-auto">
                  Reopen the bench
                </button>
              )}
              <span className="font-mono text-2xs uppercase tracking-label text-ink-500 sm:ml-auto">
                Anyone with the link can watch it
              </span>
            </div>
          </div>

          {/* The slate. Everything a print should tell you, in mono. */}
          <aside className="border border-[color:var(--hair-dark)] bg-ink-850 px-3 py-3">
            <p className="eyebrow-light mb-2">Slate</p>
            <SlateRow tone="ink" k="Running" v={formatDuration(publishedRender.durationSeconds)} />
            <SlateRow tone="ink" k="Shots" v={String(clips).padStart(2, "0")} />
            <SlateRow tone="ink" k="Crew" v={String(crew).padStart(2, "0")} />
            <SlateRow
              tone="ink"
              k="Size"
              v={publishedRender.sizeBytes ? formatBytes(publishedRender.sizeBytes) : "—"}
            />
            <SlateRow tone="ink" k="Roll" v={slug} />
            <p className="mt-3 font-mono text-2xs leading-relaxed text-ink-500">
              Shot by everyone. Cut by committee. Blame shared equally.
            </p>
          </aside>
        </div>
      </div>
    );
  }

  // ---------- burnt ----------
  if (status === "failed") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <p className="eyebrow-signal">Print failed</p>
        <h2 className="headline-xl mt-2 text-[clamp(1.8rem,5vw,2.8rem)] text-paper-50">
          The lab ruined it.
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-300">
          Nothing is lost — the cut, the marks and the footage are all still there. Have a look at
          what the renderer said, then try again.
        </p>
        {error && (
          <pre className="mt-4 overflow-x-auto whitespace-pre-wrap border border-signal-700/50 bg-signal-900/25 p-3 font-mono text-2xs leading-relaxed text-signal-200">
            {error}
          </pre>
        )}
        {isCreator && (
          <button onClick={reopen} className="btn-signal mt-4">
            Back to the bench
          </button>
        )}
      </div>
    );
  }

  // ---------- in the lab ----------
  return (
    <div className="mx-auto max-w-xl py-6 text-center sm:py-8">
      <p className="eyebrow-light">Beat 06 · Final cut</p>
      <h2 className="headline-xl mt-2 text-[clamp(1.8rem,5vw,2.8rem)] text-paper-50">
        {status === "queued" ? "Waiting for the lab" : "Printing the film"}
      </h2>

      {/* Academy leader: a countdown that means "something is happening". */}
      <div className="relative mx-auto mt-7 h-36 w-36 sm:mt-8 sm:h-44 sm:w-44">
        <div aria-hidden className="absolute inset-0 rounded-full border border-paper-100/20" />
        <div aria-hidden className="absolute inset-[14%] rounded-full border border-paper-100/10" />
        <div
          aria-hidden
          className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-paper-100/15"
        />
        <div
          aria-hidden
          className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-paper-100/15"
        />

        {/* Exposed so far. */}
        <div
          aria-hidden
          className="absolute inset-0 rounded-full transition-[background] duration-700"
          style={{
            background: `conic-gradient(rgba(206,52,16,0.35) ${Math.max(2, progress)}%, transparent 0)`,
          }}
        />
        {/* The sweep. */}
        <div
          aria-hidden
          className="absolute inset-0 animate-sweep rounded-full"
          style={{
            background:
              "conic-gradient(rgba(229,68,23,0.9) 0 3%, rgba(229,68,23,0.15) 3% 10%, transparent 10%)",
          }}
        />

        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="headline-xl animate-flicker text-5xl text-paper-50">
            {Math.round(progress)}
          </span>
          <span className="eyebrow-light mt-1">per cent</span>
        </div>
      </div>

      <p className="mx-auto mt-7 max-w-sm text-[13px] leading-relaxed text-ink-300">
        {message ?? "Splicing the shots together. This takes a few minutes for a long trip."}
      </p>

      <div
        className={cn(
          "mx-auto mt-5 h-[3px] w-full max-w-[14rem] bg-ink-800",
          status === "queued" && "animate-pulse-dot",
        )}
      >
        <div
          className="h-full bg-signal-600 transition-all duration-500"
          style={{ width: `${Math.max(2, progress)}%` }}
        />
      </div>

      <p className="mt-5 font-mono text-2xs uppercase tracking-label text-ink-500">
        Close the tab if you like — it keeps printing on the server
      </p>
    </div>
  );
}
