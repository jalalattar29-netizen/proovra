/**
 * Phase EVIDENCE-DELETE-ELIGIBILITY — single source of truth for
 * "can this record be moved to trash right now?".
 *
 * Existing backend guards already enforce all of the following on the
 * `POST /v1/evidence/:id/trash` route:
 *
 *   - `assertEvidenceNotLocked`              (evidence.routes.ts:327)
 *     → 409 EVIDENCE_LOCKED when `lockedAt` is set
 *
 *   - `assertEvidenceDeletionAllowedByRetention`  (evidence.routes.ts:338)
 *     → 409 COMPLIANCE_RETENTION_ACTIVE when
 *       `storageObjectLockMode === "COMPLIANCE"` AND
 *       `storageObjectLockRetainUntilUtc > now`
 *
 *   - `canDeleteEvidence`                    (governance.service.ts:396)
 *     → "blocked_by_retention" when `retentionUntilUtc > now`
 *     → "blocked_by_legal_hold" when active EvidenceLegalHold exists
 *
 *   - `gateRetentionAction`                  (workspace retention policy)
 *     → workspace policy denial
 *
 * This service does NOT change any of those guards. It computes the
 * same set of conditions in a READ-ONLY shape so the Evidence Detail
 * response can advertise eligibility to the UI BEFORE the user
 * clicks. Frontend mirrors this logic for offline / list-row
 * computations (and prefers this server-computed field whenever it's
 * present on the wire).
 *
 * Stable contract — frontend and backend both depend on the
 * `reasonCode` literals. New reasons MUST be added at the END of the
 * union and the frontend mirror updated in lockstep.
 */

import type { PrismaClient } from "@prisma/client";
import prismaPkg from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

export type EvidenceDeleteReasonCode =
  | "COMPLIANCE_RETENTION"
  | "LEGAL_HOLD"
  | "RETENTION_UNTIL"
  | "EVIDENCE_LOCKED"
  | "ALREADY_DELETED"
  | "UNKNOWN";

export type EvidenceDeleteEligibility = {
  canMoveToTrash: boolean;
  reasonCode: EvidenceDeleteReasonCode | null;
  /** ISO timestamp the block lifts on, when known. */
  blockedUntil: string | null;
  /** Human-readable, copy-policy-compliant. Safe to render verbatim. */
  message: string;
};

/**
 * Subset of Evidence columns the eligibility check needs. Keeping
 * the shape narrow (instead of `Prisma.Evidence`) means the service
 * can be called from the list mapper, the detail mapper, or a unit
 * test fixture without a full row.
 */
export type EvidenceDeleteEligibilityInput = {
  id: string;
  deletedAt: Date | string | null;
  lockedAt: Date | string | null;
  storageObjectLockMode: string | null;
  storageObjectLockRetainUntilUtc: Date | string | null;
  storageObjectLockLegalHoldStatus: string | null;
  retentionUntilUtc: Date | string | null;
};

function toDateOrNull(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  const d = toDateOrNull(value);
  return d ? d.toISOString() : null;
}

function formatDateForCopy(value: Date | string | null | undefined): string | null {
  const d = toDateOrNull(value);
  if (!d) return null;
  // YYYY-MM-DD keeps the copy locale-stable and never mangles month
  // ordering. The UI may reformat for display if it wants.
  return d.toISOString().slice(0, 10);
}

/**
 * Pure / synchronous half of the check. Uses ONLY fields already on
 * the evidence row — no extra DB roundtrips. Suitable for list-row
 * decoration where we cannot afford a per-record legal-hold lookup.
 *
 * The legal-hold branch is layered on top in
 * `computeEvidenceDeleteEligibility` (async), which calls this then
 * checks the EvidenceLegalHold table if no synchronous reason has
 * fired.
 */
