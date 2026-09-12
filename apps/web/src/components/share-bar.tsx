"use client";

import { useState } from "react";

/** One link is the entire invitation system. */
export function ShareBar({ shareUrl }: { shareUrl: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      // Clipboard API needs a secure context; fall back to a selection prompt.
      window.prompt("Copy this link:", shareUrl);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  async function share() {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "Join the roll", url: shareUrl });
        return;
      } catch {
        // User dismissed the sheet — fall through to copying.
      }
    }
    void copy();
  }

  return (
    <button onClick={share} className="btn-outline whitespace-nowrap" title={shareUrl}>
      {copied ? "✓ Link copied" : "Invite crew"}
    </button>
  );
}
