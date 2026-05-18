/**
 * Phase 27 — Enterprise Retention + Legal Hold + Lifecycle regression tests.
 *
 * No DB. Source-text + pure-helper + projection tests, matching the
 * style of phase26_75-identity-runtime.test.ts.
 *
 * Coverage:
 *   - Evidence lifecycle state machine: allowed/disallowed transitions,
 *     DESTROYED terminal, hold-aware destruction gate.
 *   - Retention policy state machine + precedence resolver.
 *   - Retention policy schema superRefine rules.
 *   - Destruction review state machine + terminal statuses + reason catalog.
 *   - Export eligibility outcome catalog.
 *   - Catalog wiring: SecurityEvent types, Step-up purposes, metric names
 *     all carry the Phase 27 additions.
 *   - Route layer wiring: governance lifecycle routes registered, mutating
 *     destruction endpoints require step-up, services bump the right
 *     metrics + emit the right SecurityEvent types.
 *   - Wording sweep: no playful copy on operator surfaces.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DESTRUCTION_REVIEW_REASONS,
  DESTRUCTION_REVIEW_STATUSES,
  EVIDENCE_LIFECYCLE_STATES,
  EXPORT_ELIGIBILITY_OUTCOMES,
  LIFECYCLE_EVENT_TYPES,
  RETENTION_POLICY_SCOPES,
  RETENTION_POLICY_STATUSES,
  RETENTION_PRECEDENCE_ORDER,
  RetentionPolicyCreateInputSchema,
  RetentionPolicyUpdateInputSchema,
  SECURITY_EVENT_TYPES,
  STEP_UP_PURPOSES,
  canEnterPendingDestruction,
  isAllowedDestructionReviewTransition,
  isAllowedEvidenceLifecycleTransition,
  isAllowedRetentionPolicyTransition,
  isTerminalDestructionReviewStatus,
  isTerminalLifecycleState,
  listAllowedEvidenceLifecycleTransitions,
  pickHighestPrecedencePolicy,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(rel, import.meta.url)),
    "utf8",
  );
}

// -----------------------------------------------------------------------------
// Lifecycle state machine
// -----------------------------------------------------------------------------

describe("Phase 27 — Evidence lifecycle state machine", () => {
  it("contains exactly seven canonical states", () => {
    expect(EVIDENCE_LIFECYCLE_STATES).toEqual([
      "ACTIVE",
      "UNDER_REVIEW",
      "ON_HOLD",
      "RETENTION_LOCKED",
      "PENDING_DESTRUCTION",
      "DESTROYED",
      "ARCHIVED",
    ]);
  });

  it("allows ACTIVE → UNDER_REVIEW / ON_HOLD / RETENTION_LOCKED / PENDING_DESTRUCTION / ARCHIVED", () => {
    for (const to of [
      "UNDER_REVIEW",
      "ON_HOLD",
      "RETENTION_LOCKED",
      "PENDING_DESTRUCTION",
      "ARCHIVED",
    ] as const) {
      expect(isAllowedEvidenceLifecycleTransition("ACTIVE", to)).toBe(true);
    }
  });

  it("rejects ACTIVE → DESTROYED (must go through PENDING_DESTRUCTION)", () => {
    expect(isAllowedEvidenceLifecycleTransition("ACTIVE", "DESTROYED")).toBe(
      false,
    );
  });

  it("treats DESTROYED as terminal — no outbound transitions", () => {
    expect(isTerminalLifecycleState("DESTROYED")).toBe(true);
    for (const to of EVIDENCE_LIFECYCLE_STATES) {
      if (to === "DESTROYED") continue;
      expect(isAllowedEvidenceLifecycleTransition("DESTROYED", to)).toBe(false);
    }
  });

  it("supports archive restoration: ARCHIVED → ACTIVE", () => {
    expect(isAllowedEvidenceLifecycleTransition("ARCHIVED", "ACTIVE")).toBe(
      true,
    );
  });

  it("denies destruction from ON_HOLD even if state machine were permissive", () => {
    expect(
      canEnterPendingDestruction({
        fromState: "ON_HOLD",
        hasActiveHold: false,
        immutableRetention: false,
      }),
    ).toBe(false);
  });

  it("denies destruction whenever a hold is active, regardless of from-state", () => {
    expect(
      canEnterPendingDestruction({
        fromState: "ACTIVE",
        hasActiveHold: true,
        immutableRetention: false,
      }),
    ).toBe(false);
  });

  it("denies destruction whenever retention is immutable", () => {
    expect(
      canEnterPendingDestruction({
        fromState: "ACTIVE",
        hasActiveHold: false,
        immutableRetention: true,
      }),
    ).toBe(false);
  });

  it("permits destruction from ACTIVE only when no hold + not immutable", () => {
    expect(
      canEnterPendingDestruction({
        fromState: "ACTIVE",
        hasActiveHold: false,
        immutableRetention: false,
      }),
    ).toBe(true);
  });

  it("self-transition is treated as no-op (orchestrator heartbeat)", () => {
    expect(isAllowedEvidenceLifecycleTransition("ACTIVE", "ACTIVE")).toBe(true);
    expect(isAllowedEvidenceLifecycleTransition("DESTROYED", "DESTROYED")).toBe(
      true,
    );
  });

  it("listAllowedEvidenceLifecycleTransitions matches the table", () => {
    expect(listAllowedEvidenceLifecycleTransitions("UNDER_REVIEW")).toContain(
      "ACTIVE",
    );
    expect(listAllowedEvidenceLifecycleTransitions("DESTROYED")).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Retention policy state machine + scopes
// -----------------------------------------------------------------------------

describe("Phase 27 — Retention policy state machine", () => {
  it("contains exactly four statuses", () => {
    expect(RETENTION_POLICY_STATUSES).toEqual([
      "ACTIVE",
      "PAUSED",
      "SUPERSEDED",
      "ARCHIVED",
    ]);
  });

  it("ACTIVE → PAUSED / SUPERSEDED / ARCHIVED allowed; reverse from ARCHIVED denied", () => {
    expect(isAllowedRetentionPolicyTransition("ACTIVE", "PAUSED")).toBe(true);
    expect(isAllowedRetentionPolicyTransition("ACTIVE", "SUPERSEDED")).toBe(
      true,
    );
    expect(isAllowedRetentionPolicyTransition("ACTIVE", "ARCHIVED")).toBe(
      true,
    );
    expect(isAllowedRetentionPolicyTransition("ARCHIVED", "ACTIVE")).toBe(
      false,
    );
  });

  it("SUPERSEDED can only move to ARCHIVED (cannot un-supersede)", () => {
    expect(isAllowedRetentionPolicyTransition("SUPERSEDED", "ARCHIVED")).toBe(
      true,
    );
    expect(isAllowedRetentionPolicyTransition("SUPERSEDED", "ACTIVE")).toBe(
      false,
    );
  });
});

describe("Phase 27 — Retention policy scopes + precedence", () => {
  it("contains exactly four scopes", () => {
    expect(RETENTION_POLICY_SCOPES).toEqual([
      "WORKSPACE",
      "EVIDENCE_TYPE",
      "CASE",
      "REGULATORY",
    ]);
  });

  it("precedence ordering: CASE → EVIDENCE_TYPE → REGULATORY → WORKSPACE", () => {
    expect(RETENTION_PRECEDENCE_ORDER).toEqual([
      "CASE",
      "EVIDENCE_TYPE",
      "REGULATORY",
      "WORKSPACE",
    ]);
  });

  it("picker returns CASE over EVIDENCE_TYPE/REGULATORY/WORKSPACE", () => {
    const winner = pickHighestPrecedencePolicy([
      { scope: "WORKSPACE", status: "ACTIVE" },
      { scope: "REGULATORY", status: "ACTIVE" },
      { scope: "EVIDENCE_TYPE", status: "ACTIVE" },
      { scope: "CASE", status: "ACTIVE" },
    ]);
    expect(winner?.scope).toBe("CASE");
  });

  it("picker ignores non-ACTIVE policies", () => {
    const winner = pickHighestPrecedencePolicy([
      { scope: "CASE", status: "SUPERSEDED" },
      { scope: "WORKSPACE", status: "ACTIVE" },
    ]);
    expect(winner?.scope).toBe("WORKSPACE");
  });

  it("picker returns null when no ACTIVE candidate", () => {
    const winner = pickHighestPrecedencePolicy([
      { scope: "WORKSPACE", status: "PAUSED" },
      { scope: "CASE", status: "ARCHIVED" },
    ]);
    expect(winner).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Retention policy schema
// -----------------------------------------------------------------------------

describe("Phase 27 — RetentionPolicyCreateInputSchema", () => {
  const baseTeam = "11111111-1111-4111-8111-111111111111";

  it("requires scopeQualifier when scope=EVIDENCE_TYPE", () => {
    const res = RetentionPolicyCreateInputSchema.safeParse({
      teamId: baseTeam,
      displayName: "Photos 30d",
      scope: "EVIDENCE_TYPE",
      retentionDays: 30,
    });
    expect(res.success).toBe(false);
  });

  it("requires scopeQualifier when scope=REGULATORY", () => {
    const res = RetentionPolicyCreateInputSchema.safeParse({
      teamId: baseTeam,
      displayName: "EU GDPR",
      scope: "REGULATORY",
      retentionDays: 365,
    });
    expect(res.success).toBe(false);
  });

  it("requires caseId when scope=CASE", () => {
    const res = RetentionPolicyCreateInputSchema.safeParse({
      teamId: baseTeam,
      displayName: "Case-specific",
      scope: "CASE",
      retentionDays: 90,
    });
    expect(res.success).toBe(false);
  });

  it("requires autoExtensionDays when autoExtensionEnabled=true", () => {
    const res = RetentionPolicyCreateInputSchema.safeParse({
      teamId: baseTeam,
      displayName: "Litigation",
      scope: "WORKSPACE",
      retentionDays: 365,
      autoExtensionEnabled: true,
    });
    expect(res.success).toBe(false);
  });

  it("accepts a well-formed workspace policy", () => {
    const res = RetentionPolicyCreateInputSchema.safeParse({
      teamId: baseTeam,
      displayName: "Workspace default",
      scope: "WORKSPACE",
      retentionDays: 30,
    });
    expect(res.success).toBe(true);
  });

  it("rejects retention > 100 years", () => {
    const res = RetentionPolicyCreateInputSchema.safeParse({
      teamId: baseTeam,
      displayName: "Insane retention",
      scope: "WORKSPACE",
      retentionDays: 999999,
    });
    expect(res.success).toBe(false);
  });
});

describe("Phase 27 — RetentionPolicyUpdateInputSchema", () => {
  it("requires changeNote on update", () => {
    const res = RetentionPolicyUpdateInputSchema.safeParse({
      teamId: "11111111-1111-4111-8111-111111111111",
      id: "22222222-2222-4222-8222-222222222222",
      retentionDays: 60,
    });
    expect(res.success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Destruction review state machine + reasons
// -----------------------------------------------------------------------------

describe("Phase 27 — Destruction review state machine", () => {
  it("contains exactly eight statuses", () => {
    expect(DESTRUCTION_REVIEW_STATUSES).toEqual([
      "PENDING",
      "UNDER_REVIEW",
      "APPROVED",
      "DENIED",
      "DEFERRED",
      "RESTORED",
      "EXECUTED",
      "CANCELLED",
    ]);
  });

  it("PENDING → UNDER_REVIEW / DEFERRED / CANCELLED", () => {
    for (const to of ["UNDER_REVIEW", "DEFERRED", "CANCELLED"] as const) {
      expect(isAllowedDestructionReviewTransition("PENDING", to)).toBe(true);
    }
    expect(isAllowedDestructionReviewTransition("PENDING", "APPROVED")).toBe(
      false,
    );
  });

  it("UNDER_REVIEW → APPROVED / DENIED / DEFERRED / CANCELLED", () => {
    for (const to of [
      "APPROVED",
      "DENIED",
      "DEFERRED",
      "CANCELLED",
    ] as const) {
      expect(isAllowedDestructionReviewTransition("UNDER_REVIEW", to)).toBe(
        true,
      );
    }
    expect(
      isAllowedDestructionReviewTransition("UNDER_REVIEW", "EXECUTED"),
    ).toBe(false);
  });

  it("APPROVED → EXECUTED / CANCELLED only", () => {
    expect(isAllowedDestructionReviewTransition("APPROVED", "EXECUTED")).toBe(
      true,
    );
    expect(isAllowedDestructionReviewTransition("APPROVED", "DENIED")).toBe(
      false,
    );
  });

  it("DENIED → RESTORED / CANCELLED only", () => {
    expect(isAllowedDestructionReviewTransition("DENIED", "RESTORED")).toBe(
      true,
    );
    expect(isAllowedDestructionReviewTransition("DENIED", "APPROVED")).toBe(
      false,
    );
  });

  it("treats EXECUTED, RESTORED, CANCELLED as terminal", () => {
    expect(isTerminalDestructionReviewStatus("EXECUTED")).toBe(true);
    expect(isTerminalDestructionReviewStatus("RESTORED")).toBe(true);
    expect(isTerminalDestructionReviewStatus("CANCELLED")).toBe(true);
    expect(isTerminalDestructionReviewStatus("PENDING")).toBe(false);
  });

  it("reasons are bounded-catalog", () => {
    expect(DESTRUCTION_REVIEW_REASONS).toEqual([
      "retention_expired",
      "manual_review",
      "policy_supersede",
    ]);
  });
});

// -----------------------------------------------------------------------------
// Export eligibility
// -----------------------------------------------------------------------------

describe("Phase 27 — Export eligibility catalog", () => {
  it("contains exactly the documented outcomes", () => {
    expect(EXPORT_ELIGIBILITY_OUTCOMES).toEqual([
      "ALLOWED",
      "BLOCKED_BY_HOLD",
      "BLOCKED_BY_RETENTION",
      "BLOCKED_BY_POLICY",
      "BLOCKED_BY_LIFECYCLE",
      "BLOCKED_BY_REVIEW_GATE",
    ]);
  });
});

// -----------------------------------------------------------------------------
// Lifecycle event types catalog
// -----------------------------------------------------------------------------

describe("Phase 27 — Lifecycle event types catalog", () => {
  it("includes the canonical event types written by the orchestrator", () => {
    for (const t of [
      "lifecycle_transition",
      "destruction_review_created",
      "destruction_review_approved",
      "destruction_review_denied",
      "destruction_review_restored",
      "destruction_executed",
      "policy_attached",
      "policy_superseded",
      "hold_placed",
      "hold_released",
    ]) {
      expect(LIFECYCLE_EVENT_TYPES).toContain(t);
    }
  });
});

// -----------------------------------------------------------------------------
// Catalog wiring (SecurityEvent + Step-up + metrics)
// -----------------------------------------------------------------------------

describe("Phase 27 — Catalog wiring", () => {
  it("SecurityEvent types include Phase 27 retention + destruction signals", () => {
    for (const t of [
      "retention_policy_created",
      "retention_policy_updated",
      "retention_policy_paused",
      "retention_policy_superseded",
      "retention_policy_archived",
      "destruction_review_created",
      "destruction_review_approved",
      "destruction_review_denied",
      "destruction_review_deferred",
      "destruction_review_restored",
      "destruction_executed",
      "destruction_blocked_by_hold",
      "destruction_blocked_by_immutable",
      "export_blocked_by_lifecycle",
      "evidence_lifecycle_transition",
      "lifecycle_transition_blocked",
    ]) {
      expect(SECURITY_EVENT_TYPES).toContain(t);
    }
  });

  it("Step-up purposes include Phase 27 destruction + lifecycle gates", () => {
    for (const p of [
      "RETENTION_POLICY_UPDATE",
      "EVIDENCE_DESTRUCTION_APPROVE",
      "EVIDENCE_DESTRUCTION_EXECUTE",
      "EVIDENCE_LIFECYCLE_FORCE",
    ]) {
      expect(STEP_UP_PURPOSES).toContain(p);
    }
  });

  it("metrics catalog includes Phase 27 counters + gauges", () => {
    const src = readSource(
      "../src/services/ops/metrics.service.ts",
    );
    for (const c of [
      "retention_policy_created_total",
      "retention_policy_updated_total",
      "retention_policy_superseded_total",
      "destruction_review_created_total",
      "destruction_review_approved_total",
      "destruction_review_denied_total",
      "destruction_review_restored_total",
      "destruction_executed_total",
      "destruction_blocked_by_hold_total",
      "destruction_blocked_by_immutable_total",
      "export_blocked_by_lifecycle_total",
      "lifecycle_transition_total",
      "lifecycle_transition_blocked_total",
    ]) {
      expect(src).toContain(`"${c}"`);
    }
    for (const g of [
      "evidence_pending_destruction",
      "active_legal_holds",
      "retention_policy_conflicts",
      "blocked_destruction_attempts",
      "governance_incidents_total",
      "export_governance_blocks",
      "lifecycle_pending_destruction",
      "lifecycle_on_hold",
      "lifecycle_retention_locked",
      "lifecycle_destroyed",
    ]) {
      expect(src).toContain(`"${g}"`);
    }
  });
});

// -----------------------------------------------------------------------------
// Service-source wiring
// -----------------------------------------------------------------------------

describe("Phase 27 — Service source wiring", () => {
  it("retention engine imports the shared schemas + emits the right events", () => {
    const src = readSource(
      "../src/services/governance-lifecycle/retention-engine.service.ts",
    );
    expect(src).toContain("RetentionPolicyCreateInputSchema");
    expect(src).toContain("RetentionPolicyUpdateInputSchema");
    expect(src).toContain("isAllowedRetentionPolicyTransition");
    expect(src).toContain("pickHighestPrecedencePolicy");
    expect(src).toContain("retention_policy_created_total");
    expect(src).toContain("retention_policy_updated_total");
    expect(src).toContain("retention_policy_superseded_total");
    expect(src).toContain("appendPlatformAuditLog");
  });

  it("destruction-review service is hold-aware via the orchestrator preflight", () => {
    const src = readSource(
      "../src/services/governance-lifecycle/destruction-review.service.ts",
    );
    expect(src).toContain("preflightLifecycleTransition");
    expect(src).toContain("LIFECYCLE_BLOCKED_BY_HOLD");
    expect(src).toContain("LIFECYCLE_BLOCKED_BY_IMMUTABLE");
    expect(src).toContain("DESTRUCTION_REVIEW_DECISION_NOTE_REQUIRED");
    expect(src).toContain("certificateHash");
    expect(src).toContain("canonicalJson");
    expect(src).toContain("sha256Hex");
    expect(src).toContain('"destruction_executed"');
    // Governance incident emitted at destruction time.
    expect(src).toContain("recordIncident");
    expect(src).toContain('category: "GOVERNANCE"');
  });

  it("lifecycle orchestrator scrubs sensitive metadata before persistence", () => {
    const src = readSource(
      "../src/services/governance-lifecycle/lifecycle-orchestrator.service.ts",
    );
    expect(src).toContain("scrubMetadata");
    expect(src).toContain("privileged");
    expect(src).toContain("credential");
    // Hold + immutable checks live here so the orchestrator is the single
    // source of truth.
    expect(src).toContain("evidenceHasActiveHold");
    expect(src).toContain("evidenceHasImmutableRetention");
    expect(src).toContain("destruction_blocked_by_hold");
    expect(src).toContain("destruction_blocked_by_immutable");
  });

  it("export governance returns one of the catalogued outcomes", () => {
    const src = readSource(
      "../src/services/governance-lifecycle/export-governance.service.ts",
    );
    expect(src).toContain('"BLOCKED_BY_HOLD"');
    expect(src).toContain('"BLOCKED_BY_LIFECYCLE"');
    expect(src).toContain('"BLOCKED_BY_REVIEW_GATE"');
    expect(src).toContain('"ALLOWED"');
    expect(src).toContain("export_blocked_by_lifecycle_total");
  });
});

// -----------------------------------------------------------------------------
// Route wiring
// -----------------------------------------------------------------------------

describe("Phase 27 — Route wiring", () => {
  const routesSrc = readSource(
    "../src/routes/governance-lifecycle.routes.ts",
  );
  const serverSrc = readSource("../src/server.ts");

  it("server registers the Phase 27 governance lifecycle routes", () => {
    expect(serverSrc).toContain("governanceLifecycleRoutes");
    expect(serverSrc).toMatch(/app\.register\(governanceLifecycleRoutes\)/);
  });

  it("exposes all documented retention-policy endpoints", () => {
    expect(routesSrc).toContain('"/v1/governance/retention-policies"');
    expect(routesSrc).toContain(
      '"/v1/governance/retention-policies/:id"',
    );
    expect(routesSrc).toContain(
      '"/v1/governance/retention-policies/:id/transition"',
    );
    expect(routesSrc).toContain(
      '"/v1/governance/retention-policies/:id/versions"',
    );
    expect(routesSrc).toContain(
      '"/v1/governance/retention-policies/effective"',
    );
  });

  it("exposes destruction-review endpoints + lifecycle + export gate + dashboard", () => {
    expect(routesSrc).toContain('"/v1/governance/destruction-reviews"');
    expect(routesSrc).toContain(
      '"/v1/governance/destruction-reviews/:id"',
    );
    expect(routesSrc).toContain(
      '"/v1/governance/destruction-reviews/:id/transition"',
    );
    expect(routesSrc).toContain(
      '"/v1/governance/lifecycle/evidence/:id/events"',
    );
    expect(routesSrc).toContain(
      '"/v1/governance/lifecycle/evidence/:id/transition"',
    );
    expect(routesSrc).toContain('"/v1/governance/export-eligibility"');
    expect(routesSrc).toContain('"/v1/governance/dashboard"');
  });

  it("requires step-up on destructive destruction-review transitions", () => {
    expect(routesSrc).toContain("EVIDENCE_DESTRUCTION_APPROVE");
    expect(routesSrc).toContain("EVIDENCE_DESTRUCTION_EXECUTE");
    expect(routesSrc).toContain("requireStepUpForSensitiveAction");
  });

  it("requires step-up on forced PENDING_DESTRUCTION / DESTROYED transitions", () => {
    expect(routesSrc).toContain("EVIDENCE_LIFECYCLE_FORCE");
  });

  it("requires step-up on retention policy mutations", () => {
    expect(routesSrc).toContain("RETENTION_POLICY_UPDATE");
  });

  it("non-member fall-through never reveals workspace data", () => {
    // The requireMember helper returns null and sends 403; every route
    // returns immediately on null.
    expect(routesSrc).toContain("if (!ok) return");
  });
});

// -----------------------------------------------------------------------------
// UI wording sweep
// -----------------------------------------------------------------------------

describe("Phase 27 — UI wording sweep", () => {
  const playfulPhrases = [
    "oops",
    "yay",
    "let's go",
    "awesome",
    "🎉",
    "🚀",
    "love it",
  ];
  const truthClaimPhrases = [
    "guaranteed",
    "tamper-proof",
    "100% authentic",
    "legally admissible",
    "court-ready",
  ];

  function assertCleanOf(rel: string) {
    const src = readSource(rel);
    for (const phrase of playfulPhrases) {
      expect(src.toLowerCase()).not.toContain(phrase);
    }
    for (const phrase of truthClaimPhrases) {
      expect(src.toLowerCase()).not.toContain(phrase);
    }
  }

  it("operations dashboard wording is enterprise-grade", () => {
    assertCleanOf("../../../apps/web/app/(app)/governance/lifecycle/page.tsx");
  });

  it("retention policies console wording is enterprise-grade", () => {
    assertCleanOf("../../../apps/web/app/(app)/governance/retention/page.tsx");
  });

  it("destruction queue wording is enterprise-grade", () => {
    assertCleanOf(
      "../../../apps/web/app/(app)/governance/destruction/page.tsx",
    );
  });
});

// -----------------------------------------------------------------------------
// Migration wiring
// -----------------------------------------------------------------------------

describe("Phase 27 — Migration safety", () => {
  const migrationSrc = readSource(
    "../prisma/migrations/20260606100000_phase27_retention_lifecycle/migration.sql",
  );

  it("creates the EvidenceLifecycleState enum + new evidence columns", () => {
    expect(migrationSrc).toContain("EvidenceLifecycleState");
    expect(migrationSrc).toContain("lifecycle_state");
    expect(migrationSrc).toContain("retention_policy_version_id");
    expect(migrationSrc).toContain("active_destruction_review_id");
  });

  it("creates the four Phase 27 tables", () => {
    expect(migrationSrc).toContain("evidence_retention_policies");
    expect(migrationSrc).toContain("evidence_retention_policy_versions");
    expect(migrationSrc).toContain("destruction_reviews");
    expect(migrationSrc).toContain("evidence_lifecycle_events");
  });

  it("guards every FK with DO $$ pg_constraint $$ block (idempotent)", () => {
    expect(migrationSrc).toContain("DO $$");
    expect(migrationSrc).toContain("pg_constraint");
  });
});
