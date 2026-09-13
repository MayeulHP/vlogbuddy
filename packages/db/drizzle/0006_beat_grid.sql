ALTER TABLE "music_items" ADD COLUMN IF NOT EXISTS "bpm" double precision;--> statement-breakpoint
ALTER TABLE "music_items" ADD COLUMN IF NOT EXISTS "beat_offset_seconds" double precision;--> statement-breakpoint
ALTER TABLE "music_items" ADD COLUMN IF NOT EXISTS "beat_times" jsonb;--> statement-breakpoint
ALTER TABLE "music_items" ADD COLUMN IF NOT EXISTS "beat_confidence" double precision;--> statement-breakpoint
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "bpm" double precision;--> statement-breakpoint
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "beat_offset_seconds" double precision;--> statement-breakpoint
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "beat_times" jsonb;--> statement-breakpoint
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "beat_confidence" double precision;
