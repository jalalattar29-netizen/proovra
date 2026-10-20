/**
 * AUD-47 (2026-10-20) — ONE reader-facing vocabulary for the enums that
 * surfaces printed raw or re-declared with their own words and tones: the
 * record's verification status, the Object Lock mode, and an organization's
 * status. Web, mobile, API and the report read these; none keeps a copy.
 */
export type VocabularyTone = "success" | "warning" | "danger" | "neutral";

export const EVIDENCE_VERIFICATION_STATUS_LABELS = Object.freeze({
  RECORDED_INTEGRITY_VERIFIED: "Recorded integrity state verified",
  MATERIALS_AVAILABLE: "Technical materials available",
  REVIEW_REQUIRED: "Review required",
  FAILED: "Verification failed",
} as const);
export const EVIDENCE_VERIFICATION_STATUS_UNKNOWN = "Verification status not recorded";

const norm = (v: string | null | undefined) => String(v ?? "").trim().toUpperCase();

/** The label for a record's verification status; an unknown value is said to be unrecorded, never printed raw. */
export function evidenceVerificationStatusLabel(status: string | null | undefined): string {
  return (EVIDENCE_VERIFICATION_STATUS_LABELS as Record<string, string>)[norm(status)] ?? EVIDENCE_VERIFICATION_STATUS_UNKNOWN;
}

/**
 * Its tone, by exact value — never `endsWith("VERIFIED")`: only a recorded
 * integrity verification is success; materials alone are neutral.
 */
export function evidenceVerificationStatusTone(status: string | null | undefined): VocabularyTone {
  switch (norm(status)) {
    case "RECORDED_INTEGRITY_VERIFIED":
      return "success";
    case "REVIEW_REQUIRED":
      return "warning";
    case "FAILED":
      return "danger";
    default:
      return "neutral";
  }
}

/** The Object Lock mode in words; null when none is recorded (the surface states absence its own way). */
export function objectLockModeLabel(mode: string | null | undefined): string | null {
  switch (norm(mode)) {
    case "COMPLIANCE":
      return "Compliance retention lock";
    case "GOVERNANCE":
      return "Governance retention lock";
    default:
      return null;
  }
}

/** An organization's status (OrganizationStatus). A completed closure archives the organization: it reads "Closed". */
export const ORGANIZATION_STATUS_LABELS = Object.freeze({
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  ARCHIVED: "Closed",
} as const);

export function organizationStatusLabel(status: string | null | undefined): string {
  return (ORGANIZATION_STATUS_LABELS as Record<string, string>)[norm(status)] ?? "Status not recorded";
}

export function organizationStatusTone(status: string | null | undefined): VocabularyTone {
  switch (norm(status)) {
    case "ACTIVE":
      return "success";
    case "SUSPENDED":
      return "warning";
    case "ARCHIVED":
      return "neutral";
    default:
      return "neutral";
  }
}

/** An enterprise contract's status (EnterpriseContractStatus). */
export const ENTERPRISE_CONTRACT_STATUS_LABELS = Object.freeze({
  DRAFT: "Draft",
  PENDING_ACTIVATION: "Pending activation",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  TERMINATED: "Terminated",
} as const);

export function enterpriseContractStatusLabel(status: string | null | undefined): string {
  return (ENTERPRISE_CONTRACT_STATUS_LABELS as Record<string, string>)[norm(status)] ?? "Status not recorded";
}

/** Only a terminated contract is danger; a draft or one awaiting activation is not a risk. */
export function enterpriseContractStatusTone(status: string | null | undefined): VocabularyTone {
  switch (norm(status)) {
    case "ACTIVE":
      return "success";
    case "PENDING_ACTIVATION":
    case "SUSPENDED":
      return "warning";
    case "TERMINATED":
      return "danger";
    default:
      return "neutral";
  }
}

/**
 * AUD-51 (2026-10-20) — THE two integrity conclusions, each computed once.
 *
 * `recordedIntegrityVerified`: the record's own recorded verification (the
 * report's review note reads it; the worker computed it ad hoc twice).
 * `overallIntegrityOf`: Public Verify's live conclusion from its checks — every
 * check that RAN agrees; an unknown (null) check never fails it, a false one
 * always does.
 */
