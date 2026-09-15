import Link from "next/link";
import { getRenderSettings } from "@vlogbuddy/db";
import { formatBytes } from "@vlogbuddy/shared";
import { requireAdmin } from "@/lib/admin";
import { listVlogStorage } from "@/lib/admin-queries";
import { Wordmark } from "@/components/brand";
import { CreateVlogForm } from "@/components/create-vlog-form";
import { RenderSettingsForm } from "@/components/admin/render-settings-form";
import { StorageTable } from "@/components/admin/storage-table";

export const dynamic = "force-dynamic";

/**
 * The projection booth: the one page that belongs to whoever runs the box.
 *
 * Basic Auth in middleware keeps guests out; `requireAdmin` here and in every
 * action is what actually protects the data.
 */
export default async function AdminPage() {
  await requireAdmin();

  const [settings, rows] = await Promise.all([getRenderSettings(), listVlogStorage()]);

  const sourceBytes = rows.reduce((acc, r) => acc + r.sourceBytes, 0);
  const renderBytes = rows.reduce((acc, r) => acc + r.renderBytes, 0);
  const sweepable = rows.filter((r) => r.hasPublishedRender && r.liveMedia > 0);
  const reclaimable = sweepable.reduce((acc, r) => acc + r.sourceBytes, 0);

  return (
    <div className="min-h-screen">
      <header className="border-b border-[color:var(--hair-strong)]">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-baseline justify-between gap-x-8 gap-y-2 px-5 py-4 sm:px-8">
          <Link href="/">
            <Wordmark size="sm" />
          </Link>
          <p className="eyebrow-signal">Projection booth · admin</p>
          <p className="eyebrow hidden sm:block">{rows.length} rolls on this box</p>
        </div>
      </header>

      <main className="mx-auto max-w-[1200px] space-y-12 px-5 py-10 sm:px-8">
        {/* ---------- what's on the disk ---------- */}
        <section>
          <p className="eyebrow-signal">Inventory</p>
          <h1 className="headline mt-1 text-3xl">What&apos;s on the disk</h1>

          <dl className="mt-5 grid gap-px border border-[color:var(--hair)] bg-[color:var(--hair)] sm:grid-cols-3">
            <Figure label="Source footage" value={formatBytes(sourceBytes)} note="originals, proxies, thumbnails" />
            <Figure label="Finished films" value={formatBytes(renderBytes)} note="the bit worth keeping" />
            <Figure
              label="Sweepable"
              value={formatBytes(reclaimable)}
              note={
                sweepable.length === 0
                  ? "nothing rendered yet"
                  : `across ${sweepable.length} rendered roll${sweepable.length === 1 ? "" : "s"}`
              }
              signal={reclaimable > 0}
            />
          </dl>
        </section>

        {/* ---------- export format ---------- */}
        <section>
          <p className="eyebrow-signal">Format</p>
          <h2 className="headline mt-1 text-3xl">How films come out</h2>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-700">
            Applies to the next render, not to anything already made. On a small
            machine the frame size and the preset are what decide whether a render
            takes ten minutes or two hours.
          </p>
          <div className="mt-5">
            <RenderSettingsForm settings={settings} />
          </div>
        </section>

        {/* ---------- new roll ---------- */}
        <section>
          <p className="eyebrow-signal">New</p>
          <h2 className="headline mt-1 text-3xl">Start a roll</h2>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-700">
            Only you can start one. Everyone else joins with the share link and
            never needs an account.
          </p>
          <div className="mt-5 max-w-lg border border-[color:var(--hair)] bg-paper-50 p-5">
            <CreateVlogForm />
          </div>
        </section>

        {/* ---------- housekeeping ---------- */}
        <section>
          <p className="eyebrow-signal">Housekeeping</p>
          <h2 className="headline mt-1 text-3xl">Rolls on this box</h2>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-700">
            Once a film is rendered, the source footage behind it is usually the
            only thing still taking real space. Sweeping it keeps the film, the
            credits and the votes, and gives the disk back.
          </p>
          <div className="mt-5">
            <StorageTable rows={rows} />
          </div>
        </section>
      </main>
    </div>
  );
}

function Figure({
  label,
  value,
  note,
  signal,
}: {
  label: string;
  value: string;
  note: string;
  signal?: boolean;
}) {
  return (
    <div className="bg-paper-50 px-4 py-4">
      <dt className="eyebrow">{label}</dt>
      <dd
        className={`headline mt-1 text-3xl tabular-nums ${signal ? "text-signal-600" : "text-ink-900"}`}
      >
        {value}
      </dd>
      <p className="mt-0.5 font-mono text-2xs text-ink-600">{note}</p>
    </div>
  );
}
