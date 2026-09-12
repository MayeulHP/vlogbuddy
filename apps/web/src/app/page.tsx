import Link from "next/link";
import { CreateVlogForm } from "@/components/create-vlog-form";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-6 py-12">
      <header className="mb-12">
        <div className="flex items-center gap-2.5">
          <span className="text-3xl">🎬</span>
          <h1 className="text-2xl font-bold tracking-tight text-white">VlogBuddy</h1>
        </div>
      </header>

      <div className="grid flex-1 gap-12 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
        <section className="flex flex-col justify-center">
          <h2 className="text-4xl font-bold leading-tight tracking-tight text-white sm:text-5xl">
            Make a vlog with your friends.
            <br />
            <span className="bg-gradient-to-r from-brand-400 to-cyan-400 bg-clip-text text-transparent">
              Without the effort.
            </span>
          </h2>

          <p className="mt-5 max-w-lg text-lg leading-relaxed text-ink-300">
            Create a vlog, share one link. Everyone dumps their photos, videos and
            music picks into a shared pile, reacts to the good stuff, and the best
            bits float to the top on their own.
          </p>

          <ol className="mt-10 space-y-4">
            {[
              {
                emoji: "🔗",
                title: "Share a link",
                body: "No accounts. Friends pick a name and they're in.",
              },
              {
                emoji: "📥",
                title: "Dump everything",
                body: "Photos, videos and music links land in one shared pile, roughly in order.",
              },
              {
                emoji: "🔥",
                title: "React to rank",
                body: "Three emoji, three scores. The best moments surface organically.",
              },
              {
                emoji: "✂️",
                title: "Cut it together",
                body: "The vlog assembles itself from the winners. Trim it together, then render.",
              },
            ].map((step, i) => (
              <li key={step.title} className="flex gap-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ink-700 bg-ink-850 text-lg">
                  {step.emoji}
                </div>
                <div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-mono text-ink-500">0{i + 1}</span>
                    <h3 className="font-semibold text-white">{step.title}</h3>
                  </div>
                  <p className="mt-0.5 text-sm text-ink-400">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="flex flex-col justify-center">
          <div className="card p-6">
            <h3 className="text-lg font-semibold text-white">Start a new vlog</h3>
            <p className="mt-1 text-sm text-ink-400">
              You&apos;ll get a share link on the next screen.
            </p>
            <div className="mt-6">
              <CreateVlogForm />
            </div>
          </div>

          <p className="mt-6 text-center text-sm text-ink-500">
            Got a link from a friend? Just open it — no account needed.
          </p>
        </section>
      </div>

      <footer className="mt-16 border-t border-ink-800 pt-6 text-sm text-ink-500">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>VlogBuddy — self-hosted, yours entirely.</span>
          <Link
            href="https://github.com"
            className="text-ink-400 transition-colors hover:text-ink-200"
          >
            Docs &amp; source
          </Link>
        </div>
      </footer>
    </main>
  );
}