export function recordedIntegrityVerified(input: {
  verificationStatus?: string | null;
  recordedIntegrityVerifiedAtUtc?: Date | string | null;
}): boolean {
  return norm(input.verificationStatus) === "RECORDED_INTEGRITY_VERIFIED" || Boolean(input.recordedIntegrityVerifiedAtUtc);
}

export function overallIntegrityOf(checks: {
  canonicalHashMatches: boolean;
  signatureValid: boolean;
  custodyChainValid: boolean;
  timestampDigestMatches: boolean | null;
  otsHashMatches: boolean | null;
  digestColumnsMatchSignedFingerprint: boolean | null;
  storedBytesContradict: boolean;
}): boolean {
  return (
    checks.canonicalHashMatches &&
    checks.signatureValid &&
    checks.custodyChainValid &&
    checks.timestampDigestMatches !== false &&
    checks.otsHashMatches !== false &&
    checks.digestColumnsMatchSignedFingerprint !== false &&
    !checks.storedBytesContradict
  );
}

/**
 * AUD-51 (2026-10-20) — THE custody display counts, one shape for the owner
 * workspace and Public Verify (they built it twice; the public copy carried
 * redundant pairs: currentForensic = currentForensicEvents, totalDisplayedNow
 * = totalDisplayedEvents).
 */
export type CustodyDisplayCounts = {
  forensicAtReportGeneration: number;
  currentForensicEvents: number;
  accessAfterReportGeneration: number;
  currentAccessEvents: number;
  totalDisplayedEvents: number;
  reportGeneratedAtUtc: string | null;
};

export function buildCustodyDisplayCounts(input: {
  forensicAtReportGeneration: number;
  currentForensicEvents: number;
  accessAfterReportGeneration: number;
  currentAccessEvents: number;
  reportGeneratedAtUtc: Date | null | undefined;
}): CustodyDisplayCounts {
  return {
    forensicAtReportGeneration: input.forensicAtReportGeneration,
    currentForensicEvents: input.currentForensicEvents,
    accessAfterReportGeneration: input.accessAfterReportGeneration,
    currentAccessEvents: input.currentAccessEvents,
    totalDisplayedEvents: input.currentForensicEvents + input.currentAccessEvents,
    reportGeneratedAtUtc: input.reportGeneratedAtUtc ? input.reportGeneratedAtUtc.toISOString() : null,
  };
}

/**
 * AUD-51 (2026-10-20) — THE custody cut-off of an issued artifact is a
 * SEQUENCE, never a time (worker custodyThroughIssuance, ET-CUS-06): an event's
 * atUtc is its own time and is not monotonic in sequence. The artifact's
 * recorded custodyThroughSequence wins; a legacy artifact without one uses the
 * highest sequence recorded at or before its issue time.
 */
export function custodyCutoffSequence(
  events: ReadonlyArray<{ sequence: number; atUtc: Date }>,
  issuedAtUtc: Date | null | undefined,
  recordedThroughSequence?: number | null,
): number | null {
  if (typeof recordedThroughSequence === "number") return recordedThroughSequence;
  if (!issuedAtUtc) return null;
  let max: number | null = null;
  for (const e of events) {
    if (e.atUtc.getTime() <= issuedAtUtc.getTime() && (max === null || e.sequence > max)) max = e.sequence;
  }
  return max ?? 0;
}

/** Events at issue (sequence <= cut-off) and after it; no cut-off: every event is "at issue". */
export function splitCustodyAtCutoff<T extends { sequence: number }>(
  events: ReadonlyArray<T>,
  cutoff: number | null,
): { atIssue: T[]; afterIssue: T[] } {
  if (cutoff === null) return { atIssue: [...events], afterIssue: [...events] };
  return { atIssue: events.filter((e) => e.sequence <= cutoff), afterIssue: events.filter((e) => e.sequence > cutoff) };
}
