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
- [ ] Push the *finished render* back into Immich as an asset, not just the
      source media.
- [ ] Resume a part-finished transfer automatically instead of on the next press.

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

- [ ] Colour: brightness/contrast/saturation (`eq`), hue (`hue`), blur
      (`gblur`). One op field each.
- [ ] Speed ramps (`setpts` + `atempo`). Needs a `speed` field on the clip,
      and `clipDuration` has to divide by it — the only fiddly part, because
      every timing helper derives from that one function.
- [ ] Per-clip ducking under the bed, replacing today's flat `× 0.35`
      (`render.ts`), with `sidechaincompress` for the real thing.

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
      disagree. (Transitions are already a case in point: the renderer does all
      eleven, the preview shows none of them.) The honest fix is a WebCodecs
      preview that decodes and composites the way the renderer does. This is
      the structural weakness worth money, not the engine.

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

- [ ] Split scenes by **place**, not only time. Needs `latitude`/`longitude` on
      `media_items` (a migration), `exifr` in the worker for photo EXIF, and
      `com.apple.quicktime.location.ISO6709` parsing for iPhone video. Scene
      breaks when the crew moves more than ~500m.
- [ ] Reverse-geocode a place name. An external service is a privacy question
      for a self-hosted app; a bundled offline city list gives "nearest town",
      which is coarse but honest.
- [ ] **Renameable scenes** — the derived name is only a first guess. Needs the
      scene to be a stored thing (`doc.scenes` with an id per clip) rather than
      re-derived on every read.
- [ ] Scene markers on the bench ruler, next to the dissolve each one caused.
- [ ] Ken Burns on stills (`zoompan` in `buildFilterGraph`) so a photo can hold
      longer than four seconds without going dead. Today the auto-cut caps
      photo holds precisely because it can't.
- [ ] Cold open: lift the best-voted moment to the front as a teaser. Needs a
      second clip pointing at the same media, and `mergeIntoOrder` has to learn
      to leave it alone.
- [ ] Let the bed's length steer the pace, so the film lands with the track.

## v2 — Music & licensing

- [ ] Native Spotify / Deezer playback integration for preview (SDK-based).
- [ ] Beat detection to auto-cut clips on the beat.

## v2 — Capture & uploads

- [ ] PWA
- [ ] Resumable / background uploads (multipart, retry on flaky mobile data).
- [ ] Client-side pre-compression option for huge phone videos.
- [ ] HEIC/HEIF conversion for Apple photos.

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
