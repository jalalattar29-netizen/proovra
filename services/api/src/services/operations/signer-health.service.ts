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
 *   * Local-pem provider returns `healthy` after a deterministic file
 *     existence check.
 *   * `disabled` provider returns `degraded` with reason
 *     `signing_disabled`.
 */

import { GetPublicKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { existsSync } from "node:fs";

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
  /** Operator-safe — KMS algorithm string or PEM path label. NEVER the key. */
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
export async function probeSignerHealth(): Promise<SignerHealthSnapshot> {
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.SIGNER_HEALTH_CHECK,
    {
      provider: (process.env.SIGNER_PROVIDER ?? "local-pem")
        .trim()
        .toLowerCase(),
    },
    () => probeSignerHealthInner(),
  );
}

async function probeSignerHealthInner(): Promise<SignerHealthSnapshot> {
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
        publicMaterialRef: pubPath,
        algorithm: "ED25519",
        recommendedAction:
          "Mount the PEM files at the configured paths or rotate via the local-pem rotation procedure.",
      };
    }
    return {
      health: "healthy",
      provider,
      checkedAtUtc,
      reason: null,
      publicMaterialRef: pubPath,
      algorithm: "ED25519",
      recommendedAction: null,
    };
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
