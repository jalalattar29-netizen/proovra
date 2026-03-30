import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  type ObjectLockLegalHoldStatus,
  type ObjectLockMode,
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

function normalizeMetadata(
  metadata?: Record<string, string | null | undefined>
): Record<string, string> | undefined {
  if (!metadata) return undefined;

  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(metadata)) {
    const normalizedKey = key.trim().toLowerCase();
    const normalizedValue = clean(value);

    if (!normalizedKey || !normalizedValue) continue;
    if (normalizedKey.length > 128) continue;
    if (normalizedValue.length > 1024) continue;
    if (/[\r\n]/.test(normalizedKey) || /[\r\n]/.test(normalizedValue)) continue;

    out[normalizedKey] = normalizedValue;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeTagging(
  tags?: Record<string, string | null | undefined>
): string | undefined {
  if (!tags) return undefined;

  const parts: string[] = [];

  for (const [key, value] of Object.entries(tags)) {
    const k = clean(key);
    const v = clean(value);
    if (!k || !v) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }

  return parts.length > 0 ? parts.join("&") : undefined;
}

function parsePositiveInt(value: string | null | undefined): number | null {
  const raw = clean(value);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function readObjectLockDefaults(): {
  mode?: ObjectLockMode;
  retainUntilDate?: Date;
  legalHold?: ObjectLockLegalHoldStatus;
} {
  const enabled = clean(process.env.S3_OBJECT_LOCK_ENABLED)?.toLowerCase() === "true";
  if (!enabled) {
    return {};
  }

  const modeRaw = clean(process.env.S3_OBJECT_LOCK_MODE)?.toUpperCase();
  const legalHoldRaw = clean(process.env.S3_OBJECT_LOCK_LEGAL_HOLD)?.toUpperCase();
  const retainDays = parsePositiveInt(process.env.S3_OBJECT_LOCK_RETAIN_DAYS);

  const mode: ObjectLockMode | undefined =
    modeRaw === "GOVERNANCE" || modeRaw === "COMPLIANCE"
      ? (modeRaw as ObjectLockMode)
      : undefined;

  const legalHold: ObjectLockLegalHoldStatus | undefined =
    legalHoldRaw === "ON" || legalHoldRaw === "OFF"
      ? (legalHoldRaw as ObjectLockLegalHoldStatus)
      : undefined;

  const retainUntilDate =
    mode && retainDays
      ? new Date(Date.now() + retainDays * 24 * 60 * 60 * 1000)
      : undefined;

  return {
    mode,
    retainUntilDate,
    legalHold,
  };
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
  return res.Body;
}

export async function putObjectBuffer(params: {
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
  metadata?: Record<string, string | null | undefined>;
  tags?: Record<string, string | null | undefined>;
  immutable?: boolean;
}) {
  const bucket = mustClean(params.bucket, "bucket");
  const key = mustClean(params.key, "key");

  if (!Buffer.isBuffer(params.body) || params.body.length <= 0) {
    throw new Error("putObjectBuffer: body must be a non-empty Buffer");
  }

  const metadata = normalizeMetadata(params.metadata);
  const tagging = normalizeTagging(params.tags);

  const objectLock = params.immutable ? readObjectLockDefaults() : {};

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: params.body,
      ContentType: normalizeContentType(params.contentType),
      ContentLength: params.body.length,
      Metadata: metadata,
      Tagging: tagging,
      ObjectLockMode: objectLock.mode,
      ObjectLockRetainUntilDate: objectLock.retainUntilDate,
      ObjectLockLegalHoldStatus: objectLock.legalHold,
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
    metadata: res.Metadata ?? null,
    objectLockMode: res.ObjectLockMode ?? null,
    objectLockRetainUntilDate: res.ObjectLockRetainUntilDate ?? null,
    objectLockLegalHoldStatus: res.ObjectLockLegalHoldStatus ?? null,
  };
}