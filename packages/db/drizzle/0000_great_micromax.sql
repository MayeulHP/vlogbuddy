CREATE TYPE "public"."media_kind" AS ENUM('photo', 'video', 'audio');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('creator', 'friend');--> statement-breakpoint
CREATE TYPE "public"."music_source" AS ENUM('youtube', 'spotify', 'deezer');--> statement-breakpoint
CREATE TYPE "public"."processing_status" AS ENUM('pending', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."render_status" AS ENUM('queued', 'rendering', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."target_type" AS ENUM('media', 'music');--> statement-breakpoint
CREATE TYPE "public"."vlog_state" AS ENUM('open', 'curate', 'edit', 'export', 'published');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "media_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vlog_id" uuid NOT NULL,
	"uploader_id" uuid,
	"kind" "media_kind" NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer,
	"storage_key" text NOT NULL,
	"proxy_key" text,
	"thumbnail_key" text,
	"width" integer,
	"height" integer,
	"duration_seconds" double precision,
	"captured_at" timestamp with time zone,
	"upload_index" integer DEFAULT 0 NOT NULL,
	"status" "processing_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vlog_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"session_token" text NOT NULL,
	"role" "member_role" DEFAULT 'friend' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_session_token_unique" UNIQUE("session_token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "music_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vlog_id" uuid NOT NULL,
	"added_by_id" uuid,
	"source" "music_source" NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"embed_url" text NOT NULL,
	"title" text,
	"artist" text,
	"thumbnail_url" text,
	"timeline_position" real DEFAULT 0.5 NOT NULL,
	"extracted_audio_key" text,
	"audio_duration_seconds" double precision,
	"status" "processing_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "music_items_vlog_external_unique" UNIQUE("vlog_id","source","external_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vlog_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reactions" (
	"vlog_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"target_type" "target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"score" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reactions_member_id_target_type_target_id_pk" PRIMARY KEY("member_id","target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "render_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vlog_id" uuid NOT NULL,
	"requested_by_id" uuid,
	"status" "render_status" DEFAULT 'queued' NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"message" text,
	"output_key" text,
	"duration_seconds" double precision,
	"size_bytes" integer,
	"error" text,
	"timeline_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "selections" (
	"vlog_id" uuid NOT NULL,
	"target_type" "target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"selected_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "selections_vlog_id_target_type_target_id_pk" PRIMARY KEY("vlog_id","target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "timeline_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vlog_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"doc" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "timelines" (
	"vlog_id" uuid PRIMARY KEY NOT NULL,
	"doc" jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vlogs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"share_slug" text NOT NULL,
	"passcode_hash" text,
	"state" "vlog_state" DEFAULT 'open' NOT NULL,
	"reaction_tiers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vlogs_share_slug_unique" UNIQUE("share_slug")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "media_items" ADD CONSTRAINT "media_items_vlog_id_vlogs_id_fk" FOREIGN KEY ("vlog_id") REFERENCES "public"."vlogs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "media_items" ADD CONSTRAINT "media_items_uploader_id_members_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "members" ADD CONSTRAINT "members_vlog_id_vlogs_id_fk" FOREIGN KEY ("vlog_id") REFERENCES "public"."vlogs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "music_items" ADD CONSTRAINT "music_items_vlog_id_vlogs_id_fk" FOREIGN KEY ("vlog_id") REFERENCES "public"."vlogs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "music_items" ADD CONSTRAINT "music_items_added_by_id_members_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_uploads" ADD CONSTRAINT "pending_uploads_vlog_id_vlogs_id_fk" FOREIGN KEY ("vlog_id") REFERENCES "public"."vlogs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_uploads" ADD CONSTRAINT "pending_uploads_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reactions" ADD CONSTRAINT "reactions_vlog_id_vlogs_id_fk" FOREIGN KEY ("vlog_id") REFERENCES "public"."vlogs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reactions" ADD CONSTRAINT "reactions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_vlog_id_vlogs_id_fk" FOREIGN KEY ("vlog_id") REFERENCES "public"."vlogs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_requested_by_id_members_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "selections" ADD CONSTRAINT "selections_vlog_id_vlogs_id_fk" FOREIGN KEY ("vlog_id") REFERENCES "public"."vlogs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "selections" ADD CONSTRAINT "selections_selected_by_id_members_id_fk" FOREIGN KEY ("selected_by_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "timeline_versions" ADD CONSTRAINT "timeline_versions_vlog_id_vlogs_id_fk" FOREIGN KEY ("vlog_id") REFERENCES "public"."vlogs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "timelines" ADD CONSTRAINT "timelines_vlog_id_vlogs_id_fk" FOREIGN KEY ("vlog_id") REFERENCES "public"."vlogs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "timelines" ADD CONSTRAINT "timelines_updated_by_id_members_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_items_vlog_id_idx" ON "media_items" USING btree ("vlog_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_items_chrono_idx" ON "media_items" USING btree ("vlog_id","captured_at","upload_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_items_status_idx" ON "media_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "members_vlog_id_idx" ON "members" USING btree ("vlog_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "members_session_token_idx" ON "members" USING btree ("session_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "music_items_vlog_id_idx" ON "music_items" USING btree ("vlog_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reactions_target_idx" ON "reactions" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reactions_vlog_idx" ON "reactions" USING btree ("vlog_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "render_jobs_vlog_idx" ON "render_jobs" USING btree ("vlog_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "selections_order_idx" ON "selections" USING btree ("vlog_id","order_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timeline_versions_vlog_rev_idx" ON "timeline_versions" USING btree ("vlog_id","revision");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vlogs_share_slug_idx" ON "vlogs" USING btree ("share_slug");