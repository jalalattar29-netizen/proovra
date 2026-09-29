/**
 * ET-PKG-11 — signers/historical-verification-material.json carries no
 * infrastructure identifiers and describes each purpose with ITS key.
 *
 * On a40ca76f the file shipped the server's public-key FILE PATH (local PEM) or
 * `kms:<KMS_KEY_ID>` (an ARN embeds account and region) to every recipient,
 * and extracted SIGNING_PUBLIC_KEY_PATH once for all four purposes although the
 * package signer prefers PACKAGE_SIGNING_PUBLIC_KEY_PATH.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const kmsDer = vi.hoisted(() => ({ value: Buffer.alloc(0) }));
vi.mock("@aws-sdk/client-kms", () => ({
  KMSClient: class {
    async send() {
      return { PublicKey: new Uint8Array(kmsDer.value) };
    }
  },
  GetPublicKeyCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { buildHistoricalVerificationMaterial } = await import("../src/verification-package-historical-material.js");

function ed25519() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const der = publicKey.export({ type: "spki", format: "der" });
  return { pem, der, sha256: createHash("sha256").update(der).digest("hex") };
}

const ENV_KEYS = ["SIGNER_PROVIDER", "SIGNING_PUBLIC_KEY_PATH", "PACKAGE_SIGNING_PUBLIC_KEY_PATH", "KMS_KEY_ID", "SIGNING_KEY_ID", "SIGNING_KEY_VERSION"];
const saved: Record<string, string | undefined> = {};

describe("historical verification material (ET-PKG-11)", () => {
  let dir = "";
  const evidenceKey = ed25519();
  const packageKey = ed25519();

  beforeAll(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    dir = mkdtempSync(path.join(tmpdir(), "pkg11-"));
    writeFileSync(path.join(dir, "evidence-public.pem"), evidenceKey.pem);
    writeFileSync(path.join(dir, "package-public.pem"), packageKey.pem);
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("local PEM: the package purpose carries the PACKAGE key, the others the evidence key; no path anywhere", async () => {
    process.env.SIGNER_PROVIDER = "local-pem";
    process.env.SIGNING_PUBLIC_KEY_PATH = path.join(dir, "evidence-public.pem");
    process.env.PACKAGE_SIGNING_PUBLIC_KEY_PATH = path.join(dir, "package-public.pem");
    process.env.SIGNING_KEY_ID = "k1";
    process.env.SIGNING_KEY_VERSION = "1";
    const file = await buildHistoricalVerificationMaterial({ evidenceId: "ev-1" });
    const by = Object.fromEntries(file.signers.map((s) => [s.signerPurpose, s]));
    expect(by.verification_package!.verificationMaterial.publicKeyPem).toBe(packageKey.pem.trim());
    expect(by.verification_package!.verificationMaterial.publicKeySpkiSha256).toBe(packageKey.sha256);
    for (const p of ["report_pdf", "export_manifest", "custody_event"] as const) {
      expect(by[p]!.verificationMaterial.publicKeyPem).toBe(evidenceKey.pem.trim());
      expect(by[p]!.verificationMaterial.publicKeySpkiSha256).toBe(evidenceKey.sha256);
    }
    const json = JSON.stringify(file);
    expect(json).not.toContain(dir.replace(/\\/g, "\\\\"));
    expect(json).not.toContain("evidence-public.pem");
    expect(file.signers.every((s) => s.verificationMaterial.publicMaterialRef === null)).toBe(true);
  });

  it("AWS KMS: the key id never reaches the file; the SPKI fingerprint does", async () => {
    const kmsKey = ed25519();
    kmsDer.value = kmsKey.der;
    process.env.SIGNER_PROVIDER = "aws-kms";
    process.env.KMS_KEY_ID = "arn:aws:kms:eu-central-1:123456789012:key/secret-key-id";
    const file = await buildHistoricalVerificationMaterial({ evidenceId: "ev-2" });
    const json = JSON.stringify(file);
    expect(json).not.toContain("123456789012");
    expect(json).not.toContain("secret-key-id");
    expect(json).not.toMatch(/"kms:/);
    expect(file.signers.every((s) => s.verificationMaterial.publicKeySpkiSha256 === kmsKey.sha256)).toBe(true);
  });
});
