/**
 * Phase 13 — Review operations API-side tests.
 *
 *   - Service-layer assertions: projection privacy, error-code mapping
 *   - Governance gate now requires APPROVED_INTERNAL (source-level
 *     assertion since `evidenceIsReviewed` uses Prisma)
 *   - Route file uses 404-not-403 for non-reviewer members
 *     (anti-enumeration consistent with Phases 11–12)
 *   - Decision route is wrapped through the canonical service
 *
 * Pure source-text + projection tests; no DB required.
 */

import { describe, expect, it } from "vitest";

import {
  ReviewOperationError,
  projectReviewWorkflow,
} from "../src/services/review-operations/review-operations.service.js";

const NOW = new Date("2026-05-21T10:00:00Z");

function mockWorkflowRow(
  patch: Partial<Parameters<typeof projectReviewWorkflow>[0]> = {},
): Parameters<typeof projectReviewWorkflow>[0] {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    evidenceId: "22222222-2222-4222-8222-222222222222",
    teamId: "33333333-3333-4333-8333-333333333333",
    workspaceType: "TEAM",
    assignedToUserId: null,
    assignedByUserId: null,
    status: "QUEUED" as never,
    priority: "NORMAL" as never,
    dueAt: null,
    lastReviewedAt: null,
    closedAt: null,
    assignedAtUtc: null,
    reassignedAtUtc: null,
    firstResponseDueAtUtc: null,
    escalationDueAtUtc: null,
    completedAtUtc: null,
    slaStatus: null,
    slaPausedAtUtc: null,
    escalationLevel: 0,
    escalatedAtUtc: null,
    escalatedByUserId: null,
    escalationReason: null,
    rejectionReason: null,
    reopenCount: 0,
    reopenedAtUtc: null,
    reopenedByUserId: null,
    // Phase 25 — additive nullable columns on EvidenceReviewWorkflow.
    assignmentDueAtUtc: null,
    completionDueAtUtc: null,
    pausedReason: null,
    activeEscalationId: null,
    // Phase 2A reviewer-workspace — coding schema bind. The contract requires
    // `string | null` (not `undefined`), so the fixture must explicitly set
    // both to `null` when no schema is bound. Tests that exercise coding
    // schema binding override via the `patch` arg.
    codingSchemaId: null,
    codingSchemaVersion: null,
    // Phase T — additive nullable template-identity trio. Same `string | null`
    // (not `undefined`) contract as Phase 2A above. Legacy fixtures stay NULL.
    templateSlug: null,
    templateVersion: null,
    templateDbId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

describe("review workflow projection — privacy + correctness", () => {
  it("does NOT expose billingShape or raw status", () => {
    const projected = projectReviewWorkflow(mockWorkflowRow());
    expect((projected as Record<string, unknown>).workspaceType).toBeUndefined();
    expect((projected as Record<string, unknown>).status).toBeUndefined();
    expect(projected.stage).toBe("QUEUED");
  });

  it("maps legacy DB status NOT_STARTED → QUEUED", () => {
    const projected = projectReviewWorkflow(
      mockWorkflowRow({ status: "NOT_STARTED" as never }),
    );
    expect(projected.stage).toBe("QUEUED");
  });

  it("approvedForGovernanceGate=true only for APPROVED_INTERNAL", () => {
    const inReview = projectReviewWorkflow(
      mockWorkflowRow({ status: "IN_REVIEW" as never }),
    );
    expect(inReview.approvedForGovernanceGate).toBe(false);

    const approved = projectReviewWorkflow(
      mockWorkflowRow({ status: "APPROVED_INTERNAL" as never }),
    );
    expect(approved.approvedForGovernanceGate).toBe(true);

    const readyExternal = projectReviewWorkflow(
      mockWorkflowRow({ status: "READY_FOR_EXTERNAL_REVIEW" as never }),
    );
    // mapDbStatusToReviewStage returns APPROVED_INTERNAL for the legacy
    // value, so the gate predicate evaluates true.
    expect(readyExternal.approvedForGovernanceGate).toBe(true);
  });

  it("propagates SLA + escalation metadata", () => {
    const projected = projectReviewWorkflow(
      mockWorkflowRow({
        slaStatus: "OVERDUE" as never,
        escalationLevel: 2,
        escalationReason: "stalled past SLA",
        reopenCount: 1,
      }),
    );
    expect(projected.slaStatus).toBe("OVERDUE");
    expect(projected.escalationLevel).toBe(2);
    expect(projected.escalationReason).toBe("stalled past SLA");
    expect(projected.reopenCount).toBe(1);
  });
});

describe("ReviewOperationError — code surface", () => {
  it("has stable codes used by the route mapper", () => {
    const codes = [
      "workflow_not_found",
      "invalid_stage_transition",
      "note_required",
      "permission_denied",
      "already_assigned_elsewhere",
      "evidence_not_in_workspace",
    ] as const;
    for (const code of codes) {
      const err = new ReviewOperationError(code);
      expect(err.code).toBe(code);
      expect(err.message).toBe(code);
    }
  });
});

describe("governance gate — source-level tightening", () => {
  it("evidenceIsReviewed only accepts APPROVED_INTERNAL / READY_FOR_EXTERNAL_REVIEW", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/services/governance.service.ts", import.meta.url),
      ),
      "utf8",
    );
    // Phase 13.5 — `evidenceIsReviewed` now delegates to the pure
    // helper `reviewStatusSatisfiesGovernanceGate`. The helper must
    // accept APPROVED_INTERNAL + READY_FOR_EXTERNAL_REVIEW and reject
    // everything else (including IN_REVIEW).
    expect(src).toMatch(/reviewStatusSatisfiesGovernanceGate/);
    const helper = src.match(
      /export function reviewStatusSatisfiesGovernanceGate[\s\S]*?return\s*\(/,
    );
    expect(helper).not.toBeNull();
    if (helper) {
      const body = src.slice(helper.index ?? 0);
      const end = body.indexOf("\n}");
      const fullHelper = end > 0 ? body.slice(0, end) : body;
      expect(fullHelper).not.toMatch(
        /EvidenceReviewWorkflowStatus\.IN_REVIEW/,
      );
      expect(fullHelper).toMatch(
        /EvidenceReviewWorkflowStatus\.APPROVED_INTERNAL/,
      );
      expect(fullHelper).toMatch(
        /EvidenceReviewWorkflowStatus\.READY_FOR_EXTERNAL_REVIEW/,
      );
    }
  });
});

