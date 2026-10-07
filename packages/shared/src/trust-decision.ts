import {
  classifyCustodyEventType,
  type CustodyEventCategory,
} from "./custody.js";
import { normalizeOtsAnchorCheck } from "./ots.js";
import { presentedTsaStatus } from "./tsa-validation-state.js";
import {
  TRUST_SIGNAL_STATE_PRESENTATION,
  resolveOtsTrustState,
  resolveSnapshotSignalState,
  resolveTsaTrustState,
  type TrustSignalState,
} from "./trust-signal-state.js";

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

export type TrustDecisionVerdict =
  | "STRONGLY_VERIFIED"
  | "VERIFIED"
  | "PARTIALLY_VERIFIED"
  | "REVIEW_REQUIRED";

export type TrustPresentationState =
  | "VERIFIED_FINALIZED"
  | "VERIFIED_PENDING_ANCHORING"
  | "VERIFIED_WITH_DEGRADED_SIGNALS"
  | "PARTIALLY_VERIFIED"
  | "FAILED_VERIFICATION"
  | "REVIEW_REQUIRED";

export type TrustAnchoringState =
  | "finalized"
  | "present_not_verified"
  | "stale"
  | "pending"
  | "degraded"
  | "unavailable"
  | "failed";

export type TrustSignalKey =
  | "core_integrity"
  | "signature"
  | "trusted_timestamp"
  | "bitcoin_anchoring"
  | "immutable_storage"
  | "custody_chain"
  | "identity"
  | "verification_package";

export type TrustSignal = {
  key: TrustSignalKey;
  label: string;
  /** THE canonical state. `status` is its legacy projection. */
  state: TrustSignalState;
  /** When the check behind this state was measured, where recorded. */
  measuredAtUtc: string | null;
  status: TrustSignalStatus;
  tone: TrustDecisionTone;
  points: number;
  maxPoints: number;
  summary: string;
  detail: string;
};

export type TrustDecision = {
  verdict: TrustDecisionVerdict;
  level: "strong" | "standard" | "partial" | "review";
  tone: TrustDecisionTone;
  presentationState: TrustPresentationState;
  presentationTone: TrustDecisionTone;
  anchoringState: TrustAnchoringState;
  score: number;
  maxScore: 100;
  scoreLabel: string;
  verdictLabel: string;
  shortLabel: string;
  title: string;
  confidenceLabel: string;
  anchoringStatusLabel: string;
  summary: string;
  primaryReason: string;
  reviewerAction: string;
  degradedButUsable: boolean;
  relianceLevel: "high" | "medium" | "limited" | "low";
  signals: TrustSignal[];
  passedSignals: number;
  degradedSignals: number;
  failedSignals: number;
};

export type ReviewerPackageTrustSignal = Pick<
  TrustSignal,
  "key" | "label" | "state" | "status" | "tone" | "summary" | "measuredAtUtc"
>;

export type ReviewerPackageTrustDecision = {
  verdict: TrustDecisionVerdict;
  verdictLabel: string;
  relianceLevel: TrustDecision["relianceLevel"];
  relianceLabel: string;
  narrative: string;
  reviewerAction: string;
  legalBoundary: string;
  signals: ReviewerPackageTrustSignal[];
  internalDebug?: {
    score: number;
    maxScore: number;
    scoreLabel: string;
    passedSignals: number;
    degradedSignals: number;
    failedSignals: number;
    signals: Array<
      ReviewerPackageTrustSignal & {
        points: number;
        maxPoints: number;
      }
    >;
  };
};

export function getTrustDecisionLabel(
  decision: Pick<TrustDecision, "verdictLabel">
): string {
  return decision.verdictLabel;
}

export function getReviewerRelianceLabel(
  relianceLevel: TrustDecision["relianceLevel"]
): string {
  switch (relianceLevel) {
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "limited":
      return "Limited";
    case "low":
    default:
      return "Low";
  }
}

function hasAnchoringPendingSignal(
  decision:
    | Pick<TrustDecision, "signals">
    | {
        signals?: Array<Pick<TrustSignal, "key" | "status">> | null;
      }
): boolean {
  const anchoringSignal = decision.signals?.find(
    (signal) => signal.key === "bitcoin_anchoring"
  );
  return anchoringSignal ? resolveSnapshotSignalState(anchoringSignal) === "PENDING" : false;
}

function hasAnchoringPresentNotVerifiedSignal(
  decision: { signals?: Array<Pick<TrustSignal, "key" | "status"> & { state?: TrustSignalState | null; summary?: string | null }> | null }
): boolean {
  const anchoringSignal = decision.signals?.find(
    (signal) => signal.key === "bitcoin_anchoring"
  );
  return anchoringSignal
    ? resolveSnapshotSignalState(anchoringSignal) === "PRESENT_NOT_INDEPENDENTLY_VERIFIED"
    : false;
}

