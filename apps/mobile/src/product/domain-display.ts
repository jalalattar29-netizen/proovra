/**
 * CANONICAL NATIVE DOMAIN DISPLAY — the ONE mapping from backend/@proovra/shared
 * domain values to a user-facing { label, tone } for native badges (Law of One,
 * Master Program §24 / L1). Pure data — no React/RN imports — so it is unit-
 * testable and consumed by every screen instead of raw enum strings in the UI.
 *
 * WHY this layer exists (it is a documented mapping layer, not a duplicate enum):
 *  - The four core enums (EvidenceType, EvidenceStatus, VerificationStatus,
 *    CaseStatus) are authored in the Prisma schema; only EvidenceType is mirrored
 *    in @proovra/shared. Their VALUES are mirrored here verbatim.
 *  - The web app resolves TONES in app-local helpers (lib/status-tone/*,
 *    cases-experience/*) that are not published to a shared package. Native needs
 *    the same semantics, so the tone table is mirrored here against the ONE
 *    cross-platform tone contract (ProovraStatusTone from @proovra/ui).
 *  - The backend evidence LIST/DETAIL already returns human `statusLabel`,
 *    `verificationStatusLabel`, `captureMethodLabel`, `acquisition.label`. Screens
 *    PREFER those server labels and use this module for the tone. Where the server
 *    returns raw enums (e.g. bare Case rows), the label table here is the fallback.
 *
 * A drift guard (test/domain-display.test.mjs) asserts every canonical value is
 * mapped and no tone escapes the 6-value ProovraStatusTone contract.
 */
import type { ProovraStatusTone } from "@proovra/ui";
import type {
  EvidenceType,
  EvidenceStatus,
  VerificationStatus,
  EvidenceLifecycleState,
  CaseStatus,
} from "./domain-enums.generated";

export interface DomainDisplay {
  readonly label: string;
  readonly tone: ProovraStatusTone;
}

/* ------------------------------------------------------------ Evidence type */
// Prisma enum EvidenceType (schema.prisma) / @proovra/shared EvidenceTypeSchema.
export { EVIDENCE_TYPES } from "./domain-enums.generated";
export type { EvidenceType } from "./domain-enums.generated";

const EVIDENCE_TYPE_LABEL: Record<EvidenceType, string> = {
  PHOTO: "Photo",
  VIDEO: "Video",
  AUDIO: "Audio",
  DOCUMENT: "Document",
};

/* ---------------------------------------------------------- Evidence status */
// Prisma enum EvidenceStatus (ingestion pipeline).
export { EVIDENCE_STATUSES } from "./domain-enums.generated";
export type { EvidenceStatus } from "./domain-enums.generated";

const EVIDENCE_STATUS_DISPLAY: Record<EvidenceStatus, DomainDisplay> = {
  CREATED: { label: "Created", tone: "neutral" },
  UPLOADING: { label: "Uploading", tone: "pending" },
  UPLOADED: { label: "Uploaded", tone: "info" },
  SIGNED: { label: "Signed", tone: "verified" },
  REPORTED: { label: "Reported", tone: "verified" },
  FAILED_HASH_MISMATCH: { label: "Integrity failed", tone: "risk" },
};

/* ------------------------------------------------------ Verification status */
// Prisma enum VerificationStatus (integrity verdict). Honest claims only — never
// upgrade REVIEW_REQUIRED/MATERIALS_AVAILABLE into a "verified" tone (§4.7).
export { VERIFICATION_STATUSES } from "./domain-enums.generated";
export type { VerificationStatus } from "./domain-enums.generated";

const VERIFICATION_STATUS_DISPLAY: Record<VerificationStatus, DomainDisplay> = {
  MATERIALS_AVAILABLE: { label: "Materials available", tone: "neutral" },
  RECORDED_INTEGRITY_VERIFIED: { label: "Integrity verified", tone: "verified" },
  REVIEW_REQUIRED: { label: "Review required", tone: "pending" },
  FAILED: { label: "Verification failed", tone: "risk" },
};

/* ------------------------------------------------- Evidence lifecycle state */
// @proovra/shared EVIDENCE_LIFECYCLE_STATES (governance/retention state machine).
export { EVIDENCE_LIFECYCLE_STATES } from "./domain-enums.generated";
export type { EvidenceLifecycleState } from "./domain-enums.generated";

const EVIDENCE_LIFECYCLE_DISPLAY: Record<EvidenceLifecycleState, DomainDisplay> = {
  ACTIVE: { label: "Active", tone: "verified" },
  UNDER_REVIEW: { label: "Under review", tone: "pending" },
  ON_HOLD: { label: "On hold", tone: "governance" },
  RETENTION_LOCKED: { label: "Retention locked", tone: "governance" },
  PENDING_DESTRUCTION: { label: "Pending destruction", tone: "risk" },
  // TRASHED was absent from the hand-mirrored list and the old drift guard
  // could not see it: it compared the native table to itself. Deriving the
  // values from schema.prisma turned that into a compile error on the first
  // run. The library speaks Active / Archived / Trash (the canonical scope
  // vocabulary), so the label follows the scope the user sees.
  TRASHED: { label: "In trash", tone: "neutral" },
  DESTROYED: { label: "Destroyed", tone: "neutral" },
  ARCHIVED: { label: "Archived", tone: "neutral" },
};

/* ---------------------------------------------------------------- Case status */
// Prisma enum CaseStatus. Labels mirror the web CASE_STATUS_LABEL table.
export { CASE_STATUSES } from "./domain-enums.generated";
export type { CaseStatus } from "./domain-enums.generated";

const CASE_STATUS_DISPLAY: Record<CaseStatus, DomainDisplay> = {
  OPEN: { label: "Open", tone: "verified" },
  INVESTIGATING: { label: "Investigating", tone: "info" },
  ON_HOLD: { label: "On hold", tone: "governance" },
  RESOLVED: { label: "Resolved", tone: "verified" },
  CLOSED: { label: "Closed", tone: "neutral" },
  ARCHIVED: { label: "Archived", tone: "neutral" },
};

/* ------------------------------------------------------------------ Resolvers */

/** Title-case an unknown SCREAMING_SNAKE value as a safe last-resort label. */
export function humanizeEnum(value: string): string {
  return value
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function lookup<T extends string>(
  table: Record<T, DomainDisplay>,
  value: string | null | undefined,
  fallbackTone: ProovraStatusTone,
): DomainDisplay {
  if (value && value in table) return table[value as T];
  return { label: value ? humanizeEnum(value) : "Unknown", tone: fallbackTone };
}

export function evidenceTypeLabel(value: string | null | undefined): string {
  if (value && value in EVIDENCE_TYPE_LABEL) return EVIDENCE_TYPE_LABEL[value as EvidenceType];
  return value ? humanizeEnum(value) : "File";
}

export function evidenceStatusDisplay(value: string | null | undefined): DomainDisplay {
  return lookup(EVIDENCE_STATUS_DISPLAY, value, "neutral");
}

export function verificationStatusDisplay(value: string | null | undefined): DomainDisplay {
  return lookup(VERIFICATION_STATUS_DISPLAY, value, "neutral");
}

export function evidenceLifecycleDisplay(value: string | null | undefined): DomainDisplay {
  return lookup(EVIDENCE_LIFECYCLE_DISPLAY, value, "neutral");
}

export function caseStatusDisplay(value: string | null | undefined): DomainDisplay {
  return lookup(CASE_STATUS_DISPLAY, value, "neutral");
}
