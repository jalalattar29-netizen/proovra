/**
 * ET-PKG-06 — public Verify states a recorded storage lock as RECORDED, and an
 * expired one as expired. Live PostgreSQL 16, real HTTP.
 *
 * On a40ca76f any storage-lock column on the row made public Verify return
 * `verified: true` and `immutable` (COMPLIANCE + any retain-until) without a
 * HEAD and without comparing retain-until to now; the page then said
 * protected objects "cannot be altered or deleted" and counted storage as a
 * passed signal — for a lock whose retention had already ended.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
// ET-PKG-07 — a record's id is not a public link: requests go through a share
// link (the record is published and the link minted on first use).
import { shareLinkFor } from "./helpers/verify-share.js";

type Storage = {
  immutable: boolean;
  verified: boolean;
  source?: string;
  expired?: boolean;
  retainUntil: string | null;
  verification?: string;
};

describe("public Verify — recorded storage protection (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const created: string[] = [];
  const keyId = `pkg06-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  let originalBilling: Record<string, unknown> | null = null;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.signingKey.create({ data: { keyId, version: 1, publicKeyPem } });
    originalBilling = (await prisma.team.findUniqueOrThrow({
      where: { id: h.fixtures.teamA.teamId },
      select: { billingPlan: true, billingStatus: true },
    })) as unknown as Record<string, unknown>;
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
  }, 180_000);

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence.updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } }).catch(() => undefined);
    }
    if (h && originalBilling) {
      await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: originalBilling as never }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  async function lockedRecord(retainUntil: Date) {
    const { teamId } = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const fileSha256 = createHash("sha256").update(randomUUID()).digest("hex");
    const { id } = await prisma.evidence.create({
      data: { title: "PKG-06 fixture", type: "PHOTO", status: "SIGNED", teamId, organizationId: team.organizationId, ownerUserId: team.ownerUserId },
      select: { id: true },
    });
    created.push(id);
    const canonical = JSON.stringify({ v: 1, evidenceId: id, sha256: fileSha256 });
    const fingerprintHash = createHash("sha256").update(canonical).digest("hex");
    await prisma.evidence.update({
      where: { id },
      data: {
        fileSha256,
        fingerprintCanonicalJson: canonical,
        fingerprintHash,
        signatureBase64: sign(null, Buffer.from(fingerprintHash, "hex"), privateKey).toString("base64"),
        signingKeyId: keyId,
        signingKeyVersion: 1,
        signedAtUtc: new Date(),
        storageBucket: "evidence",
        storageKey: `evidence/${id}/original.jpg`,
        storageObjectLockMode: "COMPLIANCE",
        storageObjectLockRetainUntilUtc: retainUntil,
      } as never,
    });
    return id;
  }

  async function storageOf(id: string): Promise<Storage> {
    const res = await h.app.inject({ method: "GET", url: `/public/verify/${await shareLinkFor(prisma, id)}` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { storage?: Storage; storageAndTimestamping?: { storage?: Storage } };
    const storage = body.storageAndTimestamping?.storage ?? body.storage;
    expect(storage, "the response carries storage protection").toBeTruthy();
    return storage!;
  }

  it("a recorded COMPLIANCE lock still in force is RECORDED, not verified", async () => {
    const storage = await storageOf(await lockedRecord(new Date(Date.now() + 365 * 24 * 3600_000)));
    expect(storage).toMatchObject({ verified: false, source: "RECORDED", immutable: true, expired: false });
  });

  // -------------------------------------------------------------------------
  // AUD-014 — only a successful read of the stored object confirms the lock.
  // A real MinIO bucket with Object Lock: a COMPLIANCE object read back is
  // STORAGE_CONFIRMED (verified, PASSED); the same recorded snapshot over an
  // object that carries no lock is FAILED; an unreadable object stays RECORDED.
  // -------------------------------------------------------------------------
  const LOCKED_BUCKET = "uc-trust-objlock";
  async function s3() {
    const { S3Client } = await import("@aws-sdk/client-s3");
    return new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY!, secretAccessKey: process.env.S3_SECRET_KEY! },
    });
  }
  async function objectInStore(lock: boolean): Promise<{ key: string; versionId: string | null }> {
    const { CreateBucketCommand, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await s3();
    await client.send(new CreateBucketCommand({ Bucket: LOCKED_BUCKET, ObjectLockEnabledForBucket: true })).catch((err: { name?: string }) => {
      if (!/BucketAlready(OwnedByYou|Exists)/.test(String(err?.name))) throw err;
    });
    const key = `evidence/${randomUUID()}/original.jpg`;
    const put = await client.send(
      new PutObjectCommand({
        Bucket: LOCKED_BUCKET,
        Key: key,
        Body: Buffer.from(`aud014-${randomUUID()}`),
        ...(lock ? { ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: new Date(Date.now() + 2 * 24 * 3600_000) } : {}),
      }),
    );
    return { key, versionId: put.VersionId ?? null };
  }
  async function recordOver(object: { key: string; versionId: string | null }) {
    const id = await lockedRecord(new Date(Date.now() + 365 * 24 * 3600_000));
    await prisma.evidence.update({
      where: { id },
      data: { storageBucket: LOCKED_BUCKET, storageKey: object.key, storageVersionId: object.versionId } as never,
    });
    return id;
  }
  async function verifyBody(id: string) {
    const res = await h.app.inject({ method: "GET", url: `/public/verify/${await shareLinkFor(prisma, id)}` });
    expect(res.statusCode, res.body).toBe(200);
    return res;
  }

  it("AUD-014 a COMPLIANCE lock READ from the stored object is verified; the trust signal is PASSED", async () => {
    const id = await recordOver(await objectInStore(true));
    const storage = await storageOf(id);
    expect(storage).toMatchObject({ verified: true, source: "OBSERVED", immutable: true, verification: "STORAGE_CONFIRMED" });
    const body = (await verifyBody(id)).body;
    expect(body).toMatch(/"key":"immutable_storage"[^}]*"state":"PASSED"|"state":"PASSED"[^}]*"key":"immutable_storage"/);
    // The owner review workspace reads the object the same way.
    const owner = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${id}/review-workspace`,
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` },
    });
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.body).toContain('"verification":"STORAGE_CONFIRMED"');
  });

  it("AUD-014 a recorded COMPLIANCE snapshot over an object that carries NO lock is FAILED, never verified", async () => {
    const id = await recordOver(await objectInStore(false));
    const storage = await storageOf(id);
    expect(storage).toMatchObject({ verified: false, source: "OBSERVED", verification: "FAILED" });
    const body = (await verifyBody(id)).body;
    expect(body).not.toContain("Immutable retention verified");
  });

  it("AUD-014 an unreadable object leaves the snapshot RECORDED: the signal says recorded, never verified", async () => {
    const id = await lockedRecord(new Date(Date.now() + 365 * 24 * 3600_000));
    const storage = await storageOf(id);
    expect(storage).toMatchObject({ verified: false, source: "RECORDED", verification: "RECORDED" });
    const body = (await verifyBody(id)).body;
    expect(body).toContain("Immutable retention recorded");
    expect(body).not.toContain("Immutable retention verified");
  });

  it("a recorded lock whose retain-until has passed is expired and not immutable", async () => {
    const storage = await storageOf(await lockedRecord(new Date(Date.now() - 24 * 3600_000)));
    expect(storage).toMatchObject({ verified: false, source: "RECORDED", immutable: false, expired: true });
  });
});
