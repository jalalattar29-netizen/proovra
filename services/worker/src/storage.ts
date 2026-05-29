import {
  S3Client,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectLegalHoldCommand,
  PutObjectRetentionCommand,
  type ObjectLockLegalHoldStatus,
  type ObjectLockMode,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { env } from "./config.js";
// Phase O1.4 — instrument S3 calls with bounded PROOVRA spans so the
// API → S3 latency / failure surface is visible in Grafana alongside
// the parent business span. Attributes are bounded: bucket name +
// object-key prefix (first 32 chars) + size. NEVER the body bytes,
// NEVER the full signed URL, NEVER the AWS credentials.
import { PROOVRA_SPAN_NAMES, withProovraSpan, withProovraSpanSync } from "./otel.js";

function boundedKeyAttr(key: string): string {
  return key.length > 64 ? key.slice(0, 64) + "…" : key;
}

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

function readForcePathStyle(endpoint: string | null): boolean {
  const raw = clean(process.env.S3_FORCE_PATH_STYLE)?.toLowerCase();

  if (raw === "true") return true;
  if (raw === "false") return false;

  // default:
  // - custom endpoint (MinIO/R2/etc) => true
  // - native AWS S3 => false
  return Boolean(endpoint);
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

function sha256Base64(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("base64");
}

function md5Base64(buffer: Buffer): string {
  return createHash("md5").update(buffer).digest("base64");
}

function buildS3ClientConfig(): S3ClientConfig {
  const endpoint = clean(env.S3_ENDPOINT);
  requireTls(endpoint);

  const config: S3ClientConfig = {
    region: mustClean(env.S3_REGION, "S3_REGION"),
    credentials: {
      accessKeyId: mustClean(env.S3_ACCESS_KEY, "S3_ACCESS_KEY"),
      secretAccessKey: mustClean(env.S3_SECRET_KEY, "S3_SECRET_KEY"),
    },
    forcePathStyle: readForcePathStyle(endpoint),
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  };

  if (endpoint) {
    config.endpoint = endpoint;
  }

  return config;
}

export const s3 = new S3Client(buildS3ClientConfig());

export async function getObjectStream(params: { bucket: string; key: string }) {
  const bucket = mustClean(params.bucket, "bucket");
  const key = mustClean(params.key, "key");

  // Phase O1.4 — bounded S3 span. Attributes carry the bucket +
  // bounded key prefix only; never body bytes or signed URLs.
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.S3_GET_OBJECT,
    {
      "proovra.bucket": bucket,
      "proovra.s3.key_prefix": boundedKeyAttr(key),
      "proovra.operation": "get_object",
    },
    async () => {
      const res = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );

      if (!res.Body) throw new Error("S3 returned empty body");
      return res.Body;
    },
  );
}

/**
 * Phase 31.8 — bounded byte range fetch. Used by the EXIF extractor
 * job to pull only the first few KB of an image (EXIF data lives at
 * the start of JPEG/TIFF). Range is an HTTP byte range string like
 * "bytes=0-65535". Returns the bytes as a Buffer.
 *
 * NEVER mutates the object. NEVER touches retention. Read-only.
 */
