/**
 * FINAL-VERIFY-2 closure — the reconciler's S3 store (`s3DerivedObjectStore`)
 * against a REAL S3 implementation (local MinIO, an Object-Lock bucket): what
 * the reconciler decides on must be what the store really answers.
 *
 *   - listVersions: every data version of EXACTLY the key (a longer key with
 *     the same prefix is not included), with its stored size, its retention
 *     and its legal hold;
 *   - deleteVersion: an unlocked version is removed; a version under
 *     retention is REFUSED (false) and is still listed afterwards;
 *   - listMultipartUploads / abortMultipartUpload: an interrupted upload's
 *     parts are found for exactly the key and removed;
 *   - every call honours its AbortSignal (an aborted signal sends nothing).
 *
 * Runs where MinIO answers (same convention as the multipart suite).
 */
import { randomBytes, randomUUID } from "node:crypto";

import {
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  PutObjectLegalHoldCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: {} }));

import { s3DerivedObjectStore } from "../src/derived-storage-intent.js";

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
const runIf = (await reachable()) ? describe : describe.skip;
const bucket = `fv2-store-${randomUUID().slice(0, 8)}`;
const signal = () => AbortSignal.timeout(20_000);

runIf("s3DerivedObjectStore (real MinIO, Object Lock)", () => {
  const store = s3DerivedObjectStore(client as never);

  beforeAll(async () => {
    await client.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
  });

  afterAll(async () => {
    const versions = await client.send(new ListObjectVersionsCommand({ Bucket: bucket })).catch(() => null);
    for (const v of [...(versions?.Versions ?? []), ...(versions?.DeleteMarkers ?? [])]) {
      await client
        .send(new PutObjectLegalHoldCommand({ Bucket: bucket, Key: v.Key!, VersionId: v.VersionId, LegalHold: { Status: "OFF" } }))
        .catch(() => undefined);
      await client
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: v.Key!, VersionId: v.VersionId, BypassGovernanceRetention: true }))
        .catch(() => undefined);
    }
    const uploads = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket })).catch(() => null);
    for (const u of uploads?.Uploads ?? []) {
      await store.abortMultipartUpload({ bucket, key: u.Key!, uploadId: u.UploadId! }, signal()).catch(() => undefined);
    }
    await client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
  });

  it("lists exactly the key's versions with size and lock state; deletes the unlocked one; refuses the retained one", async () => {
    const key = `derived-assets/${randomUUID()}/thumb.webp`;
    const free = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: randomBytes(1234) }));
    const locked = await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: randomBytes(4321),
        ObjectLockMode: "GOVERNANCE",
        ObjectLockRetainUntilDate: new Date(Date.now() + 86_400_000),
      }),
    );
    const held = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: randomBytes(77), ObjectLockLegalHoldStatus: "ON" }));
    // A longer key sharing the prefix is not this key's version.
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: `${key}.other`, Body: randomBytes(5) }));

    const listed = await store.listVersions({ bucket, key }, signal());
    const byId = new Map(listed.map((v) => [v.versionId, v]));
    expect(listed).toHaveLength(3);
    expect(byId.get(free.VersionId!)).toMatchObject({ sizeBytes: 1234, legalHold: false, retainUntil: null });
    expect(byId.get(locked.VersionId!)!.sizeBytes).toBe(4321);
    expect(byId.get(locked.VersionId!)!.retainUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(byId.get(held.VersionId!)).toMatchObject({ sizeBytes: 77, legalHold: true });

    expect(await store.deleteVersion({ bucket, key, versionId: free.VersionId! }, signal())).toBe(true);
    expect(await store.deleteVersion({ bucket, key, versionId: locked.VersionId! }, signal()), "retention refuses the delete").toBe(false);
    expect(await store.deleteVersion({ bucket, key, versionId: held.VersionId! }, signal()), "a legal hold refuses the delete").toBe(false);
    const after = (await store.listVersions({ bucket, key }, signal())).map((v) => v.versionId).sort();
    expect(after).toEqual([locked.VersionId!, held.VersionId!].sort());
  });

  it("finds and aborts an interrupted multipart upload of exactly the key", async () => {
    const key = `derived-assets/${randomUUID()}/combined.mp4`;
    const created = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }));
    await client.send(
      new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: created.UploadId!, PartNumber: 1, Body: randomBytes(5 * 1024 * 1024) }),
    );
    const other = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: `${key}.x` }));
    expect(await store.listMultipartUploads({ bucket, key }, signal())).toEqual([created.UploadId]);
    await store.abortMultipartUpload({ bucket, key, uploadId: created.UploadId! }, signal());
    expect(await store.listMultipartUploads({ bucket, key }, signal())).toEqual([]);
    expect(await store.listVersions({ bucket, key }, signal()), "an aborted upload stored no object").toEqual([]);
    await store.abortMultipartUpload({ bucket, key: `${key}.x`, uploadId: other.UploadId! }, signal());
  });

  it("an aborted signal cancels the request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(store.listVersions({ bucket, key: "derived-assets/x" }, controller.signal)).rejects.toThrow();
    await expect(store.deleteVersion({ bucket, key: "derived-assets/x", versionId: "v" }, controller.signal)).rejects.toThrow();
  });
});
