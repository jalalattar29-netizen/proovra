import {
  classifyCustodyEventType,
  type CustodyEventCategory,
} from "./custody.js";
import {
  OTS_STATE_WORDS,
  OTS_VERIFICATION_WORDS,
  otsChainRecordOf,
  type OtsAnchoring,
  type OtsVerificationKey,
} from "./ots-anchoring.js";
import { presentedTsaStatus } from "./tsa-validation-state.js";
import { recordSignatureValiditySummary, type RecordSignatureValidity } from "./record-signature-validity.js";
import {
  STORAGE_PROTECTION_VERIFICATION_LABELS,
  resolveStorageProtectionVerification,
  type StorageProtectionVerificationState,
} from "./storage-protection.js";
import {
  TSA_VALIDATED_QUALIFICATION_STATEMENT,
  TRUST_SIGNAL_STATE_PRESENTATION,
  otsQualifiersOf,
  otsTrustStateOf,
  otsVerificationOfSignalState,
  resolveOtsTrustState,
  resolveSnapshotSignalState,
  resolveTsaTrustState,
  toVerificationStatus,
  type TrustSignalState,
  type VerificationQualifier,
} from "./trust-signal-state.js";
import {
  VERIFICATION_MATRIX_LABELS,
  verificationMatrixSummary,
  type VerificationMatrixKey,
} from "./verification-matrix.js";

export type TrustDecisionTone = "success" | "warning" | "danger" | "neutral";

/**
 * LEGACY PROJECTION of `TrustSignal.state` (see trust-signal-state.ts). Kept
 * for stored snapshots and old readers; `passed` is written only for PASSED.
 */
export type TrustSignalStatus =
  | "passed"
  | "partial"
  | "pending"
  | "missing"
  | "failed"
  | "not_applicable";

/**
 * Internal presentation buckets (tones, which wording a surface shows). Never
 * displayed as words and never an overall conclusion: what a record shows is
 * its per-signal verification matrix (verification-matrix.ts).
 */
export type TrustPresentationState =
  | "VERIFIED_FINALIZED"
  | "VERIFIED_PENDING_ANCHORING"
  | "VERIFIED_WITH_DEGRADED_SIGNALS"
  | "PARTIALLY_VERIFIED"
  | "FAILED_VERIFICATION"
  | "REVIEW_REQUIRED";

/**
 * The anchoring bucket, from the canonical OTS verification (ots-anchoring.ts):
 *   verified       independently verified against the Bitcoin main chain (the ONLY positive bucket)
 *   recorded       the proof names a Bitcoin block; not independently checked
 *   pending        calendar proof pending, or chain confirmations pending
 *   failed         proof defect or chain contradiction
 *   unavailable    material or verifier unavailable
 *   not_requested  anchoring not requested
 */
export type TrustAnchoringState = "verified" | "recorded" | "pending" | "failed" | "unavailable" | "not_requested";

export type TrustSignalKey =
  | "core_integrity"
  | "signature"
  | "trusted_timestamp"
  | "bitcoin_anchoring"
  | "immutable_storage"
  | "custody_chain"
  | "identity"
  | "verification_package";

/**
 * One verification layer. It carries a STATE and the words for it — never a
 * point, a weight or a score (2026-10-08: PROOVRA reports what was checked,
 * not a confidence).
 */
export type TrustSignal = {
  key: TrustSignalKey;
  label: string;
  /** THE canonical state. `status` is its legacy projection. */
  state: TrustSignalState;
  /** When the check behind this state was measured, where recorded. */
  measuredAtUtc: string | null;
  status: TrustSignalStatus;
  tone: TrustDecisionTone;
  summary: string;
  detail: string;
  /** bitcoin_anchoring only: the canonical OTS verification key (CHAIN_VERIFIED is the only PASSED). */
  otsVerification?: OtsVerificationKey;
  /** How the state came about (never a status; see VERIFICATION_QUALIFIERS). */
  qualifiers?: VerificationQualifier[];
};

/**
 * The record's signals and the bounded summary of them. There is no verdict,
 * score, reliance level or confidence label: a surface states each signal
 * (through the verification matrix) and this summary, nothing more.
 */
export type TrustDecision = {
  tone: TrustDecisionTone;
  presentationState: TrustPresentationState;
  presentationTone: TrustDecisionTone;
  anchoringState: TrustAnchoringState;
  anchoringStatusLabel: string;
  /** THE bounded summary (verificationMatrixSummary over these signals). */
  summary: string;
  /** What a reviewer must check themselves before relying on a signal. */
  reviewerAction: string;
  /** A file-integrity, record-signature or custody check FAILED. */
  integrityReviewRequired: boolean;
  signals: TrustSignal[];
};

function hasAnchoringPendingSignal(
  decision: {
    signals?: Array<Pick<TrustSignal, "key" | "status"> & { state?: TrustSignalState | null; summary?: string | null }> | null;
  }
): boolean {
  const anchoringSignal = decision.signals?.find(
    (signal) => signal.key === "bitcoin_anchoring"
  );
  return anchoringSignal ? resolveSnapshotSignalState(anchoringSignal) === "PENDING" : false;
}

function hasAnchoringFailedSignal(
  decision: {
    signals?: Array<Pick<TrustSignal, "key" | "status"> & { state?: TrustSignalState | null; summary?: string | null }> | null;
  }
): boolean {
  const anchoringSignal = decision.signals?.find(
    (signal) => signal.key === "bitcoin_anchoring"
  );
  return anchoringSignal ? resolveSnapshotSignalState(anchoringSignal) === "FAILED" : false;
}

export function getTrustDecisionPresentationTone(
  decision: {
    presentationTone?: TrustDecisionTone | null;
    tone?: TrustDecisionTone | null;
    signals?: Array<Pick<TrustSignal, "key" | "status"> & { state?: TrustSignalState | null; summary?: string | null }> | null;
  }
): TrustDecisionTone {
  if (decision.presentationTone) {
    return decision.presentationTone;
  }

  if (hasAnchoringPendingSignal(decision)) {
    return "warning";
  }

  if (hasAnchoringFailedSignal(decision)) {
    return "danger";
  }

  return decision.tone ?? "neutral";
}

