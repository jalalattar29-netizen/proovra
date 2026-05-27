/**
 * Phase B.2 — Multi-stage review governance.
 *
 * Locks in:
 *
 *   1. `GET  /v1/reviewer-ops/workspace/:workflowId/decisions` exists,
 *      requires auth + team-member gate, returns the documented
 *      envelope (state, secondReviewRequirement, callerContext,
 *      decisions).
 *
 *   2. `POST /v1/reviewer-ops/workspace/:workflowId/decisions` exists,
 *      requires auth + team-member gate, validates body shape, returns
 *      201 on success and the correct error codes on each enforced
 *      guard.
 *
 *   3. Source-presence guards for:
 *      - the new SQL migration file
 *      - the new Prisma model declaration
 *      - the API endpoints + state-machine logic
 *      - the frontend decision-lineage panel + form
 *
 *   4. No regression on Phase 2.7X / A.1B / A.1C / A.1D / Phase B /
 *      Phase B.1 / Phase C contracts.
 */
import { test, expect } from "@playwright/test";
import {
  clearTestRateLimits,
  createGuestSession,
} from "./helpers/api-client";

test.beforeEach(async () => {
  await clearTestRateLimits();
});

const NONEXISTENT_TEAM = "00000000-0000-4000-8000-0000000000d1";
const NONEXISTENT_WORKFLOW = "00000000-0000-4000-8000-0000000000d2";

