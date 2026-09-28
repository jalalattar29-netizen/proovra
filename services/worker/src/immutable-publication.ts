/**
 * IMMUTABLE ARTIFACT PUBLICATION — the one way a report PDF or a verification
 * package ZIP reaches object storage.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (incident 2026-09-28, Sentry 150024171)
 * ---------------------------------------------------------------------------
 * The UC-3 streaming package path (10d43e40) published a package in two
 * steps: a `PutObject` of the temp file to a private staging key with NO
 * integrity header, then a `CopyObject` to the canonical key carrying Object
 * Lock parameters and, again, no checksum. The client is built with
 * `requestChecksumCalculation: "WHEN_REQUIRED"` and the installed SDK
 * (client-s3 3.1000.0) declares `PutObject` with `requestChecksumRequired:
 * false`, so the SDK adds nothing on its own. A bucket with Object Lock
 * default retention — or a request that carries Object Lock parameters —
 * refuses such a write with `InvalidRequest: Content-MD5 OR x-amz-checksum-
 * HTTP header is required`. Which of the two calls failed in production is
 * not provable from the error text alone; both are removed.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT
 * ---------------------------------------------------------------------------
 *   1. The caller computes the SHA-256 of the EXACT bytes it publishes, and it
 *      is sent as `x-amz-checksum-sha256`. The store validates it on receipt
 *      and keeps it, which also satisfies the Object Lock checksum rule.
 *   2. Retention is part of the same request (`ObjectLockMode` +
 *      `ObjectLockRetainUntilDate`) when Object Lock is enabled — there is no
 *      window in which the canonical object exists unprotected.
 *   3. `If-None-Match: *` — a key receives bytes ONCE. Every publication uses
 *      a fresh key (see {@link buildPublicationKey}), so a retry never writes
 *      different bytes over an earlier attempt's immutable object. A 412 on an
 *      object that already holds exactly our digest is treated as success
 *      (lost response), anything else is a conflict and is refused.
 *   4. The object is then read back BY ITS VERSION ID and must match: size,
 *      stored SHA-256, and — when Object Lock is enabled — lock mode and a
 *      retain-until date no earlier than requested. Only a verified
 *      publication is returned, and only a returned publication may be
 *      recorded as READY by a caller.
 *
 * No database transaction is open while any of this runs.
 */
