import { assertNotCommittedFixture } from "@proovra/shared-runtime";

import { ed25519SignHexWithKeyPath, loadPemFromPathEnv } from "../crypto.js";
import { prisma } from "../db.js";
import { assertSignatureVerifiesWithRegisteredKey, publicKeyPemFromPrivateKeyPem } from "./key-registry.js";
import { assertSignerUsable } from "../services/operations/signer-control-state.service.js";
import {
  currentSignerIdForPurpose,
  type SignerPurpose,
} from "../services/operations/signer-registry.service.js";
import { KmsEvidenceSigner } from "./kms-signer.js";

function must(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`${name} is not set`);
  }
  return v.trim();
}

function mustInt(name: string): number {
  const raw = must(name);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer`);
  }

  return parsed;
}

function getSignerProvider(): "local-pem" | "aws-kms" {
  const raw = (process.env.SIGNER_PROVIDER ?? "local-pem").trim().toLowerCase();

  if (raw === "aws-kms") {
    return "aws-kms";
  }

  return "local-pem";
}

export type SignFingerprintResult = {
  signatureBase64: string;
  keyId: string;
  keyVersion: number;
  /**
   * UC-TRUST-003 — SHA-256 of the DER SubjectPublicKeyInfo of the REGISTERED
   * key the signature was self-verified with. Present on every signature the
   * controlled signer returns.
   */
  publicKeySha256?: string;
};

export interface EvidenceSigner {
  signFingerprintHex(messageHex: string): Promise<SignFingerprintResult>;
  /** The signer's own public key, when it can derive it (local PEM). */
  ownPublicKeyPem?(): string | null;
}

class LocalPemEvidenceSigner implements EvidenceSigner {
  ownPublicKeyPem(): string | null {
    try {
      const pem = process.env.SIGNING_PRIVATE_KEY_PEM?.trim()
        ? process.env.SIGNING_PRIVATE_KEY_PEM
        : loadPemFromPathEnv("SIGNING_PRIVATE_KEY_PATH");
      return publicKeyPemFromPrivateKeyPem(pem!);
    } catch {
      return null;
    }
  }

  async signFingerprintHex(messageHex: string): Promise<SignFingerprintResult> {
    const normalizedHex = messageHex.trim().toLowerCase();

    if (!/^[a-f0-9]+$/.test(normalizedHex) || normalizedHex.length % 2 !== 0) {
      throw new Error("signFingerprintHex: messageHex must be valid hex");
    }

    // Checked at the point of SIGNING, not only at boot: a signature made with
    // the repository's committed fixture would be indistinguishable from a real
    // one to a downstream verifier, so the refusal has to sit on the path that
    // actually produces it.
    assertNotCommittedFixture({
      privateKeyPath: process.env.SIGNING_PRIVATE_KEY_PATH,
      privateKeyPem: process.env.SIGNING_PRIVATE_KEY_PEM,
    });

    const signatureBase64 = ed25519SignHexWithKeyPath(
      normalizedHex,
      "SIGNING_PRIVATE_KEY_PATH"
    );

    return {
      signatureBase64,
      keyId: must("SIGNING_KEY_ID"),
      keyVersion: mustInt("SIGNING_KEY_VERSION"),
    };
  }
}

class AwsKmsEvidenceSigner implements EvidenceSigner {
  private readonly kmsSigner = new KmsEvidenceSigner();

  async signFingerprintHex(messageHex: string): Promise<SignFingerprintResult> {
    const normalizedHex = messageHex.trim().toLowerCase();

    if (!/^[a-f0-9]+$/.test(normalizedHex) || normalizedHex.length % 2 !== 0) {
      throw new Error("signFingerprintHex: messageHex must be valid hex");
    }

    return this.kmsSigner.signFingerprintHex(normalizedHex);
  }
}

/**
 * THE SIGNING BOUNDARY.
 *
 * Wraps whichever provider is configured and refuses to sign with a signer the
 * persisted control state says is RETIRED or REVOKED.
 *
 * It is a wrapper rather than a check at the call sites because the call sites
 * are the thing that keeps growing: evidence completion today, a replay or a
 * backfill tomorrow. A guard that lives beside the private key cannot be
 * forgotten by a new caller, and that is the whole point — the previous
 * implementation's failure was precisely that "revoked" lived somewhere the
 * signing path never consulted.
 *
 * The status is read from the DATABASE on every signature, deliberately. A job
 * queued before a revocation and executed after it must observe the revocation;
 * an in-memory cache is exactly how that guarantee would be lost.
 */
class ControlledEvidenceSigner implements EvidenceSigner {
  constructor(
    private readonly inner: EvidenceSigner,
    private readonly purpose: SignerPurpose,
  ) {}

  async signFingerprintHex(messageHex: string): Promise<SignFingerprintResult> {
    await assertSignerUsable(currentSignerIdForPurpose(this.purpose));
    const result = await this.inner.signFingerprintHex(messageHex);
    // UC-TRUST-003 — SELF-VERIFY against the REGISTERED key before anything
    // commits. A private key that does not match its registered public key
    // (rotation without a version bump, a wrong mounted PEM) or a revoked key
    // fails here, at capture time, instead of producing a record every
    // verifier reports invalid.
    const verified = await assertSignatureVerifiesWithRegisteredKey(prisma, {
      keyId: result.keyId,
      version: result.keyVersion,
      // The evidence signer verifies only against an EVIDENCE_SIGNATURE key.
      purpose: "EVIDENCE_SIGNATURE",
      messageHex: messageHex.trim().toLowerCase(),
      signatureBase64: result.signatureBase64,
      selfPublicKeyPem: this.inner.ownPublicKeyPem?.() ?? null,
    });
    return { ...result, publicKeySha256: verified.publicKeySha256 };
  }
}

let cachedSigner: EvidenceSigner | null = null;

export function getEvidenceSigner(): EvidenceSigner {
  if (!cachedSigner) {
    const provider = getSignerProvider();

    const inner =
      provider === "aws-kms"
        ? new AwsKmsEvidenceSigner()
        : new LocalPemEvidenceSigner();

    // Evidence fingerprints are sealed with the custody-event signing identity
    // — the same env pair the read model derives `custody_event` from.
    cachedSigner = new ControlledEvidenceSigner(inner, "custody_event");
  }

  return cachedSigner;
}