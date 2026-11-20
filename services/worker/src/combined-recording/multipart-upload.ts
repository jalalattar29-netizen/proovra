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
}): Promise<MultipartUploadResult> {
  const deadlineAt = input.deadlineAt;
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
  const timer =
    deadlineAt === undefined
      ? null
      : setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()));
  timer?.unref?.();
  const signal = { abortSignal: controller.signal };
  const deadlineHit = () => controller.signal.aborted || pastDeadline();
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
    if (timer) clearTimeout(timer);
    throw deadlineHit() ? new MultipartUploadDeadlineExceeded() : err;
  }

  const whole = createHash("sha256");
  const parts: Array<{ ETag: string; PartNumber: number; ChecksumSHA256: string }> = [];
  let sent = 0;
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(input.file, "r");
    const buf = Buffer.allocUnsafe(partBytes);
    for (let partNumber = 1; sent < size; partNumber += 1) {
      if (deadlineHit()) throw new MultipartUploadDeadlineExceeded();
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
    // Completion is not requested past the deadline. It is sent without the
    // abort signal: a completion cut off mid-flight could leave an object the
    // caller never learns about.
    if (deadlineHit()) throw new MultipartUploadDeadlineExceeded();
    const done = await input.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
    return {
      versionId: done.VersionId ?? null,
      sha256: whole.digest("hex"),
      sizeBytes: sent,
      partCount: parts.length,
    };
  } catch (err) {
    try {
      await input.client.send(
        new AbortMultipartUploadCommand({ Bucket: input.bucket, Key: input.key, UploadId: uploadId }),
      );
    } catch {
      /* the store's incomplete-upload lifecycle reaps what an abort could not */
    }
    throw deadlineHit() && !(err instanceof MultipartUploadDeadlineExceeded) ? new MultipartUploadDeadlineExceeded() : err;
  } finally {
    if (timer) clearTimeout(timer);
    await fh?.close().catch(() => undefined);
  }
}
