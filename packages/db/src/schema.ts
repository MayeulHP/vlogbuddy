import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import type { ReactionTier } from "@vlogbuddy/shared";
import type { TimelineDoc } from "@vlogbuddy/shared";

export const vlogStateEnum = pgEnum("vlog_state", [
  "open",
  "curate",
  "edit",
  "export",
  "published",
]);
export const mediaKindEnum = pgEnum("media_kind", ["photo", "video", "audio"]);
export const musicSourceEnum = pgEnum("music_source", ["youtube", "spotify", "deezer"]);
export const processingStatusEnum = pgEnum("processing_status", [
  "pending",
  "processing",
  "ready",
  "failed",
]);
export const renderStatusEnum = pgEnum("render_status", [
  "queued",
  "rendering",
  "done",
  "failed",
]);
export const memberRoleEnum = pgEnum("member_role", ["creator", "friend"]);
export const targetTypeEnum = pgEnum("target_type", ["media", "music"]);

// --- vlogs ------------------------------------------------------------------

export const vlogs = pgTable(
  "vlogs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    description: text("description"),
    /** Public share slug — this is the link friends receive. */
    shareSlug: text("share_slug").notNull().unique(),
    passcodeHash: text("passcode_hash"),
    state: vlogStateEnum("state").notNull().default("open"),
    /** Customisable three-tier emoji scale. */
    reactionTiers: jsonb("reaction_tiers").$type<ReactionTier[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugIdx: index("vlogs_share_slug_idx").on(t.shareSlug),
  }),
);

// --- members ----------------------------------------------------------------

export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vlogId: uuid("vlog_id")
      .notNull()
      .references(() => vlogs.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    /** Opaque token stored in a signed cookie; identifies a returning friend. */
    sessionToken: text("session_token").notNull().unique(),
    role: memberRoleEnum("role").notNull().default("friend"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    vlogIdx: index("members_vlog_id_idx").on(t.vlogId),
    tokenIdx: index("members_session_token_idx").on(t.sessionToken),
  }),
);

// --- media ------------------------------------------------------------------

export const mediaItems = pgTable(
  "media_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vlogId: uuid("vlog_id")
      .notNull()
      .references(() => vlogs.id, { onDelete: "cascade" }),
    uploaderId: uuid("uploader_id").references(() => members.id, { onDelete: "set null" }),
    kind: mediaKindEnum("kind").notNull(),
    originalFilename: text("original_filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes"),

    /** Object storage keys. */
    storageKey: text("storage_key").notNull(),
    proxyKey: text("proxy_key"),
    thumbnailKey: text("thumbnail_key"),

    width: integer("width"),
    height: integer("height"),
    durationSeconds: doublePrecision("duration_seconds"),
    /** From EXIF/container metadata — drives chronological ordering. */
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    /** Fallback ordering when there's no capture time. */
    uploadIndex: integer("upload_index").notNull().default(0),

    status: processingStatusEnum("status").notNull().default("pending"),
    error: text("error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    vlogIdx: index("media_items_vlog_id_idx").on(t.vlogId),
    chronoIdx: index("media_items_chrono_idx").on(t.vlogId, t.capturedAt, t.uploadIndex),
    statusIdx: index("media_items_status_idx").on(t.status),
  }),
);

// --- music ------------------------------------------------------------------

export const musicItems = pgTable(
  "music_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vlogId: uuid("vlog_id")
      .notNull()
      .references(() => vlogs.id, { onDelete: "cascade" }),
    addedById: uuid("added_by_id").references(() => members.id, { onDelete: "set null" }),
    source: musicSourceEnum("source").notNull(),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    embedUrl: text("embed_url").notNull(),

    title: text("title"),
    artist: text("artist"),
    thumbnailUrl: text("thumbnail_url"),

    /** 0..1 placement along the rough timeline in the dump view. */
    timelinePosition: real("timeline_position").notNull().default(0.5),

    /** Populated by yt-dlp when ENABLE_YT_AUDIO is on. */
    extractedAudioKey: text("extracted_audio_key"),
    audioDurationSeconds: doublePrecision("audio_duration_seconds"),
    status: processingStatusEnum("status").notNull().default("pending"),
    error: text("error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    vlogIdx: index("music_items_vlog_id_idx").on(t.vlogId),
    uniquePerVlog: unique("music_items_vlog_external_unique").on(t.vlogId, t.source, t.externalId),
  }),
);

// --- reactions --------------------------------------------------------------

/** One reaction per member per item; changing it overwrites the previous score. */
export const reactions = pgTable(
  "reactions",
  {
    vlogId: uuid("vlog_id")
      .notNull()
      .references(() => vlogs.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    targetType: targetTypeEnum("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    score: smallint("score").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.memberId, t.targetType, t.targetId] }),
    targetIdx: index("reactions_target_idx").on(t.targetType, t.targetId),
    vlogIdx: index("reactions_vlog_idx").on(t.vlogId),
  }),
);

// --- selections -------------------------------------------------------------

/** Finalists chosen during the curate phase, with their running order. */
export const selections = pgTable(
  "selections",
  {
    vlogId: uuid("vlog_id")
      .notNull()
      .references(() => vlogs.id, { onDelete: "cascade" }),
    targetType: targetTypeEnum("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    orderIndex: integer("order_index").notNull().default(0),
    selectedById: uuid("selected_by_id").references(() => members.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.vlogId, t.targetType, t.targetId] }),
    orderIdx: index("selections_order_idx").on(t.vlogId, t.orderIndex),
  }),
);

