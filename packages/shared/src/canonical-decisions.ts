/**
 * Phase X — Canonical decision contracts.
 *
 * This module is the SINGLE source of truth for the pure decision
 * formulas the platform uses across BOTH runtimes (api + worker). It is
 * deliberately additive — it does not replace any existing engine. It
 * gives both runtimes a shared, typed entry point so the decision
 * RULES cannot drift between processes.
 *
 * Hard rules:
 *   - NO Prisma. NO Node. NO Fastify. NO BullMQ. This module is
 *     browser-safe, runtime-agnostic, and import-cheap.
 *   - NO new policy logic. Everything here is either a direct re-export
 *     of an already-canonical helper from a sibling shared module or a
 *     thin wrapper that names the canonical input contract.
 *   - The CALLER supplies the facts (hasActiveHold, immutableRetention,
 *     etc). This module never reads from the database. Both runtimes
 *     gather the same facts the same way (documented in the
 *     `RuntimeOwnershipMap` below).
 *
 * Why this exists:
 *   The Phase 27.5 retention + destruction + immutable workers each
 *   re-implemented inline hold/immutable/lifecycle precedence rules
 *   instead of calling the canonical pure helpers in
 *   `governance-lifecycle.ts`. This module names the canonical entry
 *   points and exposes a small re-export surface so both runtimes
 *   can `import { canonicalCanEnterPendingDestruction } from "@proovra/shared"`
 *   and get the same answer. Anything else is semantic drift.
 */

import {
  canEnterPendingDestruction,
  isAllowedDestructionReviewTransition,
  isAllowedEvidenceLifecycleTransition,
  isAllowedRetentionPolicyTransition,
  isTerminalDestructionReviewStatus,
  isTerminalLifecycleState,
  listAllowedEvidenceLifecycleTransitions,
  pickHighestPrecedencePolicy,
  type DestructionReviewStatus,
  type EvidenceLifecycleState,
  type RetentionPolicyScope,
  type RetentionPolicyStatus,
} from "./governance-lifecycle.js";

// -----------------------------------------------------------------------------
// Canonical decision outcome shape — every gate in the platform should
// be projectable into this contract.
// -----------------------------------------------------------------------------

export type CanonicalDecisionReason =
  | "ok"
  | "blocked_by_hold"
  | "blocked_by_case_hold"
  | "blocked_by_immutable"
  | "blocked_by_lifecycle_terminal"
  | "blocked_by_invalid_transition"
  | "blocked_by_retention"
  | "blocked_by_review_gate"
  | "blocked_by_policy"
  | "blocked_by_destruction_pending"
  | "blocked_by_active_destruction_review"
  | "blocked_by_storage_drift";

export type CanonicalDecision =
  | { allowed: true; reason: "ok" }
  | { allowed: false; reason: Exclude<CanonicalDecisionReason, "ok"> };

export function decisionAllow(): CanonicalDecision {
  return { allowed: true, reason: "ok" };
}

export function decisionDeny(
  reason: Exclude<CanonicalDecisionReason, "ok">,
): CanonicalDecision {
  return { allowed: false, reason };
}

// -----------------------------------------------------------------------------
// Canonical destruction-eligibility decision.
//
// Wraps `canEnterPendingDestruction` in the typed `CanonicalDecision`
// shape so both runtimes (api orchestrator + destruction worker +
// retention reconciliation worker) return the same answer for the same
// inputs. This is the formula. The DB lookup is per-runtime.
// -----------------------------------------------------------------------------

export type CanonicalDestructionFacts = {
  fromState: EvidenceLifecycleState;
  hasActiveDirectHold: boolean;
  hasActiveCaseHold: boolean;
  immutableRetention: boolean;
  hasActiveDestructionReview?: boolean;
};

export function canonicalCanEnterPendingDestruction(
  facts: CanonicalDestructionFacts,
): CanonicalDecision {
  if (facts.hasActiveDirectHold) return decisionDeny("blocked_by_hold");
  if (facts.hasActiveCaseHold) return decisionDeny("blocked_by_case_hold");
  if (facts.immutableRetention) return decisionDeny("blocked_by_immutable");
  if (facts.hasActiveDestructionReview)
    return decisionDeny("blocked_by_active_destruction_review");
  const allowed = canEnterPendingDestruction({
    fromState: facts.fromState,
    hasActiveHold: facts.hasActiveDirectHold || facts.hasActiveCaseHold,
    immutableRetention: facts.immutableRetention,
  });
  if (!allowed) {
    if (isTerminalLifecycleState(facts.fromState)) {
      return decisionDeny("blocked_by_lifecycle_terminal");
    }
    return decisionDeny("blocked_by_invalid_transition");
  }
  return decisionAllow();
}

