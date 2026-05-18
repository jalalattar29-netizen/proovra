/**
 * Phase 25.5 — Reviewer Operations Hardening API regression tests.
 *
 * No DB. Source-text + pure-helper + projection tests.
 *
 * Coverage:
 *   - Engine wiring: assignReviewerToWorkflow reads the layered SLA
 *     resolver (template > workspace > env).
 *   - Engine wiring: reconcile invokes the reminder sweep + inactivity
 *     sweep when workspace flag set.
 *   - Bulk triage service: partial-success aware, dedupes
 *     workflowIds, requires note for note-required actions.
 *   - Saved-queue-views service: only touches REVIEWER_OPS scope; never
 *     reads cross-team rows.
 *   - Reminder engine: fingerprint dedup; safeSummary scrub.
 *   - Step-up wiring: routes call requireStepUpForSensitiveAction
 *     under the workspace governance flag.
 *   - SLA policy route: GOVERNANCE_POLICY_UPDATE step-up required to
 *     edit.
 *   - Analytics service: range bounded (max 90 days); operator-safe
 *     fields only.
 *   - Routes: new Phase 25.5 endpoints registered.
 *   - Wording sweep: no forbidden overclaim phrase in the new sources
 *     or in the new admin / analytics pages.
 *   - Public-verify isolation + untouched-files invariants preserved.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  REVIEWER_OPS_BULK_ACTIONS,
  REVIEWER_OPS_REMINDER_KINDS,
  REVIEWER_OPS_SAVED_VIEW_SCOPE,
  REVIEWER_OPS_SLA_POLICY_HOURS_MAX,
  SAVED_VIEW_SCOPES,
  SEARCH_FORBIDDEN_OVERCLAIM_PHRASES,
  isReviewerInactive,
  resolveReviewerOpsSlaPolicy,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(rel, import.meta.url)),
    "utf8",
  );
}

// -----------------------------------------------------------------------------
// SLA policy resolver wiring
// -----------------------------------------------------------------------------

describe("Phase 25.5 — SLA policy resolver wiring", () => {
  const slaSrc = readSource(
    "../src/services/reviewer-ops/sla-policy.service.ts",
  );
  const engineSrc = readSource(
    "../src/services/reviewer-ops/reviewer-operations-engine.service.ts",
  );

  it("sla-policy.service.ts reads env, workspace, and template layers", () => {
    expect(slaSrc).toMatch(/loadWorkspaceOverride/);
    expect(slaSrc).toMatch(/loadTemplateOverride/);
    expect(slaSrc).toMatch(/envOverride/);
    expect(slaSrc).toMatch(/resolveReviewerOpsSlaPolicy/);
  });

  it("env override is bounded by the shared schema", () => {
    expect(slaSrc).toMatch(/REVIEWER_OPS_SLA_POLICY_HOURS_MIN/);
    expect(slaSrc).toMatch(/REVIEWER_OPS_SLA_POLICY_HOURS_MAX/);
  });

  it("template overrides validate via ReviewerOpsSlaPolicySchema (fail-open on invalid)", () => {
    expect(slaSrc).toMatch(/ReviewerOpsSlaPolicySchema\.safeParse/);
  });

  it("engine uses resolveEffectiveSlaPolicy at assignment time", () => {
    expect(engineSrc).toMatch(/resolveEffectiveSlaPolicy/);
  });

  it("engine reconcile wires reminder + inactivity sweeps", () => {
    expect(engineSrc).toMatch(/sweepDueSoonReminders/);
    expect(engineSrc).toMatch(/sweepInactivityReminders/);
    expect(engineSrc).toMatch(/loadWorkspaceReviewerOpsFlags/);
  });
});

// -----------------------------------------------------------------------------
// Bulk triage service
// -----------------------------------------------------------------------------

describe("Phase 25.5 — bulk triage service", () => {
  const src = readSource(
    "../src/services/reviewer-ops/bulk-triage.service.ts",
  );

  it("dedupes workflowIds before dispatching", () => {
    expect(src).toMatch(/seen\.add\(id\)/);
    expect(src).toMatch(/Set<string>/);
  });

  it("partial-success aware (returns per-item ok/errorCode)", () => {
    expect(src).toMatch(/items\.filter\(\(i\) => i\.ok\)/);
    expect(src).toMatch(/errorCode/);
  });

  it("note-required actions throw REVIEW_NOTE_REQUIRED when missing", () => {
    // Source-level: each note-required branch checks the input.note.
    expect(src).toMatch(/case "ESCALATE":/);
    expect(src).toMatch(/REVIEW_NOTE_REQUIRED/);
    expect(src).toMatch(/case "PAUSE":/);
    expect(src).toMatch(/case "REQUEST_INFO":/);
  });

  it("bulk metric + audit emitted at the outer level (not per row)", () => {
    expect(src).toMatch(/reviewer_bulk_action_total/);
    expect(src).toMatch(/reviewer_bulk_triage_executed/);
    expect(src).toMatch(/appendPlatformAuditLog\(/);
  });

  it("priority change writes a field update (no lifecycle transition)", () => {
    expect(src).toMatch(/priorityValue/);
    expect(src).toMatch(/evidenceReviewWorkflow\.update/);
  });
});

// -----------------------------------------------------------------------------
// Saved queue views service
// -----------------------------------------------------------------------------

describe("Phase 25.5 — saved queue views", () => {
  const src = readSource(
    "../src/services/reviewer-ops/saved-queue-views.service.ts",
  );

  it("every query filters on scope = REVIEWER_OPS", () => {
    // 3 spots: list, delete, (create writes the scope on insert).
    const matches = src.match(/REVIEWER_OPS_SAVED_VIEW_SCOPE/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("PRIVATE views are deletable only by the creator", () => {
    expect(src).toMatch(
      /visibility\s*===\s*["']PRIVATE["'][\s\S]*?createdByUserId\s*!==\s*input\.actorUserId/,
    );
  });

  it("create rejects cross-team filter (filter.teamId !== input.teamId)", () => {
    expect(src).toMatch(/input\.filter\.teamId\s*!==\s*input\.teamId/);
  });

  it("read uses the discriminator + TEAM-visibility OR clause", () => {
    expect(src).toMatch(/visibility:\s*["']TEAM["']/);
  });
});

// -----------------------------------------------------------------------------
// Reminder engine
// -----------------------------------------------------------------------------

describe("Phase 25.5 — reminder engine", () => {
  const src = readSource(
    "../src/services/reviewer-ops/reminder-engine.service.ts",
  );

  it("fingerprint dedup uses workflowId / escalationId / reviewerUserId + kind + dayBucket", () => {
    expect(src).toMatch(/dayBucket\(input\.now\)/);
    expect(src).toMatch(/createHash\(["']sha256["']\)/);
  });

  it("safe summary scrubs forbidden overclaim wording", () => {
    expect(src).toMatch(/stringContainsForbiddenOverclaim/);
    expect(src).toMatch(/summary withheld/);
  });

  it("scheduleReminder catches unique-violation race + returns existing", () => {
    expect(src).toMatch(/reviewer_reminder_duplicate_blocked_total/);
    expect(src).toMatch(/findUnique/);
  });

  it("sweeps are bounded and idempotent", () => {
    expect(src).toMatch(/sweepDueSoonReminders/);
    expect(src).toMatch(/sweepInactivityReminders/);
    expect(src).toMatch(/Math\.min\(Math\.max\(input\.batchSize/);
  });

  it("delivery success and failure update status (insert-only otherwise)", () => {
    expect(src).toMatch(/markReminderDelivered/);
    expect(src).toMatch(/markReminderFailed/);
    expect(src).toMatch(/reviewer_reminder_delivered_total/);
    expect(src).toMatch(/reviewer_reminder_failed_total/);
  });
});

// -----------------------------------------------------------------------------
// Step-up wiring
// -----------------------------------------------------------------------------

describe("Phase 25.5 — step-up wiring", () => {
  const src = readSource("../src/routes/reviewer-ops.routes.ts");

  it("enforceStepUpIfFlagged helper exists and reads workspace flags", () => {
    expect(src).toMatch(/enforceStepUpIfFlagged/);
    expect(src).toMatch(/loadWorkspaceReviewerOpsFlags/);
    expect(src).toMatch(/STEP_UP_FLAG_BY_GATE/);
  });

  it("approve / reject / escalation-resolve / escalation-suppress routes invoke the gate", () => {
    // Count distinct call sites in the routes file.
    const matches =
      src.match(/await enforceStepUpIfFlagged\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });

  it("the gate maps to the right shared step-up purposes", () => {
    expect(src).toMatch(/REVIEW_APPROVAL_HIGH_RISK/);
    expect(src).toMatch(/REVIEWER_OPS_REJECT/);
    expect(src).toMatch(/REVIEWER_OPS_ESCALATION_RESOLVE/);
    expect(src).toMatch(/REVIEWER_OPS_BULK_ACTION/);
  });

  it("SLA policy edit route requires GOVERNANCE_POLICY_UPDATE step-up", () => {
    // POST /v1/reviewer-ops/sla-policy must exist.
    expect(src).toMatch(
      /app\.post\(\s*"\/v1\/reviewer-ops\/sla-policy"/,
    );
    // The route file must reference the GOVERNANCE_POLICY_UPDATE
    // purpose, which is only used by this route.
    expect(src).toMatch(/purpose:\s*["']GOVERNANCE_POLICY_UPDATE["']/);
  });
});

// -----------------------------------------------------------------------------
// Analytics service
// -----------------------------------------------------------------------------

describe("Phase 25.5 — analytics service", () => {
  const src = readSource(
    "../src/services/reviewer-ops/analytics.service.ts",
  );

  it("range is bounded (1..90 days)", () => {
    expect(src).toMatch(/ANALYTICS_RANGE_MAX_DAYS/);
    expect(src).toMatch(/90/);
  });

  it("daily buckets are seeded so the UI gets contiguous range with zeros", () => {
    expect(src).toMatch(/Seed buckets so the UI gets a contiguous range/);
  });

  it("hotspots are keyed by ReviewEscalationReason from the shared catalog", () => {
    expect(src).toMatch(/REVIEW_ESCALATION_REASONS/);
  });

  it("reviewer perf reads workload snapshot for capacity score", () => {
    expect(src).toMatch(/reviewerWorkloadSnapshot\.findMany/);
    expect(src).toMatch(/latestCapacity/);
  });

  it("metric bumped on view", () => {
    expect(src).toMatch(/reviewer_analytics_viewed_total/);
  });
});

// -----------------------------------------------------------------------------
// Route registration
// -----------------------------------------------------------------------------

describe("Phase 25.5 — routes registered", () => {
  const src = readSource("../src/routes/reviewer-ops.routes.ts");

  it("all Phase 25.5 endpoints present", () => {
    for (const path of [
      "/v1/reviewer-ops/reviews/bulk",
      "/v1/reviewer-ops/saved-views",
      "/v1/reviewer-ops/saved-views/:id",
      "/v1/reviewer-ops/analytics/escalations",
      "/v1/reviewer-ops/analytics/reviewers",
      "/v1/reviewer-ops/sla-policy",
    ]) {
      expect(src.includes(`"${path}"`), `missing route ${path}`).toBe(true);
    }
  });

  it("bulk route validates via shared schema before reviewer-actor lookup", () => {
    expect(src).toMatch(/ReviewerOpsBulkInputSchema\.safeParse/);
  });

  it("saved-views POST validates filter via shared schema", () => {
    expect(src).toMatch(/ReviewerOpsSavedViewFilterSchema/);
  });
});

// -----------------------------------------------------------------------------
// Wording sweep across new Phase 25.5 sources + UI pages
// -----------------------------------------------------------------------------

describe("Phase 25.5 — wording sweep", () => {
  const sources = [
    "../src/services/reviewer-ops/sla-policy.service.ts",
    "../src/services/reviewer-ops/bulk-triage.service.ts",
    "../src/services/reviewer-ops/saved-queue-views.service.ts",
    "../src/services/reviewer-ops/reminder-engine.service.ts",
    "../src/services/reviewer-ops/analytics.service.ts",
    "../../../apps/web/app/(app)/reviewer-ops/policy/page.tsx",
  ];
  for (const path of sources) {
    it(`no overclaim phrase in ${path.split("/").slice(-2).join("/")}`, () => {
      const src = readSource(path);
      for (const re of SEARCH_FORBIDDEN_OVERCLAIM_PHRASES) {
        expect(src).not.toMatch(re);
      }
    });
  }
});

// -----------------------------------------------------------------------------
// Pure helper smoke tests (Phase 25.5 shared helpers in API land)
// -----------------------------------------------------------------------------

describe("Phase 25.5 — pure helpers reachable from API", () => {
  it("resolveReviewerOpsSlaPolicy precedence holds in API context", () => {
    const p = resolveReviewerOpsSlaPolicy({
      envDefaults: { assignmentHours: 12 },
      workspaceOverride: { completionHours: 48 },
      templateOverride: { assignmentHours: 1 },
    });
    expect(p.assignmentHours).toBe(1);
    expect(p.completionHours).toBe(48);
  });

  it("isReviewerInactive flips at the configured threshold", () => {
    const now = new Date("2026-05-18T12:00:00Z");
    const stale = new Date(now.getTime() - 50 * 3600_000);
    expect(
      isReviewerInactive({
        nowUtc: now,
        lastReviewedAtUtc: stale,
        assignedAtUtc: null,
        thresholdHours: 48,
      }),
    ).toBe(true);
  });

  it("REVIEWER_OPS_BULK_ACTIONS includes ASSIGN through PRIORITY_URGENT", () => {
    expect(REVIEWER_OPS_BULK_ACTIONS.length).toBeGreaterThanOrEqual(9);
  });

  it("REVIEWER_OPS_REMINDER_KINDS includes the four kinds", () => {
    expect(REVIEWER_OPS_REMINDER_KINDS.length).toBe(4);
  });

  it("SAVED_VIEW_SCOPES includes the REVIEWER_OPS scope", () => {
    expect(SAVED_VIEW_SCOPES.includes(REVIEWER_OPS_SAVED_VIEW_SCOPE)).toBe(true);
  });

  it("SLA policy hours max is 720 (30 days)", () => {
    expect(REVIEWER_OPS_SLA_POLICY_HOURS_MAX).toBe(720);
  });
});

// -----------------------------------------------------------------------------
// Public verify isolation
// -----------------------------------------------------------------------------

describe("Phase 25.5 — public verify isolation", () => {
  it("evidence.routes.ts does NOT import Phase 25.5 services", () => {
    const src = readSource("../src/routes/evidence.routes.ts");
    expect(src).not.toMatch(/reviewer-ops\/bulk-triage/);
    expect(src).not.toMatch(/reviewer-ops\/saved-queue-views/);
    expect(src).not.toMatch(/reviewer-ops\/reminder-engine/);
    expect(src).not.toMatch(/reviewer-ops\/analytics/);
    expect(src).not.toMatch(/reviewer-ops\/sla-policy/);
  });
});

// -----------------------------------------------------------------------------
// Untouched files invariant
// -----------------------------------------------------------------------------

describe("Phase 25.5 — untouched files invariant", () => {
  it("services/worker/src/pdf/report.ts has NO Phase 25.5 markers", () => {
    const src = readSource("../../worker/src/pdf/report.ts");
    expect(src).not.toMatch(/Phase 25\.5/);
    expect(src).not.toMatch(/ReviewerOpsReminder/);
    expect(src).not.toMatch(/bulk-triage/);
  });
});

// -----------------------------------------------------------------------------
// Runbooks present
// -----------------------------------------------------------------------------

describe("Phase 25.5 — runbooks present", () => {
  for (const slug of [
    "reviewer-sla-breach",
    "reviewer-escalation-backlog",
    "reviewer-inactivity",
    "reviewer-queue-stuck",
  ]) {
    it(`runbook ${slug} exists with the expected slug header`, () => {
      const src = readSource(`../../../docs/runbooks/${slug}.md`);
      expect(src).toMatch(new RegExp(`Slug:\\*\\*\\s*\`${slug}\``));
      // Standard runbook sections.
      expect(src).toMatch(/## Symptoms/);
      expect(src).toMatch(/## Detection/);
      expect(src).toMatch(/## Operational response/);
      expect(src).toMatch(/## Mitigation/);
      expect(src).toMatch(/## Escalation path/);
      expect(src).toMatch(/## Verification steps/);
    });
  }
});
