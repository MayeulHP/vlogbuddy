"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDuration, type ImmichAlbum } from "@vlogbuddy/shared";
import {
  listImmichAlbumAssetsAction,
  listImmichAlbumsAction,
  startImmichImportAction,
  type ImmichAssetPreview,
} from "@/lib/actions/immich";
import { cn } from "@/lib/cn";

/**
 * Picking what to bring over from Immich.
 *
 * Two screens, and the first one usually ends it: albums, then one album's
 * contents. Importing a whole album is a single tap on the album card, because
 * that's what people actually want — picking individual photos is there for
 * the times it isn't, behind a "Choose photos" that only appears once you're
 * inside.
 */
export function ImmichBrowser({
  slug,
  onClose,
  onStarted,
}: {
  slug: string;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [albums, setAlbums] = useState<ImmichAlbum[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ImmichAlbum | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listImmichAlbumsAction(slug).then((res) => {
      if (cancelled) return;
      if (res.ok) setAlbums(res.albums);
      else setError(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (open ? setOpen(null) : onClose());
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose, open]);

  const startImport = useCallback(
    async (album: ImmichAlbum, assetIds: string[]) => {
      setStarting(true);
      setError(null);
      const res = await startImmichImportAction(slug, {
        albumId: album.id,
        albumName: album.albumName,
        assetIds,
      });
      setStarting(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onStarted();
      onClose();
    },
    [slug, onClose, onStarted],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-end justify-center bg-ink-950/75 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        className="flex h-[88vh] w-full max-w-4xl animate-slide-up flex-col overflow-hidden border border-[color:var(--hair-strong)] bg-paper-50 shadow-deck sm:h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-[color:var(--hair-strong)] px-4 py-3">
          {open && (
            <button
              onClick={() => setOpen(null)}
              className="btn-quiet"
              aria-label="Back to albums"
            >
              ←
            </button>
          )}
          <div className="min-w-0 flex-1">
            <p className="eyebrow">Archive · Immich</p>
            <h2 className="headline truncate text-xl text-ink-900">
              {open ? open.albumName : "Import from your library"}
            </h2>
            <p className="truncate font-mono text-2xs uppercase tracking-label text-ink-500">
              {open
                ? `${open.assetCount} item${open.assetCount === 1 ? "" : "s"}`
                : "straight off your own server"}
            </p>
          </div>
          <button onClick={onClose} className="btn-quiet" aria-label="Close">
            ✕
          </button>
        </header>

        {error && (
          <p className="notice mx-4 mt-3 shrink-0">{error}</p>
        )}

        {open ? (
          <AlbumDetail
            slug={slug}
            album={open}
            starting={starting}
            onImport={(ids) => startImport(open, ids)}
          />
        ) : (
          <AlbumGrid
            slug={slug}
            albums={albums}
            starting={starting}
            onOpen={setOpen}
            onImportAll={(album) => startImport(album, [])}
          />
        )}
      </div>
    </div>
  );
}

function AlbumGrid({
  slug,
  albums,
  starting,
  onOpen,
  onImportAll,
}: {
  slug: string;
  albums: ImmichAlbum[] | null;
  starting: boolean;
  onOpen: (album: ImmichAlbum) => void;
  onImportAll: (album: ImmichAlbum) => void;
}) {
  if (albums === null) {
    return <Loading label="Reading your albums…" />;
  }

  if (albums.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="eyebrow-signal">Nothing filed</p>
        <p className="headline text-2xl text-ink-900">No albums on that server</p>
        <p className="max-w-xs text-[13px] leading-relaxed text-ink-600">
          Make an album in Immich with the photos from the trip, then come back.
        </p>
      </div>
    );
  }

  return (
    <div className="scrollbar-thin lighttable grid flex-1 grid-cols-2 content-start gap-3 overflow-y-auto p-4 sm:grid-cols-3 lg:grid-cols-4">
      {albums.map((album) => (
        <div
          key={album.id}
          className="group flex flex-col border border-[color:var(--hair)] bg-paper-50 transition-shadow hover:shadow-print"
        >
          <button
            onClick={() => onOpen(album)}
            className="block aspect-[4/3] w-full overflow-hidden bg-ink-900"
          >
            {album.albumThumbnailAssetId ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/immich/${slug}/thumb/${album.albumThumbnailAssetId}`}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
              />
            ) : (
              <div className="flex h-full items-center justify-center font-mono text-2xs uppercase tracking-label text-ink-500">
                no cover
              </div>
            )}
          </button>

          <div className="flex flex-1 flex-col p-2.5">
            <p className="truncate text-[13px] font-medium text-ink-900" title={album.albumName}>
              {album.albumName}
            </p>
            <p className="eyebrow mt-0.5">
              {album.assetCount} item{album.assetCount === 1 ? "" : "s"}
              {album.shared && " · shared"}
            </p>
            {dateRange(album) && (
              <p className="mt-0.5 font-mono text-2xs text-ink-400">{dateRange(album)}</p>
            )}

            <div className="mt-2.5 flex gap-1.5">
              <button
                onClick={() => onImportAll(album)}
                disabled={starting || album.assetCount === 0}
                className="btn-signal flex-1 px-2 py-1.5"
              >
                Import all
              </button>
              <button
                onClick={() => onOpen(album)}
                className="btn-outline px-2 py-1.5"
                title="Pick individual photos"
              >
                Choose
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function AlbumDetail({
  slug,
  album,
  starting,
  onImport,
}: {
  slug: string;
  album: ImmichAlbum;
  starting: boolean;
  onImport: (assetIds: string[]) => void;
}) {
  const [assets, setAssets] = useState<ImmichAssetPreview[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setAssets(null);
    void listImmichAlbumAssetsAction(slug, album.id).then((res) => {
      if (cancelled) return;
      if (res.ok) setAssets(res.assets);
      else setFailed(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [slug, album.id]);

  const importable = useMemo(
    () => (assets ?? []).filter((a) => !a.alreadyHere),
    [assets],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (failed) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <p className="notice">{failed}</p>
      </div>
    );
  }

  if (assets === null) return <Loading label="Looking through the album…" />;

  const allHere = importable.length === 0 && assets.length > 0;

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--hair)] px-4 py-2">
        <p className="eyebrow flex-1">
          {allHere
            ? "Every photo in this album is already in the pile"
            : `${importable.length} not in the pile yet`}
          {selected.size > 0 && ` · ${selected.size} picked`}
        </p>
        {importable.length > 0 && (
          <button
            onClick={() =>
              setSelected(
                selected.size === importable.length
                  ? new Set()
                  : new Set(importable.map((a) => a.id)),
              )
            }
            className="btn-quiet"
          >
            {selected.size === importable.length ? "Clear" : "Select all"}
          </button>
        )}
      </div>

      <div className="scrollbar-thin lighttable grid flex-1 grid-cols-3 content-start gap-1.5 overflow-y-auto p-3 sm:grid-cols-4 md:grid-cols-6">
        {assets.map((asset) => {
          const picked = selected.has(asset.id);
          return (
            <button
              key={asset.id}
              onClick={() => !asset.alreadyHere && toggle(asset.id)}
              disabled={asset.alreadyHere}
              title={asset.alreadyHere ? `${asset.filename} — already in the pile` : asset.filename}
              className={cn(
                "group relative aspect-square overflow-hidden border transition-all",
                asset.alreadyHere
                  ? "cursor-default border-[color:var(--hair)] opacity-35"
                  : picked
                    ? "border-signal-600 shadow-[0_0_0_2px_theme(colors.signal.600)]"
                    : "border-[color:var(--hair)] hover:border-ink-700",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/immich/${slug}/thumb/${asset.id}`}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />

              {asset.kind === "video" && asset.duration != null && (
                <span className="timecode absolute bottom-1 left-1 bg-ink-950/80 px-1 text-2xs text-paper-100">
                  {formatDuration(asset.duration / 1000)}
                </span>
              )}

              {asset.alreadyHere ? (
                <span className="absolute right-1 top-1 bg-ink-900/85 px-1 font-mono text-2xs uppercase tracking-label text-paper-200">
                  in pile
                </span>
              ) : (
                <span
                  className={cn(
                    "absolute right-1 top-1 flex h-5 w-5 items-center justify-center border text-[11px] font-bold transition-all",
                    picked
                      ? "border-signal-600 bg-signal-600 text-paper-50"
                      : "border-paper-100/50 bg-ink-950/35 text-transparent group-hover:border-paper-100",
                  )}
                >
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-[color:var(--hair-strong)] px-4 py-3">
        <button
          onClick={() => onImport([])}
          disabled={starting || importable.length === 0}
          className="btn-outline"
        >
          Import all {importable.length > 0 && importable.length}
        </button>
        <button
          onClick={() => onImport(Array.from(selected))}
          disabled={starting || selected.size === 0}
          className="btn-signal ml-auto"
        >
          {starting
            ? "Starting…"
            : selected.size > 0
              ? `Import ${selected.size} photo${selected.size === 1 ? "" : "s"}`
              : "Pick some photos"}
        </button>
      </footer>
    </>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3">
      <div className="h-5 w-5 animate-sweep border-2 border-ink-300 border-t-signal-600" />
      <p className="eyebrow">{label}</p>
    </div>
  );
}

function dateRange(album: ImmichAlbum): string {
  const fmt = (v: string) =>
    new Date(v).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  if (!album.startDate) return "";
  const start = fmt(album.startDate);
  const end = album.endDate ? fmt(album.endDate) : start;
  return start === end ? start : `${start} – ${end}`;
}
