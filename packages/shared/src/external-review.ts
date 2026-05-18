/**
 * Phase 28-E — External review access lifecycle primitives.
 *
 * This module defines the typed lifecycle states + privacy-filter
 * projections an external reviewer (outside the workspace, given a
 * scoped share token) is allowed to see. The full token issuance /
 * revocation / expiration storage layer is a separate phase; this
 * module is the canonical decision + projection surface so the api
 * and worker can never agree to leak something they shouldn't.
 *
 * Hard rules:
 *   - Browser-safe. No Prisma, no Node.
 *   - State machine is closed and deterministic.
 *   - The privacy filter is a STRIPPING projection: it returns a
 *     reduced shape with the safe fields only. It cannot
 *     accidentally include an unlisted field because the returned
 *     type's properties are explicitly enumerated.
 *   - No path produces a free-form metadata leak.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Lifecycle state machine
// -----------------------------------------------------------------------------

export const EXTERNAL_REVIEW_ACCESS_STATES = [
  "INVITED",
  "ACTIVE",
  "EXPIRED",
  "REVOKED",
  "BLOCKED_BY_POLICY",
] as const;

export const ExternalReviewAccessStateSchema = z.enum(
  EXTERNAL_REVIEW_ACCESS_STATES,
);
export type ExternalReviewAccessState = z.infer<
  typeof ExternalReviewAccessStateSchema
>;

/**
 * Allowed transitions. Anything not listed is REJECTED by the
 * canonical evaluator. Terminal states (EXPIRED / REVOKED) have an
 * empty next-state set.
 */
const EXTERNAL_REVIEW_TRANSITIONS: Readonly<
  Record<ExternalReviewAccessState, ReadonlyArray<ExternalReviewAccessState>>
> = {
  INVITED: ["ACTIVE", "REVOKED", "EXPIRED", "BLOCKED_BY_POLICY"],
  ACTIVE: ["REVOKED", "EXPIRED", "BLOCKED_BY_POLICY"],
  // Terminal states.
  EXPIRED: [],
  REVOKED: [],
  // Soft-blocked by policy can recover if the policy lifts.
  BLOCKED_BY_POLICY: ["ACTIVE", "REVOKED", "EXPIRED"],
};

