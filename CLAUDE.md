# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Self-hosted collaborative vlog maker. Friends open one share link, dump photos/videos/music
into a shared pile, react with three emoji that double as a score, and the best bits
assemble themselves into a timeline that FFmpeg renders server-side into an MP4.
No accounts — identity is a display name plus a signed cookie scoped to one vlog.

## Commands

```bash
pnpm install

# Dependencies only; the app runs on the host
docker compose up -d postgres minio minio-init
pnpm db:migrate

pnpm dev          # web on :3000 (custom server, not `next dev`)
pnpm dev:worker   # media + render worker (needs ffmpeg/ffprobe on PATH)

pnpm typecheck    # all four packages — the real gate, run this before finishing
pnpm build        # production build
```

`pnpm lint` is currently broken: `next lint` is deprecated in Next 15 and prompts
interactively. Don't rely on it; `pnpm typecheck` is the check that works.

Full stack in Docker: `docker compose up -d --build`. Migrations run automatically on
web boot. `./scripts/setup-env.sh` writes `.env` with generated secrets
(`--lan` detects the LAN IP and sets `CORS_ALLOW_ORIGIN=*` for domain-less access).

### Database changes

Edit `packages/db/src/schema.ts`, then either `pnpm db:generate` (drizzle-kit writes a
migration) or hand-write the SQL in `packages/db/drizzle/` and append an entry to
`drizzle/meta/_journal.json`. Migrations are applied by `packages/db/src/migrate.ts`,
which reads that journal — a `.sql` file without a journal entry never runs.

### Checks

There is no unit test suite. Two integration scripts exist instead:

```bash
# FFmpeg filter graphs, rendering real MP4s. Generate test media first —
# see the header of apps/worker/src/render-check.ts.
pnpm --filter @vlogbuddy/worker render-check /tmp/vbrender

# Whole pipeline against live Postgres + MinIO
docker compose exec worker pnpm --filter @vlogbuddy/worker exec tsx src/e2e-check.ts
```

## Architecture

Both `apps/web` and `apps/worker` need `SESSION_SECRET` — the worker uses it to
unseal stored Immich keys, and the two must match.

Four packages: `apps/web` (Next 15 App Router + custom Node server), `apps/worker`
(FFmpeg pipeline), `packages/db` (Drizzle schema/migrations/client), `packages/shared`
(timeline model, zod schemas, realtime contract). The two `packages/*` are consumed as
raw TypeScript source — no build step, so a change there is live in both apps.

### The timeline document is the product

`packages/shared/src/timeline.ts` holds `TimelineDoc`: one flat video track, one music
bed, titles as per-clip overlays. It is mutated only through `TimelineOp` values fed to
the pure reducer `applyTimelineOp`, which runs in three places — optimistically in the
browser, authoritatively in the socket handler, and again in server actions. The worker
compiles the result into an FFmpeg filter graph. Any new editing capability means a new
op in the discriminated union plus a reducer case, not an ad-hoc mutation.

### The cut engine keeps Gather and Edit in sync

`apps/web/src/lib/cut-core.ts` (`syncCut`, re-exported from `lib/cut.ts`) is the single place that decides what is in the
final cut and in what order. It reads votes, the vlog's `scoreThreshold` (the draggable
cut line) and per-item `cutOverride` columns, writes the running order into `selections`,
and reconciles `timelines.doc` with `reconcileClips` — reusing existing clips by
`mediaItemId` so trims, titles and transitions survive. It returns the document unchanged
when nothing moved, so a flurry of votes doesn't churn revisions.

Every mutation that can change the cut calls it: voting, dragging the cut line,
pinning/dropping an item, reordering, adding/deleting media or music, finishing an
Immich import, and `startRenderAction`. The inclusion rule (`lib/is-in-cut.ts`) is shared verbatim with the
client so the pile, the cut strip and the render can't disagree. Adding a new mutation
that touches media, music, votes or ordering means calling `syncCut` from it.

### Phases are mostly gone

