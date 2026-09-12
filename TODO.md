# VlogBuddy — Backlog

## v2 — Immich integration (explicitly deferred from v1)

The big one. Let friends pull media straight out of their own Immich instances
instead of re-uploading files they already have on a server.

- [ ] Per-member Immich connection: instance base URL + API key, stored encrypted.
- [ ] Browse the connected instance: timeline view, albums, search by date range.
- [ ] **Import an entire album in one action** — pick an album, pull every asset
      into the vlog dump, preserving each asset's original capture time so the
      chronological ordering in the dump view stays correct.
- [ ] Selective import: multi-select individual assets.
- [ ] Server-side transfer (worker pulls from Immich → MinIO) so large albums
      don't round-trip through the browser.
- [ ] Deduplicate against already-imported assets (Immich asset id / checksum).
- [ ] Import live photos / motion photos sensibly (still + video pair).
- [ ] Optional: OAuth instead of API keys if Immich exposes it.
- [ ] Optional: push the finished vlog back into Immich as an asset.

## v2 — Full multi-track video editor

v1 ships an intentionally small "assemble + trim/reorder" editor. v2 grows it
into a real one.

- [ ] Multiple video and audio tracks with layering.
- [ ] Transitions library beyond cut/crossfade (wipe, dip to black, slide).
- [ ] Effects: brightness/contrast/saturation, blur, speed ramps.
- [ ] Keyframe animation for any property.
- [ ] Frame-accurate scrubbing, ripple delete, snapping, zoom.
- [ ] **Conflict-free co-editing** — replace the v1 last-writer-wins op
      broadcast with a CRDT (Yjs + Hocuspocus) so simultaneous edits merge
      cleanly. Persist the Yjs doc alongside the timeline JSON.
- [ ] Per-clip audio ducking under the music bed; auto-duck on speech.
- [ ] Undo/redo that behaves correctly with multiple concurrent editors.
- [ ] Consider adopting/forking an existing OSS editor core (OpenReel,
      OpenVideo engine) rather than growing ours indefinitely.

## v2 — Music & licensing

- [ ] Native Spotify / Deezer playback integration for preview (SDK-based).
- [ ] Licensing-safe audio: bundled royalty-free library, or upload-your-own as
      the blessed path for exports.
- [ ] Beat detection to auto-cut clips on the beat.
- [ ] Replace the yt-dlp path with something that isn't ToS-hostile.

## v2 — Capture & uploads

- [ ] PWA with direct camera capture, upload straight into a vlog.
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
- [ ] Auto-generated subtitles (whisper.cpp in the worker).
- [ ] "Best of" auto-cut: generate a first draft purely from vote scores.
- [ ] Multi-language UI.
- [ ] Backup/restore command for the whole instance.
