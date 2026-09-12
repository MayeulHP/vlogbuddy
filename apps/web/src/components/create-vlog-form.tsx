"use client";

import { useState, useTransition } from "react";
import { createVlogAction } from "@/lib/actions/vlog";

/** The call sheet: a title, a name, and optionally a word at the door. */
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
    <form action={onSubmit} className="space-y-5">
      <div>
        <label className="field-label" htmlFor="title">
          Working title
        </label>
        <input
          id="title"
          name="title"
          className="field display-sm text-xl"
          placeholder="Ski trip 2026"
          maxLength={120}
          required
          autoComplete="off"
        />
      </div>

      <div>
        <label className="field-label" htmlFor="creatorName">
          Credited as
        </label>
        <input
          id="creatorName"
          name="creatorName"
          className="field"
          placeholder="Your name"
          maxLength={40}
          required
          autoComplete="nickname"
        />
      </div>

      <div>
        <label className="field-label" htmlFor="description">
          Logline <span className="normal-case tracking-normal text-ink-400">(optional)</span>
        </label>
        <textarea
          id="description"
          name="description"
          className="field min-h-[58px] resize-y leading-snug"
          placeholder="Three days, too much snow, one broken ski."
          maxLength={1000}
        />
      </div>

      {showPasscode ? (
        <div>
          <label className="field-label" htmlFor="passcode">
            Door code
          </label>
          <input
            id="passcode"
            name="passcode"
            className="field timecode"
            placeholder="Friends need this to join"
            minLength={3}
            maxLength={64}
            autoComplete="off"
          />
          <button type="button" onClick={() => setShowPasscode(false)} className="btn-quiet mt-1 px-0">
            — Remove code
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setShowPasscode(true)} className="btn-quiet px-0">
          + Add a door code
        </button>
      )}

      {error && <p className="notice">{error}</p>}

      <button type="submit" className="btn-signal w-full" disabled={pending}>
        {pending ? "Loading the camera…" : "Roll camera"}
      </button>
    </form>
  );
}
