/**
 * Evidence lifecycle — PRESENTATION MAPPER. No decisions live here.
 *
 * WHAT THIS FILE USED TO BE
 * ---------------------------------------------------------------------------
 * A client-side mirror of the backend's retention rules: it parsed
 * `storageObjectLockMode`, `storageObjectLockRetainUntilUtc`,
 * `storageObjectLockLegalHoldStatus` and `retentionUntilUtc` off the evidence
 * row and decided for itself whether the record could be moved to trash. Its
 * own docstring said the precedence "MUST match" the backend's — an instruction
 * to two codebases to stay in step by hand, which is the shape of every drift
 * bug this convergence closed.
 *
 * It also could not have been right. The legal-hold tables are not on the
 * evidence row and are not reachable from a browser, so the mirror's
 * "no hold, go ahead" was a guess. And it blocked trash on retention, which
 * produced the copy this whole pass exists to remove: telling a user that a
 * record retained until 2034 could not be moved to trash until 2034, for an
 * operation that deletes nothing and restores intact.
 *
 * WHAT IT IS NOW
 * ---------------------------------------------------------------------------
 * A reader of `evidence.lifecycle` — the canonical projection the API computes
 * from `@proovra/shared`'s single authority, the same function the write path
 * calls. Every function below either reads a field off that projection or
 * formats one for display. There is no branch in this file that decides whether
 * an action is available; if the projection is missing, the answer is "no",
 * because a client that cannot see the verdict must not invent one.
 */

import type {
  EvidenceDeleteEligibility,
  EvidenceDeleteReasonCode,
  EvidenceLifecycleProjection,
  EvidenceListItem,
  EvidenceRecord,
} from "./evidence-library-types";

/** Anything the API returns that may carry the canonical projection. */
export type EvidenceLifecycleCandidate = {
  lifecycle?: EvidenceLifecycleProjection | null;
  /** Legacy field, still read as a fallback for responses not yet migrated. */
  deleteEligibility?: EvidenceDeleteEligibility | null;
};

/**
 * The projection, or null.
 *
 * Null means "this response predates the convergence or the record was not
 * loaded". Callers treat null as "no lifecycle action is available", never as
 * "everything is available".
 */
export function getEvidenceLifecycle(
  evidence:
    | EvidenceLifecycleCandidate
    | EvidenceRecord
    | EvidenceListItem
    | null
    | undefined,
): EvidenceLifecycleProjection | null {
  if (!evidence) return null;
  const projection = (evidence as EvidenceLifecycleCandidate).lifecycle;
  if (projection && typeof projection === "object" && "productState" in projection) {
    return projection;
  }
  return null;
}

/**
 * Trash availability + the reason, for rendering.
 *
 * The legacy `deleteEligibility` field is consulted ONLY when the canonical
 * projection is absent, and it is consulted verbatim — the server computed it,
 * derived from the same authority. There is no third path where this file
 * computes something.
 */
export function getEvidenceDeletionEligibility(
  evidence:
    | EvidenceLifecycleCandidate
    | EvidenceRecord
    | EvidenceListItem
    | null
    | undefined,
): EvidenceDeleteEligibility {
  const lifecycle = getEvidenceLifecycle(evidence);
  if (lifecycle) {
    return {
      canMoveToTrash: lifecycle.canTrash,
      reasonCode: lifecycle.canTrash ? null : mapReasonCode(lifecycle),
      blockedUntil: null,
      message: lifecycle.canTrash ? "" : mapReasonMessage(lifecycle),
    };
  }

  const legacy = (evidence as EvidenceLifecycleCandidate | null)?.deleteEligibility;
  if (legacy && typeof legacy === "object" && "canMoveToTrash" in legacy) {
    return legacy;
  }

  // No projection and no legacy field. Refuse rather than guess: a disabled
  // control that should have been enabled is a moment's confusion; an enabled
  // control that should have been disabled is an action the server will reject
  // after the user has committed to it.
  return {
    canMoveToTrash: false,
    reasonCode: "UNKNOWN",
    blockedUntil: null,
    message: "Record state is loading. Try again in a moment.",
  };
}

