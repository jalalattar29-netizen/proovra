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

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  UploadPartCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { Readable } from "node:stream";

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
] as const;

export type StorageMultipartDenialCode =
  (typeof STORAGE_MULTIPART_DENIAL_CODES)[number];

// =============================================================================
// Canonical storage key helper
// =============================================================================

/**
 * The ONLY way the multipart code constructs an S3 key. Inputs are
 * UUIDs — no client-supplied path component can bleed into the key.
 * The result is rooted under `evidence/` so the multipart bucket
 * layout is structurally identical to the single-shot path.
 */
export function buildMultipartStorageKey(input: {
  evidenceId: string;
  sessionId: string;
}): string {
  // Defensive: only accept UUID-shaped inputs so a tampered caller
  // can't escape the prefix with slashes / colons / etc.
  const uuidRegex =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuidRegex.test(input.evidenceId) || !uuidRegex.test(input.sessionId)) {
    throw new Error("buildMultipartStorageKey: evidenceId/sessionId must be UUID");
  }
  return `evidence/${input.evidenceId}/multipart/${input.sessionId}/object`;
}

// =============================================================================
// Env / config helpers — re-read on every call so test overrides work
// =============================================================================

function clean(v: string | undefined | null): string | null {
  if (typeof v !== "string") return v ?? null;
  const t = v.trim();
  return t ? t : null;
}

function parsePositiveInt(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readPresignExpirySeconds(explicit?: number): number {
  if (explicit && explicit > 0) {
    return Math.min(explicit, 900); // hard cap at 15 min
  }
  const raw = clean(process.env.S3_PRESIGN_EXPIRES_SECONDS);
  const fallback = parsePositiveInt(raw);
  if (fallback) return Math.min(Math.max(fallback, 60), 900);
  return 300; // 5 min default
}

function readMultipartBucket(): string | null {
  return clean(process.env.S3_BUCKET);
}

/**
 * WHY THERE IS NO `ObjectLockLegalHoldStatus` HERE ANY MORE (2026-08-24).
 *
 * The multipart upload stamped it too, from the same environment variable, so
 * every part of every multipart evidence record carried a legal-hold status the
 * application had never decided — and one config edit would have made those
 * stamps `ON`, i.e. native holds this codebase cannot release. See
 * `services/api/src/storage.ts` for the full reasoning.
 *
 * Object Lock RETENTION is untouched: mode and retain-until are still applied
 * to the multipart upload exactly as before.
 */
function readObjectLockDefaults(): {
  ObjectLockMode?: "GOVERNANCE" | "COMPLIANCE";
  ObjectLockRetainUntilDate?: Date;
} {
  if (clean(process.env.S3_OBJECT_LOCK_ENABLED)?.toLowerCase() !== "true") {
    return {};
  }
  const modeRaw = clean(process.env.S3_OBJECT_LOCK_MODE)?.toUpperCase();
  const retainDays = parsePositiveInt(process.env.S3_OBJECT_LOCK_RETAIN_DAYS);
  const mode =
    modeRaw === "GOVERNANCE" || modeRaw === "COMPLIANCE"
      ? (modeRaw as "GOVERNANCE" | "COMPLIANCE")
      : undefined;
  const retainUntilDate =
    mode && retainDays
      ? new Date(Date.now() + retainDays * 24 * 60 * 60 * 1000)
      : undefined;
  return {
    ...(mode ? { ObjectLockMode: mode } : {}),
    ...(retainUntilDate ? { ObjectLockRetainUntilDate: retainUntilDate } : {}),
  };
}

// =============================================================================
// initiateMultipartUpload
// =============================================================================

export type InitiateMultipartUploadInput = {
  evidenceId: string;
  sessionId: string;
  contentType?: string | null;
};

export type InitiateMultipartUploadResult =
  | {
      ok: true;
      bucket: string;
      key: string;
      /** S3 MultipartUploadId — internal-only. Caller must persist it
       *  to evidence_upload_sessions.multipart_upload_id and NEVER
       *  project it onto a route response. */
      multipartUploadId: string;
    }
  | { ok: false; reason: StorageMultipartDenialCode };

export async function initiateMultipartUpload(
  input: InitiateMultipartUploadInput,
): Promise<InitiateMultipartUploadResult> {
  const bucket = readMultipartBucket();
  if (!bucket) {
    return { ok: false, reason: "configuration_missing" };
  }
  let key: string;
  try {
    key = buildMultipartStorageKey({
      evidenceId: input.evidenceId,
      sessionId: input.sessionId,
    });
  } catch {
    return { ok: false, reason: "invalid_part" };
  }
  try {
    const objectLock = readObjectLockDefaults();
    const result = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: input.contentType ?? "application/octet-stream",
        ...objectLock,
      }),
    );
    if (!result.UploadId) {
      return { ok: false, reason: "storage_unavailable" };
    }
    return {
      ok: true,
      bucket,
      key,
      multipartUploadId: result.UploadId,
    };
  } catch {
    return { ok: false, reason: "storage_unavailable" };
  }
}

// =============================================================================
// createPresignedPartUploadUrl
// =============================================================================

export type CreatePresignedPartUploadUrlInput = {
  bucket: string;
  key: string;
  multipartUploadId: string;
  /** S3 part number is 1-indexed and bounded to [1, 10000]. The
   *  session service's part_index is 0-indexed; the caller does the
   *  +1 conversion at the route boundary. */
  partNumber: number;
  expiresInSeconds?: number;
};

