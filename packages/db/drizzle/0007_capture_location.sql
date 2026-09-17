ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "latitude" double precision;--> statement-breakpoint
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "longitude" double precision;--> statement-breakpoint
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "has_audio" boolean;
