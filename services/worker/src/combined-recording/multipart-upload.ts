/**
 * 2026-10-29 — streaming multipart upload of ONE local file to object storage.
 *
 * The worker's `putObjectBuffer` sends one in-memory Buffer, which is right for
 * a thumbnail and wrong for a recording of up to 640 MiB. This reads the file
 * one part at a time (memory bounded by `partBytes`), hashes the whole object
 * while it reads (the derived digest is of exactly the bytes sent), and uses
 * only `@aws-sdk/client-s3` commands the worker already depends on:
 * CreateMultipartUpload → UploadPart × n → CompleteMultipartUpload, with
 * AbortMultipartUpload on any failure so no orphaned parts are left behind.
 *
 * Integrity per part: Content-MD5 (required by Object Lock buckets) and a
 * SHA-256 checksum the store verifies. The record's artifact lock is applied
 * at creation, never the bucket default.
 */

import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  type ObjectLockMode,
  type S3Client,
} from "@aws-sdk/client-s3";

/** S3's minimum size for every part but the last. */
export const MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
/** S3's part-count ceiling. */
const MAX_PARTS = 10_000;

/**
 * PRO-W1C-08 — the upload reached its deadline. Every in-flight request was
 * aborted and the multipart upload was aborted at the store: nothing was
 * completed, no object version exists for it.
 */
export class MultipartUploadDeadlineExceeded extends Error {
  constructor() {
    super("multipart_upload_deadline_exceeded");
    this.name = "MultipartUploadDeadlineExceeded";
  }
}

/**
 * M676 follow-up — the upload's fence (the caller's storage reservation and
 * claim) was lost: nothing more was sent, the completion was not requested,
 * and the multipart upload was aborted at the store.
 */
export class MultipartUploadFenceLost extends Error {
  constructor() {
    super("multipart_upload_fence_lost");
    this.name = "MultipartUploadFenceLost";
  }
}

/**
 * M676 follow-up — the completion was sent but its answer never arrived
 * (deadline or transport failure) AND the upload could not be aborted
 * afterwards: the store may hold a completed object at `key` whose version
 * the caller does not know. The caller must treat the key as possibly written.
 */
export class MultipartUploadCompletionUnknown extends Error {
  constructor(
    readonly bucket: string,
    readonly key: string,
    readonly cause?: unknown,
  ) {
    super("multipart_upload_completion_unknown");
    this.name = "MultipartUploadCompletionUnknown";
  }
}

/** M676 follow-up — the default interval between fence renewals during an upload. */
export const MULTIPART_FENCE_INTERVAL_MS = 60 * 1000;

export type MultipartUploadResult = {
  versionId: string | null;
  sha256: string;
  sizeBytes: number;
  partCount: number;
};

