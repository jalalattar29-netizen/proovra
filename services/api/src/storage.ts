import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  PutObjectRetentionCommand,
  CopyObjectCommand,
  RestoreObjectCommand,
  DeleteObjectCommand,
  type ObjectLockMode,
  type S3ClientConfig,
  type StorageClass,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
// Phase O1.4 — bounded S3 spans. Attributes carry the bucket name +
// bounded key prefix (first 64 chars). NEVER the signed URL, body
// bytes, or credentials.
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpan,
} from "./observability/otel.js";

function boundedKeyAttr(key: string): string {
  return key.length > 64 ? key.slice(0, 64) + "…" : key;
}

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

/**
 * WHY THERE IS NO `legalHold` HERE ANY MORE (2026-08-24).
 *
 * This function used to return a `legalHold` read straight from
 * `S3_OBJECT_LOCK_LEGAL_HOLD`, and every ordinary upload and retention call
 * spread it into the S3 request. Two things were wrong with that, and the
 * second is the serious one.
 *
 * FIRST: the variable is set to `OFF` in production, and `"OFF"` is a truthy
 * string. So the guard `if (objectLock.legalHold)` passed, and PROOVRA
 * actively stamped `LegalHold=OFF` on every finalized object and part — a
 * write nobody asked for, expressing a decision the application had not made.
 *
 * SECOND: the variable reads like an opt-out and behaves like an opt-in. An
 * operator setting it to `ON` — a one-character change that looks like
 * "enable the legal-hold feature" — would have placed a NATIVE S3 legal hold on
 * every newly finalized object. On this platform's COMPLIANCE bucket that hold
 * is not releasable by any code that exists: PROOVRA persists no S3 VersionId,
 * has no GetObjectLegalHold, and has no release path. The result would be
 * permanently unreleasable objects, and no account — including root — can
 * clear a COMPLIANCE-mode legal hold it cannot address by version.
 *
 * Native legal hold is a real and worthwhile future capability. It needs
 * durable version tracking, a per-version apply/release saga, propagation to
 * artifacts created after placement, and drift reconciliation. None of that is
 * a default on an upload helper, so the capability is removed from this path
 * entirely rather than left behind a variable. When it is built it will arrive
 * as an explicit, saga-owned operation.
 *
 * RETENTION IS UNTOUCHED. `mode` and `retainUntilDate` still come from
 * `S3_OBJECT_LOCK_MODE` and `S3_OBJECT_LOCK_RETAIN_DAYS` and are still applied
 * to every object exactly as before. Only the legal-hold stamp is gone.
 */
function readObjectLockDefaults(): {
  mode?: ObjectLockMode;
  retainUntilDate?: Date;
} {
  if (!isObjectLockEnabled()) {
    return {};
  }

  const modeRaw = clean(process.env.S3_OBJECT_LOCK_MODE)?.toUpperCase();
  const retainDays = parsePositiveInt(process.env.S3_OBJECT_LOCK_RETAIN_DAYS);

  const mode: ObjectLockMode | undefined =
    modeRaw === "GOVERNANCE" || modeRaw === "COMPLIANCE"
      ? (modeRaw as ObjectLockMode)
      : undefined;

  const retainUntilDate =
    mode && retainDays
      ? new Date(Date.now() + retainDays * 24 * 60 * 60 * 1000)
      : undefined;

  return {
    mode,
    retainUntilDate,
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
    // No ObjectLockLegalHoldStatus. See readObjectLockDefaults.
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

  // Phase O1.4 — bounded S3 PUT span.
  await withProovraSpan(
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
          // No ObjectLockLegalHoldStatus. See readObjectLockDefaults.
        }),
      );
    },
  );
}

/**
 * Apply Object Lock RETENTION to one object.
 *
 * The `legalHold` parameter and its `PutObjectLegalHoldCommand` call were
 * removed on 2026-08-24. A retention helper that can also place a legal hold is
 * a loaded gun: the only caller passed the value straight from an environment
 * variable, so a config edit could place unreleasable native holds with no
 * application lifecycle behind them. Native legal hold returns as an explicit
 * saga-owned operation or not at all.
 */
export async function applyObjectRetention(params: {
  bucket: string;
  key: string;
  mode?: ObjectLockMode;
  retainUntilDate?: Date;
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
    bypassGovernance: params.bypassGovernance,
  });
}

