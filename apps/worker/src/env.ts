import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url().optional(),

  /** Same secret as the web app — it unseals stored Immich API keys. */
  SESSION_SECRET: z.string().min(16),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),

  RENDER_CONCURRENCY: z.coerce.number().default(1),
  /**
   * First-boot defaults only. Once the admin has saved the export format on
   * /admin, the database row wins and changing these does nothing.
   */
  RENDER_HEIGHT: z.coerce.number().default(1080),
  RENDER_FPS: z.coerce.number().default(30),

  TMP_DIR: z.string().default("/tmp/vlogbuddy"),
  /** drawtext needs a concrete font file on Alpine (no fontconfig defaults). */
  FONT_PATH: z.string().default("/usr/share/fonts/noto/NotoSans-Regular.ttf"),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  YTDLP_PATH: z.string().default("yt-dlp"),
});

let cached: z.infer<typeof envSchema> | null = null;

export function env() {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Invalid worker environment:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
