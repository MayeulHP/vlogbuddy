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
import { VIDEO_FORMATS } from "@vlogbuddy/shared";
import type { CutOverride, MediaRotation, ReactionTier } from "@vlogbuddy/shared";
import type { TimelineDoc } from "@vlogbuddy/shared";

export const vlogStateEnum = pgEnum("vlog_state", ["open", "export", "published"]);
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
export const cutOverrideEnum = pgEnum("cut_override", ["include", "exclude"]);
export const transferDirectionEnum = pgEnum("transfer_direction", ["import", "export"]);
export const transferStatusEnum = pgEnum("transfer_status", [
  "queued",
  "running",
  "done",
  "failed",
]);
export const targetTypeEnum = pgEnum("target_type", ["media", "music"]);
export const videoFormatEnum = pgEnum("video_format", VIDEO_FORMATS);

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
    /**
     * Dump-view cut line. Media whose rank is at or above this value are the
     * pre-curated running order (chronological).
     */
    scoreThreshold: real("score_threshold").notNull().default(0),
    /** Customisable three-tier emoji scale. */
    reactionTiers: jsonb("reaction_tiers").$type<ReactionTier[]>(),
    /**
     * The shape of the finished film. Per vlog, not per box: the same server
     * prints a widescreen holiday film and an upright gig reel. Resolution is
     * still the operator's, on /admin. Everything written before this column
     * existed is widescreen, which is what it was rendered as.
     */
    format: videoFormatEnum("format").notNull().default("landscape"),
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

    /**
     * Degrees clockwise to turn this file before it is shown or rendered.
     *
     * FFmpeg already honours the rotation flag in a well-formed file, and the
     * width/height above are the display dimensions that come out of that. This
     * is the override for the files that lie: forwarded video with the flag
     * stripped, cameras that never wrote one. It sits on the file rather than
     * on a clip because being sideways is a fact about the file, and one fix
     * has to straighten it everywhere it appears.
     */
    rotation: integer("rotation").notNull().default(0).$type<MediaRotation>(),

    durationSeconds: doublePrecision("duration_seconds"),
    /** From EXIF/container metadata — drives chronological ordering. */
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    /** Fallback ordering when there's no capture time. */
    uploadIndex: integer("upload_index").notNull().default(0),

    status: processingStatusEnum("status").notNull().default("pending"),
    error: text("error"),

    /**
     * Manual veto of the cut line. `null` means "whatever the votes say";
     * `include`/`exclude` mean a human decided and the line no longer applies.
     */
    cutOverride: cutOverrideEnum("cut_override").$type<CutOverride>(),

    /**
     * Base64 SHA-1 of the file. Immich uses the same hash, which is what lets
     * us hand a vlog's media to somebody else's instance without re-uploading
     * the half of it they already have. Filled by the worker for browser
     * uploads, and copied straight from the asset for Immich imports.
     */
    checksumSha1: text("checksum_sha1"),

    /**
     * Audio uploads only: the same beat grid `music_items` carries, because an
     * uploaded track is just as likely to be the bed as a YouTube link is.
     * Seconds from the start of the file.
     */
    bpm: doublePrecision("bpm"),
    beatOffsetSeconds: doublePrecision("beat_offset_seconds"),
    beatTimes: jsonb("beat_times").$type<number[]>(),
    beatConfidence: doublePrecision("beat_confidence"),

    /**
     * The strip's legibility, precomputed.
     *
     * Video gets a contact sheet: `filmstripFrames` frames, one every
     * `filmstripIntervalSeconds`, tiled left to right into a single JPEG. The
     * editor paints it as a repeating background whose width is
     * frames × interval × pixels-per-second, so the shot on the bench is the
     * footage at that moment rather than one thumbnail stretched over it — and
     * it stays true while the shot is trimmed, because the offset is just the
     * in-point in pixels.
     *
     * Audio uploads get `peaks` instead: a 0..1 envelope at
     * `PEAKS_PER_SECOND` buckets a second, which is what turns a flat block in
     * the audio lane into a waveform you can line a cue up against.
     */
    filmstripKey: text("filmstrip_key"),
    filmstripFrames: integer("filmstrip_frames"),
    filmstripIntervalSeconds: doublePrecision("filmstrip_interval_seconds"),
    peaks: jsonb("peaks").$type<number[]>(),

    /** Where this came from, when it came from somebody's Immich. */
    immichAssetId: text("immich_asset_id"),
    immichAlbumName: text("immich_album_name"),

    /**
     * Set when the admin has swept the source files out of storage after a
     * render. The row stays — we still want the credits, the votes and the
     * shape of the cut — but the bytes are gone and nothing should try to
     * presign them.
     */
    prunedAt: timestamp("pruned_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    vlogIdx: index("media_items_vlog_id_idx").on(t.vlogId),
    chronoIdx: index("media_items_chrono_idx").on(t.vlogId, t.capturedAt, t.uploadIndex),
    statusIdx: index("media_items_status_idx").on(t.status),
    checksumIdx: index("media_items_checksum_idx").on(t.vlogId, t.checksumSha1),
  }),
);

