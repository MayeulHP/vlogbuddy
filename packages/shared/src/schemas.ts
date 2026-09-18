import { z } from "zod";
import {
  ACCEPTED_UPLOAD_TYPES,
  CUT_OVERRIDES,
  MEDIA_KINDS,
  MUSIC_SOURCES,
  REACTION_SCORES,
  VLOG_STATES,
} from "./constants";

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Pick a name so your friends know who you are")
  .max(40, "That name is a bit long");

export const createVlogSchema = z.object({
  title: z.string().trim().min(1, "Give your vlog a title").max(120),
  description: z.string().trim().max(1000).optional(),
  creatorName: displayNameSchema,
  passcode: z.string().trim().min(3).max(64).optional().or(z.literal("")),
});
export type CreateVlogInput = z.infer<typeof createVlogSchema>;

export const joinVlogSchema = z.object({
  displayName: displayNameSchema,
  passcode: z.string().trim().max(64).optional(),
});
export type JoinVlogInput = z.infer<typeof joinVlogSchema>;

export const presignUploadSchema = z.object({
  filename: z.string().min(1).max(400),
  contentType: z.string().refine((t) => ACCEPTED_UPLOAD_TYPES.includes(t), {
    message: "That file type isn't supported",
  }),
  size: z.number().int().positive(),
});
export type PresignUploadInput = z.infer<typeof presignUploadSchema>;

export const completeUploadSchema = z.object({
  uploadId: z.string().uuid(),
  /** Client-read capture time (EXIF/file mtime); the worker may override it. */
  capturedAt: z.string().datetime().optional(),
});
export type CompleteUploadInput = z.infer<typeof completeUploadSchema>;

export const reactSchema = z.object({
  targetType: z.enum(["media", "music"]),
  targetId: z.string().uuid(),
  /** null clears the reaction. */
  score: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .nullable(),
});
export type ReactInput = z.infer<typeof reactSchema>;

export const addMusicSchema = z.object({
  url: z.string().url("Paste a YouTube link"),
  /** 0..1 position along the rough timeline. */
  timelinePosition: z.number().min(0).max(1).default(0.5),
});
export type AddMusicInput = z.infer<typeof addMusicSchema>;

export const moveMusicSchema = z.object({
  musicItemId: z.string().uuid(),
  timelinePosition: z.number().min(0).max(1),
});

export const selectItemSchema = z.object({
  targetType: z.enum(["media", "music"]),
  targetId: z.string().uuid(),
  selected: z.boolean(),
});

export const reorderSelectionSchema = z.object({
  /** media_item ids in final order. */
  order: z.array(z.string().uuid()),
});

export const cutOverrideSchema = z.object({
  targetType: z.enum(["media", "music"]),
  targetId: z.string().uuid(),
  /** null hands the item back to the cut line. */
  override: z.enum(CUT_OVERRIDES).nullable(),
});
export type CutOverrideInput = z.infer<typeof cutOverrideSchema>;

export const connectImmichSchema = z.object({
  baseUrl: z.string().trim().min(1, "Enter the address of your Immich server"),
  apiKey: z.string().trim().min(10, "That API key looks too short"),
});
export type ConnectImmichInput = z.infer<typeof connectImmichSchema>;

export const immichImportSchema = z.object({
  albumId: z.string().min(1),
  /** Empty means "the whole album". */
  assetIds: z.array(z.string()).default([]),
});
export type ImmichImportInput = z.infer<typeof immichImportSchema>;

export const setStateSchema = z.object({
  state: z.enum(VLOG_STATES),
});

export const scoreThresholdSchema = z.object({
  threshold: z.number().min(0).max(100),
});

export const mediaKindSchema = z.enum(MEDIA_KINDS);
export const musicSourceSchema = z.enum(MUSIC_SOURCES);
export const reactionScoreSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export { REACTION_SCORES };