`vlog_state` still has five values, but `open`, `curate` and `edit` are all "the vlog is
being worked on" — use `isWorkingState()`, never compare to `"open"` directly. Only
`export` (rendering) and `published` lock things. Which view a member sees (Gather / Edit
/ Watch) is a per-browser `localStorage` preference in `vlog-shell.tsx`, not vlog state,
so nobody waits for the creator to advance a phase. Creator-only actions are down to
rendering and reopening a published vlog.

### Immich transfers

Each member can connect their own Immich server (`immich_connections`, one row
per member, API key sealed with AES-256-GCM via `@vlogbuddy/shared/secrets` —
a subpath export precisely because it imports `node:crypto` and must never
reach a browser bundle). The API client in `packages/shared/src/immich.ts` is
plain `fetch` against the documented endpoints, written for Immich API v3.2.0
and tolerant of older field spellings; it has no Node imports so its types are
safe to use client-side.

Both directions run in the worker as pg-boss jobs and report through one
`immich_transfers` row (persisted *and* broadcast, so a reload mid-copy still
shows the bar). Import pulls originals into MinIO and enqueues the normal
`process-media` pipeline; export asks the target instance which checksums it
already has (`bulk-upload-check`) before uploading anything, then files
everything into an album. Dedupe in both directions keys off
`media_items.checksum_sha1`, a base64 SHA-1 in the same shape Immich uses —
`process-media` computes it for browser uploads while it has the file on disk.

Never let a decrypted key into a server action's return value; `publicConnection`
is the only shape the browser gets. Thumbnails go through
`/api/immich/[slug]/thumb/[assetId]`, which uses the *caller's own* credentials.

### Realtime

One Socket.IO room per vlog, served from `apps/web/server.ts` (that's why there's a
custom server — `next dev`/`next start` won't work). Socket auth re-verifies the same
signed cookie the app uses, scoped to the single vlog in the handshake.

Server components own all data, so most events are just a debounced `router.refresh()`
in `vlog-shell.tsx`; only `timeline:op` and `immich:transfer` carry real payloads.
The worker is a separate process and reaches browsers via Postgres `LISTEN/NOTIFY`
(`apps/worker/src/notify.ts` → the bridge in `server.ts`). Broadcasting from a server
action goes through `emitToVlog`, which finds the io instance on `globalThis`.

`useVlogSocket` holds the socket in **state, not a ref**. React runs child effects
before the parent's, so a ref is still null when a nested component subscribes and
that subscription silently never fires. Pass the socket itself (`VlogSocket | null`)
down to children, never a ref.

One `NOTIFY` type is not a browser event: `cut:resync`. The worker sends it after an
Immich import because the cut engine lives in the web app, and `server.ts` handles it
by calling `syncCut`. That's also why the engine sits in `lib/cut-core.ts` with the
broadcaster **injected** — the custom server runs outside Next's module graph, where
`server-only` (and anything importing it) can't resolve. App code imports `lib/cut.ts`,
which re-adds the guard and wires `emitToVlog`.

### Storage and jobs

Browsers PUT straight to MinIO with presigned URLs — media never passes through Node, so
proxy body limits don't matter for the app, only for the storage host. `pending_uploads`
tracks the gap between issuing a URL and the client confirming. Job queue is pg-boss on
the same Postgres (no Redis); queues must be created before `send()` or jobs are silently
dropped, which both `lib/queue.ts` and the worker's boot do defensively.

## Conventions

- Comments explain *why*, at the level of a design decision, and are written for a reader
  who can already read the code. Match that register; don't narrate syntax.
- Server actions return `{ ok: true, ... } | { ok: false, error: string }` rather than
  throwing, and the error string is shown to the user — write it as UI copy.
- User-facing copy is plain, warm and specific ("The pile is empty", "give it a moment and
  try again"). No jargon from the data model leaks into it.
- `revalidatePath('/v/${slug}')` after any mutation; add `"layout"` when the phase changes.