/**
 * The badge for one signal, from its canonical state (a stored snapshot
 * without one is re-read by `resolveSnapshotSignalState`). "Verified" is
 * reserved for PASSED.
 */
export function getTrustSignalPresentationLabel(
  signal: Pick<TrustSignal, "status" | "tone"> & {
    state?: TrustSignalState | null;
    key?: string | null;
    summary?: string | null;
  }
): string {
  return TRUST_SIGNAL_STATE_PRESENTATION[resolveSnapshotSignalState(signal)].label;
}

const ANCHORING_STATE_LABELS: Readonly<Record<TrustAnchoringState, string>> = {
  verified: OTS_VERIFICATION_WORDS.CHAIN_VERIFIED,
  recorded: OTS_STATE_WORDS.ANCHORED,
  pending: OTS_STATE_WORDS.PENDING,
  failed: OTS_STATE_WORDS.FAILED,
  unavailable: OTS_STATE_WORDS.UNAVAILABLE,
  not_requested: OTS_STATE_WORDS.NOT_REQUESTED,
};

/**
 * The bounded summary of a decision's own signals (no identity, capture or
 * package rows — those come from the full matrix). Old stored snapshots are
 * read through the same function, so a historical score or verdict is never
 * restated.
 */
export function summarizeTrustSignals(
  signals: ReadonlyArray<Pick<TrustSignal, "key" | "status"> & { state?: TrustSignalState | null; summary?: string | null }>
): string {
  const rowKey: Partial<Record<string, VerificationMatrixKey>> = {
    core_integrity: "file_integrity",
    signature: "record_signature",
    custody_chain: "custody_chain",
    trusted_timestamp: "tsa_token",
    bitcoin_anchoring: "ots_anchoring",
    immutable_storage: "storage_protection",
  };
  const rows = signals.flatMap((signal) => {
    const key = rowKey[signal.key];
    return key
      ? [{ key, label: VERIFICATION_MATRIX_LABELS[key], status: toVerificationStatus(resolveSnapshotSignalState(signal)) }]
      : [];
  });
  return verificationMatrixSummary(rows);
}

export type TrustDecisionEvidenceInput = {
  verificationStatus?: string | null;
  recordedIntegrityVerifiedAtUtc?: string | null;
  fileSha256?: string | null;
  fingerprintHash?: string | null;
  signatureBase64?: string | null;
  signingKeyId?: string | null;
  publicKeyPem?: string | null;
  /**
   * The stored status. It is read through `presentedTsaStatus` here, so a
   * STAMPED row without `tsaValidatedAtUtc` is never a validated timestamp.
   */
  tsaStatus?: string | null;
  tsaFailureReason?: string | null;
  /** Bounded failure code (e.g. tsa_trust_anchor_not_configured). */
  tsaFailureCode?: string | null;
  /** True when the RFC 3161 token is kept on the record. */
  tsaTokenPresent?: boolean | null;
  tsaValidatedAtUtc?: string | null;
  /**
   * (2026-10-18) The validation was performed LATER, by the repair that
   * validated the token kept at intake (custody repair_source
   * "tsa_kept_token_validated"). The timeline stays truthful: intake marked the
   * timestamp FAILED, reports issued before the repair state it so.
   */
  tsaValidatedFromRetainedToken?: boolean | null;
  otsStatus?: string | null;
  otsHash?: string | null;
  otsAnchoredAtUtc?: string | null;
  otsUpgradedAtUtc?: string | null;
  /** The independent Bitcoin-chain check (evidence.ots_chain_*). Omitted = never checked. */
  otsChainVerificationStatus?: string | null;
  otsChainCheckedAtUtc?: string | Date | null;
  otsChainVerifiedAtUtc?: string | Date | null;
  otsChainBlockHeight?: number | null;
  otsChainBlockHash?: string | null;
  otsChainBlockTimeUtc?: string | Date | null;
  otsChainConfirmations?: number | null;
  otsChainVerifier?: string | null;
  otsChainFailureCode?: string | null;
  otsCalendar?: string | null;
  otsFailureReason?: string | null;
  /**
   * (2026-10-13) The stored proof bytes — REQUIRED: the anchoring signal is the
   * canonical state resolved from them (resolveOtsAnchoring). null = no proof.
   */
  otsProofBase64: string | null;
  /**
   * The result of verifying the Ed25519 signature over the recomputed
   * fingerprint IN THE EVALUATION that builds this decision. Omitted/null:
   * not checked here, and the signal never says "Verified".
   */
  signatureVerified?: boolean | null;
  /**
   * AUD-013 — THE validity state (resolveRecordSignatureValidity): a
   * mathematically valid signature made with a revoked or mismatched key is
   * never PASSED. When present it decides the signal; `signatureVerified` must
   * then equal its `presentlyTrusted`.
   */
  signatureValidity?: Pick<RecordSignatureValidity, "state" | "revokedAtUtc"> | null;
  /** The result of recomputing the custody hash chain; null when not run. */
  custodyChainValid?: boolean | null;
  storageImmutable?: boolean | null;
  storageObjectLockMode?: string | null;
  storageObjectLockRetainUntilUtc?: string | null;
  /**
   * AUD-014 — THE storage verification state
   * (resolveStorageProtectionVerification). Only STORAGE_CONFIRMED — a
   * successful authoritative read of the stored object — is PASSED. Absent:
   * the lock columns are read as a RECORDED snapshot, never as verified.
   */
  storageProtectionVerification?: StorageProtectionVerificationState | null;
  identityLevelSnapshot?: string | null;
  /**
   * AUD-016 — the canonical organization-verification fact
   * (`isOrganizationVerifiedAtCapture` over the capture-time snapshot). The
   * identity level alone never makes the identity signal PASSED.
   */
  organizationVerifiedAtCapture?: boolean | null;
  submittedByEmail?: string | null;
  submittedByAuthProvider?: string | null;
  verificationPackageVersion?: number | string | null;
  verificationPackageGeneratedAtUtc?: string | null;
  anchor?: {
    configured?: boolean | null;
    provider?: string | null;
    anchoredAtUtc?: string | null;
    transactionId?: string | null;
  } | null;
};

