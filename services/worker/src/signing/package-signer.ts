import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  assertNotCommittedFixture,
  publicFingerprintOfPem,
} from "@proovra/shared-runtime";

export type PackageSignerProvider = "local-pem" | "aws-kms";

export type PackageSignature = {
  signatureBase64: string;
  signingKeyId: string;
  signingKeyVersion: string;
  publicKeyPem: string;
  provider: PackageSignerProvider;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Package signer configuration requires ${name}`);
  return value;
}

export function packageSignerProvider(): PackageSignerProvider {
  const raw = (process.env.SIGNER_PROVIDER ?? "local-pem")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (raw === "aws-kms") return "aws-kms";
  if (raw === "local-pem") return "local-pem";
  throw new Error("SIGNER_PROVIDER must be aws-kms or local-pem for package signing");
}

function keyIdentity(): { id: string; version: string } {
  const id =
    process.env.PACKAGE_SIGNING_KEY_ID?.trim() || required("SIGNING_KEY_ID");
  const version =
    process.env.PACKAGE_SIGNING_KEY_VERSION?.trim() ||
    required("SIGNING_KEY_VERSION");
  if (!/^\d+$/.test(version)) {
    throw new Error("PACKAGE_SIGNING_KEY_VERSION/SIGNING_KEY_VERSION must be an integer");
  }
  return { id, version };
}

function resolveKeyPath(primary: string, fallback: string): string {
  const configured = process.env[primary]?.trim() || process.env[fallback]?.trim();
  if (!configured) throw new Error(`Package signer configuration requires ${primary} or ${fallback}`);
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(process.cwd(), configured);
}

function localMaterial(): { privatePem: string; publicPem: string } {
  const privatePath = resolveKeyPath(
    "PACKAGE_SIGNING_PRIVATE_KEY_PATH",
    "SIGNING_PRIVATE_KEY_PATH",
  );
  const publicPath = resolveKeyPath(
    "PACKAGE_SIGNING_PUBLIC_KEY_PATH",
    "SIGNING_PUBLIC_KEY_PATH",
  );
  assertNotCommittedFixture({ privateKeyPath: privatePath });
  const privatePem = readFileSync(privatePath, "utf8");
  const publicPem = readFileSync(publicPath, "utf8");
  const privateFingerprint = publicFingerprintOfPem(privatePem);
  const publicFingerprint = publicFingerprintOfPem(publicPem);
  if (!privateFingerprint || !publicFingerprint || privateFingerprint !== publicFingerprint) {
    throw new Error("Package signing private and public keys do not match");
  }
  return { privatePem, publicPem };
}

function kmsClient(): KMSClient {
  return new KMSClient({
    region:
      process.env.AWS_REGION?.trim() ||
      process.env.AWS_DEFAULT_REGION?.trim() ||
      "eu-central-1",
  });
}

function spkiPem(der: Uint8Array): string {
  const base64 = Buffer.from(der).toString("base64");
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

async function kmsPublicKey(client: KMSClient): Promise<string> {
  const result = await client.send(
    new GetPublicKeyCommand({ KeyId: required("KMS_KEY_ID") }),
  );
  if (!result.PublicKey) throw new Error("KMS did not return package signer public material");
  return spkiPem(result.PublicKey);
}

async function kmsSign(client: KMSClient, bytes: Buffer): Promise<Buffer> {
  const result = await client.send(
    new SignCommand({
      KeyId: required("KMS_KEY_ID"),
      Message: bytes,
      MessageType: "RAW",
      SigningAlgorithm: "ED25519_SHA_512",
    }),
  );
  if (!result.Signature) throw new Error("KMS did not return a package signature");
  return Buffer.from(result.Signature);
}

/**
 * Fail closed before the report queue starts. This validates the effective
 * post-secrets configuration and proves the selected public identity matches
 * the signer without logging key material or provider key references.
 */
export async function validatePackageSignerAtStartup(): Promise<{
  provider: PackageSignerProvider;
  signingKeyId: string;
  signingKeyVersion: string;
}> {
  const provider = packageSignerProvider();
  const identity = keyIdentity();
  const challenge = Buffer.alloc(32, 0xa5);
  if (provider === "local-pem") {
    const material = localMaterial();
    const signature = cryptoSign(null, challenge, createPrivateKey(material.privatePem));
    if (!cryptoVerify(null, challenge, createPublicKey(material.publicPem), signature)) {
      throw new Error("Package signer startup verification failed");
    }
  } else {
    const client = kmsClient();
    const [publicPem, signature] = await Promise.all([
      kmsPublicKey(client),
      kmsSign(client, challenge),
    ]);
    if (!cryptoVerify(null, challenge, createPublicKey(publicPem), signature)) {
      throw new Error("KMS package signer public identity does not verify its signature");
    }
  }
  return {
    provider,
    signingKeyId: identity.id,
    signingKeyVersion: identity.version,
  };
}

export async function signPackageManifestDigest(
  digestHex: string,
): Promise<PackageSignature> {
  if (!/^[a-f0-9]{64}$/i.test(digestHex)) {
    throw new Error("Package manifest digest must be a SHA-256 hex digest");
  }
  const provider = packageSignerProvider();
  const identity = keyIdentity();
  const bytes = Buffer.from(digestHex, "hex");
  if (provider === "local-pem") {
    const material = localMaterial();
    return {
      signatureBase64: cryptoSign(
        null,
        bytes,
        createPrivateKey(material.privatePem),
      ).toString("base64"),
      signingKeyId: identity.id,
      signingKeyVersion: identity.version,
      publicKeyPem: material.publicPem,
      provider,
    };
  }
  const client = kmsClient();
  const [signature, publicKeyPem] = await Promise.all([
    kmsSign(client, bytes),
    kmsPublicKey(client),
  ]);
  return {
    signatureBase64: signature.toString("base64"),
    signingKeyId: identity.id,
    signingKeyVersion: identity.version,
    publicKeyPem,
    provider,
  };
}