export function isAllowedExternalReviewTransition(
  from: ExternalReviewAccessState,
  to: ExternalReviewAccessState,
): boolean {
  if (from === to) return true;
  return EXTERNAL_REVIEW_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminalExternalReviewState(
  state: ExternalReviewAccessState,
): boolean {
  return state === "EXPIRED" || state === "REVOKED";
}

export function isActiveExternalReviewState(
  state: ExternalReviewAccessState,
): boolean {
  return state === "ACTIVE";
}

// -----------------------------------------------------------------------------
// Access-evaluation facts + decision
// -----------------------------------------------------------------------------

export type ExternalReviewAccessFacts = {
  state: ExternalReviewAccessState;
  /** ISO timestamp. Null means no expiration; the access lives until
   *  explicitly revoked. */
  expiresAtUtc: string | null;
  /** Now in ISO. Injected for deterministic testing. */
  nowIsoUtc?: string;
  /** Whether an active legal hold exists on the evidence. Hold can
   *  invalidate external access depending on policy. */
  hasActiveLegalHold: boolean;
  /** Whether workspace policy says external access auto-revokes on
   *  hold. Defaults true if absent. */
  workspaceRevokeExternalOnHold?: boolean;
  /** Whether the share's scoped artifact is governance-blocked
   *  (export/package gate already denied). */
  governanceBlocked: boolean;
};

export type ExternalReviewAccessDecision =
  | { allowed: true; reason: "active" }
  | {
      allowed: false;
      reason:
        | "not_active"
        | "expired"
        | "revoked"
        | "blocked_by_policy"
        | "invalidated_by_hold"
        | "blocked_by_governance";
    };

/**
 * Canonical decision: can this external reviewer access the share
 * RIGHT NOW? Inputs are facts; the caller gathers them from the
 * persistence layer.
 */
export function evaluateExternalReviewAccess(
  facts: ExternalReviewAccessFacts,
): ExternalReviewAccessDecision {
  // Hard terminal states fail first.
  if (facts.state === "REVOKED") return { allowed: false, reason: "revoked" };
  if (facts.state === "EXPIRED") return { allowed: false, reason: "expired" };
  if (facts.state === "BLOCKED_BY_POLICY")
    return { allowed: false, reason: "blocked_by_policy" };

  // Time-based expiry overrides ACTIVE state.
  const now = facts.nowIsoUtc ?? new Date().toISOString();
  if (facts.expiresAtUtc && facts.expiresAtUtc <= now) {
    return { allowed: false, reason: "expired" };
  }

  // Governance gate from snapshot — if the underlying export/package is
  // blocked, the external reviewer cannot bypass that.
  if (facts.governanceBlocked) {
    return { allowed: false, reason: "blocked_by_governance" };
  }

  // Hold invalidation per workspace policy.
  const revokeOnHold = facts.workspaceRevokeExternalOnHold ?? true;
  if (facts.hasActiveLegalHold && revokeOnHold) {
    return { allowed: false, reason: "invalidated_by_hold" };
  }

  // INVITED is not yet active — the reviewer must accept the invite
  // before reading anything.
  if (facts.state !== "ACTIVE") {
    return { allowed: false, reason: "not_active" };
  }

  return { allowed: true, reason: "active" };
}

// -----------------------------------------------------------------------------
// Privacy filter — STRIPPING projection
// -----------------------------------------------------------------------------

/**
 * The catalog of fields an external reviewer is allowed to see on
 * Evidence. The projection function NEVER returns properties outside
 * this list — adding a new field requires a code-review change here.
 */
export const EXTERNAL_REVIEW_EVIDENCE_SAFE_FIELDS = [
  "id",
  "type",
  "mimeType",
  "title",
  "displayFileName",
  "captureMethod",
  "capturedAtUtc",
  "uploadedAtUtc",
  "fileSizeBytes",
  // Lifecycle / governance state that's safe to surface:
  "lifecycleState",
  "verificationStatus",
  // Trust evidence (cryptographic — same as public-verify):
  "fileSha256",
  "fingerprintHash",
] as const;

export type ExternalReviewEvidenceProjection = {
  id: string;
  type: string | null;
  mimeType: string | null;
  title: string | null;
  displayFileName: string | null;
  captureMethod: string | null;
  capturedAtUtc: string | null;
  uploadedAtUtc: string | null;
  fileSizeBytes: number | null;
  lifecycleState: string | null;
  verificationStatus: string | null;
  fileSha256: string | null;
  fingerprintHash: string | null;
};

/**
 * Filter ANY evidence-shaped row down to the projection an external
 * reviewer is allowed to see. NEVER returns fields outside the
 * allow-list, even if the input carries them. This is the only safe
 * way to ship an evidence row to an external reviewer.
 */
export function projectEvidenceForExternalReview(
  raw: Record<string, unknown>,
): ExternalReviewEvidenceProjection {
  const pick = (key: string): unknown => raw[key] ?? null;
  return {
    id: String(pick("id") ?? ""),
    type: maybeString(pick("type")),
    mimeType: maybeString(pick("mimeType")),
    title: maybeString(pick("title")),
    displayFileName: maybeString(pick("displayFileName")),
    captureMethod: maybeString(pick("captureMethod")),
    capturedAtUtc: maybeIso(pick("capturedAtUtc")),
    uploadedAtUtc: maybeIso(pick("uploadedAtUtc")),
    fileSizeBytes:
      typeof pick("fileSizeBytes") === "number"
        ? (pick("fileSizeBytes") as number)
        : null,
    lifecycleState: maybeString(pick("lifecycleState")),
    verificationStatus: maybeString(pick("verificationStatus")),
    fileSha256: maybeString(pick("fileSha256")),
    fingerprintHash: maybeString(pick("fingerprintHash")),
  };
}

/**
 * The catalog of fields an external reviewer MUST NOT see. Used by
 * the test suite to assert the projection cannot regress.
 */
export const EXTERNAL_REVIEW_EVIDENCE_FORBIDDEN_FIELDS = [
  "internalNotes",
  "submittedByEmail",
  "submittedByUserId",
  "createdByUserId",
  "uploadedByUserId",
  "lastAccessedByUserId",
  "ownerUserId",
  "teamId",
  "organizationId",
  "signatureBase64",
  "publicKeyPem",
  "tsaTokenBase64",
  "otsProofBase64",
  "storageBucket",
  "storageKey",
  "storageRegion",
  // Operator-only governance fields:
  "activeDestructionReviewId",
  "retentionPolicyVersionId",
] as const;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function maybeString(value: unknown): string | null {
  if (typeof value === "string") return value;
  return null;
}

function maybeIso(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return null;
}