export async function getObjectRange(params: {
  bucket: string;
  key: string;
  range: string;
}): Promise<Buffer> {
  const bucket = mustClean(params.bucket, "bucket");
  const key = mustClean(params.key, "key");
  if (!params.range) {
    throw new Error("getObjectRange: range is required");
  }
  const res = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: params.range,
    })
  );
  if (!res.Body) throw new Error("S3 returned empty body");
  const stream = res.Body as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer),
    );
  }
  return Buffer.concat(chunks);
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
  const objectLock =
    params.immutable && isObjectLockEnabled() ? readObjectLockDefaults() : {};
  // Phase O1.5B — bounded integrity.hash.compute span. Wraps the
  // sha256 + md5 compute over the upload body. NEVER the bytes.
  const { checksumSha256Base64, contentMd5Base64 } = withProovraSpanSync(
    PROOVRA_SPAN_NAMES.INTEGRITY_HASH_COMPUTE,
    {
      "proovra.operation": "integrity_hash_compute",
      "proovra.size_bytes": params.body.length,
    },
    () => ({
      checksumSha256Base64: sha256Base64(params.body),
      contentMd5Base64: md5Base64(params.body),
    }),
  );

  // Phase O1.4 — bounded S3 PUT span. Carries bucket + key prefix +
  // size. NEVER the body bytes / signed URL / AWS credentials.
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.S3_PUT_OBJECT,
    {
      "proovra.bucket": bucket,
      "proovra.s3.key_prefix": boundedKeyAttr(key),
      "proovra.operation": "put_object",
      "proovra.size_bytes": params.body.length,
      "proovra.immutable": Boolean(params.immutable),
    },
    async () => {
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
        }),
      );
    },
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
  const bucket = mustClean(params.bucket, "bucket");
  const key = mustClean(params.key, "key");

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
  const bucket = mustClean(params.bucket, "bucket");
  const key = mustClean(params.key, "key");

  // Phase O1.4 — bounded S3 HEAD span.
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.S3_HEAD_OBJECT,
    {
      "proovra.bucket": bucket,
      "proovra.s3.key_prefix": boundedKeyAttr(key),
      "proovra.operation": "head_object",
    },
    async () => {
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
    },
  );
}

export async function deleteObject(params: { bucket: string; key: string }) {
  const bucket = mustClean(params.bucket, "bucket");
  const key = mustClean(params.key, "key");

  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  return {
    deleted: true,
  };
}

/**
 * Phase C #1 — worker side of Object Lock startup verification. Mirrors the
 * API verification function so both surfaces apply the same policy.
 */
export type ObjectLockVerificationResult =
  | {
      mode: "verified";
      configured: {
        objectLockEnabled: boolean;
        defaultMode: string | null;
        defaultRetainDays: number | null;
        bucket: string;
      };
    }
  | { mode: "claimed-but-unsupported"; bucket: string; reason: string }
  | { mode: "disabled" }
  | { mode: "skipped"; reason: string };

export async function verifyObjectLockConfiguration(): Promise<ObjectLockVerificationResult> {
  if (!isObjectLockEnabled()) {
    return { mode: "disabled" };
  }

  const bucket = clean(process.env.S3_BUCKET);
  if (!bucket) {
    return { mode: "skipped", reason: "S3_BUCKET not configured" };
  }

  try {
    const res = await s3.send(
      new GetObjectLockConfigurationCommand({ Bucket: bucket })
    );
    const cfg = res.ObjectLockConfiguration;
    const objectLockEnabled =
      String(cfg?.ObjectLockEnabled ?? "").toLowerCase() === "enabled";

    if (!objectLockEnabled) {
      return {
        mode: "claimed-but-unsupported",
        bucket,
        reason:
          "GetObjectLockConfiguration returned a configuration but ObjectLockEnabled is not 'Enabled'",
      };
    }

    return {
      mode: "verified",
      configured: {
        objectLockEnabled,
        defaultMode: cfg?.Rule?.DefaultRetention?.Mode ?? null,
        defaultRetainDays:
          cfg?.Rule?.DefaultRetention?.Days ??
          (typeof cfg?.Rule?.DefaultRetention?.Years === "number"
            ? cfg.Rule.DefaultRetention.Years * 365
            : null),
        bucket,
      },
    };
  } catch (err) {
    const errObj = err as {
      name?: unknown;
      Code?: unknown;
      code?: unknown;
      message?: unknown;
    };
    const code = String(errObj?.Code ?? errObj?.code ?? errObj?.name ?? "");
    const msg = String(errObj?.message ?? "");
    if (
      code.includes("ObjectLockConfigurationNotFoundError") ||
      msg.includes("Object Lock configuration does not exist") ||
      msg.includes("ObjectLockConfigurationNotFound")
    ) {
      return {
        mode: "claimed-but-unsupported",
        bucket,
        reason:
          "Bucket has no Object Lock configuration. Object Lock can only be enabled at bucket creation time on AWS S3.",
      };
    }
    return {
      mode: "skipped",
      reason: `GetObjectLockConfiguration probe failed: ${code || msg || "unknown"}`,
    };
  }
}
