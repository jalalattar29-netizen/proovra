import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function clean(v: string | undefined | null): string | null {
  if (typeof v !== "string") return v ?? null;
  const t = v.trim();
  return t ? t : null;
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

const endpoint = must("S3_ENDPOINT");
requireTls(endpoint);

const region = clean(process.env.S3_REGION) ?? "auto";

// NOTE:
// - Cloudflare R2 usually works with forcePathStyle: true.
// - But make it configurable in case you switch providers.
const forcePathStyle =
  clean(process.env.S3_FORCE_PATH_STYLE)?.toLowerCase() === "false"
    ? false
    : true;

export const s3 = new S3Client({
  region,
  endpoint,
  credentials: {
    accessKeyId: must("S3_ACCESS_KEY"),
    secretAccessKey: must("S3_SECRET_KEY"),
  },
  forcePathStyle,
});

export async function presignPutObject(params: {
  bucket: string;
  key: string;
  contentType: string;
  expiresInSeconds?: number;
}) {
  const bucket = clean(params.bucket);
  const key = clean(params.key);
  const contentType = clean(params.contentType);

  if (!bucket || !key || !contentType) {
    throw new Error("presignPutObject: bucket/key/contentType are required");
  }

  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(s3, cmd, { expiresIn: params.expiresInSeconds ?? 600 });
}

export async function presignGetObject(params: {
  bucket: string;
  key: string;
  expiresInSeconds?: number;
}) {
  const bucket = clean(params.bucket);
  const key = clean(params.key);

  if (!bucket || !key) {
    throw new Error("presignGetObject: bucket/key are required");
  }

  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return getSignedUrl(s3, cmd, { expiresIn: params.expiresInSeconds ?? 600 });
}

export async function headObject(params: { bucket: string; key: string }) {
  const bucket = clean(params.bucket);
  const key = clean(params.key);

  if (!bucket || !key) {
    throw new Error("headObject: bucket/key are required");
  }

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

export async function getObjectStream(params: {
  bucket: string;
  key: string;
}): Promise<NodeJS.ReadableStream> {
  const bucket = clean(params.bucket);
  const key = clean(params.key);

  if (!bucket || !key) {
    throw new Error("getObjectStream: bucket/key are required");
  }

  const res = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  if (!res.Body) throw new Error("S3 returned empty body");
  return res.Body as unknown as NodeJS.ReadableStream;
}