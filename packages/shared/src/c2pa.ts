/**
 * PROOVRA C2PA — bounded provenance interoperability model.
 *
 * Phase M2.
 *
 * What this is:
 *   * A canonical, bounded result shape for C2PA detection /
 *     validation outcomes per evidence file.
 *   * Shared between api, worker, web, and the offline verifier so
 *     every surface mechanically interprets C2PA state identically.
 *
 * What this is NOT:
 *   * NOT a claim that content is "authentic" / "true" / "court-
 *     admissible" / "verified content" — none of those map to C2PA.
 *   * NOT a substitute for PROOVRA's hash / custody / TSA / OTS
 *     integrity. C2PA is an additional provenance signal that runs
 *     ALONGSIDE PROOVRA's integrity decision, never instead of it.
 *   * NOT a replacement for the offline-verifier crypto chain.
 *
 * Rules enforced here:
 *   * Every state is a bounded enum.
 *   * `summary` / `note` strings are bounded ≤240 chars at use sites.
 *   * Free-form raw manifest bytes are NEVER stored on this type —
 *     callers handle raw manifests as separate artifacts referenced
 *     by hash.
 */

// ---------------------------------------------------------------------------
// Bounded enums
// ---------------------------------------------------------------------------

/**
 * Top-level C2PA status for a single evidence file.
 *
 *   * `not_present`  — file has no C2PA manifest. Not a failure on
 *                      its own; PROOVRA hash/custody integrity stands
 *                      independently.
 *   * `present`      — manifest detected but validation either
 *                      disabled, not_checked, or pending.
 *   * `valid`        — manifest detected AND cryptographic validation
 *                      succeeded under the configured provider.
 *   * `invalid`      — manifest detected AND validation failed (bad
 *                      signature / hash mismatch / certificate
 *                      untrusted). This does NOT override PROOVRA
 *                      hash/custody integrity; surface it separately.
 *   * `unsupported`  — media format does not support C2PA, or current
 *                      provider mode cannot validate this format.
 *   * `disabled`     — C2PA provider is operationally disabled at
 *                      this deployment. Honest no-op.
 *   * `error`        — extraction or validation failed for an
 *                      operational reason (timeout, tool missing).
 */
export const C2PA_STATUSES = [
  "not_present",
  "present",
  "valid",
  "invalid",
  "unsupported",
  "disabled",
  "error",
] as const;
export type C2paStatus = (typeof C2PA_STATUSES)[number];

/**
 * Validation sub-status. Separates "we ran cryptographic checks" from
 * "we only detected the manifest's presence."
 *
 *   * `not_checked` — only detection ran (provider mode `detect_only`
 *                     or `disabled`). Not a failure.
 *   * `valid`       — signature + claim hash verified.
 *   * `invalid`     — signature OR claim hash did not verify.
 *   * `unsupported` — tooling does not support this format/algorithm.
 *   * `error`       — operational failure during validation.
 */
export const C2PA_VALIDATION_STATUSES = [
  "not_checked",
  "valid",
  "invalid",
  "unsupported",
  "error",
] as const;
export type C2paValidationStatus =
  (typeof C2PA_VALIDATION_STATUSES)[number];

/**
 * Provider operational mode (set via `C2PA_PROVIDER_MODE` env).
 *
 *   * `disabled`         — no C2PA work at all.
 *   * `detect_only`      — detect manifest presence, no validation.
 *   * `validate`         — detect + validate cryptographically.
 *   * `embed_supported`  — `validate` plus optional embedding into
 *                          PROOVRA-derived export artifacts (NEVER
 *                          mutates the original evidence file).
 */
export const C2PA_PROVIDER_MODES = [
  "disabled",
  "detect_only",
  "validate",
  "embed_supported",
] as const;
export type C2paProviderMode = (typeof C2PA_PROVIDER_MODES)[number];

/**
 * Bounded failure reason. Free-form error strings NEVER leak here.
 */
export const C2PA_FAILURE_REASONS = [
  "unsupported_format",
  "tooling_unavailable",
  "timeout",
  "malformed_manifest",
  "signature_invalid",
  "certificate_untrusted",
  "claim_hash_mismatch",
  "unknown",
] as const;
export type C2paFailureReason = (typeof C2PA_FAILURE_REASONS)[number];

