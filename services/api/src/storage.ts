import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectLegalHoldCommand,
  PutObjectRetentionCommand,
  type ObjectLockLegalHoldStatus,
  type ObjectLockMode,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";

function must(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} is not set`);
  return v.trim();
}

function clean(v: string | undefined | null): string | null {
  if (typeof v !== "string") return v ?? null;
  const t = v.trim();
  return t ? t : null;
}

function requireTls(endpoint: string | null) {
  if (!endpoint) return;

  const allowInsecure = process.env.S3_ALLOW_INSECURE === "true";
  if (
    process.env.NODE_ENV === "production" &&
    endpoint.startsWith("http://") &&
    !allowInsecure
  ) {
    throw new Error("S3_ENDPOINT must use https in production");
  }
}

function normBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function isProbablyS3ApiEndpoint(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes(".r2.cloudflarestorage.com") ||
    u.includes("amazonaws.com") ||
    u.includes("storage.googleapis.com")
  );
}

/**
 * IMPORTANT:
 * S3_PUBLIC_BASE_URL must be a real public serving domain (custom domain / CDN),
 * not the raw S3 API endpoint.
 */
export function getPublicBaseUrl(): string | null {
  const base = clean(process.env.S3_PUBLIC_BASE_URL);
  if (!base) return null;

  const assumePublic = process.env.S3_PUBLIC_ASSUME_PUBLIC === "true";
  const normalized = normBaseUrl(base);

  if (!assumePublic && isProbablyS3ApiEndpoint(normalized)) {
    return null;
  }

  return normalized;
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

function normalizeBase64Value(value?: string | null): string | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  if (raw.length > 128) return undefined;
  if (/[\r\n]/.test(raw)) return undefined;
  if (!/^[A-Za-z0-9+/=]+$/.test(raw)) return undefined;
  return raw;
}

function normalizeChecksumSha256Base64(
  value?: string | null
): string | undefined {
  return normalizeBase64Value(value);
}

function normalizeContentMd5Base64(
  value?: string | null
): string | undefined {
  return normalizeBase64Value(value);
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

function isObjectTaggingEnabled(): boolean {
  return clean(process.env.S3_ENABLE_OBJECT_TAGGING)?.toLowerCase() === "true";
}

function normalizeTagging(
  tags?: Record<string, string | null | undefined>
): string | undefined {
  if (!tags) return undefined;
  if (!isObjectTaggingEnabled()) return undefined;

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

function isObjectLockEnabled(): boolean {
  return clean(process.env.S3_OBJECT_LOCK_ENABLED)?.toLowerCase() === "true";
}

function readObjectLockDefaults(): {
  mode?: ObjectLockMode;
  retainUntilDate?: Date;
  legalHold?: ObjectLockLegalHoldStatus;
} {
  if (!isObjectLockEnabled()) {
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

function readPresignExpirySeconds(explicit?: number): number {
  const fallbackRaw = clean(process.env.S3_PRESIGN_EXPIRES_SECONDS);
  const fallbackParsed = fallbackRaw ? Number.parseInt(fallbackRaw, 10) : 600;
  const base = explicit ?? fallbackParsed;

  if (!Number.isFinite(base)) return 600;
  if (base < 60) return 60;
  if (base > 900) return 900;

  return base;
}

function sha256Base64(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("base64");
}

function md5Base64(buffer: Buffer): string {
  return createHash("md5").update(buffer).digest("base64");
}

function buildS3ClientConfig(): S3ClientConfig {
  const endpoint = clean(process.env.S3_ENDPOINT);
  requireTls(endpoint);

  const forcePathStyleRaw = clean(process.env.S3_FORCE_PATH_STYLE)?.toLowerCase();

  const config: S3ClientConfig = {
    region: clean(process.env.S3_REGION) ?? "eu-central-1",
    credentials: {
      accessKeyId: must("S3_ACCESS_KEY"),
      secretAccessKey: must("S3_SECRET_KEY"),
    },
    forcePathStyle:
      forcePathStyleRaw === "true"
        ? true
        : forcePathStyleRaw === "false"
          ? false
          : Boolean(endpoint),
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  };

  if (endpoint) {
    config.endpoint = endpoint;
  }

  return config;
}

export const s3 = new S3Client(buildS3ClientConfig());

export async function presignPutObject(params: {
  bucket: string;
  key: string;
  contentType: string;
  checksumSha256Base64?: string | null;
  contentMd5Base64?: string | null;
  expiresInSeconds?: number;
}) {
  const bucket = clean(params.bucket);
  const key = clean(params.key);

  if (!bucket || !key) {
    throw new Error("presignPutObject: bucket/key are required");
  }

  const normalizedContentType = normalizeContentType(params.contentType);
  const normalizedChecksum = normalizeChecksumSha256Base64(
    params.checksumSha256Base64
  );
  const normalizedContentMd5 = normalizeContentMd5Base64(
    params.contentMd5Base64
  );

  /**
   * IMPORTANT:
   * For browser/mobile direct uploads, we explicitly sign checksum headers,
   * and we also attach Object Lock values to the command so uploads do not rely
   * only on bucket defaults.
   *
   * We intentionally do NOT force Object Lock headers to stay as request headers
   * from the client, because the current frontend only sends checksum headers.
   * The SDK can safely carry Object Lock values in the signed request generated
   * from this command.
   */
  const objectLock = readObjectLockDefaults();

  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: normalizedContentType,
    ...(normalizedChecksum ? { ChecksumSHA256: normalizedChecksum } : {}),
    ...(normalizedContentMd5 ? { ContentMD5: normalizedContentMd5 } : {}),
    ...(objectLock.mode ? { ObjectLockMode: objectLock.mode } : {}),
    ...(objectLock.retainUntilDate
      ? { ObjectLockRetainUntilDate: objectLock.retainUntilDate }
      : {}),
    ...(objectLock.legalHold
      ? { ObjectLockLegalHoldStatus: objectLock.legalHold }
      : {}),
  });

  const signableHeaders = new Set<string>(["content-type"]);
  const unhoistableHeaders = new Set<string>();

  if (normalizedChecksum) {
    unhoistableHeaders.add("x-amz-checksum-sha256");
  }

  if (normalizedContentMd5) {
    unhoistableHeaders.add("content-md5");
  }

  return getSignedUrl(s3, cmd, {
    expiresIn: readPresignExpirySeconds(params.expiresInSeconds),
    signableHeaders,
    ...(unhoistableHeaders.size > 0 ? { unhoistableHeaders } : {}),
  });
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

  return getSignedUrl(s3, cmd, {
    expiresIn: readPresignExpirySeconds(params.expiresInSeconds),
  });
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
  const bucket = clean(params.bucket);
  const key = clean(params.key);

  if (!bucket || !key) {
    throw new Error("putObjectBuffer: bucket/key are required");
  }

  if (!Buffer.isBuffer(params.body) || params.body.length <= 0) {
    throw new Error("putObjectBuffer: body must be a non-empty Buffer");
  }

  const metadata = normalizeMetadata(params.metadata);
  const tagging = normalizeTagging(params.tags);
  const objectLock =
    params.immutable && isObjectLockEnabled() ? readObjectLockDefaults() : {};
  const checksumSha256Base64 = sha256Base64(params.body);
  const contentMd5Base64 = md5Base64(params.body);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: params.body,
      ContentType: normalizeContentType(params.contentType),
      ContentLength: params.body.length,
      Metadata: metadata,
      ChecksumSHA256: checksumSha256Base64,
      ContentMD5: contentMd5Base64,
      ...(tagging ? { Tagging: tagging } : {}),
      ...(objectLock.mode ? { ObjectLockMode: objectLock.mode } : {}),
      ...(objectLock.retainUntilDate
        ? { ObjectLockRetainUntilDate: objectLock.retainUntilDate }
        : {}),
      ...(objectLock.legalHold
        ? { ObjectLockLegalHoldStatus: objectLock.legalHold }
        : {}),
    })
  );
}

export async function applyObjectRetention(params: {
  bucket: string;
  key: string;
  mode?: ObjectLockMode;
  retainUntilDate?: Date;
  legalHold?: ObjectLockLegalHoldStatus;
  bypassGovernance?: boolean;
}) {
  const bucket = clean(params.bucket);
  const key = clean(params.key);

  if (!bucket || !key) {
    throw new Error("applyObjectRetention: bucket/key are required");
  }

  if (!isObjectLockEnabled()) {
    return {
      applied: false,
      reason: "object_lock_disabled",
    };
  }

  if (params.mode && params.retainUntilDate) {
    await s3.send(
      new PutObjectRetentionCommand({
        Bucket: bucket,
        Key: key,
        Retention: {
          Mode: params.mode,
          RetainUntilDate: params.retainUntilDate,
        },
        ...(params.bypassGovernance ? { BypassGovernanceRetention: true } : {}),
      })
    );
  }

  if (params.legalHold) {
    await s3.send(
      new PutObjectLegalHoldCommand({
        Bucket: bucket,
        Key: key,
        LegalHold: {
          Status: params.legalHold,
        },
      })
    );
  }

  return {
    applied: true,
  };
}

export async function applyDefaultObjectRetention(params: {
  bucket: string;
  key: string;
  bypassGovernance?: boolean;
}) {
  const defaults = readObjectLockDefaults();

  return applyObjectRetention({
    bucket: params.bucket,
    key: params.key,
    mode: defaults.mode,
    retainUntilDate: defaults.retainUntilDate,
    legalHold: defaults.legalHold,
    bypassGovernance: params.bypassGovernance,
  });
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
    metadata: res.Metadata ?? null,
    objectLockMode: res.ObjectLockMode ?? null,
    objectLockRetainUntilDate: res.ObjectLockRetainUntilDate ?? null,
    objectLockLegalHoldStatus: res.ObjectLockLegalHoldStatus ?? null,
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