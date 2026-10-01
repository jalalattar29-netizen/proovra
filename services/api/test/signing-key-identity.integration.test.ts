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
    expect((await registry.registerSigningKey(prisma, { keyId, version: 1, publicKeyPem: pem(k1.publicKey, "spki") })).outcome).toBe("created");
    await prisma.signingKey.update({ where: { keyId_version: { keyId, version: 1 } }, data: { revokedAt: new Date() } });
    const again = await registry.registerSigningKey(prisma, { keyId, version: 1, publicKeyPem: `\n${pem(k1.publicKey, "spki")}\n` });
    expect(again.outcome).toBe("unchanged");
    expect(again.revokedAt).toBeInstanceOf(Date);
    await expect(
      registry.registerSigningKey(prisma, { keyId, version: 1, publicKeyPem: pem(k2.publicKey, "spki") }),
    ).rejects.toMatchObject({ code: "SIGNING_KEY_IDENTITY_CONFLICT" });
    const row = await prisma.signingKey.findUniqueOrThrow({ where: { keyId_version: { keyId, version: 1 } } });
    expect(registry.publicKeySpkiSha256(row.publicKeyPem)).toBe(registry.publicKeySpkiSha256(pem(k1.publicKey, "spki")));
    expect(row.revokedAt).not.toBeNull();
  });
});
