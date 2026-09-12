import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { headers } from "next/headers";
import { env } from "./env";

let client: S3Client | null = null;

/** AWS SDK v3 signs CRC32 checksums by default; browsers (and older MinIO) don't send them. */
const s3ClientOpts = {
  requestChecksumCalculation: "WHEN_REQUIRED" as const,
  responseChecksumValidation: "WHEN_REQUIRED" as const,
};

function s3() {
  if (!client) {
    const e = env();
    client = new S3Client({
      region: e.S3_REGION,
      endpoint: e.S3_ENDPOINT,
      // MinIO needs path-style addressing.
      forcePathStyle: true,
      credentials: {
        accessKeyId: e.S3_ACCESS_KEY,
        secretAccessKey: e.S3_SECRET_KEY,
      },
      ...s3ClientOpts,
    });
  }
  return client;
}

/** Sign against the public origin so `host` in SigV4 matches what the browser hits. */
function s3Presign(publicEndpoint: string) {
  const e = env();
  return new S3Client({
    region: e.S3_REGION,
    endpoint: publicEndpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: e.S3_ACCESS_KEY,
      secretAccessKey: e.S3_SECRET_KEY,
    },
    ...s3ClientOpts,
  });
}

/**
 * When accessing by IP (CORS_ALLOW_ORIGIN=*), use the hostname the browser
 * actually used so uploads go to this machine's MinIO port — not a leftover
 * PUBLIC_STORAGE_URL domain that the browser cannot reach.
 */
async function resolvePublicStorageUrl(): Promise<URL> {
  const configured = new URL(env().PUBLIC_STORAGE_URL);
  if (process.env.CORS_ALLOW_ORIGIN !== "*") return configured;

  try {
    const h = await headers();
    const hostHeader = h.get("x-forwarded-host") ?? h.get("host");
    if (!hostHeader) return configured;

    const hostname = hostHeader.split(":")[0];
    const forwarded = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const proto = forwarded || "http";
    const port = process.env.S3_PORT || configured.port || "9000";
    return new URL(`${proto}://${hostname}:${port}`);
  } catch {
    return configured;
  }
}

export async function presignUpload(key: string, contentType: string, expiresIn?: number) {
  const e = env();
  const publicEndpoint = publicEndpointFrom(await resolvePublicStorageUrl());
  const command = new PutObjectCommand({
    Bucket: e.S3_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3Presign(publicEndpoint), command, {
    expiresIn: expiresIn ?? e.S3_PRESIGN_EXPIRY,
  });
}

export async function presignDownload(key: string, expiresIn?: number, downloadName?: string) {
  const e = env();
  const publicEndpoint = publicEndpointFrom(await resolvePublicStorageUrl());
  const command = new GetObjectCommand({
    Bucket: e.S3_BUCKET,
    Key: key,
    ...(downloadName
      ? { ResponseContentDisposition: `attachment; filename="${downloadName.replace(/"/g, "")}"` }
      : {}),
  });
  return getSignedUrl(s3Presign(publicEndpoint), command, {
    expiresIn: expiresIn ?? e.S3_PRESIGN_EXPIRY,
  });
}

function publicEndpointFrom(url: URL) {
  const path = url.pathname.replace(/\/$/, "");
  return `${url.origin}${path}`;
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: env().S3_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function headObject(key: string) {
  try {
    const res = await s3().send(new HeadObjectCommand({ Bucket: env().S3_BUCKET, Key: key }));
    return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? "" };
  } catch {
    return null;
  }
}

export async function deleteObject(key: string) {
  await s3().send(new DeleteObjectCommand({ Bucket: env().S3_BUCKET, Key: key }));
}

/** Deterministic, collision-free storage layout. */
export function buildStorageKey(
  vlogId: string,
  kind: "original" | "proxy" | "thumb" | "audio" | "render",
  id: string,
  filename: string,
) {
  return `vlogs/${vlogId}/${kind}/${id}/${filename}`;
}