function hasAnchoringFailedSignal(
  decision:
    | Pick<TrustDecision, "signals">
    | {
        signals?: Array<Pick<TrustSignal, "key" | "status">> | null;
      }
): boolean {
  const anchoringSignal = decision.signals?.find(
    (signal) => signal.key === "bitcoin_anchoring"
  );

  return anchoringSignal?.status === "failed";
}

export function getTrustDecisionPresentationTone(
  decision:
    | Pick<
        TrustDecision,
        "presentationTone" | "tone" | "signals"
      >
    | {
        presentationTone?: TrustDecisionTone | null;
        tone?: TrustDecisionTone | null;
        signals?: Array<Pick<TrustSignal, "key" | "status">> | null;
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

export function getTrustDecisionConfidenceLabel(
  decision:
    | Pick<
        TrustDecision,
        | "confidenceLabel"
        | "relianceLevel"
        | "presentationState"
        | "signals"
        | "failedSignals"
      >
    | {
        confidenceLabel?: string | null;
        relianceLevel?: TrustDecision["relianceLevel"] | null;
        presentationState?: TrustPresentationState | null;
        signals?: Array<Pick<TrustSignal, "key" | "status">> | null;
        failedSignals?: number | null;
      }
): string {
  if (decision.confidenceLabel) {
    return decision.confidenceLabel;
  }

  if (
    decision.presentationState === "VERIFIED_PENDING_ANCHORING" ||
    hasAnchoringPendingSignal(decision)
  ) {
    return "High (Bitcoin anchoring pending)";
  }

  if (decision.presentationState === "VERIFIED_WITH_DEGRADED_SIGNALS") {
    return "Conditional";
  }

  if (
    decision.presentationState === "FAILED_VERIFICATION" ||
    (typeof decision.failedSignals === "number" && decision.failedSignals > 0)
  ) {
    return "Low";
  }

  return getReviewerRelianceLabel(decision.relianceLevel ?? "limited");
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

function getAnchoringStateLabel(state: TrustAnchoringState): string {
  switch (state) {
    case "finalized":
      return "Anchored in Bitcoin; verified against the Bitcoin chain";
    case "present_not_verified":
      return "Anchoring proof present; not independently chain-verified";
    case "stale":
      return "Anchoring state unknown (pending longer than expected)";
    case "pending":
      return "Bitcoin anchoring pending";
    case "degraded":
      return "Bitcoin anchoring recorded with limitations";
    case "failed":
      return "OpenTimestamps anchoring failed";
    case "unavailable":
    default:
      return "Anchoring not recorded";
  }
}

export function getTrustNarrative(
  decision: Pick<
    TrustDecision,
    | "verdictLabel"
    | "presentationState"
    | "relianceLevel"
    | "degradedButUsable"
    | "failedSignals"
    | "signals"
  >
): string {
  if (
    decision.presentationState === "VERIFIED_FINALIZED" ||
    decision.verdictLabel === "Verified" ||
    decision.verdictLabel === "Recorded integrity verified"
  ) {
    return "Recorded integrity is verified across the returned cryptographic, custody, storage, timestamp, and anchoring materials. This remains a technical integrity conclusion, not proof of factual truth, authorship, legal admissibility, or original device capture authenticity.";
  }

  if (
    (decision.presentationState === "VERIFIED_WITH_DEGRADED_SIGNALS" ||
      decision.presentationState === "VERIFIED_PENDING_ANCHORING") &&
    hasAnchoringPresentNotVerifiedSignal(decision)
  ) {
    return "Recorded integrity is verified. An OpenTimestamps proof with a Bitcoin attestation is present, but it has not been independently checked against the Bitcoin chain, so Bitcoin anchoring is not claimed as verified. Verify the proof against the Bitcoin chain if independent anchoring is required.";
  }

  if (
    decision.presentationState === "VERIFIED_PENDING_ANCHORING" ||
    hasAnchoringPendingSignal(decision)
  ) {
    return "Recorded integrity is verified, but Bitcoin anchoring has not finalized yet. An OpenTimestamps proof is recorded. Reviewers should treat the record as conditionally reliable for integrity review and recheck anchoring later if independent Bitcoin anchoring is required.";
  }

  if (decision.presentationState === "VERIFIED_WITH_DEGRADED_SIGNALS") {
    return "Recorded integrity is verified, but one or more supporting verification signals remain pending, partial, unavailable, or otherwise degraded. Review the affected technical layers before higher-reliance use.";
  }

  if (
    decision.verdictLabel === "Verified with limitations" ||
    decision.verdictLabel === "Recorded integrity verified with limitations"
  ) {
    return "Recorded integrity is verified with limitations. Core integrity materials are recorded, but one or more supporting verification layers still require follow-up.";
  }

  if (decision.verdictLabel === "Insufficient verification") {
    return "Integrity concerns were detected across one or more critical verification layers.";
  }

  return "Recorded verification materials require reviewer follow-up before higher-reliance use.";
}

export const TRUST_DECISION_LEGAL_BOUNDARY =
  "This trust decision summarizes the recorded integrity state of the evidence record. It does not independently prove factual truth, authorship, legal admissibility, intent, or completed Bitcoin anchoring unless those anchoring materials are separately verified.";

export function serializeTrustDecisionForReviewerPackage(
  decision: TrustDecision,
  options?: { includeInternalDebug?: boolean }
): ReviewerPackageTrustDecision {
  const base: ReviewerPackageTrustDecision = {
    verdict: decision.verdict,
    verdictLabel: decision.verdictLabel,
    relianceLevel: decision.relianceLevel,
    relianceLabel: getTrustDecisionConfidenceLabel(decision),
    narrative: getTrustNarrative(decision),
    reviewerAction: decision.reviewerAction,
    legalBoundary: TRUST_DECISION_LEGAL_BOUNDARY,
    signals: decision.signals.map((signal) => ({
      key: signal.key,
      label: signal.label,
      state: signal.state,
      status: signal.status,
      tone: signal.tone,
      summary: signal.summary,
      measuredAtUtc: signal.measuredAtUtc,
    })),
  };

  if (options?.includeInternalDebug) {
    base.internalDebug = {
      score: decision.score,
      maxScore: decision.maxScore,
      scoreLabel: decision.scoreLabel,
      passedSignals: decision.passedSignals,
      degradedSignals: decision.degradedSignals,
      failedSignals: decision.failedSignals,
      signals: decision.signals.map((signal) => ({
        key: signal.key,
        label: signal.label,
        state: signal.state,
        status: signal.status,
        tone: signal.tone,
        summary: signal.summary,
        measuredAtUtc: signal.measuredAtUtc,
        points: signal.points,
        maxPoints: signal.maxPoints,
      })),
    };
  }

  return base;
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
  otsStatus?: string | null;
  otsHash?: string | null;
  otsBitcoinTxid?: string | null;
  otsAnchoredAtUtc?: string | null;
  otsCalendar?: string | null;
  otsFailureReason?: string | null;
  /**
   * How the anchor was established (2026-09-29): BITCOIN_VERIFIED | PROOF_STRUCTURE,
   * null when not recorded. Only BITCOIN_VERIFIED may be called verified.
   */
  otsAnchorCheck?: string | null;
  /** When the recorded anchor check was made (OTS_APPLIED observedAtUtc). */
  otsAnchorCheckedAtUtc?: string | null;
  /** True when an OTS proof is stored (a proof without status is pending). */
  otsProofPresent?: boolean | null;
  /** When the proof was requested; drives STALE for a long-pending proof. */
  otsSubmittedAtUtc?: string | null;
  otsUpgradedAtUtc?: string | null;
  /**
   * The result of verifying the Ed25519 signature over the recomputed
   * fingerprint IN THE EVALUATION that builds this decision. Omitted/null:
   * not checked here, and the signal never says "Verified".
   */
  signatureVerified?: boolean | null;
  /** The result of recomputing the custody hash chain; null when not run. */
  custodyChainValid?: boolean | null;
  storageImmutable?: boolean | null;
  storageObjectLockMode?: string | null;
  storageObjectLockRetainUntilUtc?: string | null;
  identityLevelSnapshot?: string | null;
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
  evidence: TrustDecisionEvidenceInput;
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

function clampScore(value: number, maxPoints: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(maxPoints, Math.round(value)));
}

function makeSignal(params: {
  key: TrustSignalKey;
  label: string;
  state: TrustSignalState;
  measuredAtUtc?: string | null;
  points: number;
  maxPoints: number;
  summary: string;
  detail: string;
  // Optional presentation tone override. Used for the identity signal so
  // recorded (but not independently verified) contributor identity renders
  // as "Recorded" rather than "Verified", without changing scoring.
  tone?: TrustDecisionTone;
}): TrustSignal {
  // Full credit is reserved for PASSED: any other state is capped below max.
  const max = params.maxPoints;
  const points =
    params.state === "PASSED" || max === 0
      ? clampScore(params.points, max)
      : Math.min(clampScore(params.points, max), Math.max(0, max - 1));
  return {
    key: params.key,
    label: params.label,
    state: params.state,
    measuredAtUtc: params.measuredAtUtc ?? null,
    status: TRUST_SIGNAL_STATE_PRESENTATION[params.state].legacyStatus,
    tone: params.tone ?? toneForState(params.state),
    points,
    maxPoints: params.maxPoints,
    summary: params.summary,
    detail: params.detail,
  };
}

export function isExplicitRecordedIntegrityVerified(
  input: TrustDecisionEvidenceInput
): boolean {
  return (
    safe(input.verificationStatus).toUpperCase() ===
      "RECORDED_INTEGRITY_VERIFIED" ||
    safe(input.recordedIntegrityVerifiedAtUtc) !== ""
  );
}

export function hasCoreCryptoMaterials(
  input: TrustDecisionEvidenceInput
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

function hasAnchorMaterial(
  anchor: TrustDecisionEvidenceInput["anchor"]
): boolean {
  return Boolean(
    hasMeaningfulValue(anchor?.transactionId) ||
      hasMeaningfulValue(anchor?.anchoredAtUtc)
  );
}

function isValidOtsBitcoinTxid(
  value: string | null | undefined
): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value.trim());
}

function hasMalformedOtsBitcoinTxid(
  value: string | null | undefined
): boolean {
  return hasMeaningfulValue(value) && !isValidOtsBitcoinTxid(value);
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
      points: 25,
      maxPoints: 25,
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
      points: 18,
      maxPoints: 25,
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
      points: 10,
      maxPoints: 25,
      summary: "Partial integrity material",
      detail:
        "Some integrity material is present, but the core digest/fingerprint record is incomplete.",
    });
  }

  return makeSignal({
    key: "core_integrity",
    label: "Core integrity",
    state: "UNAVAILABLE",
    points: 0,
    maxPoints: 25,
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

  if (hasSignature && evidence.signatureVerified === false) {
    return makeSignal({
      key: "signature",
      label: "Digital signature",
      state: "FAILED",
      points: 0,
      maxPoints: 15,
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
      points: 15,
      maxPoints: 15,
      summary: "Signature verified",
      detail:
        "The Ed25519 signature verified against the recomputed canonical fingerprint with the recorded public key, which is available for independent verification.",
    });
  }

  if (hasSignature && hasKey) {
    return makeSignal({
      key: "signature",
      label: "Digital signature",
      state: "NOT_CHECKED",
      points: hasPublicKey ? 13 : 11,
      maxPoints: 15,
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
      points: 7,
      maxPoints: 15,
      summary: "Partial signature material",
      detail:
        "Some signature-related material is recorded, but the signing package is incomplete.",
    });
  }

  return makeSignal({
    key: "signature",
    label: "Digital signature",
    state: "FAILED",
    points: 0,
    maxPoints: 15,
    summary: "Signature missing",
    detail:
      "No complete digital-signature material was recorded for this evidence state.",
  });
}

const TIMESTAMP_SIGNAL_POINTS: Readonly<Record<TrustSignalState, number>> = {
  PASSED: 15,
  PRESENT_NOT_INDEPENDENTLY_VERIFIED: 6,
  NOT_CHECKED: 6,
  PENDING: 8,
  STALE: 4,
  UNAVAILABLE: 3,
  FAILED: 0,
  NOT_APPLICABLE: 0,
};

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
      "An RFC 3161 timestamp token is recorded and was validated (signature, signer certificate chain to the configured trust anchor, signer validity at the stamped time, and the certified digest). It supports review of when the preserved integrity state existed.",
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

  return makeSignal({
    key: "trusted_timestamp",
    label: "Trusted timestamp",
    state: tsa.state,
    measuredAtUtc: tsa.measuredAtUtc,
    points: TIMESTAMP_SIGNAL_POINTS[tsa.state],
    maxPoints: 15,
    summary: tsa.label,
    detail: detail[tsa.state],
  });
}

