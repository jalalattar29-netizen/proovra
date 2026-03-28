import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { env } from "./config.js";

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return value ?? null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function mustClean(value: string | null | undefined, fieldName: string): string {
  const trimmed = clean(value);
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function requireTls(endpoint: string) {
  const allowInsecure = process.env.S3_ALLOW_INSECURE === "true";
  if (
    process.env.NODE_ENV === "production" &&
    endpoint.startsWith("http://") &&
    !allowInsecure
  ) {
    throw new Error("S3_ENDPOINT must use https in production");
  }
}

function readForcePathStyle(): boolean {
  const raw = clean(process.env.S3_FORCE_PATH_STYLE)?.toLowerCase();
  if (raw === "false") return false;
  return true;
}

function normalizeContentType(contentType: string): string {
  const trimmed = contentType.trim().toLowerCase();

  if (!trimmed) return "application/octet-stream";
  if (trimmed.length > 128) return "application/octet-stream";
  if (/[\r\n]/.test(trimmed)) return "application/octet-stream";
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(trimmed)) {
    return "application/octet-stream";
  }

  return trimmed;
}

const endpoint = mustClean(env.S3_ENDPOINT, "S3_ENDPOINT");
requireTls(endpoint);

export const s3 = new S3Client({
  region: mustClean(env.S3_REGION, "S3_REGION"),
  endpoint,
  credentials: {
    accessKeyId: mustClean(env.S3_ACCESS_KEY, "S3_ACCESS_KEY"),
    secretAccessKey: mustClean(env.S3_SECRET_KEY, "S3_SECRET_KEY"),
  },
  forcePathStyle: readForcePathStyle(),
});

export async function getObjectStream(params: { bucket: string; key: string }) {
  const bucket = mustClean(params.bucket, "bucket");
  const key = mustClean(params.key, "key");

  const res = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  if (!res.Body) throw new Error("S3 returned empty body");
  return res.Body; // Node.js Readable
}

export async function putObjectBuffer(params: {
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
}) {
  const bucket = mustClean(params.bucket, "bucket");
  const key = mustClean(params.key, "key");

  if (!Buffer.isBuffer(params.body) || params.body.length <= 0) {
    throw new Error("putObjectBuffer: body must be a non-empty Buffer");
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: params.body,
      ContentType: normalizeContentType(params.contentType),
      ContentLength: params.body.length,
    })
  );
}

export async function headObject(params: { bucket: string; key: string }) {
  const bucket = mustClean(params.bucket, "bucket");
  const key = mustClean(params.key, "key");

  const res = await s3.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  return {
    sizeBytes: res.ContentLength ?? null,
    contentType: res.ContentType ?? null,
    etag: res.ETag ?? null,
  };
}