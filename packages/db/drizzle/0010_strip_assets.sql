-- What the strip needs to be legible.
--
-- A filmstrip sprite per video (frames + the interval between them, so the
-- editor can map pixels to time without asking the worker) and a 0..1 peak
-- envelope for anything with audio. All nullable: everything already in the
-- pile has neither, and the strip falls back to the single thumbnail and the
-- flat block it drew before. `backfill-strip-assets.ts` fills them in.
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "filmstrip_key" text;
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "filmstrip_frames" integer;
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "filmstrip_interval_seconds" double precision;
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "peaks" jsonb;
ALTER TABLE "music_items" ADD COLUMN IF NOT EXISTS "peaks" jsonb;