const ANCHORING_SIGNAL_POINTS: Readonly<Record<TrustSignalState, number>> = {
  PASSED: 10,
  PRESENT_NOT_INDEPENDENTLY_VERIFIED: 6,
  NOT_CHECKED: 6,
  PENDING: 4,
  STALE: 2,
  UNAVAILABLE: 3,
  FAILED: 2,
  NOT_APPLICABLE: 0,
};

function buildAnchoringSignal(
  evidence: TrustDecisionEvidenceInput
): TrustSignal {
  const otsHashMismatch =
    hasMeaningfulValue(evidence.otsHash) &&
    hasMeaningfulValue(evidence.fingerprintHash) &&
    safe(evidence.otsHash).toLowerCase() !==
      safe(evidence.fingerprintHash).toLowerCase();
  const malformedTxidWithoutOtherProof =
    hasMalformedOtsBitcoinTxid(evidence.otsBitcoinTxid) &&
    !hasAnchorMaterial(evidence.anchor);

  if (otsHashMismatch) {
    return makeSignal({
      key: "bitcoin_anchoring",
      label: "Bitcoin anchoring",
      state: "FAILED",
      points: 2,
      maxPoints: 10,
      summary: "Bitcoin anchoring review required",
      detail:
        "Recorded OpenTimestamps hash material does not match the canonical fingerprint hash, so Bitcoin anchoring cannot be treated as verified.",
    });
  }

  if (malformedTxidWithoutOtherProof) {
    return makeSignal({
      key: "bitcoin_anchoring",
      label: "Bitcoin anchoring",
      state: "FAILED",
      points: 2,
      maxPoints: 10,
      summary: "Bitcoin anchoring review required",
      detail:
        "A malformed Bitcoin transaction identifier was recorded without any other defensible Bitcoin transaction id or anchored timestamp.",
    });
  }

  // THE CLAIM FOLLOWS THE CHECK. A proof carrying a Bitcoin attestation is
  // PRESENT; only a recorded BITCOIN_VERIFIED check is PASSED.
  const ots = resolveOtsTrustState({
    status: evidence.otsStatus,
    anchoredAtUtc: evidence.otsAnchoredAtUtc ?? evidence.anchor?.anchoredAtUtc ?? null,
    anchorCheck: normalizeOtsAnchorCheck(evidence.otsAnchorCheck ?? null),
    proofPresent: evidence.otsProofPresent ?? null,
    upgradedAtUtc: evidence.otsUpgradedAtUtc ?? null,
    submittedAtUtc: evidence.otsSubmittedAtUtc ?? null,
    anchorCheckedAtUtc: evidence.otsAnchorCheckedAtUtc ?? null,
  });

  const detail: Readonly<Record<TrustSignalState, string>> = {
    PASSED: ots.measuredAtUtc
      ? `The OpenTimestamps proof was verified against the Bitcoin chain (check recorded ${ots.measuredAtUtc}).`
      : "The OpenTimestamps proof was verified against the Bitcoin chain (the time of the check was not recorded).",
    PRESENT_NOT_INDEPENDENTLY_VERIFIED:
      "An OpenTimestamps proof with a Bitcoin block attestation is recorded, but the attestation has not been independently checked against the Bitcoin chain. Bitcoin anchoring is therefore not claimed as verified.",
    NOT_CHECKED: "The anchoring proof was not checked in this evaluation.",
    PENDING: "OpenTimestamps proof material is present, but Bitcoin anchoring has not finalized yet.",
    STALE:
      "The OpenTimestamps proof has been pending for longer than Bitcoin anchoring normally takes; its current state is not known and is not claimed.",
    UNAVAILABLE: "Anchoring was not recorded for this evidence record.",
    FAILED: "OpenTimestamps anchoring processing reported a failure state.",
    NOT_APPLICABLE: "",
  };

  return makeSignal({
    key: "bitcoin_anchoring",
    label: "Bitcoin anchoring",
    state: ots.state,
    measuredAtUtc: ots.measuredAtUtc,
    points: ANCHORING_SIGNAL_POINTS[ots.state],
    maxPoints: 10,
    summary: ots.label,
    detail: detail[ots.state],
  });
}

