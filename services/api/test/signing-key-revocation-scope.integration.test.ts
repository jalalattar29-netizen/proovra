/**
 * SIGNER AUTHORIZATION VERSUS KEY COMPROMISE (2026-11-04). Live PostgreSQL 16.
 *
 * On 69251a953 revoking one signer from the console revoked every registry row
 * of the same key FILE, so a deployment whose evidence signer and package seal
 * share a file lost package sealing when one signer's authorization was
 * withdrawn. The fix makes the scope explicit:
 *
 *   authorization   one signer (one purpose of one key identity) stops signing.
 *                   signing_keys is not touched: what it signed still verifies,
 *                   and another purpose served by the same material keeps
 *                   working.
 *   key_compromise  the material is compromised: every registry row of it (any
 *                   key id, version or purpose) is revoked, every signer naming
 *                   one of those identities is withdrawn, verification reports
 *                   it, and the material registered later is born revoked.
 *
 * The package seal is driven through the worker's own boundary
 * (assertWorkerSignerUsable, signPackageManifestDigest, bindPackageSealKey).
 */
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ENV_KEYS = [
  "SIGNING_KEY_ID",
  "SIGNING_KEY_VERSION",
  "PACKAGE_SIGNING_KEY_ID",
  "PACKAGE_SIGNING_KEY_VERSION",
  "PACKAGE_SIGNING_PRIVATE_KEY_PATH",
  "PACKAGE_SIGNING_PUBLIC_KEY_PATH",
] as const;

