"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ImmichTransferPayload } from "@vlogbuddy/shared";
import {
  connectImmichAction,
  disconnectImmichAction,
  latestTransferAction,
  startImmichExportAction,
} from "@/lib/actions/immich";
import type { PublicImmichConnection } from "@/lib/immich";
import { useSocketEvent, type VlogSocket } from "@/hooks/use-vlog-socket";
import { cn } from "@/lib/cn";
import { ImmichBrowser } from "./immich-browser";

/**
 * The wire to your own photo library, as one strip above the pile.
 *
 * Three states and no menus: connect, pull an album in, or push the whole roll
 * back out. That second direction is the one Immich can't do for you — two
 * friends with two servers have no way to merge libraries — and it's why this
 * exists: whoever brought the footage, everyone can keep the originals.
 */
export function ImmichPanel({
  slug,
  memberId,
  connection: initialConnection,
  mediaCount,
  socket,
}: {
  slug: string;
  memberId: string;
  connection: PublicImmichConnection | null;
  mediaCount: number;
  socket: VlogSocket | null;
}) {
  const router = useRouter();
  const [connection, setConnection] = useState(initialConnection);
  const [showForm, setShowForm] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [transfer, setTransfer] = useState<ImmichTransferPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => setConnection(initialConnection), [initialConnection]);

  // A copy outlives the page: pick up anything still running after a reload.
  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    void latestTransferAction(slug).then((res) => {
      if (cancelled || !res.ok || !res.transfer) return;
      if (res.transfer.status === "running" || res.transfer.status === "queued") {
        setTransfer(res.transfer as ImmichTransferPayload);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [slug, connection]);

  useSocketEvent(
    socket,
    "immich:transfer",
    useCallback(
      (payload: ImmichTransferPayload) => {
        // Everyone's transfers come down the room; only mine belong in my bar.
        if (payload.memberId !== memberId) {
          // Somebody else's import still fills the shared pile.
          if (payload.direction === "import" && payload.status === "done") router.refresh();
          return;
        }
        setTransfer(payload);
        if (payload.status === "done" || payload.status === "failed") router.refresh();
      },
      [memberId, router],
    ),
  );

  function copyToImmich() {
    setError(null);
    startTransition(async () => {
      const res = await startImmichExportAction(slug);
      if (!res.ok) setError(res.error);
    });
  }

  function disconnect() {
    setError(null);
    startTransition(async () => {
      const res = await disconnectImmichAction(slug);
      if (res.ok) {
        setConnection(null);
        setTransfer(null);
      } else setError(res.error);
    });
  }

  if (!connection) {
    return (
      <section className="sheet">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">Archive · Immich</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-700">
              Already keep your photos on your own Immich server? Pull a whole album
              across — server to server, nothing re-uploaded from your phone.
            </p>
          </div>
          <button
            onClick={() => setShowForm((v) => !v)}
            className={cn(showForm ? "btn-quiet" : "btn-outline", "shrink-0")}
          >
            {showForm ? "Cancel" : "Connect"}
          </button>
        </div>

        {showForm && (
          <ConnectForm
            slug={slug}
            onConnected={(conn) => {
              setConnection(conn);
              setShowForm(false);
              router.refresh();
            }}
          />
        )}
      </section>
    );
  }

  const busy = transfer?.status === "running" || transfer?.status === "queued";

  return (
    <>
      <section className="sheet">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2">
              <span className="eyebrow">Archive · Immich</span>
              <span className="tag-leader">connected</span>
            </p>
            <p className="mt-1 truncate font-mono text-[11px] text-ink-600">
              {connection.userName ?? "your server"} · {hostOf(connection.baseUrl)}
              {connection.keyHint && ` · key ${connection.keyHint}`}
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button onClick={() => setBrowsing(true)} disabled={busy} className="btn-outline">
              Import an album
            </button>
            <button
              onClick={copyToImmich}
              disabled={busy || pending || mediaCount === 0}
              className="btn-quiet"
              title={
                mediaCount === 0
                  ? "Nothing in the pile yet"
                  : "Copy every original in this vlog into your own Immich"
              }
            >
              ↑ Copy roll to my Immich
            </button>
            <button
              onClick={disconnect}
              disabled={busy || pending}
              className="px-1 font-mono text-[11px] text-ink-400 hover:text-signal-600"
              title="Forget my server and delete the stored key"
            >
              ✕
            </button>
          </div>
        </div>

        {error && <p className="notice mx-4 mb-3">{error}</p>}

        {transfer && <TransferBar transfer={transfer} onDismiss={() => setTransfer(null)} />}
      </section>

      {browsing && (
        <ImmichBrowser
          slug={slug}
          onClose={() => setBrowsing(false)}
          onStarted={() => router.refresh()}
        />
      )}
    </>
  );
}

function ConnectForm({
  slug,
  onConnected,
}: {
  slug: string;
  onConnected: (conn: PublicImmichConnection) => void;
}) {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await connectImmichAction(slug, { baseUrl, apiKey });
      if (res.ok) onConnected(res.connection);
      else setError(res.error);
    });
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 border-t border-[color:var(--hair)] bg-paper-100 px-4 py-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Server address</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://photos.example.com"
            className="field"
            autoComplete="off"
            disabled={pending}
          />
        </label>
        <label className="block">
          <span className="field-label">API key</span>
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            type="password"
            placeholder="Immich → Account Settings → API Keys"
            className="field"
            autoComplete="off"
            disabled={pending}
          />
        </label>
      </div>

      {error && <p className="notice">{error}</p>}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="submit"
          disabled={pending || !baseUrl.trim() || !apiKey.trim()}
          className="btn-signal"
        >
          {pending ? "Checking…" : "Connect"}
        </button>
        <p className="max-w-md text-[11px] leading-relaxed text-ink-600">
          The key is encrypted before it&apos;s stored, kept to this one vlog, and never
          reaches your friends&apos; browsers. Remove it any time with the ✕.
        </p>
      </div>
    </form>
  );
}

