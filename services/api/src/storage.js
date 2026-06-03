import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, GetObjectLockConfigurationCommand, PutObjectLegalHoldCommand, PutObjectRetentionCommand, CopyObjectCommand, RestoreObjectCommand, DeleteObjectCommand, } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
// Phase O1.4 — bounded S3 spans. Attributes carry the bucket name +
// bounded key prefix (first 64 chars). NEVER the signed URL, body
// bytes, or credentials.
import { PROOVRA_SPAN_NAMES, withProovraSpan, } from "./observability/otel.js";
function boundedKeyAttr(key) {
    return key.length > 64 ? key.slice(0, 64) + "…" : key;
}
function must(name) {
    const v = process.env[name];
    if (!v || !v.trim())
        throw new Error(`${name} is not set`);
    return v.trim();
}
function clean(v) {
    if (typeof v !== "string")
        return v ?? null;
    const t = v.trim();
    return t ? t : null;
}
function requireTls(endpoint) {
    if (!endpoint)
        return;
    const allowInsecure = process.env.S3_ALLOW_INSECURE === "true";
    if (process.env.NODE_ENV === "production" &&
        endpoint.startsWith("http://") &&
        !allowInsecure) {
        throw new Error("S3_ENDPOINT must use https in production");
    }
}
function normBaseUrl(url) {
    return url.replace(/\/+$/, "");
}
function isProbablyS3ApiEndpoint(url) {
    const u = url.toLowerCase();
    return (u.includes(".r2.cloudflarestorage.com") ||
        u.includes("amazonaws.com") ||
        u.includes("storage.googleapis.com"));
}
/**
 * IMPORTANT:
 * S3_PUBLIC_BASE_URL must be a real public serving domain (custom domain / CDN),
 * not the raw S3 API endpoint.
 */
