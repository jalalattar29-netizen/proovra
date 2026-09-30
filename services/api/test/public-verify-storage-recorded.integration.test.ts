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

type Storage = { immutable: boolean; verified: boolean; source?: string; expired?: boolean; retainUntil: string | null };

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

  it("a recorded lock whose retain-until has passed is expired and not immutable", async () => {
    const storage = await storageOf(await lockedRecord(new Date(Date.now() - 24 * 3600_000)));
    expect(storage).toMatchObject({ verified: false, source: "RECORDED", immutable: false, expired: true });
  });
});