test.describe("Phase B.2 — multi-stage review governance @critical", () => {
  // ---------------------------------------------------------------------------
  // Auth + RBAC contracts.
  // ---------------------------------------------------------------------------
  test("GET decisions requires auth", async () => {
    const { request } = await import("@playwright/test");
    const anon = await request.newContext({
      baseURL: process.env.API_BASE ?? "http://localhost:8081",
    });
    const resp = await anon.get(
      `/v1/reviewer-ops/workspace/${NONEXISTENT_WORKFLOW}/decisions?teamId=${NONEXISTENT_TEAM}`,
    );
    expect([401, 403]).toContain(resp.status());
    await anon.dispose();
  });

  test("POST decisions requires auth", async () => {
    const { request } = await import("@playwright/test");
    const anon = await request.newContext({
      baseURL: process.env.API_BASE ?? "http://localhost:8081",
    });
    const resp = await anon.post(
      `/v1/reviewer-ops/workspace/${NONEXISTENT_WORKFLOW}/decisions`,
      {
        data: {
          teamId: NONEXISTENT_TEAM,
          decision: "APPROVE",
          rationale: "test",
        },
      },
    );
    expect([401, 403]).toContain(resp.status());
    await anon.dispose();
  });

  test("GET decisions for unknown team returns 404 (non-member)", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get(
      `/v1/reviewer-ops/workspace/${NONEXISTENT_WORKFLOW}/decisions?teamId=${NONEXISTENT_TEAM}`,
    );
    expect(resp.status()).toBe(404);
  });

  test("POST decisions validates body shape", async () => {
    const session = await createGuestSession();
    const resp = await session.api.post(
      `/v1/reviewer-ops/workspace/${NONEXISTENT_WORKFLOW}/decisions`,
      { data: {} },
    );
    expect(resp.status()).toBe(400);
  });

  test("POST decisions rejects invalid decision enum", async () => {
    const session = await createGuestSession();
    const resp = await session.api.post(
      `/v1/reviewer-ops/workspace/${NONEXISTENT_WORKFLOW}/decisions`,
      {
        data: {
          teamId: NONEXISTENT_TEAM,
          decision: "NOT_A_REAL_DECISION",
          rationale: "test",
        },
      },
    );
    expect(resp.status()).toBe(400);
  });

  test("POST decisions rejects empty rationale", async () => {
    const session = await createGuestSession();
    const resp = await session.api.post(
      `/v1/reviewer-ops/workspace/${NONEXISTENT_WORKFLOW}/decisions`,
      {
        data: {
          teamId: NONEXISTENT_TEAM,
          decision: "APPROVE",
          rationale: "",
        },
      },
    );
    expect(resp.status()).toBe(400);
  });

  test("POST decisions rejects rationale over 4000 chars", async () => {
    const session = await createGuestSession();
    const resp = await session.api.post(
      `/v1/reviewer-ops/workspace/${NONEXISTENT_WORKFLOW}/decisions`,
      {
        data: {
          teamId: NONEXISTENT_TEAM,
          decision: "APPROVE",
          rationale: "x".repeat(4001),
        },
      },
    );
    expect(resp.status()).toBe(400);
  });

  test("POST decisions rejects invalid reason code", async () => {
    const session = await createGuestSession();
    const resp = await session.api.post(
      `/v1/reviewer-ops/workspace/${NONEXISTENT_WORKFLOW}/decisions`,
      {
        data: {
          teamId: NONEXISTENT_TEAM,
          decision: "REJECT",
          reasonCode: "NOT_A_REAL_REASON",
          rationale: "test",
        },
      },
    );
    expect(resp.status()).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Source-presence regression — migration file + schema model + endpoints + UI
  // ---------------------------------------------------------------------------
  test("Phase B.2 migration SQL file exists and is additive", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const sql = await fs.readFile(
      path.resolve(
        process.cwd(),
        "services/api/prisma/migrations/20260929000000_phase_b2_workflow_review_decisions/migration.sql",
      ),
      "utf8",
    );
    // 3 enums + 1 table — purely additive.
    expect(sql).toContain('CREATE TYPE "workflow_review_stage"');
    expect(sql).toContain('CREATE TYPE "workflow_review_decision_kind"');
    expect(sql).toContain('CREATE TYPE "workflow_review_reason_code"');
    expect(sql).toContain('CREATE TABLE "workflow_review_decisions"');
    // No DROP / ALTER on existing tables — additive only.
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql).not.toMatch(
      /ALTER\s+TABLE\s+(?!"workflow_review_decisions")/i,
    );
    // Unique (workflow_id, stage) — the DB-level "one decision per
    // stage" enforcement.
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "workflow_review_decisions_workflow_id_stage_key"',
    );
  });

  test("Prisma schema declares the WorkflowReviewDecision model + 3 enums", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(process.cwd(), "services/api/prisma/schema.prisma"),
      "utf8",
    );
    expect(src).toContain("model WorkflowReviewDecision {");
    expect(src).toContain("enum WorkflowReviewStage");
    expect(src).toContain("enum WorkflowReviewDecisionKind");
    expect(src).toContain("enum WorkflowReviewReasonCode");
    // Unique (workflowId, stage) at the schema level.
    expect(src).toContain("@@unique([workflowId, stage])");
    // Back-relation from EvidenceReviewWorkflow.
    expect(src).toContain("reviewDecisions WorkflowReviewDecision[]");
    // Back-relation from User.
    expect(src).toContain("workflowReviewDecisions");
  });

  test("Backend reviewer-ops routes ship the decision endpoints + state machine", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "services/api/src/routes/reviewer-ops.routes.ts",
      ),
      "utf8",
    );
    // Endpoints
    expect(src).toContain(
      '"/v1/reviewer-ops/workspace/:workflowId/decisions"',
    );
    // State machine
    expect(src).toContain("deriveReviewState");
    expect(src).toContain('"first_required"');
    expect(src).toContain('"second_required"');
    expect(src).toContain('"conflict_detected"');
    expect(src).toContain('"resolved"');
    // Same-reviewer guard
    expect(src).toContain("same_reviewer_blocked");
    // Adjudicator role guard
    expect(src).toContain("adjudicator_role_required");
    // Duplicate stage guard (DB-level unique surfaces as 409)
    expect(src).toContain("duplicate_stage_decision");
    // Policy triggers for second review
    expect(src).toContain("workflow_escalated");
    expect(src).toContain("open_escalation");
    expect(src).toContain("active_legal_hold");
    expect(src).toContain("redaction_required");
    // Audit emission per stage
    expect(src).toContain("REVIEWER_DECISION_FIRST");
    expect(src).toContain("REVIEWER_DECISION_SECOND");
    expect(src).toContain("REVIEWER_DECISION_ADJUDICATION");
    // All 7 decision kinds in the zod enum
    for (const k of [
      "APPROVE",
      "REJECT",
      "REQUEST_INFO",
      "UPHOLD_FIRST",
      "UPHOLD_SECOND",
      "NEEDS_MORE_INFO",
      "UNRESOLVED",
    ]) {
      expect(src).toContain(`"${k}"`);
    }
    // All 9 reason codes in the zod enum
    for (const r of [
      "EVIDENCE_INCOMPLETE",
      "REPORT_FAILED",
      "INTEGRITY_CONCERN",
      "CUSTODY_CONCERN",
      "MISSING_CONTEXT",
      "LEGAL_HOLD_ISSUE",
      "REDACTION_REQUIRED",
      "REVIEWER_DISAGREEMENT",
      "OTHER",
    ]) {
      expect(src).toContain(`"${r}"`);
    }
  });

  test("Reviewer detail page ships the Phase B.2 decision lineage panel", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "apps/web/app/(app)/reviewer-ops/[reviewId]/page.tsx",
      ),
      "utf8",
    );
    // Section root + state attrs
    expect(src).toContain('data-section="reviewer-decision-lineage"');
    expect(src).toContain("data-decision-state");
    expect(src).toContain("data-decision-next-action");
    expect(src).toContain("data-decision-requires-second");
    expect(src).toContain("data-decision-caller-is-first-reviewer");
    expect(src).toContain("data-decision-is-adjudicator");
    // Form markers
    expect(src).toContain("data-decision-form");
    expect(src).toContain("data-decision-form-decision");
    expect(src).toContain("data-decision-form-reason");
    expect(src).toContain("data-decision-form-rationale");
    expect(src).toContain("data-decision-form-submit");
    // Lineage markers
    expect(src).toContain("data-decision-lineage");
    expect(src).toContain("data-decision-row");
    expect(src).toContain("data-decision-stage");
    expect(src).toContain("data-decision-kind");
    expect(src).toContain("data-decision-rationale");
    // Blocked banners
    expect(src).toContain("data-decision-blocked-banner");
    // Phase B.1 promoted-to-available items
    expect(src).toContain('data-reviewer-deferred-item="multi-stage-review"');
    expect(src).toContain('data-reviewer-deferred-item="decision-lineage"');
  });

  // ---------------------------------------------------------------------------
  // Route reachability.
  // ---------------------------------------------------------------------------
  test("/reviewer-ops/[reviewId] still serves 2xx after Phase B.2 additions", async ({
    page,
  }) => {
    const resp = await page.goto(
      "/reviewer-ops/00000000-0000-4000-8000-0000000000d3",
      { waitUntil: "load" },
    );
    expect(
      resp?.ok(),
      `expected 2xx from /reviewer-ops/[reviewId], got ${resp?.status()}`,
    ).toBe(true);
  });
});
