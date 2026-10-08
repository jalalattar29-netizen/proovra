import {
  classifyCustodyEventType,
  type CustodyEventCategory,
} from "./custody.js";
import { normalizeOtsAnchorCheck } from "./ots.js";
import { presentedTsaStatus } from "./tsa-validation-state.js";
import {
  TSA_VALIDATED_QUALIFICATION_STATEMENT,
  TRUST_SIGNAL_STATE_PRESENTATION,
  resolveOtsTrustState,
  resolveSnapshotSignalState,
  resolveTsaTrustState,
  toVerificationStatus,
  type TrustSignalState,
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
}): TrustSignal {
  return {
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
        "The Ed25519 signature verified against the recomputed canonical fingerprint with the recorded public key, which is available for independent verification.",
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

  return makeSignal({
    key: "trusted_timestamp",
    label: "Trusted timestamp",
    state: tsa.state,
    measuredAtUtc: tsa.measuredAtUtc,
    summary: tsa.label,
    detail: detail[tsa.state],
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
  const malformedTxidWithoutOtherProof =
    hasMalformedOtsBitcoinTxid(evidence.otsBitcoinTxid) &&
    !hasAnchorMaterial(evidence.anchor);

  if (otsHashMismatch) {
    return makeSignal({
      key: "bitcoin_anchoring",
      label: "Bitcoin anchoring",
      state: "FAILED",
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
    // The txid precondition the package seals: a chain check with no txid on
    // the record is never "verified". Passed whenever the caller supplied the
    // field (null = known to be absent).
    ...(evidence.otsBitcoinTxid !== undefined ? { bitcoinTxid: evidence.otsBitcoinTxid } : {}),
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
      summary: "Storage requires review",
      detail:
        "Storage metadata indicates a protection state that should be reviewed before relying on immutability conclusions.",
    });
  }

  return makeSignal({
    key: "immutable_storage",
    label: "Immutable storage",
    state: "UNAVAILABLE",
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

  if (level === "VERIFIED_ORGANIZATION") {
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

  if (level === "ORGANIZATION_ACCOUNT" || level === "OAUTH_BACKED_IDENTITY") {
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
  const anchoringSignal = signals.find((signal) => signal.key === "bitcoin_anchoring");
  const anchoring = { state: anchoringSignal?.state ?? "UNAVAILABLE", summary: anchoringSignal?.summary ?? "" };

  const criticalFailed =
    core.state === "FAILED" ||
    signature.state === "FAILED" ||
    custody.state === "FAILED";

  const corePassed = core.state === "PASSED";
  const publicAnchoringPending = anchoring.state === "PENDING";
  const anchoringPresentNotVerified =
    anchoring.state === "PRESENT_NOT_INDEPENDENTLY_VERIFIED" || anchoring.state === "NOT_CHECKED";
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
  // Every time-and-anchoring layer PASSED its own check: an attested proof or
  // an unvalidated token never puts a record in the finalized bucket.
  const finalizable = anchoringState === "finalized" && timestamp.state === "PASSED";

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
    : anchoringPresentNotVerified
      ? "To rely on Bitcoin anchoring, verify the OpenTimestamps proof against the Bitcoin chain yourself; PROOVRA has not checked it against the chain."
      : publicAnchoringPending || anchoring.state === "STALE"
        ? "Bitcoin anchoring has not completed; recheck it later if independent Bitcoin anchoring is required."
        : timestamp.state !== "PASSED"
          ? "The RFC 3161 timestamp is not validated; do not rely on it as a trusted timestamp."
          : "Check each signal's status and the technical appendix before relying on this record for a specific purpose.";

  return {
    tone,
    presentationState,
    presentationTone: tone,
    anchoringState,
    // A finalized anchor says exactly what was checked (see buildAnchoringSignal).
    anchoringStatusLabel:
      anchoringState === "finalized" ? anchoring.summary : getAnchoringStateLabel(anchoringState),
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
    });
    signals.push({
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