export type TrustDecisionCustodyEventInput = {
  eventType?: string | null;
  category?: CustodyEventCategory | null;
  eventHash?: string | null;
  prevEventHash?: string | null;
};

export type BuildEvidenceTrustDecisionInput = {
  evidence: TrustDecisionEvidenceInput;
  custodyEvents: TrustDecisionCustodyEventInput[];
  /**
   * True ONLY for Secure Intake Link evidence. Drives role-accurate identity
   * wording: intake evidence records the LINK CREATOR (workspace account) and
   * the remote contributor is not independently verified; authenticated
   * Capture / Web Upload / Mobile evidence is submitted by the authenticated
   * workspace user themselves. Defaults to false (authenticated capture).
   */
  isIntake?: boolean;
};

export type RecordedIntegrityPromotionInput = {
  /** Anchoring never decides the promotion; the OTS proof is not read here. */
  evidence: Omit<TrustDecisionEvidenceInput, "otsProofBase64"> & { otsProofBase64?: string | null };
  itemCount?: number | null;
  multipartItemHashesPresent?: boolean | null;
  canonicalHashMatches: boolean;
  signatureValid: boolean;
  custodyChainValid: boolean;
  forensicCustodyEventCount: number;
  forensicCustodyHasHashChain: boolean;
  timestampDigestMatches?: boolean | null;
  otsHashMatches?: boolean | null;
};

export type RecordedIntegrityPromotionDecision = {
  qualifies: boolean;
  alreadyExplicitlyVerified: boolean;
  shouldPromote: boolean;
  blockers: string[];
};

function safe(value: string | null | undefined, fallback = ""): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
}

function hasMeaningfulValue(value: string | null | undefined): boolean {
  const normalized = safe(value).toLowerCase();
  return Boolean(
    normalized &&
      normalized !== "n/a" &&
      normalized !== "not recorded" &&
      normalized !== "not reported" &&
      normalized !== "none" &&
      normalized !== "null" &&
      normalized !== "undefined"
  );
}

function toneForState(state: TrustSignalState): TrustDecisionTone {
  const tone = TRUST_SIGNAL_STATE_PRESENTATION[state].tone;
  return tone === "info" ? "neutral" : tone;
}


function makeSignal(params: {
  key: TrustSignalKey;
  label: string;
  state: TrustSignalState;
  measuredAtUtc?: string | null;
  summary: string;
  detail: string;
  // Optional presentation tone override. Used for the identity signal so
  // recorded (but not independently verified) contributor identity renders
  // as "Recorded" rather than "Verified".
  tone?: TrustDecisionTone;
  otsVerification?: OtsVerificationKey;
  qualifiers?: VerificationQualifier[];
}): TrustSignal {
  return {
    ...(params.otsVerification ? { otsVerification: params.otsVerification } : {}),
    ...(params.qualifiers && params.qualifiers.length > 0 ? { qualifiers: params.qualifiers } : {}),
    key: params.key,
    label: params.label,
    state: params.state,
    measuredAtUtc: params.measuredAtUtc ?? null,
    status: TRUST_SIGNAL_STATE_PRESENTATION[params.state].legacyStatus,
    tone: params.tone ?? toneForState(params.state),
    summary: params.summary,
    detail: params.detail,
  };
}

export function isExplicitRecordedIntegrityVerified(
  input: Pick<TrustDecisionEvidenceInput, "verificationStatus" | "recordedIntegrityVerifiedAtUtc">
): boolean {
  return (
    safe(input.verificationStatus).toUpperCase() ===
      "RECORDED_INTEGRITY_VERIFIED" ||
    safe(input.recordedIntegrityVerifiedAtUtc) !== ""
  );
}

export function hasCoreCryptoMaterials(
  input: Pick<TrustDecisionEvidenceInput, "fileSha256" | "fingerprintHash" | "signatureBase64" | "signingKeyId">
): boolean {
  return Boolean(
    hasMeaningfulValue(input.fileSha256) &&
      hasMeaningfulValue(input.fingerprintHash) &&
      hasMeaningfulValue(input.signatureBase64) &&
      hasMeaningfulValue(input.signingKeyId)
  );
}

export function evaluateRecordedIntegrityPromotion(
  input: RecordedIntegrityPromotionInput
): RecordedIntegrityPromotionDecision {
  const blockers: string[] = [];
  const evidence = input.evidence;
  const alreadyExplicitlyVerified = isExplicitRecordedIntegrityVerified(evidence);
  const itemCount = Number(input.itemCount ?? 0);
  const isMultipart = itemCount > 1;

  if (!hasCoreCryptoMaterials(evidence)) {
    blockers.push("core_crypto_material_missing");
  }

  if (isMultipart && input.multipartItemHashesPresent !== true) {
    blockers.push("multipart_item_hashes_incomplete");
  }

  if (!input.canonicalHashMatches) {
    blockers.push("canonical_hash_mismatch");
  }

  if (!input.signatureValid) {
    blockers.push("signature_validation_failed");
  }

  if (!input.custodyChainValid) {
    blockers.push("custody_chain_invalid");
  }

  if (input.forensicCustodyEventCount <= 0) {
    blockers.push("forensic_custody_missing");
  }

  if (!input.forensicCustodyHasHashChain) {
    blockers.push("forensic_hash_chain_missing");
  }

  if (input.timestampDigestMatches === false) {
    blockers.push("timestamp_digest_mismatch");
  }

  if (input.otsHashMatches === false) {
    blockers.push("ots_hash_mismatch");
  }

  const qualifies = blockers.length === 0;

  return {
    qualifies,
    alreadyExplicitlyVerified,
    shouldPromote: qualifies && !alreadyExplicitlyVerified,
    blockers,
  };
}

