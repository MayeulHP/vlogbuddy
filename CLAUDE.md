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
web boot. The images are built for slow machines: a BuildKit cache mount holds the pnpm
store, `pnpm fetch` keeps the download layer keyed on the lockfile alone, the runtime
stages install `--prod` only, and neither app copies the other's source — so a web-only
change rebuilds the worker in seconds. `tsx` is a runtime dependency, not a dev one,
because the production server and the migrator both run through it. `./scripts/setup-env.sh` writes `.env` with generated secrets
(`--lan` detects the LAN IP and sets `CORS_ALLOW_ORIGIN=*` for domain-less access).

### Database changes

Edit `packages/db/src/schema.ts`, then either `pnpm db:generate` (drizzle-kit writes a
migration) or hand-write the SQL in `packages/db/drizzle/` and append an entry to
`drizzle/meta/_journal.json`. Migrations are applied by `packages/db/src/migrate.ts`,
which reads that journal — a `.sql` file without a journal entry never runs, and a
duplicate `when` timestamp makes Drizzle skip the later migration silently, so always
give a new entry a strictly larger one.

### Checks

There is no unit test suite. Two integration scripts exist instead:

```bash
# The auto-cut: scene detection, and the identity contract syncCut relies on.
# Pure functions, so this needs nothing running.
pnpm --filter @vlogbuddy/worker exec tsx src/director-check.ts

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

`packages/shared/src/timeline.ts` holds `TimelineDoc`, which has four parts:

- `clips` — the base video track, a sequence. The cut engine owns it: the vote decides
  what's in it and in what order.
- `layers` — photos and video composited *over* the base track, each pinned to an
  absolute time and a rectangle in the frame (fractions, never pixels, so a layout made
  against the preview survives a change of render height). Hand-placed; the vote has no
  opinion about them.
- `audio` — a stack of tracks mixed underneath. Exactly one carries `role: "bed"` and
  follows the soundtrack lane; the rest are hand-placed cues. Never index `audio[0]` to
  find the bed — look it up by role.
- `scenes` — the stretches of trip the base track breaks into, derived from capture gaps
  but **stored**, because the derived name is only a first guess and a person may replace
  it. A clip points at one by `sceneId`; never by index, which stops being true the moment
  anything is reordered. Reconciled across a re-cut by *shot membership* — the
  `reconcileClips` rule widened from one item to a set — so a scene that splits leaves its
  name on the bigger half. Ids derive from a member clip's `mediaItemId`, never randomly,
  or the director would churn a revision on every vote forever. A name a person set is
  protected by the same `auto` provenance as a hand-trimmed clip, through
  `SCENE_AUTO_FIELDS` and `clearSceneAutoFor`.

The base track sets the running time; layers and audio are clipped to it. It is mutated
only through `TimelineOp` values fed to the pure reducer `applyTimelineOp`, which runs in
three places — optimistically in the browser, authoritatively in the socket handler, and
again in server actions. The worker compiles the result into an FFmpeg filter graph. Any
new editing capability means a new op in the discriminated union plus a reducer case, not
an ad-hoc mutation.

Documents written before multi-track have no `layers` and no ids on their audio tracks,
so **every read of `timelines.doc` goes through `normalizeTimeline`** — the column is
typed but not validated, and the schema's defaults are what fill the gap.

### The cut engine keeps Gather and Edit in sync

`apps/web/src/lib/cut-core.ts` (`syncCut`, re-exported from `lib/cut.ts`) is the single place that decides what is in the
final cut and in what order. It reads votes, the vlog's `scoreThreshold` (the draggable
cut line) and per-item `cutOverride` columns, writes the running order into `selections`,
and reconciles `timelines.doc` with `reconcileClips` — reusing existing clips by
`mediaItemId` so trims, titles and transitions survive. It returns the document unchanged
when nothing moved, so a flurry of votes doesn't churn revisions.

### The auto-cut decides how the cut plays

`syncCut` settles *what* is in the film; `packages/shared/src/director.ts`
(`runDirector`) settles *how* it plays. It runs inside `syncCut`, between
`reconcileClips` and the running-time measurement — the music bed's start is a
fraction of the total, so it has to see the lengths the director chose.

Screen time is a budget from the item's `rankScore`, banded into three absolute
tiers against the vlog's `scoreThreshold` — deliberately **not** a percentile of
the pile, because a percentile is set-relative and one new reaction would re-time
every other shot. Long videos get a window taken out of their middle rather than
their whole length. Scenes come from `capturedAt` gaps, day boundaries, and
distance: a shot more than `SCENE_MOVE_METRES` (500m) from the scene's **anchor**
— the first located shot in it, never the previous shot — starts a new one, so a
walk breaks once per 500m covered instead of never or constantly. Items with no
fix never break a scene and never move the anchor, and `(0,0)` is read as no fix
because it is what a camera writes when GPS never locked. The grammar is a hard
cut within a scene and a dissolve between them. Stills get a slow push or pull
(`motion`, an auto field of its own), which is what pays for their cap rising
from four seconds to seven — a still told to hold still gives the time back.

The budget is always *screen* seconds. `clipDuration` is the one place `speed`
is divided out and `clipSourceSpan` is the pre-speed length the trim window and
FFmpeg's `-t` both measure; every other timing helper derives from those two, so
a third opinion about how long a clip is will desynchronise the bench, the
preview and the render.

Two invariants:

- **It is pure.** No `Date.now()`, no `Math.random()`, no I/O, and every
  generated number rounded to 3dp at the point of generation. `syncCut` skips
  its write when `next === current`, so the director must return the identical
  clip object — and the identical document — when nothing moved. A float that
  fails to round-trip through jsonb would churn a revision on every vote forever.
- **It never overrules a person.** Each clip carries `auto`, the list of
  decisions the director still owns (`AUTO_FIELDS`). `applyTimelineOp` clears the
  matching flag through `clearAutoFor` whenever an edit touches those fields, so
  all three reducer sites agree without coordination. Documents written before
  the auto-cut parse with `auto: []`, which means the director leaves them
  entirely alone. `AUTO_FIELD_FOR` is a total map over the clip's fields, so
  adding one fails the typecheck until it's classified.

`director.recut` re-arms every flag — that's the "start again" button, and the
only way the director gets a hand-trimmed shot back.

Every mutation that can change the cut calls it: voting, dragging the cut line,
pinning/dropping an item, reordering, adding/deleting media or music, finishing an
Immich import, and `startRenderAction`. The inclusion rule (`lib/is-in-cut.ts`) is shared verbatim with the
client so the pile, the cut strip and the render can't disagree. Adding a new mutation
that touches media, music, votes or ordering means calling `syncCut` from it.

It only reconciles the base track and the bed. Layers and hand-placed cues survive every
sync untouched — except that `pruneTimelineReferences` drops anything pointing at media
or music that has since been deleted, because a layer over a vanished photo can't
render.

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

Coordinates are the same kind of secret. `media_items.latitude`/`longitude` reach
exactly two places: `CutEntry`, built inside `syncCut` and read by the auto-cut,
and the worker that writes them. **`MediaItemView` deliberately `Omit`s both**,
because it is serialised into the RSC payload for every member of the vlog — a
plain `{ ...item }` there once shipped the whole row, and putting the columns
back on either side would hand everyone's GPS to every browser in the vlog. Any
new column on `media_items` walks into the same trap.

### The admin boundary

`/admin` is a signed cookie checked in `src/middleware.ts`, which sends anyone
without one to the form at `/admin/login`; every admin page and action also calls
`requireAdmin()` from `lib/admin.ts`, and that second check is the one that
protects the data — server actions are plain POSTs and a matcher change shouldn't
be all that stands between a guest and `deleteVlogAction`. `createVlogAction` is
admin-only too. Anything guest-facing (`/v/[slug]` and its actions) stays open.

It is **not** HTTP Basic Auth, and must not become it again: a navigation served
through `public/sw.js` can't carry an auth challenge to completion, so the
browser re-prompts forever, and the prompt is unfillable by a password manager
besides. The cookie is minted and verified in `lib/admin-session.ts`, which uses
Web Crypto and imports neither `node:crypto` nor `server-only` — the middleware
runs in the edge runtime and has to reach the same verdict as the pages do. It
carries an expiry and a fingerprint of `ADMIN_PASSWORD`, so rotating the password
(or `SESSION_SECRET`) signs every browser out.

Export format lives in the one-row `app_settings` table, read through
`getRenderSettings()` in `packages/db` by both the admin page and the render job;
`RENDER_HEIGHT`/`RENDER_FPS` only seed the first boot. The read tolerates the
table being absent, because the worker boots independently of the migration.

Sweeping sources sets `media_items.pruned_at` and drops the objects. The row and
its votes stay; `queries.ts` must never presign a pruned item.

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
dropped. Both apps create them through `ensureQueues` in `@vlogbuddy/shared/queues`,
which is also the single place a queue's **policy** is stated — whichever process boots
first would otherwise decide.

The policy is not decoration. `singletonKey` on a `send()` is enforced only by a partial
unique index, and each of those is conditioned on the queue's policy, so under the default
`standard` a key is **accepted and silently ignored** — which is how "one render at a time
per vlog" was decorative for a while. Renders and both Immich directions run `stately`
(one active, one waiting, per key); `process-media` stays `standard` because fan-out is
the point. Two traps behind that:

- `create_queue` inserts `ON CONFLICT DO NOTHING` and returns *without error* on a queue
  that already exists — it does not raise "already exists". Reconciling a policy only
  inside a `catch` therefore never runs, and an instance created before the policies
  existed keeps `standard` forever. `ensureQueues` reconciles unconditionally.
- A real constraint means `send()` returns **null** when it rejects. Every caller has to
  handle that or it leaves a row — a `render_jobs` or an `immich_transfers` — waiting on a
  job that will never exist, which for transfers is a progress bar that never moves.

## Conventions

- Comments explain *why*, at the level of a design decision, and are written for a reader
  who can already read the code. Match that register; don't narrate syntax.
- Server actions return `{ ok: true, ... } | { ok: false, error: string }` rather than
  throwing, and the error string is shown to the user — write it as UI copy.
- User-facing copy is plain, warm and specific ("The pile is empty", "give it a moment and
  try again"). No jargon from the data model leaks into it.
- `revalidatePath('/v/${slug}')` after any mutation; add `"layout"` when the phase changes.

Transitions are a curated subset of FFmpeg's `xfade` (eleven, with editors'
names rather than the filter's). `XFADE_FOR` in `constants.ts` is the single
place a filter name appears — every other caller asks `overlapsPrevious()`,
because what the timing code needs to know is whether a clip overlaps the one
before it, not how it looks. Adding a transition is one entry in four maps —
the fourth, `TRANSITION_EFFECT`, is how the preview plays it in the DOM, kept
apart from `XFADE_FOR` so no filter name ever reaches a browser bundle.

## FFmpeg gotchas worth not rediscovering

`concat` returns its output at timebase 1/1000000 regardless of what went in,
and `xfade` refuses two inputs whose timebases disagree. A run of hard cuts
followed by a dissolve — the auto-cut's ordinary grammar — therefore fails
outright unless the clip chains and the concat output both `settb=1/${fps}`.
The `cut-then-dissolve` case in `render-check.ts` exists to keep that fixed.
