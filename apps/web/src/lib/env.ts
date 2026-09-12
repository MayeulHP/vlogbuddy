import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string().min(1),

  PUBLIC_BASE_URL: z.string().url(),
  PUBLIC_STORAGE_URL: z.string().url(),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_PRESIGN_EXPIRY: z.coerce.number().default(3600),

  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),
  MAX_UPLOAD_MB: z.coerce.number().default(2048),
  ENABLE_YT_AUDIO: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  }
  return parsed.data;
}

let cached: z.infer<typeof envSchema> | null = null;

export function env() {
  if (!cached) cached = loadEnv();
  return cached;
}

export const maxUploadBytes = () => env().MAX_UPLOAD_MB * 1024 * 1024;
