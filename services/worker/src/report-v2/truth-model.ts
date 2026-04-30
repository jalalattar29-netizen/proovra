import {
  Tone,
  ReportEvidence,
  ReportAnchorSummary,
  ReportCustodyEvent,
  CalloutModel,
  ReportTrustDecision,
  ReportTrustSignal,
  ReportTrustSignalStatus,
} from "./types.js";
import {
  normalizeTimestampFailureReason,
  safe,
  safeBooleanLabel,
} from "./formatters.js";
import {
  mapOtsStatusPublicLabel,
  mapTimestampStatusPublicLabel,
} from "./normalizers.js";

export function isIntegrityVerified(evidence: ReportEvidence): boolean {
  return (
    safe(evidence.verificationStatus, "").toUpperCase() ===
      "RECORDED_INTEGRITY_VERIFIED" ||
    safe(evidence.recordedIntegrityVerifiedAtUtc, "") !== ""
  );
}

export function hasCoreCryptoMaterials(evidence: ReportEvidence): boolean {
  return Boolean(
    evidence.fileSha256 &&
      evidence.fingerprintHash &&
      evidence.signatureBase64 &&
      evidence.signingKeyId
  );
}

export function normalizeTimestampTone(
  status: string | null | undefined
): Tone {
  const s = safe(status, "").toUpperCase();

  if (["GRANTED", "STAMPED", "VERIFIED", "SUCCEEDED"].includes(s)) {
    return "success";
  }
  if (["PENDING", "UNAVAILABLE"].includes(s)) return "warning";
  if (s) return "danger";
  return "neutral";
}

export function normalizeOtsTone(status: string | null | undefined): Tone {
  const s = safe(status, "").toUpperCase();

  if (s === "ANCHORED") return "success";
  if (s === "PENDING") return "warning";
  if (s === "FAILED") return "danger";
  return "neutral";
}

export function normalizeStorageTone(
  immutable: boolean | null | undefined,
  mode: string | null | undefined,
  retainUntil: string | null | undefined
): Tone {
  const normalizedMode = safe(mode, "").toUpperCase();

  if (
    immutable &&
    normalizedMode === "COMPLIANCE" &&
    safe(retainUntil, "") !== ""
  ) {
    return "success";
  }

  if (immutable || normalizedMode === "GOVERNANCE") {
    return "warning";
  }

  if (normalizedMode) {
    return "danger";
  }

  return "neutral";
}

export function buildExecutiveConclusion(
  evidence: ReportEvidence
): CalloutModel {
  const verified = isIntegrityVerified(evidence);

  return {
    title: verified ? "Executive conclusion" : "Reviewable evidence record",
    body: verified
      ? "The preserved evidence record reached a verified recorded-integrity state at report generation time. Reviewers can use this report to orient themselves to the package, then proceed to the later technical and legal sections for deeper validation and interpretation."
      : "The preserved evidence record is present and reviewable, but one or more technical confirmation signals were not finalized at report generation time. Reviewers should use the report as an evidence-orientation and technical-review aid.",
    tone: verified ? "success" : "warning",
  };
}

export function buildLegalLimitationShort(): CalloutModel {
  return {
    title: "Important legal limitation",
    body:
      "This report verifies the recorded integrity state of the evidence record. It does not independently prove factual truth, authorship, context, intent, or legal admissibility.",
    tone: "warning",
  };
}

export function buildStorageCallout(evidence: ReportEvidence): CalloutModel {
  const tone = normalizeStorageTone(
    evidence.storageImmutable,
    evidence.storageObjectLockMode,
    evidence.storageObjectLockRetainUntilUtc
  );

  return {
    title:
      tone === "success"
        ? "Immutable storage verified"
        : tone === "warning"
          ? "Storage protection recorded"
          : tone === "danger"
            ? "Storage protection requires review"
            : "Storage protection not reported",
    body:
      tone === "success"
        ? "This report records immutable-style storage protection consistent with Object Lock COMPLIANCE mode and a recorded retention-until timestamp."
        : tone === "warning"
          ? "Some storage-protection indicators are recorded, but the report does not fully confirm COMPLIANCE immutable protection."
          : tone === "danger"
            ? "Storage metadata indicates a protection state that should be reviewed before relying on immutability conclusions."
            : "No verifiable storage-protection information was included in the report payload.",
    tone,
  };
}

