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

`packages/shared/src/timeline.ts` holds `TimelineDoc`, which has three parts:

- `clips` — the base video track, a sequence. The cut engine owns it: the vote decides
  what's in it and in what order.
- `layers` — photos and video composited *over* the base track, each pinned to an
  absolute time and a rectangle in the frame (fractions, never pixels, so a layout made
  against the preview survives a change of render height). Hand-placed; the vote has no
  opinion about them.
- `audio` — a stack of tracks mixed underneath. Exactly one carries `role: "bed"` and
  follows the soundtrack lane; the rest are hand-placed cues. Never index `audio[0]` to
  find the bed — look it up by role.

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

`reconcileClips` reuses clips **by group, in document order**: one media item can hold
several clips, because `clip.split` cuts a shot in two and both halves point at the same
file. Keeping a single clip per media item — which is what it used to do — silently
dropped the second half on the next vote. A default clip is invented only for a cut entry
that has no clips at all. `clip.split` itself works in on-screen seconds (so a shot
running at 2× splits where the playhead is, not where the file is), refuses a cut that
would leave a flash frame either side, hands the tail a hard `transitionIn` because
dissolving a shot into itself is never what splitting meant, and takes its new id from the
*caller* — the reducer runs three times over the same op, and an id minted inside it would
come out different each time.

### The auto-cut decides how the cut plays

`syncCut` settles *what* is in the film; `packages/shared/src/director.ts`
(`runDirector`) settles *how* it plays. It runs inside `syncCut`, between
`reconcileClips` and the running-time measurement — the music bed's start is a
fraction of the total, so it has to see the lengths the director chose.

Screen time is a budget from the item's `rankScore`, banded into three absolute
tiers against the vlog's `scoreThreshold` — deliberately **not** a percentile of
the pile, because a percentile is set-relative and one new reaction would re-time
every other shot. Long videos get a window taken out of their middle rather than
their whole length. Scenes come from `capturedAt` gaps; the grammar is a hard cut
within a scene and a dissolve between them.

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

### The bench is a fixed viewport

Edit is the one room that doesn't scroll: picture, strip and inspector are all on screen
at once. `vlog-shell.tsx` puts the page on `md:h-dvh md:overflow-hidden` for that tab only,
and the column flex hands the editor whatever the sticky masthead and the footer leave
behind — no header height is written down anywhere, so it can't go stale. Everything
inside needs `min-h-0` to let a flex child actually shrink, and the strip's cap is a
`max(…, min(…))` of viewport units rather than a fixed number. Phones keep the ordinary
stacked flow and get the inspector as a bottom sheet instead. The practical consequence:
anything added to the bench costs strip you can't see, which is why the editor has no
masthead of its own and why the inspectors group their controls into collapsible sections.

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

### The admin boundary

`/admin` is Basic Auth in `src/middleware.ts`; every admin page and action also
calls `requireAdmin()` from `lib/admin.ts`, and that second check is the one that
protects the data — server actions are plain POSTs and a matcher change shouldn't
be all that stands between a guest and `deleteVlogAction`. `createVlogAction` is
admin-only too. Anything guest-facing (`/v/[slug]` and its actions) stays open.

Export format lives in the one-row `app_settings` table, read through
`getRenderSettings()` in `packages/db` by both the admin page and the render job;
`RENDER_HEIGHT`/`RENDER_FPS` only seed the first boot. The read tolerates the
table being absent, because the worker boots independently of the migration.

### The frame

Shape belongs to the vlog, size belongs to the box. `vlogs.format` is landscape,
portrait or square, chosen by any crew member on the bench (`format-panel.tsx`, in the
Film tab beside the auto-cut's fit policy — gating the shape when anyone can already
reframe a shot would be a lock with the door open; only printing stays creator-only), while
`app_settings.renderHeight` is read as the film's **shorter edge** — so widescreen
comes out exactly as it always did (1080 → 1920×1080) and an upright film costs the
same pixels rather than 1.8× them. `frameFor()` in `packages/shared/src/frame.ts` is
the only place that arithmetic lives; the render job, the print dialog and the
preview all ask it, and `previewFrame()` is the same shape at a nominal 1080 for
anything drawn in a browser. Clip normalisation is geometry-agnostic (scale to fit,
pad, `setsar=1`), so a portrait frame pillarboxes landscape footage with no further
help; `render-check.ts` renders a portrait and a square case to keep it that way.