function buildCoreIntegritySignal(
  evidence: TrustDecisionEvidenceInput
): TrustSignal {
  const hasFileDigest = hasMeaningfulValue(evidence.fileSha256);
  const hasFingerprint = hasMeaningfulValue(evidence.fingerprintHash);
  const hasSignatureMaterial = hasCoreCryptoMaterials(evidence);
  const explicitVerified = isExplicitRecordedIntegrityVerified(evidence);

  if (explicitVerified && hasSignatureMaterial) {
    return makeSignal({
      key: "core_integrity",
      label: "Core integrity",
      state: "PASSED",
      measuredAtUtc: safe(evidence.recordedIntegrityVerifiedAtUtc) || null,
      summary: "Core integrity verified",
      detail:
        "Recorded digest, canonical fingerprint, signature material, and custody references are available and consistent for this evidence record.",
    });
  }

  if (hasFileDigest && hasFingerprint && hasSignatureMaterial) {
    return makeSignal({
      key: "core_integrity",
      label: "Core integrity",
      state: "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
      summary: "Integrity materials recorded",
      detail:
        "Recorded digest, canonical fingerprint, and signature material are present, but the recorded-integrity state has not yet been finalized as explicitly verified.",
    });
  }

  if (hasFileDigest || hasFingerprint) {
    return makeSignal({
      key: "core_integrity",
      label: "Core integrity",
      state: "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
      summary: "Partial integrity material",
      detail:
        "Some integrity material is present, but the core digest/fingerprint record is incomplete.",
    });
  }

  return makeSignal({
    key: "core_integrity",
    label: "Core integrity",
    state: "UNAVAILABLE",
    summary: "Integrity material missing",
    detail:
      "The record does not contain enough core digest or fingerprint material to support reliable integrity review.",
  });
}

function buildSignatureSignal(
  evidence: TrustDecisionEvidenceInput
): TrustSignal {
  const hasSignature = hasMeaningfulValue(evidence.signatureBase64);
  const hasKey = hasMeaningfulValue(evidence.signingKeyId);
  const hasPublicKey = hasMeaningfulValue(evidence.publicKeyPem);

  // AUD-013 — a revoked or mismatched key: reported, never presently trusted.
  const validity = evidence.signatureValidity ?? null;
  if (hasSignature && validity && (validity.state === "REVOKED_KEY" || validity.state === "KEY_MISMATCH" || validity.state === "KEY_NOT_REGISTERED")) {
    return makeSignal({
      key: "signature",
      label: "Digital signature",
      state: "FAILED",
      summary: recordSignatureValiditySummary(validity),
      detail:
        validity.state === "REVOKED_KEY"
          ? "The Ed25519 signature still verifies mathematically against the recomputed canonical fingerprint, but its signing key was revoked; it is not presented as a presently trusted signature."
          : "The signature cannot be attributed to the key this record was signed with, so it is not presented as valid.",
    });
  }

  if (hasSignature && evidence.signatureVerified === false) {
    return makeSignal({
      key: "signature",
      label: "Digital signature",
      state: "FAILED",
      summary: "Signature did not verify",
      detail:
        "The recorded Ed25519 signature did not verify against the recomputed canonical fingerprint with the recorded public key.",
    });
  }

  if (hasSignature && hasKey && hasPublicKey && evidence.signatureVerified === true) {
    return makeSignal({
      key: "signature",
      label: "Digital signature",
      state: "PASSED",
      summary: "Signature verified",
      detail:
        validity?.state === "VALID_SUPERSEDED_KEY"
          ? "The Ed25519 signature verified against the recomputed canonical fingerprint with the registered public key, a rotated (not revoked) key available for independent verification."
          : "The Ed25519 signature verified against the recomputed canonical fingerprint with the recorded public key, which is available for independent verification.",
    });
  }

  if (hasSignature && hasKey) {
    return makeSignal({
      key: "signature",
      label: "Digital signature",
      state: "NOT_CHECKED",
      summary: "Signature material recorded; not checked in this evaluation",
      detail: hasPublicKey
        ? "Signature material, signing-key reference, and public-key material are recorded for independent verification; this evaluation did not verify the signature."
        : "Signature material and signing-key reference are recorded. Public-key material should be checked through the verification package or technical endpoint.",
    });
  }

  if (hasSignature || hasKey) {
    return makeSignal({
      key: "signature",
      label: "Digital signature",
      state: "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
      summary: "Partial signature material",
      detail:
        "Some signature-related material is recorded, but the signing package is incomplete.",
    });
  }

  return makeSignal({
    key: "signature",
    label: "Digital signature",
    state: "FAILED",
    summary: "Signature missing",
    detail:
      "No complete digital-signature material was recorded for this evidence state.",
  });
}


/** The one wording of a timestamp validated later from the token kept at intake. */
export const TSA_RETAINED_TOKEN_VALIDATED_SUMMARY = "Verified — validated from the timestamp token retained at intake";
export const TSA_RETAINED_TOKEN_VALIDATED_DETAIL =
  "The RFC 3161 token was obtained at intake and kept; validation did not run then, so intake recorded the timestamp as not validated and reports issued before the validation state it that way. The kept token was later validated (signature, certificate chain and certified digest) without contacting the timestamp authority again.";

