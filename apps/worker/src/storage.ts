import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { readFile } from "node:fs/promises";
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

export function buildStorageKey(
  vlogId: string,
  kind: "original" | "proxy" | "thumb" | "audio" | "render",
  id: string,
  filename: string,
) {
  return `vlogs/${vlogId}/${kind}/${id}/${filename}`;
}
