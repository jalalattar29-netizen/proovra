/**
 * THE CANONICAL VERIFICATION IDENTITY AUTHORITY (owner decision 2026-10-14).
 *
 * Every evidence record for which PROOVRA issues a report has ONE permanent
 * public verification reference, `evidence.verification_ref`:
 *
 *   - `pvr_` + 27 base64url characters = 160 bits from the CSPRNG — never
 *     sequential, never derived from the Evidence ID, never guessable;
 *   - issued BEFORE Report v1 is rendered, so the QR code, the report text, the
 *     verification package and the Evidence page button all carry it;
 *   - the same for every later report/package version of the record;
 *   - never reassigned, never cleared, never reused (UNIQUE index plus the
 *     `evidence_verification_ref_set_once` trigger), including on the purge
 *     tombstone — an old printed report must never open a different record.
 *
 * It is a public REFERENCE, not a capability. The page it opens verifies the
 * record from verification-safe facts only and never serves original files,
 * reports or packages: obscurity is not what protects sensitive material.
 * Restricted recipient links (`pvs_` share tokens, ./authority.ts) remain a
 * separate feature with expiry, revocation and use limits.
 *
 * This module is the one place that mints references, builds the canonical
 * URL and resolves the page's availability state, for the API (owner surface,
 * public route) and the worker (report and package issuance).
 */
import { randomBytes } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { appendCustodyEventTx } from "../custody/custody-chain.js";

export const VERIFICATION_REF_PREFIX = "pvr_";
/** 20 random bytes → 27 base64url characters (160 bits). */
const REF_BODY = /^[A-Za-z0-9_-]{27}$/;

export function generateVerificationRef(): string {
  return `${VERIFICATION_REF_PREFIX}${randomBytes(20).toString("base64url")}`;
}

/** Is this string SHAPED like a canonical reference? (Shape only.) */
export function isVerificationRefShape(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === VERIFICATION_REF_PREFIX.length + 27 &&
    value.startsWith(VERIFICATION_REF_PREFIX) &&
    REF_BODY.test(value.slice(VERIFICATION_REF_PREFIX.length))
  );
}

/** The canonical page path. Every surface builds the link through this. */
export function canonicalVerificationPath(ref: string): string {
  return `/verify/${ref}`;
}

/**
 * The absolute canonical URL. `base` is the deployment's verify base
 * (e.g. `https://app.proovra.com/verify`); a trailing slash is tolerated.
 */
export function canonicalVerificationUrl(base: string, ref: string): string {
  return `${base.replace(/\/+$/, "")}/${ref}`;
}

export const VERIFICATION_ACCESS_STATES = ["AVAILABLE", "WITHDRAWN", "SUSPENDED"] as const;
export type VerificationAccessState = (typeof VERIFICATION_ACCESS_STATES)[number];

export const VERIFICATION_WITHDRAWAL_REASONS = [
  "LEGAL_REQUEST",
  "PRIVACY_REQUEST",
  "SECURITY_INCIDENT",
  "OPERATOR_REVIEW",
] as const;
export type VerificationWithdrawalReason = (typeof VERIFICATION_WITHDRAWAL_REASONS)[number];

/**
 * What the canonical page says about the record. The order is the precedence:
 * a purged record is PURGED whatever else is true; a withdrawn page says so
 * even while the record is retained.
 */
export type CanonicalVerificationStatus =
  | "PURGED"
  | "WITHDRAWN"
  | "TEMPORARILY_UNAVAILABLE"
  | "RETAINED"
  | "AVAILABLE";