Pillarboxing is only the floor, though. `clip.fit` picks what happens to a shot
whose shape isn't the frame's — `bars` (scale to fit and pad, the untouched
original path), `fill` (scale to cover and crop) or `blur` (the fitted shot over a
blurred, cropped copy of itself). The vlog-wide default is `director.fitPolicy`,
`blur`, because the common mismatch should look deliberate and cropping should be a
choice rather than a default someone discovers.

**`fit` defaults to `"auto"` and `"auto"` is never resolved into the document.**
`process-media` writes `width`/`height` after the upload lands, so a clip can reach
the cut before anything knows its shape; a decision baked in at that moment would
flip when the probe arrives and churn a revision on every upload. The document holds
the intent and `resolveFit()` in `frame.ts` answers the question wherever the real
dimensions are — the renderer, the preview and the inspector all ask it, and they
agree because there is only one of it. Unknown dimensions resolve to `bars`: it is
the only answer that can't lose someone their footage. The director has no opinion
here at all, which is why `AUTO_FIELD_FOR.fit` is `null`.

Layer geometry is fractions of the frame and **stays** fractions when the shape
changes: a corner inset stays in that corner and is re-proportioned. Rewriting the
stored numbers on a format change can't preserve both a layer's position and its
size, so it would quietly clamp one; re-proportioning is visible and reversible —
switch back and the layout is exactly as it was.

Sweeping sources sets `media_items.pruned_at` and drops the objects. The row and
its votes stay; `queries.ts` must never presign a pruned item.

### Speed and look

