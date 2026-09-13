"use client";

import { useEffect } from "react";

/**
 * Registers the service worker that makes ROLLCALL installable.
 *
 * Development is left alone on purpose: Next's dev chunks under /_next/static
 * are rewritten constantly, and the worker treats that path as immutable. In
 * production those URLs are content-hashed, which is what makes it safe.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
        // An instance served over plain HTTP on a LAN IP can't register one.
        // That costs the install prompt, nothing else, so don't shout about it.
        console.info("[rollcall] service worker not registered:", err?.message ?? err);
      });
    };

    if (document.readyState === "complete") register();
    else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
