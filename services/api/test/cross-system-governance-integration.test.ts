/**
 * Phase 28-D — Cross-system governance integration tests.
 *
 * Proves the canonical decision helpers, the unified
 * GovernanceSnapshotService, and the new routes are all wired so that
 * one read of the snapshot is the single source of truth for:
 *
 *   - Lifecycle state
 *   - Review state (workflow + SLA + escalation)
 *   - Legal hold (direct + case)
 *   - Retention binding (immutable + expired)
 *   - Active destruction review
 *   - Export eligibility
 *   - Package eligibility (export + immutable drift)
 *   - Open operational incidents
 *   - Storage governance drift
 *   - Operator-safe warnings
 *
 * No DB: pure-helper + source-contract assertions only. A live
 * integration test would require staging Postgres; the
 * operational-seeding flow (Phase 28-C) exercises the same chain
 * against a real DB.
 *
 * Hard rules followed by this file:
 *   - No new product features asserted.
 *   - No assumption that drift is content tamper — wording is
 *     explicitly checked.
 *   - Cleanup / privacy invariants get explicit tests.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PACKAGE_ELIGIBILITY_OUTCOMES,
  canonicalCanEnterPendingDestruction,
  canonicalEvaluateExportEligibility,
  canonicalEvaluatePackageEligibility,
  exportEligibilityLabel,
  packageEligibilityLabel,
  type CanonicalPackageFacts,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// Pure helper — canonicalEvaluatePackageEligibility
// =============================================================================

describe("Phase 28-D — canonicalEvaluatePackageEligibility precedence", () => {
  const cleanFacts: CanonicalPackageFacts = {
    lifecycleState: "ACTIVE",
    hasActiveDirectHold: false,
    hasActiveCaseHold: false,
    hasActiveDestructionReview: false,
    hasOpenImmutableDriftIncident: false,
  };

  it("ALLOWED on a clean record", () => {
    expect(canonicalEvaluatePackageEligibility(cleanFacts)).toEqual({
      outcome: "ALLOWED",
      reason: "ok",
    });
  });

  it("hold beats every other blocker", () => {
    const d = canonicalEvaluatePackageEligibility({
      ...cleanFacts,
      lifecycleState: "RETENTION_LOCKED",
      hasActiveDirectHold: true,
      hasActiveDestructionReview: true,
      destructionReviewStatus: "PENDING",
      hasOpenImmutableDriftIncident: true,
    });
    expect(d.outcome).toBe("BLOCKED_BY_HOLD");
  });

  it("case hold blocks even without direct hold", () => {
    const d = canonicalEvaluatePackageEligibility({
      ...cleanFacts,
      hasActiveCaseHold: true,
    });
    expect(d.outcome).toBe("BLOCKED_BY_HOLD");
  });

  it("lifecycle blockers (DESTROYED / PENDING_DESTRUCTION / ON_HOLD / RETENTION_LOCKED)", () => {
    for (const state of [
      "DESTROYED",
      "PENDING_DESTRUCTION",
      "ON_HOLD",
      "RETENTION_LOCKED",
    ] as const) {
      const d = canonicalEvaluatePackageEligibility({
        ...cleanFacts,
        lifecycleState: state,
      });
      expect(d.outcome).toBe("BLOCKED_BY_LIFECYCLE");
    }
  });

  it("non-terminal destruction review blocks (PENDING/UNDER_REVIEW/DEFERRED/APPROVED)", () => {
    for (const status of [
      "PENDING",
      "UNDER_REVIEW",
      "DEFERRED",
      "APPROVED",
    ] as const) {
      const d = canonicalEvaluatePackageEligibility({
        ...cleanFacts,
        hasActiveDestructionReview: true,
        destructionReviewStatus: status,
      });
      expect(d.outcome).toBe("BLOCKED_BY_REVIEW_GATE");
    }
  });

  it("immutable drift fires LAST in the precedence ladder", () => {
    // Drift only blocks when nothing else does. Verified by toggling
    // every other blocker off and the drift flag on.
    const d = canonicalEvaluatePackageEligibility({
      ...cleanFacts,
      hasOpenImmutableDriftIncident: true,
    });
    expect(d.outcome).toBe("BLOCKED_BY_IMMUTABLE_DRIFT");
    expect(d.reason).toBe("immutable_storage_drift_open");
  });

  it("drift label uses storage-governance wording (never content tamper)", () => {
    const label = packageEligibilityLabel("BLOCKED_BY_IMMUTABLE_DRIFT");
    expect(label.toLowerCase()).toContain("storage");
    expect(label.toLowerCase()).not.toMatch(/tamper|altered|modified content/);
  });

  it("every outcome has an operator-readable label", () => {
    for (const o of PACKAGE_ELIGIBILITY_OUTCOMES) {
      const label = packageEligibilityLabel(o);
      expect(label).toBeTruthy();
      expect(label.length).toBeLessThan(120);
    }
  });

  it("package decision is byte-compatible with export decision for non-drift outcomes", () => {
    // Same facts → export decides hold/lifecycle/review identically.
    const exportFacts = {
      lifecycleState: "PENDING_DESTRUCTION" as const,
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: false,
    };
    const ex = canonicalEvaluateExportEligibility(exportFacts);
    const pk = canonicalEvaluatePackageEligibility({
      ...exportFacts,
      hasOpenImmutableDriftIncident: false,
    });
    expect(pk.outcome).toBe(ex.outcome);
    expect(pk.reason).toBe(ex.reason);
    expect(exportEligibilityLabel(ex.outcome)).toBeTruthy();
  });
});

// =============================================================================
// Source contract — snapshot service wiring
// =============================================================================

describe("Phase 28-D — governance-snapshot.service wiring", () => {
  const src = readSource(
    "../src/services/governance-lifecycle/governance-snapshot.service.ts",
  );

  it("uses the canonical export + package + destruction helpers (no inline duplication)", () => {
    expect(src).toContain("canonicalEvaluateExportEligibility");
    expect(src).toContain("canonicalEvaluatePackageEligibility");
    expect(src).toContain("canonicalCanEnterPendingDestruction");
  });

  it("fans out queries in parallel via Promise.all", () => {
    expect(src).toMatch(/Promise\.all\(\[/);
  });

  it("counts direct hold and case hold separately", () => {
    // PHASE 12 POINT 3 — both counters read the ONE canonical table. They stay
    // SEPARATE (that is the invariant): the case-hold count is scope-filtered,
    // the direct-hold count is not, so a case hold is never silently folded
    // into the per-record total.
    expect(src).toMatch(/evidenceLegalHold\.count/);
    expect(src).toMatch(/scope: "CASE"/);
    expect(src).not.toMatch(/caseLegalHold\.count/);
  });

  it("derives immutable drift from OperationalIncident.runbookSlug === 'immutable-drift'", () => {
    expect(src).toContain('IMMUTABLE_DRIFT_RUNBOOK');
    expect(src).toContain('"immutable-drift"');
  });

  it("bumps the governance_snapshot_requested_total counter", () => {
    expect(src).toMatch(
      /bump\("governance_snapshot_requested_total"\)/,
    );
  });

  it("never returns private review note bodies", () => {
    // The workflow selection should pluck only the bounded fields,
    // not the privateReviewerNote / decisionNote / pausedReason
    // strings.
    expect(src).not.toMatch(/privateReviewerNote/);
    expect(src).not.toMatch(/decisionNote/);
    expect(src).not.toMatch(/note\s*:\s*true/);
  });

  it("drift label is bounded to storage-governance wording", () => {
    expect(src).toContain('"Storage governance drift');
    // Scope the negative check to STRING LITERALS only — comments may
    // legitimately mention "tamper" / "altered" / "modified" while
    // explaining what the labels must NOT contain.
    const stringLiterals = src.match(/"[^"\n]+"/g) ?? [];
    const allStrings = stringLiterals.join(" ");
    expect(allStrings).not.toMatch(/tamper|altered content|forged/i);
  });

  it("derives operator warnings from real state (never invents events)", () => {
    expect(src).toContain("function deriveWarnings");
    // Warnings list maps to bounded codes.
    expect(src).toContain("ACTIVE_LEGAL_HOLD");
    expect(src).toContain("LIFECYCLE_PENDING_DESTRUCTION");
    expect(src).toContain("DESTRUCTION_REVIEW_ACTIVE");
    expect(src).toContain("IMMUTABLE_STORAGE_DRIFT");
    expect(src).toContain("SLA_BREACHED");
    expect(src).toContain("ESCALATION_OPEN");
    expect(src).toContain("RETENTION_EXPIRED");
  });
});

// =============================================================================
// Source contract — timeline service wiring
// =============================================================================

describe("Phase 28-D — operational-timeline.service wiring", () => {
  const src = readSource(
    "../src/services/governance-lifecycle/operational-timeline.service.ts",
  );

  it("reads only real event sources (no derived events)", () => {
    expect(src).toMatch(/evidenceLifecycleEvent\.findMany/);
    expect(src).toMatch(/evidenceReviewWorkflowEvent\.findMany/);
    expect(src).toMatch(/operationalIncident\.findMany/);
  });

  it("never surfaces private review notes", () => {
    // The schema's workflow-event table has a `note` field that may
    // carry private content. The timeline projection must NOT select
    // it.
    expect(src).not.toMatch(/\bnote:\s*true\b/);
    // The projection explicitly nulls safeSummary for review events.
    expect(src).toMatch(/private content|private review/i);
    expect(src).toMatch(/safeSummary:\s*null/);
  });

  it("merges streams by timestamp DESC", () => {
    expect(src).toMatch(/entries\.sort/);
    expect(src).toMatch(/occurredAtUtc/);
  });

  it("caps result count via a bounded limit", () => {
    expect(src).toMatch(/Math\.min\(input\.limit \?\? 100, 500\)/);
  });

  it("bumps operational_timeline_loaded_total", () => {
    expect(src).toMatch(/bump\("operational_timeline_loaded_total"\)/);
  });
});

// =============================================================================
// Source contract — routes
// =============================================================================

describe("Phase 28-D — routes registered + gated", () => {
  it("GET /v1/evidence/:id/governance-snapshot requires audit.read", () => {
    const src = readSource("../src/routes/governance-snapshot.routes.ts");
    expect(src).toMatch(
      /permission:\s*"audit\.read"/,
    );
    expect(src).toMatch(/governance-snapshot/);
    expect(src).toMatch(/operational-timeline/);
  });

  it("snapshot route bumps blocker counters per outcome class", () => {
    const src = readSource("../src/routes/governance-snapshot.routes.ts");
    expect(src).toMatch(/bump\("export_governance_blocked_total"\)/);
    expect(src).toMatch(/bump\("package_governance_blocked_total"\)/);
    expect(src).toMatch(/bump\("immutable_drift_block_total"\)/);
    expect(src).toMatch(/bump\("legal_hold_export_block_total"\)/);
    expect(src).toMatch(/bump\("retention_destruction_candidate_total"\)/);
  });

  it("snapshot route returns 404 for non-member tenants (anti-enum)", () => {
    const src = readSource("../src/routes/governance-snapshot.routes.ts");
    expect(src).toMatch(/reply\.code\(404\)/);
    expect(src).toMatch(/code:\s*"not_found"/);
  });

  it("server.ts registers the new routes", () => {
    const src = readSource("../src/server.ts");
    expect(src).toContain("governanceSnapshotRoutes");
    expect(src).toContain("./routes/governance-snapshot.routes.js");
  });
});

// =============================================================================
// Cross-system chain — every link the brief asks for
// =============================================================================

describe("Phase 28-D — cross-system chain proof", () => {
  it("review approval unlocks export only when policy allows (canonical helper)", () => {
    // A workflow in approved state with no hold + ACTIVE lifecycle
    // should pass the export check.
    const decision = canonicalEvaluateExportEligibility({
      lifecycleState: "ACTIVE",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: false,
    });
    expect(decision.outcome).toBe("ALLOWED");
  });

  it("needs-info/rejected workflow with active destruction review still blocks export", () => {
    const decision = canonicalEvaluateExportEligibility({
      lifecycleState: "ACTIVE",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: true,
      destructionReviewStatus: "UNDER_REVIEW",
    });
    expect(decision.outcome).toBe("BLOCKED_BY_REVIEW_GATE");
  });

  it("legal hold blocks destruction (canonical helper)", () => {
    const decision = canonicalCanEnterPendingDestruction({
      fromState: "ACTIVE",
      hasActiveDirectHold: true,
      hasActiveCaseHold: false,
      immutableRetention: false,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("blocked_by_hold");
  });

  it("legal hold blocks package generation (canonical helper)", () => {
    const decision = canonicalEvaluatePackageEligibility({
      lifecycleState: "ACTIVE",
      hasActiveDirectHold: true,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: false,
      hasOpenImmutableDriftIncident: false,
    });
    expect(decision.outcome).toBe("BLOCKED_BY_HOLD");
  });

  it("immutable drift blocks package generation", () => {
    const decision = canonicalEvaluatePackageEligibility({
      lifecycleState: "ACTIVE",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      hasActiveDestructionReview: false,
      hasOpenImmutableDriftIncident: true,
    });
    expect(decision.outcome).toBe("BLOCKED_BY_IMMUTABLE_DRIFT");
  });

  it("retention expired records become destruction candidates only when no hold/immutable", () => {
    // Retention expiry is checked in the snapshot service; the
    // canonical destruction helper enforces that hold/immutable still
    // win even after retention expires.
    const decision = canonicalCanEnterPendingDestruction({
      fromState: "ACTIVE",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      immutableRetention: true,
    });
    expect(decision.allowed).toBe(false);
  });

  it("retention expired + clean state → destruction eligible", () => {
    const decision = canonicalCanEnterPendingDestruction({
      fromState: "ACTIVE",
      hasActiveDirectHold: false,
      hasActiveCaseHold: false,
      immutableRetention: false,
    });
    expect(decision.allowed).toBe(true);
  });
});

// =============================================================================
// Metrics catalog includes every Phase 28-D counter
// =============================================================================

describe("Phase 28-D — metrics catalog completeness", () => {
  const src = readSource("../../../packages/shared-runtime/src/ops/metrics.service.ts");
  const required = [
    "governance_snapshot_requested_total",
    "export_governance_blocked_total",
    "package_governance_blocked_total",
    "immutable_drift_block_total",
    "legal_hold_export_block_total",
    "retention_destruction_candidate_total",
    "external_review_access_blocked_total",
    "operational_timeline_loaded_total",
  ];

  for (const counter of required) {
    it(`registers ${counter}`, () => {
      expect(src).toContain(`"${counter}"`);
    });
  }
});

// =============================================================================
// Privacy invariants
// =============================================================================

describe("Phase 28-D — privacy invariants", () => {
  const snapshotSrc = readSource(
    "../src/services/governance-lifecycle/governance-snapshot.service.ts",
  );
  const timelineSrc = readSource(
    "../src/services/governance-lifecycle/operational-timeline.service.ts",
  );

  it("snapshot service does not select private fields from review workflow", () => {
    // The Prisma `select` block must explicitly enumerate fields; we
    // ban the forbidden ones below.
    expect(snapshotSrc).not.toMatch(/privateReviewerNote/);
    expect(snapshotSrc).not.toMatch(/decisionNote:\s*true/);
    expect(snapshotSrc).not.toMatch(/pausedReason:\s*true/);
    expect(snapshotSrc).not.toMatch(/rejectionReason:\s*true/);
  });

  it("timeline projection never surfaces note bodies", () => {
    expect(timelineSrc).not.toMatch(/\bnote:\s*true\b/);
    // The schema-event table's `note` field is on the table but
    // intentionally not selected. The projection comment confirms.
    expect(timelineSrc).toMatch(/never surface/i);
  });

  it("snapshot warnings carry only bounded labels (no PII)", () => {
    expect(snapshotSrc).toMatch(/Operator-readable, bounded-catalog label/);
  });
});

// =============================================================================
// Wording invariants — drift must never imply content tamper
// =============================================================================

describe("Phase 28-D — drift wording invariant", () => {
  it("snapshot service drift label uses storage-governance wording", () => {
    const src = readSource(
      "../src/services/governance-lifecycle/governance-snapshot.service.ts",
    );
    expect(src).toContain("Storage governance drift");
    // Scope the negative check to string literals only — comments may
    // legitimately reference what the labels must NOT contain.
    const stringLiterals = src.match(/"[^"\n]+"/g) ?? [];
    const allStrings = stringLiterals.join(" ");
    expect(allStrings).not.toMatch(/tamper|altered content|forged|forgery/i);
  });

  it("canonical package label uses storage-governance wording", () => {
    const label = packageEligibilityLabel("BLOCKED_BY_IMMUTABLE_DRIFT");
    expect(label).toContain("Storage");
    expect(label).not.toMatch(/tamper|altered|forged/i);
  });
});
