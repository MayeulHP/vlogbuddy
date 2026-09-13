import { FLOW_STAGES } from "@vlogbuddy/shared";
import Link from "next/link";
import { EmptyFrames, Perfs, Wordmark } from "@/components/brand";

/**
 * The cover. One headline, one strip of film, six beats, one form.
 *
 * No screenshots and no stock photography — the empty frames are the pitch:
 * this page is a film that hasn't been shot yet.
 */
export default function HomePage() {
  return (
    <div className="min-h-screen">
      {/* ---------- masthead ---------- */}
      <header className="border-b border-[color:var(--hair-strong)]">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-baseline justify-between gap-x-8 gap-y-2 px-5 py-4 sm:px-8">
          <Wordmark size="md" />
          <p className="eyebrow">Everyone brought the footage</p>
          <p className="eyebrow hidden sm:block">No accounts · One link · Self-hosted</p>
        </div>
      </header>

      {/* ---------- hero ---------- */}
      <main className="mx-auto max-w-[1400px] px-5 sm:px-8">
        <section className="grid gap-10 border-b border-[color:var(--hair)] py-10 lg:grid-cols-12 lg:gap-14 lg:py-16">
          <div className="lg:col-span-7">
            <p className="eyebrow-signal animate-fade-in">Collaborative film club · Issue 01</p>

            <h1 className="headline-xl mt-4 animate-rise text-[clamp(2.6rem,7vw,5.4rem)]">
              Everyone brought
              <br />
              the footage.
              <br />
              <span className="italic text-signal-600">Make the film</span> together.
            </h1>

            <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-ink-700">
              Three days, four phones, nine hundred photos and nobody willing to sit down and
              edit. ROLLCALL turns that pile into one shared cutting room: everyone drops their
              footage, the crew marks up what&apos;s worth keeping, and the film assembles itself
              as the votes land. You tighten it. Then you watch it.
            </p>

            <dl className="mt-8 grid max-w-xl grid-cols-3 gap-px border border-[color:var(--hair)] bg-[color:var(--hair)]">
              {[
                { k: "Accounts", v: "None" },
                { k: "Crew size", v: "Everyone" },
                { k: "Output", v: "MP4" },
              ].map((stat) => (
                <div key={stat.k} className="bg-paper-50 px-3 py-3">
                  <dt className="eyebrow">{stat.k}</dt>
                  <dd className="headline mt-1 text-xl">{stat.v}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* ---------- the call sheet ---------- */}
          <div className="lg:col-span-5">
            <div className="sheet crop-marks shadow-print">
              <div className="flex items-baseline justify-between border-b border-[color:var(--hair-strong)] px-5 py-3">
                <h2 className="headline text-2xl">Got a link?</h2>
                <span className="eyebrow">Call sheet</span>
              </div>
              <div className="space-y-4 px-5 py-5">
                <p className="text-[13px] leading-relaxed text-ink-700">
                  Open it and pick a name. That&apos;s the whole sign-up — no account, no
                  app, no password.
                </p>
                <p className="text-[13px] leading-relaxed text-ink-700">
                  Rolls are started by whoever runs this box, because the footage lives on
                  their disk. Ask them for a link.
                </p>
              </div>
              <div className="border-t border-[color:var(--hair)] bg-paper-100 px-5 py-3">
                <p className="font-mono text-2xs leading-relaxed text-ink-500">
                  Run this box yourself?{" "}
                  <Link href="/admin" className="text-signal-600 underline-offset-2 hover:underline">
                    Projection booth →
                  </Link>
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ---------- the strip ---------- */}
        <section className="border-b border-[color:var(--hair)] py-10">
          <div className="flex items-baseline justify-between">
            <p className="eyebrow">Reel 01 · Unexposed</p>
            <p className="eyebrow">00:00:00:00</p>
          </div>
          <div className="mt-3 bg-ink-900 p-2 shadow-lift">
            <Perfs tone="light" />
            <EmptyFrames count={9} tone="ink" className="my-2" />
            <Perfs tone="light" />
          </div>
          <p className="mt-3 max-w-md font-mono text-2xs leading-relaxed text-ink-500">
            Nine empty frames. Yours will have the bad one where everyone blinked, the good one
            nobody noticed, and the one that ends up first.
          </p>
        </section>

        {/* ---------- the six beats ---------- */}
        <section className="py-12">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[color:var(--hair-strong)] pb-3">
            <h2 className="headline text-[2rem]">How the film gets made</h2>
            <p className="eyebrow">Six beats · One afternoon</p>
          </div>

          <ol className="grid gap-px bg-[color:var(--hair)] sm:grid-cols-2 lg:grid-cols-3">
            {FLOW_STAGES.map((stage, i) => (
              <li key={stage.id} className="group bg-paper-50 p-5 transition-colors hover:bg-paper-100">
                <div className="flex items-baseline justify-between">
                  <span className="timecode text-2xs text-signal-600">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span
                    aria-hidden
                    className="h-px w-10 bg-[color:var(--hair-strong)] transition-all group-hover:w-16 group-hover:bg-signal-500"
                  />
                </div>
                <h3 className="headline mt-3 text-[1.6rem]">{stage.label}</h3>
                <p className="mt-1.5 text-[13px] leading-snug text-ink-600">{stage.blurb}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ---------- pull quote ---------- */}
        <section className="border-t border-[color:var(--hair-strong)] py-12">
          <blockquote className="mx-auto max-w-3xl text-center">
            <p className="headline-xl text-[clamp(1.8rem,4vw,3rem)]">
              A vote isn&apos;t a score. It&apos;s{" "}
              <span className="italic text-signal-600">a note in the margin</span> from someone
              who was there.
            </p>
            <footer className="eyebrow mt-5">ROLLCALL · Editorial policy</footer>
          </blockquote>
        </section>
      </main>

      <footer className="border-t border-[color:var(--hair-strong)]">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3 px-5 py-5 sm:px-8">
          <Wordmark size="sm" />
          <p className="eyebrow">Self-hosted · Yours entirely · Nothing leaves your box</p>
        </div>
      </footer>
    </div>
  );
}
