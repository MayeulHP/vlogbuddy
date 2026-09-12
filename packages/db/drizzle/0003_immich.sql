DO $$ BEGIN
 CREATE TYPE "transfer_direction" AS ENUM('import', 'export');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "transfer_status" AS ENUM('queued', 'running', 'done', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "checksum_sha1" text;--> statement-breakpoint
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "immich_asset_id" text;--> statement-breakpoint
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "immich_album_name" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_items_checksum_idx" ON "media_items" ("vlog_id","checksum_sha1");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "immich_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vlog_id" uuid NOT NULL REFERENCES "vlogs"("id") ON DELETE cascade,
	"member_id" uuid NOT NULL REFERENCES "members"("id") ON DELETE cascade,
	"base_url" text NOT NULL,
	"api_key_cipher" text NOT NULL,
	"immich_user_id" text,
	"immich_user_name" text,
	"key_hint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "immich_connections_member_unique" UNIQUE("member_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "immich_connections_vlog_idx" ON "immich_connections" ("vlog_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "immich_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vlog_id" uuid NOT NULL REFERENCES "vlogs"("id") ON DELETE cascade,
	"member_id" uuid NOT NULL REFERENCES "members"("id") ON DELETE cascade,
	"direction" "transfer_direction" NOT NULL,
	"label" text NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"status" "transfer_status" DEFAULT 'queued' NOT NULL,
	"message" text,
	"error" text,
	"remote_album_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "immich_transfers_vlog_idx" ON "immich_transfers" ("vlog_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "immich_transfers_member_idx" ON "immich_transfers" ("member_id");