Two cheap decisions that change what a shot is like, both of them clip fields the director
never touches. `speed` is folded into `clipDuration` — the on-screen length is the trimmed
span *divided by* the speed — so the strip, the preview, the beat snapping and the renderer
all agree on how long a 2× shot runs without any of them knowing the field exists; anything
measuring a shot must go through `clipDuration`/`clipSpeed` rather than subtracting trims.
`look` is a grade named for what it does to a holiday, and `LOOK_FILTERS` (FFmpeg) beside
`LOOK_CSS` (the preview's approximation) are the only places a filter is spelled — the two
will never match exactly, which is why the inspector says the print is the truth. Adding a
look is one entry in each of the four maps. Sound follows the picture: the render pulls
`duration × rate` seconds of file and lets `atempo` hand back `duration` seconds of film.
`atempo` only takes 0.5–2.0, so anything further out is a chain of stages (4× is two
doublings) and 1× is an empty chain rather than a pointless resample. It keeps pitch,
which is the right answer for a walk back to the car and the wrong one for a voice — part
of why `MIN_CLIP_SPEED`/`MAX_CLIP_SPEED` stop at a quarter and four.

### The print is many small passes

`planRender` in `apps/worker/src/jobs/render.ts` turns the timeline into a list of
FFmpeg invocations, and the worker runs them one at a time. It used to be a single
invocation — every clip an input, the whole film one filter graph — which cannot be
made to work on a modest box: FFmpeg opens every input at once and decodes them all
from the start of the film while the encoder is still on shot one, and the frames
nothing is ready to consume queue up inside the graph, unbounded. Measured on a
14-shot 50-second cut at 1440p60: 6 GB after a minute, then the OOM killer takes
FFmpeg out and the job reports `exited with code null`. **Adding a feature here must
not put a second piece of footage into a pass that didn't have one.**

The pieces are disjoint spans of the finished film: a *body* per shot, covering the
part no dissolve reaches into, and one pass per dissolve over just the tail of the
outgoing shot and the head of the incoming one. Every piece leaves the same encoder
at the same size, rate and timebase, so the join is `-c copy` through the concat
demuxer and costs nothing. Three things follow from that shape:

- **Piece lengths are snapped to whole frames** (`snap()`). A file holds frames, so
  FFmpeg rounds up whatever it's asked for; twenty pieces of half a frame each is a
  third of a second the film never had.
- **A dissolve may eat at most `MAX_OVERLAP_SHARE` of *both* neighbours**, where the
  single graph only clamped against the incoming one. A shot dissolving at both ends
  therefore always keeps a body, because FFmpeg will not encode nothing.
- **Sound is one pass of its own**, mixed from all tracks at once — audio frames are
  kilobytes, so the all-at-once graph that sinks a picture render is free here. It is
  assembled on the same overlaps as the picture; feed it different ones and the film
  goes out of sync. Titles likewise shift onto the piece being printed, because a
  title's times are relative to its clip and a piece may start partway in.

Layers are pinned to absolute times in the film rather than to a shot, so they can't
be printed into the pieces: they are a second encode of the joined picture, and only
when somebody actually placed one.

`render-check.ts` runs real plans against real media — it is the only thing that
proves the pieces still join, so a change to the plan means running it.

A render that dies with its worker leaves a `rendering` row and a vlog stuck in
`export`, which locks every room and makes `startRenderAction` refuse. The worker
reclaims those on boot (`reclaimAbandonedRenders`), which assumes one worker.

### Undo is local, and made of inverse ops

`use-timeline-history.ts` is per browser and only records ops *this* client dispatched:
undoing somebody else's edit because it happened to be the most recent one is never what
the button means, so remote `timeline:op` and `timeline:sync` pass it by. Nothing rolls a
document back. An undo is computed as the inverse of the op against the document as it
stood *before* it, then dispatched down the ordinary path, so it broadcasts, persists and
reconciles like a hand edit — and a stale inverse simply no-ops, because the reducer
ignores ids it can't find. A patch's inverse carries the old `auto` flags too, or undoing
a hand trim would leave the shot pinned away from the director for good.

The awkward part is that not every bench edit is a document edit. Taking a shot out is a
`cutOverride` on the media item, and reordering goes through `reorderCutAction`, so their
inverses have to route through the cut actions as well — hence the three flavours of
`HistoryAction`: `ops` (the editor's own dispatch, cut actions included), `restore` (the
floor's "bring it back", the inverse of taking a shot out) and `rawOps`, which writes the
document directly and exists only for un-splitting, where routing through the cut would
throw the whole source file out of the film.

### The strip draws real footage

`media_items` carries `filmstrip_key` / `filmstrip_frames` / `filmstrip_interval_seconds`
for video and `peaks` for audio (`music_items.peaks` likewise), all written by
`process-media`. The filmstrip is one JPEG of tiled frames that the editor paints as a
repeating background sized frames × interval × pixels-per-second, so a block on the bench
shows the footage at that moment instead of one thumbnail stretched over it, and stays
true through a trim because the in-point is just an offset in pixels. `peaks` is a 0..1
envelope at `PEAKS_PER_SECOND` buckets a second — the thing that makes a cue line up
against a waveform rather than a flat bar.

Footage that predates all this is repaired by the worker's two one-off scripts, both of
which pull originals down through the worker's own S3 client, touch only rows missing the
value, and take `--dry-run`:

```bash
pnpm --filter @vlogbuddy/worker exec tsx src/backfill-strip-assets.ts   # filmstrips, peaks
pnpm --filter @vlogbuddy/worker exec tsx src/backfill-dimensions.ts     # re-probe w/h/rotation
```

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

Transitions are a curated subset of FFmpeg's `xfade` (eleven, with editors'
names rather than the filter's). `XFADE_FOR` in `constants.ts` is the single
place a filter name appears — every other caller asks `overlapsPrevious()`,
because what the timing code needs to know is whether a clip overlaps the one
before it, not how it looks. Adding a transition is one entry in three maps.

## FFmpeg gotchas worth not rediscovering

`xfade` refuses two inputs whose timebases disagree, and `concat` hands its
output back at timebase 1/1000000 regardless of what went in. Every picture
chain therefore ends `settb=1/${fps}` — it is also what lets the finished
pieces be joined by stream copy. The `cut-then-dissolve` case in
`render-check.ts` exists to keep that fixed.

A child killed by a signal closes with `code === null` and no exit code, so
reporting only the code throws away the one useful fact. `exitMessage` in
`ffmpeg.ts` names the signal and reads SIGKILL as what it almost always is on a
shared box: the OOM killer choosing the biggest process, which FFmpeg is. It
also drops the `frame= … speed=` progress lines from the stderr tail, because
otherwise whatever FFmpeg said about the failure scrolled past minutes ago.

`side_data_list` is a list, and the "Display Matrix" entry — the one carrying
`rotation` — is not reliably first in it. Modern phone footage (iPhone HDR,
recent Samsung) files Ambient Viewing Environment, Content Light Level and
Mastering Display ahead of it, so reading index 0 found rotation 0 for exactly
the portrait clips that needed it and stored them landscape; `resolveFit` then
saw a landscape shot and skipped the film's fit policy. `probe()` searches for
the entry that has the field, falls back to `tags.rotate` for older files, and
normalises onto 0/90/180/270 — the two spellings disagree in sign, the display
matrix angle being counter-clockwise and `tags.rotate` clockwise.
`src/backfill-dimensions.ts` re-probes the rows written before that fix.
