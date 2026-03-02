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
  if (process.env.NODE_ENV === "production" && endpoint.startsWith("http://") && !allowInsecure) {
    throw new Error("S3_ENDPOINT must use https in production");
  }
}

function normBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function isProbablyS3ApiEndpoint(url: string): boolean {
  // Cloudflare R2 S3 API endpoint (NOT a public object CDN)
  // also catches many S3-like api endpoints
  const u = url.toLowerCase();
  return (
    u.includes(".r2.cloudflarestorage.com") ||
    u.includes("amazonaws.com") ||
    u.includes("storage.googleapis.com")
  );
}

/**
 * IMPORTANT:
 * S3_PUBLIC_BASE_URL يجب أن يكون "public serving domain" فعلاً (custom domain / r2.dev / CDN)
 * وليس S3 API endpoint. لذلك:
 * - إذا كان يبدو مثل S3 API endpoint -> نُعطّله تلقائياً حتى ما نخرب التحميل بالمتصفح.
 * - أو يمكنك إجبار استخدامه عبر S3_PUBLIC_ASSUME_PUBLIC=true (إذا أنت متأكد أنه public فعلاً).
 */
export function getPublicBaseUrl(): string | null {
  const base = clean(process.env.S3_PUBLIC_BASE_URL);
  if (!base) return null;

  const assumePublic = process.env.S3_PUBLIC_ASSUME_PUBLIC === "true";
  const normalized = normBaseUrl(base);

  if (!assumePublic && isProbablyS3ApiEndpoint(normalized)) {
    // حماية من إعداد خاطئ شائع (مثل حالتك)
    return null;
  }

  return normalized;
}

const endpoint = must("S3_ENDPOINT");
requireTls(endpoint);

const region = clean(process.env.S3_REGION) ?? "auto";

// Cloudflare R2 غالباً يحتاج forcePathStyle=true
const forcePathStyle =
  clean(process.env.S3_FORCE_PATH_STYLE)?.toLowerCase() === "false" ? false : true;

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