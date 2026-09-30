/**
 * ET-PKG-05 — public Verify's package verdict rests on the seal, not on file
 * names. Live PostgreSQL 16, real HTTP.
 *
 * On a40ca76f "Package Integrity Complete / Independent Review Enabled" was
 * computed from artifact-presence flags (DB flags written at generation, or
 * ZIP central-directory names), so an unsealed format-4 legacy package got the
 * same success badge as a sealed one. The response now carries the package's
 * format and whether it is sealed (format 5 with the seal digest and signing
 * key recorded; the worker refuses to publish a seal that does not verify).
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("public Verify — package sealed state (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const created: string[] = [];
  const keyId = `pkg05-${randomUUID().slice(0, 8)}`;
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

  /** A signed record with a v1 report and a v1 package of the given format. */
  async function withPackage(format: { version: number; sealed: boolean }) {
    const { teamId } = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const fileSha256 = createHash("sha256").update(randomUUID()).digest("hex");
    const { id } = await prisma.evidence.create({
      data: { title: "PKG-05 fixture", type: "PHOTO", status: "REPORTED", teamId, organizationId: team.organizationId, ownerUserId: team.ownerUserId },
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
        latestReportVersion: 1,
        verificationPackageVersion: 1,
        verificationPackageMetadata: {
          packageVersion: "v1",
          generatedAtUtc: new Date().toISOString(),
          source: "GENERATION",
          manifestPresent: true,
          signedManifestPresent: true,
          checksumIndexPresent: true,
          auditExportIncluded: true,
          custodyExportIncluded: true,
          accessExportIncluded: true,
        },
      } as never,
    });
    await prisma.report.create({
      data: { evidenceId: id, version: 1, storageBucket: "b", storageKey: `reports/${id}/v1.pdf`, generatedAtUtc: new Date(), sizeBytes: 1_000n },
    });
    await prisma.verificationPackage.create({
      data: {
        evidenceId: id,
        version: 1,
        storageBucket: "b",
        storageKey: `verification/${id}/v1.zip`,
        generatedAtUtc: new Date(),
        sizeBytes: 9_000n,
        reportVersion: 1,
        packageFormatVersion: format.version,
        ...(format.sealed ? { sealSha256: "a".repeat(64), sealSigningKeySha256: "b".repeat(64) } : {}),
      } as never,
    });
    return id;
  }

  async function packageIntegrity(id: string) {
    const res = await h.app.inject({ method: "GET", url: `/public/verify/${id}` });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { verificationPackageIntegrity?: { available: boolean; sealed?: boolean; packageFormatVersion?: number | null } })
      .verificationPackageIntegrity;
  }

  it("a legacy (format 4) package with every artifact flag set is NOT sealed", async () => {
    const integrity = await packageIntegrity(await withPackage({ version: 4, sealed: false }));
    expect(integrity).toMatchObject({ available: true, sealed: false, packageFormatVersion: 4 });
  });

  it("a format-5 package with its seal digest and key recorded is sealed", async () => {
    const integrity = await packageIntegrity(await withPackage({ version: 5, sealed: true }));
    expect(integrity).toMatchObject({ available: true, sealed: true, packageFormatVersion: 5 });
  });

  it("a format-5 row with no recorded seal is not sealed", async () => {
    const integrity = await packageIntegrity(await withPackage({ version: 5, sealed: false }));
    expect(integrity).toMatchObject({ available: true, sealed: false });
  });
});