describe("signer authorization vs key compromise (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let rotation: typeof import("../src/services/operations/signer-rotation.service.js");
  let control: typeof import("../src/services/operations/signer-control-state.service.js");
  let registry: typeof import("../src/services/operations/signer-registry.service.js");
  let evidenceSigner: typeof import("../src/signing/signer.js");
  let runtime: typeof import("@proovra/shared-runtime");
  let guard: typeof import("../../worker/src/signing/signer-control-guard.js");
  let packageSigner: typeof import("../../worker/src/signing/package-signer.js");
  let sealKey: typeof import("../../worker/src/signing/package-seal-key.js");
  const saved: Record<string, string | undefined> = {};
  const A = () => h.fixtures.teamA;
  const dir = mkdtempSync(path.join(tmpdir(), "proovra-revocation-scope-"));

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    rotation = await import("../src/services/operations/signer-rotation.service.js");
    control = await import("../src/services/operations/signer-control-state.service.js");
    registry = await import("../src/services/operations/signer-registry.service.js");
    evidenceSigner = await import("../src/signing/signer.js");
    runtime = await import("@proovra/shared-runtime");
    guard = await import("../../worker/src/signing/signer-control-guard.js");
    packageSigner = await import("../../worker/src/signing/package-signer.js");
    sealKey = await import("../../worker/src/signing/package-seal-key.js");
  }, 180_000);
  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await h?.cleanup();
  });

  /** A key pair of this test's own, on disk for the worker's local-pem seal. */
  function keyFile(name: string) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
    const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pubPath = path.join(dir, `${name}-public.pem`);
    const privPath = path.join(dir, `${name}-private.pem`);
    writeFileSync(pubPath, pub);
    writeFileSync(privPath, priv);
    return { pem: pub.trim(), privateKey, pubPath, privPath };
  }

  /**
   * The layout the retest ran: the evidence signer and the package seal are two
   * identities on ONE key file, each registered for its own purpose.
   * signing_keys is append-only, so every case uses identities of its own.
   */
  async function sharedFileDeployment() {
    const t = randomUUID().slice(0, 8);
    const key = keyFile(`shared-${t}`);
    const evid = `evid-${t}`;
    const pkg = `pkg-${t}`;
    process.env.SIGNING_KEY_ID = evid;
    process.env.SIGNING_KEY_VERSION = "1";
    process.env.PACKAGE_SIGNING_KEY_ID = pkg;
    process.env.PACKAGE_SIGNING_KEY_VERSION = "1";
    process.env.PACKAGE_SIGNING_PRIVATE_KEY_PATH = key.privPath;
    process.env.PACKAGE_SIGNING_PUBLIC_KEY_PATH = key.pubPath;
    await prisma.signingKey.create({ data: { keyId: evid, version: 1, publicKeyPem: key.pem, purpose: "EVIDENCE_SIGNATURE", fingerprintSha256: runtime.publicKeySpkiSha256(key.pem) } as never });
    await prisma.signingKey.create({ data: { keyId: pkg, version: 1, publicKeyPem: key.pem, purpose: "PACKAGE_SEAL", fingerprintSha256: runtime.publicKeySpkiSha256(key.pem) } as never });
    const signers = await registry.listAllSigners({ teamId: A().teamId });
    const of = (purpose: string) => signers.find((s) => s.signerPurpose === purpose)!.signerId;
    return { key, evid, pkg, custodySigner: of("custody_event"), packageSigner: of("verification_package") };
  }

  async function signedRecord(keyId: string, privateKey: ReturnType<typeof keyFile>["privateKey"]) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const row = await prisma.evidence.create({
      data: { title: "revocation scope", type: "PHOTO", status: "SIGNED", teamId: A().teamId, organizationId: team.organizationId, ownerUserId: A().ownerUserId, signedAtUtc: new Date() } as never,
      select: { id: true },
    });
    const fileSha256 = sha(randomUUID());
    const canonical = JSON.stringify({ v: 1, evidenceId: row.id, sha256: fileSha256 });
    const fingerprintHash = sha(canonical);
    const verificationRef = runtime.generateVerificationRef();
    await prisma.evidence.update({
      where: { id: row.id },
      data: {
        fileSha256,
        fingerprintCanonicalJson: canonical,
        fingerprintHash,
        signatureBase64: sign(null, Buffer.from(fingerprintHash, "hex"), privateKey).toString("base64"),
        signingKeyId: keyId,
        signingKeyVersion: 1,
        verificationRef,
        verificationRefIssuedAtUtc: new Date(),
      } as never,
    });
    return verificationRef;
  }

  const signatureRow = async (ref: string) => {
    const body = (await h.app.inject({ method: "GET", url: `/public/verify/${ref}` })).json();
    return (body.verificationMatrix.rows as Array<{ key: string; status: string }>).find((r) => /signature/.test(r.key));
  };

  /** The worker's package seal, end to end: boundary, signature, registry binding, verification. */
  async function seal() {
    await guard.assertWorkerSignerUsable("verification_package");
    const digest = sha(randomUUID());
    const signature = await packageSigner.signPackageManifestDigest(digest);
    const bound = await sealKey.bindPackageSealKey(signature);
    const row = await runtime.findRegisteredSigningKey(prisma as never, { keyId: bound.signingKeyId, version: bound.signingKeyVersion, purpose: "PACKAGE_SEAL" });
    expect(row?.revokedAt ?? null).toBeNull();
    expect(verify(null, Buffer.from(digest, "hex"), `${row!.publicKeyPem}\n`, Buffer.from(signature.signatureBase64, "base64"))).toBe(true);
    return bound;
  }

  const keyRows = (keyIds: string[]) =>
    prisma.signingKey.findMany({ where: { keyId: { in: keyIds } }, select: { keyId: true, purpose: true, revokedAt: true }, orderBy: { keyId: "asc" } });

  it("an authorization revoke withdraws one signer and leaves the other purpose's key, and every signature, working", async () => {
    const d = await sharedFileDeployment();
    const ref = await signedRecord(d.evid, d.key.privateKey);
    const before = await signatureRow(ref);
    expect((await seal()).signingKeyId, "positive control: sealing works before").toBe(d.pkg);

    const res = await rotation.revokeSigner({ teamId: A().teamId, actorUserId: A().ownerUserId, signerId: d.custodySigner, reason: "custody signer withdrawn", scope: "authorization" });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true, state: "changed", status: "REVOKED" });

    // The key material is not declared compromised: no registry row moved.
    expect((await keyRows([d.evid, d.pkg])).every((r) => r.revokedAt === null)).toBe(true);
    expect(await control.getEffectiveSignerStatus(d.custodySigner)).toBe("REVOKED");
    expect(await control.getEffectiveSignerStatus(d.packageSigner)).toBe("ACTIVE");
    // The withdrawn signer refuses at the signing boundary...
    await expect(evidenceSigner.getEvidenceSigner().signFingerprintHex("ab".repeat(32))).rejects.toMatchObject({ code: "signer_not_usable" });
    // ...while sealing, a different purpose on the same file, continues.
    expect((await seal()).signingKeyId).toBe(d.pkg);
    // What it signed before still reads as it did.
    expect((await signatureRow(ref))?.status).toBe(before?.status);

    // A compromise found later is still declared, from the revoked state, and
    // then reaches every use of the key.
    const compromised = await rotation.revokeSigner({ teamId: A().teamId, actorUserId: A().ownerUserId, signerId: d.custodySigner, reason: "now known compromised", scope: "key_compromise" });
    expect(compromised).toMatchObject({ ok: true, state: "changed", scope: "key_compromise", revokedKeyRows: 2 });
    expect((await keyRows([d.evid, d.pkg])).every((r) => r.revokedAt instanceof Date)).toBe(true);
    expect(await control.getEffectiveSignerStatus(d.packageSigner)).toBe("REVOKED");
    expect((await signatureRow(ref))?.status).not.toBe(before?.status);
  });

  it("a key compromise revokes every purpose using the material, verification shows it, and sealing continues with an unaffected key", async () => {
    const d = await sharedFileDeployment();
    const ref = await signedRecord(d.evid, d.key.privateKey);
    const before = await signatureRow(ref);
    expect((await seal()).signingKeyId).toBe(d.pkg);

    const res = await rotation.revokeSigner({ teamId: A().teamId, actorUserId: A().ownerUserId, signerId: d.custodySigner, reason: "private key leaked", scope: "key_compromise" });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true, state: "changed", status: "REVOKED", keyMaterialResolved: true, revokedKeyRows: 2 });
    const rows = await keyRows([d.evid, d.pkg]);
    expect(rows.map((r) => `${r.keyId}:${r.purpose}`)).toEqual([`${d.evid}:EVIDENCE_SIGNATURE`, `${d.pkg}:PACKAGE_SEAL`]);
    expect(rows.every((r) => r.revokedAt instanceof Date), "every use of the key, the seal under another key id included").toBe(true);
    expect((res as { revokedSignerIds: string[] }).revokedSignerIds).toEqual(expect.arrayContaining([d.custodySigner, d.packageSigner]));

    // A repeat changes nothing and says so; the first revocation time stands.
    const stamped = rows[0]!.revokedAt!.toISOString();
    const again = await rotation.revokeSigner({ teamId: A().teamId, actorUserId: A().ownerUserId, signerId: d.custodySigner, reason: "again", scope: "key_compromise" });
    expect(again).toMatchObject({ ok: true, state: "already", revokedKeyRows: 0, revokedSignerIds: [] });
    expect((await prisma.signingKey.findFirstOrThrow({ where: { keyId: d.evid } })).revokedAt!.toISOString()).toBe(stamped);

    // Verification says so: the record's signature and the seal key's public binding.
    expect((await signatureRow(ref))?.status).not.toBe(before?.status);
    expect((await runtime.describePublicSigningKey(prisma as never, { keyId: d.pkg, version: 1, purpose: "PACKAGE_SEAL" }))?.status).toBe("REVOKED");

    // Rejected at sign: the package seal boundary, the seal binding, the evidence self-verify.
    await expect(guard.assertWorkerSignerUsable("verification_package")).rejects.toMatchObject({ code: "signer_not_usable" });
    const signature = await packageSigner.signPackageManifestDigest(sha(randomUUID()));
    await expect(sealKey.bindPackageSealKey(signature)).rejects.toMatchObject({ code: "PACKAGE_SEAL_KEY_REVOKED" });
    const message = sha(randomUUID());
    await expect(
      runtime.assertSignatureVerifiesWithRegisteredKey(prisma as never, {
        keyId: d.evid,
        version: 1,
        purpose: "EVIDENCE_SIGNATURE",
        messageHex: message,
        signatureBase64: sign(null, Buffer.from(message, "hex"), d.key.privateKey).toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "SIGNING_KEY_REVOKED" });
    expect(await runtime.isKeyIdentityCompromised(prisma as never, { keyId: d.pkg, version: 1 })).toBe(true);

    // The material stays compromised under a new identity: born revoked.
    const reused = await runtime.registerSigningKey(prisma as never, { keyId: `reuse-${randomUUID().slice(0, 8)}`, version: 1, purpose: "PACKAGE_SEAL", publicKeyPem: d.key.pem });
    expect(reused.outcome).toBe("created");
    expect(reused.revokedAt).toBeInstanceOf(Date);

    // An unaffected key keeps sealing: a distinct package key of its own.
    const fresh = keyFile(`fresh-${randomUUID().slice(0, 8)}`);
    const freshId = `pkg-fresh-${randomUUID().slice(0, 8)}`;
    process.env.PACKAGE_SIGNING_KEY_ID = freshId;
    process.env.PACKAGE_SIGNING_PRIVATE_KEY_PATH = fresh.privPath;
    process.env.PACKAGE_SIGNING_PUBLIC_KEY_PATH = fresh.pubPath;
    expect((await seal()).signingKeyId).toBe(freshId);
    expect(await runtime.isKeyIdentityCompromised(prisma as never, { keyId: freshId, version: 1 })).toBe(false);
  });

  it("a signer that names no key identity cannot be declared compromised; its authorization can still be revoked", async () => {
    const signerId = `export_manifest:local_pem:_:_`;
    await prisma.securityEvent.create({
      data: {
        teamId: A().teamId,
        eventType: "signer_staged",
        severity: "INFO",
        details: { actorUserId: A().ownerUserId, signerId, signerPurpose: "export_manifest", provider: "local_pem", keyId: null, keyVersion: null },
      } as never,
    });
    const refused = await rotation.revokeSigner({ teamId: A().teamId, actorUserId: A().ownerUserId, signerId, reason: "x", scope: "key_compromise" });
    expect(refused).toMatchObject({ ok: false, code: "key_identity_unknown" });
    expect(await prisma.signerControlState.findUnique({ where: { signerId } })).toBeNull();
  });
});