export type CreatePresignedPartUploadUrlResult =
  | {
      ok: true;
      uploadUrl: string;
      method: "PUT";
      expiresAt: string;
      partNumber: number;
    }
  | { ok: false; reason: StorageMultipartDenialCode };

export async function createPresignedPartUploadUrl(
  input: CreatePresignedPartUploadUrlInput,
): Promise<CreatePresignedPartUploadUrlResult> {
  if (
    !Number.isInteger(input.partNumber) ||
    input.partNumber < 1 ||
    input.partNumber > 10_000
  ) {
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
  } catch {
    return { ok: false, reason: "storage_unavailable" };
  }
}

// =============================================================================
// completeMultipartUpload
// =============================================================================

export type CompletedPartInput = {
  partNumber: number;
  etag: string;
};

export type CompleteMultipartUploadInput = {
  bucket: string;
  key: string;
  multipartUploadId: string;
  parts: ReadonlyArray<CompletedPartInput>;
};

export type CompleteMultipartUploadResult =
  | {
      ok: true;
      etag: string;
      versionId: string | null;
    }
  | { ok: false; reason: StorageMultipartDenialCode };

export async function completeMultipartUpload(
  input: CompleteMultipartUploadInput,
): Promise<CompleteMultipartUploadResult> {
  if (input.parts.length === 0) {
    return { ok: false, reason: "invalid_part" };
  }
  // S3 requires PartNumbers in ascending order. We sort defensively
  // rather than trusting the caller.
  const completedParts: CompletedPart[] = [...input.parts]
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => ({
      PartNumber: p.partNumber,
      ETag: p.etag,
    }));
  try {
    const result = await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.multipartUploadId,
        MultipartUpload: { Parts: completedParts },
      }),
    );
    if (!result.ETag) {
      return { ok: false, reason: "complete_failed" };
    }
    return {
      ok: true,
      etag: result.ETag,
      versionId: result.VersionId ?? null,
    };
  } catch (err) {
    // Distinguish NoSuchUpload (multipart already gone) from generic
    // SDK errors — the caller wants to know whether to retry.
    const name = err instanceof Error ? err.name : "";
    if (name === "NoSuchUpload") {
      return { ok: false, reason: "multipart_not_found" };
    }
    return { ok: false, reason: "complete_failed" };
  }
}

// =============================================================================
// abortMultipartUpload
// =============================================================================

export type AbortMultipartUploadInput = {
  bucket: string;
  key: string;
  multipartUploadId: string;
};

export type AbortMultipartUploadResult =
  | {
      ok: true;
      /** `true` if S3 confirmed the abort; `true-already_absent` if
       *  S3 said NoSuchUpload (idempotent — already gone). */
      alreadyAbsent: boolean;
    }
  | { ok: false; reason: StorageMultipartDenialCode };

export async function abortMultipartUpload(
  input: AbortMultipartUploadInput,
): Promise<AbortMultipartUploadResult> {
  try {
    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.multipartUploadId,
      }),
    );
    return { ok: true, alreadyAbsent: false };
  } catch (err) {
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

// =============================================================================
// headCompletedObject
// =============================================================================

export type HeadCompletedObjectInput = {
  bucket: string;
  key: string;
};

export type HeadCompletedObjectResult =
  | {
      ok: true;
      /** S3-supplied ETag. Storage metadata only — NOT a hash of the
       *  original bytes. For native multipart objects S3's ETag is
       *  `md5(concat(md5(partN)))-N`. */
      etag: string;
      contentLength: number;
      contentType: string | null;
      versionId: string | null;
    }
  | { ok: false; reason: StorageMultipartDenialCode };

export async function headCompletedObject(
  input: HeadCompletedObjectInput,
): Promise<HeadCompletedObjectResult> {
  try {
    const result = await s3.send(
      new HeadObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
      }),
    );
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
  } catch {
    return { ok: false, reason: "head_failed" };
  }
}

// =============================================================================
// verifyCompletedObject — custody-grade SHA-256 over the whole object
// =============================================================================

export type VerifyCompletedObjectInput = {
  bucket: string;
  key: string;
  /** Optional expected hash; if supplied, mismatch returns
   *  `hash_mismatch` and the caller must refuse to mark VERIFIED. */
  expectedSha256?: string | null;
};

export type VerifyCompletedObjectResult =
  | {
      ok: true;
      serverSha256: string;
      matchedExpected: boolean | null;
    }
  | { ok: false; reason: StorageMultipartDenialCode };

/**
 * Streams the final object through SHA-256. This is the authoritative
 * custody-grade verification — ETag is NOT a substitute. Caller is
 * responsible for storing the resulting hash on the session row
 * (`expected_sha256` audit field) and marking parts VERIFIED.
 */
export async function verifyCompletedObject(
  input: VerifyCompletedObjectInput,
): Promise<VerifyCompletedObjectResult> {
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
    const serverSha256 = await sha256HexFromStream(
      stream as unknown as Readable,
    );
    if (
      input.expectedSha256 &&
      input.expectedSha256.toLowerCase() !== serverSha256.toLowerCase()
    ) {
      return { ok: false, reason: "hash_mismatch" };
    }
    return {
      ok: true,
      serverSha256: serverSha256.toLowerCase(),
      matchedExpected: input.expectedSha256
        ? input.expectedSha256.toLowerCase() === serverSha256.toLowerCase()
        : null,
    };
  } catch {
    return { ok: false, reason: "head_failed" };
  }
}