function buildTimestampSignal(
  evidence: TrustDecisionEvidenceInput
): TrustSignal {
  // Callers pass either the PRESENTED status (API, worker) or the raw column
  // together with its validation time; the raw form is presented here so a
  // STAMPED row without a validation time is never a validated timestamp.
  const presented =
    evidence.tsaValidatedAtUtc !== undefined
      ? presentedTsaStatus({ tsaStatus: evidence.tsaStatus, tsaValidatedAtUtc: evidence.tsaValidatedAtUtc })
      : evidence.tsaStatus;
  const tsa = resolveTsaTrustState({
    presentedStatus: presented,
    tokenPresent: evidence.tsaTokenPresent ?? null,
    failureCode: evidence.tsaFailureCode ?? null,
    validatedAtUtc: evidence.tsaValidatedAtUtc ?? null,
  });

  const detail: Readonly<Record<TrustSignalState, string>> = {
    PASSED:
      `An RFC 3161 timestamp token is recorded and was validated (signature, signer certificate chain to the configured trust anchor, signer validity at the stamped time, and the certified digest). It supports review of when the preserved integrity state existed. ${TSA_VALIDATED_QUALIFICATION_STATEMENT}`,
    PRESENT_NOT_INDEPENDENTLY_VERIFIED:
      "An RFC 3161 timestamp token was obtained and kept, but it has not been validated. It is not relied on as a trusted timestamp until it is validated.",
    NOT_CHECKED:
      "An RFC 3161 timestamp token is recorded; it was not validated in this evaluation.",
    PENDING:
      "The trusted timestamp was not finalized for this evidence state. The record can still be reviewed using digest, signature, custody, and storage materials.",
    STALE: "The recorded timestamp state is too old to describe the present.",
    UNAVAILABLE:
      tsa.label === "Timestamp not recorded"
        ? "No RFC 3161 timestamp state was included. The evidence may still have other integrity controls, but timestamp reliance is limited."
        : "A trusted timestamp was not obtained for this evidence state. Reviewers should rely on the recorded digest, signature, custody history, and other verification materials.",
    FAILED:
      "An RFC 3161 timestamp token was obtained, and validating it failed. It must not be relied on as a trusted timestamp.",
    NOT_APPLICABLE: "",
  };

  // (2026-10-18) A token validated later from the copy retained at intake: the
  // same VERIFIED state, stated with how and when it was validated.
  if (tsa.state === "PASSED" && evidence.tsaValidatedFromRetainedToken) {
    return makeSignal({
      key: "trusted_timestamp",
      label: "Trusted timestamp",
      state: tsa.state,
      measuredAtUtc: tsa.measuredAtUtc,
      summary: TSA_RETAINED_TOKEN_VALIDATED_SUMMARY,
      detail: `${TSA_RETAINED_TOKEN_VALIDATED_DETAIL} ${TSA_VALIDATED_QUALIFICATION_STATEMENT}`,
      qualifiers: ["VALIDATED_FROM_RETAINED_TOKEN"],
    });
  }
  return makeSignal({
    key: "trusted_timestamp",
    label: "Trusted timestamp",
    state: tsa.state,
    measuredAtUtc: tsa.measuredAtUtc,
    summary: tsa.label,
    detail: detail[tsa.state],
    qualifiers: tsa.state === "PRESENT_NOT_INDEPENDENTLY_VERIFIED" ? ["TOKEN_KEPT_NOT_VALIDATED"] : [],
  });
}


function buildAnchoringSignal(
  evidence: TrustDecisionEvidenceInput
): TrustSignal {
  // THE CANONICAL OTS STATE: a stored proof that executes from the record's
  // digest to a Bitcoin block attestation is ANCHORED — an attestation the
  // proof NAMES. Only the independent chain fact bound to that proof makes the
  // signal PASSED. Nothing else (a txid, a time, a status string) decides it.
  const ots = resolveOtsTrustState({
    status: evidence.otsStatus,
    proofBase64: evidence.otsProofBase64,
    fingerprintHash: evidence.fingerprintHash ?? null,
    otsHash: evidence.otsHash ?? null,
    failureReason: evidence.otsFailureReason ?? null,
    calendar: evidence.otsCalendar ?? null,
    anchoredAtUtc: evidence.otsAnchoredAtUtc ?? null,
    upgradedAtUtc: evidence.otsUpgradedAtUtc ?? null,
    chain: otsChainRecordOf(evidence),
  });
  return anchoringSignalOf(ots);
}

function anchoringSignalOf(ots: ReturnType<typeof otsTrustStateOf>): TrustSignal {
  return makeSignal({
    key: "bitcoin_anchoring",
    label: "Bitcoin anchoring",
    state: ots.state,
    measuredAtUtc: ots.measuredAtUtc,
    summary: OTS_VERIFICATION_WORDS[ots.otsVerification],
    detail: ots.label,
    otsVerification: ots.otsVerification,
    qualifiers: otsQualifiersOf(ots.otsVerification),
  });
}

/**
 * THE DECISION WITH THE ANCHORING OF THE PROOF ACTUALLY SHIPPED (2026-10-13).
 *
 * A verification package carries the record's OpenTimestamps proof and states
 * its state in the manifest, anchor.json and opentimestamps.json — resolved
 * once, from those bytes, against the package's fingerprint digest. Its
 * verification matrix used to take the anchoring row from the decision STORED
 * WITH THE REPORT instead. For a report issued before the canonical OTS state
 * existed that snapshot reads a legacy anchoring `passed` conservatively as
 * UNAVAILABLE (resolveSnapshotSignalState), so a package for that report said
 * ANCHORED in its manifest and UNAVAILABLE in its matrix, and the consistency
 * gate refused every attempt (production, 2026-10-13). A package for a report
 * that stated PENDING before the proof anchored had the same contradiction.
 *
 * Every other signal keeps the report's words. Only the anchoring signal is
 * replaced, by the one resolution the package ships, and the presentation is
 * derived again from the signal states. Nothing is promoted: a proof that does
 * not execute to a Bitcoin attestation resolves PENDING, FAILED or UNAVAILABLE
 * here exactly as it does on every other surface.
 */
export function withShippedAnchoring(
  decision: TrustDecision,
  ots: Pick<OtsAnchoring, "state" | "anchoredAtUtc">,
): TrustDecision {
  const anchoring = anchoringSignalOf(otsTrustStateOf(ots));
  const signals = decision.signals.some((s) => s.key === "bitcoin_anchoring")
    ? decision.signals.map((s) => (s.key === "bitcoin_anchoring" ? anchoring : s))
    : [...decision.signals, anchoring];
  return { ...decision, ...deriveTrustPresentation(signals), signals };
}

