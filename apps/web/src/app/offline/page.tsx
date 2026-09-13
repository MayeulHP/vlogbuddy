import type { Metadata } from "next";
import { EmptyFrames, Perfs, Wordmark } from "@/components/brand";

/**
 * The only page the service worker is allowed to keep. It is deliberately
 * static and self-contained: it has to render with no network at all.
 */
export const metadata: Metadata = {
  title: "Offline — ROLLCALL",
};

export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-5 py-12">
      <div className="mb-5 flex items-baseline justify-between">
        <Wordmark size="sm" />
        <span className="eyebrow">No signal</span>
      </div>

      <div className="sheet crop-marks shadow-print">
        <div className="border-b border-[color:var(--hair-strong)] px-6 py-5">
          <p className="eyebrow-signal">Nothing is coming through</p>
          <h1 className="headline-xl mt-2 text-[clamp(1.8rem,7vw,2.6rem)]">
            You&apos;re offline.
          </h1>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-600">
            ROLLCALL keeps everything on the crew&apos;s own box, so it needs the network to
            show you the pile. Get a bar of signal back and it&apos;ll pick up where you left
            off — nothing you did has been lost.
          </p>
        </div>

        <div className="bg-ink-900 p-2">
          <Perfs tone="light" />
          <EmptyFrames count={6} tone="ink" className="my-2" />
          <Perfs tone="light" />
        </div>

        <div className="border-t border-[color:var(--hair)] bg-paper-100 px-6 py-4">
          <a href="/" className="btn-outline w-full">
            Try again
          </a>
        </div>
      </div>
    </main>
  );
}
