/**
 * PROOVRA Offline Verification Result — canonical schema.
 *
 * Bounded, machine-readable, versioned. Every field is constrained
 * to a small enum so a downstream consumer (CLI / browser / SIEM)
 * can mechanically interpret the result without parsing free-form
 * strings.
 *
 * Hard rules:
 *   * NO legal-admissibility / "authentic content proven" / "court-
 *     ready" claims anywhere.
 *   * NO unbounded `error.message` style fields. Operator-readable
 *     `summary` is bounded ≤240 chars; bounded enums carry the
 *     decision; `warnings` / `limitations` are arrays of bounded
 *     codes (each ≤80 chars).
 *   * NO leakage of raw evidence content, signatures, KMS keys, or
 *     OS file paths inside the result.
 *   * Old packages produce `partial` / `missing` / `unsupported`
 *     statuses — they NEVER hard-fail just because they lack the
 *     P3.1.1 attestation files.
 */

export const SCHEMA_VERSION = "PROOVRA_OFFLINE_VERIFICATION_RESULT_V1";

// ---------------------------------------------------------------------------
// Bounded enums
// ---------------------------------------------------------------------------

export const PACKAGE_STATUSES = [
  "verified",
  "partial",
  "failed",
  "unsupported",
] as const;
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];

export const CHECKSUMS_STATUSES = [
  "verified",
  "mismatch",
  "missing_index",
  "unsupported",
] as const;
export type ChecksumsStatus = (typeof CHECKSUMS_STATUSES)[number];

export const MANIFEST_STATUSES = [
  "verified",
  "schema_invalid",
  "missing",
  "unsupported",
] as const;
export type ManifestStatus = (typeof MANIFEST_STATUSES)[number];

export const SIGNATURE_STATUSES = [
  "verified",
  "failed",
  "missing",
  "unsupported",
] as const;
export type SignatureStatus = (typeof SIGNATURE_STATUSES)[number];

export const ARTIFACT_INTEGRITY_STATUSES = [
  "verified",
  "failed",
  "missing",
  "unsupported",
] as const;
export type ArtifactIntegrityStatus =
  (typeof ARTIFACT_INTEGRITY_STATUSES)[number];

export const ATTESTATIONS_STATUSES = [
  "verified",
  "partial",
  "missing",
  "failed",
  "unsupported",
] as const;
export type AttestationsStatus = (typeof ATTESTATIONS_STATUSES)[number];

export const TSA_STATUSES = [
  "verified",
  "missing",
  "failed",
  "unsupported",
] as const;
export type TsaStatus = (typeof TSA_STATUSES)[number];

export const OTS_STATUSES = [
  "verified",
  "pending",
  "missing",
  "failed",
  "unsupported",
] as const;
export type OtsStatus = (typeof OTS_STATUSES)[number];

export const OVERALL_STATUSES = ["verified", "partial", "failed"] as const;
export type OverallStatus = (typeof OVERALL_STATUSES)[number];

// Phase M1.1 — explicit historical-vs-current trust distinction.

export const HISTORICAL_VERIFICATION_STATUSES = [
  "verified",
  "partial",
  "failed",
  "missing",
  "unsupported",
] as const;
export type HistoricalVerificationStatus =
  (typeof HISTORICAL_VERIFICATION_STATUSES)[number];

export const CURRENT_TRUST_STATUSES = [
  "unknown",
  "not_checked",
  "unsupported",
] as const;
export type CurrentTrustStatus = (typeof CURRENT_TRUST_STATUSES)[number];

// Phase M2 — C2PA provenance interoperability statuses.
//
// `provenance/c2pa-summary.json` carries the bounded provider result
// from package generation time. The verifier mirrors the summary's
// aggregate state into this top-level field. The verifier NEVER runs
// external C2PA validation tooling, so even a `valid` summary is
// surfaced honestly without re-verification — see standing
// limitation `C2PA_VALIDATION_REQUIRES_TOOLING_NOT_BUNDLED_OFFLINE`.

export const C2PA_STATUSES = [
  "not_present",
  "present",
  "valid",
  "invalid",
  "unsupported",
  "disabled",
  "error",
  "missing",
] as const;
export type C2paStatus = (typeof C2PA_STATUSES)[number];

export const C2PA_VALIDATION_STATUSES = [
  "not_checked",
  "valid",
  "invalid",
  "unsupported",
  "error",
] as const;
export type C2paValidationStatus =
  (typeof C2PA_VALIDATION_STATUSES)[number];

// Phase M2.1 — bounded raw-manifest + generation surfaces. The
// offline verifier mirrors these from the bundled summary and
// reports raw-manifest file presence/absence inside the ZIP.

