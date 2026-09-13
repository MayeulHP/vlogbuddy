"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDuration, formatMonthYear, type ImmichAlbum } from "@vlogbuddy/shared";
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
 *
 * Inside an album the list is somebody's whole year, so it is filtered (the
 * common ask being "just the videos"), paged as you scroll, and laid out on a
 * fixed square grid — see `AlbumDetail`.
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
        className="flex h-[92dvh] w-full max-w-5xl animate-slide-up flex-col overflow-hidden border border-[color:var(--hair-strong)] bg-paper-50 shadow-deck sm:h-[84dvh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="pt-safe flex shrink-0 items-center gap-2 border-b border-[color:var(--hair-strong)] px-3 py-2.5 sm:gap-3 sm:px-4 sm:py-3">
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
            <h2 className="headline truncate text-lg text-ink-900 sm:text-xl">
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
    <div className="scrollbar-thin lighttable grid flex-1 grid-cols-2 content-start gap-2 overflow-y-auto overscroll-contain p-3 sm:grid-cols-3 sm:gap-3 sm:p-4 lg:grid-cols-4">
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

            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <button
                onClick={() => onImportAll(album)}
                disabled={starting || album.assetCount === 0}
                className="btn-signal flex-1 basis-20 px-2 py-1.5"
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

type AssetFilter = "all" | "photo" | "video";

/**
 * How many tiles are mounted at once.
 *
 * A holiday album on somebody's own server is routinely a couple of thousand
 * assets. Mounting all of them lays out thousands of nodes and — because each
 * thumbnail is proxied through this app with the caller's own credentials —
 * queues thousands of requests the moment the browser decides they're near the
 * viewport. So the grid grows a page at a time as you reach the bottom.
 */