export function buildTimestampCallout(evidence: ReportEvidence): CalloutModel {
  const tone = normalizeTimestampTone(evidence.tsaStatus);

  return {
    title:
      tone === "success"
        ? "Trusted timestamp recorded"
        : tone === "warning"
          ? "Trusted timestamp not finalized"
          : tone === "danger"
            ? "Trusted timestamp could not be obtained"
            : "Trusted timestamp not reported",
    body:
      tone === "success"
        ? "An RFC 3161 timestamp record is available and may support later review of when the recorded integrity state existed."
        : tone === "warning"
          ? "A trusted timestamp was not finalized in the current report state. The evidence record can still be reviewed using its recorded fingerprint, signature, custody, and storage materials."
          : tone === "danger"
            ? normalizeTimestampFailureReason(evidence.tsaFailureReason)
            : "No trusted timestamp record was included.",
    tone,
  };
}

export function buildOtsCallout(evidence: ReportEvidence): CalloutModel {
  const tone = normalizeOtsTone(evidence.otsStatus);

  return {
    title:
      tone === "success"
        ? "OpenTimestamps anchored"
        : tone === "warning"
          ? "OpenTimestamps pending"
          : tone === "danger"
            ? "OpenTimestamps failed"
            : "OpenTimestamps not reported",
    body:
      tone === "success"
        ? "An OpenTimestamps proof is recorded in an anchored state and may provide additional independent public anchoring evidence."
        : tone === "warning"
          ? "OpenTimestamps proof data is present but not yet in a final anchored state."
          : tone === "danger"
            ? `OpenTimestamps processing reported a failure state.${safe(
                evidence.otsFailureReason,
                ""
              )
                ? ` ${safe(evidence.otsFailureReason)}`
                : ""}`.trim()
            : "No OpenTimestamps record was included.",
    tone,
  };
}

export function buildReviewSequence(
  primaryLabel: string | null | undefined
): CalloutModel {
  return {
    title: "Review sequence",
    body: `Start with the primary evidence item${
      primaryLabel ? ` (${primaryLabel})` : ""
    }, then review the package structure, then assess the recorded integrity outcome, and only then move into forensic custody, timestamping, storage, anchoring, and the technical appendix when deeper validation is needed.`,
    tone: "neutral",
  };
}

export function buildIntegrityReadinessSummary(
  evidence: ReportEvidence
): string {
  return [
    mapTimestampStatusPublicLabel(evidence.tsaStatus),
    safeBooleanLabel(
      evidence.storageImmutable,
      "Immutable",
      "Review storage",
      "Not reported"
    ),
  ].join(" • ");
}

export function buildAnchorPublicationSummary(
  anchor: ReportAnchorSummary | null
): string {
  if (anchor?.published) {
    return `Published via ${safe(anchor.provider, "external anchor")}`;
  }

  if (anchor?.configured) {
    return `Anchor configured but no published record captured`;
  }

  return "No external publication recorded";
}

function isPositiveTimestamp(status: string | null | undefined): boolean {
  const s = safe(status, "").toUpperCase();
  return ["STAMPED", "GRANTED", "VERIFIED", "SUCCEEDED"].includes(s);
}

function isPendingTimestamp(status: string | null | undefined): boolean {
  const s = safe(status, "").toUpperCase();
  return ["PENDING", "UNAVAILABLE"].includes(s);
}

function isFailedTimestamp(status: string | null | undefined): boolean {
  const s = safe(status, "").toUpperCase();
  return Boolean(s) && !isPositiveTimestamp(s) && !isPendingTimestamp(s);
}

function isAnchoredOts(status: string | null | undefined): boolean {
  return safe(status, "").toUpperCase() === "ANCHORED";
}

function isPendingOts(status: string | null | undefined): boolean {
  return safe(status, "").toUpperCase() === "PENDING";
}

