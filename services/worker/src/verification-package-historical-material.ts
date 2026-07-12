/**
 * Phase M1.1 — Historical verification material extraction.
 *
 * Produces `signers/historical-verification-material.json` for every
 * newly generated Verification Package. The file carries ONLY the
 * PUBLIC verification material the active signers expose at package
 * generation time, so a third party running independent tooling can
 * actually verify custody attestation + report signatures without
 * calling PROOVRA APIs.
 *
 * Hard rules:
 *   * NEVER includes private keys.
 *   * NEVER includes AWS credentials.
 *   * The file is HISTORICAL — it captures signing-time state. It
 *     does NOT carry "currently trusted" semantics; the verifier
 *     surfaces this explicitly via the bounded
 *     `currentTrustStatus="unknown"` result field.
 *   * Deterministic ordering: signers sorted by purpose in the
 *     bounded purpose enum order.
 *   * Bounded provider + algorithm + materialType enums.
 *   * Best-effort: if the public material cannot be extracted (KMS
 *     unreachable, PEM file missing) the per-signer entry records a
 *     bounded `unsupported` materialType. Package generation
 *     ALWAYS continues — extraction failures NEVER fail the build.
 */

import { existsSync, readFileSync } from "node:fs";

import { trace, SpanStatusCode } from "@opentelemetry/api";

import { captureException } from "./sentry.js";

// ---------------------------------------------------------------------------
// Bounded enums (mirror P3.1 registry)
// ---------------------------------------------------------------------------

export const SIGNER_PURPOSES = [
  "report_pdf",
  "verification_package",
  "export_manifest",
  "custody_event",
] as const;
export type SignerPurpose = (typeof SIGNER_PURPOSES)[number];

export type SignerProvider = "aws_kms" | "local_pem" | "disabled";

export const VERIFICATION_MATERIAL_TYPES = [
  "ed25519_spki_pem",
  "kms_public_key_pem",
  "unsupported",
] as const;
export type VerificationMaterialType =
  (typeof VERIFICATION_MATERIAL_TYPES)[number];

export type HistoricalSignerEntry = {
  signerPurpose: SignerPurpose;
  signerId: string;
  provider: SignerProvider;
  keyId: string | null;
  keyVersion: string | null;
  algorithm: string | null;
  /** Signer state at signing time. Subsequent rotation / revocation
   *  is NOT reflected here — that's the point. */
  signerStatusAtSigningTime: "active" | "degraded" | "disabled";
  verificationMaterial: {
    /** Operator-safe PEM block when extractable. NEVER private key. */
    publicKeyPem: string | null;
    /** Provider-side reference (e.g. KMS ARN). May be null. */
    publicMaterialRef: string | null;
  };
  verificationMaterialType: VerificationMaterialType;
  /** Where the public material was sourced from. Bounded enum. */
  generatedFrom:
    | "aws_kms_get_public_key"
    | "local_pem_file"
    | "unavailable";
  /** Always true — this file is historical evidence only. */
  historicalOnly: true;
};

export type HistoricalVerificationMaterialFile = {
  schemaVersion: 1;
  schema: "PROOVRA_HISTORICAL_VERIFICATION_MATERIAL";
  generatedAtUtc: string;
  evidenceId: string;
  packageId: string | null;
  signers: ReadonlyArray<HistoricalSignerEntry>;
  trustInterpretation: {
    /** Operator-readable, bounded. */
    statement: string;
    historicalVerificationMaterialReflectsSigningTimeStateOnly: true;
  };
  revocationAwareness: {
    currentLiveRevocationStatusNotIncluded: true;
    /** Operator-readable, bounded. */
    note: string;
  };
};

// ---------------------------------------------------------------------------
// Public entry point — called by `verification-package.ts`
// ---------------------------------------------------------------------------