function buildStorageSignal(
  evidence: TrustDecisionEvidenceInput
): TrustSignal {
  // AUD-014 — THE canonical storage verification state. A caller that did
  // not resolve it hands only the lock columns: a RECORDED snapshot.
  const state =
    evidence.storageProtectionVerification ??
    resolveStorageProtectionVerification({
      mode: evidence.storageObjectLockMode ?? null,
      retainUntil: evidence.storageObjectLockRetainUntilUtc ?? null,
      source: "RECORDED",
    }).state;
  const label = STORAGE_PROTECTION_VERIFICATION_LABELS[state];
  const signal = (s: TrustSignalState, detail: string) =>
    makeSignal({ key: "immutable_storage", label: "Immutable storage", state: s, summary: label, detail });

  switch (state) {
    case "STORAGE_CONFIRMED":
      return signal(
        "PASSED",
        "A read of the stored object confirmed Object Lock COMPLIANCE retention with a retain-until date in the future.",
      );
    case "RECORDED":
      return signal(
        "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
        "Object Lock COMPLIANCE retention was recorded when the record was sealed; the stored object was not read in this evaluation.",
      );
    case "CONFIGURED":
      return signal(
        "NOT_CHECKED",
        "COMPLIANCE Object Lock is configured for the platform, but no lock was recorded or observed for this record's stored object.",
      );
    case "FAILED":
      return signal(
        "FAILED",
        "The recorded or observed lock does not provide Object Lock COMPLIANCE retention in force.",
      );
    case "NOT_APPLICABLE":
      return signal("NOT_APPLICABLE", "There is no stored object for this record.");
    default:
      return signal(
        "UNAVAILABLE",
        "The stored object's Object Lock retention could not be confirmed.",
      );
  }
}

function buildCustodySignal(
  custodyEvents: TrustDecisionCustodyEventInput[],
  custodyChainValid: boolean | null | undefined
): TrustSignal {
  const forensicEvents = custodyEvents.filter(
    (event) =>
      (event.category ?? classifyCustodyEventType(event.eventType)) ===
      "forensic"
  );
  const hasHashChain = forensicEvents.some(
    (event) =>
      hasMeaningfulValue(event.eventHash) || hasMeaningfulValue(event.prevEventHash)
  );

  if (custodyChainValid === false) {
    return makeSignal({
      key: "custody_chain",
      label: "Custody chain",
      state: "FAILED",
      summary: "Custody chain did not verify",
      detail:
        "Recomputing the custody hash chain did not reproduce the recorded event hashes.",
    });
  }

  if (forensicEvents.length >= 5 && hasHashChain) {
    const checked = custodyChainValid === true;
    return makeSignal({
      key: "custody_chain",
      label: "Custody chain",
      state: checked ? "PASSED" : "NOT_CHECKED",
      summary: checked
        ? `${forensicEvents.length} forensic events recorded; hash chain verified`
        : `${forensicEvents.length} forensic events recorded; hash chain not checked in this evaluation`,
      detail: checked
        ? "A forensic custody chronology is recorded and its hash chain was recomputed and matched."
        : "A forensic custody chronology and custody hash-chain references are recorded for reviewer inspection; this evaluation did not recompute the chain.",
    });
  }

  if (forensicEvents.length > 0) {
    return makeSignal({
      key: "custody_chain",
      label: "Custody chain",
      state: "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
      summary: `${forensicEvents.length} forensic events recorded`,
      detail:
        "Forensic custody events are recorded, but the custody-chain material is limited or incomplete.",
    });
  }

  return makeSignal({
    key: "custody_chain",
    label: "Custody chain",
    state: "UNAVAILABLE",
    summary: "No forensic custody events",
    detail:
      "No forensic custody chronology was included in the record payload.",
  });
}

/** How the submitting account signed in, in words (never the raw enum). */
export function describeAccountSignInMethod(provider: string | null | undefined): string | null {
  switch (safe(provider).toUpperCase()) {
    case "GOOGLE":
      return "a Google sign-in";
    case "APPLE":
      return "an Apple sign-in";
    case "EMAIL":
      return "an email-and-password account";
    case "GUEST":
      return "a guest session";
    default:
      return null;
  }
}

function buildIdentitySignal(
  evidence: TrustDecisionEvidenceInput,
  // True ONLY for Secure Intake evidence. Intake records the LINK CREATOR
  // (workspace account) while the remote contributor is not independently
  // verified. Authenticated Capture / Web Upload / Mobile evidence is submitted
  // by the authenticated workspace user themselves, so it must never read the
  // "link creator / remote contributor not independently verified" wording.
  isIntake = false
): TrustSignal {
  const level = safe(evidence.identityLevelSnapshot).toUpperCase();
  const hasEmail = hasMeaningfulValue(evidence.submittedByEmail);
  const hasProvider = hasMeaningfulValue(evidence.submittedByAuthProvider);
  const signIn = describeAccountSignInMethod(evidence.submittedByAuthProvider);

  // Intake tail: identifies the remote-contributor boundary.
  const intakeContributorTail =
    " Remote contributor identity was not independently verified.";
  // Capture tail: names the sign-in method the account actually uses.
  const captureSubmitterTail = signIn
    ? ` Submitted by the authenticated workspace user through ${signIn}. PROOVRA did not establish the person's real-world identity.`
    : " Submitted by the authenticated workspace user. PROOVRA did not establish the person's real-world identity.";
  const tail = isIntake ? intakeContributorTail : captureSubmitterTail;
  // "link creator" only applies to intake; capture uses "workspace user".
  const recordedParty = isIntake
    ? "Workspace or link creator"
    : "Authenticated workspace user";
  const recordedSummary = isIntake
    ? "Workspace/link creator identity recorded"
    : "Authenticated workspace user identity recorded";

  if (evidence.organizationVerifiedAtCapture === true) {
    return makeSignal({
      key: "identity",
      label: "Workspace identity",
      state: "PASSED",
      tone: "neutral",
      summary: "Organization verification recorded at capture",
      detail:
        `The workspace was associated with a verified organization when the record was captured.${tail}`,
    });
  }

  // AUD-016 — a VERIFIED_ORGANIZATION level without the capture-time
  // verification fact (legacy rows) is workspace membership, nothing more.
  if (level === "VERIFIED_ORGANIZATION" || level === "ORGANIZATION_ACCOUNT" || level === "OAUTH_BACKED_IDENTITY") {
    return makeSignal({
      key: "identity",
      label: "Workspace identity",
      state: "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
      tone: "neutral",
      summary: recordedSummary,
      detail: `${recordedParty} identity was recorded for reviewer context.${tail}`,
    });
  }

  if (level === "VERIFIED_EMAIL" || level === "BASIC_ACCOUNT" || hasEmail || hasProvider) {
    return makeSignal({
      key: "identity",
      label: "Workspace identity",
      state: "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
      tone: "neutral",
      summary: recordedSummary,
      detail: `${recordedParty} identity information is recorded.${tail}`,
    });
  }

  return makeSignal({
    key: "identity",
    label: "Workspace identity",
    state: "UNAVAILABLE",
    summary: "Identity not recorded",
    detail: isIntake
      ? "No meaningful workspace or link creator identity context was recorded."
      : "No meaningful authenticated workspace user identity context was recorded.",
  });
}

