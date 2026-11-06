/**
 * GOV-009 — A DESTRUCTION CERTIFICATE A CUSTOMER CAN VERIFY.
 *
 * The certificate carried only an HMAC under a deployment secret: no route
 * verified it and no customer could. It is now also signed with the platform's
 * existing signer (local PEM or AWS KMS, the same provider and key the evidence
 * signature uses) and the signature is self-verified against the key REGISTERED
 * under its own purpose, DESTRUCTION_CERTIFICATE, before the certificate is
 * written. The certificate carries the public key and its registry identity, so
 * anyone can check `Ed25519.verify(publicKey, hexDecode(certificateHash),
 * signature)` and compare the key's SHA-256 with PROOVRA's registry.
 *
 * Signing happens after verified deletion, so readiness is proven BEFORE the
 * first byte is removed (`assertDestructionCertificateSignerReady`), as the
 * HMAC secret already is.
 */
import { parseSignerProvider } from "@proovra/shared-runtime";

import { ed25519SignHexWithKeyPath, loadPemFromPathEnv } from "../crypto.js";
import { prisma } from "../db.js";
import { assertSignerUsable } from "../services/operations/signer-control-state.service.js";
import { currentSignerIdForPurpose } from "../services/operations/signer-registry.service.js";
import { assertSignatureVerifiesWithRegisteredKey, publicKeyPemFromPrivateKeyPem } from "./key-registry.js";
import { KmsEvidenceSigner } from "./kms-signer.js";

export const DESTRUCTION_CERTIFICATE_SIGNATURE_SCHEME = "PROOVRA_DESTRUCTION_CERT_ED25519_V1" as const;

export type DestructionCertificateSignature = {
  scheme: typeof DESTRUCTION_CERTIFICATE_SIGNATURE_SCHEME;
  algorithm: "Ed25519";
  /** What was signed: the bytes of `certificateHash` (hex-decoded). */
  signedField: "certificateHash";
  purpose: "DESTRUCTION_CERTIFICATE";
  keyId: string;
  keyVersion: number;
  publicKeySha256: string;
  publicKeyPem: string;
  signatureBase64: string;
};

function mustEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

let kms: KmsEvidenceSigner | null = null;

async function providerSign(messageHex: string): Promise<{ signatureBase64: string; keyId: string; keyVersion: number; publicKeyPem: string }> {
  if (parseSignerProvider(process.env.SIGNER_PROVIDER) === "aws-kms") {
    kms ??= new KmsEvidenceSigner();
    const res = await kms.signFingerprintHex(messageHex);
    return { signatureBase64: res.signatureBase64, keyId: res.keyId, keyVersion: res.keyVersion, publicKeyPem: await kms.getPublicKeyPem() };
  }
  const pem = process.env.SIGNING_PRIVATE_KEY_PEM?.trim()
    ? process.env.SIGNING_PRIVATE_KEY_PEM
    : loadPemFromPathEnv("SIGNING_PRIVATE_KEY_PATH");
  return {
    signatureBase64: ed25519SignHexWithKeyPath(messageHex, "SIGNING_PRIVATE_KEY_PATH"),
    keyId: mustEnv("SIGNING_KEY_ID"),
    keyVersion: Number.parseInt(mustEnv("SIGNING_KEY_VERSION"), 10),
    publicKeyPem: publicKeyPemFromPrivateKeyPem(pem!),
  };
}

/** Sign a certificate hash (64 hex chars) and self-verify against the registry. */
export async function signDestructionCertificateHash(certificateHashHex: string): Promise<DestructionCertificateSignature> {
  const messageHex = certificateHashHex.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(messageHex)) throw new Error("certificate hash must be 64 hex characters");
  // A revoked or retired signer signs nothing, certificates included.
  await assertSignerUsable(currentSignerIdForPurpose("custody_event"));
  const signed = await providerSign(messageHex);
  const verified = await assertSignatureVerifiesWithRegisteredKey(prisma, {
    keyId: signed.keyId,
    version: signed.keyVersion,
    purpose: "DESTRUCTION_CERTIFICATE",
    messageHex,
    signatureBase64: signed.signatureBase64,
    selfPublicKeyPem: signed.publicKeyPem,
  });
  return {
    scheme: DESTRUCTION_CERTIFICATE_SIGNATURE_SCHEME,
    algorithm: "Ed25519",
    signedField: "certificateHash",
    purpose: "DESTRUCTION_CERTIFICATE",
    keyId: signed.keyId,
    keyVersion: signed.keyVersion,
    publicKeySha256: verified.publicKeySha256,
    publicKeyPem: signed.publicKeyPem.trim(),
    signatureBase64: signed.signatureBase64,
  };
}

/** Proven before any deletion: the signer can sign and its key is registered and unrevoked. */
export async function assertDestructionCertificateSignerReady(): Promise<void> {
  await signDestructionCertificateHash("0".repeat(64));
}
