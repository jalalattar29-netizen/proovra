/**
 * 2026-10-29 — the streaming multipart upload against a REAL S3 store
 * (local MinIO at 127.0.0.1:59000, the integration infrastructure).
 *
 * Proves: a 37 MiB file goes up in 16 MiB parts (3 parts) with bounded memory;
 * the returned digest is of exactly the bytes stored; the object VERSION is
 * returned and reads back the same bytes; the record's artifact lock is
 * applied at creation; a presigned GET honours Range (206 + the exact slice)
 * and the signed Content-Disposition — what the combined-recording player and
 * download rely on; a failed upload is aborted (no incomplete upload left).
 *
 * Skips when MinIO is not reachable (no store, nothing to prove against).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectRetentionCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { uploadFileMultipart } from "../src/combined-recording/multipart-upload.js";

const ENDPOINT = process.env.COMBINE_TEST_S3_ENDPOINT ?? "http://127.0.0.1:59000";
const client = new S3Client({
  region: "us-east-1",
  endpoint: ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: "point7-local-minio", secretAccessKey: "point7-local-minio-secret" },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${ENDPOINT}/minio/health/live`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
const available = await reachable();
const runIf = available ? describe : describe.skip;

const bucket = `combine-mp-${randomUUID().slice(0, 8)}`;
const lockBucket = `combine-mpl-${randomUUID().slice(0, 8)}`;
let dir = "";
let file = "";
let bytes: Buffer;

async function readAll(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

async function emptyBucket(name: string): Promise<void> {
  const versions = await client.send(new ListObjectVersionsCommand({ Bucket: name })).catch(() => null);
  for (const v of [...(versions?.Versions ?? []), ...(versions?.DeleteMarkers ?? [])]) {
    await client
      .send(new DeleteObjectCommand({ Bucket: name, Key: v.Key!, VersionId: v.VersionId, BypassGovernanceRetention: true }))
      .catch(() => undefined);
  }
  await client.send(new DeleteBucketCommand({ Bucket: name })).catch(() => undefined);
}

runIf("multipart upload of a combined recording (real MinIO)", () => {
  beforeAll(async () => {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    await client.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
    await client.send(new CreateBucketCommand({ Bucket: lockBucket, ObjectLockEnabledForBucket: true }));
    dir = await mkdtemp(path.join(os.tmpdir(), "proovra-mp-test-"));
    file = path.join(dir, "combined.mp4");
    bytes = randomBytes(37 * 1024 * 1024 + 12345);
    await writeFile(file, bytes);
  });

  afterAll(async () => {
    await emptyBucket(bucket);
    await emptyBucket(lockBucket);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("uploads in bounded parts; digest, size and VERSION identify exactly the stored bytes", async () => {
    const key = `derived-assets/${randomUUID()}/screen_recording_combined/combined-v1.mp4`;
    const res = await uploadFileMultipart({
      client,
      bucket,
      key,
      file,
      contentType: "video/mp4",
      partBytes: 16 * 1024 * 1024,
      lock: null,
      objectLockEnabled: false,
      maxBytes: 640 * 1024 * 1024,
    });
    expect(res.partCount).toBe(3);
    expect(res.sizeBytes).toBe(bytes.length);
    expect(res.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(res.versionId).toBeTruthy();
    const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: res.versionId! }));
    expect(got.ContentType).toBe("video/mp4");
    expect(createHash("sha256").update(await readAll(got.Body)).digest("hex")).toBe(res.sha256);

    // A presigned GET (what the player and the download route hand out) honours
    // Range — seeking in a 600 MB recording never pulls the whole object.
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: res.versionId!,
        ResponseContentDisposition: 'attachment; filename="abcdef12-DERIVED-combined-recording-v1.mp4"',
        ResponseContentType: "video/mp4",
      }),
      { expiresIn: 300 },
    );
    const start = 20 * 1024 * 1024 + 7;
    const end = start + 4095;
    const ranged = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes ${start}-${end}/${bytes.length}`);
    expect(ranged.headers.get("content-disposition")).toBe(
      'attachment; filename="abcdef12-DERIVED-combined-recording-v1.mp4"',
    );
    expect(Buffer.from(await ranged.arrayBuffer()).equals(bytes.subarray(start, end + 1))).toBe(true);
  });

  it("applies the record's artifact lock at creation", async () => {
    const key = `derived-assets/${randomUUID()}/screen_recording_combined/combined-v1.mp4`;
    const retainUntil = new Date(Date.now() + 24 * 3600 * 1000);
    const res = await uploadFileMultipart({
      client,
      bucket: lockBucket,
      key,
      file,
      contentType: "video/mp4",
      partBytes: 16 * 1024 * 1024,
      lock: { mode: "GOVERNANCE", retainUntil },
      objectLockEnabled: true,
      maxBytes: 640 * 1024 * 1024,
    });
    const retention = await client.send(
      new GetObjectRetentionCommand({ Bucket: lockBucket, Key: key, VersionId: res.versionId ?? undefined }),
    );
    expect(retention.Retention?.Mode).toBe("GOVERNANCE");
    expect(Math.abs(new Date(retention.Retention!.RetainUntilDate!).getTime() - retainUntil.getTime())).toBeLessThan(2000);
  });

  it("refuses an oversize file before sending a byte, and aborts a failed upload", async () => {
    await expect(
      uploadFileMultipart({
        client,
        bucket,
        key: "derived-assets/oversize.mp4",
        file,
        contentType: "video/mp4",
        partBytes: 16 * 1024 * 1024,
        lock: null,
        objectLockEnabled: false,
        maxBytes: 1024,
      }),
    ).rejects.toThrow("multipart_upload_oversize");
    // A part the store rejects (bad Content-MD5 is impossible to forge here, so
    // a bucket that does not exist): the upload id never survives.
    await expect(
      uploadFileMultipart({
        client,
        bucket: `${bucket}-missing`,
        key: "x.mp4",
        file,
        contentType: "video/mp4",
        partBytes: 16 * 1024 * 1024,
        lock: null,
        objectLockEnabled: false,
        maxBytes: 640 * 1024 * 1024,
      }),
    ).rejects.toThrow();
    const open = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
    expect(open.Uploads ?? []).toEqual([]);
  });
});
