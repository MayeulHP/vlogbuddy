"use client";

import { useState, useTransition } from "react";
import { createVlogAction } from "@/lib/actions/vlog";

export function CreateVlogForm() {
  const [error, setError] = useState<string | null>(null);
  const [showPasscode, setShowPasscode] = useState(false);
  const [pending, startTransition] = useTransition();

  function onSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await createVlogAction(formData);
      // A successful create redirects, so anything returned is a failure.
      if (result && !result.ok) setError(result.error);
    });
  }

  return (
    <form action={onSubmit} className="space-y-4">
      <div>
        <label className="label" htmlFor="title">
          Vlog title
        </label>
        <input
          id="title"
          name="title"
          className="input"
          placeholder="Ski trip 2026"
          maxLength={120}
          required
          autoComplete="off"
        />
      </div>

      <div>
        <label className="label" htmlFor="creatorName">
          Your name
        </label>
        <input
          id="creatorName"
          name="creatorName"
          className="input"
          placeholder="Mayeul"
          maxLength={40}
          required
          autoComplete="nickname"
        />
      </div>

      <div>
        <label className="label" htmlFor="description">
          Description <span className="font-normal text-ink-500">(optional)</span>
        </label>
        <textarea
          id="description"
          name="description"
          className="input min-h-[70px] resize-y"
          placeholder="Three days, too much snow, one broken ski."
          maxLength={1000}
        />
      </div>

      {showPasscode ? (
        <div>
          <label className="label" htmlFor="passcode">
            Passcode
          </label>
          <input
            id="passcode"
            name="passcode"
            className="input"
            placeholder="Friends need this to join"
            minLength={3}
            maxLength={64}
            autoComplete="off"
          />
          <button
            type="button"
            onClick={() => setShowPasscode(false)}
            className="mt-1.5 text-xs text-ink-500 transition-colors hover:text-ink-300"
          >
            Remove passcode
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowPasscode(true)}
          className="text-xs text-ink-500 transition-colors hover:text-ink-300"
        >
          + Protect with a passcode
        </button>
      )}

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <button type="submit" className="btn-primary w-full" disabled={pending}>
        {pending ? "Creating…" : "Create vlog"}
      </button>
    </form>
  );
}
