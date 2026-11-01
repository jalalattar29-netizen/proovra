/**
 * INGEST-003 — a redaction is built from the bytes it says it derives from.
 * Live PostgreSQL 16, a real versioned MinIO bucket.
 *
 * A new object version can land on a sealed key while an old upload URL is still
 * live, and the redaction reader took whatever was latest at that key.
 */
import { createHash, randomUUID } from "node:crypto";

import { CreateBucketCommand, PutBucketVersioningCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("the redaction reader (live PostgreSQL 16, versioned MinIO)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let s3: (typeof import("../src/storage.js"))["s3"];
  let bytes: typeof import("../src/services/redaction/evidence-bytes.service.js");
  const BUCKET = `ing003-${randomUUID().slice(0, 8)}`;
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ s3 } = await import("../src/storage.js"));
    bytes = await import("../src/services/redaction/evidence-bytes.service.js");
    bytes.__setTestS3(s3 as never);
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    await s3.send(new PutBucketVersioningCommand({ Bucket: BUCKET, VersioningConfiguration: { Status: "Enabled" } }));
  }, 180_000);
  afterAll(async () => {
    bytes?.__setTestS3(null);
    await h?.cleanup();
  });

  async function sealed(key: string, body: Buffer, versionId: string | null) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const row = await prisma.evidence.create({
      data: {
        title: "redaction source",
        type: "PHOTO",
        status: "SIGNED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        storageBucket: BUCKET,
        storageKey: key,
        storageVersionId: versionId,
        fileSha256: createHash("sha256").update(body).digest("hex"),
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  it("reads the sealed version when a later one sits on the key", async () => {
    const key = `evidence/${randomUUID()}`;
    const original = Buffer.from("the sealed original");
    const first = await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: original }));
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: Buffer.from("written after the seal") }));
    const id = await sealed(key, original, first.VersionId!);
    const res = await bytes.fetchEvidenceBytes({ teamId: A().teamId, evidenceId: id });
    expect(res.ok).toBe(true);
    if (res.ok) expect(Buffer.from(res.bytes).toString()).toBe("the sealed original");
  });

  it("a legacy row with no version is refused when the bytes are not the sealed digest", async () => {
    const key = `evidence/${randomUUID()}`;
    const original = Buffer.from("the sealed original");
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: Buffer.from("written after the seal") }));
    const id = await sealed(key, original, null);
    const res = await bytes.fetchEvidenceBytes({ teamId: A().teamId, evidenceId: id });
    expect(res).toMatchObject({ ok: false, denial: "ARTIFACT_NOT_REDACTABLE", reason: "stored_bytes_differ_from_sealed_digest" });
  });
});