export function getPublicBaseUrl() {
    const base = clean(process.env.S3_PUBLIC_BASE_URL);
    if (!base)
        return null;
    const assumePublic = process.env.S3_PUBLIC_ASSUME_PUBLIC === "true";
    const normalized = normBaseUrl(base);
    if (!assumePublic && isProbablyS3ApiEndpoint(normalized)) {
        return null;
    }
    return normalized;
}
function normalizeContentType(contentType) {
    const trimmed = contentType.trim().toLowerCase();
    if (!trimmed)
        return "application/octet-stream";
    if (trimmed.length > 128)
        return "application/octet-stream";
    if (/[\r\n]/.test(trimmed))
        return "application/octet-stream";
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(trimmed)) {
        return "application/octet-stream";
    }
    return trimmed;
}
function normalizeBase64Value(value) {
    const raw = clean(value);
    if (!raw)
        return undefined;
    if (raw.length > 128)
        return undefined;
    if (/[\r\n]/.test(raw))
        return undefined;
    if (!/^[A-Za-z0-9+/=]+$/.test(raw))
        return undefined;
    return raw;
}
function normalizeChecksumSha256Base64(value) {
    return normalizeBase64Value(value);
}
function normalizeContentMd5Base64(value) {
    return normalizeBase64Value(value);
}
function normalizeMetadata(metadata) {
    if (!metadata)
        return undefined;
    const out = {};
    for (const [key, value] of Object.entries(metadata)) {
        const normalizedKey = key.trim().toLowerCase();
        const normalizedValue = clean(value);
        if (!normalizedKey || !normalizedValue)
            continue;
        if (normalizedKey.length > 128)
            continue;
        if (normalizedValue.length > 1024)
            continue;
        if (/[\r\n]/.test(normalizedKey) || /[\r\n]/.test(normalizedValue))
            continue;
        out[normalizedKey] = normalizedValue;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
function isObjectTaggingEnabled() {
    return clean(process.env.S3_ENABLE_OBJECT_TAGGING)?.toLowerCase() === "true";
}
function normalizeTagging(tags) {
    if (!tags)
        return undefined;
    if (!isObjectTaggingEnabled())
        return undefined;
    const parts = [];
    for (const [key, value] of Object.entries(tags)) {
        const k = clean(key);
        const v = clean(value);
        if (!k || !v)
            continue;
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
    return parts.length > 0 ? parts.join("&") : undefined;
}
function parsePositiveInt(value) {
    const raw = clean(value);
    if (!raw)
        return null;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return null;
    return parsed;
}
function isObjectLockEnabled() {
    return clean(process.env.S3_OBJECT_LOCK_ENABLED)?.toLowerCase() === "true";
}
function readObjectLockDefaults() {
    if (!isObjectLockEnabled()) {
        return {};
    }
    const modeRaw = clean(process.env.S3_OBJECT_LOCK_MODE)?.toUpperCase();
    const legalHoldRaw = clean(process.env.S3_OBJECT_LOCK_LEGAL_HOLD)?.toUpperCase();
    const retainDays = parsePositiveInt(process.env.S3_OBJECT_LOCK_RETAIN_DAYS);
    const mode = modeRaw === "GOVERNANCE" || modeRaw === "COMPLIANCE"
        ? modeRaw
        : undefined;
    const legalHold = legalHoldRaw === "ON" || legalHoldRaw === "OFF"
        ? legalHoldRaw
        : undefined;
    const retainUntilDate = mode && retainDays
        ? new Date(Date.now() + retainDays * 24 * 60 * 60 * 1000)
        : undefined;
    return {
        mode,
        retainUntilDate,
        legalHold,
    };
}
function readPresignExpirySeconds(explicit) {
    const fallbackRaw = clean(process.env.S3_PRESIGN_EXPIRES_SECONDS);
    const fallbackParsed = fallbackRaw ? Number.parseInt(fallbackRaw, 10) : 600;
    const base = explicit ?? fallbackParsed;
    if (!Number.isFinite(base))
        return 600;
    if (base < 60)
        return 60;
    if (base > 900)
        return 900;
    return base;
}
function sha256Base64(buffer) {
    return createHash("sha256").update(buffer).digest("base64");
}
function md5Base64(buffer) {
    return createHash("md5").update(buffer).digest("base64");
}
function buildS3ClientConfig() {
    const endpoint = clean(process.env.S3_ENDPOINT);
    requireTls(endpoint);
    const forcePathStyleRaw = clean(process.env.S3_FORCE_PATH_STYLE)?.toLowerCase();
    const config = {
        region: clean(process.env.S3_REGION) ?? "eu-central-1",
        credentials: {
            accessKeyId: must("S3_ACCESS_KEY"),
            secretAccessKey: must("S3_SECRET_KEY"),
        },
        forcePathStyle: forcePathStyleRaw === "true"
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
export async function presignPutObject(params) {
    const bucket = clean(params.bucket);
    const key = clean(params.key);
    if (!bucket || !key) {
        throw new Error("presignPutObject: bucket/key are required");
    }
    const normalizedContentType = normalizeContentType(params.contentType);
    const normalizedChecksum = normalizeChecksumSha256Base64(params.checksumSha256Base64);
    const normalizedContentMd5 = normalizeContentMd5Base64(params.contentMd5Base64);
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
    const signableHeaders = new Set(["content-type"]);
    const unhoistableHeaders = new Set();
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
export async function presignGetObject(params) {
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
export async function putObjectBuffer(params) {
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
    const objectLock = params.immutable && isObjectLockEnabled() ? readObjectLockDefaults() : {};
    const checksumSha256Base64 = sha256Base64(params.body);
    const contentMd5Base64 = md5Base64(params.body);
    // Phase O1.4 — bounded S3 PUT span.
    await withProovraSpan(PROOVRA_SPAN_NAMES.S3_PUT_OBJECT, {
        "proovra.bucket": bucket,
        "proovra.s3.key_prefix": boundedKeyAttr(key),
        "proovra.operation": "put_object",
        "proovra.size_bytes": params.body.length,
        "proovra.immutable": Boolean(params.immutable),
    }, async () => {
        await s3.send(new PutObjectCommand({
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
        }));
    });
}
export async function applyObjectRetention(params) {
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
        await s3.send(new PutObjectRetentionCommand({
            Bucket: bucket,
            Key: key,
            Retention: {
                Mode: params.mode,
                RetainUntilDate: params.retainUntilDate,
            },
            ...(params.bypassGovernance ? { BypassGovernanceRetention: true } : {}),
        }));
    }
    if (params.legalHold) {
        await s3.send(new PutObjectLegalHoldCommand({
            Bucket: bucket,
            Key: key,
            LegalHold: {
                Status: params.legalHold,
            },
        }));
    }
    return {
        applied: true,
    };
}
export async function applyDefaultObjectRetention(params) {
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
export async function headObject(params) {
    const bucket = clean(params.bucket);
    const key = clean(params.key);
    if (!bucket || !key) {
        throw new Error("headObject: bucket/key are required");
    }
    // Phase O1.4 — bounded S3 HEAD span.
    return withProovraSpan(PROOVRA_SPAN_NAMES.S3_HEAD_OBJECT, {
        "proovra.bucket": bucket,
        "proovra.s3.key_prefix": boundedKeyAttr(key),
        "proovra.operation": "head_object",
    }, async () => {
        const res = await s3.send(new HeadObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
        return {
            sizeBytes: res.ContentLength ?? null,
            contentType: res.ContentType ?? null,
            etag: res.ETag ?? null,
            metadata: res.Metadata ?? null,
            objectLockMode: res.ObjectLockMode ?? null,
            objectLockRetainUntilDate: res.ObjectLockRetainUntilDate ?? null,
            objectLockLegalHoldStatus: res.ObjectLockLegalHoldStatus ?? null,
        };
    });
}
export async function getObjectStream(params) {
    const bucket = clean(params.bucket);
    const key = clean(params.key);
    if (!bucket || !key) {
        throw new Error("getObjectStream: bucket/key are required");
    }
    // Phase O1.4 — bounded S3 GET span.
    return withProovraSpan(PROOVRA_SPAN_NAMES.S3_GET_OBJECT, {
        "proovra.bucket": bucket,
        "proovra.s3.key_prefix": boundedKeyAttr(key),
        "proovra.operation": "get_object",
    }, async () => {
        const res = await s3.send(new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
        if (!res.Body)
            throw new Error("S3 returned empty body");
        return res.Body;
    });
}
export async function getObjectRange(params) {
    const bucket = clean(params.bucket);
    const key = clean(params.key);
    if (!bucket || !key || !params.range) {
        throw new Error("getObjectRange: bucket/key/range are required");
    }
    const res = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: params.range,
    }));
    if (!res.Body)
        throw new Error("S3 returned empty body");
    return streamToBuffer(res.Body);
}
async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        if (typeof chunk === "string") {
            chunks.push(Buffer.from(chunk));
        }
        else if (Buffer.isBuffer(chunk)) {
            chunks.push(chunk);
        }
        else {
            chunks.push(Buffer.from(chunk));
        }
    }
    return Buffer.concat(chunks);
}
export async function verifyObjectLockConfiguration() {
    if (!isObjectLockEnabled()) {
        return { mode: "disabled" };
    }
    const bucket = clean(process.env.S3_BUCKET);
    if (!bucket) {
        return { mode: "skipped", reason: "S3_BUCKET not configured" };
    }
    try {
        const res = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
        const cfg = res.ObjectLockConfiguration;
        const objectLockEnabled = String(cfg?.ObjectLockEnabled ?? "").toLowerCase() === "enabled";
        if (!objectLockEnabled) {
            return {
                mode: "claimed-but-unsupported",
                bucket,
                reason: "GetObjectLockConfiguration returned a configuration but ObjectLockEnabled is not 'Enabled'",
            };
        }
        return {
            mode: "verified",
            configured: {
                objectLockEnabled,
                defaultMode: cfg?.Rule?.DefaultRetention?.Mode ?? null,
                defaultRetainDays: cfg?.Rule?.DefaultRetention?.Days ??
                    (typeof cfg?.Rule?.DefaultRetention?.Years === "number"
                        ? cfg.Rule.DefaultRetention.Years * 365
                        : null),
                bucket,
            },
        };
    }
    catch (err) {
        const errObj = err;
        const code = String(errObj?.Code ?? errObj?.code ?? errObj?.name ?? "");
        const msg = String(errObj?.message ?? "");
        // S3 returns ObjectLockConfigurationNotFoundError when the bucket exists
        // but Object Lock was never enabled at bucket creation time.
        if (code.includes("ObjectLockConfigurationNotFoundError") ||
            msg.includes("Object Lock configuration does not exist") ||
            msg.includes("ObjectLockConfigurationNotFound")) {
            return {
                mode: "claimed-but-unsupported",
                bucket,
                reason: "Bucket has no Object Lock configuration. Object Lock can only be enabled at bucket creation time on AWS S3.",
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
export async function copyObjectStorageClass(params) {
    await s3.send(new CopyObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
        CopySource: `${params.bucket}/${params.key}`,
        StorageClass: params.storageClass,
        MetadataDirective: "COPY",
    }));
}
/** Initiate a Glacier restore for a COLD/DEEP_ARCHIVE object. */
export async function restoreObject(params) {
    await s3.send(new RestoreObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
        RestoreRequest: { Days: params.days ?? 7, GlacierJobParameters: { Tier: "Standard" } },
    }));
}
/** Return the current storage class of an S3 object, or null if unknown. */
export async function headObjectStorageClass(params) {
    try {
        const res = await s3.send(new HeadObjectCommand({ Bucket: params.bucket, Key: params.key }));
        return res.StorageClass ?? "STANDARD";
    }
    catch {
        return null;
    }
}
// -----------------------------------------------------------------------------
// Phase 4B — Destruction governance: delete an S3 object.
// -----------------------------------------------------------------------------
/** Delete an S3 object. Best-effort: errors are caught and returned as a
 *  bounded reason string so the caller can persist the failure without
 *  throwing. */
export async function deleteObject(params) {
    try {
        await s3.send(new DeleteObjectCommand({
            Bucket: params.bucket,
            Key: params.key,
        }));
        return { ok: true };
    }
    catch (err) {
        const msg = err instanceof Error
            ? err.message.slice(0, 200)
            : "unknown_delete_error";
        return { ok: false, error: msg };
    }
}
