ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "pruned_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"render_height" integer DEFAULT 1080 NOT NULL,
	"render_fps" integer DEFAULT 30 NOT NULL,
	"render_crf" integer DEFAULT 20 NOT NULL,
	"render_preset" text DEFAULT 'veryfast' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
