/**
 * Phase P3.1 — Signer health probe.
 *
 * Live, operator-safe health check against the configured signer
 * provider. For AWS KMS we issue `GetPublicKeyCommand` — the cheapest
 * KMS API that proves:
 *   * The KMS key id resolves to a real key.
 *   * The IAM role is allowed to read the public key.
 *   * The region binding is correct.
 *   * The configured signing algorithm matches the key.
 *
 * Hard rules:
 *   * Never log the KMS key ARN, IAM role, or any returned material
 *     in plain text. We bound `lastErrorCode` to an enum.
 *   * Never include private-key material in the response.
 *   * AWS unavailable → bounded `unreachable` status. App never crashes.
 *   * Local-pem provider is `healthy` only when the configured private key
 *     parses as Ed25519, its public half IS the configured public key, and
 *     that key is the REGISTERED, unrevoked (SIGNING_KEY_ID,
 *     SIGNING_KEY_VERSION) evidence key (F-31, independent forward audit:
 *     it used to be "healthy" when two files merely existed, and returned
 *     the filesystem path). The reference returned is the public key's SPKI
 *     fingerprint — never a path, never key material.
 *   * `disabled` provider returns `degraded` with reason
 *     `signing_disabled`.
 */

import { GetPublicKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type { PrismaClient } from "@prisma/client";
import { publicKeySpkiSha256 } from "../../signing/key-registry.js";

import { prisma as defaultPrisma } from "../../db.js";

import { bump } from "../ops/metrics.service.js";
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpan,
} from "../../observability/otel.js";

export const SIGNER_HEALTH_STATES = [
  "healthy",
  "degraded",
  "unreachable",
  "permission_denied",
  "key_disabled",
  "region_mismatch",
  "unsupported_algorithm",
  "unknown",
] as const;

export type SignerHealthState = (typeof SIGNER_HEALTH_STATES)[number];

export type SignerHealthSnapshot = {
  health: SignerHealthState;
  provider: "aws_kms" | "local_pem" | "disabled";
  checkedAtUtc: string;
  /** Operator-readable one-liner. Bounded vocabulary. */
  reason: string | null;
  /** Operator-safe — "kms://GetPublicKey" or "sha256:<SPKI fingerprint>". NEVER a path or key material. */
  publicMaterialRef: string | null;
  /** Last-known signing-algorithm string. */
  algorithm: string | null;
  /** Bounded recommended action. */
  recommendedAction: string | null;
};

let _kmsClient: KMSClient | null = null;
function kms(): KMSClient {
  if (_kmsClient) return _kmsClient;
  _kmsClient = new KMSClient({
    region:
      (process.env.AWS_REGION ?? "").trim() ||
      (process.env.AWS_DEFAULT_REGION ?? "").trim() ||
      "us-east-1",
  });
  return _kmsClient;
}

function classifyKmsError(err: unknown): SignerHealthState {
  const e = err as { name?: unknown; Code?: unknown; message?: unknown };
  const name = String(e?.name ?? e?.Code ?? "").toLowerCase();
  const msg = String(e?.message ?? "").toLowerCase();
  if (name.includes("accessdenied") || name.includes("unauthorized")) {
    return "permission_denied";
  }
  if (name.includes("disabled") || msg.includes("is disabled")) {
    return "key_disabled";
  }
  if (
    name.includes("notfound") ||
    name.includes("nosuchentity") ||
    msg.includes("does not exist")
  ) {
    return "unreachable";
  }
  if (
    msg.includes("region") &&
    (msg.includes("mismatch") || msg.includes("not match"))
  ) {
    return "region_mismatch";
  }
  if (msg.includes("algorithm") && msg.includes("not")) {
    return "unsupported_algorithm";
  }
  if (
    name.includes("timeout") ||
    name.includes("network") ||
    name.includes("econn")
  ) {
    return "unreachable";
  }
  return "unknown";
}

/**
 * Probe the configured provider. Bumps `signer_health_check_total`
 * always; bumps `signer_health_degraded_total` on non-healthy.
 */
export type SignerHealthDeps = {
  /** The signing-key registry (defaults to the API's client). */
  registry?: Pick<PrismaClient, "signingKey">;
};