export async function uploadFileMultipart(input: {
  client: S3Client;
  bucket: string;
  key: string;
  file: string;
  contentType: string;
  partBytes: number;
  /** The record's artifact lock (resolved by the caller); applied only when the store enforces locks. */
  lock: { mode: "GOVERNANCE" | "COMPLIANCE"; retainUntil: Date } | null;
  objectLockEnabled: boolean;
  metadata?: Record<string, string>;
  /** Refuse to send more than this many bytes. */
  maxBytes: number;
  /**
   * PRO-W1C-08 — epoch ms by which the upload must have completed. In-flight
   * requests are aborted when it passes, no further part is sent, the
   * completion is not requested, and the multipart upload is aborted at the
   * store (MultipartUploadDeadlineExceeded). Absent: unbounded, as before.
   */
  deadlineAt?: number;
  /**
   * M676 follow-up — the caller's fence (its storage reservation and claim),
   * renewed before the first part, every `fenceIntervalMs` between parts, and
   * ALWAYS immediately before the completion. Returns the epoch ms by which
   * the upload must end under the renewed fence (the effective deadline is the
   * earlier of it and `deadlineAt`), or null when the fence is lost: the
   * upload is then aborted (MultipartUploadFenceLost) and never completed.
   */
  fence?: () => Promise<{ deadlineAt: number } | null>;
  fenceIntervalMs?: number;
}): Promise<MultipartUploadResult> {
  let deadlineAt = input.deadlineAt;
  const pastDeadline = () => deadlineAt !== undefined && Date.now() >= deadlineAt;
  if (pastDeadline()) throw new MultipartUploadDeadlineExceeded();
  const partBytes = Math.max(MIN_MULTIPART_PART_BYTES, Math.trunc(input.partBytes));
  const size = (await stat(input.file)).size;
  if (size <= 0) throw new Error("multipart_upload_empty_file");
  if (size > input.maxBytes) throw new Error("multipart_upload_oversize");
  if (Math.ceil(size / partBytes) > MAX_PARTS) throw new Error("multipart_upload_too_many_parts");

  const lock = input.objectLockEnabled && input.lock ? input.lock : null;
  // One controller for the whole upload: the deadline aborts whatever request
  // is in flight (a stalled part cannot hold the attempt past its claim).
  const controller = new AbortController();
  const timer: { id: ReturnType<typeof setTimeout> | null } = { id: null };
  const disarm = () => {
    if (timer.id) clearTimeout(timer.id);
    timer.id = null;
  };
  const arm = () => {
    disarm();
    if (deadlineAt === undefined) return;
    timer.id = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()));
    timer.id.unref?.();
  };
  arm();
  const signal = { abortSignal: controller.signal };
  const deadlineHit = () => controller.signal.aborted || pastDeadline();
  // M676 follow-up — renew the fence; a lost fence stops the upload, a renewed
  // one may move the deadline (never past the caller's own `deadlineAt`).
  const fenceIntervalMs = input.fenceIntervalMs ?? MULTIPART_FENCE_INTERVAL_MS;
  let fencedAt = 0;
  const renewFence = async () => {
    if (!input.fence) return;
    const renewed = await input.fence();
    if (!renewed) throw new MultipartUploadFenceLost();
    deadlineAt = input.deadlineAt === undefined ? renewed.deadlineAt : Math.min(input.deadlineAt, renewed.deadlineAt);
    fencedAt = Date.now();
    arm();
    if (deadlineHit()) throw new MultipartUploadDeadlineExceeded();
  };
  try {
    await renewFence();
  } catch (err) {
    disarm();
    throw err;
  }
  let uploadId: string | undefined;
  try {
    const created = await input.client.send(
      new CreateMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        ContentType: input.contentType,
        ChecksumAlgorithm: "SHA256",
        ...(input.metadata ? { Metadata: input.metadata } : {}),
        ...(lock ? { ObjectLockMode: lock.mode as ObjectLockMode, ObjectLockRetainUntilDate: lock.retainUntil } : {}),
      }),
      signal,
    );
    uploadId = created.UploadId;
    if (!uploadId) throw new Error("multipart_upload_no_upload_id");
  } catch (err) {
    disarm();
    throw deadlineHit() ? new MultipartUploadDeadlineExceeded() : err;
  }

  const whole = createHash("sha256");
  const parts: Array<{ ETag: string; PartNumber: number; ChecksumSHA256: string }> = [];
  let sent = 0;
  let completionSent = false;
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(input.file, "r");
    const buf = Buffer.allocUnsafe(partBytes);
    for (let partNumber = 1; sent < size; partNumber += 1) {
      if (deadlineHit()) throw new MultipartUploadDeadlineExceeded();
      if (input.fence && Date.now() - fencedAt >= fenceIntervalMs) await renewFence();
      // Fill one part completely (a short read is not the end of the file).
      let filled = 0;
      while (filled < partBytes && sent + filled < size) {
        const { bytesRead } = await fh.read(buf, filled, partBytes - filled, sent + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled === 0) throw new Error("multipart_upload_short_read");
      const body = buf.subarray(0, filled);
      whole.update(body);
      const checksum = createHash("sha256").update(body).digest("base64");
      const res = await input.client.send(
        new UploadPartCommand({
          Bucket: input.bucket,
          Key: input.key,
          UploadId: uploadId,
          PartNumber: partNumber,
          // A copy: the shared buffer is reused for the next part.
          Body: Buffer.from(body),
          ContentLength: filled,
          ContentMD5: createHash("md5").update(body).digest("base64"),
          ChecksumSHA256: checksum,
        }),
        signal,
      );
      if (!res.ETag) throw new Error("multipart_upload_part_without_etag");
      parts.push({ ETag: res.ETag, PartNumber: partNumber, ChecksumSHA256: res.ChecksumSHA256 ?? checksum });
      sent += filled;
    }
    if (sent !== size) throw new Error("multipart_upload_size_changed");
    // Completion is not requested past the deadline, nor without a fence
    // renewed immediately before it (M676 follow-up).
    if (deadlineHit()) throw new MultipartUploadDeadlineExceeded();
    await renewFence();
    // M676 follow-up — the completion is bounded by the same deadline (it
    // carries the abort signal): an unbounded completion could land bytes
    // after the caller's reservation stopped counting. One cut off mid-flight
    // is resolved below: the upload is aborted, and if the abort finds no
    // upload left the object may exist (MultipartUploadCompletionUnknown).
    completionSent = true;
    const done = await input.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
      signal,
    );
    return {
      versionId: done.VersionId ?? null,
      sha256: whole.digest("hex"),
      sizeBytes: sent,
      partCount: parts.length,
    };
  } catch (err) {
    let aborted = false;
    try {
      await input.client.send(
        new AbortMultipartUploadCommand({ Bucket: input.bucket, Key: input.key, UploadId: uploadId }),
      );
      aborted = true;
    } catch {
      /* the store's incomplete-upload lifecycle reaps what an abort could not */
    }
    // M676 follow-up — a completion whose answer was lost and whose upload
    // can no longer be aborted may have produced an object.
    if (completionSent && !aborted) throw new MultipartUploadCompletionUnknown(input.bucket, input.key, err);
    throw deadlineHit() && !(err instanceof MultipartUploadDeadlineExceeded) && !(err instanceof MultipartUploadFenceLost)
      ? new MultipartUploadDeadlineExceeded()
      : err;
  } finally {
    disarm();
    await fh?.close().catch(() => undefined);
  }
}
