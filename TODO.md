# VlogBuddy — Backlog

## Immich integration — shipped

Friends pull media straight out of their own Immich instances instead of
re-uploading files that already live on a server, and can pull the whole vlog
back down into their own library afterwards.

- [x] Per-member Immich connection: instance base URL + API key, stored encrypted.
- [x] Browse the connected instance by album.
- [x] **Import an entire album in one action**, preserving each asset's original
      capture time so the chronological ordering holds.
- [x] Selective import: multi-select individual assets.
- [x] Server-side transfer (worker pulls from Immich → MinIO) so large albums
      don't round-trip through the browser.
- [x] Deduplicate against already-imported assets by SHA-1 checksum.
- [x] **Push the whole pile into a member's own Immich**, as an album, skipping
      what they already have — so everyone ends up with the raw media, which
      Immich can't do between two instances on its own.

Still open:

- [ ] Browse by timeline and date range, not only by album.
- [ ] Import live photos / motion photos sensibly (still + video pair).
- [ ] Optional: OAuth instead of API keys if Immich exposes it.
- [x] Push the *finished render* back into Immich as an asset, not just the
      source media. Folded into the same export: the film goes up after the
      originals, deduped by content hash like everything else, into the same
      album.
- [ ] Resume a part-finished transfer automatically instead of on the next press.

## Dawarich integration — where the trip happened

