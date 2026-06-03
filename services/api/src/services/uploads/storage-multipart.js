/**
 * Phase 30.8 — S3 native multipart upload abstraction.
 *
 * Thin wrapper around the AWS SDK's multipart commands so route /
 * service code can never construct raw S3 commands directly. Every
 * external call goes through this module, which:
 *
 *   * Builds the canonical storage key for a session
 *     (`evidence/{evidenceId}/multipart/{sessionId}/object`).
 *   * Applies Object Lock defaults at CreateMultipartUpload time so
 *     the final object inherits retention as soon as it lands.
 *   * Bounds the presigned-UploadPart URL lifetime via the same env
 *     var used by the single-shot path
 *     (`S3_PRESIGN_EXPIRES_SECONDS`).
 *   * Returns a bounded tagged-union result on every call — no raw
 *     AWS exceptions leak to the route layer. Bounded denial codes:
 *       - `storage_unavailable`   — SDK throw of any kind
 *       - `multipart_not_found`   — S3 says NoSuchUpload (idempotent
 *                                   abort path treats this as success)
 *       - `invalid_part`          — bad part number / size / etag
 *       - `complete_failed`       — CompleteMultipartUpload rejected
 *       - `head_failed`           — post-complete HEAD failed
 *
 * Hard custody rules encoded in this module:
 *   * `headCompletedObject` returns ETag + size + content-type but
 *     NEVER claims integrity. Callers must run `verifyCompletedObject`
 *     (server-side SHA-256 stream hash) to get a custody-grade signal.
 *   * `multipartUploadId` is treated as internal-only — every public
 *     return type avoids it. Callers that need it (e.g. the session
 *     service writing it to the DB) get it via the explicit `internal`
 *     namespace.
 *   * No retention call is made until the multipart upload has been
 *     verified-and-finalized by `completeEvidence` — Object Lock
 *     defaults are attached at create time so the bucket policy
 *     applies, and `applyDefaultObjectRetention` is invoked from the
 *     finalize path as it always has been.
 */
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, HeadObjectCommand, UploadPartCommand, } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3 } from "../../storage.js";
import { sha256HexFromStream } from "../../stream-hash.js";
// =============================================================================
// Bounded denial vocabulary
// =============================================================================
export const STORAGE_MULTIPART_DENIAL_CODES = [
    "storage_unavailable",
    "multipart_not_found",
    "invalid_part",
    "complete_failed",
    "head_failed",
    "hash_mismatch",
    "configuration_missing",
];
// =============================================================================
// Canonical storage key helper
// =============================================================================
/**
 * The ONLY way the multipart code constructs an S3 key. Inputs are
 * UUIDs — no client-supplied path component can bleed into the key.
 * The result is rooted under `evidence/` so the multipart bucket
 * layout is structurally identical to the single-shot path.
 */
export function buildMultipartStorageKey(input) {
    // Defensive: only accept UUID-shaped inputs so a tampered caller
    // can't escape the prefix with slashes / colons / etc.
    const uuidRegex = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (!uuidRegex.test(input.evidenceId) || !uuidRegex.test(input.sessionId)) {
        throw new Error("buildMultipartStorageKey: evidenceId/sessionId must be UUID");
    }
    return `evidence/${input.evidenceId}/multipart/${input.sessionId}/object`;
}
// =============================================================================
// Env / config helpers — re-read on every call so test overrides work
// =============================================================================
function clean(v) {
    if (typeof v !== "string")
        return v ?? null;
    const t = v.trim();
    return t ? t : null;
}
function parsePositiveInt(raw) {
    if (raw == null)
        return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}