function TransferBar({
  transfer,
  onDismiss,
}: {
  transfer: ImmichTransferPayload;
  onDismiss: () => void;
}) {
  const finished = transfer.status === "done" || transfer.status === "failed";
  const failed = transfer.status === "failed";
  const pct =
    transfer.total > 0
      ? Math.round(((transfer.done + transfer.failed) / transfer.total) * 100)
      : transfer.status === "done"
        ? 100
        : 0;

  const heading = finished
    ? transfer.direction === "import"
      ? "Imported"
      : "Copied out"
    : transfer.direction === "import"
      ? "Importing"
      : "Copying to Immich";

  return (
    <div className="border-t border-[color:var(--hair)] px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="eyebrow flex items-center gap-2">
          {!finished && (
            <span className="h-1 w-1 animate-pulse-dot rounded-full bg-signal-500" aria-hidden />
          )}
          <span className={cn(failed && "text-signal-600")}>{heading}</span>
          <span className="normal-case tracking-normal text-ink-700">“{transfer.label}”</span>
        </p>

        <div className="flex items-center gap-3">
          <p
            className={cn(
              "font-mono text-[11px] tabular-nums",
              failed ? "text-signal-600" : "text-ink-500",
            )}
          >
            {transfer.error ?? transfer.message ?? ""}
          </p>
          {finished && (
            <button
              onClick={onDismiss}
              className="font-mono text-[11px] text-ink-400 hover:text-ink-900"
              aria-label="Dismiss"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {!finished && (
        <div className="mt-2 h-[3px] w-full bg-ink-300">
          <div
            className={cn(
              "h-full bg-signal-600 transition-all duration-500",
              transfer.total === 0 && "animate-pulse-dot",
            )}
            style={{ width: `${Math.max(3, pct)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
