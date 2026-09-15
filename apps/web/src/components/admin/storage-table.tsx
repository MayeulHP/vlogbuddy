"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { formatBytes, formatDate, VLOG_STATE_LABELS } from "@vlogbuddy/shared";
import type { VlogStorageRow } from "@/lib/admin-queries";
import {
  deleteVlogAction,
  pruneOldRendersAction,
  pruneVlogSourcesAction,
} from "@/lib/actions/admin";
import { cn } from "@/lib/cn";

/**
 * One row per roll, with the two destructive buttons kept honest.
 *
 * Sweeping and deleting both ask for a second press rather than opening a
 * dialog: the confirmation *is* the button changing into what it will actually
 * do, which is harder to click through on autopilot than a modal.
 */
export function StorageTable({ rows }: { rows: VlogStorageRow[] }) {
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  if (rows.length === 0) {
    return (
      <p className="border border-dashed border-[color:var(--hair-strong)] px-4 py-10 text-center text-[13px] text-ink-600">
        No rolls yet. Start one above and share the link.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {message && (
        <p className={message.tone === "ok" ? "notice-tape" : "notice"}>{message.text}</p>
      )}

      <div className="divide-y divide-[color:var(--hair)] border border-[color:var(--hair)] bg-paper-50">
        {rows.map((row) => (
          <Row key={row.id} row={row} onMessage={setMessage} />
        ))}
      </div>
    </div>
  );
}

function Row({
  row,
  onMessage,
}: {
  row: VlogStorageRow;
  onMessage: (m: { tone: "ok" | "bad"; text: string }) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [armed, setArmed] = useState<"sweep" | "delete" | null>(null);

  const total = row.sourceBytes + row.renderBytes;
  const canSweep = row.hasPublishedRender && row.liveMedia > 0;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const res = await fn();
      setArmed(null);
      onMessage(res.ok ? { tone: "ok", text: success } : { tone: "bad", text: res.error ?? "That didn't work" });
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <Link
            href={`/v/${row.shareSlug}`}
            className="truncate text-[15px] font-medium text-ink-900 hover:text-signal-600"
          >
            {row.title}
          </Link>
          <span className={cn("tag", row.state === "published" ? "tag-leader" : "tag-ink")}>
            {VLOG_STATE_LABELS[row.state]}
          </span>
          {row.prunedMedia > 0 && (
            <span className="tag-tape" title="Source footage has been swept">
              swept
            </span>
          )}
        </p>
        <p className="mt-0.5 font-mono text-2xs uppercase tracking-label text-ink-600">
          {row.members} crew · {row.liveMedia} item{row.liveMedia === 1 ? "" : "s"}
          {row.prunedMedia > 0 && ` (+${row.prunedMedia} swept)`} ·{" "}
          {formatDate(row.createdAt)}
        </p>
      </div>

      <div className="text-right">
        <p className="timecode text-[15px] text-ink-900">{formatBytes(total)}</p>
        <p className="font-mono text-2xs text-ink-600">
          {formatBytes(row.sourceBytes)} source · {formatBytes(row.renderBytes)} film
        </p>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {row.renderCount > 1 && (
          <button
            onClick={() =>
              run(() => pruneOldRendersAction(row.id), `Cleared the old renders of “${row.title}”`)
            }
            disabled={pending}
            className="btn-quiet"
            title="Delete every render but the latest finished one"
          >
            Old renders
          </button>
        )}

        <button
          onClick={() =>
            armed === "sweep"
              ? run(
                  () => pruneVlogSourcesAction(row.id),
                  `Swept the footage behind “${row.title}” — the film is still there`,
                )
              : setArmed("sweep")
          }
          disabled={pending || !canSweep}
          className={armed === "sweep" ? "btn-danger" : "btn-outline"}
          title={
            canSweep
              ? "Delete the originals and keep the finished film"
              : row.hasPublishedRender
                ? "Already swept"
                : "Nothing rendered yet — there'd be no film left"
          }
        >
          {armed === "sweep" ? `Delete ${formatBytes(row.sourceBytes)} of footage?` : "Sweep sources"}
        </button>

        <button
          onClick={() =>
            armed === "delete"
              ? run(() => deleteVlogAction(row.id), `Deleted “${row.title}” and everything in it`)
              : setArmed("delete")
          }
          disabled={pending}
          className={armed === "delete" ? "btn-danger" : "btn-quiet"}
        >
          {armed === "delete" ? "Delete the whole roll?" : "Delete"}
        </button>

        {armed && (
          <button onClick={() => setArmed(null)} disabled={pending} className="btn-quiet">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