// -----------------------------------------------------------------------------
// Canonical lifecycle-transition decision.
// -----------------------------------------------------------------------------

export type CanonicalLifecycleTransitionFacts = {
  fromState: EvidenceLifecycleState;
  toState: EvidenceLifecycleState;
  hasActiveDirectHold: boolean;
  hasActiveCaseHold: boolean;
  immutableRetention: boolean;
};

export function canonicalEvaluateLifecycleTransition(
  facts: CanonicalLifecycleTransitionFacts,
): CanonicalDecision {
  if (
    isTerminalLifecycleState(facts.fromState) &&
    facts.fromState !== facts.toState
  ) {
    return decisionDeny("blocked_by_lifecycle_terminal");
  }
  if (
    !isAllowedEvidenceLifecycleTransition(facts.fromState, facts.toState)
  ) {
    return decisionDeny("blocked_by_invalid_transition");
  }
  if (facts.toState === "PENDING_DESTRUCTION" || facts.toState === "DESTROYED") {
    if (facts.hasActiveDirectHold) return decisionDeny("blocked_by_hold");
    if (facts.hasActiveCaseHold) return decisionDeny("blocked_by_case_hold");
    if (facts.immutableRetention) return decisionDeny("blocked_by_immutable");
  }
  return decisionAllow();
}

// -----------------------------------------------------------------------------
// Canonical export-eligibility decision.
//
// Mirrors the rules already encoded in
// `services/api/src/services/governance-lifecycle/export-governance.service.ts`.
// The pure formula lives here; the DB lookup stays in the API service.
// -----------------------------------------------------------------------------

export type CanonicalExportFacts = {
  lifecycleState: EvidenceLifecycleState;
  hasActiveDirectHold: boolean;
  hasActiveCaseHold: boolean;
  hasActiveDestructionReview: boolean;
  /** Optional: an outstanding non-terminal review with status APPROVED is
   *  still considered a review-gating signal because the evidence is
   *  queued for execution. */
  destructionReviewStatus?: DestructionReviewStatus | null;
};

export type CanonicalExportOutcome =
  | "ALLOWED"
  | "BLOCKED_BY_HOLD"
  | "BLOCKED_BY_LIFECYCLE"
  | "BLOCKED_BY_REVIEW_GATE";

const GATING_REVIEW_STATUSES: ReadonlyArray<DestructionReviewStatus> = [
  "PENDING",
  "UNDER_REVIEW",
  "DEFERRED",
  "APPROVED",
];

export function canonicalEvaluateExportEligibility(
  facts: CanonicalExportFacts,
): { outcome: CanonicalExportOutcome; reason: string } {
  if (facts.hasActiveDirectHold || facts.hasActiveCaseHold) {
    return { outcome: "BLOCKED_BY_HOLD", reason: "active_legal_hold" };
  }
  if (facts.lifecycleState === "DESTROYED") {
    return { outcome: "BLOCKED_BY_LIFECYCLE", reason: "evidence_destroyed" };
  }
  if (facts.lifecycleState === "PENDING_DESTRUCTION") {
    return { outcome: "BLOCKED_BY_LIFECYCLE", reason: "pending_destruction" };
  }
  if (facts.lifecycleState === "ON_HOLD") {
    return { outcome: "BLOCKED_BY_LIFECYCLE", reason: "lifecycle_on_hold" };
  }
  if (facts.lifecycleState === "RETENTION_LOCKED") {
    return { outcome: "BLOCKED_BY_LIFECYCLE", reason: "retention_locked" };
  }
  if (
    facts.hasActiveDestructionReview &&
    (!facts.destructionReviewStatus ||
      GATING_REVIEW_STATUSES.includes(facts.destructionReviewStatus))
  ) {
    return {
      outcome: "BLOCKED_BY_REVIEW_GATE",
      reason: "active_destruction_review",
    };
  }
  return { outcome: "ALLOWED", reason: "ok" };
}

