/**
 * Independent forward audit closure — F-31 / F-32 (2026-10-21).
 *
 * F-31: the operator signer-health probe said "healthy" for local-PEM when two
 *       files merely EXISTED, and returned the host's filesystem path. It is
 *       healthy now only when the key pair parses as Ed25519, the public file
 *       IS the private key's public half, and that key is the registered,
 *       unrevoked (SIGNING_KEY_ID, SIGNING_KEY_VERSION) evidence key; the
 *       reference it returns is the public SPKI fingerprint, never a path.
 * F-32: the package manifest signature was hardcoded SIGNED; it is the
 *       inspected fact recorded at issuance, otherwise NOT_INSPECTED.
 *
 * Real Ed25519 keys on disk; the registry is a stub (its contract is the
 * findUnique the probe makes). Expected values are literals.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: {} }));

const { probeSignerHealth } = await import("../src/services/operations/signer-health.service.js");
const { manifestSignatureStatusOf } = await import("../src/services/evidence-artifact-status.service.js");

type Row = { publicKeyPem: string; revokedAt: Date | null } | null;
const registryWith = (row: Row | Error) => ({
  signingKey: {
    findUnique: vi.fn(async () => {
      if (row instanceof Error) throw row;
      return row;
    }),
  },
});

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem,
    fingerprint: createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex"),
  };
};

describe("F-31 — local-PEM signer health is the key, not the files", () => {
  let dir: string;
  const env = { ...process.env };
  const a = pair();
  const b = pair();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "afc-signer-"));
    writeFileSync(join(dir, "a-private.pem"), a.privatePem);
    writeFileSync(join(dir, "a-public.pem"), a.publicPem);
    writeFileSync(join(dir, "b-public.pem"), b.publicPem);
    writeFileSync(join(dir, "garbage.pem"), "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n");
    const { privateKey: rsa } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    writeFileSync(join(dir, "rsa-private.pem"), rsa.export({ type: "pkcs8", format: "pem" }).toString());
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => {
    process.env = { ...env };
  });

  const configure = (priv: string, pub: string) => {
    process.env.SIGNER_PROVIDER = "local-pem";
    process.env.SIGNING_PRIVATE_KEY_PATH = join(dir, priv);
    process.env.SIGNING_PUBLIC_KEY_PATH = join(dir, pub);
    process.env.SIGNING_KEY_ID = "afc-key";
    process.env.SIGNING_KEY_VERSION = "3";
  };

  it("healthy only for the registered, unrevoked key — and the reference is its fingerprint, never a path", async () => {
    configure("a-private.pem", "a-public.pem");
    const registry = registryWith({ publicKeyPem: a.publicPem, revokedAt: null });
    const snap = await probeSignerHealth({ registry: registry as never });
    expect(snap).toMatchObject({ health: "healthy", provider: "local_pem", reason: null, publicMaterialRef: `sha256:${a.fingerprint}` });
    expect(JSON.stringify(snap)).not.toContain(dir.replace(/\\/g, "\\\\"));
    expect(JSON.stringify(snap)).not.toMatch(/\.pem/);
    expect(registry.signingKey.findUnique).toHaveBeenCalledWith({
      where: { keyId_version_purpose: { keyId: "afc-key", version: 3, purpose: "EVIDENCE_SIGNATURE" } },
      select: { publicKeyPem: true, revokedAt: true },
    });
  });

  it("a public key that is not the private key's half is a mismatch", async () => {
    configure("a-private.pem", "b-public.pem");
    const snap = await probeSignerHealth({ registry: registryWith({ publicKeyPem: a.publicPem, revokedAt: null }) as never });
    expect(snap).toMatchObject({ health: "degraded", reason: "key_pair_mismatch" });
  });

  it("files that do not parse are not healthy", async () => {
    configure("garbage.pem", "a-public.pem");
    const snap = await probeSignerHealth({ registry: registryWith({ publicKeyPem: a.publicPem, revokedAt: null }) as never });
    expect(snap).toMatchObject({ health: "degraded", reason: "pem_unparseable", publicMaterialRef: null });
  });

  it("a non-Ed25519 key is unsupported", async () => {
    configure("rsa-private.pem", "a-public.pem");
    const snap = await probeSignerHealth({ registry: registryWith(null) as never });
    expect(snap).toMatchObject({ health: "unsupported_algorithm", reason: "pem_not_ed25519" });
  });

  it("an unregistered key, a different registered key, or a revoked key is not healthy", async () => {
    configure("a-private.pem", "a-public.pem");
    expect(await probeSignerHealth({ registry: registryWith(null) as never })).toMatchObject({ health: "degraded", reason: "key_not_registered" });
    expect(await probeSignerHealth({ registry: registryWith({ publicKeyPem: b.publicPem, revokedAt: null }) as never })).toMatchObject({
      health: "degraded",
      reason: "registry_key_mismatch",
    });
    expect(
      await probeSignerHealth({ registry: registryWith({ publicKeyPem: a.publicPem, revokedAt: new Date("2026-10-01T00:00:00Z") }) as never }),
    ).toMatchObject({ health: "key_disabled", reason: "key_revoked" });
  });

  it("an unreadable registry or a missing key identity is never healthy", async () => {
    configure("a-private.pem", "a-public.pem");
    expect(await probeSignerHealth({ registry: registryWith(new Error("db down")) as never })).toMatchObject({
      health: "unknown",
      reason: "registry_unreadable",
    });
    delete process.env.SIGNING_KEY_VERSION;
    expect(await probeSignerHealth({ registry: registryWith({ publicKeyPem: a.publicPem, revokedAt: null }) as never })).toMatchObject({
      health: "degraded",
      reason: "key_identity_unset",
    });
  });

  it("a missing file names no path", async () => {
    configure("absent-private.pem", "a-public.pem");
    const snap = await probeSignerHealth({ registry: registryWith(null) as never });
    expect(snap).toMatchObject({ health: "degraded", reason: "pem_file_missing", publicMaterialRef: null });
  });
});

describe("F-32 — the package manifest signature is the inspected fact", () => {
  it("reads the recorded boolean only for the package it describes", () => {
    expect(manifestSignatureStatusOf({ signedManifestPresent: true }, true)).toBe("SIGNED");
    expect(manifestSignatureStatusOf({ signedManifestPresent: false }, true)).toBe("UNSIGNED");
    expect(manifestSignatureStatusOf({ signedManifestPresent: true }, false)).toBe("NOT_INSPECTED");
  });

  it("is never SIGNED by default", () => {
    for (const m of [null, undefined, {}, [], "SIGNED", { blocked: true }, { signedManifestPresent: "true" }]) {
      expect(manifestSignatureStatusOf(m as never, true), JSON.stringify(m)).toBe("NOT_INSPECTED");
    }
  });
});