/**
 * THE VERIFICATION-PACKAGE SIGNAL — INFORMATIONAL (P3-4, 2026-09-10).
 *
 * Whether a package exists is a commercial fact (the plan and the record's
 * funding decide it), and every proof inside a package is a signal of its own
 * in this list. So the signal says truthfully whether a package exists and is
 * NOT_APPLICABLE in both the present and absent-with-materials cases: neither
 * a passed check nor a degradation of the evidence. The genuinely bare case —
 * no package AND no core cryptographic material — is UNAVAILABLE.
 */
function buildVerificationPackageSignal(
  evidence: TrustDecisionEvidenceInput
): TrustSignal {
  if (
    evidence.verificationPackageVersion != null ||
    hasMeaningfulValue(evidence.verificationPackageGeneratedAtUtc)
  ) {
    return makeSignal({
      key: "verification_package",
      label: "Verification package",
      state: "NOT_APPLICABLE",
      summary: "Verification package recorded",
      detail:
        "A verification package is recorded, bundling this record's integrity materials for offline review. It does not add to the integrity assessment above — the proofs it contains are each assessed on their own.",
    });
  }

  if (hasCoreCryptoMaterials(evidence)) {
    return makeSignal({
      key: "verification_package",
      label: "Verification package",
      state: "NOT_APPLICABLE",
      summary: "Not included for this record",
      detail:
        "No downloadable verification package is included for this record. This does not affect its integrity: the fingerprint, signature, timestamp, anchoring and custody materials are recorded and are assessed individually above, and they can be checked from this page.",
    });
  }

  return makeSignal({
    key: "verification_package",
    label: "Verification package",
    state: "UNAVAILABLE",
    summary: "No integrity materials recorded",
    detail:
      "Neither a verification package nor core cryptographic materials were recorded for this record.",
  });
}

export function buildEvidenceTrustDecision(
  input: BuildEvidenceTrustDecisionInput
): TrustDecision {
  const core = buildCoreIntegritySignal(input.evidence);
  const signature = buildSignatureSignal(input.evidence);
  const timestamp = buildTimestampSignal(input.evidence);
  const anchoring = buildAnchoringSignal(input.evidence);
  const storage = buildStorageSignal(input.evidence);
  const custody = buildCustodySignal(input.custodyEvents, input.evidence.custodyChainValid);
  const identity = buildIdentitySignal(input.evidence, input.isIntake === true);
  const verificationPackage = buildVerificationPackageSignal(input.evidence);

  const signals = [
    core,
    signature,
    timestamp,
    anchoring,
    storage,
    custody,
    identity,
    verificationPackage,
  ];

  return { ...deriveTrustPresentation(signals), signals };
}

/**
 * Everything a decision derives from its signals — the internal presentation
 * bucket, the anchoring wording, the reviewer action and the bounded summary.
 * ONE derivation for a freshly built decision and for a stored snapshot read
 * back (readStoredTrustDecision), so a surface never shows an old score,
 * verdict or reliance level, and never says more than the signals.
 */
export function deriveTrustPresentation(
  signals: ReadonlyArray<Pick<TrustSignal, "key" | "state" | "summary">>
): Omit<TrustDecision, "signals"> {
  const stateOf = (key: TrustSignalKey): TrustSignalState =>
    signals.find((signal) => signal.key === key)?.state ?? "UNAVAILABLE";
  const core = { state: stateOf("core_integrity") };
  const signature = { state: stateOf("signature") };
  const custody = { state: stateOf("custody_chain") };
  const timestamp = { state: stateOf("trusted_timestamp") };
  const anchoring = { state: stateOf("bitcoin_anchoring") };

  const criticalFailed =
    core.state === "FAILED" ||
    signature.state === "FAILED" ||
    custody.state === "FAILED";

  const corePassed = core.state === "PASSED";
  const anchoringState: TrustAnchoringState =
    anchoring.state === "PASSED"
      ? "verified"
      : anchoring.state === "PRESENT_NOT_INDEPENDENTLY_VERIFIED"
        ? "recorded"
      : anchoring.state === "PENDING"
        ? "pending"
        : anchoring.state === "FAILED"
          ? "failed"
          : anchoring.state === "NOT_APPLICABLE"
            ? "not_requested"
            : "unavailable";
  // Every time-and-anchoring layer PASSED its own check: an unvalidated token
  // never puts a record in the finalized bucket.
  // Only an INDEPENDENTLY VERIFIED Bitcoin anchor (chain-checked) finalizes.
  const finalizable = anchoringState === "verified" && timestamp.state === "PASSED";

  // Internal presentation bucket — decided by the states themselves, never by
  // a weighted total. It picks a tone; it is not a conclusion and not shown.
  let presentationState: TrustPresentationState;
  let tone: TrustDecisionTone;
  if (criticalFailed) {
    presentationState = "FAILED_VERIFICATION";
    tone = "danger";
  } else if (!corePassed) {
    presentationState = core.state === "UNAVAILABLE" ? "REVIEW_REQUIRED" : "PARTIALLY_VERIFIED";
    tone = "warning";
  } else if (finalizable) {
    presentationState = "VERIFIED_FINALIZED";
    tone = "success";
  } else if (anchoringState === "pending") {
    presentationState = "VERIFIED_PENDING_ANCHORING";
    tone = "warning";
  } else {
    presentationState = "VERIFIED_WITH_DEGRADED_SIGNALS";
    tone = "warning";
  }

  const reviewerAction = criticalFailed
    ? "Do not rely on the preserved bytes until the failed file-integrity, record-signature or custody check is reviewed."
    : timestamp.state !== "PASSED"
      ? "The RFC 3161 timestamp is not validated; do not rely on it as a trusted timestamp."
      : "Check each signal's status and the technical appendix before relying on this record for a specific purpose.";

  return {
    tone,
    presentationState,
    presentationTone: tone,
    anchoringState,
    anchoringStatusLabel: ANCHORING_STATE_LABELS[anchoringState],
    summary: summarizeTrustSignals(signals as TrustSignal[]),
    reviewerAction,
    integrityReviewRequired: criticalFailed,
  };
}

