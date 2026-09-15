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

## Film page — UX review (2026-09-13)

Two bugs that undermine the editor:

- [x] **Reorders and lifts on the Film page don't survive the next sync.** Strip
      drag, Earlier/Later and "Lift this shot out" are document-only ops over the
      socket; `syncCut` rebuilds the base track from `selections` and
      `cutOverride`, and nothing in the editor calls `reorderCutAction` or
      `setCutOverrideAction`. Any vote, upload, cut-line drag — or the render
      itself — puts the shot back. Route them through the cut actions.
- [x] **The probe misses rotation on modern phone files.** `probe()` reads only
      `side_data_list[0].rotation`; HDR side data comes first on iPhone/Samsung
      clips, so portrait video is stored 1920×1080 and `resolveFit` never applies
      the Blur policy. `find` the Display Matrix entry, fall back to
      `tags.rotate`, and backfill existing rows.

UX, in order:

- [x] Fixed-viewport layout: no page scroll. Preview capped ~45vh, strip sized to
      its content and scrolling internally, side column with its own scroll.
      Today the page is 1870px tall at 1440×900 and the strip is 893px of mostly void.
- [x] Drop the "Beat 05 · Cut" masthead and blurb inside the editor; running time
      and shot count move into the transport bar.
- [x] Side column: Auto-cut, format, bed choice and ducking are film settings —
      behind one "Film settings" sheet. Layers/Mix lists duplicate the lanes;
      replace with "+ Layer" / "+ Sound" buttons on the strip toolbar.
- [x] Filmstrip thumbnails (sprite sheet from the worker) and audio waveforms
      (peaks array from the worker). Open: a file with a manual rotation falls
      back to the single thumbnail; the strip isn't regenerated on rotate.
- [x] Zoom about the playhead, cmd+wheel / pinch, fit-to-width, and auto-scroll
      the strip during playback.
- [x] Transition marker on the cut line between shots, picker opens from it.
- [x] Direct manipulation in the preview: drag and corner-resize layers and titles.
- [x] Inspector hierarchy: Timing / Look / Sound / Text groups, rare controls
      collapsed, number fields beside sliders on desktop. Replace the layer
      start slider (0.05s steps across the whole film) with time fields and
      "at playhead".
- [x] Titles: expose start, duration, size and colour (already in the schema).
- [x] Small: click-to-seek on the Picture lane; one verb for delete across
      inspectors; lane labels truncate on phones. Still open: "Reel 02 · Strip"
      decorative label, and Gather's "Pull this frame?" copy.
- [x] Reaction marks: the ●/●●/●●● tally reads as a rating and is illegible at
      thumbnail size. Distinct ordered glyphs (✓ ★ ✦), tier names on the medium
      size, and a fill-plus-count instead of the 3px weight bar.
- [ ] Phone contact-sheet cards: three 34px mark cells overflow the ~88px frame
      (pre-existing). Narrower coarse floor, or tap-to-open marks on phone cards.
- [x] Vlogs created before the grease-pencil change keep legacy emoji tiers in
      `vlogs.reaction_tiers` with no way to reset them.

Features that make it a complete tool:

- [x] Undo/redo, local per client via inverse ops.
- [x] Keyboard: space, arrows to nudge, `[`/`]`, S, delete, cmd+Z, frame stepping.
      Frame step is hard-coded to 30fps — pass `renderFps` down from page.tsx.
- [x] Audition: "Play this shot" loops the trimmed window in the preview, trim
      handles scrub the picture; "Play this track" solos an audio track.
- [x] J/K/L shuttle.
- [ ] Pitch-preserving speed (`rubberband`); `atempo` shifts pitch.
- [x] Document speed/look in CLAUDE.md.
- [x] Split at the playhead (`clip.split` op). Halves share one `selections`
      row, so they can't be reordered apart or lifted separately yet — that
      needs selections keyed by clip, not media.
- [x] Add a shot from the pile directly on the strip, at the playhead.
- [ ] A real text tool, plus a film title card and end credits from the crew list.
- [ ] Multi-select on the strip for batch transitions, mute and lift.
- [x] Speed and a few colour looks.
- [ ] Collaborator selection highlights on the strip.

## Film page — menu system (2026-09-15 audit, full report in docs/film-menu-audit-2026-09-15.md)

- [x] **Toolbar owns the room's chrome.** (S) Drop "← Back to the floor" from the
      toolbar (keep it in the empty-strip state); span the row across the main
      column instead of the preview's maxWidth; left Undo/Redo/?, right
      "1:12 · 18 shots" + Film settings + Print. Hide "?" below md.
- [x] **Strip toolbar gets the verbs.** (M) Replace the Layers and Mix tabs with
      `+ Shot` / `+ Layer` / `+ Sound` buttons on the strip toolbar; each opens the
      existing picker as an anchored popover (desk) or bottom sheet (phone).
      Delete "Reel 02 · Strip". The lanes are the list — no panel duplicates them.
- [ ] **Film settings is a sheet, not a tab.** (M) Move Director + Format (+ Duck)
      behind a ⚙ "Film settings" button. Order Shape → Pace → wrong-shape policy →
      toggles → Re-cut footer. Friends see Shape but its buttons are disabled with
      "Only <creator> can change the shape". Remove the duplicated fit blurb.
- [ ] **Side column = inspector, full stop.** (M) One stable header ("Selected ·
      Shot 02 of 18"), no relabelling tab; ARIA tabs pattern only if any tab row
      survives (arrow keys, aria-controls, 12px labels, ≥40px tall). Selection no
      longer force-switches panels; the Pile picker shows its anchor ("after shot
      04 ▾") and defaults to the shot under the playhead.
- [x] **Phone editor is a fixed viewport.** (L) Preview ≤40dvh, strip fills the
      rest and scrolls horizontally only; tool row (+ Shot, + Layer, + Sound, ⚙)
      under the transport; every secondary panel is the bottom sheet the inspector
      already uses; sheet content gets a sticky footer for the Take-out/Done row.
- [x] **Cut marker you can find.** (S) 24px on desk as on touch; hard cuts at ~50%
      opacity always, 100% on hover or when an adjacent shot is selected. Inspector
      Transition section shrinks to a one-line summary that focuses the marker.
- [ ] **44px everywhere it's tapped.** (S) Transport Play 36/44; "Play this shot",
      −5s/+5s/Use all, Pile filter, Film checkboxes → `.btn`-derived classes so the
      touch media query applies; checkbox rows full-width ≥40px.
- [x] **Compact masthead on Film** (desktop; the phone masthead is still ~110px). (M) One 48px row (wordmark · title · segmented
      Trip/Film/Watch · presence · share); the slate line and display rail stay on
      Trip only. Frees ~80px, which at 1280×720 is the difference between a 444px
      and a 590px picture.
- [x] **Shortcuts on the controls.** (S) kbd hint on Split (S), Take out (⌫), Undo
      (⌘Z) buttons; keep the "?" card as the index.
- [ ] **One name per thing.** (S) "Trip" not "the floor"/"the Trip page"; "Music"
      not "Bed"; "Sound n" not "Cue/Snd"; "Muted" not "Held out"; "marks" not
      "rank"; sheet titles = inspector header; tab counts use the rail's chip.
- [ ] **Gutter labels by width.** (S) Icons at 52px, words at 74px, instead of
      `Pic / L1 / Bed`.
- [ ] Phone leftovers: collapse the masthead on Film below md; the clip
      inspector renders its own "Take this shot out" under the sheet's sticky one.
