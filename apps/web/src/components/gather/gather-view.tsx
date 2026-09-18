"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ReactionTier, TimelineDoc } from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import type { PublicImmichConnection } from "@/lib/immich";
import type { VlogSocket } from "@/hooks/use-vlog-socket";
import { UploadZone } from "../dump/upload-zone";
import { DumpVoteTimeline } from "../dump/dump-vote-timeline";
import { CueSheet } from "../dump/cue-sheet";
import { Lightbox } from "../dump/lightbox";
import { EmptyFrames, Perfs, SectionHead } from "../brand";
import { FinalCut } from "./final-cut";
import { ImmichPanel } from "./immich-panel";
import { ReviewDeck } from "./review-deck";

/**
 * The floor: drop, discover, vote and shortlist, stacked down one page.
 *
 * Splitting these into phases meant the creator had to declare voting over
 * before anyone could see the consequences of their votes. Here the lanes sit
 * in the order the film actually thinks — the pile, the sound, the cut it adds
 * up to — and each one updates the next live.
 */
export function GatherView({
  slug,
  media,
  music,
  timeline,
  reactionTiers,
  memberId,
  crew,
  scoreThreshold,
  immichConnection,
  socket,
}: {
  slug: string;
  media: MediaItemView[];
  music: MusicItemView[];
  timeline: TimelineDoc;
  reactionTiers: ReactionTier[];
  memberId: string;
  /** How many people are on the crew — votes are read against this, not a score. */
  crew: number;
  scoreThreshold: number;
  immichConnection: PublicImmichConnection | null;
  socket: VlogSocket | null;
}) {
  const router = useRouter();
  const [lightboxItem, setLightboxItem] = useState<MediaItemView | null>(null);
  const [reviewing, setReviewing] = useState<MediaItemView[] | null>(null);

  const footage = useMemo(() => media.filter((m) => m.kind !== "audio"), [media]);
  // Never audio[0] — the bed is the one track with the role, wherever it sits.
  const bedTrack = timeline.audio.find((t) => t.role === "bed") ?? null;
  const reviewable = useMemo(() => footage.filter((m) => m.status === "ready"), [footage]);
  const unrated = useMemo(
    () => reviewable.filter((m) => m.reactions.mine === null),
    [reviewable],
  );
  const processing = media.filter(
    (m) => m.status === "pending" || m.status === "processing",
  ).length;

  return (
    <div className="space-y-12">
      {/* ---------- 01 · DROP ---------- */}
      <section id="stage-drop" className="scroll-mt-40">
        <SectionHead
          eyebrow="Beat 01 · Drop"
          title="Empty the camera roll"
          note="Straight from your phone into the shared pile. Everyone with the link can add theirs — order sorts itself out from the capture times."
          right={
            processing > 0 ? (
              <span className="tag-tape">
                <span className="h-1 w-1 animate-pulse-dot rounded-full bg-tape-500" />
                {processing} processing
              </span>
            ) : (
              <span className="eyebrow">{footage.length} in the pile</span>
            )
          }
        />

        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_320px]">
          <UploadZone slug={slug} onUploaded={() => router.refresh()} />

          {/* The way into the voting room — a clapper, not a button. */}
          {reviewable.length > 0 && (
            <button
              onClick={() => setReviewing(unrated.length > 0 ? unrated : reviewable)}
              className="group relative flex flex-col justify-between overflow-hidden border border-ink-900 bg-ink-900 p-4 text-left text-paper-100 transition-colors hover:bg-ink-850"
            >
              <div
                aria-hidden
                className="absolute inset-x-0 top-0 h-2.5 bg-[repeating-linear-gradient(45deg,theme(colors.paper.100)_0_10px,theme(colors.ink.900)_10px_20px)] opacity-80"
              />
              <div className="mt-3">
                <p className="eyebrow-light">Beat 02 — 03 · Discover &amp; Vote</p>
                <p className="headline mt-1.5 text-2xl text-paper-50">
                  {unrated.length > 0 ? "Screen the dailies" : "Another pass"}
                </p>
              </div>
              <p className="mt-6 font-mono text-2xs uppercase tracking-label text-ink-300">
                {unrated.length > 0
                  ? `${unrated.length} unmarked · one at a time`
                  : `All ${reviewable.length} marked · go again`}
                <span className="ml-1.5 inline-block text-signal-400 transition-transform group-hover:translate-x-1">
                  →
                </span>
              </p>
            </button>
          )}
        </div>

        {/* The other way in: somebody's own archive, server to server. */}
        <div className="mt-4">
          <ImmichPanel
            slug={slug}
            memberId={memberId}
            connection={immichConnection}
            mediaCount={media.length}
            socket={socket}
          />
        </div>
      </section>

      {/* ---------- 02 · DISCOVER / 03 · VOTE ---------- */}
      <section id="stage-discover" className="scroll-mt-40">
        {footage.length > 0 ? (
          <DumpVoteTimeline
            slug={slug}
            media={media}
            memberId={memberId}
            crew={crew}
            reactionTiers={reactionTiers}
            threshold={scoreThreshold}
            onOpen={setLightboxItem}
            onReview={() => setReviewing(unrated.length > 0 ? unrated : reviewable)}
          />
        ) : (
          <div className="sheet crop-marks px-6 py-14 text-center">
            <p className="eyebrow-signal">Beat 02 · Discover</p>
            <h3 className="headline mt-2 text-3xl">The light table is empty</h3>
            <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-ink-600">
              Drop in the photos and videos from the trip. They&apos;ll lay themselves out by
              when they were shot, and rise as the crew marks them up.
            </p>
            <EmptyFrames count={5} className="mx-auto mt-7 max-w-md" />
          </div>
        )}
      </section>

      {/* ---------- sound ---------- */}
      <section>
        <CueSheet
          slug={slug}
          music={music}
          tiers={reactionTiers}
          memberId={memberId}
          crew={crew}
          bedMusicId={bedTrack?.musicItemId ?? null}
          bedStartAt={bedTrack?.startAt ?? null}
          canEdit
        />
      </section>

      {/* ---------- 04 · SHORTLIST ---------- */}
      <section id="stage-shortlist" className="scroll-mt-40">
        <FinalCut
          slug={slug}
          media={media}
          music={music}
          timeline={timeline}
          onOpenClip={setLightboxItem}
        />
      </section>

      <Perfs className="text-ink-900/15" />

      {lightboxItem && (
        <Lightbox
          item={lightboxItem}
          slug={slug}
          tiers={reactionTiers}
          crew={crew}
          onClose={() => setLightboxItem(null)}
        />
      )}

      {reviewing && (
        <ReviewDeck
          slug={slug}
          items={reviewing}
          tiers={reactionTiers}
          crew={crew}
          onClose={() => setReviewing(null)}
        />
      )}
    </div>
  );
}