export function computeEvidenceDeleteEligibilitySync(
  evidence: EvidenceDeleteEligibilityInput,
): EvidenceDeleteEligibility {
  // Precedence — match the existing backend route's check order
  // (assertEvidenceNotLocked → assertEvidenceDeletionAllowedByRetention →
  // canDeleteEvidence) so the surfaced reason matches what the API
  // would actually return on click.

  if (evidence.deletedAt) {
    return {
      canMoveToTrash: false,
      reasonCode: "ALREADY_DELETED",
      blockedUntil: null,
      message: "This record is already in trash.",
    };
  }

  if (evidence.lockedAt) {
    return {
      canMoveToTrash: false,
      reasonCode: "EVIDENCE_LOCKED",
      blockedUntil: null,
      message:
        "This record is permanently locked and cannot be moved to trash.",
    };
  }

  // Object Lock COMPLIANCE — mirrors assertEvidenceDeletionAllowedByRetention.
  const mode = String(evidence.storageObjectLockMode ?? "").toUpperCase();
  const olRetainUntil = toDateOrNull(evidence.storageObjectLockRetainUntilUtc);
  if (mode === "COMPLIANCE" && olRetainUntil && olRetainUntil.getTime() > Date.now()) {
    const human = formatDateForCopy(olRetainUntil);
    return {
      canMoveToTrash: false,
      reasonCode: "COMPLIANCE_RETENTION",
      blockedUntil: olRetainUntil.toISOString(),
      message: human
        ? `This record is protected by compliance retention until ${human}. It cannot be moved to trash before that date.`
        : "This record is protected by compliance retention and cannot be moved to trash while retention is active.",
    };
  }

  // Object Lock legal hold — `ON` means S3 has the hold engaged.
  if (
    String(evidence.storageObjectLockLegalHoldStatus ?? "").toUpperCase() === "ON"
  ) {
    return {
      canMoveToTrash: false,
      reasonCode: "LEGAL_HOLD",
      blockedUntil: null,
      message:
        "This record is under an active legal hold and cannot be moved to trash.",
    };
  }

  // Workspace retention until — the only generic retention deadline
  // not covered by Object Lock.
  const retentionUntil = toDateOrNull(evidence.retentionUntilUtc);
  if (retentionUntil && retentionUntil.getTime() > Date.now()) {
    const human = formatDateForCopy(retentionUntil);
    return {
      canMoveToTrash: false,
      reasonCode: "RETENTION_UNTIL",
      blockedUntil: retentionUntil.toISOString(),
      message: human
        ? `This record is protected by workspace retention until ${human}. It cannot be moved to trash before that date.`
        : "This record is protected by workspace retention and cannot be moved to trash while retention is active.",
    };
  }

  return {
    canMoveToTrash: true,
    reasonCode: null,
    blockedUntil: null,
    message: "",
  };
}

/**
 * Async variant — same precedence, plus a follow-up check against
 * the `evidence_legal_holds` table (mirrors
 * `isUnderActiveLegalHold` in governance.service.ts) when the
 * synchronous branch did not already block.
 *
 * Use this on single-record paths (Evidence Detail response). For
 * list views, prefer the sync variant + the Object Lock legal-hold
 * column which we already select.
 */
export async function computeEvidenceDeleteEligibility(
  evidence: EvidenceDeleteEligibilityInput,
  client: PrismaClient = defaultPrisma,
): Promise<EvidenceDeleteEligibility> {
  const sync = computeEvidenceDeleteEligibilitySync(evidence);
  if (!sync.canMoveToTrash) return sync;

  const activeHold = await client.evidenceLegalHold.findFirst({
    where: { evidenceId: evidence.id, status: prismaPkg.LegalHoldStatus.ACTIVE },
    select: { id: true },
  });
  if (activeHold) {
    return {
      canMoveToTrash: false,
      reasonCode: "LEGAL_HOLD",
      blockedUntil: null,
      message:
        "This record is under an active legal hold and cannot be moved to trash.",
    };
  }

  return sync;
}

// Re-export the field name used in the Evidence Detail response so
// the response builder and the frontend reader stay in sync via a
// single shared constant. Tests pin this name to catch drift.
export const DELETE_ELIGIBILITY_RESPONSE_FIELD = "deleteEligibility" as const;