function mapReasonCode(
  lifecycle: EvidenceLifecycleProjection,
): EvidenceDeleteReasonCode {
  switch (lifecycle.trashBlockReason) {
    case "LEGAL_HOLD_ACTIVE":
      return "LEGAL_HOLD";
    case "EVIDENCE_LOCKED":
      return "EVIDENCE_LOCKED";
    case "ALREADY_IN_STATE":
    case "TERMINAL_DESTROYED":
      return "ALREADY_DELETED";
    default:
      return "UNKNOWN";
  }
}

function mapReasonMessage(lifecycle: EvidenceLifecycleProjection): string {
  switch (lifecycle.trashBlockReason) {
    case "LEGAL_HOLD_ACTIVE":
      // A hold blocks archive as well as trash, so naming only trash would
      // leave the user wondering where the Archive button went.
      return "This record is under an active legal hold. It cannot be archived or moved to trash while the hold stands.";
    case "EVIDENCE_LOCKED":
      return "This record is permanently locked and cannot be moved to trash.";
    case "TERMINAL_DESTROYED":
      return "This record has been destroyed. Only its tombstone remains.";
    case "ALREADY_IN_STATE":
      return "This record is already in the trash.";
    default:
      return "This record cannot be moved to trash right now.";
  }
}

// ---------------------------------------------------------------------------
// Retention display — SEPARATE from availability, deliberately
// ---------------------------------------------------------------------------

/**
 * Locale-stable short date. `Jun 14, 2034`.
 */
export function formatLifecycleDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export type RetentionPosture = {
  /** "Retained until Jun 14, 2034", or null when nothing retains it. */
  retainedUntilLabel: string | null;
  /** "Object Lock: Compliance", or null. */
  objectLockLabel: string | null;
  /**
   * The one honest sentence about what retention actually prevents.
   *
   * It says PHYSICAL DESTRUCTION, because that is the only thing retention
   * blocks. The record can still be archived and still be moved to trash while
   * this is showing — which is exactly the distinction the old copy collapsed.
   */
  destructionNote: string | null;
  legalHold: boolean;
};

/**
 * Retention facts for display, reported INDEPENDENTLY of what the user can do.
 *
 * The two were entangled before: retention was surfaced only as the reason an
 * action was unavailable, so a retained record could only ever be described in
 * terms of something it stopped you doing. Now the panel states the retention
 * posture as a fact about the record, and the action buttons state their own
 * availability, and neither is expressed in the other's terms.
 */
export function getRetentionPosture(
  evidence:
    | EvidenceLifecycleCandidate
    | EvidenceRecord
    | EvidenceListItem
    | null
    | undefined,
): RetentionPosture {
  const lifecycle = getEvidenceLifecycle(evidence);
  if (!lifecycle) {
    return {
      retainedUntilLabel: null,
      objectLockLabel: null,
      destructionNote: null,
      legalHold: false,
    };
  }

  const until = formatLifecycleDate(lifecycle.effectiveRetentionUntilUtc);
  const retained =
    until !== null &&
    new Date(lifecycle.effectiveRetentionUntilUtc as string).getTime() >
      Date.now();

  return {
    retainedUntilLabel: retained ? `Retained until ${until}` : null,
    objectLockLabel: lifecycle.objectLockCompliance
      ? "Object Lock: Compliance"
      : null,
    destructionNote: retained
      ? `Physical destruction unavailable until ${until}`
      : null,
    legalHold: lifecycle.legalHold,
  };
}

// Re-exported for callers that just need the types.
export type {
  EvidenceDeleteEligibility,
  EvidenceDeleteReasonCode,
  EvidenceLifecycleProjection,
};

/**
 * Guidance shown beside a disabled trash control.
 *
 * Reworded: the old copy said archive "preserv[es] it under retention", which
 * implied archive was the thing retention permitted and trash was the thing it
 * forbade. Retention permits both. Archive is offered here because it is the
 * action that keeps the record in easy reach, not because trash is blocked.
 */
export const ARCHIVE_AS_ALTERNATIVE_COPY =
  "Archive removes the record from Active evidence and keeps it fully available." as const;