/**
 * Bounded warning codes — operational hints that DO NOT fail
 * integrity. Surfaced in result `warnings[]`.
 */
export const C2PA_WARNING_CODES = [
  "C2PA_TOOL_VERSION_UNKNOWN",
  "C2PA_LARGE_MANIFEST_TRUNCATED_FROM_SUMMARY",
  "C2PA_PROVIDER_DOWNGRADED_TO_DETECT_ONLY",
  "C2PA_EXTRACTION_TIMED_OUT",
  "C2PA_INGREDIENT_GRAPH_INCOMPLETE",
  "C2PA_GENERATION_DEFERRED",
  // Phase M2.1 — raw manifest + generation surface warnings.
  "C2PA_RAW_MANIFEST_TOO_LARGE_TO_EXPORT",
  "C2PA_RAW_MANIFEST_EXPORT_DISABLED",
  "C2PA_GENERATION_UNAVAILABLE",
  "C2PA_GENERATION_REFUSED_FOR_ORIGINAL_EVIDENCE",
] as const;
export type C2paWarningCode = (typeof C2PA_WARNING_CODES)[number];

/**
 * Standing limitations — surfaced on EVERY C2PA result so the
 * historical / current / hash / custody distinction can never
 * silently disappear.
 */
export const C2PA_LIMITATION_CODES = [
  "C2PA_DOES_NOT_PROVE_CONTENT_TRUTH",
  "C2PA_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY",
  "C2PA_IS_NOT_A_REPLACEMENT_FOR_PROOVRA_CUSTODY",
  "MISSING_C2PA_DOES_NOT_REDUCE_PROOVRA_INTEGRITY",
  "INVALID_C2PA_DOES_NOT_OVERRIDE_PROOVRA_HASH_DECISION",
  "C2PA_VALIDATION_REQUIRES_TOOLING_NOT_BUNDLED_OFFLINE",
] as const;
export type C2paLimitationCode = (typeof C2PA_LIMITATION_CODES)[number];

/**
 * Bounded claim signature status (mirrors C2PA's signing surface).
 */