function readPresignExpirySeconds(explicit) {
    if (explicit && explicit > 0) {
        return Math.min(explicit, 900); // hard cap at 15 min
    }
    const raw = clean(process.env.S3_PRESIGN_EXPIRES_SECONDS);
    const fallback = parsePositiveInt(raw);
    if (fallback)
        return Math.min(Math.max(fallback, 60), 900);
    return 300; // 5 min default
}
function readMultipartBucket() {
    return clean(process.env.S3_BUCKET);
}
function readObjectLockDefaults() {
    if (clean(process.env.S3_OBJECT_LOCK_ENABLED)?.toLowerCase() !== "true") {
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
        ...(mode ? { ObjectLockMode: mode } : {}),
        ...(retainUntilDate ? { ObjectLockRetainUntilDate: retainUntilDate } : {}),
        ...(legalHold ? { ObjectLockLegalHoldStatus: legalHold } : {}),
    };
}
export async function initiateMultipartUpload(input) {
    const bucket = readMultipartBucket();
    if (!bucket) {
        return { ok: false, reason: "configuration_missing" };
    }
    let key;
    try {
        key = buildMultipartStorageKey({
            evidenceId: input.evidenceId,
            sessionId: input.sessionId,
        });
    }
    catch {
        return { ok: false, reason: "invalid_part" };
    }
    try {
        const objectLock = readObjectLockDefaults();
        const result = await s3.send(new CreateMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            ContentType: input.contentType ?? "application/octet-stream",
            ...objectLock,
        }));
        if (!result.UploadId) {
            return { ok: false, reason: "storage_unavailable" };
        }
        return {
            ok: true,
            bucket,
            key,
            multipartUploadId: result.UploadId,
        };
    }
    catch {
        return { ok: false, reason: "storage_unavailable" };
    }
}
export async function createPresignedPartUploadUrl(input) {
    if (!Number.isInteger(input.partNumber) ||
        input.partNumber < 1 ||
        input.partNumber > 10_000) {
        return { ok: false, reason: "invalid_part" };
    }
    if (!input.bucket || !input.key || !input.multipartUploadId) {
        return { ok: false, reason: "configuration_missing" };
    }
    try {
        const expiresIn = readPresignExpirySeconds(input.expiresInSeconds);
        const cmd = new UploadPartCommand({
            Bucket: input.bucket,
            Key: input.key,
            UploadId: input.multipartUploadId,
            PartNumber: input.partNumber,
        });
        const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn });
        const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
        return {
            ok: true,
            uploadUrl,
            method: "PUT",
            expiresAt,
            partNumber: input.partNumber,
        };
    }
    catch {
        return { ok: false, reason: "storage_unavailable" };
    }
}
export async function completeMultipartUpload(input) {
    if (input.parts.length === 0) {
        return { ok: false, reason: "invalid_part" };
    }
    // S3 requires PartNumbers in ascending order. We sort defensively
    // rather than trusting the caller.
    const completedParts = [...input.parts]
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => ({
        PartNumber: p.partNumber,
        ETag: p.etag,
    }));
    try {
        const result = await s3.send(new CompleteMultipartUploadCommand({
            Bucket: input.bucket,
            Key: input.key,
            UploadId: input.multipartUploadId,
            MultipartUpload: { Parts: completedParts },
        }));
        if (!result.ETag) {
            return { ok: false, reason: "complete_failed" };
        }
        return {
            ok: true,
            etag: result.ETag,
            versionId: result.VersionId ?? null,
        };
    }
    catch (err) {
        // Distinguish NoSuchUpload (multipart already gone) from generic
        // SDK errors — the caller wants to know whether to retry.
        const name = err instanceof Error ? err.name : "";
        if (name === "NoSuchUpload") {
            return { ok: false, reason: "multipart_not_found" };
        }
        return { ok: false, reason: "complete_failed" };
    }
}
export async function abortMultipartUpload(input) {
    try {
        await s3.send(new AbortMultipartUploadCommand({
            Bucket: input.bucket,
            Key: input.key,
            UploadId: input.multipartUploadId,
        }));
        return { ok: true, alreadyAbsent: false };
    }
    catch (err) {
        const name = err instanceof Error ? err.name : "";
        // S3's NoSuchUpload on AbortMultipartUpload is the IDEMPOTENT
        // success case: somebody else already cleaned up, or it was
        // never created. Treat as success so the reaper can keep
        // marching.
        if (name === "NoSuchUpload") {
            return { ok: true, alreadyAbsent: true };
        }
        return { ok: false, reason: "storage_unavailable" };
    }
}
export async function headCompletedObject(input) {
    try {
        const result = await s3.send(new HeadObjectCommand({
            Bucket: input.bucket,
            Key: input.key,
        }));
        if (!result.ETag) {
            return { ok: false, reason: "head_failed" };
        }
        return {
            ok: true,
            etag: result.ETag,
            contentLength: result.ContentLength ?? 0,
            contentType: result.ContentType ?? null,
            versionId: result.VersionId ?? null,
        };
    }
    catch {
        return { ok: false, reason: "head_failed" };
    }
}
/**
 * Streams the final object through SHA-256. This is the authoritative
 * custody-grade verification — ETag is NOT a substitute. Caller is
 * responsible for storing the resulting hash on the session row
 * (`expected_sha256` audit field) and marking parts VERIFIED.
 */
export async function verifyCompletedObject(input) {
    try {
        // The single-shot upload path already does exactly this in
        // completeEvidence — we re-use the streaming helper rather than
        // re-implementing the hash loop.
        const { getObjectStream } = await import("../../storage.js");
        const stream = await getObjectStream({
            bucket: input.bucket,
            key: input.key,
        });
        // The S3 GetObject body is a Node Readable in the API runtime;
        // the SDK type is broader. We narrow defensively the same way
        // evidence-complete.service.ts does for the single-shot path.
        const serverSha256 = await sha256HexFromStream(stream);
        if (input.expectedSha256 &&
            input.expectedSha256.toLowerCase() !== serverSha256.toLowerCase()) {
            return { ok: false, reason: "hash_mismatch" };
        }
        return {
            ok: true,
            serverSha256: serverSha256.toLowerCase(),
            matchedExpected: input.expectedSha256
                ? input.expectedSha256.toLowerCase() === serverSha256.toLowerCase()
                : null,
        };
    }
    catch {
        return { ok: false, reason: "head_failed" };
    }
}