export async function buildHistoricalVerificationMaterial(input: {
  evidenceId: string;
  packageId?: string | null;
}): Promise<HistoricalVerificationMaterialFile> {
  const tracer = trace.getTracer("proovra-worker");
  return tracer.startActiveSpan(
    "proovra.package.historical_material.generate",
    async (span) => {
      try {
        const generatedAtUtc = new Date().toISOString();
        const providerRaw = (process.env.SIGNER_PROVIDER ?? "local-pem")
          .trim()
          .toLowerCase();
        const provider: SignerProvider =
          providerRaw === "aws-kms" || providerRaw === "aws_kms"
            ? "aws_kms"
            : providerRaw === "disabled"
              ? "disabled"
              : "local_pem";

        // Extract public material ONCE; the same material applies to
        // all four signer purposes today (they share the same env-
        // resolved keyId / keyVersion).
        const extracted = await extractPublicMaterial(provider);

        const evidKeyId = envValue("SIGNING_KEY_ID");
        const evidKeyVersion = envValue("SIGNING_KEY_VERSION");
        const pkgKeyId =
          envValue("PACKAGE_SIGNING_KEY_ID") ?? evidKeyId;
        const pkgKeyVersion =
          envValue("PACKAGE_SIGNING_KEY_VERSION") ?? evidKeyVersion;
        const algorithm =
          provider === "aws_kms"
            ? "ED25519_SHA_512"
            : provider === "local_pem"
              ? "ED25519"
              : null;
        const statusAtSigning: HistoricalSignerEntry["signerStatusAtSigningTime"] =
          provider === "disabled"
            ? "disabled"
            : extracted.materialType === "unsupported"
              ? "degraded"
              : "active";

        function entry(
          purpose: SignerPurpose,
          keyId: string | null,
          keyVersion: string | null,
        ): HistoricalSignerEntry {
          return {
            signerPurpose: purpose,
            signerId: `${purpose}:${provider}:${keyId ?? "_"}:${
              keyVersion ?? "_"
            }`,
            provider,
            keyId,
            keyVersion,
            algorithm,
            signerStatusAtSigningTime: statusAtSigning,
            verificationMaterial: {
              publicKeyPem: extracted.publicKeyPem,
              publicMaterialRef: extracted.publicMaterialRef,
            },
            verificationMaterialType: extracted.materialType,
            generatedFrom: extracted.generatedFrom,
            historicalOnly: true,
          };
        }

        // Deterministic order: matches the bounded `SIGNER_PURPOSES`
        // enum order.
        const signers: HistoricalSignerEntry[] = [
          entry("report_pdf", evidKeyId, evidKeyVersion),
          entry("verification_package", pkgKeyId, pkgKeyVersion),
          entry("export_manifest", evidKeyId, evidKeyVersion),
          entry("custody_event", evidKeyId, evidKeyVersion),
        ];

        const file: HistoricalVerificationMaterialFile = {
          schemaVersion: 1,
          schema: "PROOVRA_HISTORICAL_VERIFICATION_MATERIAL",
          generatedAtUtc,
          evidenceId: input.evidenceId,
          packageId: input.packageId ?? null,
          signers,
          trustInterpretation: {
            statement:
              "Historical verification material reflects signing-time state only. It is NOT a current-trust assertion. The signer may have been rotated, retired, or revoked after this package was generated; currentTrustStatus is reported as unknown to surface this.",
            historicalVerificationMaterialReflectsSigningTimeStateOnly: true,
          },
          revocationAwareness: {
            currentLiveRevocationStatusNotIncluded: true,
            note:
              "This file does not carry live revocation status. To inspect current signer state consult the PROOVRA signer governance surface (/operations/signers) when bound to the live deployment.",
          },
        };
        span.setAttribute("status", "ok");
        span.setAttribute("provider", provider);
        span.setAttribute("materialType", extracted.materialType);
        return file;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        captureException(err, {
          stage: "buildHistoricalVerificationMaterial",
          packageKind: "verification_package",
        });
        // Honour the "best-effort" contract — return a degraded but
        // structurally complete file so package generation never
        // fails because of this module.
        return degradedFile(input);
      } finally {
        span.end();
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Public-material extraction
// ---------------------------------------------------------------------------

type Extracted = {
  publicKeyPem: string | null;
  publicMaterialRef: string | null;
  materialType: VerificationMaterialType;
  generatedFrom: HistoricalSignerEntry["generatedFrom"];
};

async function extractPublicMaterial(
  provider: SignerProvider,
): Promise<Extracted> {
  if (provider === "disabled") {
    return {
      publicKeyPem: null,
      publicMaterialRef: null,
      materialType: "unsupported",
      generatedFrom: "unavailable",
    };
  }
  if (provider === "local_pem") {
    const pubPath = envValue("SIGNING_PUBLIC_KEY_PATH");
    if (!pubPath || !existsSync(pubPath)) {
      return {
        publicKeyPem: null,
        publicMaterialRef: pubPath,
        materialType: "unsupported",
        generatedFrom: "unavailable",
      };
    }
    try {
      const raw = readFileSync(pubPath, "utf8");
      if (!raw.includes("BEGIN") || !raw.includes("END")) {
        return {
          publicKeyPem: null,
          publicMaterialRef: pubPath,
          materialType: "unsupported",
          generatedFrom: "unavailable",
        };
      }
      return {
        publicKeyPem: raw.trim(),
        publicMaterialRef: pubPath,
        materialType: "ed25519_spki_pem",
        generatedFrom: "local_pem_file",
      };
    } catch {
      return {
        publicKeyPem: null,
        publicMaterialRef: pubPath,
        materialType: "unsupported",
        generatedFrom: "unavailable",
      };
    }
  }
  // aws_kms
  const keyId = envValue("KMS_KEY_ID");
  if (!keyId) {
    return {
      publicKeyPem: null,
      publicMaterialRef: null,
      materialType: "unsupported",
      generatedFrom: "unavailable",
    };
  }
  try {
    const { GetPublicKeyCommand, KMSClient } = await import(
      "@aws-sdk/client-kms"
    );
    const region =
      (process.env.AWS_REGION ?? "").trim() ||
      (process.env.AWS_DEFAULT_REGION ?? "").trim() ||
      "us-east-1";
    const kms = new KMSClient({ region });
    const res = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
    if (!res.PublicKey) {
      return {
        publicKeyPem: null,
        publicMaterialRef: `kms:${keyId}`,
        materialType: "unsupported",
        generatedFrom: "unavailable",
      };
    }
    const pem = derToPem(Buffer.from(res.PublicKey));
    return {
      publicKeyPem: pem,
      publicMaterialRef: `kms:${keyId}`,
      materialType: "kms_public_key_pem",
      generatedFrom: "aws_kms_get_public_key",
    };
  } catch {
    return {
      publicKeyPem: null,
      publicMaterialRef: `kms:${keyId}`,
      materialType: "unsupported",
      generatedFrom: "unavailable",
    };
  }
}

function derToPem(der: Buffer): string {
  const b64 = der.toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

function envValue(name: string): string | null {
  const v = (process.env[name] ?? "").trim();
  return v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// Degraded fallback (best-effort contract)
// ---------------------------------------------------------------------------

function degradedFile(input: {
  evidenceId: string;
  packageId?: string | null;
}): HistoricalVerificationMaterialFile {
  const generatedAtUtc = new Date().toISOString();
  const placeholder = (
    purpose: SignerPurpose,
  ): HistoricalSignerEntry => ({
    signerPurpose: purpose,
    signerId: `${purpose}:disabled:_:_`,
    provider: "disabled",
    keyId: null,
    keyVersion: null,
    algorithm: null,
    signerStatusAtSigningTime: "disabled",
    verificationMaterial: { publicKeyPem: null, publicMaterialRef: null },
    verificationMaterialType: "unsupported",
    generatedFrom: "unavailable",
    historicalOnly: true,
  });
  return {
    schemaVersion: 1,
    schema: "PROOVRA_HISTORICAL_VERIFICATION_MATERIAL",
    generatedAtUtc,
    evidenceId: input.evidenceId,
    packageId: input.packageId ?? null,
    signers: SIGNER_PURPOSES.map(placeholder),
    trustInterpretation: {
      statement:
        "Historical verification material reflects signing-time state only. Extraction failed at generation time — see verificationMaterialType=unsupported per signer.",
      historicalVerificationMaterialReflectsSigningTimeStateOnly: true,
    },
    revocationAwareness: {
      currentLiveRevocationStatusNotIncluded: true,
      note:
        "This file does not carry live revocation status. currentTrustStatus is reported as unknown.",
    },
  };
}
