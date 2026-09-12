DO $$ BEGIN
 CREATE TYPE "cut_override" AS ENUM('include', 'exclude');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "cut_override" "cut_override";--> statement-breakpoint
ALTER TABLE "music_items" ADD COLUMN IF NOT EXISTS "cut_override" "cut_override";
