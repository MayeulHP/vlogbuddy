"use client";

import { useState, useTransition } from "react";
import { adminLoginAction } from "@/lib/actions/admin-auth";

/**
 * A real form, with real fields, so a password manager can fill it — which the
 * browser's Basic Auth dialog never let it do. The action sets the cookie and
 * redirects, so success here is simply the page going away.
 */
export function AdminLoginForm({ next }: { next: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    data.set("next", next);
    setError(null);
    startTransition(async () => {
      const result = await adminLoginAction(data);
      // A successful sign-in redirects, so anything that comes back is a no.
      if (result && !result.ok) setError(result.error);
    });
  }

  return (
    <form onSubmit={submit} className="border border-[color:var(--hair)] bg-paper-50 p-5">
      <label className="block">
        <span className="field-label">Name</span>
        <input
          name="username"
          type="text"
          autoComplete="username"
          defaultValue="admin"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          className="field"
        />
      </label>

      <label className="mt-5 block">
        <span className="field-label">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          className="field"
        />
      </label>

      {error && <p className="notice mt-4">{error}</p>}

      <button type="submit" disabled={pending} className="btn-signal mt-5 w-full">
        {pending ? "Checking…" : "Open the booth"}
      </button>
    </form>
  );
}
