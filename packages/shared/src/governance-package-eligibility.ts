/**
 * Phase 28-D — Canonical verification-package eligibility decision.
 *
 * Mirrors `canonicalEvaluateExportEligibility` (which gates compliance
 * exports) but adds the immutable-storage-drift signal as an
 * additional blocker. Package generation is the heaviest external-
 * facing artifact emission the platform performs; it MUST refuse to
 * run while the DB / object-lock state disagrees about whether the
 * underlying evidence is immutable.
 *
 * Hard rules:
 *   - Browser-safe. No Prisma, no Node imports.
 *   - The caller supplies the facts (review state, hold state,
 *     lifecycle state, immutable drift). This module never reads
 *     from the database.
 *   - This module never returns ALLOWED on a record under hold,
 *     under destruction review (non-terminal), in a destruction-
 *     pending lifecycle state, or with an open immutable-drift
 *     incident. Same precedence as the export gate.
 *   - Storage drift surfaces as a STORAGE-GOVERNANCE blocker — never
 *     as evidence of content manipulation. The label and reason are
 *     bounded-catalog and never imply tamper.
 */

import {
  canonicalEvaluateExportEligibility,
  type CanonicalExportFacts,
  type CanonicalExportOutcome,
} from "./canonical-decisions.js";

// -----------------------------------------------------------------------------
// Decision shape
// -----------------------------------------------------------------------------

export const PACKAGE_ELIGIBILITY_OUTCOMES = [
  "ALLOWED",
  "BLOCKED_BY_HOLD",
  "BLOCKED_BY_LIFECYCLE",
  "BLOCKED_BY_REVIEW_GATE",
  "BLOCKED_BY_IMMUTABLE_DRIFT",
] as const;

export type PackageEligibilityOutcome =
  (typeof PACKAGE_ELIGIBILITY_OUTCOMES)[number];

export type CanonicalPackageFacts = CanonicalExportFacts & {
  /** True when an OPEN OperationalIncident exists for this evidence
   *  with runbookSlug = "immutable-drift" (raised by the immutable-
   *  storage-reconciliation worker). */
  hasOpenImmutableDriftIncident: boolean;
};

export type CanonicalPackageDecision = {
  outcome: PackageEligibilityOutcome;
  reason: string;
};

/**
 * Decide whether a verification package may be generated for this
 * evidence record RIGHT NOW. Returns the same shape as the export
 * decision plus an additional `BLOCKED_BY_IMMUTABLE_DRIFT` outcome.
 *
 * Precedence (most-restrictive wins):
 *   1. Hold (direct or case)        → BLOCKED_BY_HOLD
 *   2. Lifecycle (destroyed / pending destruction / on hold / retention-locked)
 *                                   → BLOCKED_BY_LIFECYCLE
 *   3. Non-terminal destruction review
 *                                   → BLOCKED_BY_REVIEW_GATE
 *   4. Immutable storage drift      → BLOCKED_BY_IMMUTABLE_DRIFT
 *   5. Everything else              → ALLOWED
 *
 * Drift is intentionally LAST so an operator clearing the underlying
 * gate (hold released, lifecycle reset) sees the next blocker
 * immediately instead of jumping straight to "ALLOWED".
 */
export function canonicalEvaluatePackageEligibility(
  facts: CanonicalPackageFacts,
): CanonicalPackageDecision {
  const exportDecision = canonicalEvaluateExportEligibility(facts);
  if (exportDecision.outcome !== "ALLOWED") {
    // The export decision already returns BLOCKED_BY_HOLD /
    // BLOCKED_BY_LIFECYCLE / BLOCKED_BY_REVIEW_GATE. Those outcomes
    // are byte-compatible with the package outcome enum because we
    // chose the same names.
    return {
      outcome: exportDecision.outcome as PackageEligibilityOutcome,
      reason: exportDecision.reason,
    };
  }
  if (facts.hasOpenImmutableDriftIncident) {
    return {
      outcome: "BLOCKED_BY_IMMUTABLE_DRIFT",
      reason: "immutable_storage_drift_open",
    };
  }
  return { outcome: "ALLOWED", reason: "ok" };
}

/**
 * Operator-readable label for each package eligibility outcome.
 * Catalog-bound; safe to render in UI without further escaping.
 */
export function packageEligibilityLabel(
  outcome: PackageEligibilityOutcome,
): string {
  switch (outcome) {
    case "ALLOWED":
      return "Package generation allowed";
    case "BLOCKED_BY_HOLD":
      return "Active legal hold — package generation blocked";
    case "BLOCKED_BY_LIFECYCLE":
      return "Lifecycle state blocks package generation";
    case "BLOCKED_BY_REVIEW_GATE":
      return "Destruction review in progress — package generation blocked";
    case "BLOCKED_BY_IMMUTABLE_DRIFT":
      // CRITICAL wording rule: drift is a STORAGE GOVERNANCE state,
      // NOT a content-integrity finding. The label must never imply
      // the evidence has been tampered with.
      return "Storage governance drift — package generation paused until reconciled";
  }
}

export function exportEligibilityLabel(outcome: CanonicalExportOutcome): string {
  switch (outcome) {
    case "ALLOWED":
      return "Compliance export allowed";
    case "BLOCKED_BY_HOLD":
      return "Active legal hold — export blocked";
    case "BLOCKED_BY_LIFECYCLE":
      return "Lifecycle state blocks export";
    case "BLOCKED_BY_REVIEW_GATE":
      return "Destruction review in progress — export blocked";
  }
}
