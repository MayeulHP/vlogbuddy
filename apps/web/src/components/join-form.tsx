"use client";

import { useState, useTransition } from "react";
import { joinVlogAction } from "@/lib/actions/vlog";

/** Signing in on the crew list. No account, just a name and maybe a code. */
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
    <form action={onSubmit} className="space-y-5">
      <div>
        <label className="field-label" htmlFor="displayName">
          Sign the crew list
        </label>
        <input
          id="displayName"
          name="displayName"
          className="field display-sm text-xl"
          placeholder="Your name"
          maxLength={40}
          required
          autoFocus
          autoComplete="nickname"
        />
      </div>

      {requiresPasscode && (
        <div>
          <label className="field-label" htmlFor="passcode">
            Door code
          </label>
          <input
            id="passcode"
            name="passcode"
            className="field timecode"
            placeholder="Ask whoever sent the link"
            maxLength={64}
            required
            autoComplete="off"
          />
        </div>
      )}

      {error && <p className="notice">{error}</p>}

      <button type="submit" className="btn-signal w-full" disabled={pending}>
        {pending ? "Signing in…" : "Join the crew"}
      </button>

      <p className="font-mono text-2xs leading-relaxed text-ink-500">
        No account, no password — just a name your friends will recognise on the credits.
      </p>
    </form>
  );
}
