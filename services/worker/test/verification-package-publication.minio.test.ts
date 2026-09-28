/**
 * PACKAGE / REPORT PUBLICATION AGAINST AN OBJECT-LOCK BUCKET (MinIO).
 *
 * Replaces the UC-3 staging harness. That harness ran against a bucket with NO
 * Object Lock, which is exactly why the staging PUT (no checksum) and the
 * promote CopyObject (lock headers, no checksum) passed it and failed in
 * production (Sentry 150024171, 2026-09-28).
 *
 * This suite needs a MinIO whose bucket was created WITH object lock and a
 * DEFAULT COMPLIANCE retention — the production shape documented in
 * `docs/architecture/evidence-lifecycle-convergence.md`:
 *
 *   mc mb --with-lock l/olc-locked
 *   mc retention set --default COMPLIANCE 1d l/olc-locked
 *
 * and is enabled by `OBJECT_LOCK_MINIO_ENDPOINT` (plus `_LOGIN`,
 * `_PASSPHRASE`, `_BUCKET` — names chosen so the test bootstrap's credential
 * scrub does not remove them). Without it the suite is skipped.
 *
 * WHAT MINIO CANNOT PROVE (observed 2026-09-29, MinIO RELEASE.2024-12-18):
 * a PUT with NO checksum header into this default-COMPLIANCE bucket was
 * ACCEPTED. MinIO does not enforce the AWS rule that produced the incident, so
 * this suite cannot reproduce the failure and cannot close the production
 * gate. It proves the new path's own properties — checksum validated and kept,
 * retention applied, VersionId pinned, single write per key — and nothing
 * about AWS acceptance. That gate stays open until a run against a real AWS
 * bucket configured like production.
 */
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

const ENDPOINT = process.env.OBJECT_LOCK_MINIO_ENDPOINT;
const run = ENDPOINT ? describe : describe.skip;

if (ENDPOINT) {
  process.env.S3_ENDPOINT = ENDPOINT;
  process.env.S3_REGION = "us-east-1";
  process.env.S3_ACCESS_KEY = process.env.OBJECT_LOCK_MINIO_LOGIN ?? "";
  process.env.S3_SECRET_KEY = process.env.OBJECT_LOCK_MINIO_PASSPHRASE ?? "";
  process.env.S3_BUCKET = process.env.OBJECT_LOCK_MINIO_BUCKET ?? "olc-locked";
  process.env.S3_ALLOW_INSECURE = "true";
  process.env.S3_FORCE_PATH_STYLE = "true";
  process.env.S3_OBJECT_LOCK_ENABLED = "true";
  process.env.S3_OBJECT_LOCK_MODE = "COMPLIANCE";
  process.env.S3_OBJECT_LOCK_RETAIN_DAYS = "1";
}