// --- instance settings ------------------------------------------------------

/**
 * One row, always. Settings the operator can change without editing .env and
 * restarting — the export format, mostly, which is the thing you actually want
 * to fiddle with once you've seen a render come out too big for the Pi.
 *
 * Env vars still provide the first-boot defaults; after that this wins.
 */
export const appSettings = pgTable("app_settings", {
  /** Always `true` — a one-row table that can't accidentally grow. */
  id: boolean("id").primaryKey().default(true),

  /**
   * The film's shorter edge in pixels — the long one follows from the vlog's
   * own format. In widescreen that is the height, exactly as it always was.
   */
  renderHeight: integer("render_height").notNull().default(1080),
  renderFps: integer("render_fps").notNull().default(30),
  /** x264 quality, lower is better. 18 is visually lossless, 28 is rough. */
  renderCrf: integer("render_crf").notNull().default(20),
  /** x264 speed/size trade-off — "veryfast" is the sane default on a Pi. */
  renderPreset: text("render_preset").notNull().default("veryfast"),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- immich -----------------------------------------------------------------

/**
 * One person's Immich server, as connected from inside one vlog.
 *
 * Scoped to a member rather than a person, because there are no accounts here —
 * a member *is* the identity. It also means the key disappears with the vlog,
 * which is the right default for a credential this powerful.
 */
export const immichConnections = pgTable(
  "immich_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vlogId: uuid("vlog_id")
      .notNull()
      .references(() => vlogs.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),

    baseUrl: text("base_url").notNull(),
    /** AES-256-GCM sealed with a key derived from SESSION_SECRET. */
    apiKeyCipher: text("api_key_cipher").notNull(),
    /** Shown as "connected as ..."; never used for auth. */
    immichUserId: text("immich_user_id"),
    immichUserName: text("immich_user_name"),
    /** Last four characters of the key, so people can tell which one is saved. */
    keyHint: text("key_hint"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => ({
    memberUnique: unique("immich_connections_member_unique").on(t.memberId),
    vlogIdx: index("immich_connections_vlog_idx").on(t.vlogId),
  }),
);

/**
 * A bulk copy in either direction: pulling an album out of somebody's Immich
 * into the vlog, or pushing the whole pile back into somebody else's.
 *
 * One table for both because the UI shows them the same way — a labelled
 * progress bar that survives a page reload.
 */
export const immichTransfers = pgTable(
  "immich_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vlogId: uuid("vlog_id")
      .notNull()
      .references(() => vlogs.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),

    direction: transferDirectionEnum("direction").notNull(),
    /** Album name — what the person will recognise it by. */
    label: text("label").notNull(),

    total: integer("total").notNull().default(0),
    done: integer("done").notNull().default(0),
    /** Already present at the destination; counted, not copied. */
    skipped: integer("skipped").notNull().default(0),
    failed: integer("failed").notNull().default(0),

    status: transferStatusEnum("status").notNull().default("queued"),
    message: text("message"),
    error: text("error"),
    /** Album created on the far side by an export. */
    remoteAlbumId: text("remote_album_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    vlogIdx: index("immich_transfers_vlog_idx").on(t.vlogId, t.createdAt),
    memberIdx: index("immich_transfers_member_idx").on(t.memberId),
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

    /**
     * The beat grid, measured by the worker off the extracted audio. `bpm`
     * plus `beatOffsetSeconds` is the whole story — `beatTimes` is the first
     * couple of minutes as actually measured, which is enough for the
     * auto-cut to snap the opening of a film to a beat the ear agrees with.
     * Seconds from the start of the *track*, not the film.
     */
    bpm: doublePrecision("bpm"),
    beatOffsetSeconds: doublePrecision("beat_offset_seconds"),
    beatTimes: jsonb("beat_times").$type<number[]>(),
    /** 0..1. Low means the envelope had no periodicity worth trusting. */
    beatConfidence: doublePrecision("beat_confidence"),
    /**
     * The track's envelope, same shape and scale as `media_items.peaks` —
     * measured off the extracted audio while the worker had it on disk. Null
     * until (or unless) that extraction happens, which is why the audio lane
     * still has to draw something without it.
     */
    peaks: jsonb("peaks").$type<number[]>(),
    status: processingStatusEnum("status").notNull().default("pending"),
    error: text("error"),

    /** Same veto as media: keep a track out of the cut regardless of votes. */
    cutOverride: cutOverrideEnum("cut_override").$type<CutOverride>(),

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
  immichConnection: one(immichConnections, {
    fields: [members.id],
    references: [immichConnections.memberId],
  }),
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
export type ImmichConnection = typeof immichConnections.$inferSelect;
export type NewImmichConnection = typeof immichConnections.$inferInsert;
export type ImmichTransfer = typeof immichTransfers.$inferSelect;
export type AppSettings = typeof appSettings.$inferSelect;