export const C2PA_CLAIM_SIGNATURE_STATUSES = [
  "not_evaluated",
  "valid",
  "invalid",
  "unsupported",
  "expired",
  "untrusted_certificate",
] as const;
export type C2paClaimSignatureStatus =
  (typeof C2PA_CLAIM_SIGNATURE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

export const C2PA_RESULT_SCHEMA_VERSION =
  "PROOVRA_C2PA_RESULT_V1" as const;

/**
 * Phase M2.1 — bounded raw-manifest reference. Used when the operator
 * has opted into raw-manifest preservation
 * (`C2PA_RAW_MANIFEST_EXPORT_ENABLED=true`) and the manifest size is
 * below the configured cap.
 *
 * Hard rules:
 *   * Raw manifest bytes are NEVER stored inline in this projection.
 *     A reference to a separately-stored artifact lives here, along
 *     with its SHA-256 hash for downstream verification.
 *   * `packageRelativePath` is the path the file occupies INSIDE a
 *     Verification Package ZIP. Absence means "not bundled in any
 *     known package yet".
 */
export const C2PA_RAW_MANIFEST_STORAGE_STATUSES = [
  "not_exported",
  "exported_to_package",
  "exported_to_artifact_store",
  "too_large_to_export",
  "unsupported",
  "disabled",
] as const;
export type C2paRawManifestStorageStatus =
  (typeof C2PA_RAW_MANIFEST_STORAGE_STATUSES)[number];

export type C2paRawManifestReference = {
  status: C2paRawManifestStorageStatus;
  /** SHA-256 hex of the raw manifest bytes when available. */
  sha256Hex: string | null;
  /** Manifest byte count when available; null on unsupported / disabled. */
  sizeBytes: number | null;
  /** Path inside the Verification Package ZIP when bundled. */
  packageRelativePath: string | null;
};

/**
 * Phase M2.1 — bounded generation-assertion status. Records whether
 * PROOVRA produced a derivative C2PA manifest for a downstream export
 * artifact (NEVER for the original evidence file).
 */
export const C2PA_GENERATED_ASSERTION_STATUSES = [
  "not_generated",
  "generated_for_derivative",
  "generation_disabled",
  "generation_unavailable",
  "generation_refused",
] as const;
export type C2paGeneratedAssertionStatus =
  (typeof C2PA_GENERATED_ASSERTION_STATUSES)[number];

export type C2paGeneratedAssertion = {
  status: C2paGeneratedAssertionStatus;
  /** Bounded label of the targeted derivative artifact kind. */
  targetKind:
    | "verification_package"
    | "report_pdf"
    | "export_bundle"
    | "none";
  /** Optional reference to the artifact containing the generated
   *  assertion. Bounded path; never raw bytes. */
  derivativeArtifactRef: string | null;
  /** Hash of the verification-package the assertion claims to belong
   *  to (when present). */
  verificationPackageSha256: string | null;
};

/**
 * Phase M2.1 — bounded generation readiness response.
 */
export const C2PA_GENERATION_READINESS_STATES = [
  "ready",
  "disabled",
  "missing_cert",
  "missing_key",
  "tooling_unavailable",
  "unsupported_target",
  "blocked_by_signer_governance",
] as const;
export type C2paGenerationReadinessState =
  (typeof C2PA_GENERATION_READINESS_STATES)[number];

export type C2paGenerationReadiness = {
  state: C2paGenerationReadinessState;
  /** Bounded operator-readable reason (≤240 chars). */
  reason: string;
  /** Bounded target kinds the operator has configured. */
  configuredTargets: ReadonlyArray<
    "derived_exports" | "report_pdfs" | "verification_packages"
  >;
  /** When `state === "ready"`, the operator can attempt generation.
   *  Otherwise, the UI must surface "Generation unavailable". */
  canAttempt: boolean;
};

/**
 * Single-file C2PA evaluation result. Multiple of these are
 * aggregated into a per-evidence summary.
 */
export type C2paFileResult = {
  /** Item / part id when the evidence is multi-part; null for single. */
  itemId: string | null;
  /** Operator-visible bounded media type (e.g. `image/jpeg`). */
  mediaType: string;
  /** Top-level bounded status. */
  status: C2paStatus;
  /** Did we observe at least one C2PA manifest in the bytes? */
  manifestDetected: boolean;
  /** Validation sub-status. */
  validationStatus: C2paValidationStatus;
  /** Optional bounded `claimSignatureStatus`. */
  claimSignatureStatus: C2paClaimSignatureStatus;
  /**
   * Free-form generator label as reported by the manifest's
   * `claim_generator` field, bounded to ≤120 chars. May be `null` if
   * the manifest does not report one or the provider did not extract.
   */
  claimGenerator: string | null;
  /** Number of ingredients referenced by the manifest. */
  ingredientsCount: number;
  /**
   * Bounded assertion summary — counts only, no raw assertion bytes.
   */
  assertionsSummary: {
    total: number;
    actionsCount: number;
    thumbnailCount: number;
    hashCount: number;
    customCount: number;
  };
  /** Optional claim timestamp (UTC ISO) from inside the manifest. */
  claimTimestampUtc: string | null;
  /** Bounded failure reason when `status` is `invalid` or `error`. */
  failureReason: C2paFailureReason | null;
  /** Bounded warnings — never a failure. */
  warnings: ReadonlyArray<C2paWarningCode>;
  /**
   * Phase M2.1 — bounded raw-manifest reference. Always present;
   * carries `disabled` / `not_exported` for files where preservation
   * is off or unsupported.
   */
  rawManifest?: C2paRawManifestReference;
};

/**
 * Per-evidence aggregation. One of these lives inside the verification
 * package as `provenance/c2pa-summary.json` and is mirrored on
 * `Evidence.verificationPackageMetadata.c2pa` (the storage projection).
 */
export type C2paEvidenceSummary = {
  schemaVersion: typeof C2PA_RESULT_SCHEMA_VERSION;
  /** When this summary was assembled (UTC ISO). */
  generatedAtUtc: string;
  /** Evidence id this summary pertains to. */
  evidenceId: string;
  /** Provider mode at the time of evaluation. */
  providerMode: C2paProviderMode;
  /** Provider tool version when known, else null. */
  toolVersion: string | null;
  /** Bounded aggregate status across all files. */
  aggregateStatus: C2paStatus;
  /** Bounded aggregate validation status across all files. */
  aggregateValidationStatus: C2paValidationStatus;
  /** Number of files we attempted to check. */
  itemsChecked: number;
  /** Per-file bounded results. */
  files: ReadonlyArray<C2paFileResult>;
  /** Warnings spanning the whole evidence. */
  warnings: ReadonlyArray<C2paWarningCode>;
  /** Standing limitations — ALWAYS the full set; see below. */
  limitations: ReadonlyArray<C2paLimitationCode>;
  /** Optional bounded note (≤240 chars). */
  note: string | null;
  /**
   * Phase M2.1 — bounded aggregate generation status. Tells
   * downstream verifiers whether a PROOVRA-derived assertion was
   * embedded in any companion artifact.
   */
  generatedAssertion?: C2paGeneratedAssertion;
  /**
   * Phase M2.1 — bounded aggregate raw-manifest status. Mirrors the
   * per-file `rawManifest.status` values for the operator UI; the
   * authoritative per-file state lives on `files[]`.
   */
  rawManifestExportStatus?: C2paRawManifestStorageStatus;
};

// ---------------------------------------------------------------------------
// Defaults / constructors
// ---------------------------------------------------------------------------

/**
 * The standing limitations injected on every result, regardless of
 * outcome. These exist so the distinction between C2PA provenance
 * and PROOVRA integrity is impossible to lose in any surface.
 */
export const STANDING_C2PA_LIMITATIONS: ReadonlyArray<C2paLimitationCode> = [
  "C2PA_DOES_NOT_PROVE_CONTENT_TRUTH",
  "C2PA_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY",
  "C2PA_IS_NOT_A_REPLACEMENT_FOR_PROOVRA_CUSTODY",
  "MISSING_C2PA_DOES_NOT_REDUCE_PROOVRA_INTEGRITY",
  "INVALID_C2PA_DOES_NOT_OVERRIDE_PROOVRA_HASH_DECISION",
];

/**
 * Build an honest "disabled" result for an evidence record. Used as
 * the default when the provider is operationally disabled, so the
 * verification package STILL carries a bounded c2pa-summary.json
 * (preferring honesty over silence).
 */
export function buildDisabledC2paSummary(input: {
  evidenceId: string;
  generatedAtUtc: string;
}): C2paEvidenceSummary {
  return {
    schemaVersion: C2PA_RESULT_SCHEMA_VERSION,
    generatedAtUtc: input.generatedAtUtc,
    evidenceId: input.evidenceId,
    providerMode: "disabled",
    toolVersion: null,
    aggregateStatus: "disabled",
    aggregateValidationStatus: "not_checked",
    itemsChecked: 0,
    files: [],
    warnings: [],
    limitations: STANDING_C2PA_LIMITATIONS,
    note:
      "C2PA provenance evaluation is operationally disabled at this PROOVRA deployment. PROOVRA hash/custody integrity is unaffected.",
    generatedAssertion: buildDisabledGeneratedAssertion(),
    rawManifestExportStatus: "disabled",
  };
}

/**
 * Build an honest "not_present" single-file result.
 */
export function buildNotPresentC2paFileResult(input: {
  itemId: string | null;
  mediaType: string;
}): C2paFileResult {
  return {
    itemId: input.itemId,
    mediaType: input.mediaType,
    status: "not_present",
    manifestDetected: false,
    validationStatus: "not_checked",
    claimSignatureStatus: "not_evaluated",
    claimGenerator: null,
    ingredientsCount: 0,
    assertionsSummary: {
      total: 0,
      actionsCount: 0,
      thumbnailCount: 0,
      hashCount: 0,
      customCount: 0,
    },
    claimTimestampUtc: null,
    failureReason: null,
    warnings: [],
    rawManifest: buildDisabledRawManifestReference(),
  };
}

/**
 * Bounded default for `rawManifest` — used when preservation is off
 * by environment policy. Honest "disabled" beats silence.
 */
export function buildDisabledRawManifestReference(): C2paRawManifestReference {
  return {
    status: "disabled",
    sha256Hex: null,
    sizeBytes: null,
    packageRelativePath: null,
  };
}

/**
 * Bounded default for `generatedAssertion` — used when generation is
 * off by environment policy.
 */
export function buildDisabledGeneratedAssertion(): C2paGeneratedAssertion {
  return {
    status: "generation_disabled",
    targetKind: "none",
    derivativeArtifactRef: null,
    verificationPackageSha256: null,
  };
}

/**
 * Bounded list of media types the PROOVRA C2PA provider considers
 * "potentially capable" of carrying a C2PA manifest. Files outside
 * this list short-circuit to `unsupported` without invoking any
 * external tooling — keeps the worker cheap and predictable.
 *
 * Sourced from the C2PA spec's "Supported Formats" baseline:
 * https://c2pa.org/specifications/specifications/1.4/specs/C2PA_Specification.html#_supported_formats
 *
 * (Recorded here as a bounded enum so we can mechanically test
 * against it in source-contract tests.)
 */
export const C2PA_SUPPORTED_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/tiff",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/avif",
  "image/x-adobe-dng",
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "application/pdf",
] as const;