export function resolveCanonicalVerificationStatus(row: {
  lifecycleState: string;
  destroyedAtUtc?: Date | null;
  verificationAccessState: string | null | undefined;
}): CanonicalVerificationStatus {
  if (row.lifecycleState === "DESTROYED" || row.destroyedAtUtc) return "PURGED";
  if (row.verificationAccessState === "WITHDRAWN") return "WITHDRAWN";
  if (row.verificationAccessState === "SUSPENDED") return "TEMPORARILY_UNAVAILABLE";
  if (
    row.lifecycleState === "TRASHED" ||
    row.lifecycleState === "RETENTION_ARCHIVED" ||
    row.lifecycleState === "PENDING_DESTRUCTION"
  ) {
    return "RETAINED";
  }
  return "AVAILABLE";
}

// =============================================================================
// ELIGIBILITY — the ONE rule every issuer and every projection reads.
// =============================================================================
//
// A record earns its permanent canonical reference when it is finalized
// (signed) and still an active, intact record. Publication (the historical
// `public_verify_state`) is NOT part of this: the canonical page never depends
// on owner publication. Refusals carry their reason; nothing is issued for a
// deleted, destroyed, archived/retained or integrity-failed record, and a
// record that already holds a reference keeps it (it is never removed or
// rotated — the page then states the record's lifecycle truthfully).

export const CANONICAL_VERIFICATION_REFUSALS = [
  "NOT_FOUND",
  "NOT_FINALIZED",
  "DELETED",
  "DESTROYED",
  "ARCHIVED",
  "INTEGRITY_FAILED",
] as const;
export type CanonicalVerificationRefusal = (typeof CANONICAL_VERIFICATION_REFUSALS)[number];

export type CanonicalVerificationEligibilityFacts = {
  status: string | null | undefined;
  lifecycleState: string | null | undefined;
  deletedAt?: Date | null;
  destroyedAtUtc?: Date | null;
  integrityCheckOutcome?: string | null;
};

/** The columns eligibility reads — select exactly these. */
export const CANONICAL_VERIFICATION_ELIGIBILITY_SELECT = {
  status: true,
  lifecycleState: true,
  deletedAt: true,
  destroyedAtUtc: true,
  integrityCheckOutcome: true,
} as const;

export function resolveCanonicalVerificationEligibility(
  row: CanonicalVerificationEligibilityFacts | null | undefined,
): { eligible: true } | { eligible: false; reason: CanonicalVerificationRefusal } {
  if (!row) return { eligible: false, reason: "NOT_FOUND" };
  if (row.lifecycleState === "DESTROYED" || row.destroyedAtUtc) return { eligible: false, reason: "DESTROYED" };
  if (row.deletedAt) return { eligible: false, reason: "DELETED" };
  if (row.lifecycleState && row.lifecycleState !== "ACTIVE") return { eligible: false, reason: "ARCHIVED" };
  if (row.status === "FAILED_HASH_MISMATCH" || row.integrityCheckOutcome === "FAILED") {
    return { eligible: false, reason: "INTEGRITY_FAILED" };
  }
  if (row.status !== "SIGNED" && row.status !== "REPORTED") return { eligible: false, reason: "NOT_FINALIZED" };
  return { eligible: true };
}

export type EnsureVerificationRefResult =
  | { ref: string; issued: boolean; refused: null }
  | { ref: null; issued: false; refused: CanonicalVerificationRefusal };

/**
 * Ensure the record has its canonical reference, in the caller's transaction.
 *
 *   - A record that already holds a reference gets it back — it is NEVER
 *     replaced, rotated or removed, whatever its state now.
 *   - An ineligible record without one is REFUSED with its reason; nothing is
 *     written.
 *   - Otherwise a reference is minted and stored conditionally on the column
 *     still being NULL. A concurrent issuer blocks on the row lock and then
 *     matches zero rows, so both converge on the ONE stored value; the UNIQUE
 *     index and the set-once trigger back this up in the database. Exactly one
 *     VERIFICATION_REFERENCE_ISSUED custody event is appended, by the winner.
 */
