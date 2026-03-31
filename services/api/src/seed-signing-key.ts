import { prisma } from "./db.js";
import { createPublicKey } from "node:crypto";
import { KMSClient, GetPublicKeyCommand } from "@aws-sdk/client-kms";

function must(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function mustInt(name: string): number {
  const raw = must(name);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer`);
  }

  return parsed;
}

function derToPemSpki(der: Uint8Array): string {
  const keyObject = createPublicKey({
    key: Buffer.from(der),
    format: "der",
    type: "spki",
  });

  return keyObject.export({
    format: "pem",
    type: "spki",
  }) as string;
}

async function main() {
  const region = must("AWS_REGION");
  const kmsKeyId = must("KMS_KEY_ID");
  const signingKeyId = must("SIGNING_KEY_ID");
  const signingKeyVersion = mustInt("SIGNING_KEY_VERSION");

  const kms = new KMSClient({ region });

  const response = await kms.send(
    new GetPublicKeyCommand({
      KeyId: kmsKeyId,
    })
  );

  if (!response.PublicKey || response.PublicKey.length === 0) {
    throw new Error("KMS GetPublicKey returned no public key");
  }

  if (response.KeySpec !== "ECC_NIST_EDWARDS25519") {
    throw new Error(
      `Unexpected KMS key spec: ${response.KeySpec ?? "unknown"}`
    );
  }

  if (response.KeyUsage !== "SIGN_VERIFY") {
    throw new Error(
      `Unexpected KMS key usage: ${response.KeyUsage ?? "unknown"}`
    );
  }

  const publicKeyPem = derToPemSpki(response.PublicKey);

  const saved = await prisma.signingKey.upsert({
    where: {
      keyId_version: {
        keyId: signingKeyId,
        version: signingKeyVersion,
      },
    },
    update: {
      publicKeyPem,
      revokedAt: null,
    },
    create: {
      keyId: signingKeyId,
      version: signingKeyVersion,
      publicKeyPem,
    },
  });

  console.log("KMS public key saved successfully");
  console.log({
    id: saved.id,
    keyId: saved.keyId,
    version: saved.version,
    kmsKeyId,
    region,
  });
}

main()
  .catch((error) => {
    console.error("Failed to seed signing key");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
  