function buildStorageSignal(
  evidence: TrustDecisionEvidenceInput
): TrustSignal {
  const mode = safe(evidence.storageObjectLockMode).toUpperCase();
  const hasRetainUntil = hasMeaningfulValue(
    evidence.storageObjectLockRetainUntilUtc
  );

  if (evidence.storageImmutable && mode === "COMPLIANCE" && hasRetainUntil) {
    return makeSignal({
      key: "immutable_storage",
      label: "Immutable storage",
      state: "PASSED",
      points: 15,
      maxPoints: 15,
      summary: "Immutable retention verified",
      detail:
        "Storage metadata indicates immutable-style preservation using Object Lock COMPLIANCE mode with a recorded retention-until timestamp.",
    });
  }

  if (evidence.storageImmutable || mode === "GOVERNANCE") {
    return makeSignal({
      key: "immutable_storage",
      label: "Immutable storage",
      state: "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
      points: 9,
      maxPoints: 15,
      summary: "Storage protection recorded",
      detail:
        "Some storage-protection indicators are recorded, but the record does not fully confirm compliance-grade immutable retention.",
    });
  }

  if (mode) {
    return makeSignal({
      key: "immutable_storage",
      label: "Immutable storage",
      state: "FAILED",
      points: 2,
      maxPoints: 15,
      summary: "Storage requires review",
      detail:
        "Storage metadata indicates a protection state that should be reviewed before relying on immutability conclusions.",
    });
  }

  return makeSignal({
    key: "immutable_storage",
    label: "Immutable storage",
    state: "UNAVAILABLE",
    points: 0,
    maxPoints: 15,
    summary: "Storage not reported",
    detail:
      "No verifiable immutable-storage protection was included in the record payload.",
  });
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
      points: 0,
      maxPoints: 10,
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
      points: checked ? 10 : 8,
      maxPoints: 10,
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
      points: 6,
      maxPoints: 10,
      summary: `${forensicEvents.length} forensic events recorded`,
      detail:
        "Forensic custody events are recorded, but the custody-chain material is limited or incomplete.",
    });
  }

  return makeSignal({
    key: "custody_chain",
    label: "Custody chain",
    state: "UNAVAILABLE",
    points: 0,
    maxPoints: 10,
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

  if (level === "VERIFIED_ORGANIZATION") {
    return makeSignal({
      key: "identity",
      label: "Workspace identity",
      state: "PASSED",
      tone: "neutral",
      points: 5,
      maxPoints: 5,
      summary: "Organization verification recorded at capture",
      detail:
        `The workspace was associated with a verified organization when the record was captured.${tail}`,
    });
  }

  if (level === "ORGANIZATION_ACCOUNT" || level === "OAUTH_BACKED_IDENTITY") {
    return makeSignal({
      key: "identity",
      label: "Workspace identity",
      state: "PRESENT_NOT_INDEPENDENTLY_VERIFIED",
      tone: "neutral",
      points: 4,
      maxPoints: 5,
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
      points: level === "VERIFIED_EMAIL" ? 3 : 2,
      maxPoints: 5,
      summary: recordedSummary,
      detail: `${recordedParty} identity information is recorded.${tail}`,
    });
  }

  return makeSignal({
    key: "identity",
    label: "Workspace identity",
    state: "UNAVAILABLE",
    points: 0,
    maxPoints: 5,
    summary: "Identity not recorded",
    detail: isIntake
      ? "No meaningful workspace or link creator identity context was recorded."
      : "No meaningful authenticated workspace user identity context was recorded.",
  });
}

/**
 * =============================================================================
 * THE VERIFICATION-PACKAGE SIGNAL — INFORMATIONAL, AND DELIBERATELY UNSCORED.
 * =============================================================================
 * P3-4 CLOSURE (2026-09-10).
 *
 * ----------------------------------------------------------------------------
 * THE PROBLEM: A COMMERCIAL INPUT INTO A PUBLIC INTEGRITY SCORE
 * ----------------------------------------------------------------------------
 * This signal carried 5 of the 40 available points, awarded 5 when a package
 * existed and 3 when it did not. Whether a package exists is a COMMERCIAL fact:
 * the plan and the record's funding decide it (`resolveEvidenceOutputEntitlements`
 * is the authority), and a Free record never has one. So a Free customer's
 * public verification page scored 95 where an otherwise identical paid record
 * scored 100, and the two points of difference measured the price plan rather
 * than the evidence.
 *
 * It reached further than the number. `degradedSignals` counts any signal whose
 * status is partial/pending/missing/failed, and it drives `degradedButUsable`
 * and the `VERIFIED_WITH_DEGRADED_SIGNALS` presentation state — so a record's
 * headline could read "verified with supporting limitations" because of an
 * artifact its owner had not bought.
 *
 * ----------------------------------------------------------------------------
 * WHY REMOVING IT IS CORRECT, NOT A CONCESSION
 * ----------------------------------------------------------------------------
 * The exemption in the product decision is for a package that "contains a
 * forensic proof element not otherwise represented". It contains none. Every
 * proof inside a verification package — the canonical fingerprint, the Ed25519
 * signature and public key, the RFC 3161 token, the OpenTimestamps proof, the
 * custody chain, the storage protection state — is a SIGNAL OF ITS OWN in this
 * very list. The package is a convenient offline BUNDLE of things already
 * scored here, so scoring it again both double-counted the same assurance and
 * charged for the convenience.
 *
 * ----------------------------------------------------------------------------
 * WHAT IT STILL DOES
 * ----------------------------------------------------------------------------
 * It remains in the signal list and it still says truthfully whether a package
 * exists — that is real, useful information for someone deciding how to verify
 * the record offline. `maxPoints: 0` is what makes it informational: it adds
 * nothing to the numerator and nothing to the denominator, in every branch, so
 * a record's score is identical with and without a package.
 *
 * Its STATE is NOT_APPLICABLE in both the present and absent-with-materials
 * cases: it is neither a passed check nor a degradation of the evidence. The genuinely bare case — no package AND no core
 * cryptographic material — keeps `missing`, and it is not a commercial
 * statement: a record with no fingerprint and no signature has a real problem,
 * which the core and signature signals score directly.
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
      points: 0,
      maxPoints: 0,
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
      points: 0,
      maxPoints: 0,
      summary: "Not included for this record",
      detail:
        "No downloadable verification package is included for this record. This does not affect its integrity: the fingerprint, signature, timestamp, anchoring and custody materials are recorded and are assessed individually above, and they can be checked from this page.",
    });
  }

  return makeSignal({
    key: "verification_package",
    label: "Verification package",
    state: "UNAVAILABLE",
    points: 0,
    maxPoints: 0,
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

  const rawScore = signals.reduce((sum, signal) => sum + signal.points, 0);
  const computedMaxScore = signals.reduce(
    (sum, signal) => sum + signal.maxPoints,
    0
  );
  const score =
    computedMaxScore > 0
      ? Math.max(0, Math.min(100, Math.round((rawScore / computedMaxScore) * 100)))
      : 0;

  const passedSignals = signals.filter((signal) => signal.state === "PASSED").length;
  const failedSignals = signals.filter((signal) => signal.state === "FAILED").length;
  const degradedSignals = signals.filter(
    (signal) => TRUST_SIGNAL_STATE_PRESENTATION[signal.state].countsAsDegraded
  ).length;

  const criticalFailed =
    core.status === "failed" ||
    signature.status === "failed" ||
    custody.status === "failed";

  const degradedButUsable = !criticalFailed && score >= 62 && degradedSignals > 0;

  const corePassed = core.state === "PASSED";
  const publicAnchoringPending = anchoring.state === "PENDING";
  const anchoringPresentNotVerified =
    anchoring.state === "PRESENT_NOT_INDEPENDENTLY_VERIFIED" || anchoring.state === "NOT_CHECKED";
  const publicAnchoringPartial = anchoringPresentNotVerified || anchoring.state === "STALE";
  const anchoringState: TrustAnchoringState =
    anchoring.state === "PASSED"
      ? "finalized"
      : publicAnchoringPending
        ? "pending"
        : anchoringPresentNotVerified
          ? "present_not_verified"
          : anchoring.state === "STALE"
            ? "stale"
            : anchoring.state === "FAILED"
              ? "failed"
              : "unavailable";
  // A finalized presentation requires every time-and-anchoring layer to have
  // PASSED its own check: an attested proof or an unvalidated token never
  // makes a record "Recorded integrity verified" on its own.
  const finalizable = anchoringState === "finalized" && timestamp.state === "PASSED";

  let verdict: TrustDecisionVerdict;
  let level: TrustDecision["level"];
  let tone: TrustDecisionTone;
  let presentationState: TrustPresentationState;
  let presentationTone: TrustDecisionTone;
  let verdictLabel: string;
  let shortLabel: string;
  let title: string;
  let relianceLevel: TrustDecision["relianceLevel"];
  let confidenceLabel: string;

  if (criticalFailed || score < 45) {
    verdict = "REVIEW_REQUIRED";
    level = "review";
    tone = "danger";
    presentationState = "FAILED_VERIFICATION";
    presentationTone = "danger";
    verdictLabel = "Insufficient verification";
    shortLabel = "Insufficient";
    title = "Insufficient verification materials";
    relianceLevel = "low";
    confidenceLabel = "Low";
  } else if (score >= 90 && failedSignals === 0 && corePassed && finalizable) {
    verdict = "STRONGLY_VERIFIED";
    level = "strong";
    tone = "success";
    presentationState = "VERIFIED_FINALIZED";
    presentationTone = "success";
    verdictLabel = "Recorded integrity verified";
    shortLabel = "Verified";
    title = "Recorded integrity verified";
    relianceLevel = "high";
    confidenceLabel = "High";
  } else if (score >= 78 && corePassed) {
    // Core integrity verified; at least one time or anchoring layer has not
    // passed its own check. Each limitation is named for what it is.
    verdict = "VERIFIED";
    level = "standard";
    tone = "warning";
    presentationTone = "warning";
    relianceLevel = "medium";
    if (anchoringState === "pending") {
      presentationState = "VERIFIED_PENDING_ANCHORING";
      verdictLabel = "Recorded integrity verified; Bitcoin anchoring pending";
      shortLabel = "Anchoring pending";
      title = verdictLabel;
      confidenceLabel = "High (Bitcoin anchoring pending)";
    } else if (anchoringState === "present_not_verified") {
      presentationState = "VERIFIED_WITH_DEGRADED_SIGNALS";
      verdictLabel = "Recorded integrity verified; anchoring proof not independently chain-verified";
      shortLabel = "Anchor not chain-verified";
      title = verdictLabel;
      confidenceLabel = "Conditional";
    } else {
      presentationState = "VERIFIED_WITH_DEGRADED_SIGNALS";
      verdictLabel = "Recorded integrity verified with supporting limitations";
      shortLabel = "Conditional";
      title = "Conditional trust state";
      confidenceLabel = "Conditional";
    }
  } else if (score >= 78 && !corePassed) {
    verdict = "PARTIALLY_VERIFIED";
    level = "partial";
    tone = "warning";
    presentationState = "PARTIALLY_VERIFIED";
    presentationTone = "warning";
    verdictLabel = "Conditional trust state";
    shortLabel = "Conditional";
    title = "Conditional trust state";
    relianceLevel = "medium";
    confidenceLabel = "Conditional";
  } else if (score >= 62) {
    verdict = "PARTIALLY_VERIFIED";
    level = "partial";
    tone = "warning";
    presentationState = "PARTIALLY_VERIFIED";
    presentationTone = "warning";
    verdictLabel = "Conditional trust state";
    shortLabel = "Conditional";
    title = "Conditional trust state";
    relianceLevel = "medium";
    confidenceLabel = "Conditional";
  } else {
    verdict = "REVIEW_REQUIRED";
    level = "review";
    tone = "warning";
    presentationState = "REVIEW_REQUIRED";
    presentationTone = "warning";
    verdictLabel = "Review required";
    shortLabel = "Review";
    title = "Reviewer validation required";
    relianceLevel = "limited";
    confidenceLabel = "Limited";
  }

  const passedText =
    signals
      .filter((signal) => signal.state === "PASSED")
      .map((signal) => signal.label)
      .join(", ") || "No major verification signals passed";

  const degradedText =
    signals
      .filter((signal) => TRUST_SIGNAL_STATE_PRESENTATION[signal.state].countsAsDegraded)
      .map((signal) => signal.summary)
      .join("; ") || "No degraded signals were recorded";

  const summary = getTrustNarrative({
    verdictLabel,
    presentationState,
    relianceLevel,
    degradedButUsable,
    failedSignals,
    signals,
  });

  const primaryReason = `Passed signals: ${passedText}. Degraded signals: ${degradedText}.`;

  const reviewerAction = criticalFailed
    ? "Do not rely on this record as verified until failed core integrity, signature, or custody signals are reviewed."
    : anchoringPresentNotVerified && corePassed
      ? "Recorded integrity is verified. An OpenTimestamps proof with a Bitcoin attestation is present but has not been independently checked against the Bitcoin chain; verify it against the chain if independent Bitcoin anchoring is required."
    : (publicAnchoringPending || publicAnchoringPartial) && corePassed
      ? "Recorded integrity is verified, but Bitcoin anchoring is not finalized yet. An OpenTimestamps proof is recorded. Use the technical integrity result and recheck anchoring later if independent Bitcoin anchoring is required."
    : degradedButUsable
      ? "Review the degraded signals before high-reliance use, especially timestamping, Bitcoin anchoring, storage, or custody items marked as pending, partial, missing, or failed."
      : score >= 78
        ? "Proceed with normal review. For formal reliance, validate the technical appendix and verification package."
        : "Perform manual reviewer validation before relying on this evidence record.";

  return {
    verdict,
    level,
    tone,
    presentationState,
    presentationTone,
    anchoringState,
    score,
    maxScore: 100,
    scoreLabel: `${score}/100`,
    verdictLabel,
    shortLabel,
    title,
    confidenceLabel,
    // A finalized anchor says exactly what was checked (see buildAnchoringSignal).
    anchoringStatusLabel:
      anchoringState === "finalized" ? anchoring.summary : getAnchoringStateLabel(anchoringState),
    summary,
    primaryReason,
    reviewerAction,
    degradedButUsable,
    relianceLevel,
    signals,
    passedSignals,
    degradedSignals,
    failedSignals,
  };
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
  bitcoin_anchoring: {
    PASSED: "Anchored, chain-verified",
    PRESENT_NOT_INDEPENDENTLY_VERIFIED: "Proof present, not chain-verified",
    PENDING: "Pending",
    STALE: "State unknown",
    FAILED: "Failed",
    UNAVAILABLE: "Not recorded",
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
