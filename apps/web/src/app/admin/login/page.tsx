import Link from "next/link";
import { Wordmark } from "@/components/brand";
import { AdminLoginForm } from "@/components/admin/admin-login-form";
import { safeAdminRedirect } from "@/lib/admin-session";

export const dynamic = "force-dynamic";

/**
 * The door to the projection booth. Open to anyone — it has to be — and the
 * only page under /admin the middleware lets through unauthenticated.
 */
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeAdminRedirect((await searchParams).next);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-[color:var(--hair-strong)]">
        <div className="mx-auto flex max-w-[1200px] items-baseline justify-between gap-6 px-5 py-4 sm:px-8">
          <Link href="/">
            <Wordmark size="sm" />
          </Link>
          <p className="eyebrow-signal">Projection booth</p>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center px-5 py-12">
        <p className="eyebrow-signal">Staff only</p>
        <h1 className="headline mt-1 text-3xl">Sign in</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-700">
          This is the box itself — the disk, the export format, the rolls. Guests
          never need to come through here.
        </p>

        <div className="mt-6">
          <AdminLoginForm next={next} />
        </div>

        <p className="mt-6 font-mono text-2xs text-ink-400">
          The password is ADMIN_PASSWORD from the instance&apos;s .env.
        </p>
      </main>
    </div>
  );
}
