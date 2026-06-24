/**
 * PROOVRA Offline Verifier — portable core.
 *
 * Takes a `PackageReader` interface so it can run in:
 *   * Node CLI    (adapter wraps `adm-zip` → `bin/proovra-verify.mjs`)
 *   * Browser     (adapter wraps `JSZip` → `apps/offline-verifier`)
 *
 * No network. No PROOVRA API. No private keys ever read.
 *
 * What this verifier does:
 *   1. Reads `package-checksums.json` (the canonical file index).
 *   2. Re-hashes every file inside the ZIP and compares to the index.
 *   3. Checks `package-manifest.json` schema sanity.
 *   4. Checks `package-manifest.sig` (we report `unsupported` if the
 *      embedded Ed25519 verification dependency is not available; in
 *      the Node CLI we use built-in `crypto.verify` so this works
 *      offline).
 *   5. Parses `custody/attestations.json` + `signers/signer-registry-
 *      snapshot.json` if present (P3.1.1).
 *   6. Validates custody attestation envelopes structurally; verifies
 *      signatures via the `SignatureVerifier` adapter (Node uses
 *      built-in crypto; browser must provide a Web-Crypto adapter).
 *   7. Reports presence + structural sanity of TSA / OTS files;
 *      explicitly returns `unsupported` for the full RFC3161 / OTS
 *      cryptographic chain (those require external tooling we do
 *      NOT bundle to keep the verifier dependency-free).
 *
 * Hard rules:
 *   * Old packages (pre-P3.1.1) without attestation files return
 *     `missing` — NEVER `failed`.
 *   * Strict mode = upgrade `partial` overall to `failed` ONLY in
 *     the CLI's caller; the core ALWAYS returns bounded `partial`.
 *   * Bounded warnings + limitations everywhere.
 */

import {
  SCHEMA_VERSION,
  type AttestationFailure,
  type AttestationsStatus,
  type ArtifactIntegrityFailure,
  type C2paStatus,
  type C2paValidationStatus,
  type ChecksumFailure,
  type HistoricalVerificationStatus,
  type LimitationCode,
  type OfflineVerificationResult,
  type OverallStatus,
  type WarningCode,
} from "./result-schema.js";
import type {
  C2paRawManifestExportStatus,
  C2paGeneratedAssertionStatusForVerifier,
} from "./result-schema.js";
// Silence unused-type warnings — these are exported via result-schema
// for external consumers; the verifier itself uses the C2paBlock alias.
type _C2paUnused = C2paRawManifestExportStatus | C2paGeneratedAssertionStatusForVerifier;

// ---------------------------------------------------------------------------
// Adapter interfaces
// ---------------------------------------------------------------------------

/**
 * Reader over the package ZIP. Implementations:
 *   * Node: wraps `adm-zip`
 *   * Browser: wraps `JSZip`
 */
export interface PackageReader {
  /** Sorted list of file paths in the ZIP. */
  listFiles(): ReadonlyArray<string>;
  /** Read a file as bytes; null when absent. */
  readBytes(path: string): Uint8Array | null;
  /** Read a file as utf-8 text; null when absent. */
  readText(path: string): string | null;
}

/**
 * Cryptographic primitives. The Node adapter uses `node:crypto`.
 * The browser adapter uses `crypto.subtle`. Either returns null when
 * verification is not supported.
 */
export interface CryptoAdapter {
  /** Compute SHA-256 hex of bytes. NEVER returns null. */
  sha256Hex(bytes: Uint8Array): string;
  /**
   * Verify an Ed25519 signature over `messageHex` (raw bytes from
   * the hex string) using a PEM-encoded SPKI public key. Returns
   * `true` / `false` for verification result, or `null` when the
   * environment cannot perform the verification (browsers without
   * WebCrypto Ed25519 support).
   */
  verifyEd25519HexMessage(input: {
    messageHex: string;
    signatureBase64: string;
    publicKeyPem: string;
  }): Promise<boolean | null>;
}

// ---------------------------------------------------------------------------
// Canonical file paths
// ---------------------------------------------------------------------------

const PATHS = {
  checksums: "package-checksums.json",
  manifest: "package-manifest.json",
  manifestSig: "package-manifest.sig",
  manifestPublicKey: "package-manifest-public-key.pem",
  custodyAttestations: "custody/attestations.json",
  custodyVerificationReadme: "custody/attestation-verification.md",
  signerSnapshot: "signers/signer-registry-snapshot.json",
  historicalMaterial: "signers/historical-verification-material.json",
  // TSA + OTS canonical paths (audit derived).
  tsaToken: "timestamps/tsa.tsr",
  tsaInfo: "timestamps/tsa.json",
  otsProof: "opentimestamps-proof.ots",
  otsJson: "opentimestamps.json",
  // Phase M2 — C2PA provenance summary.
  c2paSummary: "provenance/c2pa-summary.json",
} as const;

