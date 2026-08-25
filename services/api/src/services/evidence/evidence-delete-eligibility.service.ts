/**
 * The Evidence lifecycle PROJECTION for API responses — a mapper, not an
 * authority.
 *
 * WHAT THIS FILE USED TO BE
 * ---------------------------------------------------------------------------
 * A second implementation of the retention rules. It carried its own precedence
 * chain — already-deleted, locked, Object Lock COMPLIANCE, S3 legal-hold flag,
 * `retentionUntilUtc` — with a docstring instructing the reader to keep it in
 * step with the route's guards and with the frontend's copy of the same chain.
 * Three hand-synchronised implementations of one rule; they disagreed, and the
 * disagreement is what shipped "this record cannot be moved to trash until
 * 2034" to users for an operation that deletes nothing.
 *
 * WHAT IT IS NOW
 * ---------------------------------------------------------------------------
 * A translation from persisted columns to the wire shape, with the decision
 * made by `computeEvidenceLifecycleCapabilities` in `@proovra/shared` — the
 * same function the write path calls, so what a response advertises and what a
 * click actually does cannot diverge.
 *
 * The legacy `deleteEligibility` field is still emitted alongside the new
 * `lifecycle` projection, DERIVED FROM IT rather than computed beside it, so a
 * client that has not been updated keeps working and cannot be told something
 * the canonical authority did not say.
 */

