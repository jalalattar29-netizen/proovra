import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
} from "@aws-sdk/client-kms";

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

function getAwsRegion(): string {
  return (
    process.env.AWS_REGION?.trim() ||
    process.env.AWS_DEFAULT_REGION?.trim() ||
    "eu-central-1"
  );
}

function bufferToPemSpki(der: Uint8Array): string {
  const base64 = Buffer.from(der).toString("base64");
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

export type KmsSignFingerprintResult = {
  signatureBase64: string;
  keyId: string;
  keyVersion: number;
};

export class KmsEvidenceSigner {
  private readonly kms: KMSClient;
  private publicKeyPemCache: string | null = null;

  constructor() {
    this.kms = new KMSClient({
      region: getAwsRegion(),
    });
  }

  private getKmsKeyId(): string {
    return must("KMS_KEY_ID");
  }

  private getBusinessKeyId(): string {
    return must("SIGNING_KEY_ID");
  }

  private getBusinessKeyVersion(): number {
    return mustInt("SIGNING_KEY_VERSION");
  }

  async getPublicKeyPem(): Promise<string> {
    if (this.publicKeyPemCache) {
      return this.publicKeyPemCache;
    }

    const res = await this.kms.send(
      new GetPublicKeyCommand({
        KeyId: this.getKmsKeyId(),
      })
    );

    if (!res.PublicKey) {
      throw new Error("KMS public key was not returned");
    }

    const pem = bufferToPemSpki(res.PublicKey);
    this.publicKeyPemCache = pem;
    return pem;
  }

  async signFingerprintHex(
    messageHex: string
  ): Promise<KmsSignFingerprintResult> {
    const normalizedHex = messageHex.trim().toLowerCase();

    if (!/^[a-f0-9]+$/.test(normalizedHex) || normalizedHex.length % 2 !== 0) {
      throw new Error("signFingerprintHex: messageHex must be valid hex");
    }

    const message = Buffer.from(normalizedHex, "hex");

    const res = await this.kms.send(
      new SignCommand({
        KeyId: this.getKmsKeyId(),
        Message: message,
        MessageType: "RAW",
        SigningAlgorithm: "ED25519_SHA_512",
      })
    );

    if (!res.Signature) {
      throw new Error("KMS signature was not returned");
    }

    return {
      signatureBase64: Buffer.from(res.Signature).toString("base64"),
      keyId: this.getBusinessKeyId(),
      keyVersion: this.getBusinessKeyVersion(),
    };
  }
}