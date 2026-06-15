/**
 * Phase EVIDENCE-DELETE-ELIGIBILITY — frontend mirror.
 *
 * `getEvidenceDeletionEligibility(evidence)` is the SINGLE entry the
 * UI uses to decide whether to enable Move-to-trash. Every surface
 * that renders the trash control must use it — list row, detail tab,
 * bulk toolbar, preview, anywhere.
 *
 * Behaviour:
 *
 *   1. If the backend response carries `deleteEligibility` (Evidence
 *      Detail does), USE IT VERBATIM. That field is the only one
 *      that knows about the EvidenceLegalHold table — which lives
 *      outside the evidence row — so it's strictly more accurate
 *      than the client mirror.
 *
 *   2. Otherwise (list rows / older clients), compute the eligibility
 *      from the retention columns the evidence row already has. The
 *      precedence MUST match the backend
 *      `computeEvidenceDeleteEligibilitySync` order so the UI's
 *      reason matches what the API would actually return if the user
 *      clicked through.
 *
 * Copy is locked by the spec — no emoji, no over-claim vocabulary.
 * The full banned-token list (and the safer replacement vocabulary)
 * lives in the contract tests; this module just stays inside the
 * "recorded integrity", "retention-protected", and "legal outcome"
 * frame.
 */

import type {
  EvidenceDeleteEligibility,
  EvidenceDeleteReasonCode,
  EvidenceListItem,
  EvidenceRecord,
} from "./evidence-library-types";

/**
 * The subset of fields the client-side computation needs. Narrow so
 * any evidence-shaped object (list item, record, mock, snapshot)
 * works without ceremony.
 */
export type EvidenceDeleteEligibilityCandidate = {
  deleteEligibility?: EvidenceDeleteEligibility | null;
  deletedAt?: string | null;
  lockedAt?: string | null;
  storageObjectLockMode?: string | null;
  storageObjectLockRetainUntilUtc?: string | null;
  storageObjectLockLegalHoldStatus?: string | null;
  retentionUntilUtc?: string | null;
};

function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function formatDateForCopy(iso: string | null | undefined): string | null {
  const d = parseIso(iso ?? null);
  if (!d) return null;
  // Locale-stable, never ambiguous. The spec example uses "Jun 14,
  // 2034" so we render the short-month form for the visible helper
  // text; the ISO date is preserved separately in `blockedUntil`.
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const day = d.getUTCDate();
  const month = months[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  return `${month} ${day}, ${year}`;
}

function complianceMessage(iso: string | null | undefined): string {
  const human = formatDateForCopy(iso);
  return human
    ? `This record is protected by compliance retention until ${human}. It cannot be moved to trash before that date.`
    : "This record is protected by compliance retention and cannot be moved to trash while retention is active.";
}

function retentionUntilMessage(iso: string | null | undefined): string {
  const human = formatDateForCopy(iso);
  return human
    ? `This record is protected by workspace retention until ${human}. It cannot be moved to trash before that date.`
    : "This record is protected by workspace retention and cannot be moved to trash while retention is active.";
}

export function getEvidenceDeletionEligibility(
  evidence:
    | EvidenceDeleteEligibilityCandidate
    | EvidenceRecord
    | EvidenceListItem
    | null
    | undefined,
): EvidenceDeleteEligibility {
  if (!evidence) {
    // Defensive default — when there's no record at all, the UI
    // should NOT enable the trash control. Better to render a
    // disabled button than to crash on a null reference.
    return {
      canMoveToTrash: false,
      reasonCode: "UNKNOWN",
      blockedUntil: null,
      message: "Record state is loading. Try again in a moment.",
    };
  }

  // 1. Trust the backend-computed field when present.
  const candidate = evidence as EvidenceDeleteEligibilityCandidate;
  const backend = candidate.deleteEligibility;
  if (backend && typeof backend === "object" && "canMoveToTrash" in backend) {
    return backend;
  }

  // 2. Client mirror — precedence matches the backend's
  //    `computeEvidenceDeleteEligibilitySync`.

  if (candidate.deletedAt) {
    return {
      canMoveToTrash: false,
      reasonCode: "ALREADY_DELETED",
      blockedUntil: null,
      message: "This record is already in trash.",
    };
  }

  if (candidate.lockedAt) {
    return {
      canMoveToTrash: false,
      reasonCode: "EVIDENCE_LOCKED",
      blockedUntil: null,
      message:
        "This record is permanently locked and cannot be moved to trash.",
    };
  }

  const mode = String(candidate.storageObjectLockMode ?? "").toUpperCase();
  const olRetainUntilDate = parseIso(candidate.storageObjectLockRetainUntilUtc ?? null);
  if (mode === "COMPLIANCE" && olRetainUntilDate && olRetainUntilDate.getTime() > Date.now()) {
    return {
      canMoveToTrash: false,
      reasonCode: "COMPLIANCE_RETENTION",
      blockedUntil: olRetainUntilDate.toISOString(),
      message: complianceMessage(candidate.storageObjectLockRetainUntilUtc),
    };
  }

  if (
    String(candidate.storageObjectLockLegalHoldStatus ?? "").toUpperCase() === "ON"
  ) {
    return {
      canMoveToTrash: false,
      reasonCode: "LEGAL_HOLD",
      blockedUntil: null,
      message:
        "This record is under an active legal hold and cannot be moved to trash.",
    };
  }

  const retentionUntilDate = parseIso(candidate.retentionUntilUtc ?? null);
  if (retentionUntilDate && retentionUntilDate.getTime() > Date.now()) {
    return {
      canMoveToTrash: false,
      reasonCode: "RETENTION_UNTIL",
      blockedUntil: retentionUntilDate.toISOString(),
      message: retentionUntilMessage(candidate.retentionUntilUtc),
    };
  }

  return {
    canMoveToTrash: true,
    reasonCode: null,
    blockedUntil: null,
    message: "",
  };
}

// Re-exported for callers that just need the type.
export type { EvidenceDeleteEligibility, EvidenceDeleteReasonCode };

/**
 * Helper for the Archive guidance copy. Used next to the disabled
 * trash button so the user knows what action IS available.
 *
 * Spec-locked wording:
 *   "Archive removes the record from Active evidence while
 *    preserving it under retention."
 */
export const ARCHIVE_AS_ALTERNATIVE_COPY =
  "Archive removes the record from Active evidence while preserving it under retention." as const;