/**
 * A decision read back from a stored report or package snapshot, in today's
 * shape. Snapshots written before 2026-10-08 carry a score, weighted points, a
 * verdict, a reliance level and "Passed signals" tallies: none of it survives.
 * Each signal keeps its words and is given its canonical state, re-read
 * conservatively (a legacy anchoring pass is never verified), and everything
 * else is derived again from those states.
 */
export function readStoredTrustDecision(value: unknown): TrustDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as { signals?: unknown };
  if (!Array.isArray(raw.signals)) return null;
  const signals: TrustSignal[] = [];
  for (const item of raw.signals) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.key !== "string") continue;
    const state = resolveSnapshotSignalState({
      key: o.key,
      state: o.state,
      status: typeof o.status === "string" ? o.status : null,
      summary: typeof o.summary === "string" ? o.summary : null,
      otsVerification: o.otsVerification,
    });
    const otsVerification = o.key === "bitcoin_anchoring" ? otsVerificationOfSignalState(state, o.otsVerification) : null;
    signals.push({
      ...(otsVerification ? { otsVerification } : {}),
      key: o.key as TrustSignalKey,
      label: typeof o.label === "string" ? o.label : o.key,
      state,
      measuredAtUtc: typeof o.measuredAtUtc === "string" ? o.measuredAtUtc : null,
      status: TRUST_SIGNAL_STATE_PRESENTATION[state].legacyStatus,
      tone: toneForState(state),
      summary: typeof o.summary === "string" ? o.summary : "",
      detail: typeof o.detail === "string" ? o.detail : "",
    });
  }
  if (signals.length === 0) return null;
  return { ...deriveTrustPresentation(signals), signals };
}



/**
 * THE compact wording of one layer in one state (report cover, web and native
 * badges). A layer/state pair without a specific phrase reads the state's own
 * label; nothing here may say more than the state.
 */
const TRUST_LAYER_STATE_LABELS: Readonly<
  Partial<Record<TrustSignalKey, Partial<Record<TrustSignalState, string>>>>
> = {
  core_integrity: {
    PASSED: "Verified",
    PRESENT_NOT_INDEPENDENTLY_VERIFIED: "Recorded, not finalized",
    FAILED: "Failed",
    UNAVAILABLE: "Not recorded",
  },
  signature: {
    PASSED: "Verified",
    NOT_CHECKED: "Recorded, not checked",
    PRESENT_NOT_INDEPENDENTLY_VERIFIED: "Incomplete",
    FAILED: "Signature failed",
  },
  trusted_timestamp: {
    PASSED: "Validated",
    PRESENT_NOT_INDEPENDENTLY_VERIFIED: "Token recorded, not validated",
    PENDING: "Pending",
    FAILED: "Validation failed",
    UNAVAILABLE: "Not obtained",
  },
  // The customer-facing OTS vocabulary (ots-anchoring OTS_VERIFICATION_WORDS).
  bitcoin_anchoring: {
    PASSED: OTS_VERIFICATION_WORDS.CHAIN_VERIFIED,
    PRESENT_NOT_INDEPENDENTLY_VERIFIED: OTS_STATE_WORDS.ANCHORED,
    PENDING: OTS_STATE_WORDS.PENDING,
    STALE: OTS_STATE_WORDS.UNAVAILABLE,
    FAILED: OTS_STATE_WORDS.FAILED,
    UNAVAILABLE: OTS_STATE_WORDS.UNAVAILABLE,
    NOT_APPLICABLE: OTS_STATE_WORDS.NOT_REQUESTED,
  },
  immutable_storage: {
    PASSED: "Storage protected",
    PRESENT_NOT_INDEPENDENTLY_VERIFIED: "Protection partial",
    FAILED: "Requires review",
    UNAVAILABLE: "Protection not recorded",
  },
  custody_chain: {
    PASSED: "Chain verified",
    NOT_CHECKED: "Recorded, not checked",
    PRESENT_NOT_INDEPENDENTLY_VERIFIED: "Limited",
    FAILED: "Chain broken",
  },
  identity: {
    PASSED: "Organization verified",
    PRESENT_NOT_INDEPENDENTLY_VERIFIED: "Account recorded",
    UNAVAILABLE: "Not recorded",
  },
  verification_package: {
    NOT_APPLICABLE: "Informational",
  },
};

export function getTrustLayerStateLabel(
  signal: Pick<TrustSignal, "key" | "status"> & { state?: TrustSignalState | null; summary?: string | null }
): string {
  const state = resolveSnapshotSignalState(signal);
  return TRUST_LAYER_STATE_LABELS[signal.key]?.[state] ?? TRUST_SIGNAL_STATE_PRESENTATION[state].label;
}

/** The three-tone reading of a state for surfaces without an "info" tone. */
export function getTrustSignalStateTone(
  signal: Pick<TrustSignal, "key" | "status"> & { state?: TrustSignalState | null; summary?: string | null }
): "success" | "warning" | "danger" {
  const tone = TRUST_SIGNAL_STATE_PRESENTATION[resolveSnapshotSignalState(signal)].tone;
  return tone === "success" ? "success" : tone === "danger" ? "danger" : "warning";
}
