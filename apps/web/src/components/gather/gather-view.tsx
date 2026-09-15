"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ReactionTier, TimelineDoc } from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import type { PublicImmichConnection } from "@/lib/immich";
import type { VlogSocket } from "@/hooks/use-vlog-socket";
import { UploadZone } from "../dump/upload-zone";
import { DumpVoteTimeline } from "../dump/dump-vote-timeline";
import { MusicLane } from "../dump/music-lane";
import { Lightbox } from "../dump/lightbox";
import { EmptyFrames, Perfs, SectionHead } from "../brand";
import { CutTicker } from "./cut-ticker";
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
 *
 * But not all of them at once. A roll nobody has dropped anything into has
 * nothing to mark, nothing to score and no cut, and rendering all four lanes
 * anyway meant the first thing a friend met was four empty workshops with
 * four sets of controls. So the page opens as the pile fills: a lane appears
 * when there is finally something in it to work on, the optional one folds
 * away, and a single line at the top always names the one next thing worth
 * doing. Nothing is taken away — it just arrives when it's any use.
 */
export function GatherView({
  slug,
  media,
  music,
  timeline,
  reactionTiers,
  memberId,
  crew,
  onOpenEditor,
  scoreThreshold,
  ytAudioEnabled,
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
  /** Hands this viewer over to the bench — the rough cut's natural next step. */
  onOpenEditor: () => void;
  scoreThreshold: number;
  ytAudioEnabled: boolean;
  immichConnection: PublicImmichConnection | null;
  socket: VlogSocket | null;
}) {
  const router = useRouter();
  const [lightboxItem, setLightboxItem] = useState<MediaItemView | null>(null);
  const [reviewing, setReviewing] = useState<MediaItemView[] | null>(null);
  // Open if there's already something to hear; otherwise it's a line you open.
  const [soundOpen, setSoundOpen] = useState(music.length > 0);
  /** The rough cut's own section — the ticker watches it and stands down for it. */
  const shortlistRef = useRef<HTMLElement | null>(null);

  const footage = useMemo(() => media.filter((m) => m.kind !== "audio"), [media]);
  // Source lengths, so the sound lane can measure the cut it sits under.
  const durations = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const item of media) out[item.id] = item.durationSeconds;
    return out;
  }, [media]);
  const reviewable = useMemo(() => footage.filter((m) => m.status === "ready"), [footage]);
  const unrated = useMemo(
    () => reviewable.filter((m) => m.reactions.mine === null),
    [reviewable],
  );
  const processing = media.filter(
    (m) => m.status === "pending" || m.status === "processing",
  ).length;

  /**
   * Nothing dropped yet is a different page, not an emptier one: the light
   * table, the sound lane and the rough cut are all controls for footage that
   * doesn't exist.
   */
  const bare = footage.length === 0 && music.length === 0;
  const inCut = timeline.clips.length;

  return (
    <div className="space-y-12">
      {!bare && (
        <NextStep
          processing={processing}
          reviewable={reviewable.length}
          unrated={unrated.length}
          inCut={inCut}
          onReview={() => setReviewing(unrated.length > 0 ? unrated : reviewable)}
        />
      )}

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

        <div className="mt-4">
          <UploadZone slug={slug} onUploaded={() => router.refresh()} />
        </div>

        {/*
          This used to be a clapperboard tile the size of the drop zone,
          captioned "Screen the dailies". It said what it was in film-crew
          nouns and cost half the row to do it — so it's a button that names
          the count and the verb.
        */}
        {reviewable.length > 0 && (
          <button
            onClick={() => setReviewing(unrated.length > 0 ? unrated : reviewable)}
            className="btn-signal mt-3 w-full sm:w-auto"
          >
            {unrated.length > 0
              ? `Mark up ${unrated.length} new shot${unrated.length === 1 ? "" : "s"} →`
              : `Mark up all ${reviewable.length} again →`}
          </button>
        )}

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
      {!bare && (
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
      )}

      {/*
        The one thing an empty roll owes a newcomer: what happens after they
        drop something. Three lines instead of three empty workshops.
      */}
      {bare && (
        <section>
          <ol className="grid gap-px border border-[color:var(--hair)] bg-[color:var(--hair)] sm:grid-cols-3">
            {[
              { n: "02", t: "It lands on the light table", b: "Laid out by when it was shot, for everyone with the link." },
              { n: "03", t: "The crew marks it up", b: "One frame at a time. Three marks: keep it, it's strong, it's the shot." },
              { n: "04", t: "The cut builds itself", b: "The best of it assembles into a film as the marks land. You tighten it." },
            ].map((beat) => (
              <li key={beat.n} className="bg-paper-50 p-4">
                <span className="timecode text-2xs text-signal-600">{beat.n}</span>
                <h3 className="headline mt-2 text-[1.4rem]">{beat.t}</h3>
                <p className="mt-1 text-[13px] leading-snug text-ink-600">{beat.b}</p>
              </li>
            ))}
          </ol>
          <EmptyFrames count={6} className="mt-4" />
        </section>
      )}

      {/*
        Sound is the one lane that is genuinely optional — a film with no score
        is a film, and most rolls sit at nothing for days. Folded away it costs
        a line instead of a form and a drag lane.
      */}
      {!bare && (
        <section>
          {soundOpen ? (
            <>
              <MusicLane
                slug={slug}
                music={music}
                tiers={reactionTiers}
                memberId={memberId}
                crew={crew}
                mediaCount={Math.max(footage.length, 1)}
                timeline={timeline}
                durations={durations}
                bedMusicId={timeline.audio.find((t) => t.role === "bed")?.musicItemId ?? null}
                canEdit
              />

              {!ytAudioEnabled && music.length > 0 && (
                <p className="notice-tape mt-3">
                  Streaming links set the vibe, but they can&apos;t be baked into the render —
                  upload an audio file for the finished film.
                </p>
              )}
            </>
          ) : (
            <button
              onClick={() => setSoundOpen(true)}
              className="group flex w-full items-baseline justify-between gap-4 border-b border-[color:var(--hair-strong)] pb-2 text-left"
            >
              <span className="min-w-0">
                <span className="eyebrow flex items-center gap-2">
                  <span className="h-1 w-1 bg-signal-500" aria-hidden />
                  Sound
                </span>
                <span className="headline mt-1 block text-[1.7rem] text-ink-900 sm:text-[2rem]">
                  What it sounds like
                </span>
              </span>
              <span className="eyebrow shrink-0 group-hover:text-signal-600">
                {music.length > 0
                  ? `${music.length} track${music.length === 1 ? "" : "s"} · open`
                  : "Add a track"}
              </span>
            </button>
          )}
        </section>
      )}

      {/* ---------- 04 · SHORTLIST ---------- */}
      {!bare && (
        <section id="stage-shortlist" ref={shortlistRef} className="scroll-mt-40">
          <FinalCut
            slug={slug}
            media={media}
            music={music}
            timeline={timeline}
            onOpenEditor={onOpenEditor}
            onOpenClip={setLightboxItem}
          />
        </section>
      )}

      {!bare && <Perfs className="text-ink-900/15" />}

      {/*
        Marking happens three screens above the cut it changes, so the cut
        reports itself from the bottom of the viewport until you scroll down to
        the real thing.
      */}
      {!bare && (
        <CutTicker
          timeline={timeline}
          media={media}
          watch={shortlistRef}
          onOpen={() =>
            shortlistRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
        />
      )}

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

/**
 * One line naming the next thing worth doing.
 *
 * The floor is four lanes that all accept input at once, which is the point —
 * but it leaves a friend who has just followed a link with no idea which of
 * them is their turn. This answers that, and only that: the single most useful
 * move given where the roll actually is, with the way to make it.
 *
 * Deliberately not a wizard. It never blocks anything and never advances a
 * state — everything below it stays available whether or not anyone reads it.
 */
function NextStep({
  processing,
  reviewable,
  unrated,
  inCut,
  onReview,
}: {
  processing: number;
  reviewable: number;
  unrated: number;
  inCut: number;
  onReview: () => void;
}) {
  const step = (() => {
    if (reviewable === 0 && processing > 0) {
      return {
        line: `${processing} shot${processing === 1 ? "" : "s"} still developing. They'll show up on the light table on their own.`,
      };
    }
    if (unrated > 0) {
      return {
        line: `${unrated} shot${unrated === 1 ? "" : "s"} nobody has marked yet. Screening them one at a time is the quick way.`,
        action: { label: "Screen the dailies →", onClick: onReview },
      };
    }
    if (reviewable > 0 && inCut === 0) {
      return {
        line: "Everything's marked, but nothing has made it above the cut line yet. Drag the red line down to let more of the trip in.",
      };
    }
    if (reviewable > 0) {
      return {
        line: `You've marked everything in the pile. The cut is ${inCut} shot${inCut === 1 ? "" : "s"} — tighten it on the bench, or wait for the rest of the crew.`,
      };
    }
    return null;
  })();

  if (!step) return null;

  return (
    <div className="sheet flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="eyebrow-signal">Where this is up to</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-700">{step.line}</p>
      </div>
      {step.action && (
        <button onClick={step.action.onClick} className="btn-signal w-full shrink-0 sm:w-auto">
          {step.action.label}
        </button>
      )}
    </div>
  );
}
