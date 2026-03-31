import { ed25519SignHexWithKeyPath } from "../crypto.js";
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
};

export interface EvidenceSigner {
  signFingerprintHex(messageHex: string): Promise<SignFingerprintResult>;
}

class LocalPemEvidenceSigner implements EvidenceSigner {
  async signFingerprintHex(messageHex: string): Promise<SignFingerprintResult> {
    const normalizedHex = messageHex.trim().toLowerCase();

    if (!/^[a-f0-9]+$/.test(normalizedHex) || normalizedHex.length % 2 !== 0) {
      throw new Error("signFingerprintHex: messageHex must be valid hex");
    }

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

let cachedSigner: EvidenceSigner | null = null;

export function getEvidenceSigner(): EvidenceSigner {
  if (!cachedSigner) {
    const provider = getSignerProvider();

    cachedSigner =
      provider === "aws-kms"
        ? new AwsKmsEvidenceSigner()
        : new LocalPemEvidenceSigner();
  }

  return cachedSigner;
}