export async function probeSignerHealth(deps: SignerHealthDeps = {}): Promise<SignerHealthSnapshot> {
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.SIGNER_HEALTH_CHECK,
    {
      provider: (process.env.SIGNER_PROVIDER ?? "local-pem")
        .trim()
        .toLowerCase(),
    },
    () => probeSignerHealthInner(deps.registry ?? defaultPrisma),
  );
}

async function probeSignerHealthInner(
  registry: Pick<PrismaClient, "signingKey">,
): Promise<SignerHealthSnapshot> {
  bump("signer_health_check_total");
  const checkedAtUtc = new Date().toISOString();
  const providerRaw = (process.env.SIGNER_PROVIDER ?? "local-pem")
    .trim()
    .toLowerCase();
  const provider: SignerHealthSnapshot["provider"] =
    providerRaw === "aws-kms" || providerRaw === "aws_kms"
      ? "aws_kms"
      : providerRaw === "disabled"
        ? "disabled"
        : "local_pem";

  if (provider === "disabled") {
    bump("signer_health_degraded_total");
    return {
      health: "degraded",
      provider,
      checkedAtUtc,
      reason: "signing_disabled",
      publicMaterialRef: null,
      algorithm: null,
      recommendedAction:
        "Set SIGNER_PROVIDER=aws-kms (production) or local-pem (dev) to enable signing.",
    };
  }

  if (provider === "local_pem") {
    const privPath = (process.env.SIGNING_PRIVATE_KEY_PATH ?? "").trim();
    const pubPath = (process.env.SIGNING_PUBLIC_KEY_PATH ?? "").trim();
    if (!privPath || !pubPath) {
      bump("signer_health_degraded_total");
      return {
        health: "degraded",
        provider,
        checkedAtUtc,
        reason: "missing_pem_path",
        publicMaterialRef: null,
        algorithm: "ED25519",
        recommendedAction:
          "Set SIGNING_PRIVATE_KEY_PATH and SIGNING_PUBLIC_KEY_PATH.",
      };
    }
    if (!existsSync(privPath) || !existsSync(pubPath)) {
      bump("signer_health_degraded_total");
      return {
        health: "degraded",
        provider,
        checkedAtUtc,
        reason: "pem_file_missing",
        publicMaterialRef: null,
        algorithm: "ED25519",
        recommendedAction:
          "Mount the PEM files at the configured paths or rotate via the local-pem rotation procedure.",
      };
    }
    return probeLocalPemKey({ privPath, pubPath, registry, checkedAtUtc });
  }

  // AWS KMS path — issue GetPublicKey against the configured key id.
  const kmsKeyId = (process.env.KMS_KEY_ID ?? "").trim();
  if (!kmsKeyId) {
    bump("signer_health_degraded_total");
    return {
      health: "degraded",
      provider,
      checkedAtUtc,
      reason: "kms_key_id_unset",
      publicMaterialRef: null,
      algorithm: null,
      recommendedAction: "Set KMS_KEY_ID to the active KMS key ARN or alias.",
    };
  }
  try {
    const res = await kms().send(
      new GetPublicKeyCommand({ KeyId: kmsKeyId }),
    );
    const algos = res.SigningAlgorithms ?? [];
    if (!algos.includes("ED25519_SHA_512" as never)) {
      bump("signer_health_degraded_total");
      return {
        health: "unsupported_algorithm",
        provider,
        checkedAtUtc,
        reason: "ed25519_not_supported",
        publicMaterialRef: "kms://GetPublicKey",
        algorithm: algos[0] ?? null,
        recommendedAction:
          "Provision a KMS key with SigningAlgorithm=ED25519_SHA_512.",
      };
    }
    return {
      health: "healthy",
      provider,
      checkedAtUtc,
      reason: null,
      publicMaterialRef: "kms://GetPublicKey",
      algorithm: "ED25519_SHA_512",
      recommendedAction: null,
    };
  } catch (err) {
    const cls = classifyKmsError(err);
    bump("signer_health_degraded_total");
    return {
      health: cls,
      provider,
      checkedAtUtc,
      reason: cls,
      publicMaterialRef: null,
      algorithm: "ED25519_SHA_512",
      recommendedAction:
        cls === "permission_denied"
          ? "Verify the IAM role attached to the api/worker has kms:GetPublicKey + kms:Sign on this key."
          : cls === "unreachable"
            ? "Confirm KMS reachability from the api/worker VPC (or check the configured AWS_REGION)."
            : cls === "key_disabled"
              ? "The KMS key is currently disabled. Re-enable in the KMS console."
              : "Inspect KMS console for the configured key id.",
    };
  }
}