import {
  HeadObjectCommand,
  PutObjectCommand,
  type ObjectLockMode,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";

import {
  isObjectLockEnabled,
  normalizeContentType,
  normalizeMetadata,
  normalizeTagging,
  readObjectLockDefaults,
  s3,
} from "./storage.js";

export type PublicationBody =
  | { kind: "buffer"; buffer: Buffer }
  | { kind: "file"; filePath: string; sizeBytes: number };

export type PublishImmutableArtifactInput = {
  bucket: string;
  key: string;
  body: PublicationBody;
  /** SHA-256 of the exact bytes in `body`, base64 of the raw 32-byte digest. */
  sha256Base64: string;
  contentType: string;
  metadata?: Record<string, string | null | undefined>;
  tags?: Record<string, string | null | undefined>;
};

export type PublishedArtifact = {
  bucket: string;
  key: string;
  /** Null only where the store does not version (Object Lock disabled). */
  versionId: string | null;
  sizeBytes: number;
  sha256Base64: string;
  sha256Hex: string;
  objectLockMode: string | null;
  objectLockRetainUntilUtc: Date | null;
  objectLockLegalHoldStatus: string | null;
};

/** A deterministic storage refusal that no retry of the same request can fix. */
export class StoragePublicationRejectedError extends Error {
  readonly code: string;
  readonly retriable = false;
  readonly storageCode: string;
  constructor(storageCode: string, message: string) {
    super(message);
    this.name = "StoragePublicationRejectedError";
    this.storageCode = storageCode;
    this.code = `STORAGE_PUBLICATION_REJECTED`;
  }
}

/** The published object does not match what was sent. Never marked READY. */
export class StoragePublicationVerifyError extends Error {
  readonly code = "STORAGE_PUBLICATION_UNVERIFIED";
  readonly retriable = true;
  readonly mismatches: string[];
  constructor(mismatches: string[]) {
    super(`STORAGE_PUBLICATION_UNVERIFIED:${mismatches.join(",")}`);
    this.name = "StoragePublicationVerifyError";
    this.mismatches = mismatches;
  }
}

/**
 * S3 error codes that describe the REQUEST or the BUCKET, not a moment in
 * time. Retrying an identical request cannot succeed; burning the retry budget
 * on them is what turned the Object Lock incident into twelve identical
 * failures before anyone was told.
 */
const DETERMINISTIC_STORAGE_CODES = new Set([
  "InvalidRequest",
  "InvalidArgument",
  "AccessDenied",
  "NoSuchBucket",
  "InvalidBucketState",
  "MissingContentMD5",
  "InvalidDigest",
  "MalformedXML",
  "NotImplemented",
  "InvalidRetentionPeriod",
  "ObjectLockConfigurationNotFoundError",
]);

export function storageErrorCode(err: unknown): string {
  const e = err as { name?: unknown; Code?: unknown; code?: unknown } | null;
  return String(e?.Code ?? e?.name ?? e?.code ?? "").slice(0, 64) || "Unknown";
}

export function isDeterministicStorageRejection(err: unknown): boolean {
  return DETERMINISTIC_STORAGE_CODES.has(storageErrorCode(err));
}

function isPreconditionFailed(err: unknown): boolean {
  const code = storageErrorCode(err);
  const status = (err as { $metadata?: { httpStatusCode?: number } } | null)
    ?.$metadata?.httpStatusCode;
  return code === "PreconditionFailed" || status === 412;
}

/**
 * A fresh, never-reused key for one publication attempt.
 *
 * `reports/<evidenceId>/v<version>/<requestId>-<nonce>.pdf`. The version and
 * request id are there for humans and for the orphan inventory; the nonce is
 * what guarantees an attempt never shares a key with another attempt.
 */
export function buildPublicationKey(input: {
  family: "reports" | "verification";
  evidenceId: string;
  version: number;
  requestId: string;
  extension: "pdf" | "zip";
  nonce?: string;
}): string {
  const nonce = (input.nonce ?? randomUUID()).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 36);
  const req = input.requestId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 36);
  return `${input.family}/${input.evidenceId}/v${input.version}/${req}-${nonce}.${input.extension}`;
}

export function base64ToHex(b64: string): string {
  return Buffer.from(b64, "base64").toString("hex");
}

/**
 * PURE: compare what the store reports against what was sent.
 * Returns the list of mismatching properties; empty means verified.
 */
export function comparePublishedObject(input: {
  expected: {
    sizeBytes: number;
    sha256Base64: string;
    objectLockMode: ObjectLockMode | null;
    minimumRetainUntil: Date | null;
  };
  observed: {
    sizeBytes: number | null;
    checksumSha256: string | null;
    objectLockMode: string | null;
    objectLockRetainUntil: Date | null;
  };
}): string[] {
  const out: string[] = [];
  if (input.observed.sizeBytes !== input.expected.sizeBytes) out.push("size");
  // A multipart checksum is `<b64>-<parts>`; we never upload multipart here,
  // so anything but the exact full-object digest is a mismatch.
  if (input.observed.checksumSha256 !== input.expected.sha256Base64) out.push("sha256");
  if (input.expected.objectLockMode) {
    if (input.observed.objectLockMode !== input.expected.objectLockMode) {
      out.push("object_lock_mode");
    }
    if (input.expected.minimumRetainUntil) {
      const observed = input.observed.objectLockRetainUntil?.getTime() ?? null;
      // One second of tolerance for provider rounding of the date.
      if (observed === null || observed + 1000 < input.expected.minimumRetainUntil.getTime()) {
        out.push("object_lock_retain_until");
      }
    }
  }
  return out;
}

