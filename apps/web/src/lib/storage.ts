import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";

let client: S3Client | null = null;

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
    });
  }
  return client;
}

/**
 * Presigned URLs are generated against the internal endpoint, then rewritten to
 * the public one so browsers can use them. The signature stays valid because
 * SigV4 doesn't cover the host when the path and query match.
 */
function toPublicUrl(signed: string): string {
  const e = env();
  const internal = new URL(e.S3_ENDPOINT);
  const publicUrl = new URL(e.PUBLIC_STORAGE_URL);
  const target = new URL(signed);

  if (target.host === internal.host) {
    target.protocol = publicUrl.protocol;
    target.host = publicUrl.host;
    // Preserve any base path on the public endpoint.
    const basePath = publicUrl.pathname.replace(/\/$/, "");
    if (basePath) target.pathname = basePath + target.pathname;
  }
  return target.toString();
}

export async function presignUpload(key: string, contentType: string, expiresIn?: number) {
  const e = env();
  const command = new PutObjectCommand({
    Bucket: e.S3_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const signed = await getSignedUrl(s3(), command, {
    expiresIn: expiresIn ?? e.S3_PRESIGN_EXPIRY,
  });
  return toPublicUrl(signed);
}

export async function presignDownload(key: string, expiresIn?: number, downloadName?: string) {
  const e = env();
  const command = new GetObjectCommand({
    Bucket: e.S3_BUCKET,
    Key: key,
    ...(downloadName
      ? { ResponseContentDisposition: `attachment; filename="${downloadName.replace(/"/g, "")}"` }
      : {}),
  });
  const signed = await getSignedUrl(s3(), command, {
    expiresIn: expiresIn ?? e.S3_PRESIGN_EXPIRY,
  });
  return toPublicUrl(signed);
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