export const C2PA_RAW_MANIFEST_EXPORT_STATUSES = [
  "not_exported",
  "exported_to_package",
  "exported_to_artifact_store",
  "too_large_to_export",
  "unsupported",
  "disabled",
  "missing", // file referenced in summary but not present in ZIP
] as const;
export type C2paRawManifestExportStatus =
  (typeof C2PA_RAW_MANIFEST_EXPORT_STATUSES)[number];

export const C2PA_GENERATED_ASSERTION_STATUSES = [
  "not_generated",
  "generated_for_derivative",
  "generation_disabled",
  "generation_unavailable",
  "generation_refused",
] as const;
export type C2paGeneratedAssertionStatusForVerifier =
  (typeof C2PA_GENERATED_ASSERTION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Bounded warning + limitation codes
// ---------------------------------------------------------------------------

export const WARNING_CODES = [
  "PACKAGE_MANIFEST_MISSING",
  "PACKAGE_SIGNATURE_MISSING",
  "PACKAGE_PUBLIC_KEY_MISSING",
  "EXTRA_FILES_NOT_IN_CHECKSUMS",
  "CHECKSUMS_MISSING_FILE",
  "ATTESTATIONS_FILE_MISSING",
  "ATTESTATIONS_DEGRADED",
  "ATTESTATIONS_PARTIAL_COVERAGE",
  "SIGNER_SNAPSHOT_MISSING",
  "TSA_PROOF_MISSING",
  "OTS_PROOF_MISSING",
  "ARTIFACT_HASH_MISSING_FROM_PACKAGE",
  "REPORT_SIGNATURE_MISSING",
  "REPORT_SIGNATURE_UNSUPPORTED_FORMAT",
  "PRE_P3_1_1_PACKAGE_DETECTED",
  "STRICT_MODE_DEGRADED",
  // Phase M1.1
  "HISTORICAL_VERIFICATION_MATERIAL_MISSING",
  "HISTORICAL_VERIFICATION_PARTIAL_COVERAGE",
  "HISTORICAL_VERIFICATION_UNSUPPORTED_ALGORITHM",
  // Phase M2 — C2PA provenance
  "C2PA_SUMMARY_FILE_MISSING",
  "C2PA_SUMMARY_SCHEMA_INVALID",
  "C2PA_PROVIDER_REPORTED_INVALID_MANIFEST",
  "C2PA_PROVIDER_REPORTED_EXTRACTION_ERROR",
  // Phase M2.1 — raw manifest + generation
  "C2PA_RAW_MANIFEST_FILE_MISSING_FROM_PACKAGE",
  "C2PA_RAW_MANIFEST_REFERENCE_MISMATCH",
  "C2PA_GENERATED_ASSERTION_MISSING_BUT_CLAIMED",
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export const LIMITATION_CODES = [
  "TSA_REQUIRES_EXTERNAL_RFC3161_VERIFICATION",
  "OTS_REQUIRES_BITCOIN_NETWORK",
  "AWS_KMS_SIGNATURE_REQUIRES_PUBLIC_KEY",
  "EMBEDDED_PDF_SIGNATURE_REQUIRES_EXTERNAL_TOOL",
  "NO_LEGAL_ADMISSIBILITY_CLAIM",
  "NO_AUTHORSHIP_CLAIM",
  "VERIFIER_CANNOT_RECOMPUTE_CANONICAL_PAYLOAD_WITHOUT_CUSTODY_EVENT_DATA",
  // Phase M1.1 — the standing distinction.
  "HISTORICAL_VERIFICATION_DOES_NOT_IMPLY_CURRENT_TRUST",
  "CURRENT_REVOCATION_STATUS_NOT_CHECKED_OFFLINE",
  "SIGNER_MAY_HAVE_BEEN_ROTATED_OR_REVOKED_AFTER_SIGNING",
  // Phase M2 — C2PA standing distinctions. Always present.
  "C2PA_DOES_NOT_PROVE_CONTENT_TRUTH",
  "C2PA_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY",
  "C2PA_IS_NOT_A_REPLACEMENT_FOR_PROOVRA_CUSTODY",
  "MISSING_C2PA_DOES_NOT_REDUCE_PROOVRA_INTEGRITY",
  "INVALID_C2PA_DOES_NOT_OVERRIDE_PROOVRA_HASH_DECISION",
  "C2PA_VALIDATION_REQUIRES_TOOLING_NOT_BUNDLED_OFFLINE",
] as const;
export type LimitationCode = (typeof LIMITATION_CODES)[number];

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

export type ChecksumFailure = {
  path: string;
  reason: "missing" | "sha256_mismatch" | "unreadable";
};

export type AttestationFailure = {
  custodyEventId: string;
  reason:
    | "missing_signer_material"
    | "unsupported_algorithm"
    | "signature_invalid"
    | "payload_hash_mismatch_with_recompute_skipped";
};

export type ArtifactIntegrityFailure = {
  path: string;
  reason: "missing_file" | "sha256_mismatch" | "missing_recorded_hash";
};

export type OfflineVerificationResult = {
  schemaVersion: typeof SCHEMA_VERSION;
  verifiedAtUtc: string;
  /** Operator-readable bounded summary (≤240 chars). */
  summary: string;
  package: {
    status: PackageStatus;
    checksumsStatus: ChecksumsStatus;
    manifestStatus: ManifestStatus;
    signatureStatus: SignatureStatus;
    /** Numeric count of files indexed in `package-checksums.json`. */
    filesIndexed: number;
    /** Number of files inside the ZIP not appearing in the index. */
    extraFiles: number;
    checksumFailures: ReadonlyArray<ChecksumFailure>;
  };
  artifactIntegrity: {
    status: ArtifactIntegrityStatus;
    itemsChecked: number;
    failures: ReadonlyArray<ArtifactIntegrityFailure>;
  };
  reportSignature: {
    status: SignatureStatus;
    /** Bounded reason when status != "verified". */
    detail:
      | "missing"
      | "embedded_pdf_signature_external_tool_required"
      | "package_manifest_signature_verified_separately"
      | "verified"
      | "unsupported"
      | null;
  };
  custodyAttestations: {
    status: AttestationsStatus;
    attestationsExpected: number;
    attestationsChecked: number;
    attestationsVerified: number;
    failures: ReadonlyArray<AttestationFailure>;
    /** Whether the verifier could re-derive the canonical payload
     *  from package-included custody event data. */
    canonicalPayloadRecomputeAvailable: boolean;
  };
  timestamping: {
    tsaStatus: TsaStatus;
    otsStatus: OtsStatus;
    /** Bounded detail for the operator. */
    tsaDetail:
      | "missing"
      | "rfc3161_external_verification_required"
      | "verified"
      | "unsupported"
      | null;
    otsDetail:
      | "missing"
      | "calendar_network_required"
      | "verified"
      | "pending"
      | "unsupported"
      | null;
  };
  /**
   * Phase M1.1 — explicit distinction between
   *   "the signature matches the bundled signing-time public material"
   * and
   *   "the signer is currently trusted by the live PROOVRA deployment".
   *
   * The offline verifier can answer the FIRST question (when
   * `signers/historical-verification-material.json` is bundled).
   * The SECOND question cannot be answered offline and is ALWAYS
   * surfaced as `unknown`.
   */
  historicalVerification: {
    status: HistoricalVerificationStatus;
    /** Number of signer entries for which public material was
     *  bundled in `signers/historical-verification-material.json`. */
    materialEntriesBundled: number;
    /** Number of signer entries with verifiable material (PEM
     *  present, algorithm supported). */
    materialEntriesVerifiable: number;
  };
  currentTrustStatus: {
    status: CurrentTrustStatus;
    /** Bounded operator-readable note. */
    note: string;
  };
  /**
   * Phase M2 — C2PA provenance interoperability.
   *
   * Reports the package's bundled C2PA summary. The offline verifier
   * does NOT run external C2PA cryptographic validation — even if the
   * summary reports `valid`, the verifier surfaces `validationStatus`
   * honestly (it is the provider's claim at packaging time, not the
   * verifier's). This decoupling preserves PROOVRA's integrity model:
   * C2PA never overrides hash / custody / TSA / OTS state.
   */
  c2pa: {
    status: C2paStatus;
    validationStatus: C2paValidationStatus;
    /** Number of files the bundled summary covers. */
    itemsChecked: number;
    /** Bounded provider mode label echoed from the summary. */
    providerMode:
      | "disabled"
      | "detect_only"
      | "validate"
      | "embed_supported"
      | "unknown";
    /**
     * Phase M2.1 — bounded raw-manifest export status mirrored from
     * the summary. The verifier ALSO checks whether the referenced
     * raw-manifest files actually exist inside the ZIP and surfaces
     * a warning if they were claimed but absent.
     */
    rawManifestExportStatus: C2paRawManifestExportStatus;
    /** Count of raw-manifest files actually found inside the ZIP. */
    rawManifestFilesFound: number;
    /** Count of raw-manifest files claimed by the summary's references. */
    rawManifestFilesClaimed: number;
    /**
     * Phase M2.1 — bounded generated-assertion status mirrored from
     * the summary. The verifier surfaces it honestly; it does NOT
     * cryptographically verify a generated assertion offline (same
     * tooling-availability rule that applies to all C2PA validation).
     */
    generatedAssertionStatus: C2paGeneratedAssertionStatusForVerifier;
  };
  overall: {
    status: OverallStatus;
    warnings: ReadonlyArray<WarningCode>;
    limitations: ReadonlyArray<LimitationCode>;
  };
};