async function headVersion(bucket: string, key: string, versionId: string | null) {
  const res = await s3.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(versionId ? { VersionId: versionId } : {}),
      ChecksumMode: "ENABLED",
    }),
  );
  return {
    versionId: res.VersionId ?? versionId ?? null,
    sizeBytes: typeof res.ContentLength === "number" ? res.ContentLength : null,
    checksumSha256: res.ChecksumSHA256 ?? null,
    objectLockMode: res.ObjectLockMode ? String(res.ObjectLockMode) : null,
    objectLockRetainUntil: res.ObjectLockRetainUntilDate ?? null,
    legalHold: res.ObjectLockLegalHoldStatus ? String(res.ObjectLockLegalHoldStatus) : null,
  };
}

/**
 * Publish one immutable artifact and prove it landed as sent.
 *
 * Throws {@link StoragePublicationRejectedError} (non-retriable) for a
 * deterministic storage refusal, {@link StoragePublicationVerifyError}
 * (retriable) when the read-back disagrees, and the raw SDK error for a
 * transient failure (retriable by the caller's default).
 */
export async function publishImmutableArtifact(
  input: PublishImmutableArtifactInput,
): Promise<PublishedArtifact> {
  const sizeBytes =
    input.body.kind === "buffer" ? input.body.buffer.length : input.body.sizeBytes;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new StoragePublicationRejectedError("EmptyBody", "publication body is empty");
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(input.sha256Base64)) {
    throw new StoragePublicationRejectedError(
      "InvalidDigest",
      "sha256Base64 must be the base64 of a 32-byte digest",
    );
  }

  const lockEnabled = isObjectLockEnabled();
  const lock = lockEnabled ? readObjectLockDefaults() : {};
  const metadata = normalizeMetadata(input.metadata);
  const tagging = normalizeTagging(input.tags);

  let versionId: string | null = null;
  try {
    const res = await s3.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body:
          input.body.kind === "buffer"
            ? input.body.buffer
            : createReadStream(input.body.filePath),
        ContentLength: sizeBytes,
        ContentType: normalizeContentType(input.contentType),
        ChecksumSHA256: input.sha256Base64,
        IfNoneMatch: "*",
        ...(metadata ? { Metadata: metadata } : {}),
        ...(tagging ? { Tagging: tagging } : {}),
        ...(lock.mode ? { ObjectLockMode: lock.mode } : {}),
        ...(lock.retainUntilDate ? { ObjectLockRetainUntilDate: lock.retainUntilDate } : {}),
      }),
    );
    versionId = res.VersionId ?? null;
  } catch (err) {
    if (isPreconditionFailed(err)) {
      // The key already holds an object. Our keys are single-use, so this is a
      // lost response for OUR bytes, or something else wrote here. Only the
      // former may continue — decided by the stored digest, never assumed.
      const existing = await headVersion(input.bucket, input.key, null);
      if (existing.checksumSha256 !== input.sha256Base64) {
        throw new StoragePublicationRejectedError(
          "PublicationKeyConflict",
          "publication key already holds different bytes",
        );
      }
      versionId = existing.versionId;
    } else if (isDeterministicStorageRejection(err)) {
      throw new StoragePublicationRejectedError(
        storageErrorCode(err),
        `object storage refused the publication (${storageErrorCode(err)})`,
      );
    } else {
      throw err;
    }
  }

  const observed = await headVersion(input.bucket, input.key, versionId);
  const mismatches = comparePublishedObject({
    expected: {
      sizeBytes,
      sha256Base64: input.sha256Base64,
      objectLockMode: lock.mode ?? null,
      minimumRetainUntil: lock.retainUntilDate ?? null,
    },
    observed,
  });
  if (mismatches.length > 0) throw new StoragePublicationVerifyError(mismatches);

  return {
    bucket: input.bucket,
    key: input.key,
    versionId: observed.versionId,
    sizeBytes,
    sha256Base64: input.sha256Base64,
    sha256Hex: base64ToHex(input.sha256Base64),
    objectLockMode: observed.objectLockMode,
    objectLockRetainUntilUtc: observed.objectLockRetainUntil,
    objectLockLegalHoldStatus: observed.legalHold,
  };
}