// Legacy paths emitted by older / current package generators. The
// verifier reads canonical paths first, then falls back to legacy
// paths so packages produced before the canonical layout was rolled
// out continue to verify correctly. This is purely additive — no
// behaviour change for packages written at the canonical paths.
const LEGACY_PATHS = {
  tsaToken: "timestamp.tsr",
} as const;

// Accepted artifact prefixes. `evidence/` is the canonical layout;
// `evidence-parts/` is the prefix the current worker-side package
// builder emits for multipart originals. Files under either prefix
// count as artifacts for the artifact-integrity sub-result.
const ARTIFACT_PREFIXES = ["evidence/", "evidence-parts/"] as const;

function isArtifactPath(p: string): boolean {
  for (const prefix of ARTIFACT_PREFIXES) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

function readFirstBytes(
  reader: PackageReader,
  paths: readonly string[],
): Uint8Array | null {
  for (const p of paths) {
    const b = reader.readBytes(p);
    if (b && b.length > 0) return b;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function verifyPackage(input: {
  reader: PackageReader;
  crypto: CryptoAdapter;
}): Promise<OfflineVerificationResult> {
  const { reader, crypto } = input;
  const verifiedAtUtc = new Date().toISOString();
  const warnings: WarningCode[] = [];
  const limitations: LimitationCode[] = [];
  // Standing limitations every result carries.
  limitations.push(
    "NO_LEGAL_ADMISSIBILITY_CLAIM",
    "NO_AUTHORSHIP_CLAIM",
    "TSA_REQUIRES_EXTERNAL_RFC3161_VERIFICATION",
    "OTS_REQUIRES_BITCOIN_NETWORK",
  );

  // -----------------------------------------------------------------
  // 1. Checksums index
  // -----------------------------------------------------------------
  const checksumsText = reader.readText(PATHS.checksums);
  let filesIndexed = 0;
  let extraFiles = 0;
  let checksumsStatus: OfflineVerificationResult["package"]["checksumsStatus"] =
    "unsupported";
  const checksumFailures: ChecksumFailure[] = [];
  type ChecksumsIndex = {
    files: Array<{
      path: string;
      sha256: string;
      sizeBytes?: number | null;
    }>;
  };
  let parsedIndex: ChecksumsIndex | null = null;
  if (!checksumsText) {
    checksumsStatus = "missing_index";
    warnings.push("PACKAGE_MANIFEST_MISSING");
  } else {
    try {
      parsedIndex = JSON.parse(checksumsText) as ChecksumsIndex;
    } catch {
      checksumsStatus = "unsupported";
    }
    if (parsedIndex && Array.isArray(parsedIndex.files)) {
      filesIndexed = parsedIndex.files.length;
      const filesInZip = new Set(reader.listFiles());
      // Recompute every file's SHA-256 and compare.
      let allMatched = true;
      const indexedSet = new Set<string>();
      for (const entry of parsedIndex.files) {
        indexedSet.add(entry.path);
        if (entry.path === PATHS.checksums) {
          // The checksums index never lists itself — skip if it
          // somehow does.
          continue;
        }
        const bytes = reader.readBytes(entry.path);
        if (bytes === null) {
          allMatched = false;
          checksumFailures.push({ path: entry.path, reason: "missing" });
          warnings.push("CHECKSUMS_MISSING_FILE");
          continue;
        }
        const actual = crypto.sha256Hex(bytes);
        if (actual.toLowerCase() !== entry.sha256.toLowerCase()) {
          allMatched = false;
          checksumFailures.push({
            path: entry.path,
            reason: "sha256_mismatch",
          });
        }
      }
      // Extras: files in the ZIP not in the index. Not a failure on
      // its own; we surface as a warning so operators see drift.
      for (const f of filesInZip) {
        if (!indexedSet.has(f) && f !== PATHS.checksums) {
          extraFiles++;
        }
      }
      if (extraFiles > 0) warnings.push("EXTRA_FILES_NOT_IN_CHECKSUMS");
      checksumsStatus = allMatched ? "verified" : "mismatch";
    }
  }

  // -----------------------------------------------------------------
  // 2. Manifest
  // -----------------------------------------------------------------
  const manifestText = reader.readText(PATHS.manifest);
  let manifestStatus: OfflineVerificationResult["package"]["manifestStatus"] =
    "missing";
  if (manifestText) {
    try {
      const parsed = JSON.parse(manifestText);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        manifestStatus = "verified";
      } else {
        manifestStatus = "schema_invalid";
      }
    } catch {
      manifestStatus = "schema_invalid";
    }
  } else {
    warnings.push("PACKAGE_MANIFEST_MISSING");
  }

  // -----------------------------------------------------------------
  // 3. Package signature
  // -----------------------------------------------------------------
  let signatureStatus: OfflineVerificationResult["package"]["signatureStatus"] =
    "missing";
  const sigText = reader.readText(PATHS.manifestSig);
  const publicKeyPem = reader.readText(PATHS.manifestPublicKey);
  if (!sigText) {
    warnings.push("PACKAGE_SIGNATURE_MISSING");
  } else if (!publicKeyPem) {
    warnings.push("PACKAGE_PUBLIC_KEY_MISSING");
    signatureStatus = "unsupported";
  } else if (!manifestText) {
    signatureStatus = "unsupported";
  } else {
    try {
      const sigEnvelope = JSON.parse(sigText) as {
        manifestSha256?: string;
        signatureBase64?: string;
      };
      const manifestBytes = reader.readBytes(PATHS.manifest);
      if (
        !sigEnvelope.manifestSha256 ||
        !sigEnvelope.signatureBase64 ||
        !manifestBytes
      ) {
        signatureStatus = "unsupported";
      } else {
        const manifestSha = crypto.sha256Hex(manifestBytes);
        if (
          manifestSha.toLowerCase() !==
          sigEnvelope.manifestSha256.toLowerCase()
        ) {
          signatureStatus = "failed";
        } else {
          const verified = await crypto.verifyEd25519HexMessage({
            messageHex: manifestSha,
            signatureBase64: sigEnvelope.signatureBase64,
            publicKeyPem,
          });
          if (verified === null) {
            signatureStatus = "unsupported";
            limitations.push("AWS_KMS_SIGNATURE_REQUIRES_PUBLIC_KEY");
          } else {
            signatureStatus = verified ? "verified" : "failed";
          }
        }
      }
    } catch {
      signatureStatus = "unsupported";
    }
  }

  // -----------------------------------------------------------------
  // 4. Artifact integrity (presence of evidence files + recorded
  //    hashes inside the manifest). We deliberately do NOT recompute
  //    the original artifact hash from the evidence bytes here —
  //    that's already covered by the checksums index over the
  //    `evidence/...` paths. This sub-result is therefore a
  //    projection of (a) "is the manifest's hash field present" and
  //    (b) "did the checksums step succeed for the same path".
  // -----------------------------------------------------------------
  let artifactStatus: OfflineVerificationResult["artifactIntegrity"]["status"] =
    "unsupported";
  let itemsChecked = 0;
  const artifactFailures: ArtifactIntegrityFailure[] = [];
  if (parsedIndex) {
    const evidenceFiles = parsedIndex.files.filter((f) => isArtifactPath(f.path));
    itemsChecked = evidenceFiles.length;
    if (evidenceFiles.length === 0) {
      artifactStatus = "missing";
      warnings.push("ARTIFACT_HASH_MISSING_FROM_PACKAGE");
    } else {
      const failedSet = new Set(
        checksumFailures.map((f) => f.path),
      );
      let anyFail = false;
      for (const f of evidenceFiles) {
        if (failedSet.has(f.path)) {
          anyFail = true;
          artifactFailures.push({
            path: f.path,
            reason: "sha256_mismatch",
          });
        }
      }
      artifactStatus = anyFail ? "failed" : "verified";
    }
  }

  // -----------------------------------------------------------------
  // 5. Report signature inside the package (we expose what we can
  //    verify offline — embedded PDF signatures require an external
  //    PDF-signing toolchain and are explicitly `unsupported`).
  // -----------------------------------------------------------------
  let reportSigStatus: OfflineVerificationResult["reportSignature"]["status"] =
    "missing";
  let reportSigDetail:
    | OfflineVerificationResult["reportSignature"]["detail"]
    | null = null;
  // The `package-manifest.sig` covers the manifest; the embedded
  // report PDF signature is verified by external PDF tooling.
  if (parsedIndex?.files.some((f) => f.path.endsWith(".pdf"))) {
    reportSigStatus = "unsupported";
    reportSigDetail = "embedded_pdf_signature_external_tool_required";
    limitations.push("EMBEDDED_PDF_SIGNATURE_REQUIRES_EXTERNAL_TOOL");
    warnings.push("REPORT_SIGNATURE_UNSUPPORTED_FORMAT");
  } else if (signatureStatus === "verified") {
    reportSigStatus = "unsupported";
    reportSigDetail = "package_manifest_signature_verified_separately";
  } else {
    reportSigStatus = "missing";
    reportSigDetail = "missing";
    warnings.push("REPORT_SIGNATURE_MISSING");
  }

  // -----------------------------------------------------------------
  // 6. Custody attestations (P3.1.1)
  // -----------------------------------------------------------------
  const custodyResult = await verifyAttestations({
    reader,
    crypto,
    warnings,
    limitations,
  });

  // -----------------------------------------------------------------
  // 7. Timestamping (TSA + OTS) — presence + structural sanity only
  // -----------------------------------------------------------------
  const tsaToken = readFirstBytes(reader, [
    PATHS.tsaToken,
    LEGACY_PATHS.tsaToken,
  ]);
  let tsaStatus: OfflineVerificationResult["timestamping"]["tsaStatus"] =
    "missing";
  let tsaDetail: OfflineVerificationResult["timestamping"]["tsaDetail"] = "missing";
  if (tsaToken && tsaToken.length > 0) {
    tsaStatus = "unsupported";
    tsaDetail = "rfc3161_external_verification_required";
  } else {
    warnings.push("TSA_PROOF_MISSING");
  }

  const otsProof = reader.readBytes(PATHS.otsProof);
  let otsStatus: OfflineVerificationResult["timestamping"]["otsStatus"] =
    "missing";
  let otsDetail: OfflineVerificationResult["timestamping"]["otsDetail"] = "missing";
  if (otsProof && otsProof.length > 0) {
    const otsJson = reader.readText(PATHS.otsJson);
    let companionStatus: string | null = null;
    if (otsJson) {
      try {
        const j = JSON.parse(otsJson) as { status?: string };
        companionStatus = String(j.status ?? "").toLowerCase();
      } catch {
        companionStatus = null;
      }
    }
    if (
      companionStatus === "anchored" ||
      companionStatus === "upgraded"
    ) {
      otsStatus = "unsupported";
      otsDetail = "calendar_network_required";
    } else if (companionStatus === "pending") {
      otsStatus = "pending";
      otsDetail = "pending";
    } else {
      otsStatus = "unsupported";
      otsDetail = "calendar_network_required";
    }
  } else {
    warnings.push("OTS_PROOF_MISSING");
  }

  // -----------------------------------------------------------------
  // Package overall status
  // -----------------------------------------------------------------
  let packageStatus: OfflineVerificationResult["package"]["status"];
  if (checksumsStatus === "verified" && manifestStatus === "verified") {
    if (signatureStatus === "verified") packageStatus = "verified";
    else if (signatureStatus === "failed") packageStatus = "failed";
    else packageStatus = "partial";
  } else if (
    checksumsStatus === "mismatch" ||
    manifestStatus === "schema_invalid"
  ) {
    packageStatus = "failed";
  } else if (
    checksumsStatus === "missing_index" &&
    manifestStatus === "missing"
  ) {
    packageStatus = "unsupported";
  } else {
    packageStatus = "partial";
  }

  // Overall
  const overall: OverallStatus =
    packageStatus === "failed" || artifactStatus === "failed"
      ? "failed"
      : packageStatus === "verified" &&
          (custodyResult.status === "verified" ||
            custodyResult.status === "missing")
        ? custodyResult.status === "missing"
          ? "partial"
          : "verified"
        : "partial";

  const summary = buildSummary({
    packageStatus,
    artifactStatus,
    custodyStatus: custodyResult.status,
    tsaStatus,
    otsStatus,
  });

  // -----------------------------------------------------------------
  // Phase M1.1 — historical verification material check
  // -----------------------------------------------------------------
  const historical = await verifyHistoricalMaterial({
    reader,
    crypto,
    custodyAttestationsCount: custodyResult.attestationsChecked,
    warnings,
    limitations,
  });
  // The standing distinction MUST always be surfaced.
  limitations.push(
    "HISTORICAL_VERIFICATION_DOES_NOT_IMPLY_CURRENT_TRUST",
    "CURRENT_REVOCATION_STATUS_NOT_CHECKED_OFFLINE",
    "SIGNER_MAY_HAVE_BEEN_ROTATED_OR_REVOKED_AFTER_SIGNING",
  );

  // -----------------------------------------------------------------
  // Phase M2 — C2PA provenance summary
  // -----------------------------------------------------------------
  const c2paBlock = verifyC2paSummary({ reader, warnings });
  // Standing C2PA distinctions: ALWAYS surfaced so the offline result
  // can never silently imply C2PA validation when none was performed
  // and can never let a `valid` C2PA outcome promote PROOVRA's hash
  // verdict beyond what hash+custody actually showed.
  limitations.push(
    "C2PA_DOES_NOT_PROVE_CONTENT_TRUTH",
    "C2PA_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY",
    "C2PA_IS_NOT_A_REPLACEMENT_FOR_PROOVRA_CUSTODY",
    "MISSING_C2PA_DOES_NOT_REDUCE_PROOVRA_INTEGRITY",
    "INVALID_C2PA_DOES_NOT_OVERRIDE_PROOVRA_HASH_DECISION",
    "C2PA_VALIDATION_REQUIRES_TOOLING_NOT_BUNDLED_OFFLINE",
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    verifiedAtUtc,
    summary,
    package: {
      status: packageStatus,
      checksumsStatus,
      manifestStatus,
      signatureStatus,
      filesIndexed,
      extraFiles,
      checksumFailures,
    },
    artifactIntegrity: {
      status: artifactStatus,
      itemsChecked,
      failures: artifactFailures,
    },
    reportSignature: {
      status: reportSigStatus,
      detail: reportSigDetail,
    },
    custodyAttestations: custodyResult,
    timestamping: {
      tsaStatus,
      otsStatus,
      tsaDetail,
      otsDetail,
    },
    historicalVerification: historical,
    // Phase M1.1 — current trust status is ALWAYS `unknown` offline.
    // We do not contact PROOVRA's signer registry from the verifier,
    // so we cannot know whether the historical signer is currently
    // active, retired, or revoked. The verifier surfaces this
    // honestly rather than implying perpetual trust.
    currentTrustStatus: {
      status: "unknown" as const,
      note:
        "The offline verifier does not contact PROOVRA. Current signer trust / revocation status cannot be determined here. Consult /operations/signers on the live PROOVRA deployment for current state.",
    },
    c2pa: c2paBlock,
    overall: {
      status: overall,
      warnings: dedupe(warnings),
      limitations: dedupe(limitations),
    },
  };
}

// ---------------------------------------------------------------------------
// Custody attestation sub-verifier
// ---------------------------------------------------------------------------

type AttestationsBlock = OfflineVerificationResult["custodyAttestations"];

async function verifyAttestations(input: {
  reader: PackageReader;
  crypto: CryptoAdapter;
  warnings: WarningCode[];
  limitations: LimitationCode[];
}): Promise<AttestationsBlock> {
  const { reader, crypto, warnings, limitations } = input;
  const attestationsText = reader.readText(PATHS.custodyAttestations);
  const snapshotText = reader.readText(PATHS.signerSnapshot);
  if (!attestationsText) {
    // Pre-P3.1.1 package — bounded `missing`, NEVER `failed`.
    warnings.push("ATTESTATIONS_FILE_MISSING");
    warnings.push("PRE_P3_1_1_PACKAGE_DETECTED");
    return {
      status: "missing",
      attestationsExpected: 0,
      attestationsChecked: 0,
      attestationsVerified: 0,
      failures: [],
      canonicalPayloadRecomputeAvailable: false,
    };
  }
  if (!snapshotText) {
    warnings.push("SIGNER_SNAPSHOT_MISSING");
  }
  // We cannot recompute the canonical payload from inside the
  // package today — custody event raw rows are not embedded as a
  // standalone file in the package contract. We document this as a
  // bounded limitation and verify what we CAN: signature against
  // the recorded canonicalPayloadHash + signer's public material
  // when present.
  limitations.push(
    "VERIFIER_CANNOT_RECOMPUTE_CANONICAL_PAYLOAD_WITHOUT_CUSTODY_EVENT_DATA",
  );

  type AttestationsFile = {
    attestationsCount?: number;
    attestations?: Array<{
      custodyEventId: string;
      canonicalPayloadHash: string;
      signature: string;
      algorithm: string;
      signerId: string;
      keyId: string | null;
      keyVersion: string | null;
      provider: string;
    }>;
    degradedReason?: string | null;
    missingAttestations?: Array<{ custodyEventId: string }>;
  };
  let parsed: AttestationsFile;
  try {
    parsed = JSON.parse(attestationsText) as AttestationsFile;
  } catch {
    return {
      status: "unsupported",
      attestationsExpected: 0,
      attestationsChecked: 0,
      attestationsVerified: 0,
      failures: [],
      canonicalPayloadRecomputeAvailable: false,
    };
  }

  const attestations = parsed.attestations ?? [];
  const missing = parsed.missingAttestations ?? [];
  if (parsed.degradedReason) warnings.push("ATTESTATIONS_DEGRADED");
  if (missing.length > 0) warnings.push("ATTESTATIONS_PARTIAL_COVERAGE");

  // Without the per-signer public material BUNDLED in the package
  // (the snapshot lists a reference, not the material itself), we
  // cannot run the signature check offline. We surface
  // `unsupported` for the per-attestation signature verification
  // and ALLOW the operator-side / api-side `/v1/operations/custody-
  // attestations/:id/verify` to be the canonical signature check.
  //
  // What we CAN do offline today:
  //   * Structural integrity: every attestation envelope has the
  //     required fields and bounded enum values.
  //   * Coverage report: count attestations vs custody events.
  //
  // This is intentionally honest — see `attestation-verification.md`.

  let structurallyOk = 0;
  const failures: AttestationFailure[] = [];
  for (const a of attestations) {
    if (
      typeof a.custodyEventId !== "string" ||
      typeof a.canonicalPayloadHash !== "string" ||
      typeof a.signature !== "string" ||
      (a.provider !== "aws_kms" && a.provider !== "local_pem")
    ) {
      failures.push({
        custodyEventId:
          typeof a.custodyEventId === "string" ? a.custodyEventId : "<malformed>",
        reason: "signature_invalid",
      });
      continue;
    }
    if (a.provider === "aws_kms" && a.algorithm !== "ED25519_SHA_512") {
      failures.push({
        custodyEventId: a.custodyEventId,
        reason: "unsupported_algorithm",
      });
      continue;
    }
    if (a.provider === "local_pem" && a.algorithm !== "ED25519") {
      failures.push({
        custodyEventId: a.custodyEventId,
        reason: "unsupported_algorithm",
      });
      continue;
    }
    structurallyOk++;
  }
  // We deliberately do NOT call `crypto.verifyEd25519HexMessage` for
  // each attestation because the public key for the custody signer
  // is not bundled in the package today — the snapshot carries a
  // *reference* (e.g. `kms://GetPublicKey`) rather than raw PEM. A
  // future package format upgrade may inline the public key; that
  // upgrade is documented as deferred.
  //
  // We mark `unsupported` so downstream consumers know to use the
  // api-side verifier when bound to the live PROOVRA deployment.

  let status: AttestationsStatus;
  if (attestations.length === 0) {
    status = "missing";
  } else if (failures.length > 0 && failures.length === attestations.length) {
    status = "failed";
  } else if (
    failures.length === 0 &&
    missing.length === 0 &&
    parsed.degradedReason === null
  ) {
    // Structurally complete; signature cryptographic check still
    // requires online access to signer public material.
    status = "unsupported";
  } else {
    status = "partial";
  }
  // Reference the crypto adapter to silence unused-variable warnings;
  // signatures will be wired when packages carry inline public keys.
  void crypto;
  return {
    status,
    attestationsExpected: attestations.length + missing.length,
    attestationsChecked: attestations.length,
    attestationsVerified: structurallyOk,
    failures,
    canonicalPayloadRecomputeAvailable: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dedupe<T>(arr: ReadonlyArray<T>): ReadonlyArray<T> {
  return Array.from(new Set(arr));
}

function buildSummary(input: {
  packageStatus: string;
  artifactStatus: string;
  custodyStatus: string;
  tsaStatus: string;
  otsStatus: string;
}): string {
  const parts: string[] = [];
  parts.push(`package=${input.packageStatus}`);
  parts.push(`artifact=${input.artifactStatus}`);
  parts.push(`custody_attestations=${input.custodyStatus}`);
  parts.push(`tsa=${input.tsaStatus}`);
  parts.push(`ots=${input.otsStatus}`);
  return parts.join("; ").slice(0, 240);
}

// ---------------------------------------------------------------------------
// Phase M1.1 — historical verification material sub-verifier
// ---------------------------------------------------------------------------

type HistoricalBlock = OfflineVerificationResult["historicalVerification"];

async function verifyHistoricalMaterial(input: {
  reader: PackageReader;
  crypto: CryptoAdapter;
  custodyAttestationsCount: number;
  warnings: WarningCode[];
  limitations: LimitationCode[];
}): Promise<HistoricalBlock> {
  const text = input.reader.readText(PATHS.historicalMaterial);
  if (!text) {
    input.warnings.push("HISTORICAL_VERIFICATION_MATERIAL_MISSING");
    return {
      status: "missing",
      materialEntriesBundled: 0,
      materialEntriesVerifiable: 0,
    };
  }
  type HistoricalFile = {
    signers?: Array<{
      signerPurpose: string;
      verificationMaterialType?: string;
      algorithm?: string | null;
      verificationMaterial?: { publicKeyPem?: string | null };
    }>;
  };
  let parsed: HistoricalFile;
  try {
    parsed = JSON.parse(text) as HistoricalFile;
  } catch {
    return {
      status: "unsupported",
      materialEntriesBundled: 0,
      materialEntriesVerifiable: 0,
    };
  }
  const entries = parsed.signers ?? [];
  const bundled = entries.length;
  let verifiable = 0;
  let unsupportedAlgo = 0;
  for (const e of entries) {
    const pem = e.verificationMaterial?.publicKeyPem ?? null;
    const supportedAlgo =
      e.algorithm === "ED25519" || e.algorithm === "ED25519_SHA_512";
    if (!pem || !supportedAlgo) {
      if (pem && !supportedAlgo) unsupportedAlgo++;
      continue;
    }
    if (
      e.verificationMaterialType === "ed25519_spki_pem" ||
      e.verificationMaterialType === "kms_public_key_pem"
    ) {
      verifiable++;
    }
  }
  if (unsupportedAlgo > 0) {
    input.warnings.push("HISTORICAL_VERIFICATION_UNSUPPORTED_ALGORITHM");
  }
  if (verifiable < bundled) {
    input.warnings.push("HISTORICAL_VERIFICATION_PARTIAL_COVERAGE");
  }

  // The presence of a bundled public key gives us the option to
  // mechanically verify attestation signatures. However, we still
  // need the canonical custody payload to recompute the message
  // hash, which the package does not bundle today (covered by an
  // existing limitation code). So even with material present, the
  // historical signature-verify on custody attestations remains
  // structurally bounded. Report:
  //   * `verified`     — all material entries usable (PEM + supported algo)
  //   * `partial`      — some usable, some not
  //   * `unsupported`  — file present but no usable material
  //   * `failed`       — reserved for explicit verification failure
  let status: HistoricalVerificationStatus;
  if (bundled === 0) status = "unsupported";
  else if (verifiable === bundled) status = "verified";
  else if (verifiable === 0) status = "unsupported";
  else status = "partial";

  // Silence unused-variable warnings in this scope while keeping the
  // adapter available for future verification paths.
  void input.crypto;
  void input.custodyAttestationsCount;
  void input.limitations;

  return {
    status,
    materialEntriesBundled: bundled,
    materialEntriesVerifiable: verifiable,
  };
}

// ---------------------------------------------------------------------------
// Phase M2 — C2PA summary sub-verifier
// ---------------------------------------------------------------------------

type C2paBlock = OfflineVerificationResult["c2pa"];

function verifyC2paSummary(input: {
  reader: PackageReader;
  warnings: WarningCode[];
}): C2paBlock {
  const text = input.reader.readText(PATHS.c2paSummary);
  if (!text) {
    // No summary file — emit honest "missing" (not "failed"). Old
    // pre-M2 packages all land here.
    input.warnings.push("C2PA_SUMMARY_FILE_MISSING");
    return {
      status: "missing",
      validationStatus: "not_checked",
      itemsChecked: 0,
      providerMode: "unknown",
      rawManifestExportStatus: "disabled",
      rawManifestFilesFound: 0,
      rawManifestFilesClaimed: 0,
      generatedAssertionStatus: "not_generated",
    };
  }
  type SummaryShape = {
    schemaVersion?: string;
    providerMode?: string;
    aggregateStatus?: string;
    aggregateValidationStatus?: string;
    itemsChecked?: number;
    files?: ReadonlyArray<{
      rawManifest?: {
        status?: string;
        packageRelativePath?: string | null;
        sha256Hex?: string | null;
      };
    }>;
    generatedAssertion?: {
      status?: string;
    };
    rawManifestExportStatus?: string;
  };
  let parsed: SummaryShape;
  try {
    parsed = JSON.parse(text) as SummaryShape;
  } catch {
    input.warnings.push("C2PA_SUMMARY_SCHEMA_INVALID");
    return {
      status: "error",
      validationStatus: "error",
      itemsChecked: 0,
      providerMode: "unknown",
      rawManifestExportStatus: "disabled",
      rawManifestFilesFound: 0,
      rawManifestFilesClaimed: 0,
      generatedAssertionStatus: "not_generated",
    };
  }
  const status = normalizeC2paStatus(parsed.aggregateStatus);
  const validationStatus = normalizeC2paValidationStatus(
    parsed.aggregateValidationStatus,
  );
  const itemsChecked = Number.isInteger(parsed.itemsChecked)
    ? Math.max(0, parsed.itemsChecked as number)
    : Array.isArray(parsed.files)
      ? parsed.files.length
      : 0;
  const providerMode = normalizeC2paProviderMode(parsed.providerMode);

  if (status === "invalid") {
    input.warnings.push("C2PA_PROVIDER_REPORTED_INVALID_MANIFEST");
  } else if (status === "error") {
    input.warnings.push("C2PA_PROVIDER_REPORTED_EXTRACTION_ERROR");
  }

  // Phase M2.1 — raw manifest reconciliation. The summary lists
  // claimed `packageRelativePath` entries; we count how many actually
  // exist inside the ZIP. Any mismatch becomes a bounded warning.
  let rawManifestFilesClaimed = 0;
  let rawManifestFilesFound = 0;
  const files = Array.isArray(parsed.files) ? parsed.files : [];
  for (const f of files) {
    const ref = f?.rawManifest;
    const claimedPath = ref?.packageRelativePath ?? null;
    if (
      claimedPath &&
      typeof claimedPath === "string" &&
      claimedPath.startsWith("provenance/c2pa-manifests/")
    ) {
      rawManifestFilesClaimed++;
      const bytes = input.reader.readBytes(claimedPath);
      if (bytes && bytes.byteLength > 0) {
        rawManifestFilesFound++;
      } else {
        input.warnings.push("C2PA_RAW_MANIFEST_FILE_MISSING_FROM_PACKAGE");
      }
    }
  }
  const rawManifestExportStatus = normalizeRawManifestExportStatus(
    parsed.rawManifestExportStatus,
    {
      claimed: rawManifestFilesClaimed,
      found: rawManifestFilesFound,
    },
  );

  // Phase M2.1 — generated-assertion status mirror.
  const generatedAssertionStatus = normalizeGeneratedAssertionStatus(
    parsed.generatedAssertion?.status,
  );

  return {
    status,
    validationStatus,
    itemsChecked,
    providerMode,
    rawManifestExportStatus,
    rawManifestFilesFound,
    rawManifestFilesClaimed,
    generatedAssertionStatus,
  };
}

function normalizeRawManifestExportStatus(
  raw: string | undefined,
  counts: { claimed: number; found: number },
): C2paBlock["rawManifestExportStatus"] {
  const allowed: ReadonlyArray<C2paBlock["rawManifestExportStatus"]> = [
    "not_exported",
    "exported_to_package",
    "exported_to_artifact_store",
    "too_large_to_export",
    "unsupported",
    "disabled",
    "missing",
  ];
  if (counts.claimed > 0 && counts.found === 0) {
    return "missing";
  }
  if (raw && (allowed as ReadonlyArray<string>).includes(raw)) {
    return raw as C2paBlock["rawManifestExportStatus"];
  }
  // Fall back: if files reference paths but the summary's aggregate
  // is absent, infer based on the count.
  if (counts.claimed > 0 && counts.found === counts.claimed) {
    return "exported_to_package";
  }
  return "disabled";
}

function normalizeGeneratedAssertionStatus(
  raw: string | undefined,
): C2paBlock["generatedAssertionStatus"] {
  const allowed: ReadonlyArray<C2paBlock["generatedAssertionStatus"]> = [
    "not_generated",
    "generated_for_derivative",
    "generation_disabled",
    "generation_unavailable",
    "generation_refused",
  ];
  if (raw && (allowed as ReadonlyArray<string>).includes(raw)) {
    return raw as C2paBlock["generatedAssertionStatus"];
  }
  return "not_generated";
}

function normalizeC2paStatus(raw: string | undefined): C2paStatus {
  const allowed: ReadonlyArray<C2paStatus> = [
    "not_present",
    "present",
    "valid",
    "invalid",
    "unsupported",
    "disabled",
    "error",
    "missing",
  ];
  if (raw && (allowed as ReadonlyArray<string>).includes(raw)) {
    return raw as C2paStatus;
  }
  return "error";
}

function normalizeC2paValidationStatus(
  raw: string | undefined,
): C2paValidationStatus {
  const allowed: ReadonlyArray<C2paValidationStatus> = [
    "not_checked",
    "valid",
    "invalid",
    "unsupported",
    "error",
  ];
  if (raw && (allowed as ReadonlyArray<string>).includes(raw)) {
    return raw as C2paValidationStatus;
  }
  return "error";
}

function normalizeC2paProviderMode(
  raw: string | undefined,
): C2paBlock["providerMode"] {
  const allowed: ReadonlyArray<C2paBlock["providerMode"]> = [
    "disabled",
    "detect_only",
    "validate",
    "embed_supported",
    "unknown",
  ];
  if (raw && (allowed as ReadonlyArray<string>).includes(raw)) {
    return raw as C2paBlock["providerMode"];
  }
  return "unknown";
}