const degradedLocalPem = (
  checkedAtUtc: string,
  health: SignerHealthState,
  reason: string,
  recommendedAction: string,
  publicMaterialRef: string | null = null,
): SignerHealthSnapshot => {
  bump("signer_health_degraded_total");
  return { health, provider: "local_pem", checkedAtUtc, reason, publicMaterialRef, algorithm: "ED25519", recommendedAction };
};

/**
 * F-31 — the local-PEM key is healthy only when it can actually produce a
 * signature Verify will accept: both files parse, the key is Ed25519, the
 * private key's public half IS the configured public key, and that key is
 * the registered, unrevoked evidence-signature key for (SIGNING_KEY_ID,
 * SIGNING_KEY_VERSION). Nothing read here leaves this function except the
 * public fingerprint.
 */
async function probeLocalPemKey(input: {
  privPath: string;
  pubPath: string;
  registry: Pick<PrismaClient, "signingKey">;
  checkedAtUtc: string;
}): Promise<SignerHealthSnapshot> {
  const { checkedAtUtc } = input;
  let derivedFingerprint: string;
  let configuredFingerprint: string;
  try {
    const privateKey = createPrivateKey(readFileSync(input.privPath));
    if (privateKey.asymmetricKeyType !== "ed25519") {
      return degradedLocalPem(checkedAtUtc, "unsupported_algorithm", "pem_not_ed25519", "Provision an Ed25519 signing key.");
    }
    const derivedPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    derivedFingerprint = publicKeySpkiSha256(derivedPem);
    configuredFingerprint = publicKeySpkiSha256(readFileSync(input.pubPath, "utf8"));
  } catch {
    return degradedLocalPem(checkedAtUtc, "degraded", "pem_unparseable", "The configured PEM files do not parse as an Ed25519 key pair.");
  }
  const ref = `sha256:${derivedFingerprint}`;
  if (derivedFingerprint !== configuredFingerprint) {
    return degradedLocalPem(
      checkedAtUtc,
      "degraded",
      "key_pair_mismatch",
      "SIGNING_PUBLIC_KEY_PATH is not the public half of SIGNING_PRIVATE_KEY_PATH.",
      ref,
    );
  }
  const keyId = (process.env.SIGNING_KEY_ID ?? "").trim();
  const keyVersion = Number.parseInt((process.env.SIGNING_KEY_VERSION ?? "").trim(), 10);
  if (!keyId || !Number.isInteger(keyVersion) || keyVersion < 1) {
    return degradedLocalPem(checkedAtUtc, "degraded", "key_identity_unset", "Set SIGNING_KEY_ID and SIGNING_KEY_VERSION.", ref);
  }
  let registered: { publicKeyPem: string; revokedAt: Date | null } | null;
  try {
    registered = await input.registry.signingKey.findUnique({
      where: { keyId_version_purpose: { keyId, version: keyVersion, purpose: "EVIDENCE_SIGNATURE" } },
      select: { publicKeyPem: true, revokedAt: true },
    });
  } catch {
    return degradedLocalPem(checkedAtUtc, "unknown", "registry_unreadable", "The signing-key registry could not be read.", ref);
  }
  if (!registered) {
    return degradedLocalPem(checkedAtUtc, "degraded", "key_not_registered", "Register the signing key (pnpm seed:signing-key) before signing.", ref);
  }
  let registeredFingerprint: string | null = null;
  try {
    registeredFingerprint = publicKeySpkiSha256(registered.publicKeyPem);
  } catch {
    registeredFingerprint = null;
  }
  if (registeredFingerprint !== derivedFingerprint) {
    return degradedLocalPem(
      checkedAtUtc,
      "degraded",
      "registry_key_mismatch",
      "The registered key for this SIGNING_KEY_ID / SIGNING_KEY_VERSION is a different key; rotate by registering a new version.",
      ref,
    );
  }
  if (registered.revokedAt) {
    return degradedLocalPem(checkedAtUtc, "key_disabled", "key_revoked", "The registered signing key is revoked; rotate to a new version.", ref);
  }
  return { health: "healthy", provider: "local_pem", checkedAtUtc, reason: null, publicMaterialRef: ref, algorithm: "ED25519", recommendedAction: null };
}