// -----------------------------------------------------------------------------
// Canonical retention-policy precedence decision.
// -----------------------------------------------------------------------------

export type CanonicalPolicyPick<
  T extends { scope: RetentionPolicyScope; status: RetentionPolicyStatus },
> = T | null;

export function canonicalPickHighestPrecedencePolicy<
  T extends { scope: RetentionPolicyScope; status: RetentionPolicyStatus },
>(policies: ReadonlyArray<T>): CanonicalPolicyPick<T> {
  return pickHighestPrecedencePolicy(policies);
}

// -----------------------------------------------------------------------------
// Re-export the canonical state-machine helpers under "canonical" names
// so a future consumer searching for the canonical entry point finds
// exactly one place to import from.
// -----------------------------------------------------------------------------

export const canonicalIsAllowedEvidenceLifecycleTransition =
  isAllowedEvidenceLifecycleTransition;
export const canonicalListAllowedEvidenceLifecycleTransitions =
  listAllowedEvidenceLifecycleTransitions;
export const canonicalIsTerminalLifecycleState = isTerminalLifecycleState;
export const canonicalIsAllowedDestructionReviewTransition =
  isAllowedDestructionReviewTransition;
export const canonicalIsTerminalDestructionReviewStatus =
  isTerminalDestructionReviewStatus;
export const canonicalIsAllowedRetentionPolicyTransition =
  isAllowedRetentionPolicyTransition;

// -----------------------------------------------------------------------------
// Runtime ownership map — captured here as a value so it appears in
// docs + bundles + introspection tooling. Each entry names the
// authoritative writer of a piece of state. Anyone reading this is
// looking at the contract — and the cross-runtime regression test
// verifies the contract matches reality.
// -----------------------------------------------------------------------------

export type RuntimeOwner =
  | "api:governance.service"
  | "api:retention-engine.service"
  | "api:destruction-review.service"
  | "api:lifecycle-orchestrator.service"
  | "api:export-governance.service"
  | "api:export-lineage.service"
  | "api:governance-notification.service"
  | "api:governance-analytics.service"
  | "api:review-operations.service"
  | "api:workflow-engine.service"
  | "api:platform-audit-log.service"
  | "worker:retention-reconciliation"
  | "worker:destruction-orchestrator"
  | "worker:immutable-storage-reconciliation";

export type CanonicalDomain =
  | "lifecycle"
  | "retention"
  | "destruction"
  | "legal_hold"
  | "export"
  | "governance_notification"
  | "governance_incident"
  | "review_workflow"
  | "audit"
  | "reconciliation_run";

export type RuntimeOwnershipEntry = {
  domain: CanonicalDomain;
  /** Concrete state / decision this entry owns. */
  artifact: string;
  /** The ONLY service / worker permitted to write this state. */
  authoritativeWriter: RuntimeOwner;
  /** Other components that read this state. */
  readers: ReadonlyArray<RuntimeOwner>;
  /** Notes about cross-runtime delegation (e.g. workers proxy through
   *  the canonical formula imported from this module). */
  notes?: string;
};

