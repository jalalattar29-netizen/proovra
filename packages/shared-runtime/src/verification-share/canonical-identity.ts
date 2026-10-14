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

/**
 * Ensure the record has its canonical reference, in the caller's transaction.
 * Returns the existing reference when there is one — it is NEVER replaced — and
 * otherwise mints, stores (conditional on still being NULL, so two concurrent
 * issuers converge on one value) and records VERIFICATION_REFERENCE_ISSUED.
 */
export async function ensureVerificationRefTx(
  tx: Prisma.TransactionClient,
  evidenceId: string,
  options: { now?: Date; source?: string } = {},
): Promise<{ ref: string; issued: boolean }> {
  const existing = await tx.evidence.findUnique({
    where: { id: evidenceId },
    select: { verificationRef: true },
  });
  if (!existing) throw new Error(`ensureVerificationRefTx: evidence ${evidenceId} not found`);
  if (existing.verificationRef) return { ref: existing.verificationRef, issued: false };

  const now = options.now ?? new Date();
  // A 160-bit collision is not a practical event; the loop only exists so the
  // UNIQUE index, not chance, is what guarantees a reference is never shared.
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = generateVerificationRef();
    try {
      const updated = await tx.evidence.updateMany({
        where: { id: evidenceId, verificationRef: null },
        data: { verificationRef: candidate, verificationRefIssuedAtUtc: now },
      });
      if (updated.count === 0) {
        const winner = await tx.evidence.findUniqueOrThrow({
          where: { id: evidenceId },
          select: { verificationRef: true },
        });
        if (winner.verificationRef) return { ref: winner.verificationRef, issued: false };
        continue;
      }
      await appendCustodyEventTx(tx, {
        evidenceId,
        eventType: "VERIFICATION_REFERENCE_ISSUED",
        atUtc: now,
        // The reference itself is public; recording it binds the identity to
        // the custody chain so a later dispute can prove which link was issued.
        payload: { verificationRef: candidate, source: options.source ?? "ISSUANCE" },
      });
      return { ref: candidate, issued: true };
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") continue;
      throw err;
    }
  }
  throw new Error(`ensureVerificationRefTx: could not issue a unique reference for ${evidenceId}`);
}