const PAGE = 120;

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
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [limit, setLimit] = useState(PAGE);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

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

  const counts = useMemo(() => {
    const all = assets ?? [];
    return {
      all: all.length,
      photo: all.filter((a) => a.kind === "photo").length,
      video: all.filter((a) => a.kind === "video").length,
    };
  }, [assets]);

  /** What the filter is currently showing, in album order. */
  const showing = useMemo(
    () => (assets ?? []).filter((a) => filter === "all" || a.kind === filter),
    [assets, filter],
  );

  /** Of what's showing, the ones that aren't already in the pile. */
  const pickable = useMemo(() => showing.filter((a) => !a.alreadyHere), [showing]);

  const importable = useMemo(
    () => (assets ?? []).filter((a) => !a.alreadyHere),
    [assets],
  );

  // A new filter is a new list; start it at the top and at one page again.
  useEffect(() => {
    setLimit(PAGE);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [filter]);

  // Grow the grid as the bottom of it comes into view.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setLimit((current) => current + PAGE);
        }
      },
      { root, rootMargin: "400px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [showing.length]);

  const pickedHere = pickable.reduce((acc, a) => acc + (selected.has(a.id) ? 1 : 0), 0);
  const allPicked = pickable.length > 0 && pickedHere === pickable.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Select-all takes the filtered set, and says so. */
  function toggleAllShowing() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPicked) for (const a of pickable) next.delete(a.id);
      else for (const a of pickable) next.add(a.id);
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
  const visible = showing.slice(0, limit);

  return (
    <>
      <div className="shrink-0 border-b border-[color:var(--hair)]">
        <div className="scrollbar-thin touch-scroll-x flex items-center gap-1 overflow-x-auto px-3 py-2">
          {(
            [
              ["all", "Everything", counts.all],
              ["photo", "Photos", counts.photo],
              ["video", "Videos", counts.video],
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              disabled={count === 0 && value !== "all"}
              aria-pressed={filter === value}
              className={cn(
                "flex min-h-[36px] shrink-0 items-center gap-1.5 border px-2.5 font-mono text-2xs uppercase tracking-label transition-colors disabled:opacity-35",
                filter === value
                  ? "border-signal-600 bg-signal-600 text-paper-50"
                  : "border-[color:var(--hair-strong)] bg-paper-50 text-ink-600 hover:border-ink-900 hover:text-ink-900",
              )}
            >
              {label}
              <span className="tabular-nums opacity-70">{count}</span>
            </button>
          ))}

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {selected.size > 0 && (
              <button onClick={() => setSelected(new Set())} className="btn-quiet px-2">
                Clear {selected.size}
              </button>
            )}
            {pickable.length > 0 && (
              <button onClick={toggleAllShowing} className="btn-outline px-2">
                {allPicked
                  ? "Unpick these"
                  : filter === "all"
                    ? `Pick all ${pickable.length}`
                    : `Pick all ${pickable.length} ${filter === "video" ? "videos" : "photos"}`}
              </button>
            )}
          </div>
        </div>

        <p className="eyebrow px-3 pb-2">
          {allHere
            ? "Every item in this album is already in the pile"
            : `${importable.length} not in the pile yet`}
          {filter !== "all" && ` · showing ${showing.length}`}
          {selected.size > 0 && ` · ${selected.size} picked`}
        </p>
      </div>

      <div
        ref={scrollRef}
        className="scrollbar-thin lighttable flex-1 overflow-y-auto overscroll-contain p-3"
      >
        {showing.length === 0 ? (
          <p className="py-10 text-center text-[13px] text-ink-600">
            {filter === "video"
              ? "No videos in this album."
              : "No photos in this album."}
          </p>
        ) : (
          <>
            {/*
              Fixed square tiles on a fixed column count: whatever the album
              holds, the grid is the same shape, so nothing reflows as
              thumbnails arrive and the selection you made stays where it was.
            */}
            <div className="grid grid-cols-3 content-start gap-1.5 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
              {visible.map((asset) => {
                const picked = selected.has(asset.id);
                return (
                  <button
                    key={asset.id}
                    onClick={() => !asset.alreadyHere && toggle(asset.id)}
                    disabled={asset.alreadyHere}
                    title={
                      asset.alreadyHere
                        ? `${asset.filename} — already in the pile`
                        : asset.filename
                    }
                    className={cn(
                      "group relative aspect-square overflow-hidden border bg-paper-300 transition-all",
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
                      decoding="async"
                      className="h-full w-full object-cover"
                    />

                    {asset.kind === "video" && (
                      <span className="timecode absolute bottom-1 left-1 bg-ink-950/80 px-1 text-2xs text-paper-100">
                        ▶ {asset.duration != null ? formatDuration(asset.duration / 1000) : ""}
                      </span>
                    )}

                    {asset.alreadyHere ? (
                      <span className="absolute right-1 top-1 bg-ink-900/85 px-1 font-mono text-2xs uppercase tracking-label text-paper-200">
                        in pile
                      </span>
                    ) : (
                      <span
                        className={cn(
                          "absolute right-1 top-1 flex h-6 w-6 items-center justify-center border text-[11px] font-bold transition-all",
                          picked
                            ? "border-signal-600 bg-signal-600 text-paper-50"
                            : "border-paper-100/70 bg-ink-950/35 text-transparent group-hover:border-paper-100",
                        )}
                      >
                        ✓
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div ref={sentinelRef} aria-hidden className="h-px" />

            {visible.length < showing.length && (
              <p className="eyebrow py-4 text-center">
                Showing {visible.length} of {showing.length} — keep scrolling
              </p>
            )}
          </>
        )}
      </div>

      <footer className="pb-safe shrink-0 border-t border-[color:var(--hair-strong)]">
        <div className="flex items-center gap-2 px-4 py-3">
          <button
            onClick={() => onImport([])}
            disabled={starting || importable.length === 0}
            className="btn-outline"
            title="Bring the whole album over, whatever the filter is showing"
          >
            <span className="hidden sm:inline">Import the whole album</span>
            <span className="sm:hidden">Whole album</span>
            {importable.length > 0 && ` ${importable.length}`}
          </button>
          <button
            onClick={() => onImport(Array.from(selected))}
            disabled={starting || selected.size === 0}
            className="btn-signal ml-auto"
          >
            {starting
              ? "Starting…"
              : selected.size > 0
                ? `Import ${selected.size}`
                : "Pick some first"}
          </button>
        </div>
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
  if (!album.startDate) return "";
  const start = formatMonthYear(album.startDate);
  if (!start) return "";
  const end = (album.endDate ? formatMonthYear(album.endDate) : start) ?? start;
  return start === end ? start : `${start} – ${end}`;
}