export async function headObject(params: { bucket: string; key: string }) {
  const bucket = clean(params.bucket);
  const key = clean(params.key);

  if (!bucket || !key) {
    throw new Error("headObject: bucket/key are required");
  }

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

export async function getObjectStream(params: {
  bucket: string;
  key: string;
}): Promise<NodeJS.ReadableStream> {
  const bucket = clean(params.bucket);
  const key = clean(params.key);

  if (!bucket || !key) {
    throw new Error("getObjectStream: bucket/key are required");
  }

  // Phase O1.4 — bounded S3 GET span.
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
      return res.Body as unknown as NodeJS.ReadableStream;
    },
  );
}

export async function getObjectRange(params: {
  bucket: string;
  key: string;
  range: string;
}): Promise<Buffer> {
  const bucket = clean(params.bucket);
  const key = clean(params.key);

  if (!bucket || !key || !params.range) {
    throw new Error("getObjectRange: bucket/key/range are required");
  }

  const res = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: params.range,
    })
  );

  if (!res.Body) throw new Error("S3 returned empty body");
  return streamToBuffer(res.Body as unknown as NodeJS.ReadableStream);
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else {
      chunks.push(Buffer.from(chunk));
    }
  }

  return Buffer.concat(chunks);
}

/**
 * Object Lock startup verification (Phase C #1).
 *
 * When S3_OBJECT_LOCK_ENABLED=true the code path that completes evidence
 * appends EVIDENCE_LOCKED custody events. We must NOT enter that code path
 * if the configured bucket cannot actually accept retention writes — the
 * EVIDENCE_LOCKED event would still be gated by Phase A's truth check
 * (anyApplied + headObject), but operators deserve a loud failure at startup
 * rather than silent per-record downgrades.
 *
 * Returns:
 *   { mode: "verified", configured: { ... } } — bucket has Object Lock and
 *     a default retention or "no default" but Object Lock is enabled.
 *   { mode: "claimed-but-unsupported", reason } — env says enabled, bucket
 *     does not support Object Lock. In production the caller should refuse
 *     to start; in dev it should log loudly and downgrade claims.
 *   { mode: "disabled" } — env did not opt in; nothing to verify.
 *   { mode: "skipped", reason } — verification could not run (e.g., probe
 *     S3 client mis-configured); caller decides policy.
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

    // S3 returns ObjectLockConfigurationNotFoundError when the bucket exists
    // but Object Lock was never enabled at bucket creation time.
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

// -----------------------------------------------------------------------------
// Phase 4B — Archive tier storage-class transitions.
// -----------------------------------------------------------------------------

/** Change an S3 object's storage class in-place via CopyObject. */
export async function copyObjectStorageClass(params: {
  bucket: string;
  key: string;
  storageClass: string;
}): Promise<void> {
  await s3.send(
    new CopyObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      CopySource: `${params.bucket}/${params.key}`,
      StorageClass: params.storageClass as StorageClass,
      MetadataDirective: "COPY",
    })
  );
}

/** Initiate a Glacier restore for a COLD/DEEP_ARCHIVE object. */
export async function restoreObject(params: {
  bucket: string;
  key: string;
  days?: number;
}): Promise<void> {
  await s3.send(
    new RestoreObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      RestoreRequest: { Days: params.days ?? 7, GlacierJobParameters: { Tier: "Standard" } },
    })
  );
}

/** Return the current storage class of an S3 object, or null if unknown. */
export async function headObjectStorageClass(params: {
  bucket: string;
  key: string;
}): Promise<string | null> {
  try {
    const res = await s3.send(
      new HeadObjectCommand({ Bucket: params.bucket, Key: params.key })
    );
    return res.StorageClass ?? "STANDARD";
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Phase 4B — Destruction governance: delete an S3 object.
// -----------------------------------------------------------------------------

/** Delete an S3 object. Best-effort: errors are caught and returned as a
 *  bounded reason string so the caller can persist the failure without
 *  throwing. */
export async function deleteObject(params: {
  bucket: string;
  key: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
      })
    );
    return { ok: true };
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message.slice(0, 200)
        : "unknown_delete_error";
    return { ok: false, error: msg };
  }
}