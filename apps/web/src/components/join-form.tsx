"use client";

import { useState, useTransition } from "react";
import { joinVlogAction } from "@/lib/actions/vlog";

export function JoinForm({ slug, requiresPasscode }: { slug: string; requiresPasscode: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await joinVlogAction(slug, formData);
      if (result && !result.ok) setError(result.error);
    });
  }

  return (
    <form action={onSubmit} className="space-y-4">
      <div>
        <label className="label" htmlFor="displayName">
          What should we call you?
        </label>
        <input
          id="displayName"
          name="displayName"
          className="input"
          placeholder="Your name"
          maxLength={40}
          required
          autoFocus
          autoComplete="nickname"
        />
      </div>

      {requiresPasscode && (
        <div>
          <label className="label" htmlFor="passcode">
            Passcode
          </label>
          <input
            id="passcode"
            name="passcode"
            className="input"
            placeholder="Ask whoever shared the link"
            maxLength={64}
            required
            autoComplete="off"
          />
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <button type="submit" className="btn-primary w-full" disabled={pending}>
        {pending ? "Joining…" : "Join the vlog"}
      </button>

      <p className="text-center text-xs text-ink-500">
        No account, no password. Just a name your friends will recognise.
      </p>
    </form>
  );
}