export const RUNTIME_OWNERSHIP_MAP: ReadonlyArray<RuntimeOwnershipEntry> = [
  {
    domain: "lifecycle",
    artifact: "Evidence.lifecycleState",
    authoritativeWriter: "api:lifecycle-orchestrator.service",
    readers: [
      "api:destruction-review.service",
      "api:export-governance.service",
      "api:export-lineage.service",
      "api:governance-analytics.service",
      "worker:retention-reconciliation",
      "worker:destruction-orchestrator",
    ],
    notes:
      "The destruction orchestrator worker writes DESTROYED directly inside its EXECUTION transaction. The write is bounded by canonicalEvaluateLifecycleTransition (this module) so the rule never drifts. See cross-runtime test phase-x-architecture-consolidation.test.ts.",
  },
  {
    domain: "lifecycle",
    artifact: "EvidenceLifecycleEvent (ledger row)",
    authoritativeWriter: "api:lifecycle-orchestrator.service",
    readers: [
      "api:destruction-review.service",
      "api:governance-analytics.service",
      "worker:retention-reconciliation",
      "worker:destruction-orchestrator",
    ],
    notes:
      "Append-only. Workers append rows directly under transactional consistency with the lifecycle write they triggered.",
  },
  {
    domain: "retention",
    artifact: "EvidenceRetentionPolicy + EvidenceRetentionPolicyVersion",
    authoritativeWriter: "api:retention-engine.service",
    readers: [
      "api:lifecycle-orchestrator.service",
      "api:destruction-review.service",
      "api:export-governance.service",
      "api:export-lineage.service",
      "worker:retention-reconciliation",
      "worker:destruction-orchestrator",
    ],
  },
  {
    domain: "destruction",
    artifact: "DestructionReview (status, decision note, certificate hash)",
    authoritativeWriter: "api:destruction-review.service",
    readers: [
      "api:lifecycle-orchestrator.service",
      "api:export-governance.service",
      "api:governance-analytics.service",
      "worker:destruction-orchestrator",
    ],
    notes:
      "Worker flips PENDING -> APPROVED -> EXECUTED only through the destruction orchestrator; the api service is the source of operator-initiated transitions.",
  },
  {
    domain: "destruction",
    artifact: "DestructionExecution (per-attempt state row)",
    authoritativeWriter: "worker:destruction-orchestrator",
    readers: ["api:governance-analytics.service"],
  },
  {
    domain: "legal_hold",
    artifact: "EvidenceLegalHold + CaseLegalHold",
    authoritativeWriter: "api:governance.service",
    readers: [
      "api:lifecycle-orchestrator.service",
      "api:destruction-review.service",
      "api:export-governance.service",
      "api:export-lineage.service",
      "worker:retention-reconciliation",
      "worker:destruction-orchestrator",
      "worker:immutable-storage-reconciliation",
    ],
  },
  {
    domain: "export",
    artifact: "Compliance export eligibility decision",
    authoritativeWriter: "api:export-governance.service",
    readers: [
      "api:export-lineage.service",
      "api:governance-analytics.service",
    ],
    notes:
      "Pure decision formula lives in canonicalEvaluateExportEligibility (this module). The api service performs the DB lookup that gathers the facts.",
  },
  {
    domain: "export",
    artifact: "GovernanceExportSnapshot",
    authoritativeWriter: "api:export-lineage.service",
    readers: ["api:governance-analytics.service"],
  },
  {
    domain: "governance_notification",
    artifact: "GovernanceNotification rows",
    authoritativeWriter: "api:governance-notification.service",
    readers: ["api:governance-analytics.service"],
    notes:
      "KNOWN GAP: the three Phase 27.5 workers write notifications directly via `prisma.governanceNotification.upsert` rather than calling the canonical service. Throttle and incident fan-out are therefore bypassed for those emissions. Cross-runtime test asserts the dedupe-key shape stays consistent; full delegation is a future cleanup, not a blocker.",
  },
  {
    domain: "governance_incident",
    artifact: "OperationalIncident (governance category)",
    authoritativeWriter: "api:governance-notification.service",
    readers: ["api:governance-analytics.service"],
    notes:
      "Workers raise incidents via the existing Phase 21 recordIncident helper (re-implemented inline in the immutable worker). Future cleanup: delegate via shared client.",
  },
  {
    domain: "review_workflow",
    artifact: "EvidenceWorkflowInstance + EvidenceReviewWorkflow",
    authoritativeWriter: "api:workflow-engine.service",
    readers: [
      "api:review-operations.service",
      "api:export-governance.service",
    ],
  },
  {
    domain: "audit",
    artifact: "AdminAuditLog (HMAC chain)",
    authoritativeWriter: "api:platform-audit-log.service",
    readers: ["api:governance.service", "api:retention-engine.service"],
  },
  {
    domain: "reconciliation_run",
    artifact: "GovernanceReconciliationRun",
    authoritativeWriter: "worker:retention-reconciliation",
    readers: ["api:governance-analytics.service"],
    notes:
      "All three Phase 27.5 workers write rows here through reconciliation-run.ts.",
  },
];

export function findRuntimeOwners(
  domain: CanonicalDomain,
): ReadonlyArray<RuntimeOwnershipEntry> {
  return RUNTIME_OWNERSHIP_MAP.filter((e) => e.domain === domain);
}
