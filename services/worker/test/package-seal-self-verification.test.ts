/**
 * ET-PKG-05 — a package is never published with a seal that does not verify.
 *
 * Public Verify now calls a package "sealed" when its format-5 seal digest and
 * signing-key fingerprint are recorded. That is only a verification claim if
 * the builder refuses a seal whose signature fails against the key it ships —
 * which it did not check (a KMS or key-configuration fault would have produced
 * a recorded, unverifiable seal).
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { assertSealSignatureVerifies } from "../src/verification-package.js";

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
};
const sealSha256 = createHash("sha256").update("package-seal.json bytes").digest("hex");

describe("assertSealSignatureVerifies", () => {
  it("accepts a seal signed by the key the package ships", () => {
    const k = pair();
    const signatureBase64 = sign(null, Buffer.from(sealSha256, "hex"), k.privateKey).toString("base64");
    expect(() => assertSealSignatureVerifies({ sealSha256, signatureBase64, publicKeyPem: k.publicKeyPem })).not.toThrow();
  });

  it("refuses a seal signed by another key, a tampered signature and an unreadable key", () => {
    const signer = pair();
    const shipped = pair();
    const signatureBase64 = sign(null, Buffer.from(sealSha256, "hex"), signer.privateKey).toString("base64");
    expect(() => assertSealSignatureVerifies({ sealSha256, signatureBase64, publicKeyPem: shipped.publicKeyPem })).toThrow(
      "PACKAGE_SEAL_SIGNATURE_DOES_NOT_VERIFY",
    );
    const tampered = Buffer.from(signatureBase64, "base64");
    tampered[0] ^= 0xff;
    expect(() =>
      assertSealSignatureVerifies({ sealSha256, signatureBase64: tampered.toString("base64"), publicKeyPem: signer.publicKeyPem }),
    ).toThrow("PACKAGE_SEAL_SIGNATURE_DOES_NOT_VERIFY");
    expect(() => assertSealSignatureVerifies({ sealSha256, signatureBase64, publicKeyPem: "not a key" })).toThrow(
      "PACKAGE_SEAL_SIGNATURE_DOES_NOT_VERIFY",
    );
  });

  it("the builder checks the seal before it writes it", () => {
    const src = readFileSync(new URL("../src/verification-package.ts", import.meta.url), "utf8");
    const check = src.indexOf("assertSealSignatureVerifies({\n        sealSha256,");
    const write = src.indexOf("appendSealEntries(archive, sealBytes, jsonBuffer(sealSignature));");
    expect(check).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(check);
  });
});
