import { notFound } from "next/navigation";
import { getRenderSettings } from "@vlogbuddy/db";
import { getCurrentMember, getVlogBySlug } from "@/lib/session";
import {
  getLatestRenderJob,
  getMediaItems,
  getMusicItems,
  getPublishedRender,
  getTimeline,
  getVlogMembers,
  reactionTiersFor,
} from "@/lib/queries";
import { connectionForMember, publicConnection } from "@/lib/immich";
import { JoinForm } from "@/components/join-form";
import { Wordmark } from "@/components/brand";
import { VlogShell } from "@/components/vlog-shell";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function VlogPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const vlog = await getVlogBySlug(slug);
  if (!vlog) notFound();

  const member = await getCurrentMember(vlog.id);

  // Not joined yet — the invitation, then the crew list.
  if (!member) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-5 py-12">
        <div className="mb-5 flex items-baseline justify-between">
          <Wordmark size="sm" />
          <span className="eyebrow">Call sheet</span>
        </div>

        <div className="sheet crop-marks shadow-print">
          <div className="border-b border-[color:var(--hair-strong)] px-6 py-5">
            <p className="eyebrow-signal">You&apos;re on the crew for</p>
            <h1 className="headline-xl mt-2 text-[clamp(2rem,6vw,3rem)]">{vlog.title}</h1>
            {vlog.description && (
              <p className="mt-3 max-w-md text-[13px] leading-relaxed text-ink-600">
                {vlog.description}
              </p>
            )}
          </div>

          <div className="px-6 py-6">
            <JoinForm slug={slug} requiresPasscode={Boolean(vlog.passcodeHash)} />
          </div>

          <div className="border-t border-[color:var(--hair)] bg-paper-100 px-6 py-3">
            <div className="flex items-center justify-between">
              <span className="eyebrow">Roll</span>
              <span className="timecode text-2xs text-ink-600">{vlog.shareSlug}</span>
            </div>
          </div>
        </div>

        <p className="mt-5 text-center font-mono text-2xs leading-relaxed text-ink-600">
          Everyone brought the footage. Make the film together.
        </p>
      </main>
    );
  }

  const [media, music, membersList, timeline, latestRender, published, immich, renderSettings] =
    await Promise.all([
      getMediaItems(vlog.id, member.id),
      getMusicItems(vlog.id, member.id),
      getVlogMembers(vlog.id),
      getTimeline(vlog.id),
      getLatestRenderJob(vlog.id),
      getPublishedRender(vlog.id),
      connectionForMember(member.id),
      getRenderSettings(),
    ]);

  return (
    <VlogShell
      vlog={{
        id: vlog.id,
        title: vlog.title,
        description: vlog.description,
        shareSlug: vlog.shareSlug,
        state: vlog.state,
        scoreThreshold: vlog.scoreThreshold,
        format: vlog.format,
      }}
      member={{
        id: member.id,
        displayName: member.displayName,
        role: member.role,
      }}
      members={membersList.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        role: m.role,
      }))}
      media={media}
      music={music}
      timeline={timeline.doc}
      timelineRevision={timeline.revision}
      reactionTiers={reactionTiersFor(vlog)}
      latestRender={latestRender}
      publishedRender={published}
      immichConnection={immich ? publicConnection(immich) : null}
      shareUrl={`${env().PUBLIC_BASE_URL}/v/${vlog.shareSlug}`}
      /* The operator's quality setting, read as the film's shorter edge — the
         bench shows what the vlog's shape actually comes out as. */
      renderShortEdge={renderSettings.renderHeight}
      renderFps={renderSettings.renderFps}
      ytAudioEnabled={env().ENABLE_YT_AUDIO}
    />
  );
}
