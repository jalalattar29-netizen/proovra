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
 * WHAT IT CAN AND CANNOT SAY (CRYPTO-002, schema 2). A package is often assembled
 * long after its record was signed: a chain-verified update, a recovery. The
 * signers list is what was configured when THIS PACKAGE was assembled, read from
 * the deployment. The key that signed the record is `recordSignature`, from the
 * record's own identity, and agrees with public-key.pem. The report's PDF
 * signature is a separate fact, from the report row: it is not one of these keys.
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

import { publicFingerprintOfPem } from "@proovra/shared-runtime";

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
  /** The signer's state when this package was assembled. Read from the signer
   *  control state, so a retired or revoked signer is not described as active. */
  signerStatusAtPackageAssembly: "active" | "degraded" | "disabled" | "retired" | "revoked";
  verificationMaterial: {
    /** Operator-safe PEM block when extractable. NEVER private key. */
    publicKeyPem: string | null;
    /**
     * ET-PKG-11 — always null. It used to carry the server's key FILE PATH
     * or the KMS key id (an ARN embeds account and region) to every
     * recipient. Kept (nullable, schemaVersion 1) so readers do not break.
     */
    publicMaterialRef: null;
    /**
     * SHA-256 (hex) of the DER SPKI public key — the same fingerprint Public
     * Verify publishes for a package's seal key. No infrastructure identifier.
     */
    publicKeySpkiSha256: string | null;
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

export type RecordSignatureFacts = {
  keyId: string | null;
  keyVersion: string | null;
  publicKeyPem: string | null;
};

export type ReportPdfSignatureFacts = {
  /** SIGNED, UNSIGNED_OPT_OUT, ... as recorded on the report. */
  status: string | null;
  signerKeyId: string | null;
};

export type HistoricalVerificationMaterialFile = {
  schemaVersion: 2;
  schema: "PROOVRA_HISTORICAL_VERIFICATION_MATERIAL";
  generatedAtUtc: string;
  evidenceId: string;
  packageId: string | null;
  /** The key that signed the record, from the record itself. */
  recordSignature: (RecordSignatureFacts & { publicKeySpkiSha256: string | null }) | null;
  /** The report PDF's own signature, from the report row. */
  reportPdfSignature: ReportPdfSignatureFacts | null;
  /** Signers configured when this package was assembled. */
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

/** The control state of every signer; empty when it cannot be read (best-effort). */
async function loadSignerControlStatuses(): Promise<Map<string, string>> {
  try {
    const { prisma } = await import("./db.js");
    const rows = await prisma.signerControlState.findMany({ select: { signerId: true, status: true } });
    return new Map(rows.map((r) => [r.signerId, String(r.status)]));
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Public entry point — called by `verification-package.ts`
// ---------------------------------------------------------------------------

export async function buildHistoricalVerificationMaterial(input: {
  evidenceId: string;
  packageId?: string | null;
  recordSignature?: RecordSignatureFacts | null;
  reportPdfSignature?: ReportPdfSignatureFacts | null;
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

        // ET-PKG-11 — PER PURPOSE. The package signer prefers
        // PACKAGE_SIGNING_PUBLIC_KEY_PATH, so a distinct package key was
        // described with the evidence key's material. KMS: both signers use
        // KMS_KEY_ID, so one extraction serves both.
        const extracted = await extractPublicMaterial(provider, ["SIGNING_PUBLIC_KEY_PATH"]);
        const packageExtracted =
          provider === "local_pem"
            ? await extractPublicMaterial(provider, ["PACKAGE_SIGNING_PUBLIC_KEY_PATH", "SIGNING_PUBLIC_KEY_PATH"])
            : extracted;

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
        const controlled = await loadSignerControlStatuses();
        const statusAtAssembly = (
          signerId: string,
          material: Extracted,
        ): HistoricalSignerEntry["signerStatusAtPackageAssembly"] => {
          const control = controlled.get(signerId);
          if (control === "REVOKED") return "revoked";
          if (control === "RETIRED") return "retired";
          return provider === "disabled"
            ? "disabled"
            : material.materialType === "unsupported"
              ? "degraded"
              : "active";
        };

        // PHASE 12 POINT 3 — a const-bound function EXPRESSION, not a nested
        // function declaration. It closes over `provider` from this block, so
        // hoisting it to module scope would change what it reads; every call
        // site is below its definition, so losing declaration hoisting is
        // inert. Behaviour is identical.
        const entry = (
          purpose: SignerPurpose,
          keyId: string | null,
          keyVersion: string | null,
          material: Extracted = extracted,
        ): HistoricalSignerEntry => {
          const signerId = `${purpose}:${provider}:${keyId ?? "_"}:${keyVersion ?? "_"}`;
          return {
            signerPurpose: purpose,
            signerId,
            provider,
            keyId,
            keyVersion,
            algorithm,
            signerStatusAtPackageAssembly: statusAtAssembly(signerId, material),
            verificationMaterial: {
              publicKeyPem: material.publicKeyPem,
              publicMaterialRef: null,
              publicKeySpkiSha256: material.publicKeyPem ? publicFingerprintOfPem(material.publicKeyPem) : null,
            },
            verificationMaterialType: material.materialType,
            generatedFrom: material.generatedFrom,
            historicalOnly: true,
          };
        };

        // Deterministic order: matches the bounded `SIGNER_PURPOSES`
        // enum order.
        const signers: HistoricalSignerEntry[] = [
          entry("verification_package", pkgKeyId, pkgKeyVersion, packageExtracted),
          entry("export_manifest", evidKeyId, evidKeyVersion),
          entry("custody_event", evidKeyId, evidKeyVersion),
        ];

        const file: HistoricalVerificationMaterialFile = {
          schemaVersion: 2,
          schema: "PROOVRA_HISTORICAL_VERIFICATION_MATERIAL",
          generatedAtUtc,
          evidenceId: input.evidenceId,
          packageId: input.packageId ?? null,
          recordSignature: input.recordSignature
            ? {
                ...input.recordSignature,
                publicKeySpkiSha256: input.recordSignature.publicKeyPem
                  ? publicFingerprintOfPem(input.recordSignature.publicKeyPem)
                  : null,
              }
            : null,
          reportPdfSignature: input.reportPdfSignature ?? null,
          signers,
          trustInterpretation: {
            statement:
              "recordSignature names the key that signed this record. signers lists what was configured when this package was assembled, which can differ from the record's key after a rotation. Neither is a current-trust assertion: a signer may have been rotated, retired or revoked since, and currentTrustStatus is reported as unknown to surface this.",
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
        span.setAttribute("packageMaterialType", packageExtracted.materialType);
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
  materialType: VerificationMaterialType;
  generatedFrom: HistoricalSignerEntry["generatedFrom"];
};

async function extractPublicMaterial(
  provider: SignerProvider,
  /** local_pem only: the public-key path env names, first set wins. */
  publicKeyPathEnv: readonly string[],
): Promise<Extracted> {
  if (provider === "disabled") {
    return {
      publicKeyPem: null,
      materialType: "unsupported",
      generatedFrom: "unavailable",
    };
  }
  if (provider === "local_pem") {
    const pubPath = publicKeyPathEnv.map(envValue).find((v): v is string => v !== null) ?? null;
    if (!pubPath || !existsSync(pubPath)) {
      return {
        publicKeyPem: null,
        materialType: "unsupported",
        generatedFrom: "unavailable",
      };
    }
    try {
      const raw = readFileSync(pubPath, "utf8");
      if (!raw.includes("BEGIN") || !raw.includes("END")) {
        return {
          publicKeyPem: null,
          materialType: "unsupported",
          generatedFrom: "unavailable",
        };
      }
      return {
        publicKeyPem: raw.trim(),
        materialType: "ed25519_spki_pem",
        generatedFrom: "local_pem_file",
      };
    } catch {
      return {
        publicKeyPem: null,
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
        materialType: "unsupported",
        generatedFrom: "unavailable",
      };
    }
    const pem = derToPem(Buffer.from(res.PublicKey));
    return {
      publicKeyPem: pem,
      materialType: "kms_public_key_pem",
      generatedFrom: "aws_kms_get_public_key",
    };
  } catch {
    return {
      publicKeyPem: null,
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
    signerStatusAtPackageAssembly: "disabled",
    verificationMaterial: { publicKeyPem: null, publicMaterialRef: null, publicKeySpkiSha256: null },
    verificationMaterialType: "unsupported",
    generatedFrom: "unavailable",
    historicalOnly: true,
  });
  return {
    schemaVersion: 2,
    schema: "PROOVRA_HISTORICAL_VERIFICATION_MATERIAL",
    generatedAtUtc,
    evidenceId: input.evidenceId,
    packageId: input.packageId ?? null,
    recordSignature: null,
    reportPdfSignature: null,
    signers: SIGNER_PURPOSES.map(placeholder),
    trustInterpretation: {
      statement:
        "Signer material could not be read when this package was assembled — see verificationMaterialType=unsupported per signer. This is not a current-trust assertion.",
      historicalVerificationMaterialReflectsSigningTimeStateOnly: true,
    },
    revocationAwareness: {
      currentLiveRevocationStatusNotIncluded: true,
      note:
        "This file does not carry live revocation status. currentTrustStatus is reported as unknown.",
    },
  };
}