[Dawarich](https://dawarich.app) is the self-hosted location-history tracker, the
Google Timeline replacement. It knows where its owner stood at every minute of the
holiday; VlogBuddy knows which minute each shot was taken. The join is
`media_items.capturedAt`, which the pile already stores and the Immich import
already preserves — deliberately *not* EXIF, because phone video and re-encoded
photos usually arrive with their coordinates stripped and the location history has
them regardless.

Same shape as Immich, and for the same reason: per-member connection (instance URL
+ API key sealed with `@vlogbuddy/shared/secrets`), a plain-`fetch` client in
`packages/shared/src/dawarich.ts` with no Node imports, the fetching itself a
worker job. Auth is `Authorization: Bearer <key>` or `?api_key=`. The endpoints
that matter: `GET /api/v1/points` (`start_at`/`end_at` as Unix timestamps,
`slim=true` for lat/lon/time only), `/api/v1/visits` (the stops it has already
decided were places, reverse-geocoded), `/api/v1/areas` (named geofences — home,
the hotel), `/api/v1/tracks/:id/points` (the line between two stops) and
`/api/v1/stats`.

- [ ] Per-member connection, stored encrypted, with a date range to pull.
- [ ] **Stamp each item with a place from the timeline rather than from EXIF**:
      nearest point to `capturedAt` inside a tolerance, `null` beyond it. This
      fills the `latitude`/`longitude` migration the auto-cut wants anyway, so
      EXIF and Dawarich become two sources for one pair of columns.
- [ ] Scene splits from `visits` instead of from a distance threshold we invented.
      Dawarich has already merged the wandering around a place into one stop, and
      its idea of "we arrived somewhere" is better than a 500m radius.
- [ ] Scene names that cost nobody their privacy. Dawarich reverse-geocodes
      through its own Photon/Nominatim, so the name arrives attached to the visit
      and the "an external geocoder is a privacy question for a self-hosted app"
      objection goes away for anyone already running one.
- [ ] **Route interstitials** — the track between two scenes drawn as a map and
      rendered as a clip, so the 200km nobody filmed still reads on screen. Wants
      a tile source, which is the privacy question again; a coastline-only vector
      draw needs no tiles at all.
- [ ] An end card from `/api/v1/stats` and `/api/v1/countries`: distance covered,
      places slept, borders crossed. The one piece of the film that isn't footage.
- [ ] Filter the pile by place in Gather — "the afternoon in Lisbon" — once items
      carry coordinates. Same lane as the unshipped "browse Immich by date range".
- [ ] Ask Dawarich's `/api/v1/photos` which Immich assets it has already located,
      and offer *those* as an import: pick a place on a map, get the media.

## v2 — Full multi-track video editor

v1 ships an intentionally small "assemble + trim/reorder" editor. v2 grows it
into a real one.

- [x] Multiple video and audio tracks with layering. Picture layers (`doc.layers`)
      composited over the base track at absolute times, and an audio stack
      (`doc.audio`) mixed under it — one lane per track on a shared clock in the
      bench. Snapping and zoom came along with it.
- [x] **Transitions library** — eleven, from `xfade`: dissolve, dip to
      black/white, wipes, pushes, iris open/close, pixelate. A curated subset
      with editors' names, not all thirty-odd FFmpeg offers. `XFADE_FOR` in
      `constants.ts` is the only place a filter name appears; everything else
      asks `overlapsPrevious()`.

### Cheap — already sitting in FFmpeg, unused

Each of these is another entry in the per-clip chain `buildFilterGraph`
already builds, plus a control in the inspector. None needs a new engine.

- [x] Colour: brightness/contrast/saturation (`eq`), hue (`hue`), blur
      (`gblur`). One op field each, each compared against its neutral so an
      untouched clip compiles to the chain it always did.
- [x] Speed ramps (`setpts` + `atempo`). `clipDuration` divides by the new
      `speed` field and `clipSourceSpan` is what the trim window and FFmpeg
      measure — the auto-cut budgets in screen seconds, so a re-cut of a 2×
      shot takes twice as much footage to fill the same slot.
- [x] Ducking, the right way round. The flat `× 0.35` pulled the *shots* down
      under the music; `sidechaincompress` now pulls the **music down under the
      shots**, so a voice doesn't have to compete with the score. Depth lives
      on the track being ducked (`AudioTrack.duck`, default 0.6) because it is
      a property of the music, not of each shot; `Clip.duckMusic` is the
      per-shot opt-out for the motorbike that shouldn't kill the track. No new
      op — `clip.update`/`audio.update` already carry `.partial()` schemas, so
      both fields reached all three reducer sites for free.

### Model work — a new engine wouldn't help, a new model would

- [ ] Keyframe animation for any property. This is the one genuinely
      architectural item: it wants an animation-curve type on `TimelineOp` and
      a way to compile curves into FFmpeg expressions. Everything else on this
      page is a filter string.

### Not render-engine problems at all

- [ ] Frame-accurate scrubbing and ripple delete. (Snapping and zoom shipped
      with multi-track.)
- [ ] **Conflict-free co-editing** — replace the v1 last-writer-wins op
      broadcast with a CRDT (Yjs + Hocuspocus) so simultaneous edits merge
      cleanly. Persist the Yjs doc alongside the timeline JSON.
- [ ] Undo/redo that behaves correctly with multiple concurrent editors.

### On adopting an OSS editor core — researched, declined

The old note here suggested forking "OpenReel or OpenVideo engine". Neither is
a candidate: OpenReel is a browser-based CapCut alternative that renders
*client-side* (the inverse of this app's whole premise, which is that media
never touches the browser), and no project called "OpenVideo engine" appears
to exist.

What was actually evaluated:

- **MLT / `melt`** (github.com/mltframework/mlt) — the only real editor core on
  offer, and what Kdenlive and Shotcut are built on. Wraps FFmpeg rather than
  competing with it; has timeline, transitions, effects, keyframes and an XML
  project format. The credible fallback, at the cost of a C runtime in the
  worker image and a `TimelineDoc` → MLT XML compiler that is the same shape as
  the compiler we already have.
- **Remotion / Revideo / Motion Canvas** — programmatic-video frameworks, not
  editor cores. Remotion renders by screenshotting headless Chromium frame by
  frame; wrong trade for a self-hosted box assembling phone footage.
- **editly** — declarative JSON → FFmpeg, i.e. roughly what `buildFilterGraph`
  already is, with a narrower vocabulary.
- **OpenTimelineIO** — not an engine but the ASWF's JSON interchange format.
  Interesting later as an *exporter*, so a vlog can be opened in Resolve or
  Premiere. Filed under Nice to have.

Declined because the engine in question is ~350 lines (`buildFilterGraph`);
the rest of what looks like "our core" is `TimelineDoc`, the cut engine and the
auto-cut, none of which any third party has an opinion about. Most of what
motivated the item turned out to be free in FFmpeg (see Cheap, above), and the
items a swap genuinely wouldn't touch — scrubbing, co-editing, undo — are where
the real pain is.

**Revisit if** keyframes and real compositing become the priority. That's the
trigger; MLT is the answer when it fires.

- [ ] **The preview and the render are two implementations of one document.**
      `preview-player.tsx` approximates in HTML5 what `buildFilterGraph` does
      in FFmpeg — every feature gets built twice and they can silently
      disagree. The honest fix is a WebCodecs preview that decodes and
      composites the way the renderer does. This is the structural weakness
      worth money, not the engine.

      Transitions were the standing example and are now closed: the preview
      plays all eleven as two stacked DOM layers (`TRANSITION_EFFECT`, the
      fourth map). A plain dissolve is exact — an incoming layer at opacity p
      over an opaque outgoing one is the sum `xfade=fade` computes — and wipes,
      pushes and irises are right in shape, direction and timing. `pixelize` is
      the honest failure: CSS cannot pixelate, so it plays as a dissolve
      blurring to a peak at the midpoint. Same beat, different look.

      The lesson the gap actually taught, though, was about *timing*, not
      looks. The renderer capped a fade against the incoming clip and the bench
      capped it only against the film so far, so any shot briefer than its own
      dissolve rendered longer than the timeline claimed — by 0.96s on a
      three-clip test. Fixed by making there be one answer rather than two
      agreeing ones: `transitionOverlap()` in `timeline.ts`, which the bench,
      the preview and `render.ts` all now ask. Guarded by the
      `dissolve-longer-than-its-shot` case in `render-check.ts`, which measures
      the rendered file against `timelineDuration`.

      Ducking closed the audio half of the same gap, and shows where the
      approach runs out. The preview multiplies each track by `1 - duck × depth`
      over a 150 ms slew while an audible shot is on screen; the render follows
      the *envelope* of that shot's sound with `sidechaincompress`. Depth right,
      breathing absent — a rectangle where the export has a waveform. Closing
      that properly means WebAudio, which is the same argument as WebCodecs for
      picture: worth it once, not per feature.

      **The moral for anything built here twice:** a shared helper, not two
      implementations that happen to match today.

## The auto-cut — shipped

The default timeline is an edit rather than a concatenation: screen time
budgeted from the crew's marks, scenes detected from capture gaps, hard cuts
inside a scene and a dissolve between them.

- [x] Per-shot screen-time budget from rank tier and a pace preset.
- [x] Trim window inside a long clip instead of the whole recording.
- [x] Scenes from capture-time gaps and day boundaries; scene bands on the
      rough cut; optional scene names burned over the opening shot.
- [x] `auto` provenance flags, so a re-cut never walks over hand-made trims.

Still open:

- [x] Split scenes by **place**, not only time. `detectScenes` breaks when a shot
      is more than `SCENE_MOVE_METRES` (500m) from the scene's **anchor** — the
      first located shot in it.

      The anchor is the whole design. Comparing each shot to the one before it
      fails in both directions at once: a walk is a trickle of 80m steps that
      never reaches the threshold however far you go, and on the one step that
      does trip it the comparison point moves with you and the rest of the
      afternoon shatters. Anchoring asks what a scene is actually about — *are
      we still roughly where this started?* — so 1.9km of walking becomes four
      scenes rather than none or twenty.

      Items with no fix never break a scene and never move the anchor; it is
      carried across them, so one photo with stripped EXIF can't split a room in
      two. `(0,0)` is read as *no* fix, because null island is what a camera
      writes when GPS never locked, and taking it literally would put a shot
      5,000km from the pile. 500m is an order of magnitude above the drift on a
      stationary phone, so jitter can't manufacture a break.

      The haversine result feeds one comparison and is then dropped — never
      stored, because a float that fails to round-trip through jsonb would churn
      a timeline revision on every vote forever.
- [ ] Reverse-geocode a place name. Deliberately still unshipped: scenes now
      break *where* the crew moved but are still named after *when*. An external
      service is a privacy question for a self-hosted app; a bundled offline city
      list gives "nearest town", which is coarse but honest. A connected Dawarich
      answers it outright, having already geocoded the same coordinates on its
      own terms. Note scene names are now storable and renameable, so this only
      has to produce a better *first guess*.
- [x] **Renameable scenes.** `doc.scenes` is stored, not re-derived; a clip
      points at one by `sceneId`, never by index. The hard part was identity
      across a re-cut, and the rule that works is *shot membership* — the
      `reconcileClips` rule widened from one item to a set — so a scene that
      splits leaves its name on the bigger half and one that merges takes the
      name that was on more of the footage. Ids derive from a member's
      `mediaItemId` rather than randomly, because a fresh id each pass would
      churn a revision on every vote forever. A typed name is protected by the
      same `auto` provenance as a hand-trimmed clip, and `director.recut` is the
      only thing that takes it back.

      One case worth keeping: a document whose clips all carry `auto: []` — a
      hand-cut or pre-auto-cut film — gets **no scenes at all**, rather than the
      scene pass sneaking the director back into a film that told it to keep
      away.
- [x] Scene markers on the bench ruler: a Scenes lane above the ruler, a tick at
      each scene's first clip (tape-coloured on a day break), the glyph of the
      dissolve that break caused, and the name as a button that turns into a
      text box. Auto names read grey, hand-set names read tape.
- [x] Ken Burns on stills (`zoompan` in `buildFilterGraph`) so a photo can hold
      longer than four seconds without going dead. A push or a pull, centred —
      a pan would travel over the letterbox bars, which needs a "fill the
      frame" decision the timeline can't express yet. The auto-cut gives every
      still a move (`auto: "motion"`), and the cap rises from 4s to 7s for a
      photo that's moving.
- [ ] Cold open: lift the best-voted moment to the front as a teaser. Needs a
      second clip pointing at the same media, and `mergeIntoOrder` has to learn
      to leave it alone.
- [ ] Let the bed's length steer the pace, so the film lands with the track.

## v2 — Music & licensing

- [ ] Native Spotify / Deezer playback integration for preview (SDK-based).
- [x] Beat detection to auto-cut clips on the beat.

## v2 — Capture & uploads

- [x] PWA — manifest, service worker, icons, offline page.
- [ ] Resumable / background uploads (multipart, retry on flaky mobile data).
- [ ] Client-side pre-compression option for huge phone videos.
- [x] Real capture metadata out of photo files (`exifr` in the worker, plus
      `com.apple.quicktime.location.ISO6709` for iPhone video). Photos used to
      fall back to the browser's `File.lastModified`, which is usually the *copy*
      date — quietly wrong, and scene detection runs on capture gaps, so the
      auto-cut was pacing a film against the wrong clock. Precedence: an
      Immich-sourced date wins outright (its `localDateTime` is EXIF-derived
      *and* timezone-resolved, which we can't reproduce), then photo EXIF, then
      the container tag, then the client's guess.

      Two `exifr` bugs worth knowing about, both worked around: its own file
      reader is broken on Node ≥ 20 (`FileHandle.stat(path)` rejects the string),
      so we read the file and hand it a Buffer; and it mis-reads HEIC whose
      `iloc` box carries a `base_offset`, which is how libheif writes them.
- [x] Backfill script for photo proxies
      (`pnpm --filter @vlogbuddy/worker backfill-photo-proxies`, dry run by
      default). Re-enqueues `process-media` over photos that predate a change.
      It nominates a deliberately coarse superset in SQL and lets the job decide
      — the "needs a proxy" rule is never restated outside `process-media.ts`,
      so the two can't drift. Jobs go out at `priority: -100` so a photo somebody
      uploads a minute later still goes first. **Also the way to fill in
      `hasAudio` and the new EXIF columns on existing piles.**
- [x] HEIC/HEIF conversion for Apple photos. No migration: `proxyKey` turned
      out to carry no video-specific meaning, so photos store a display JPEG
      there and every consumer's existing `proxyUrl ?? originalUrl` picks it
      up. Generated for anything a browser can't paint (HEIC/HEIF, DNG) plus
      any photo over 2560px on the long edge — a 48MP original was being
      fetched whole into an 800px preview.

      Two pre-existing bugs fell out of it. iPhones write HEIC as a grid of
      512px tiles, which ffmpeg stitches with an internal *complex*
      filtergraph, and `-vf` on such a stream is a hard error — so **tiled
      HEICs had been failing thumbnailing outright**. Now `-filter_complex`,
      which works either way. And because a tiled HEIC probes as one 512×512
      tile, a 6000×4000 photo was being recorded at 512×512; the flattened
      proxy corrects it.

      Note a version floor: HEIF still-image support landed in FFmpeg 7.0 and
      tiled-HEIF CLI support in 8.1. `node:22-alpine` currently ships 8.1.2, but
      an image built months ago has neither until it is rebuilt — and
      `render.ts` decodes the *original*, so a stale worker fails at render
      time too, not only in preview.

## v2 — Collaboration & admin

- [ ] Roles and permissions per vlog (creator / editor / voter / viewer).
- [ ] Moderation: remove items, block a member, undo someone's mass-delete.
- [ ] Comments/threads on individual items, not just emoji scores.
- [ ] Notifications (email / ntfy / webhook) when a vlog changes phase.
- [ ] Per-vlog retention policy + storage usage display, prune originals after
      publish.

## Nice to have

- [ ] Export presets per platform (vertical 9:16, square, 16:9).
- [ ] Export the timeline as OpenTimelineIO, so a finished vlog can be opened
      in Resolve or Premiere for a real grade.
- [ ] Auto-generated subtitles (whisper.cpp in the worker).
- [ ] Multi-language UI.
- [ ] Backup/restore command for the whole instance.