import type { PrismaClient } from "@prisma/client";
import {
  toEvidenceLifecycleProjection,
  type EvidenceLifecycleProjection,
  type EvidenceRetentionLifecycleInput,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { evaluateEffectiveLegalHold } from "../governance/effective-legal-hold.js";

/**
 * Legacy reason vocabulary.
 *
 * Retained EXACTLY as it was so existing clients keep parsing, but every value
 * is now derived from a canonical block reason rather than decided here. Note
 * what can no longer appear: `COMPLIANCE_RETENTION` and `RETENTION_UNTIL` are
 * unreachable, because no retention deadline blocks a recoverable trash any
 * more. They stay in the union because removing a literal from a published
 * contract breaks clients that switch on it exhaustively.
 */
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
 * Subset of Evidence columns the projection needs. Narrow so the list mapper,
 * the detail mapper and a test fixture can all satisfy it.
 */
export type EvidenceLifecycleProjectionInput = {
  id: string;
  teamId?: string | null;
  lifecycleState?: string | null;
  archivedAt?: Date | string | null;
  deletedAt: Date | string | null;
  destroyedAtUtc?: Date | string | null;
  lockedAt: Date | string | null;
  deleteScheduledForUtc?: Date | string | null;
  storageObjectLockMode: string | null;
  storageObjectLockRetainUntilUtc: Date | string | null;
  storageObjectLockLegalHoldStatus: string | null;
  retentionUntilUtc: Date | string | null;
};

/** Kept as an alias so existing imports do not churn. */
export type EvidenceDeleteEligibilityInput = EvidenceLifecycleProjectionInput;

/**
 * The persisted Evidence row → the projection's input, in ONE place.
 *
 * Every response that carries the lifecycle projection needs the same fifteen
 * columns mapped the same way, and the mapping was written out longhand at the
 * call site. That is how the Evidence Details page came to have no projection
 * at all: `GET /v1/evidence/:id` had the mapping, `review-workspace` — the
 * request the page ACTUALLY makes — did not, and nothing connected the two.
 *
 * Deliberately structural (`Pick`-shaped), so a route that selects fewer
 * columns fails to compile rather than silently projecting nulls into a
 * lifecycle verdict.
 */
export function toEvidenceLifecycleProjectionInput(evidence: {
  id: string;
  teamId?: string | null;
  lifecycleState?: string | null;
  archivedAt?: Date | string | null;
  deletedAt: Date | string | null;
  destroyedAtUtc?: Date | string | null;
  lockedAt: Date | string | null;
  deleteScheduledForUtc?: Date | string | null;
  storageObjectLockMode: string | null;
  storageObjectLockRetainUntilUtc: Date | string | null;
  storageObjectLockLegalHoldStatus: string | null;
  retentionUntilUtc: Date | string | null;
}): EvidenceLifecycleProjectionInput {
  return {
    id: evidence.id,
    teamId: evidence.teamId ?? null,
    lifecycleState: evidence.lifecycleState ?? null,
    archivedAt: evidence.archivedAt ?? null,
    deletedAt: evidence.deletedAt ?? null,
    destroyedAtUtc: evidence.destroyedAtUtc ?? null,
    lockedAt: evidence.lockedAt ?? null,
    deleteScheduledForUtc: evidence.deleteScheduledForUtc ?? null,
    storageObjectLockMode: evidence.storageObjectLockMode ?? null,
    storageObjectLockRetainUntilUtc:
      evidence.storageObjectLockRetainUntilUtc ?? null,
    storageObjectLockLegalHoldStatus:
      evidence.storageObjectLockLegalHoldStatus ?? null,
    retentionUntilUtc: evidence.retentionUntilUtc ?? null,
  };
}

function toAuthorityInput(
  evidence: EvidenceLifecycleProjectionInput,
  legalHold: boolean,
): EvidenceRetentionLifecycleInput {
  return {
    lifecycleState: evidence.lifecycleState ?? null,
    archivedAt: evidence.archivedAt ?? null,
    trashedAt: evidence.deletedAt,
    destroyedAt: evidence.destroyedAtUtc ?? null,
    lockedAt: evidence.lockedAt,
    trashGraceUntil: evidence.deleteScheduledForUtc ?? null,
    appRetentionUntil: evidence.retentionUntilUtc,
    objectLockRetainUntil: evidence.storageObjectLockRetainUntilUtc,
    objectLockMode: evidence.storageObjectLockMode,
    legalHold,
  };
}

/**
 * SYNCHRONOUS projection, for list rows.
 *
 * The hold input is the S3 Object Lock legal-hold COLUMN, which is a weaker
 * signal than the union evaluator: it cannot see a case-scoped or
 * workspace-scoped application hold. That limitation is the same one the
 * pre-convergence list path had and is accepted for the same reason — a list of
 * 50 rows cannot afford 50 hold lookups — but it is now bounded to a DISPLAY
 * hint. Nothing acts on it: every write re-resolves the hold through the union
 * evaluator inside the canonical lifecycle service, so a row that looks
 * trashable and is not produces a refusal, never a trashing.
 */
export function projectEvidenceLifecycleSync(
  evidence: EvidenceLifecycleProjectionInput,
  now: Date = new Date(),
): EvidenceLifecycleProjection {
  const legalHold =
    String(evidence.storageObjectLockLegalHoldStatus ?? "").toUpperCase() === "ON";
  return toEvidenceLifecycleProjection(toAuthorityInput(evidence, legalHold), now);
}

/**
 * ASYNC projection, for single-record responses.
 *
 * Uses THE union legal-hold evaluator (evidence + case + workspace stores) and
 * FAILS CLOSED: if the hold status cannot be established, the projection
 * reports a hold, so the surface advertises "you cannot change this" rather
 * than inviting an action that will be refused.
 */
export async function projectEvidenceLifecycle(
  evidence: EvidenceLifecycleProjectionInput,
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<EvidenceLifecycleProjection> {
  let legalHold = true;
  try {
    let teamId = evidence.teamId ?? null;
    if (evidence.teamId === undefined) {
      const row = await client.evidence.findUnique({
        where: { id: evidence.id },
        select: { teamId: true },
      });
      teamId = row?.teamId ?? null;
    }
    const held = await evaluateEffectiveLegalHold(client, {
      teamId,
      evidenceId: evidence.id,
    });
    legalHold = held.held;
  } catch {
    // FAIL CLOSED — see the docstring.
    legalHold = true;
  }
  return toEvidenceLifecycleProjection(toAuthorityInput(evidence, legalHold), now);
}

/**
 * The legacy `deleteEligibility` shape, DERIVED from the canonical projection.
 *
 * One translation table, no second decision. `COMPLIANCE_RETENTION` and
 * `RETENTION_UNTIL` have no case here because the authority cannot produce a
 * retention-based trash refusal — which is precisely the bug this convergence
 * removed, so re-introducing a mapping for them would re-introduce it.
 */
export function toLegacyDeleteEligibility(
  projection: EvidenceLifecycleProjection,
): EvidenceDeleteEligibility {
  if (projection.canTrash) {
    return {
      canMoveToTrash: true,
      reasonCode: null,
      blockedUntil: null,
      message: "",
    };
  }
  switch (projection.trashBlockReason) {
    case "ALREADY_IN_STATE":
      return {
        canMoveToTrash: false,
        reasonCode: "ALREADY_DELETED",
        blockedUntil: null,
        message: "This record is already in the trash.",
      };
    case "TERMINAL_DESTROYED":
      return {
        canMoveToTrash: false,
        reasonCode: "ALREADY_DELETED",
        blockedUntil: null,
        message: "This record has been destroyed. Only its tombstone remains.",
      };
    case "EVIDENCE_LOCKED":
      return {
        canMoveToTrash: false,
        reasonCode: "EVIDENCE_LOCKED",
        blockedUntil: null,
        message:
          "This record is permanently locked and cannot be moved to trash.",
      };
    case "LEGAL_HOLD_ACTIVE":
      return {
        canMoveToTrash: false,
        reasonCode: "LEGAL_HOLD",
        blockedUntil: null,
        message:
          "This record is under an active legal hold. It cannot be archived or moved to trash while the hold stands.",
      };
    default:
      return {
        canMoveToTrash: false,
        reasonCode: "UNKNOWN",
        blockedUntil: null,
        message: "This record cannot be moved to trash right now.",
      };
  }
}

/**
 * Back-compatible entry point for the Evidence Detail response.
 *
 * Same name and same return shape as before so its call sites do not churn;
 * everything behind it is now the canonical authority.
 */
export async function computeEvidenceDeleteEligibility(
  evidence: EvidenceLifecycleProjectionInput,
  client: PrismaClient = defaultPrisma,
): Promise<EvidenceDeleteEligibility> {
  return toLegacyDeleteEligibility(await projectEvidenceLifecycle(evidence, client));
}

/** Synchronous legacy shape, for list rows. */
export function computeEvidenceDeleteEligibilitySync(
  evidence: EvidenceLifecycleProjectionInput,
): EvidenceDeleteEligibility {
  return toLegacyDeleteEligibility(projectEvidenceLifecycleSync(evidence));
}

// The response field names, exported so the response builders and the frontend
// readers share one literal and tests can pin them.
export const DELETE_ELIGIBILITY_RESPONSE_FIELD = "deleteEligibility" as const;
export { EVIDENCE_LIFECYCLE_RESPONSE_FIELD } from "@proovra/shared";
