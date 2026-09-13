/*
 * ROLLCALL service worker.
 *
 * This app is live: Socket.IO carries votes and co-editing, media goes straight
 * to storage on presigned URLs, and every page is server-rendered per member.
 * A cache that guesses wrong here doesn't make the app faster, it makes it
 * lie — a stale /v/[slug] would show a pile that other people have already
 * moved on from.
 *
 * So the rule is narrow on purpose. The worker only ever answers three kinds of
 * request:
 *
 *   1. Build assets under /_next/static/ and the app's own icons — content-
 *      hashed or effectively frozen, so cache-first is safe.
 *   2. Page navigations — network-first, and the cache is ONLY ever the offline
 *      card. HTML is never stored, so no room ever renders from yesterday.
 *   3. Nothing else.
 *
 * Everything below is passed straight through to the network by declining to
 * call respondWith, which leaves the request exactly as the page made it:
 *
 *   - anything that isn't a GET — so server actions (POST) are untouched
 *   - /api/** — which includes /api/socket, the Socket.IO endpoint, and the
 *     Immich thumbnail proxy that runs on the caller's own credentials
 *   - /socket.io/** — in case the transport path is ever moved back
 *   - every cross-origin request — presigned MinIO PUT/GETs above all, whose
 *     URLs are signed, short-lived and must never be replayed from a cache
 *   - Next's RSC/data fetches and dev endpoints, which match none of the above
 */

const VERSION = "rollcall-v1";
const STATIC_CACHE = `${VERSION}-static`;
const SHELL_CACHE = `${VERSION}-shell`;

/** The card shown when a navigation fails with no network. Nothing else. */
const OFFLINE_URL = "/offline";

const SHELL_ASSETS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // One miss (a cold boot mid-deploy, say) shouldn't fail the install and
      // leave the app with no worker at all.
      await Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !name.startsWith(VERSION)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/** True for the handful of paths that are safe to answer from a cache. */
function isImmutableAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/icon.svg" ||
    url.pathname === "/manifest.webmanifest"
  );
}

/** Paths the worker must never touch, whatever the request looks like. */
function isLive(url) {
  return url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Presigned storage, Immich servers, web fonts — none of ours to cache.
  if (url.origin !== self.location.origin) return;
  if (isLive(url)) return;

  if (isImmutableAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(navigateNetworkFirst(request));
  }

  // Everything else — RSC payloads, route handlers, dev tooling — falls through
  // to the browser untouched.
});

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  // Opaque and error responses are not worth keeping; a 404 cached hard would
  // outlive the deploy that caused it.
  if (response.ok && response.type === "basic") {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

/**
 * Pages always come from the server. If the network is gone we hand back the
 * offline card — never a previous render of this or any other page.
 */
async function navigateNetworkFirst(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response("You're offline, and ROLLCALL hasn't cached this page.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
