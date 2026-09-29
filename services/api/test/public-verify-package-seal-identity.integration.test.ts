/**
 * ET-PKG-02 / ET-PKG-12 — Public Verify publishes what a recipient needs to
 * check a package and a report copy they hold. Live PostgreSQL 16, real HTTP.
 *
 * On a40ca76f the seal key existed only inside the ZIP (anyone re-sealing an
 * altered package with their own key produced a package that verified), Public
 * Verify returned no fingerprint and no package digest while the page said the
 * package was sealed, and it said a report copy "can be checked" without
 * returning the digest to check it against.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("public Verify — package seal identity and report digest (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const created: string[] = [];
  const keyId = `pkg02-fixture-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString().trim();

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.signingKey.create({ data: { keyId, version: 1, publicKeyPem } });
  }, 180_000);

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence
        .updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } })
        .catch(() => undefined);
    }
    await harness?.cleanup();
  });

  async function recordWithPackage(seal: { sealSigningKeySha256: string | null; packageSha256: string | null }) {
    const { teamId } = harness.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { organizationId: true, ownerUserId: true },
    });
    const fileSha256 = createHash("sha256").update(randomUUID()).digest("hex");
    const row = await prisma.evidence.create({
      data: { title: "PKG-02 fixture", type: "PHOTO", status: "REPORTED", teamId, organizationId: team.organizationId, ownerUserId: team.ownerUserId },
      select: { id: true },
    });
    created.push(row.id);
    const canonical = JSON.stringify({ v: 1, evidenceId: row.id, sha256: fileSha256 });
    const fingerprintHash = createHash("sha256").update(canonical).digest("hex");
    const signatureBase64 = sign(null, Buffer.from(fingerprintHash, "hex"), privateKey).toString("base64");
    await prisma.evidence.update({
      where: { id: row.id },
      data: {
        fileSha256,
        fingerprintCanonicalJson: canonical,
        fingerprintHash,
        signatureBase64,
        signingKeyId: keyId,
        signingKeyVersion: 1,
        signedAtUtc: new Date(),
      } as never,
    });
    const reportSha256 = "c".repeat(64);
    const now = new Date();
    await prisma.report.create({
      data: { evidenceId: row.id, version: 1, storageBucket: "b", storageKey: `r/${row.id}.pdf`, generatedAtUtc: now, pdfSha256: reportSha256 } as never,
    });
    await prisma.verificationPackage.create({
      data: {
        evidenceId: row.id,
        version: 1,
        storageBucket: "b",
        storageKey: `p/${row.id}.zip`,
        generatedAtUtc: now,
        reportVersion: 1,
        reportSha256,
        packageFormatVersion: 5,
        ...seal,
      } as never,
    });
    return { id: row.id, reportSha256 };
  }

  async function basic(id: string) {
    const res = await harness.app.inject({ method: "GET", url: `/public/verify/${id}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().basicVerification as {
      report: { sha256: string | null };
      package: { sealed: boolean; packageSha256: string | null; sealKeyFingerprint: string | null };
    };
  }

  it("serves the seal key fingerprint and the package digest PROOVRA recorded", async () => {
    const fp = "d".repeat(64);
    const zip = "e".repeat(64);
    const { id, reportSha256 } = await recordWithPackage({ sealSigningKeySha256: fp, packageSha256: zip });
    const b = await basic(id);
    expect(b.package).toMatchObject({ sealed: true, sealKeyFingerprint: fp, packageSha256: zip });
    // ET-PKG-12: the report digest the page says a copy can be checked against.
    expect(b.report.sha256).toBe(reportSha256);
  });

  it("a package sealed before the identity was recorded says so (null), never a fabricated value", async () => {
    const { id } = await recordWithPackage({ sealSigningKeySha256: null, packageSha256: null });
    const b = await basic(id);
    expect(b.package).toMatchObject({ sealed: true, sealKeyFingerprint: null, packageSha256: null });
  });
});
