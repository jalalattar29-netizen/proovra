/**
 * Seed the `signing_keys` table with the public half of the evidence
 * signing key.
 *
 * Two providers are supported (mirrors `src/signing/signer.ts`):
 *
 *   1. `aws-kms` (production) — reads the public key from KMS
 *      `GetPublicKey` and persists it. Requires AWS_REGION, KMS_KEY_ID.
 *
 *   2. `local-pem` (development / new environments) — reads the
 *      public-key PEM from `SIGNING_PUBLIC_KEY_PATH` on disk and
 *      persists it. Required for `/v1/evidence/:id/review-workspace`,
 *      `/public/verify/:id` and the verification-package signature
 *      verification path to function. Without this row, every verify
 *      endpoint returns 404 "Signing key not found".
 *
 * Provider selection is driven by `SIGNER_PROVIDER`. Defaults to
 * `local-pem` (matches `services/api/.env.example`).
 *
 * Safety:
 *   * Only the PUBLIC key is persisted. The private key never leaves the
 *     signer abstraction.
 *   * Idempotent — re-runs upsert the same row, clearing any
 *     `revoked_at`.
 *   * Refuses to seed unless the file looks like a PEM public key and
 *     the algorithm is Ed25519.
 *
 * Usage:
 *   pnpm --filter proovra-api prisma:seed
 *   # or, when iterating locally on the signer config:
 *   pnpm --filter proovra-api seed:key
 */

import { readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";

import { KMSClient, GetPublicKeyCommand } from "@aws-sdk/client-kms";

import { prisma } from "./db.js";

type Provider = "aws-kms" | "local-pem";

function readProvider(): Provider {
  const raw = (process.env.SIGNER_PROVIDER ?? "local-pem").trim().toLowerCase();
  return raw === "aws-kms" ? "aws-kms" : "local-pem";
}

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

async function resolvePublicKeyPemFromKms(): Promise<string> {
  const region = must("AWS_REGION");
  const kmsKeyId = must("KMS_KEY_ID");
  const kms = new KMSClient({ region });

  const response = await kms.send(
    new GetPublicKeyCommand({
      KeyId: kmsKeyId,
    }),
  );

  if (!response.PublicKey || response.PublicKey.length === 0) {
    throw new Error("KMS GetPublicKey returned no public key");
  }

  if (response.KeySpec !== "ECC_NIST_EDWARDS25519") {
    throw new Error(
      `Unexpected KMS key spec: ${response.KeySpec ?? "unknown"}`,
    );
  }

  if (response.KeyUsage !== "SIGN_VERIFY") {
    throw new Error(
      `Unexpected KMS key usage: ${response.KeyUsage ?? "unknown"}`,
    );
  }

  return derToPemSpki(response.PublicKey);
}

function resolvePublicKeyPemFromLocalPem(): string {
  const path =
    process.env.SIGNING_PUBLIC_KEY_PATH?.trim() ?? "keys/signing-public.pem";

  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read local signing public key from "${path}". ` +
        `Set SIGNING_PUBLIC_KEY_PATH to a PEM file containing the ` +
        `Ed25519 public key. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }

  if (!pem.includes("BEGIN PUBLIC KEY")) {
    throw new Error(
      `File at "${path}" does not look like a PEM public key — ` +
        `expected a "-----BEGIN PUBLIC KEY-----" header. Refusing to seed.`,
    );
  }

  // Parse + re-export to canonical SPKI PEM. This both validates the
  // key (Ed25519 algorithm, correct length) and produces a stable
  // representation regardless of EOL style or whitespace quirks in the
  // source file.
  const keyObject = createPublicKey({
    key: pem,
    format: "pem",
    type: "spki",
  });

  if (keyObject.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `Public key at "${path}" is not an Ed25519 key ` +
        `(got asymmetricKeyType=${keyObject.asymmetricKeyType ?? "unknown"}). ` +
        `The runtime signer expects Ed25519.`,
    );
  }

  return keyObject.export({ format: "pem", type: "spki" }) as string;
}

async function upsertSigningKeyRow(
  keyId: string,
  version: number,
  publicKeyPem: string,
): Promise<{ id: string; keyId: string; version: number }> {
  const saved = await prisma.signingKey.upsert({
    where: { keyId_version: { keyId, version } },
    update: { publicKeyPem, revokedAt: null },
    create: { keyId, version, publicKeyPem },
  });
  return { id: saved.id, keyId: saved.keyId, version: saved.version };
}

async function main() {
  const provider = readProvider();
  const signingKeyId = must("SIGNING_KEY_ID");
  const signingKeyVersion = mustInt("SIGNING_KEY_VERSION");

  let publicKeyPem: string;
  let providerLabel: string;

  if (provider === "aws-kms") {
    publicKeyPem = await resolvePublicKeyPemFromKms();
    providerLabel = `aws-kms (region=${process.env.AWS_REGION ?? "?"}, keyId=${
      process.env.KMS_KEY_ID ?? "?"
    })`;
  } else {
    publicKeyPem = resolvePublicKeyPemFromLocalPem();
    providerLabel = `local-pem (${process.env.SIGNING_PUBLIC_KEY_PATH ?? "keys/signing-public.pem"})`;
  }

  const evidenceKey = await upsertSigningKeyRow(
    signingKeyId,
    signingKeyVersion,
    publicKeyPem,
  );
  // eslint-disable-next-line no-console
  console.log(`Evidence signing public key saved (${providerLabel})`, evidenceKey);

  // Also seed the package signing key row if env vars are set and the
  // pair differs from the evidence signing key. The verification
  // package worker uses an independent (keyId, version) pair, even
  // when the underlying key material is currently shared.
  const packageKeyId = process.env.PACKAGE_SIGNING_KEY_ID?.trim();
  const packageKeyVersionRaw = process.env.PACKAGE_SIGNING_KEY_VERSION?.trim();
  if (
    packageKeyId &&
    packageKeyVersionRaw &&
    !(packageKeyId === signingKeyId && packageKeyVersionRaw === String(signingKeyVersion))
  ) {
    const packageKeyVersion = Number.parseInt(packageKeyVersionRaw, 10);
    if (Number.isFinite(packageKeyVersion)) {
      // Package signing key currently shares the same key material as
      // evidence signing in the local-pem dev profile. If you split
      // the package key onto its own KMS key in production, resolve a
      // distinct PEM from PACKAGE_SIGNING_PUBLIC_KEY_PATH here.
      const packageKey = await upsertSigningKeyRow(
        packageKeyId,
        packageKeyVersion,
        publicKeyPem,
      );
      // eslint-disable-next-line no-console
      console.log("Package signing public key saved (mirrors evidence key)", packageKey);
    }
  }
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Failed to seed signing key");
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