export async function ensureVerificationRefTx(
  tx: Prisma.TransactionClient,
  evidenceId: string,
  options: { now?: Date; source?: string } = {},
): Promise<EnsureVerificationRefResult> {
  const row = await tx.evidence.findUnique({
    where: { id: evidenceId },
    select: { verificationRef: true, ...CANONICAL_VERIFICATION_ELIGIBILITY_SELECT },
  });
  if (row?.verificationRef) return { ref: row.verificationRef, issued: false, refused: null };
  const eligibility = resolveCanonicalVerificationEligibility(row);
  if (!eligibility.eligible) return { ref: null, issued: false, refused: eligibility.reason };

  const now = options.now ?? new Date();
  // 160 random bits: a collision is not a practical event, and the UNIQUE
  // index (not chance) guarantees a reference is never shared. A violation
  // aborts the caller's transaction, so it is surfaced, not retried here.
  const candidate = generateVerificationRef();
  const updated = await tx.evidence.updateMany({
    where: { id: evidenceId, verificationRef: null },
    data: { verificationRef: candidate, verificationRefIssuedAtUtc: now },
  });
  if (updated.count === 0) {
    const winner = await tx.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { verificationRef: true } });
    if (winner.verificationRef) return { ref: winner.verificationRef, issued: false, refused: null };
    throw new Error(`ensureVerificationRefTx: evidence ${evidenceId} could not be updated`);
  }
  await appendCustodyEventTx(tx, {
    evidenceId,
    eventType: "VERIFICATION_REFERENCE_ISSUED",
    atUtc: now,
    // The reference itself is public; recording it binds the identity to the
    // custody chain so a later dispute can prove which link was issued.
    payload: { verificationRef: candidate, source: options.source ?? "ISSUANCE" },
  });
  return { ref: candidate, issued: true, refused: null };
}

// =============================================================================
// THE CANONICAL VERIFICATION CONTRACT — what every owner surface receives.
// =============================================================================

export type CanonicalVerificationAccessStatus = CanonicalVerificationStatus | "NOT_ISSUED";

export type CanonicalVerificationProjection = {
  /** NOT_ISSUED until the record has a reference; then the page's own status. */
  status: CanonicalVerificationAccessStatus;
  reference: string | null;
  /** Relative canonical path (`/verify/pvr_…`), present whenever a reference exists. */
  verifyPath: string | null;
  issuedAtUtc: string | null;
  /** Why no reference exists (eligibility), or null when it exists / will be issued. */
  refusalReason: CanonicalVerificationRefusal | null;
};

/** The columns the projection reads — select exactly these. */
export const CANONICAL_VERIFICATION_PROJECTION_SELECT = {
  ...CANONICAL_VERIFICATION_ELIGIBILITY_SELECT,
  verificationRef: true,
  verificationRefIssuedAtUtc: true,
  verificationAccessState: true,
} as const;

export function projectCanonicalVerification(
  row:
    | (CanonicalVerificationEligibilityFacts & {
        verificationRef: string | null;
        verificationRefIssuedAtUtc: Date | null;
        verificationAccessState: string | null;
      })
    | null
    | undefined,
): CanonicalVerificationProjection {
  if (row?.verificationRef) {
    return {
      status: resolveCanonicalVerificationStatus({
        lifecycleState: row.lifecycleState ?? "ACTIVE",
        destroyedAtUtc: row.destroyedAtUtc ?? null,
        verificationAccessState: row.verificationAccessState,
      }),
      reference: row.verificationRef,
      verifyPath: canonicalVerificationPath(row.verificationRef),
      issuedAtUtc: row.verificationRefIssuedAtUtc ? row.verificationRefIssuedAtUtc.toISOString() : null,
      refusalReason: null,
    };
  }
  const eligibility = resolveCanonicalVerificationEligibility(row);
  return {
    status: "NOT_ISSUED",
    reference: null,
    verifyPath: null,
    issuedAtUtc: null,
    refusalReason: eligibility.eligible ? null : eligibility.reason,
  };
}
