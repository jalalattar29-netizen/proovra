/**
 * CRYPTO-001 and CRYPTO-003 — a revoked key reaches what verification reads, and
 * an attestation is judged by the key that signed it. Live PostgreSQL 16.
 *
 * The console wrote only signer_control_state, which stops new signing. Every
 * verifier reads signing_keys.revoked_at, and nothing wrote it, so a key declared
 * compromised kept reading "Signature verified". Attestations were verified
 * against today's key, so rotation looked like tampering, and any provider error
 * read as a bad signature.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("signer revocation and attestation truth (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const A = () => h.fixtures.teamA;
  const signingKeyIdBefore = process.env.SIGNING_KEY_ID;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);
  afterAll(async () => {
    process.env.SIGNING_KEY_ID = signingKeyIdBefore;
    await h?.cleanup();
  });

  const pair = () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return { pem: publicKey.export({ type: "spki", format: "pem" }).toString().trim(), privateKey };
  };

  async function signedRecord(keyId: string, version: number, privateKey: ReturnType<typeof pair>["privateKey"]) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const row = await prisma.evidence.create({
      data: { title: "revocation", type: "PHOTO", status: "SIGNED", teamId: A().teamId, organizationId: team.organizationId, ownerUserId: A().ownerUserId, signedAtUtc: new Date() } as never,
      select: { id: true },
    });
    const fileSha256 = sha(randomUUID());
    const canonical = JSON.stringify({ v: 1, evidenceId: row.id, sha256: fileSha256 });
    const fingerprintHash = sha(canonical);
    const { generateVerificationRef } = await import("@proovra/shared-runtime");
    const verificationRef = generateVerificationRef();
    await prisma.evidence.update({
      where: { id: row.id },
      data: {
        fileSha256,
        fingerprintCanonicalJson: canonical,
        fingerprintHash,
        signatureBase64: sign(null, Buffer.from(fingerprintHash, "hex"), privateKey).toString("base64"),
        signingKeyId: keyId,
        signingKeyVersion: version,
        verificationRef,
        verificationRefIssuedAtUtc: new Date(),
      } as never,
    });
    return { id: row.id, verificationRef };
  }

  const matrixRow = async (ref: string) => {
    const body = (await h.app.inject({ method: "GET", url: `/public/verify/${ref}` })).json();
    return (body.verificationMatrix.rows as Array<{ key: string; status: string; statement?: string; label?: string }>).find((r) => /signature/.test(r.key));
  };

  it("CRYPTO-001: revoking a signer reaches the registry for every purpose of the key, and verification says so", async () => {
    const { listAllSigners } = await import("../src/services/operations/signer-registry.service.js");
    const { revokeSigner } = await import("../src/services/operations/signer-rotation.service.js");
    // A key of this test's own: signing_keys is append-only, so nothing is cleaned up.
    process.env.SIGNING_KEY_ID = `revoke-${randomUUID().slice(0, 8)}`;
    const signers = await listAllSigners({ teamId: A().teamId });
    const target = signers.find((s) => s.signerPurpose === "custody_event" && s.keyId);
    expect(target, "a configured custody signer").toBeTruthy();
    const keyId = target!.keyId!;
    const version = Number(target!.keyVersion);

    const key = pair();
    await prisma.signingKey.create({ data: { keyId, version, publicKeyPem: key.pem, purpose: "EVIDENCE_SIGNATURE" } as never });
    await prisma.signingKey.create({ data: { keyId, version, publicKeyPem: key.pem, purpose: "PACKAGE_SEAL" } as never });
    const other = pair();
    const otherKeyId = `other-${randomUUID().slice(0, 8)}`;
    await prisma.signingKey.create({ data: { keyId: otherKeyId, version: 1, publicKeyPem: other.pem } as never });

    const record = await signedRecord(keyId, version, key.privateKey);
    const control = await signedRecord(otherKeyId, 1, other.privateKey);
    const before = await matrixRow(record.verificationRef);
    expect(before?.status, "positive control: trusted before revocation").toBe((await matrixRow(control.verificationRef))?.status);

    const res = await revokeSigner({ teamId: A().teamId, actorUserId: A().ownerUserId, signerId: target!.signerId, reason: "Key material compromised" });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });

    const rows = await prisma.signingKey.findMany({ where: { keyId, version }, select: { purpose: true, revokedAt: true } });
    expect(rows.map((r) => r.purpose).sort()).toEqual(["EVIDENCE_SIGNATURE", "PACKAGE_SEAL"]);
    expect(rows.every((r) => r.revokedAt instanceof Date)).toBe(true);
    expect((await prisma.signingKey.findFirstOrThrow({ where: { keyId: otherKeyId } })).revokedAt, "another key is untouched").toBeNull();

    const after = await matrixRow(record.verificationRef);
    expect(after?.status).not.toBe(before?.status);
    expect((await matrixRow(control.verificationRef))?.status, "the other key's record still verifies").toBe(before?.status);

    // A second click keeps the first revocation time.
    const stamped = rows[0]!.revokedAt!.toISOString();
    await revokeSigner({ teamId: A().teamId, actorUserId: A().ownerUserId, signerId: target!.signerId, reason: "Again" });
    const again = await prisma.signingKey.findFirstOrThrow({ where: { keyId, version, purpose: rows[0]!.purpose } });
    expect(again.revokedAt!.toISOString()).toBe(stamped);
  });

  describe("CRYPTO-003", () => {
    async function attested(over: { unregistered?: boolean; keyId?: string; version?: number; signWith?: ReturnType<typeof pair>["privateKey"]; provider?: string; algorithm?: string } = {}) {
      const { buildCanonicalPayload, hashCanonicalPayload } = await import("../src/services/operations/custody-attestation.service.js");
      const key = pair();
      const keyId = over.keyId ?? `att-${randomUUID().slice(0, 8)}`;
      const version = over.version ?? 1;
      if (!over.unregistered) await prisma.signingKey.create({ data: { keyId, version, publicKeyPem: key.pem } as never });
      const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
      const ev = await prisma.evidence.create({
        data: { title: "attested", type: "PHOTO", status: "SIGNED", teamId: A().teamId, organizationId: team.organizationId, ownerUserId: A().ownerUserId } as never,
        select: { id: true },
      });
      const event = await prisma.custodyEvent.create({
        data: { evidenceId: ev.id, sequence: 1, eventType: "EVIDENCE_CREATED", atUtc: new Date(), payload: {}, eventHash: sha(randomUUID()) } as never,
      });
      const hash = hashCanonicalPayload(buildCanonicalPayload(event as never));
      const attestationId = randomUUID();
      const signature = sign(null, Buffer.from(hash, "hex"), over.signWith ?? key.privateKey).toString("base64");
      await prisma.securityEvent.create({
        data: {
          teamId: A().teamId,
          eventType: "custody_attestation_signed",
          severity: "INFO",
          details: {
            attestationId,
            custodyEventId: event.id,
            attestation: {
              attestationId,
              custodyEventId: event.id,
              evidenceId: ev.id,
              canonicalPayloadHash: hash,
              signature,
              provider: over.provider ?? "aws_kms",
              algorithm: over.algorithm ?? "ED25519_SHA_512",
              keyId,
              keyVersion: String(version),
            },
          },
        } as never,
      });
      return { attestationId, keyId };
    }
    const verify = async (attestationId: string) => {
      const { verifyCustodyAttestation } = await import("../src/services/operations/custody-attestation.service.js");
      return verifyCustodyAttestation({ teamId: A().teamId, attestationId, actorUserId: A().ownerUserId });
    };

    it("an attestation verifies against its own key after the current key moved on, with no KMS call", async () => {
      const { attestationId } = await attested();
      expect((await verify(attestationId)).outcome).toBe("verified");
    });

    it("a wrong signature is still invalid", async () => {
      const { attestationId } = await attested({ signWith: pair().privateKey });
      expect((await verify(attestationId)).outcome).toBe("signature_invalid");
    });

    it("a key the registry does not hold is unavailable, not a bad signature", async () => {
      const { attestationId } = await attested({ unregistered: true });
      expect((await verify(attestationId)).outcome).toBe("signer_unavailable");
    });

    it("a revoked key is unavailable, as the runbook states", async () => {
      const { attestationId, keyId } = await attested();
      await prisma.signingKey.updateMany({ where: { keyId }, data: { revokedAt: new Date() } });
      const res = await verify(attestationId);
      expect(res.outcome).toBe("signer_unavailable");
      expect(res.summary).toContain("revoked");
    });

    it("an older attestation is found however many newer ones the workspace holds", async () => {
      const { attestationId } = await attested();
      await prisma.securityEvent.createMany({
        data: Array.from({ length: 600 }, (_, i) => ({
          teamId: A().teamId,
          eventType: "custody_attestation_signed",
          severity: "INFO",
          details: { attestationId: `noise-${i}` },
        })) as never,
      });
      expect((await verify(attestationId)).outcome).toBe("verified");
    });
  });
});