describe("anti-enumeration — review-operations routes", () => {
  it("never responds 403 (404 on non-reviewer members)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/review-operations.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).not.toMatch(/reply\.code\(403\)/);
    expect(src).toMatch(/reply\.code\(404\)/);
  });

  it("decision route invokes the canonical service (single transition path)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/review-operations.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(/recordReviewDecision\(/);
    expect(src).toMatch(/claimReviewerWorkflow\(/);
    expect(src).toMatch(/bulkReviewAction\(/);
    // Rebaselined 2026-08-17 — PHASE 13 §3. `POST /v1/review-operations/evidence/
    // :evidenceId/assign` and `…/sla` were removed: no caller existed on any
    // surface (web, mobile, worker, cron, CLI, runbook, SDK, webhook, import
    // graph, or the /v1/workspaces alias) and no test referenced them. The
    // service functions survive — `assignReviewer` and `updateReviewSla` are
    // still the canonical writers, now reached only through
    // workflow-instances.routes.ts — so this file must NOT import them again.
    expect(src).not.toMatch(/assignReviewer\(/);
    expect(src).not.toMatch(/updateReviewSla\(/);
  });
});

describe("bulk action — source-level safety contract", () => {
  it("ESCALATE and REQUEST_MORE_INFO require a note", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/review-operations/review-operations.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/SENSITIVE_BULK_ACTIONS/);
    // Verify the set contains both sensitive actions.
    expect(src).toMatch(/"ESCALATE"/);
    expect(src).toMatch(/"REQUEST_MORE_INFO"/);
    // And that the guard raises note_required.
    expect(src).toMatch(/note_required/);
  });

  it("bulk per-item failures are reported, not silently dropped", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/review-operations/review-operations.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/items\.push\(\{[^}]*ok:\s*false/);
    expect(src).toMatch(/total:\s*uniqueIds\.length/);
  });
});

describe("notification templates — Phase 13 review events covered", () => {
  it("renderTransactionalTemplate has cases for the new event types", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/services/notifications/templates.ts", import.meta.url),
      ),
      "utf8",
    );
    for (const t of [
      "REVIEW_REASSIGNED",
      "REVIEW_ESCALATED",
      "REVIEW_OVERDUE_REMINDER",
      "REVIEW_NEEDS_MORE_INFO",
      "REVIEW_RESPONSE_RECEIVED",
    ]) {
      expect(src).toMatch(new RegExp(`case\\s+"${t}"`));
    }
  });
});
