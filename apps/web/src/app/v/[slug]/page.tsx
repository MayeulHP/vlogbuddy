import { notFound } from "next/navigation";
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
import { JoinForm } from "@/components/join-form";
import { VlogShell } from "@/components/vlog-shell";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function VlogPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const vlog = await getVlogBySlug(slug);
  if (!vlog) notFound();

  const member = await getCurrentMember(vlog.id);

  // Not joined yet — show the name prompt instead of the vlog.
  if (!member) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
        <div className="card p-6">
          <div className="mb-1 flex items-center gap-2 text-sm text-ink-400">
            <span>🎬</span>
            <span>You&apos;ve been invited to</span>
          </div>
          <h1 className="text-2xl font-bold text-white">{vlog.title}</h1>
          {vlog.description && (
            <p className="mt-2 text-sm leading-relaxed text-ink-400">{vlog.description}</p>
          )}
          <div className="mt-6">
            <JoinForm slug={slug} requiresPasscode={Boolean(vlog.passcodeHash)} />
          </div>
        </div>
      </main>
    );
  }

  const [media, music, membersList, timeline, latestRender, published] = await Promise.all([
    getMediaItems(vlog.id, member.id),
    getMusicItems(vlog.id, member.id),
    getVlogMembers(vlog.id),
    getTimeline(vlog.id),
    getLatestRenderJob(vlog.id),
    getPublishedRender(vlog.id),
  ]);

  return (
    <VlogShell
      vlog={{
        id: vlog.id,
        title: vlog.title,
        description: vlog.description,
        shareSlug: vlog.shareSlug,
        state: vlog.state,
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
      shareUrl={`${env().PUBLIC_BASE_URL}/v/${vlog.shareSlug}`}
      ytAudioEnabled={env().ENABLE_YT_AUDIO}
    />
  );
}
