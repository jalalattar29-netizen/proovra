import {
  classifyCustodyEventType,
  type CustodyEventCategory,
} from "./custody.js";

export type TrustDecisionTone = "success" | "warning" | "danger" | "neutral";

export type TrustSignalStatus =
  | "passed"
  | "partial"
  | "pending"
  | "missing"
  | "failed";

export type TrustDecisionVerdict =
  | "STRONGLY_VERIFIED"
  | "VERIFIED"
  | "PARTIALLY_VERIFIED"
  | "REVIEW_REQUIRED";

export type TrustSignalKey =
  | "core_integrity"
  | "signature"
  | "trusted_timestamp"
  | "public_anchoring"
  | "immutable_storage"
  | "custody_chain"
  | "identity"
  | "verification_package";

export type TrustSignal = {
  key: TrustSignalKey;
  label: string;
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
  score: number;
  maxScore: 100;
  scoreLabel: string;
  verdictLabel: string;
  shortLabel: string;
  title: string;
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
  "key" | "label" | "status" | "tone" | "summary"
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

function hasPendingPublicAnchoringSignal(
  decision:
    | Pick<TrustDecision, "signals">
    | {
        signals?: Array<Pick<TrustSignal, "key" | "status">> | null;
      }
): boolean {
  const anchoringSignal = decision.signals?.find(
    (signal) => signal.key === "public_anchoring"
  );

  return anchoringSignal?.status === "pending";
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

export function getTrustSignalPresentationLabel(
  signal: Pick<TrustSignal, "status" | "tone">
): string {
  switch (signal.status) {
    case "passed":
      return signal.tone === "success" ? "Verified" : "Recorded";
    case "partial":
      return "Recorded";
    case "pending":
      return "Follow-up recommended";
    case "failed":
      return "Integrity concern";
    case "missing":
    default:
      return "Not recorded";
  }
}

export function getTrustNarrative(
  decision: Pick<
    TrustDecision,
    | "verdictLabel"
    | "relianceLevel"
    | "degradedButUsable"
    | "failedSignals"
    | "signals"
  >
): string {
  if (decision.verdictLabel === "Strongly verified") {
    if (hasPendingPublicAnchoringSignal(decision)) {
      return "Recorded integrity state is strongly verified; public anchoring is still pending and should be rechecked if independent public anchoring is required.";
    }

    return decision.degradedButUsable || decision.failedSignals > 0
      ? "Recorded integrity state is strongly verified. One or more supporting verification signals may still require follow-up."
      : "Recorded integrity state is strongly verified. No post-submission integrity mismatch was detected across the recorded verification layers.";
  }

  if (decision.verdictLabel === "Verified") {
    if (hasPendingPublicAnchoringSignal(decision)) {
      return "Recorded integrity state is verified; public anchoring is still pending and should be rechecked if independent public anchoring is required.";
    }

    return "Recorded integrity state is verified. No post-submission integrity mismatch was detected across the recorded verification layers reviewed here.";
  }

  if (decision.verdictLabel === "Verified with limitations") {
    return "Recorded integrity state is verified with limitations. Core integrity materials are recorded, but one or more supporting verification layers still require follow-up.";
  }

  if (decision.verdictLabel === "Insufficient verification") {
    return "Integrity concerns were detected across one or more critical verification layers.";
  }

  return "Recorded verification materials require reviewer follow-up before higher-reliance use.";
}

export const TRUST_DECISION_LEGAL_BOUNDARY =
  "This trust decision summarizes the recorded integrity state of the evidence record. It does not independently prove factual truth, authorship, legal admissibility, intent, or completed public anchoring unless those external publication materials are separately verified.";

export function serializeTrustDecisionForReviewerPackage(
  decision: TrustDecision,
  options?: { includeInternalDebug?: boolean }
): ReviewerPackageTrustDecision {
  const base: ReviewerPackageTrustDecision = {
    verdict: decision.verdict,
    verdictLabel: decision.verdictLabel,
    relianceLevel: decision.relianceLevel,
    relianceLabel: getReviewerRelianceLabel(decision.relianceLevel),
    narrative: getTrustNarrative(decision),
    reviewerAction: decision.reviewerAction,
    legalBoundary: TRUST_DECISION_LEGAL_BOUNDARY,
    signals: decision.signals.map((signal) => ({
      key: signal.key,
      label: signal.label,
      status: signal.status,
      tone: signal.tone,
      summary: signal.summary,
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
        status: signal.status,
        tone: signal.tone,
        summary: signal.summary,
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
  tsaStatus?: string | null;
  tsaFailureReason?: string | null;
  otsStatus?: string | null;
  otsHash?: string | null;
  otsBitcoinTxid?: string | null;
  otsAnchoredAtUtc?: string | null;
  otsCalendar?: string | null;
  otsFailureReason?: string | null;
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
    published?: boolean | null;
    provider?: string | null;
    publicUrl?: string | null;
    anchoredAtUtc?: string | null;
    transactionId?: string | null;
    receiptId?: string | null;
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

function toneForStatus(status: TrustSignalStatus): TrustDecisionTone {
  switch (status) {
    case "passed":
      return "success";
    case "partial":
    case "pending":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

function clampScore(value: number, maxPoints: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(maxPoints, Math.round(value)));
}

function makeSignal(params: {
  key: TrustSignalKey;
  label: string;
  status: TrustSignalStatus;
  points: number;
  maxPoints: number;
  summary: string;
  detail: string;
}): TrustSignal {
  return {
    key: params.key,
    label: params.label,
    status: params.status,
    tone: toneForStatus(params.status),
    points: clampScore(params.points, params.maxPoints),
    maxPoints: params.maxPoints,
    summary: params.summary,
    detail: params.detail,
  };
}

function isPositiveTimestamp(status: string | null | undefined): boolean {
  return ["GRANTED", "STAMPED", "VERIFIED", "SUCCEEDED"].includes(
    safe(status).toUpperCase()
  );
}

function isPendingTimestamp(status: string | null | undefined): boolean {
  return ["PENDING", "UNAVAILABLE"].includes(safe(status).toUpperCase());
}

function isFailedTimestamp(status: string | null | undefined): boolean {
  const normalized = safe(status).toUpperCase();
  return Boolean(
    normalized && !isPositiveTimestamp(normalized) && !isPendingTimestamp(normalized)
  );
}

function isAnchoredOts(status: string | null | undefined): boolean {
  return safe(status).toUpperCase() === "ANCHORED";
}

function isPendingOts(status: string | null | undefined): boolean {
  return safe(status).toUpperCase() === "PENDING";
}

function isFailedOts(status: string | null | undefined): boolean {
  return safe(status).toUpperCase() === "FAILED";
}

function isDisabledOts(status: string | null | undefined): boolean {
  return safe(status).toUpperCase() === "DISABLED";
}

function normalizeTimestampFailureReason(
  failureReason: string | null | undefined
): string {
  const value = safe(failureReason);
  return value || "Timestamp provider did not return a usable token.";
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

function hasPublishedAnchorMaterial(
  anchor: TrustDecisionEvidenceInput["anchor"]
): boolean {
  return Boolean(
    hasMeaningfulValue(anchor?.receiptId) ||
      hasMeaningfulValue(anchor?.transactionId) ||
      hasValidHttpUrl(anchor?.publicUrl) ||
      hasMeaningfulValue(anchor?.anchoredAtUtc)
  );
}

function isValidOtsBitcoinTxid(
  value: string | null | undefined
): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value.trim());
}

function hasValidHttpUrl(value: string | null | undefined): boolean {
  const text = safe(value);
  if (!text) return false;

  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function hasMalformedOtsBitcoinTxid(
  value: string | null | undefined
): boolean {
  return hasMeaningfulValue(value) && !isValidOtsBitcoinTxid(value);
}

function hasDefensibleOtsAnchorMaterial(
  evidence: TrustDecisionEvidenceInput
): boolean {
  return Boolean(
    isValidOtsBitcoinTxid(evidence.otsBitcoinTxid) ||
      hasPublishedAnchorMaterial(evidence.anchor)
  );
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
      status: "passed",
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
      status: "partial",
      points: 18,
      maxPoints: 25,
      summary: "Integrity materials recorded",
      detail:
        "Recorded digest, canonical fingerprint, and signature material are present, but the recorded-integrity state has not been finalized as fully verified.",
    });
  }

  if (hasFileDigest || hasFingerprint) {
    return makeSignal({
      key: "core_integrity",
      label: "Core integrity",
      status: "partial",
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
    status: "missing",
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

  if (hasSignature && hasKey && hasPublicKey) {
    return makeSignal({
      key: "signature",
      label: "Digital signature",
      status: "passed",
      points: 15,
      maxPoints: 15,
      summary: "Signature package recorded",
      detail:
        "Signature material, signing-key reference, and public-key material are available for independent verification.",
    });
  }

  if (hasSignature && hasKey) {
    return makeSignal({
      key: "signature",
      label: "Digital signature",
      status: "passed",
      points: 13,
      maxPoints: 15,
      summary: "Signature material recorded",
      detail:
        "Signature material and signing-key reference are recorded. Public-key material should be checked through the verification package or technical endpoint.",
    });
  }

  if (hasSignature || hasKey) {
    return makeSignal({
      key: "signature",
      label: "Digital signature",
      status: "partial",
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
    status: "failed",
    points: 0,
    maxPoints: 15,
    summary: "Signature missing",
    detail:
      "No complete digital-signature material was recorded for this evidence state.",
  });
}

function buildTimestampSignal(
  evidence: TrustDecisionEvidenceInput
): TrustSignal {
  if (isPositiveTimestamp(evidence.tsaStatus)) {
    return makeSignal({
      key: "trusted_timestamp",
      label: "Trusted timestamp",
      status: "passed",
      points: 15,
      maxPoints: 15,
      summary: "Trusted timestamp recorded",
      detail:
        "An RFC 3161 trusted timestamp is recorded and can support review of when the preserved integrity state existed.",
    });
  }

  if (isPendingTimestamp(evidence.tsaStatus)) {
    return makeSignal({
      key: "trusted_timestamp",
      label: "Trusted timestamp",
      status: "pending",
      points: 8,
      maxPoints: 15,
      summary: "Timestamp pending",
      detail:
        "The trusted timestamp was not finalized for this evidence state. The record can still be reviewed using digest, signature, custody, and storage materials.",
    });
  }

  if (isFailedTimestamp(evidence.tsaStatus)) {
    return makeSignal({
      key: "trusted_timestamp",
      label: "Trusted timestamp",
      status: "partial",
      points: 3,
      maxPoints: 15,
      summary: "Timestamp unavailable",
      detail: normalizeTimestampFailureReason(evidence.tsaFailureReason),
    });
  }

  return makeSignal({
    key: "trusted_timestamp",
    label: "Trusted timestamp",
    status: "missing",
    points: 0,
    maxPoints: 15,
    summary: "Timestamp not recorded",
    detail:
      "No RFC 3161 timestamp state was included. The evidence may still have other integrity controls, but timestamp reliance is limited.",
  });
}

function buildAnchoringSignal(
  evidence: TrustDecisionEvidenceInput
): TrustSignal {
  const otsHashMismatch =
    hasMeaningfulValue(evidence.otsHash) &&
    hasMeaningfulValue(evidence.fingerprintHash) &&
    safe(evidence.otsHash).toLowerCase() !==
      safe(evidence.fingerprintHash).toLowerCase();
  const defensibleAnchorMaterial = hasDefensibleOtsAnchorMaterial(evidence);
  const malformedTxidWithoutOtherProof =
    hasMalformedOtsBitcoinTxid(evidence.otsBitcoinTxid) &&
    !hasPublishedAnchorMaterial(evidence.anchor);

  if (otsHashMismatch) {
    return makeSignal({
      key: "public_anchoring",
      label: "Public anchoring",
      status: "failed",
      points: 2,
      maxPoints: 10,
      summary: "Public anchoring review required",
      detail:
        "Recorded OpenTimestamps hash material does not match the canonical fingerprint hash, so public anchoring cannot be treated as verified.",
    });
  }

  if (malformedTxidWithoutOtherProof) {
    return makeSignal({
      key: "public_anchoring",
      label: "Public anchoring",
      status: "failed",
      points: 2,
      maxPoints: 10,
      summary: "Public anchoring review required",
      detail:
        "A malformed Bitcoin transaction identifier was recorded without any other defensible public anchoring receipt, URL, or anchored publication metadata.",
    });
  }

  if (isAnchoredOts(evidence.otsStatus) && defensibleAnchorMaterial) {
    return makeSignal({
      key: "public_anchoring",
      label: "Public anchoring",
      status: "passed",
      points: 10,
      maxPoints: 10,
      summary: "Public anchoring verified",
      detail:
        "Public anchoring metadata includes defensible public evidence such as a valid Bitcoin transaction id, receipt, public URL, or anchored publication metadata.",
    });
  }

  if (isAnchoredOts(evidence.otsStatus)) {
    return makeSignal({
      key: "public_anchoring",
      label: "Public anchoring",
      status: "partial",
      points: 8,
      maxPoints: 10,
      summary: "Anchor material included",
      detail:
        "Anchoring material is recorded in an anchored state, but no defensible public transaction id, receipt, public URL, or anchored publication metadata was attached.",
    });
  }

  if (isPendingOts(evidence.otsStatus)) {
    return makeSignal({
      key: "public_anchoring",
      label: "Public anchoring",
      status: "pending",
      points: 6,
      maxPoints: 10,
      summary: "OTS proof present, public anchoring pending",
      detail:
        "OpenTimestamps proof material is present, but Bitcoin/public anchoring has not finalized yet.",
    });
  }

  if (isDisabledOts(evidence.otsStatus)) {
    return makeSignal({
      key: "public_anchoring",
      label: "Public anchoring",
      status: "missing",
      points: 3,
      maxPoints: 10,
      summary: "Public anchoring unavailable",
      detail:
        "Public anchoring was disabled or not used for this evidence record.",
    });
  }

  if (isFailedOts(evidence.otsStatus)) {
    return makeSignal({
      key: "public_anchoring",
      label: "Public anchoring",
      status: "failed",
      points: 2,
      maxPoints: 10,
      summary: "Public anchoring failed",
      detail:
        "OpenTimestamps or external publication processing reported a failure state.",
    });
  }

  return makeSignal({
    key: "public_anchoring",
    label: "Public anchoring",
    status: "missing",
    points: 0,
    maxPoints: 10,
    summary: "Public anchoring unavailable",
    detail: "No public anchoring material was recorded for this evidence state.",
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
      status: "passed",
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
      status: "partial",
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
      status: "failed",
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
    status: "missing",
    points: 0,
    maxPoints: 15,
    summary: "Storage not reported",
    detail:
      "No verifiable immutable-storage protection was included in the record payload.",
  });
}

function buildCustodySignal(
  custodyEvents: TrustDecisionCustodyEventInput[]
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

  if (forensicEvents.length >= 5 && hasHashChain) {
    return makeSignal({
      key: "custody_chain",
      label: "Custody chain",
      status: "passed",
      points: 10,
      maxPoints: 10,
      summary: `${forensicEvents.length} forensic events recorded`,
      detail:
        "A forensic custody chronology and custody hash-chain references are recorded for reviewer inspection.",
    });
  }

  if (forensicEvents.length > 0) {
    return makeSignal({
      key: "custody_chain",
      label: "Custody chain",
      status: "partial",
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
    status: "missing",
    points: 0,
    maxPoints: 10,
    summary: "No forensic custody events",
    detail:
      "No forensic custody chronology was included in the record payload.",
  });
}

function buildIdentitySignal(
  evidence: TrustDecisionEvidenceInput
): TrustSignal {
  const level = safe(evidence.identityLevelSnapshot).toUpperCase();
  const hasEmail = hasMeaningfulValue(evidence.submittedByEmail);
  const hasProvider = hasMeaningfulValue(evidence.submittedByAuthProvider);

  if (level === "VERIFIED_ORGANIZATION") {
    return makeSignal({
      key: "identity",
      label: "Identity assurance",
      status: "passed",
      points: 5,
      maxPoints: 5,
      summary: "Verified organization identity",
      detail:
        "The submitter context is associated with a verified organization identity level.",
    });
  }

  if (level === "ORGANIZATION_ACCOUNT" || level === "OAUTH_BACKED_IDENTITY") {
    return makeSignal({
      key: "identity",
      label: "Identity assurance",
      status: "passed",
      points: 4,
      maxPoints: 5,
      summary:
        level === "ORGANIZATION_ACCOUNT"
          ? "Organization account recorded"
          : "OAuth-backed identity recorded",
      detail:
        "A meaningful submitter identity level is recorded for reviewer context.",
    });
  }

  if (level === "VERIFIED_EMAIL" || hasEmail || hasProvider) {
    return makeSignal({
      key: "identity",
      label: "Identity assurance",
      status: "partial",
      points: 3,
      maxPoints: 5,
      summary: "Submitter identity recorded",
      detail:
        "Basic submitter identity information is present, but stronger organization verification was not recorded.",
    });
  }

  return makeSignal({
    key: "identity",
    label: "Identity assurance",
    status: "missing",
    points: 0,
    maxPoints: 5,
    summary: "Identity not recorded",
    detail: "No meaningful submitter identity context was recorded.",
  });
}

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
      status: "passed",
      points: 5,
      maxPoints: 5,
      summary: "Verification package recorded",
      detail:
        "A verification package/version is recorded, supporting deeper technical validation outside summary surfaces.",
    });
  }

  if (hasCoreCryptoMaterials(evidence)) {
    return makeSignal({
      key: "verification_package",
      label: "Verification package",
      status: "partial",
      points: 3,
      maxPoints: 5,
      summary: "Technical materials available",
      detail:
        "Core technical materials are recorded, but a verification package version was not included in this record payload.",
    });
  }

  return makeSignal({
    key: "verification_package",
    label: "Verification package",
    status: "missing",
    points: 0,
    maxPoints: 5,
    summary: "Verification package not recorded",
    detail: "No verification package reference was included.",
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
  const custody = buildCustodySignal(input.custodyEvents);
  const identity = buildIdentitySignal(input.evidence);
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

  const passedSignals = signals.filter((signal) => signal.status === "passed").length;
  const failedSignals = signals.filter((signal) => signal.status === "failed").length;
  const degradedSignals = signals.filter((signal) =>
    ["partial", "pending", "missing", "failed"].includes(signal.status)
  ).length;

  const criticalFailed =
    core.status === "failed" ||
    signature.status === "failed" ||
    custody.status === "failed";

  const degradedButUsable = !criticalFailed && score >= 62 && degradedSignals > 0;

  const corePassed = core.status === "passed";
  const publicAnchoringPending = anchoring.status === "pending";

  let verdict: TrustDecisionVerdict;
  let level: TrustDecision["level"];
  let tone: TrustDecisionTone;
  let verdictLabel: string;
  let shortLabel: string;
  let title: string;
  let relianceLevel: TrustDecision["relianceLevel"];

  if (criticalFailed || score < 45) {
    verdict = "REVIEW_REQUIRED";
    level = "review";
    tone = "danger";
    verdictLabel = "Insufficient verification";
    shortLabel = "Insufficient";
    title = "Insufficient verification materials";
    relianceLevel = "low";
  } else if (score >= 90 && failedSignals === 0 && corePassed) {
    verdict = "STRONGLY_VERIFIED";
    level = "strong";
    tone = "success";
    verdictLabel = "Strongly verified";
    shortLabel = "Strong";
    title = "Strong verification state";
    relianceLevel = "high";
  } else if (score >= 78 && corePassed) {
    verdict = "VERIFIED";
    level = "standard";
    tone = "success";
    verdictLabel = "Verified";
    shortLabel = "Verified";
    title = "Verified evidence state";
    relianceLevel = "high";
  } else if (score >= 78 && !corePassed) {
    verdict = "PARTIALLY_VERIFIED";
    level = "partial";
    tone = "warning";
    verdictLabel = "Verified with limitations";
    shortLabel = "Limited";
    title = "Verified evidence state with limitations";
    relianceLevel = "medium";
  } else if (score >= 62) {
    verdict = "PARTIALLY_VERIFIED";
    level = "partial";
    tone = "warning";
    verdictLabel = "Verified with limitations";
    shortLabel = "Limited";
    title = "Verified evidence state with limitations";
    relianceLevel = "medium";
  } else {
    verdict = "REVIEW_REQUIRED";
    level = "review";
    tone = "warning";
    verdictLabel = "Review required";
    shortLabel = "Review";
    title = "Reviewer validation required";
    relianceLevel = "limited";
  }

  const passedText =
    signals
      .filter((signal) => signal.status === "passed")
      .map((signal) => signal.label)
      .join(", ") || "No major verification signals passed";

  const degradedText =
    signals
      .filter((signal) =>
        ["partial", "pending", "missing", "failed"].includes(signal.status)
      )
      .map((signal) => signal.summary)
      .join("; ") || "No degraded signals were recorded";

  const summary = getTrustNarrative({
    verdictLabel,
    relianceLevel,
    degradedButUsable,
    failedSignals,
    signals,
  });

  const primaryReason = `Passed signals: ${passedText}. Degraded signals: ${degradedText}.`;

  const reviewerAction = criticalFailed
    ? "Do not rely on this record as verified until failed core integrity, signature, or custody signals are reviewed."
    : publicAnchoringPending && corePassed
      ? "Recorded integrity is strongly verified, but public anchoring is still pending. Recheck public anchoring later if independent public anchoring is required."
    : degradedButUsable
      ? "Review the degraded signals before high-reliance use, especially timestamping, public anchoring, storage, or custody items marked as pending, partial, missing, or failed."
      : score >= 78
        ? "Proceed with normal review. For formal reliance, validate the technical appendix and verification package."
        : "Perform manual reviewer validation before relying on this evidence record.";

  return {
    verdict,
    level,
    tone,
    score,
    maxScore: 100,
    scoreLabel: `${score}/100`,
    verdictLabel,
    shortLabel,
    title,
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
