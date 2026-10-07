/**
 * UC-TRUST-003 — the evidence signing-key identity (live PostgreSQL 16).
 *
 *   - the production signer self-verifies every signature against the
 *     REGISTERED key: a private key that does not belong to the registered
 *     (keyId, version) is refused at signing time, nothing is returned;
 *   - a revoked key refuses to sign;
 *   - registration is insert-only: a different PEM for an existing
 *     (keyId, version) is refused and a revocation is never cleared.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const pem = (k: import("node:crypto").KeyObject, type: "spki" | "pkcs8") =>
  String(type === "spki" ? k.export({ type: "spki", format: "pem" }) : k.export({ type: "pkcs8", format: "pem" }));

describe("evidence signing-key identity (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let registry: typeof import("../src/signing/key-registry.js");
  const saved = { id: process.env.SIGNING_KEY_ID, version: process.env.SIGNING_KEY_VERSION, path: process.env.SIGNING_PRIVATE_KEY_PATH };
  const dir = mkdtempSync(join(tmpdir(), "uctrust003-"));

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    registry = await import("../src/signing/key-registry.js");
  }, 180_000);

  afterAll(async () => {
    process.env.SIGNING_KEY_ID = saved.id;
    process.env.SIGNING_KEY_VERSION = saved.version;
    process.env.SIGNING_PRIVATE_KEY_PATH = saved.path;
    await h?.cleanup();
  });

  function useSigningKey(keyId: string, privateKey: import("node:crypto").KeyObject) {
    const path = join(dir, `${keyId}.pem`);
    writeFileSync(path, pem(privateKey, "pkcs8"));
    process.env.SIGNING_KEY_ID = keyId;
    process.env.SIGNING_KEY_VERSION = "1";
    process.env.SIGNING_PRIVATE_KEY_PATH = path;
  }

  it("a private key that is not the registered key is refused at signing time", async () => {
    const keyId = `t003-${randomUUID().slice(0, 8)}`;
    const k1 = generateKeyPairSync("ed25519");
    const k2 = generateKeyPairSync("ed25519");
    await prisma.signingKey.create({ data: { keyId, version: 1, publicKeyPem: pem(k1.publicKey, "spki").trim() } });
    useSigningKey(keyId, k2.privateKey);
    const { getEvidenceSigner } = await import("../src/signing/signer.js");
    await expect(getEvidenceSigner().signFingerprintHex("ab".repeat(32))).rejects.toMatchObject({
      code: "SIGNING_KEY_IDENTITY_CONFLICT",
    });
    // The matching key signs, and the result names the registered key's fingerprint.
    useSigningKey(keyId, k1.privateKey);
    const ok = await getEvidenceSigner().signFingerprintHex("ab".repeat(32));
    expect(ok.publicKeySha256).toBe(registry.publicKeySpkiSha256(pem(k1.publicKey, "spki")));
  });

  it("a revoked key refuses to sign", async () => {
    const keyId = `t003r-${randomUUID().slice(0, 8)}`;
    const k = generateKeyPairSync("ed25519");
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: pem(k.publicKey, "spki").trim(), revokedAt: new Date() },
    });
    useSigningKey(keyId, k.privateKey);
    const { getEvidenceSigner } = await import("../src/signing/signer.js");
    await expect(getEvidenceSigner().signFingerprintHex("cd".repeat(32))).rejects.toMatchObject({ code: "SIGNING_KEY_REVOKED" });
  });

  it("registration is insert-only: a different PEM is refused and a revocation stays", async () => {
    const keyId = `t003s-${randomUUID().slice(0, 8)}`;
    const k1 = generateKeyPairSync("ed25519");
    const k2 = generateKeyPairSync("ed25519");
    expect((await registry.registerSigningKey(prisma, { keyId, version: 1, purpose: "EVIDENCE_SIGNATURE", publicKeyPem: pem(k1.publicKey, "spki") })).outcome).toBe("created");
    await prisma.signingKey.update({ where: { keyId_version_purpose: { keyId, version: 1, purpose: "EVIDENCE_SIGNATURE" } }, data: { revokedAt: new Date() } });
    const again = await registry.registerSigningKey(prisma, { keyId, version: 1, purpose: "EVIDENCE_SIGNATURE", publicKeyPem: `\n${pem(k1.publicKey, "spki")}\n` });
    expect(again.outcome).toBe("unchanged");
    expect(again.revokedAt).toBeInstanceOf(Date);
    await expect(
      registry.registerSigningKey(prisma, { keyId, version: 1, purpose: "EVIDENCE_SIGNATURE", publicKeyPem: pem(k2.publicKey, "spki") }),
    ).rejects.toMatchObject({ code: "SIGNING_KEY_IDENTITY_CONFLICT" });
    const row = await prisma.signingKey.findUniqueOrThrow({ where: { keyId_version_purpose: { keyId, version: 1, purpose: "EVIDENCE_SIGNATURE" } } });
    expect(registry.publicKeySpkiSha256(row.publicKeyPem)).toBe(registry.publicKeySpkiSha256(pem(k1.publicKey, "spki")));
    expect(row.revokedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // KEY PURPOSE (2026-10-07): a package-seal key is never an evidence key.
  // -------------------------------------------------------------------------
  it("the same (key id, version) may be registered for both purposes, as two rows with two keys", async () => {
    const keyId = `t-purpose-${randomUUID().slice(0, 8)}`;
    const evidence = generateKeyPairSync("ed25519");
    const seal = generateKeyPairSync("ed25519");
    expect((await registry.registerSigningKey(prisma, { keyId, version: 1, purpose: "EVIDENCE_SIGNATURE", publicKeyPem: pem(evidence.publicKey, "spki") })).outcome).toBe("created");
    expect((await registry.registerSigningKey(prisma, { keyId, version: 1, purpose: "PACKAGE_SEAL", publicKeyPem: pem(seal.publicKey, "spki") })).outcome).toBe("created");
    const rows = await prisma.signingKey.findMany({ where: { keyId }, select: { purpose: true, algorithm: true, fingerprintSha256: true } });
    expect(rows.map((r) => r.purpose).sort()).toEqual(["EVIDENCE_SIGNATURE", "PACKAGE_SEAL"]);
    expect(rows.every((r) => r.algorithm === "Ed25519" && /^[0-9a-f]{64}$/.test(r.fingerprintSha256 ?? ""))).toBe(true);

    // The evidence path finds ONLY the evidence key.
    const ev = await registry.findRegisteredSigningKey(prisma, { keyId, version: 1, purpose: "EVIDENCE_SIGNATURE" });
    expect(ev?.fingerprintSha256).toBe(registry.publicKeySpkiSha256(pem(evidence.publicKey, "spki")));

    // A signature made with the SEAL key does not verify as an evidence signature.
    const { sign } = await import("node:crypto");
    const message = "ab".repeat(32);
    const sealSig = sign(null, Buffer.from(message, "hex"), seal.privateKey).toString("base64");
    await expect(
      registry.assertSignatureVerifiesWithRegisteredKey(prisma, {
        keyId,
        version: 1,
        purpose: "EVIDENCE_SIGNATURE",
        messageHex: message,
        signatureBase64: sealSig,
      }),
    ).rejects.toMatchObject({ code: "SIGNING_SELF_VERIFICATION_FAILED" });
    // …and the evidence key's own signature does.
    const evSig = sign(null, Buffer.from(message, "hex"), evidence.privateKey).toString("base64");
    await expect(
      registry.assertSignatureVerifiesWithRegisteredKey(prisma, {
        keyId,
        version: 1,
        purpose: "EVIDENCE_SIGNATURE",
        messageHex: message,
        signatureBase64: evSig,
      }),
    ).resolves.toMatchObject({ publicKeySha256: ev!.fingerprintSha256 });
  });

  it("a key registered ONLY for package sealing is not an evidence key", async () => {
    const keyId = `t-seal-only-${randomUUID().slice(0, 8)}`;
    const seal = generateKeyPairSync("ed25519");
    await registry.registerSigningKey(prisma, { keyId, version: 1, purpose: "PACKAGE_SEAL", publicKeyPem: pem(seal.publicKey, "spki") });
    expect(await registry.findRegisteredSigningKey(prisma, { keyId, version: 1, purpose: "EVIDENCE_SIGNATURE" })).toBeNull();
    const { sign } = await import("node:crypto");
    const message = "cd".repeat(32);
    await expect(
      registry.assertSignatureVerifiesWithRegisteredKey(prisma, {
        keyId,
        version: 1,
        purpose: "EVIDENCE_SIGNATURE",
        messageHex: message,
        signatureBase64: sign(null, Buffer.from(message, "hex"), seal.privateKey).toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "SIGNING_KEY_NOT_REGISTERED" });
  });

  it("the public binding of a seal key states purpose, validity, rotation and revocation — bounded to that identity", async () => {
    const keyId = `t-binding-${randomUUID().slice(0, 8)}`;
    const v1 = generateKeyPairSync("ed25519");
    const v2 = generateKeyPairSync("ed25519");
    await registry.registerSigningKey(prisma, { keyId, version: 1, purpose: "PACKAGE_SEAL", publicKeyPem: pem(v1.publicKey, "spki") });
    const active = await registry.describePublicSigningKey(prisma, { keyId, version: 1, purpose: "PACKAGE_SEAL" });
    expect(active).toMatchObject({ purpose: "PACKAGE_SEAL", algorithm: "Ed25519", keyId, version: 1, status: "ACTIVE", supersededByVersion: null, revokedAtUtc: null });
    await registry.registerSigningKey(prisma, { keyId, version: 2, purpose: "PACKAGE_SEAL", publicKeyPem: pem(v2.publicKey, "spki") });
    const rotated = await registry.describePublicSigningKey(prisma, { keyId, version: 1, purpose: "PACKAGE_SEAL" });
    expect(rotated).toMatchObject({ status: "SUPERSEDED", supersededByVersion: 2 });
    expect(rotated!.validUntilUtc).toBeTruthy();
    await prisma.signingKey.update({
      where: { keyId_version_purpose: { keyId, version: 1, purpose: "PACKAGE_SEAL" } },
      data: { revokedAt: new Date() },
    });
    expect(await registry.describePublicSigningKey(prisma, { keyId, version: 1, purpose: "PACKAGE_SEAL" })).toMatchObject({ status: "REVOKED" });
    // An evidence key of the same identity would not be described here.
    expect(await registry.describePublicSigningKey(prisma, { keyId, version: 1, purpose: "EVIDENCE_SIGNATURE" })).toBeNull();
  });

  it("purpose, algorithm and a recorded fingerprint are immutable (trigger)", async () => {
    const keyId = `t-immut-${randomUUID().slice(0, 8)}`;
    const k = generateKeyPairSync("ed25519");
    await registry.registerSigningKey(prisma, { keyId, version: 1, purpose: "PACKAGE_SEAL", publicKeyPem: pem(k.publicKey, "spki") });
    const where = { keyId_version_purpose: { keyId, version: 1, purpose: "PACKAGE_SEAL" } };
    await expect(prisma.signingKey.update({ where, data: { purpose: "EVIDENCE_SIGNATURE" } })).rejects.toThrow();
    await expect(prisma.signingKey.update({ where, data: { fingerprintSha256: "0".repeat(64) } })).rejects.toThrow();
  });
  it("the seed registers the package seal key as PACKAGE_SEAL — never as an evidence key — even when it shares the evidence pair", async () => {
    const { seedSigningKeyRows } = await import("../src/seed-signing-key.js");
    const k = generateKeyPairSync("ed25519");
    const publicKeyPem = pem(k.publicKey, "spki");
    const evidenceId = `t-seed-ev-${randomUUID().slice(0, 8)}`;
    const sealId = `t-seed-pk-${randomUUID().slice(0, 8)}`;
    const rows = (keyId: string) =>
      prisma.signingKey.findMany({ where: { keyId }, select: { version: true, purpose: true }, orderBy: { purpose: "asc" } });

    await seedSigningKeyRows(prisma, {
      evidence: { keyId: evidenceId, version: 1 },
      packageSeal: { keyId: sealId, version: 1 },
      publicKeyPem,
      providerLabel: "test",
    });
    expect(await rows(evidenceId)).toEqual([{ version: 1, purpose: "EVIDENCE_SIGNATURE" }]);
    expect(await rows(sealId)).toEqual([{ version: 1, purpose: "PACKAGE_SEAL" }]);
    // The seal identity is not an evidence key: the evidence lookup finds nothing.
    expect(await registry.findRegisteredSigningKey(prisma, { keyId: sealId, version: 1, purpose: "EVIDENCE_SIGNATURE" })).toBeNull();

    // Shared identity: one pair published for both purposes, as two rows.
    const sharedId = `t-seed-sh-${randomUUID().slice(0, 8)}`;
    await seedSigningKeyRows(prisma, {
      evidence: { keyId: sharedId, version: 1 },
      packageSeal: { keyId: sharedId, version: 1 },
      publicKeyPem,
      providerLabel: "test",
    });
    expect(await rows(sharedId)).toEqual([
      { version: 1, purpose: "EVIDENCE_SIGNATURE" },
      { version: 1, purpose: "PACKAGE_SEAL" },
    ]);
    // Re-running is a no-op (insert-only).
    await seedSigningKeyRows(prisma, {
      evidence: { keyId: sharedId, version: 1 },
      packageSeal: { keyId: sharedId, version: 1 },
      publicKeyPem,
      providerLabel: "test",
    });
    expect(await rows(sharedId)).toHaveLength(2);
  });
});