export function isC2paSupportedMediaType(mediaType: string | null): boolean {
  if (!mediaType) return false;
  return (C2PA_SUPPORTED_MEDIA_TYPES as ReadonlyArray<string>).includes(
    mediaType.toLowerCase(),
  );
}

/**
 * Aggregate a list of per-file results into the bounded summary.
 * Aggregation rules:
 *   * If any file is `invalid` → aggregate is `invalid`.
 *   * Else if any file is `error` → aggregate is `error`.
 *   * Else if any file is `valid` → aggregate is `valid`.
 *   * Else if any file is `present` → aggregate is `present`.
 *   * Else if any file is `unsupported` → aggregate is `unsupported`.
 *   * Else (all `not_present`) → aggregate is `not_present`.
 *
 * Validation aggregation mirrors: invalid > error > valid > unsupported > not_checked.
 */
export function aggregateC2paFileResults(input: {
  evidenceId: string;
  generatedAtUtc: string;
  providerMode: C2paProviderMode;
  toolVersion: string | null;
  files: ReadonlyArray<C2paFileResult>;
  warnings?: ReadonlyArray<C2paWarningCode>;
  note?: string | null;
}): C2paEvidenceSummary {
  const files = input.files;
  // Bounded aggregation.
  const statusPriority: ReadonlyArray<C2paStatus> = [
    "invalid",
    "error",
    "valid",
    "present",
    "unsupported",
    "disabled",
    "not_present",
  ];
  const validationPriority: ReadonlyArray<C2paValidationStatus> = [
    "invalid",
    "error",
    "valid",
    "unsupported",
    "not_checked",
  ];

  let aggregateStatus: C2paStatus =
    input.providerMode === "disabled" ? "disabled" : "not_present";
  for (const candidate of statusPriority) {
    if (files.some((f) => f.status === candidate)) {
      aggregateStatus = candidate;
      break;
    }
  }

  let aggregateValidationStatus: C2paValidationStatus = "not_checked";
  for (const candidate of validationPriority) {
    if (files.some((f) => f.validationStatus === candidate)) {
      aggregateValidationStatus = candidate;
      break;
    }
  }

  return {
    schemaVersion: C2PA_RESULT_SCHEMA_VERSION,
    generatedAtUtc: input.generatedAtUtc,
    evidenceId: input.evidenceId,
    providerMode: input.providerMode,
    toolVersion: input.toolVersion,
    aggregateStatus,
    aggregateValidationStatus,
    itemsChecked: files.length,
    files,
    warnings: input.warnings ?? [],
    limitations: STANDING_C2PA_LIMITATIONS,
    note: input.note ?? null,
  };
}