function isFailedOts(status: string | null | undefined): boolean {
  return safe(status, "").toUpperCase() === "FAILED";
}

function isDisabledOts(status: string | null | undefined): boolean {
  return safe(status, "").toUpperCase() === "DISABLED";
}

function statusTone(status: ReportTrustSignalStatus): Tone {
  switch (status) {
    case "passed":
      return "success";
    case "partial":
    case "pending":
      return "warning";
    case "failed":
      return "danger";
    case "missing":
    default:
      return "neutral";
  }
}

function clampScore(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, Math.round(value)));
}

function buildSignal(params: {
  key: ReportTrustSignal["key"];
  label: string;
  status: ReportTrustSignalStatus;
  points: number;
  maxPoints: number;
  summary: string;
  detail: string;
}): ReportTrustSignal {
  return {
    key: params.key,
    label: params.label,
    status: params.status,
    tone: statusTone(params.status),
    points: clampScore(params.points, params.maxPoints),
    maxPoints: params.maxPoints,
    summary: params.summary,
    detail: params.detail,
  };
}

function hasMeaningfulValue(value: string | null | undefined): boolean {
  const normalized = safe(value, "").trim().toLowerCase();
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

function buildCoreIntegritySignal(evidence: ReportEvidence): ReportTrustSignal {
  const hasFileDigest = hasMeaningfulValue(evidence.fileSha256);
  const hasFingerprint = hasMeaningfulValue(evidence.fingerprintHash);
  const verified = isIntegrityVerified(evidence);

  if (verified && hasFileDigest && hasFingerprint) {
    return buildSignal({
      key: "core_integrity",
      label: "Core integrity",
      status: "passed",
      points: 25,
      maxPoints: 25,
      summary: "Recorded integrity state verified",
      detail:
        "The report contains the primary digest and canonical fingerprint, and the recorded integrity state reached a verified condition.",
    });
  }

  if (hasFileDigest && hasFingerprint) {
    return buildSignal({
      key: "core_integrity",
      label: "Core integrity",
      status: "partial",
      points: 18,
      maxPoints: 25,
      summary: "Integrity materials recorded",
      detail:
        "The digest and canonical fingerprint are recorded, but the overall integrity state was not finalized as fully verified at report generation time.",
    });
  }

  if (hasFileDigest || hasFingerprint) {
    return buildSignal({
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

  return buildSignal({
    key: "core_integrity",
    label: "Core integrity",
status: "missing",
    points: 0,
    maxPoints: 25,
    summary: "Integrity material missing",
    detail:
      "The report does not contain enough core digest or fingerprint material to support reliable integrity review.",
  });
}

function buildSignatureSignal(evidence: ReportEvidence): ReportTrustSignal {
  const hasSignature = hasMeaningfulValue(evidence.signatureBase64);
  const hasKey = hasMeaningfulValue(evidence.signingKeyId);
  const hasPublicKey = hasMeaningfulValue(evidence.publicKeyPem);

  if (hasSignature && hasKey && hasPublicKey) {
    return buildSignal({
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
    return buildSignal({
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
    return buildSignal({
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

  return buildSignal({
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

function buildTimestampSignal(evidence: ReportEvidence): ReportTrustSignal {
  if (isPositiveTimestamp(evidence.tsaStatus)) {
    return buildSignal({
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
    return buildSignal({
      key: "trusted_timestamp",
      label: "Trusted timestamp",
      status: "pending",
      points: 8,
      maxPoints: 15,
      summary: "Timestamp pending",
      detail:
        "The trusted timestamp was not finalized at report generation time. The record can still be reviewed using digest, signature, custody, and storage materials.",
    });
  }

if (isFailedTimestamp(evidence.tsaStatus)) {
  return buildSignal({
    key: "trusted_timestamp",
    label: "Trusted timestamp",
    status: "partial",
    points: 3,
    maxPoints: 15,
    summary: "Timestamp unavailable",
    detail: normalizeTimestampFailureReason(evidence.tsaFailureReason),
  });
}

  return buildSignal({
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

function buildAnchoringSignal(evidence: ReportEvidence): ReportTrustSignal {
  const hasPublishedAnchor = evidence.anchor?.published === true;

  if (isAnchoredOts(evidence.otsStatus) && hasPublishedAnchor) {
    return buildSignal({
      key: "public_anchoring",
      label: "Public anchoring",
      status: "passed",
      points: 10,
      maxPoints: 10,
      summary: "Public anchoring recorded",
      detail:
        "Public anchoring metadata includes an anchored receipt, transaction, URL, or anchored timestamp.",
    });
  }

  if (isAnchoredOts(evidence.otsStatus)) {
    return buildSignal({
      key: "public_anchoring",
      label: "Public anchoring",
      status: "partial",
      points: 8,
      maxPoints: 10,
      summary: "Anchor material included",
      detail:
        "Anchoring material is recorded in an anchored state, but no external publication receipt, transaction, URL, or anchored timestamp was attached.",
    });
  }

  if (isPendingOts(evidence.otsStatus)) {
    return buildSignal({
      key: "public_anchoring",
      label: "Public anchoring",
      status: "pending",
      points: 6,
      maxPoints: 10,
      summary: "Anchoring pending",
      detail:
        "Anchoring material is present but not yet finalized. This is a degraded but usable state when core integrity, signature, custody, and storage are available.",
    });
  }

  if (isDisabledOts(evidence.otsStatus)) {
    return buildSignal({
      key: "public_anchoring",
      label: "Public anchoring",
      status: "missing",
      points: 3,
      maxPoints: 10,
      summary: "Anchoring disabled",
      detail:
        "Public anchoring was disabled or not used for this evidence record.",
    });
  }

  if (isFailedOts(evidence.otsStatus)) {
    return buildSignal({
      key: "public_anchoring",
      label: "Public anchoring",
      status: "failed",
      points: 2,
      maxPoints: 10,
      summary: "Anchoring failed",
      detail:
        safe(evidence.otsFailureReason, "") ||
        "OpenTimestamps processing reported a failure state.",
    });
  }

  return buildSignal({
    key: "public_anchoring",
    label: "Public anchoring",
    status: "missing",
    points: 0,
    maxPoints: 10,
    summary: "Anchoring not recorded",
    detail:
      "No public anchoring material was recorded for this evidence state.",
  });
}

function buildStorageSignal(evidence: ReportEvidence): ReportTrustSignal {
  const tone = normalizeStorageTone(
    evidence.storageImmutable,
    evidence.storageObjectLockMode,
    evidence.storageObjectLockRetainUntilUtc
  );

  if (tone === "success") {
    return buildSignal({
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

  if (tone === "warning") {
    return buildSignal({
      key: "immutable_storage",
      label: "Immutable storage",
      status: "partial",
      points: 9,
      maxPoints: 15,
      summary: "Storage protection recorded",
      detail:
        "Some storage-protection indicators are recorded, but the report does not fully confirm compliance-grade immutable retention.",
    });
  }

  if (tone === "danger") {
    return buildSignal({
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

  return buildSignal({
    key: "immutable_storage",
    label: "Immutable storage",
    status: "missing",
    points: 0,
    maxPoints: 15,
    summary: "Storage not reported",
    detail:
      "No verifiable immutable-storage protection was included in the report payload.",
  });
}

function buildCustodySignal(custodyEvents: ReportCustodyEvent[]): ReportTrustSignal {
  const forensicEvents = custodyEvents.filter(
    (event) => event.category !== "access"
  );
  const hasHashChain = forensicEvents.some(
    (event) => hasMeaningfulValue(event.eventHash) || hasMeaningfulValue(event.prevEventHash)
  );

  if (forensicEvents.length >= 5 && hasHashChain) {
    return buildSignal({
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
    return buildSignal({
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

  return buildSignal({
    key: "custody_chain",
    label: "Custody chain",
    status: "missing",
    points: 0,
    maxPoints: 10,
    summary: "No forensic custody events",
    detail:
      "No forensic custody chronology was included in the report payload.",
  });
}

function buildIdentitySignal(evidence: ReportEvidence): ReportTrustSignal {
  const level = safe(evidence.identityLevelSnapshot, "").toUpperCase();
  const hasEmail = hasMeaningfulValue(evidence.submittedByEmail);
  const hasProvider = hasMeaningfulValue(evidence.submittedByAuthProvider);

  if (level === "VERIFIED_ORGANIZATION") {
    return buildSignal({
      key: "identity",
      label: "Submitter identity",
      status: "passed",
      points: 5,
      maxPoints: 5,
      summary: "Verified organization identity",
      detail:
        "The submitter context is associated with a verified organization identity level.",
    });
  }

  if (level === "ORGANIZATION_ACCOUNT" || level === "OAUTH_BACKED_IDENTITY") {
    return buildSignal({
      key: "identity",
      label: "Submitter identity",
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
    return buildSignal({
      key: "identity",
      label: "Submitter identity",
      status: "partial",
      points: 3,
      maxPoints: 5,
      summary: "Submitter identity recorded",
      detail:
        "Basic submitter identity information is present, but stronger organization verification was not recorded.",
    });
  }

  return buildSignal({
    key: "identity",
    label: "Submitter identity",
    status: "missing",
    points: 0,
    maxPoints: 5,
    summary: "Identity not recorded",
    detail:
      "No meaningful submitter identity context was recorded.",
  });
}

function buildVerificationPackageSignal(evidence: ReportEvidence): ReportTrustSignal {
  if (
    evidence.verificationPackageVersion ||
    hasMeaningfulValue(evidence.verificationPackageGeneratedAtUtc)
  ) {
    return buildSignal({
      key: "verification_package",
      label: "Verification package",
      status: "passed",
      points: 5,
      maxPoints: 5,
      summary: "Verification package recorded",
      detail:
        "A verification package/version is recorded, supporting deeper technical validation outside the PDF body.",
    });
  }

  if (hasCoreCryptoMaterials(evidence)) {
    return buildSignal({
      key: "verification_package",
      label: "Verification package",
      status: "partial",
      points: 3,
      maxPoints: 5,
      summary: "Technical materials available",
      detail:
        "Core technical materials are recorded, but a verification package version was not included in this report payload.",
    });
  }

  return buildSignal({
    key: "verification_package",
    label: "Verification package",
    status: "missing",
    points: 0,
    maxPoints: 5,
    summary: "Verification package not recorded",
    detail:
      "No verification package reference was included.",
  });
}

function buildVerdict(params: {
  score: number;
  core: ReportTrustSignal;
  signature: ReportTrustSignal;
  custody: ReportTrustSignal;
  failedSignals: number;
}): Pick<
  ReportTrustDecision,
  | "verdict"
  | "level"
  | "tone"
  | "verdictLabel"
  | "shortLabel"
  | "title"
  | "relianceLevel"
> {
  const coreFailed = params.core.status === "failed";
  const signatureFailed = params.signature.status === "failed";
  const custodyFailed = params.custody.status === "failed";

if (coreFailed || signatureFailed || custodyFailed || params.score < 45) {
  return {
    verdict: "REVIEW_REQUIRED",
    level: "failed",
    tone: "danger",
    verdictLabel: "Insufficient verification",
    shortLabel: "Insufficient",
    title: "Insufficient verification materials",
    relianceLevel: "low",
  };
}

  if (params.score >= 90 && params.failedSignals === 0) {
    return {
      verdict: "STRONGLY_VERIFIED",
      level: "strong",
      tone: "success",
      verdictLabel: "Strongly verified",
      shortLabel: "Strong",
      title: "Strong verification state",
      relianceLevel: "high",
    };
  }

  if (params.score >= 78) {
    return {
      verdict: "VERIFIED",
      level: "standard",
      tone: "success",
      verdictLabel: "Verified",
      shortLabel: "Verified",
      title: "Verified evidence state",
      relianceLevel: "high",
    };
  }

if (params.score >= 62) {
  return {
    verdict: "PARTIALLY_VERIFIED",
    level: "partial",
    tone: "warning",
    verdictLabel: "Verified with limitations",
    shortLabel: "Verified with limitations",
    title: "Verified evidence state with limitations",
    relianceLevel: "medium",
  };
}

  return {
    verdict: "REVIEW_REQUIRED",
    level: "review",
    tone: "warning",
    verdictLabel: "Review required",
    shortLabel: "Review",
    title: "Reviewer validation required",
    relianceLevel: "limited",
  };
}

function buildDecisionNarrative(params: {
  verdictLabel: string;
  score: number;
  signals: ReportTrustSignal[];
  degradedButUsable: boolean;
}): {
  summary: string;
  primaryReason: string;
  reviewerAction: string;
} {
  const passed = params.signals
    .filter((s) => s.status === "passed")
    .map((s) => s.label);

  const degraded = params.signals
    .filter((s) => ["partial", "pending", "missing", "failed"].includes(s.status))
    .map((s) => s.summary);

  const passedText =
    passed.length > 0
      ? passed.join(", ")
      : "No major verification signals passed";

  const degradedText =
    degraded.length > 0
      ? degraded.join("; ")
      : "No degraded signals were recorded";

  if (params.degradedButUsable) {
    return {
      summary: `${params.verdictLabel} — ${params.score}/100. Core verification materials remain usable, but one or more supporting trust signals require follow-up.`,
      primaryReason: `Passed signals: ${passedText}. Degraded signals: ${degradedText}.`,
      reviewerAction:
        "Review the degraded signals before high-reliance use, especially timestamping, public anchoring, storage, or custody items marked as pending, partial, missing, or failed.",
    };
  }

  return {
    summary: `${params.verdictLabel} — ${params.score}/100. The recorded evidence state is summarized from cryptographic, custody, timestamping, storage, identity, and package-availability signals.`,
    primaryReason: `Passed signals: ${passedText}. Degraded signals: ${degradedText}.`,
    reviewerAction:
      params.score >= 78
        ? "Proceed with normal review. For formal reliance, validate the technical appendix and verification package."
        : "Perform manual reviewer validation before relying on this evidence record.",
  };
}

export function buildTrustDecision(params: {
  evidence: ReportEvidence;
  custodyEvents: ReportCustodyEvent[];
}): ReportTrustDecision {
  const core = buildCoreIntegritySignal(params.evidence);
  const signature = buildSignatureSignal(params.evidence);
  const timestamp = buildTimestampSignal(params.evidence);
  const anchoring = buildAnchoringSignal(params.evidence);
  const storage = buildStorageSignal(params.evidence);
  const custody = buildCustodySignal(params.custodyEvents);
  const identity = buildIdentitySignal(params.evidence);
  const verificationPackage = buildVerificationPackageSignal(params.evidence);

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

  const maxScore = signals.reduce((sum, signal) => sum + signal.maxPoints, 0);
  const rawScore = signals.reduce((sum, signal) => sum + signal.points, 0);

  const score =
    maxScore > 0 ? Math.max(0, Math.min(100, Math.round((rawScore / maxScore) * 100))) : 0;

  const passedSignals = signals.filter((s) => s.status === "passed").length;

  const failedSignals = signals.filter((s) => s.status === "failed").length;

  const degradedSignals = signals.filter((s) =>
    ["partial", "pending", "missing", "failed"].includes(s.status)
  ).length;

  const criticalFailed =
    core.status === "failed" ||
    signature.status === "failed" ||
    custody.status === "failed";

  const degradedButUsable =
    !criticalFailed &&
    score >= 62 &&
    degradedSignals > 0;

  const verdict = buildVerdict({
    score,
    core,
    signature,
    custody,
    failedSignals,
  });

  const narrative = buildDecisionNarrative({
    verdictLabel: verdict.verdictLabel,
    score,
    signals,
    degradedButUsable,
  });

  return {
    ...verdict,
    score,
    maxScore: 100,
    scoreLabel: `${score}/100`,
    summary: narrative.summary,
    primaryReason: narrative.primaryReason,
    reviewerAction: criticalFailed
      ? "Do not rely on this record as verified until failed core integrity, signature, or custody signals are reviewed."
      : narrative.reviewerAction,
    degradedButUsable,
    signals,
    passedSignals,
    degradedSignals,
    failedSignals,
  };
}
