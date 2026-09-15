DO $$ BEGIN
 CREATE TYPE "video_format" AS ENUM('landscape', 'portrait', 'square');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "vlogs" ADD COLUMN IF NOT EXISTS "format" "video_format" DEFAULT 'landscape' NOT NULL;
