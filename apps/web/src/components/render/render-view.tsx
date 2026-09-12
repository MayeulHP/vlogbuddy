"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { Socket } from "socket.io-client";
import type { RenderJob } from "@vlogbuddy/db";
import {
  formatBytes,
  formatDuration,
  type ClientToServerEvents,
  type RenderProgressPayload,
  type ServerToClientEvents,
  type VlogState,
} from "@vlogbuddy/shared";
import { setVlogStateAction } from "@/lib/actions/vlog";
import { useSocketEvent } from "@/hooks/use-vlog-socket";
import { cn } from "@/lib/cn";

export function RenderView({
  slug,
  state,
  latestRender,
  publishedRender,
  socket,
  isCreator,
}: {
  slug: string;
  state: VlogState;
  latestRender: RenderJob | null;
  publishedRender: (RenderJob & { url: string; downloadUrl: string }) | null;
  socket: React.MutableRefObject<Socket<ServerToClientEvents, ClientToServerEvents> | null>;
  isCreator: boolean;
}) {
  const router = useRouter();
  const [live, setLive] = useState<RenderProgressPayload | null>(null);

  useSocketEvent(
    socket,
    "render:progress",
    useCallback(
      (payload: RenderProgressPayload) => {
        setLive(payload);
        // Pull the finished video (and the published phase) from the server.
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

  // Finished — show the vlog.
  if (state === "published" && publishedRender) {
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <div className="text-center">
          <div className="text-3xl">🎉</div>
          <h2 className="mt-2 text-xl font-bold text-white">Your vlog is ready</h2>
          <p className="mt-1 text-sm text-ink-400">
            {formatDuration(publishedRender.durationSeconds)}
            {publishedRender.sizeBytes ? ` · ${formatBytes(publishedRender.sizeBytes)}` : ""}
          </p>
        </div>

        <div className="overflow-hidden rounded-xl border border-ink-800 bg-black">
          <video src={publishedRender.url} controls playsInline className="w-full" />
        </div>

        <div className="flex flex-wrap justify-center gap-2">
          <a href={publishedRender.downloadUrl} className="btn-primary text-sm" download>
            ⬇ Download MP4
          </a>
          {isCreator && (
            <button
              onClick={() => setVlogStateAction(slug, "edit").then(() => router.refresh())}
              className="btn-secondary text-sm"
            >
              ✂️ Back to editing
            </button>
          )}
        </div>

        <p className="text-center text-xs text-ink-600">
          Everyone with the link can watch and download it.
        </p>
      </div>
    );
  }

  // Failed.
  if (status === "failed") {
    return (
      <div className="mx-auto max-w-lg space-y-4 text-center">
        <div className="text-3xl">😞</div>
        <h2 className="text-lg font-semibold text-white">The render failed</h2>
        {error && (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-left text-[11px] text-red-300">
            {error}
          </pre>
        )}
        {isCreator && (
          <button
            onClick={() => setVlogStateAction(slug, "edit").then(() => router.refresh())}
            className="btn-primary text-sm"
          >
            Back to the editor
          </button>
        )}
      </div>
    );
  }

  // In progress.
  return (
    <div className="mx-auto max-w-lg space-y-5 py-8 text-center">
      <div className="text-3xl">{status === "queued" ? "⏳" : "⚙️"}</div>
      <div>
        <h2 className="text-lg font-semibold text-white">
          {status === "queued" ? "Waiting to start…" : "Rendering your vlog"}
        </h2>
        <p className="mt-1 text-sm text-ink-400">
          {message ?? "Stitching the clips together. This can take a few minutes."}
        </p>
      </div>

      <div>
        <div className="h-2 overflow-hidden rounded-full bg-ink-800">
          <div
            className={cn(
              "h-full rounded-full bg-gradient-to-r from-brand-500 to-cyan-400 transition-all duration-500",
              status === "queued" && "animate-pulse",
            )}
            style={{ width: `${Math.max(2, progress)}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs tabular-nums text-ink-500">{Math.round(progress)}%</p>
      </div>

      <p className="text-xs text-ink-600">
        You can close this tab — it keeps rendering on the server.
      </p>
    </div>
  );
}
