import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { readFile, stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { env } from "./env";

let client: S3Client | null = null;

function s3() {
  if (!client) {
    const e = env();
    client = new S3Client({
      region: e.S3_REGION,
      endpoint: e.S3_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: e.S3_ACCESS_KEY, secretAccessKey: e.S3_SECRET_KEY },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return client;
}

/** Streams an object to local disk so FFmpeg can work on a real file. */
export async function downloadToFile(key: string, destPath: string): Promise<void> {
  const res = await s3().send(new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key }));
  if (!res.Body) throw new Error(`Empty object: ${key}`);
  await pipeline(res.Body as Readable, createWriteStream(destPath));
}

export async function uploadFile(
  key: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  const body = await readFile(filePath);
  await s3().send(
    new PutObjectCommand({
      Bucket: env().S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/**
 * Streams a file straight from disk into storage.
 *
 * `uploadFile` reads the whole thing into memory first, which is fine for a
 * thumbnail and reckless for the 3GB video somebody just pulled out of Immich.
 * S3 accepts a stream as long as we tell it the length up front.
 */
export async function uploadFileStreaming(
  key: string,
  filePath: string,
  contentType: string,
): Promise<number> {
  const { size } = await stat(filePath);
  await s3().send(
    new PutObjectCommand({
      Bucket: env().S3_BUCKET,
      Key: key,
      Body: createReadStream(filePath),
      ContentLength: size,
      ContentType: contentType,
    }),
  );
  return size;
}

export function buildStorageKey(
  vlogId: string,
  kind: "original" | "proxy" | "thumb" | "filmstrip" | "audio" | "render",
  id: string,
  filename: string,
) {
  return `vlogs/${vlogId}/${kind}/${id}/${filename}`;
}
