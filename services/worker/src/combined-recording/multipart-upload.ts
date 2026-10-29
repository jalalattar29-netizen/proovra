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
}): Promise<MultipartUploadResult> {
  const partBytes = Math.max(MIN_MULTIPART_PART_BYTES, Math.trunc(input.partBytes));
  const size = (await stat(input.file)).size;
  if (size <= 0) throw new Error("multipart_upload_empty_file");
  if (size > input.maxBytes) throw new Error("multipart_upload_oversize");
  if (Math.ceil(size / partBytes) > MAX_PARTS) throw new Error("multipart_upload_too_many_parts");

  const lock = input.objectLockEnabled && input.lock ? input.lock : null;
  const created = await input.client.send(
    new CreateMultipartUploadCommand({
      Bucket: input.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ChecksumAlgorithm: "SHA256",
      ...(input.metadata ? { Metadata: input.metadata } : {}),
      ...(lock ? { ObjectLockMode: lock.mode as ObjectLockMode, ObjectLockRetainUntilDate: lock.retainUntil } : {}),
    }),
  );
  const uploadId = created.UploadId;
  if (!uploadId) throw new Error("multipart_upload_no_upload_id");

  const whole = createHash("sha256");
  const parts: Array<{ ETag: string; PartNumber: number; ChecksumSHA256: string }> = [];
  let sent = 0;
  const fh = await open(input.file, "r");
  try {
    const buf = Buffer.allocUnsafe(partBytes);
    for (let partNumber = 1; sent < size; partNumber += 1) {
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
      );
      if (!res.ETag) throw new Error("multipart_upload_part_without_etag");
      parts.push({ ETag: res.ETag, PartNumber: partNumber, ChecksumSHA256: res.ChecksumSHA256 ?? checksum });
      sent += filled;
    }
    if (sent !== size) throw new Error("multipart_upload_size_changed");
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
    throw err;
  } finally {
    await fh.close().catch(() => undefined);
  }
}