run("publication to an Object-Lock bucket with default COMPLIANCE retention", async () => {
  const storage = await import("../src/storage.js");
  const { publishImmutableArtifact, buildPublicationKey, StoragePublicationRejectedError } =
    await import("../src/immutable-publication.js");
  const { streamZipToTempFile, cleanupStagedTemp } = await import(
    "../src/verification-package-staging.js"
  );
  const { HeadObjectCommand, ListObjectVersionsCommand } = await import("@aws-sdk/client-s3");
  const BUCKET = process.env.S3_BUCKET as string;
  const RUN = `olc-${randomUUID()}`;

  it("publishes a streamed package once, checksum-validated and COMPLIANCE-locked, pinned by VersionId", async () => {
    const parts = [Buffer.from("segment-0-".repeat(4000)), Buffer.from("segment-1-".repeat(9000))];
    const staged = await streamZipToTempFile([
      { name: "manifest.json", buffer: Buffer.from(JSON.stringify({ parts: 2 })) },
      { name: "evidence-parts/p0.bin", source: () => Readable.from(parts[0]) },
      { name: "evidence-parts/p1.bin", source: () => Readable.from(parts[1]) },
    ]);
    const key = buildPublicationKey({
      family: "verification",
      evidenceId: RUN,
      version: 7,
      requestId: "req",
      extension: "zip",
    });
    const published = await publishImmutableArtifact({
      bucket: BUCKET,
      key,
      body: { kind: "file", filePath: staged.tempPath, sizeBytes: staged.sizeBytes },
      sha256Base64: staged.sha256Base64,
      contentType: "application/zip",
    });
    await cleanupStagedTemp(staged);

    expect(published.versionId).toBeTruthy();
    expect(published.sha256Hex).toBe(staged.sha256Hex);
    expect(published.objectLockMode).toBe("COMPLIANCE");

    const head = await storage.s3.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: key, VersionId: published.versionId!, ChecksumMode: "ENABLED" }),
    );
    expect(head.ChecksumSHA256).toBe(staged.sha256Base64);
    expect(head.ContentLength).toBe(staged.sizeBytes);

    // The bytes read back are the bytes hashed.
    const body = (await storage.getObjectStream({ bucket: BUCKET, key })) as unknown as Readable;
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(c as Buffer);
    expect(createHash("sha256").update(Buffer.concat(chunks)).digest("hex")).toBe(staged.sha256Hex);
  });

  it("never writes a second version at a key: a repeat with different bytes is refused", async () => {
    const key = `reports/${RUN}/v1/req-fixed.pdf`;
    const a = Buffer.from("%PDF first");
    const b = Buffer.from("%PDF second, different bytes");
    const sha = (x: Buffer) => createHash("sha256").update(x).digest("base64");
    await publishImmutableArtifact({ bucket: BUCKET, key, body: { kind: "buffer", buffer: a }, sha256Base64: sha(a), contentType: "application/pdf" });
    // Same bytes again (lost response): accepted, same object.
    const again = await publishImmutableArtifact({ bucket: BUCKET, key, body: { kind: "buffer", buffer: a }, sha256Base64: sha(a), contentType: "application/pdf" });
    expect(again.sizeBytes).toBe(a.length);
    await expect(
      publishImmutableArtifact({ bucket: BUCKET, key, body: { kind: "buffer", buffer: b }, sha256Base64: sha(b), contentType: "application/pdf" }),
    ).rejects.toBeInstanceOf(StoragePublicationRejectedError);
    const versions = await storage.s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: key }));
    expect((versions.Versions ?? []).filter((v) => v.Key === key)).toHaveLength(1);
  });

  it("the destruction version port sees the COMPLIANCE-locked version as retained, and it cannot be deleted", async () => {
    const { workerEvidenceDestructionStorage } = await import("../src/governance/destruction-storage-port.js");
    const key = `reports/${RUN}/v3/req-retained.pdf`;
    const a = Buffer.from("%PDF retained");
    await publishImmutableArtifact({
      bucket: BUCKET,
      key,
      body: { kind: "buffer", buffer: a },
      sha256Base64: createHash("sha256").update(a).digest("base64"),
      contentType: "application/pdf",
    });
    const versions = await workerEvidenceDestructionStorage.listObjectVersions({ bucket: BUCKET, key });
    const data = versions.filter((v) => !v.isDeleteMarker);
    expect(data).toHaveLength(1);
    expect(data[0].retainUntil!.getTime()).toBeGreaterThan(Date.now());
    const del = await workerEvidenceDestructionStorage.deleteObjectVersion({
      bucket: BUCKET,
      key,
      versionId: data[0].versionId,
    });
    expect(del.ok).toBe(false);
    const after = await workerEvidenceDestructionStorage.listObjectVersions({ bucket: BUCKET, key });
    expect(after.filter((v) => !v.isDeleteMarker)).toHaveLength(1);
  });

  it("a key-only delete of a locked object leaves the locked version (delete marker only)", async () => {
    const key = `reports/${RUN}/v2/req-del.pdf`;
    const a = Buffer.from("%PDF locked");
    await publishImmutableArtifact({
      bucket: BUCKET,
      key,
      body: { kind: "buffer", buffer: a },
      sha256Base64: createHash("sha256").update(a).digest("base64"),
      contentType: "application/pdf",
    });
    await storage.deleteObject({ bucket: BUCKET, key });
    const versions = await storage.s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: key }));
    expect((versions.Versions ?? []).length).toBe(1);
    expect((versions.DeleteMarkers ?? []).length).toBe(1);
  });
});
