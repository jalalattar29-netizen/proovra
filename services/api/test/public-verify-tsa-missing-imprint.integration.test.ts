/**
 * D10 — A STAMPED RECORD WITH NO STORED IMPRINT IS NOT "TAMPERED" (2026-09-29).
 *
 * Public Verify computed `Boolean(imprint && digest) && imprint === digest`,
 * so an empty imprint column read as a timestamp MISMATCH: Basic Verify said
 * "failed", Rich Verify set overallIntegrity=false, and the review guidance
 * spoke of a mismatch — although nothing had been found to differ.
 *
 * Over real HTTP against live PostgreSQL, with a genuinely signed record:
 *   * missing imprint → timestamp not_checked (TOKEN_RECORDED_IMPRINT_NOT_COMPARED),
 *     the original's own checks verified, integrity not failed;
 *   * a real imprint mismatch → still failed.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("public Verify — TSA imprint comparison (live PostgreSQL 16, real HTTP)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const created: string[] = [];
  const keyId = `d10-fixture-${randomUUID().slice(0, 8)}`;
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

  async function signedRecord(tsa: { tsaMessageImprint: string | null; validated?: boolean }) {
    const { teamId } = harness.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { organizationId: true, ownerUserId: true },
    });
    const fileSha256 = createHash("sha256").update(randomUUID()).digest("hex");
    const row = await prisma.evidence.create({
      data: {
        title: "D10 fixture",
        type: "PHOTO",
        status: "SIGNED",
        teamId,
        organizationId: team.organizationId,
        ownerUserId: team.ownerUserId,
      },
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
        tsaStatus: "STAMPED",
        tsaTokenBase64: Buffer.from("fixture-token").toString("base64"),
        tsaGenTimeUtc: new Date(),
        tsaInputDigestHex: fileSha256,
        tsaMessageImprint: tsa.tsaMessageImprint === "SAME" ? fileSha256 : tsa.tsaMessageImprint,
        // ET-TSA-01: fixtures are VALIDATED tokens unless a case says otherwise.
        tsaValidatedAtUtc: tsa.validated === false ? null : new Date(),
      } as never,
    });
    return { id: row.id, fileSha256 };
  }

  async function verify(id: string) {
    const res = await harness.app.inject({ method: "GET", url: `/public/verify/${id}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as {
      tier: string;
      basicVerification: {
        original: { state: string };
        timestamp: { state: string; basis: string | null };
      };
      integrityProof?: { overallIntegrity?: boolean; timestampDigestMatches?: boolean | null };
    };
  }

  it("a STAMPED record with NO stored imprint: timestamp not compared, original verified, integrity not failed", async () => {
    const { id } = await signedRecord({ tsaMessageImprint: null });
    const body = await verify(id);
    expect(body.basicVerification.original.state).toBe("verified");
    expect(body.basicVerification.timestamp).toMatchObject({
      state: "not_checked",
      basis: "TOKEN_RECORDED_IMPRINT_NOT_COMPARED",
    });
    if (body.integrityProof) {
      expect(body.integrityProof.timestampDigestMatches ?? null).toBeNull();
      expect(body.integrityProof.overallIntegrity).not.toBe(false);
    }
    expect(JSON.stringify(body)).not.toMatch(/digest mismatch was detected/i);
  });

  it("ET-TSA-01: a VALIDATED token whose imprint matches reads verified on the token-validated basis", async () => {
    const { id } = await signedRecord({ tsaMessageImprint: "SAME" });
    const body = await verify(id);
    expect(body.basicVerification.timestamp).toMatchObject({
      state: "verified",
      basis: "TOKEN_VALIDATED",
    });
  });

  it("ET-TSA-01: a legacy STAMPED token that was never validated is recorded-not-validated, never a trusted timestamp", async () => {
    const { id } = await signedRecord({ tsaMessageImprint: "SAME", validated: false });
    const body = await verify(id);
    expect(body.basicVerification.timestamp).toMatchObject({
      state: "not_checked",
      basis: "TOKEN_RECORDED_NOT_VALIDATED",
    });
    // ET-TSA-03: no "imprint matches" claim is made for an unvalidated token.
    if (body.integrityProof) expect(body.integrityProof.timestampDigestMatches ?? null).toBeNull();
    expect(JSON.stringify(body)).not.toContain('"STAMPED"');
    expect(JSON.stringify(body)).toContain("RECORDED_NOT_VALIDATED");
  });

  it("a REAL imprint mismatch still fails", async () => {
    const { id } = await signedRecord({ tsaMessageImprint: "f".repeat(64) });
    const body = await verify(id);
    expect(body.basicVerification.timestamp.state).toBe("failed");
    if (body.integrityProof) expect(body.integrityProof.overallIntegrity).toBe(false);
  });
});
