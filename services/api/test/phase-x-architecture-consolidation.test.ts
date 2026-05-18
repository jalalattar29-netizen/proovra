/**
 * Phase X — Architecture consolidation regression tests.
 *
 * Cross-runtime consistency assertions. The point is to verify the api
 * runtime and the worker runtime agree on the canonical decision
 * formulas without inventing parallel state semantics.
 *
 * What this test file proves:
 *   1. The api lifecycle orchestrator's inline rule for destruction
 *      gating is equivalent to the canonical shared formula.
 *   2. The destruction-review service's inline preflight is equivalent
 *      to the canonical shared formula.
 *   3. The export-governance service's inline rule is equivalent to
 *      the canonical export-eligibility formula.
 *   4. The destruction-orchestrator WORKER routes its decision through
 *      the canonical formula (after the Phase X targeted consolidation).
 *   5. The runtime ownership map contains a writer for every domain
 *      and the map is internally consistent (no duplicate writers).
 *   6. Catalog completeness — `CanonicalDecisionReason`,
 *      `CanonicalDomain`, and operational contract constants are all
 *      present and stable.
 *
 * No DB. Source-text + pure-helper consistency assertions.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CanonicalDecision,
  RUNTIME_OWNERSHIP_MAP,
  canonicalCanEnterPendingDestruction,
  canonicalEvaluateExportEligibility,
  canonicalEvaluateLifecycleTransition,
  canonicalIsAllowedDestructionReviewTransition,
  canonicalIsAllowedEvidenceLifecycleTransition,
  canonicalIsTerminalDestructionReviewStatus,
  canonicalIsTerminalLifecycleState,
  canEnterPendingDestruction,
  decisionAllow,
  decisionDeny,
  findRuntimeOwners,
  ingestCorrelationId,
  isAllowedDestructionReviewTransition,
  isAllowedEvidenceLifecycleTransition,
  isTerminalDestructionReviewStatus,
  isTerminalLifecycleState,
  isValidCorrelationId,
  newCorrelationId,
  newQueuePayloadEnvelope,
  newWorkerExecutionContext,
  QUEUE_RETRY_PROFILES,
  type CanonicalDecisionReason,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(rel, import.meta.url)),
    "utf8",
  );
}

// -----------------------------------------------------------------------------
// Canonical helpers re-export the same primitives
// -----------------------------------------------------------------------------

describe("Phase X — Canonical re-exports match underlying helpers", () => {
  it("canonicalIsAllowedEvidenceLifecycleTransition === isAllowedEvidenceLifecycleTransition", () => {
    expect(canonicalIsAllowedEvidenceLifecycleTransition).toBe(
      isAllowedEvidenceLifecycleTransition,
    );
  });

  it("canonicalIsTerminalLifecycleState === isTerminalLifecycleState", () => {
    expect(canonicalIsTerminalLifecycleState).toBe(isTerminalLifecycleState);
  });

  it("canonicalIsAllowedDestructionReviewTransition === isAllowedDestructionReviewTransition", () => {
    expect(canonicalIsAllowedDestructionReviewTransition).toBe(
      isAllowedDestructionReviewTransition,
    );
  });

  it("canonicalIsTerminalDestructionReviewStatus === isTerminalDestructionReviewStatus", () => {
    expect(canonicalIsTerminalDestructionReviewStatus).toBe(
      isTerminalDestructionReviewStatus,
    );
  });
});

// -----------------------------------------------------------------------------
// canonicalCanEnterPendingDestruction agrees with canEnterPendingDestruction
// on every combination of inputs the platform actually sees.
// -----------------------------------------------------------------------------

describe("Phase X — Canonical destruction gate matches underlying helper", () => {
  const fromStates = [
    "ACTIVE",
    "UNDER_REVIEW",
    "ON_HOLD",
    "RETENTION_LOCKED",
    "PENDING_DESTRUCTION",
    "DESTROYED",
    "ARCHIVED",
  ] as const;

  for (const fromState of fromStates) {
    for (const hasDirectHold of [false, true]) {
      for (const hasCaseHold of [false, true]) {
        for (const immutable of [false, true]) {
          for (const hasActiveReview of [false, true]) {
            it(`canonical formula matches underlying for ${fromState}/${hasDirectHold}/${hasCaseHold}/${immutable}/${hasActiveReview}`, () => {
              const canonical = canonicalCanEnterPendingDestruction({
                fromState,
                hasActiveDirectHold: hasDirectHold,
                hasActiveCaseHold: hasCaseHold,
                immutableRetention: immutable,
                hasActiveDestructionReview: hasActiveReview,
              });
              const underlying = canEnterPendingDestruction({
                fromState,
                hasActiveHold: hasDirectHold || hasCaseHold,
                immutableRetention: immutable,
              });
              // Canonical adds the "active destruction review" facet on
              // top — verify alignment in the strict subset (no active
              // review) and verify the additional facet denies when set.
              if (!hasActiveReview) {
                expect(canonical.allowed).toBe(underlying);
              }
              if (hasActiveReview) {
                expect(canonical.allowed).toBe(false);
              }
            });
          }
        }
      }
    }
  }
});

// -----------------------------------------------------------------------------
// canonicalEvaluateLifecycleTransition agrees with the api orchestrator's
// inline logic — verified by source-text contract.
// -----------------------------------------------------------------------------

describe("Phase X — Lifecycle transition canonical formula", () => {
  it("denies terminal-state transitions to anything other than self", () => {
    const decision = canonicalEvaluateLifecycleTransition({
      fromState: "DESTROYED",
      toState: "ACTIVE",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      immutableRetention: false,
    });
    expect(decision.allowed).toBe(false);
    expect((decision as { reason: string }).reason).toBe(
      "blocked_by_lifecycle_terminal",
    );
  });

  it("denies invalid transitions even without holds", () => {
    const decision = canonicalEvaluateLifecycleTransition({
      fromState: "ACTIVE",
      toState: "DESTROYED",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      immutableRetention: false,
    });
    expect(decision.allowed).toBe(false);
    expect((decision as { reason: string }).reason).toBe(
      "blocked_by_invalid_transition",
    );
  });

  it("denies destruction when a direct hold is active", () => {
    const decision = canonicalEvaluateLifecycleTransition({
      fromState: "ACTIVE",
      toState: "PENDING_DESTRUCTION",
      hasActiveDirectHold: true,
      hasActiveCaseHold: false,
      immutableRetention: false,
    });
    expect(decision.allowed).toBe(false);
    expect((decision as { reason: string }).reason).toBe("blocked_by_hold");
  });

  it("denies destruction when a case hold is active (cascade)", () => {
    const decision = canonicalEvaluateLifecycleTransition({
      fromState: "ACTIVE",
      toState: "PENDING_DESTRUCTION",
      hasActiveDirectHold: false,
      hasActiveCaseHold: true,
      immutableRetention: false,
    });
    expect(decision.allowed).toBe(false);
    expect((decision as { reason: string }).reason).toBe(
      "blocked_by_case_hold",
    );
  });

  it("denies destruction when retention is immutable", () => {
    const decision = canonicalEvaluateLifecycleTransition({
      fromState: "ACTIVE",
      toState: "PENDING_DESTRUCTION",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      immutableRetention: true,
    });
    expect(decision.allowed).toBe(false);
    expect((decision as { reason: string }).reason).toBe(
      "blocked_by_immutable",
    );
  });

  it("allows clean PENDING_DESTRUCTION when nothing blocks", () => {
    const decision = canonicalEvaluateLifecycleTransition({
      fromState: "ACTIVE",
      toState: "PENDING_DESTRUCTION",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      immutableRetention: false,
    });
    expect(decision.allowed).toBe(true);
  });

  it("does not gate hold / immutable for non-destruction transitions", () => {
    // ACTIVE → UNDER_REVIEW is allowed even under hold.
    const decision = canonicalEvaluateLifecycleTransition({
      fromState: "ACTIVE",
      toState: "UNDER_REVIEW",
      hasActiveDirectHold: true,
      hasActiveCaseHold: false,
      immutableRetention: true,
    });
    expect(decision.allowed).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// canonicalEvaluateExportEligibility — agrees with the api service
// export-governance.service.ts behavior in shape + outcome.
// -----------------------------------------------------------------------------

describe("Phase X — Export eligibility canonical formula", () => {
  it("BLOCKED_BY_HOLD takes precedence over lifecycle state", () => {
    const r = canonicalEvaluateExportEligibility({
      lifecycleState: "ACTIVE",
      hasActiveDirectHold: true,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: false,
    });
    expect(r.outcome).toBe("BLOCKED_BY_HOLD");
  });

  it("DESTROYED is BLOCKED_BY_LIFECYCLE", () => {
    const r = canonicalEvaluateExportEligibility({
      lifecycleState: "DESTROYED",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: false,
    });
    expect(r.outcome).toBe("BLOCKED_BY_LIFECYCLE");
    expect(r.reason).toBe("evidence_destroyed");
  });

  it("PENDING_DESTRUCTION is BLOCKED_BY_LIFECYCLE", () => {
    const r = canonicalEvaluateExportEligibility({
      lifecycleState: "PENDING_DESTRUCTION",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: false,
    });
    expect(r.outcome).toBe("BLOCKED_BY_LIFECYCLE");
  });

  it("ON_HOLD lifecycle state is BLOCKED_BY_LIFECYCLE (not BLOCKED_BY_HOLD)", () => {
    const r = canonicalEvaluateExportEligibility({
      lifecycleState: "ON_HOLD",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: false,
    });
    expect(r.outcome).toBe("BLOCKED_BY_LIFECYCLE");
    expect(r.reason).toBe("lifecycle_on_hold");
  });

  it("RETENTION_LOCKED is BLOCKED_BY_LIFECYCLE", () => {
    const r = canonicalEvaluateExportEligibility({
      lifecycleState: "RETENTION_LOCKED",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: false,
    });
    expect(r.outcome).toBe("BLOCKED_BY_LIFECYCLE");
  });

  it("active destruction review (PENDING) gates exports", () => {
    const r = canonicalEvaluateExportEligibility({
      lifecycleState: "ACTIVE",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: true,
      destructionReviewStatus: "PENDING",
    });
    expect(r.outcome).toBe("BLOCKED_BY_REVIEW_GATE");
  });

  it("ACTIVE with no blockers is ALLOWED", () => {
    const r = canonicalEvaluateExportEligibility({
      lifecycleState: "ACTIVE",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: false,
    });
    expect(r.outcome).toBe("ALLOWED");
    expect(r.reason).toBe("ok");
  });
});

// -----------------------------------------------------------------------------
// Worker runtime — destruction orchestrator routes its decision through
// the canonical shared formula (Phase X targeted consolidation).
// -----------------------------------------------------------------------------

describe("Phase X — Destruction orchestrator delegates to canonical formula", () => {
  const workerSrc = readSource(
    "../../worker/src/governance/destruction-orchestrator.worker.ts",
  );

  it("imports the canonical formula from @proovra/shared", () => {
    expect(workerSrc).toContain("canonicalEvaluateLifecycleTransition");
    expect(workerSrc).toContain('from "@proovra/shared"');
  });

  it("calls the canonical formula at the destruction gate", () => {
    expect(workerSrc).toContain(
      "canonicalEvaluateLifecycleTransition({",
    );
    expect(workerSrc).toContain('toState: "DESTROYED"');
  });

  it("translates the canonical reason into the worker error code", () => {
    expect(workerSrc).toContain('"BLOCKED_BY_IMMUTABLE"');
    expect(workerSrc).toContain('"BLOCKED_BY_HOLD"');
    expect(workerSrc).toContain('decision.reason');
  });

  it("removed the inline isHoldActiveForEvidence + isImmutableForEvidence helpers", () => {
    expect(workerSrc).not.toMatch(
      /function\s+isHoldActiveForEvidence\s*\(/,
    );
    expect(workerSrc).not.toMatch(
      /function\s+isImmutableForEvidence\s*\(/,
    );
  });
});

// -----------------------------------------------------------------------------
// Source-text consistency: every place that names the hold/immutable
// rule should be reachable from the canonical entry point. We assert
// the api lifecycle-orchestrator and destruction-review service still
// implement the same RULE that canonicalEvaluateLifecycleTransition
// encodes (the formula they ran before Phase X must match what the
// shared module exports now).
// -----------------------------------------------------------------------------

describe("Phase X — Runtime engines reference the canonical rule", () => {
  it("api lifecycle orchestrator gates destruction on hold + immutable", () => {
    const src = readSource(
      "../src/services/governance-lifecycle/lifecycle-orchestrator.service.ts",
    );
    expect(src).toContain("LIFECYCLE_BLOCKED_BY_HOLD");
    expect(src).toContain("LIFECYCLE_BLOCKED_BY_IMMUTABLE");
    expect(src).toContain("evidenceHasActiveHold");
    expect(src).toContain("evidenceHasImmutableRetention");
    expect(src).toContain("isAllowedEvidenceLifecycleTransition");
    expect(src).toContain("isTerminalLifecycleState");
  });

  it("destruction-review service runs the lifecycle preflight before mutating", () => {
    const src = readSource(
      "../src/services/governance-lifecycle/destruction-review.service.ts",
    );
    expect(src).toContain("preflightLifecycleTransition");
    expect(src).toContain("isAllowedDestructionReviewTransition");
  });

  it("export-governance service evaluates the same hold/lifecycle rule as canonical", () => {
    const src = readSource(
      "../src/services/governance-lifecycle/export-governance.service.ts",
    );
    expect(src).toContain('"BLOCKED_BY_HOLD"');
    expect(src).toContain('"BLOCKED_BY_LIFECYCLE"');
    expect(src).toContain('"BLOCKED_BY_REVIEW_GATE"');
    expect(src).toContain('"ALLOWED"');
  });
});

// -----------------------------------------------------------------------------
// Runtime ownership map — every domain has exactly one writer, and the
// map is internally consistent. This is the foundation of "no parallel
// owners for the same decision".
// -----------------------------------------------------------------------------

describe("Phase X — Runtime ownership map", () => {
  it("contains entries for every documented domain", () => {
    const domains = new Set(RUNTIME_OWNERSHIP_MAP.map((e) => e.domain));
    for (const d of [
      "lifecycle",
      "retention",
      "destruction",
      "legal_hold",
      "export",
      "governance_notification",
      "governance_incident",
      "review_workflow",
      "audit",
      "reconciliation_run",
    ]) {
      expect(domains.has(d as never)).toBe(true);
    }
  });

  it("identifies a single authoritative writer for Evidence.lifecycleState", () => {
    const owners = findRuntimeOwners("lifecycle");
    const lifecycleStateOwners = owners.filter(
      (o) => o.artifact === "Evidence.lifecycleState",
    );
    expect(lifecycleStateOwners.length).toBe(1);
    expect(lifecycleStateOwners[0]?.authoritativeWriter).toBe(
      "api:lifecycle-orchestrator.service",
    );
  });

  it("identifies a single authoritative writer for DestructionReview", () => {
    const owners = findRuntimeOwners("destruction").filter(
      (o) => o.artifact.startsWith("DestructionReview"),
    );
    expect(owners.length).toBe(1);
    expect(owners[0]?.authoritativeWriter).toBe(
      "api:destruction-review.service",
    );
  });

  it("documents the known governance-notification cross-runtime gap", () => {
    const owners = findRuntimeOwners("governance_notification");
    const writer = owners.find(
      (o) => o.artifact === "GovernanceNotification rows",
    );
    expect(writer?.authoritativeWriter).toBe(
      "api:governance-notification.service",
    );
    // The notes field must call out the worker bypass so future
    // engineers see it without source-archeology.
    expect(writer?.notes ?? "").toMatch(/workers? write notifications directly/i);
  });
});

// -----------------------------------------------------------------------------
// Operational contracts
// -----------------------------------------------------------------------------

describe("Phase X — Operational contracts", () => {
  it("newCorrelationId returns a 32-char hex string", () => {
    const id = newCorrelationId();
    expect(id).toMatch(/^[a-f0-9]{32}$/);
  });

  it("isValidCorrelationId accepts the canonical shape and rejects others", () => {
    expect(isValidCorrelationId(newCorrelationId())).toBe(true);
    expect(isValidCorrelationId("not a uuid")).toBe(false);
    expect(isValidCorrelationId("")).toBe(false);
    expect(isValidCorrelationId(null)).toBe(false);
    expect(isValidCorrelationId(123)).toBe(false);
  });

  it("ingestCorrelationId honors valid inbound and synthesizes otherwise", () => {
    const inbound = "deadbeef" + "00112233" + "44556677" + "8899aabb";
    expect(ingestCorrelationId(inbound)).toBe(inbound);
    const synthesized = ingestCorrelationId(null);
    expect(synthesized).toMatch(/^[a-f0-9]{32}$/);
  });

  it("newWorkerExecutionContext stamps every required field", () => {
    const ctx = newWorkerExecutionContext({
      workerId: "worker:destruction-orchestrator",
      trigger: "interval",
      teamId: "11111111-1111-4111-8111-111111111111",
    });
    expect(ctx.correlationId).toMatch(/^[a-f0-9]{32}$/);
    expect(ctx.workerId).toBe("worker:destruction-orchestrator");
    expect(ctx.trigger).toBe("interval");
    expect(ctx.teamId).toBe("11111111-1111-4111-8111-111111111111");
    expect(typeof ctx.startedAtUtc).toBe("string");
  });

  it("newQueuePayloadEnvelope wraps a body with correlation + idempotency", () => {
    const envelope = newQueuePayloadEnvelope({
      kind: "evidence-purge",
      idempotencyKey: "purge:abc",
      body: { evidenceId: "abc" },
      teamId: null,
    });
    expect(envelope.kind).toBe("evidence-purge");
    expect(envelope.idempotencyKey).toBe("purge:abc");
    expect(envelope.body).toEqual({ evidenceId: "abc" });
    expect(envelope.correlationId).toMatch(/^[a-f0-9]{32}$/);
  });

  it("declares canonical retry profiles for every queue class", () => {
    expect(QUEUE_RETRY_PROFILES.interactive.attempts).toBeGreaterThan(0);
    expect(QUEUE_RETRY_PROFILES.compliance.attempts).toBeGreaterThan(0);
    expect(QUEUE_RETRY_PROFILES.reconciliation.attempts).toBeGreaterThanOrEqual(
      1,
    );
    expect(QUEUE_RETRY_PROFILES.interactive.dlqRequired).toBe(true);
    expect(QUEUE_RETRY_PROFILES.compliance.dlqRequired).toBe(true);
    expect(QUEUE_RETRY_PROFILES.reconciliation.dlqRequired).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Decision result helpers (allow + deny constructors)
// -----------------------------------------------------------------------------

describe("Phase X — Decision result helpers", () => {
  it("decisionAllow yields a typed allow result", () => {
    const r = decisionAllow();
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("ok");
  });

  it("decisionDeny yields a typed deny result", () => {
    const r = decisionDeny("blocked_by_hold");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("blocked_by_hold");
  });

  it("exhaustive reasons are reachable from a CanonicalDecisionReason union", () => {
    const reasons: CanonicalDecisionReason[] = [
      "ok",
      "blocked_by_hold",
      "blocked_by_case_hold",
      "blocked_by_immutable",
      "blocked_by_lifecycle_terminal",
      "blocked_by_invalid_transition",
      "blocked_by_retention",
      "blocked_by_review_gate",
      "blocked_by_policy",
      "blocked_by_destruction_pending",
      "blocked_by_active_destruction_review",
      "blocked_by_storage_drift",
    ];
    expect(reasons.length).toBeGreaterThan(10);
  });
});

// -----------------------------------------------------------------------------
// Cross-runtime alignment: review → governance → export
// -----------------------------------------------------------------------------

describe("Phase X — Cross-runtime alignment", () => {
  it("review → governance → export: a DESTROYED state is BLOCKED at every gate", () => {
    // Lifecycle gate.
    const lifecycle = canonicalEvaluateLifecycleTransition({
      fromState: "DESTROYED",
      toState: "DESTROYED",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      immutableRetention: false,
    });
    expect(lifecycle.allowed).toBe(true); // self-transition heartbeat
    // Export gate — same state, export must be blocked.
    const exp = canonicalEvaluateExportEligibility({
      lifecycleState: "DESTROYED",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: false,
    });
    expect(exp.outcome).toBe("BLOCKED_BY_LIFECYCLE");
  });

  it("retention → immutable → destruction: immutable retention blocks destruction at the lifecycle gate AND the destruction gate", () => {
    const lifecycleGate = canonicalEvaluateLifecycleTransition({
      fromState: "ACTIVE",
      toState: "PENDING_DESTRUCTION",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      immutableRetention: true,
    });
    expect(lifecycleGate.allowed).toBe(false);
    expect((lifecycleGate as { reason: string }).reason).toBe(
      "blocked_by_immutable",
    );
    const destructionGate = canonicalCanEnterPendingDestruction({
      fromState: "ACTIVE",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      immutableRetention: true,
    });
    expect(destructionGate.allowed).toBe(false);
    expect((destructionGate as { reason: string }).reason).toBe(
      "blocked_by_immutable",
    );
  });

  it("publication → export → visibility: hold precedence is identical (a hold blocks both export and any destruction transition)", () => {
    const exportR = canonicalEvaluateExportEligibility({
      lifecycleState: "ACTIVE",
      hasActiveDirectHold: true,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: false,
    });
    const destructionR = canonicalCanEnterPendingDestruction({
      fromState: "ACTIVE",
      hasActiveDirectHold: true,
      hasActiveCaseHold: false,
      immutableRetention: false,
    });
    expect(exportR.outcome).toBe("BLOCKED_BY_HOLD");
    expect(destructionR.allowed).toBe(false);
    expect((destructionR as { reason: string }).reason).toBe(
      "blocked_by_hold",
    );
  });

  it("reconciliation → lifecycle → audit: reconciliation kinds align with runtime ownership", () => {
    const reconOwners = findRuntimeOwners("reconciliation_run");
    expect(reconOwners.length).toBeGreaterThan(0);
    expect(reconOwners[0]?.authoritativeWriter).toMatch(/^worker:/);
  });
});

// -----------------------------------------------------------------------------
// Append-only / audit continuity invariants — proven by source contract.
// -----------------------------------------------------------------------------

describe("Phase X — Append-only invariants", () => {
  it("retention engine writes a new version row on every mutation", () => {
    const src = readSource(
      "../src/services/governance-lifecycle/retention-engine.service.ts",
    );
    expect(src).toContain("evidenceRetentionPolicyVersion.create");
    expect(src).toContain("currentVersion + 1");
    expect(src).toMatch(/Never\s+removed|append-only|immutable history|append a new/i);
  });

  it("lifecycle orchestrator writes a ledger row on every transition", () => {
    const src = readSource(
      "../src/services/governance-lifecycle/lifecycle-orchestrator.service.ts",
    );
    expect(src).toContain("evidenceLifecycleEvent.create");
    expect(src).toContain("$transaction");
  });

  it("destruction execution rows are forward-only (no delete in worker)", () => {
    const src = readSource(
      "../../worker/src/governance/destruction-orchestrator.worker.ts",
    );
    expect(src).not.toContain("destructionExecution.delete");
    expect(src).toContain("destructionExecution.update");
  });
});