// --- timelines --------------------------------------------------------------

/** One timeline document per vlog. `revision` guards concurrent edits. */
export const timelines = pgTable("timelines", {
  vlogId: uuid("vlog_id")
    .primaryKey()
    .references(() => vlogs.id, { onDelete: "cascade" }),
  doc: jsonb("doc").$type<TimelineDoc>().notNull(),
  revision: integer("revision").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedById: uuid("updated_by_id").references(() => members.id, { onDelete: "set null" }),
});

/** Bounded history so the editor can undo and we can recover from mistakes. */
export const timelineVersions = pgTable(
  "timeline_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vlogId: uuid("vlog_id")
      .notNull()
      .references(() => vlogs.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    doc: jsonb("doc").$type<TimelineDoc>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    vlogRevIdx: index("timeline_versions_vlog_rev_idx").on(t.vlogId, t.revision),
  }),
);

// --- renders ----------------------------------------------------------------

export const renderJobs = pgTable(
  "render_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vlogId: uuid("vlog_id")
      .notNull()
      .references(() => vlogs.id, { onDelete: "cascade" }),
    requestedById: uuid("requested_by_id").references(() => members.id, { onDelete: "set null" }),
    status: renderStatusEnum("status").notNull().default("queued"),
    progress: real("progress").notNull().default(0),
    message: text("message"),
    outputKey: text("output_key"),
    durationSeconds: doublePrecision("duration_seconds"),
    sizeBytes: integer("size_bytes"),
    error: text("error"),
    /** Snapshot of the timeline at submit time, so later edits don't confuse it. */
    timelineSnapshot: jsonb("timeline_snapshot").$type<TimelineDoc>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    vlogIdx: index("render_jobs_vlog_idx").on(t.vlogId, t.createdAt),
  }),
);

// --- pending uploads --------------------------------------------------------

/** Tracks presigned uploads between issuing the URL and the client confirming. */
export const pendingUploads = pgTable("pending_uploads", {
  id: uuid("id").primaryKey().defaultRandom(),
  vlogId: uuid("vlog_id")
    .notNull()
    .references(() => vlogs.id, { onDelete: "cascade" }),
  memberId: uuid("member_id")
    .notNull()
    .references(() => members.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull(),
  originalFilename: text("original_filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true })
    .notNull()
    .default(sql`now() + interval '24 hours'`),
});

// --- relations --------------------------------------------------------------

export const vlogsRelations = relations(vlogs, ({ many, one }) => ({
  members: many(members),
  mediaItems: many(mediaItems),
  musicItems: many(musicItems),
  selections: many(selections),
  renderJobs: many(renderJobs),
  timeline: one(timelines, { fields: [vlogs.id], references: [timelines.vlogId] }),
}));

export const membersRelations = relations(members, ({ one, many }) => ({
  vlog: one(vlogs, { fields: [members.vlogId], references: [vlogs.id] }),
  mediaItems: many(mediaItems),
  reactions: many(reactions),
}));

export const mediaItemsRelations = relations(mediaItems, ({ one }) => ({
  vlog: one(vlogs, { fields: [mediaItems.vlogId], references: [vlogs.id] }),
  uploader: one(members, { fields: [mediaItems.uploaderId], references: [members.id] }),
}));

export const musicItemsRelations = relations(musicItems, ({ one }) => ({
  vlog: one(vlogs, { fields: [musicItems.vlogId], references: [vlogs.id] }),
  addedBy: one(members, { fields: [musicItems.addedById], references: [members.id] }),
}));

export const timelinesRelations = relations(timelines, ({ one }) => ({
  vlog: one(vlogs, { fields: [timelines.vlogId], references: [vlogs.id] }),
}));

export const renderJobsRelations = relations(renderJobs, ({ one }) => ({
  vlog: one(vlogs, { fields: [renderJobs.vlogId], references: [vlogs.id] }),
}));

// --- inferred types ---------------------------------------------------------

export type Vlog = typeof vlogs.$inferSelect;
export type NewVlog = typeof vlogs.$inferInsert;
export type Member = typeof members.$inferSelect;
export type NewMember = typeof members.$inferInsert;
export type MediaItem = typeof mediaItems.$inferSelect;
export type NewMediaItem = typeof mediaItems.$inferInsert;
export type MusicItem = typeof musicItems.$inferSelect;
export type NewMusicItem = typeof musicItems.$inferInsert;
export type Reaction = typeof reactions.$inferSelect;
export type Selection = typeof selections.$inferSelect;
export type Timeline = typeof timelines.$inferSelect;
export type RenderJob = typeof renderJobs.$inferSelect;
export type PendingUpload = typeof pendingUploads.$inferSelect;
