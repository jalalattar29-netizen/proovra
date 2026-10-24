/**
 * THE BULK ITEM ERROR CONTRACT, against a real PostgreSQL and the real route
 * (2026-10-24).
 *
 * What a failed bulk row says, and — the sentinels — what it can NEVER say:
 * raw exception text, Prisma messages, stack fragments, database or table
 * names, internal reasons. A row carries a stable code from
 * REVIEWER_OPS_BULK_ITEM_ERROR_CODES, the FIXED message beside it, an optional
 * safe nextAction, and the response carries the requestId; everything else
 * stays in the server log / Sentry, correlated by that id.
 *
 * Each case is also the mutation proof for one regression:
 *   - whitespace-only Escalate note → REVIEW_NOTE_REQUIRED, never a
 *     transition error (kills "treat whitespace note as transition error");
 *   - missing and FOREIGN ids → the one non-enumerating
 *     REVIEW_WORKFLOW_NOT_FOUND (kills "reveal foreign-record existence" and
 *     the findFirstOrThrow leak);
 *   - invalid stage → REVIEW_INVALID_TRANSITION; lost race → REVIEW_CONFLICT;
 *   - an unexpected error → REVIEW_ITEM_FAILED with the fixed message (kills
 *     "return raw internal error text").
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { REVIEWER_OPS_BULK_ITEM_ERRORS } from "@proovra/shared";

import { bootIntegrationHarness, type IntegrationHarness, type TeamFixture } from "./integration-harness.js";

let harness: IntegrationHarness;
let A: TeamFixture;
let B: TeamFixture;
let prisma: typeof import("../src/db.js").prisma;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route bodies are asserted field by field
type Res = { status: number; body: any; raw: string };

async function bulk(team: TeamFixture, payload: Record<string, unknown>, token?: string): Promise<Res> {
  const res = await harness.app.inject({
    method: "POST",
    url: "/v1/reviewer-ops/reviews/bulk",
    headers: { authorization: `Bearer ${token ?? team.adminToken}`, "content-type": "application/json" },
    payload: JSON.stringify({ teamId: team.teamId, ...payload }),
  });
  return { status: res.statusCode, body: JSON.parse(res.body), raw: res.body };
}

const LEAK = /prisma|findFirst|OrThrow|\bat [A-Za-z_$][\w$]*\s*\(|node_modules|postgres|evidence_review_workflows|invocation|ECONN|\.ts:\d+/i;

async function freshWorkflow(team: TeamFixture, title: string, status = "NOT_STARTED"): Promise<string> {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: team.teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: { title, type: "PHOTO", status: "CREATED", teamId: team.teamId, organizationId: t.organizationId, ownerUserId: team.ownerUserId },
      select: { id: true },
    })
  ).id;
  return (
    await prisma.evidenceReviewWorkflow.create({
      data: { evidenceId, teamId: team.teamId, status: status as never, workspaceType: "TEAM" },
      select: { id: true },
    })
  ).id;
}

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  A = harness.fixtures.teamA;
  B = harness.fixtures.teamB;
  ({ prisma } = await import("../src/db.js"));
  await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  await prisma.team.update({ where: { id: B.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
});

afterAll(async () => {
  if (harness) {
    await prisma.team.update({ where: { id: B.teamId }, data: { billingPlan: "FREE", billingStatus: "INACTIVE" } }).catch(() => null);
    await harness.cleanup();
  }
});

describe("bulk error contract — typed codes, fixed messages, nothing internal", () => {
  it("a whitespace-only Escalate note is REVIEW_NOTE_REQUIRED at the route edge, never a transition error", async () => {
    const w = await freshWorkflow(A, "bulk-ws-note");
    const res = await bulk(A, { workflowIds: [w], action: "ESCALATE", note: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: "REVIEW_NOTE_REQUIRED",
      message: REVIEWER_OPS_BULK_ITEM_ERRORS.REVIEW_NOTE_REQUIRED.message,
    });
    expect(res.body.error.requestId).toBeTruthy();
    expect(res.raw).not.toMatch(LEAK);
    expect(await prisma.reviewEscalation.count({ where: { workflowId: w } })).toBe(0);
  });

  it("CLOSE on a missing id and on ANOTHER workspace's id both report REVIEW_WORKFLOW_NOT_FOUND — existence is not revealed", async () => {
    const foreign = await freshWorkflow(B, "bulk-foreign-close");
    const missing = randomUUID();
    const res = await bulk(A, { workflowIds: [missing, foreign], action: "CLOSE", note: "closing" });
    expect(res.status).toBe(207);
    const items = res.body.items as Array<{ workflowId: string; errorCode: string; message: string; ok: boolean }>;
    const byId = Object.fromEntries(items.map((i) => [i.workflowId, i]));
    // The two failures are INDISTINGUISHABLE: same code, same fixed message.
    for (const id of [missing, foreign]) {
      expect(byId[id]).toMatchObject({
        ok: false,
        errorCode: "REVIEW_WORKFLOW_NOT_FOUND",
        message: REVIEWER_OPS_BULK_ITEM_ERRORS.REVIEW_WORKFLOW_NOT_FOUND.message,
      });
    }
    expect(res.body.requestId).toBeTruthy();
    expect(res.raw).not.toMatch(LEAK);
    // The foreign workspace's review is untouched.
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: foreign } })).status).toBe("NOT_STARTED");
  });

  it("an action the stage does not allow is REVIEW_INVALID_TRANSITION with the fixed message", async () => {
    const w = await freshWorkflow(A, "bulk-invalid-stage", "CLOSED");
    const res = await bulk(A, { workflowIds: [w], action: "CLOSE", note: "again" });
    expect(res.status).toBe(207);
    expect(res.body.items[0]).toMatchObject({
      ok: false,
      errorCode: "REVIEW_INVALID_TRANSITION",
      message: REVIEWER_OPS_BULK_ITEM_ERRORS.REVIEW_INVALID_TRANSITION.message,
      nextAction: "REFRESH_AND_RETRY",
    });
    expect(res.raw).not.toMatch(LEAK);
  });

  it("an entitlement denial on the bulk route is the typed ENTITLEMENT_REQUIRED, and a MEMBER's role refusal is typed too", async () => {
    const w = await freshWorkflow(A, "bulk-denials");
    const member = await bulk(A, { workflowIds: [w], action: "PRIORITY_HIGH" }, A.memberToken);
    expect(member.status).toBe(403);
    expect(member.body.error).toMatchObject({ code: "REVIEW_PERMISSION_DENIED", reason: "review_bulk_required" });
    expect(member.raw).not.toMatch(LEAK);

    await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "FREE", billingStatus: "INACTIVE" } });
    const refused = await bulk(A, { workflowIds: [w], action: "PRIORITY_HIGH" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "ENTITLEMENT_REQUIRED", entitlement: "BULK_REVIEW_OPERATIONS" });
    expect(refused.raw).not.toMatch(LEAK);
    await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: w } })).priority).toBe("NORMAL");
  });
});

describe("unexpected errors — reported, never described", () => {
  it("a thrown internal error becomes REVIEW_ITEM_FAILED with the fixed message; the raw text reaches only the observer", async () => {
    const { executeBulkTriage } = await import("../src/services/reviewer-ops/bulk-triage.service.js");
    const w = await freshWorkflow(A, "bulk-unexpected");
    const SECRET = "P1017: server at db.internal:5432 closed the connection";
    // A client whose first read explodes with infrastructure detail.
    const explosive = new Proxy(prisma, {
      get(target, prop) {
        if (prop === "evidenceReviewWorkflow") {
          return new Proxy((target as never)[prop], {
            get(t2, p2) {
              if (p2 === "findFirst") return () => Promise.reject(new Error(SECRET));
              return (t2 as never)[p2];
            },
          });
        }
        return (target as never)[prop];
      },
    });
    const reported: Array<{ workflowId: string; err: unknown }> = [];
    const result = await executeBulkTriage(
      { teamId: A.teamId, actorUserId: A.adminUserId, isReviewerCapable: true, isServiceAccount: false } as never,
      { teamId: A.teamId, workflowIds: [w], action: "PRIORITY_HIGH" } as never,
      explosive as never,
      { requestId: "req-sentinel-1", reportUnexpected: (x) => reported.push(x) },
    );
    expect(result.items[0]).toMatchObject({
      ok: false,
      errorCode: "REVIEW_ITEM_FAILED",
      message: REVIEWER_OPS_BULK_ITEM_ERRORS.REVIEW_ITEM_FAILED.message,
      nextAction: "CONTACT_SUPPORT",
    });
    expect(result.requestId).toBe("req-sentinel-1");
    // The raw text is nowhere in the result — and exactly once at the observer.
    expect(JSON.stringify(result)).not.toContain("P1017");
    expect(JSON.stringify(result)).not.toContain("db.internal");
    expect(reported).toHaveLength(1);
    expect((reported[0].err as Error).message).toBe(SECRET);
  });

  it("classifyBulkItemError maps every typed refusal to its contract code and marks only the unknown as unexpected", async () => {
    const { classifyBulkItemError } = await import("../src/services/reviewer-ops/bulk-triage.service.js");
    const { ReviewerOpsError } = await import("../src/services/reviewer-ops/reviewer-operations-engine.service.js");
    const { ReviewOperationError } = await import("../src/services/review-operations/review-operations.service.js");
    const cases: Array<[unknown, string, boolean]> = [
      [new ReviewerOpsError("REVIEW_NOTE_REQUIRED"), "REVIEW_NOTE_REQUIRED", false],
      [new ReviewerOpsError("REVIEW_WORKFLOW_NOT_FOUND"), "REVIEW_WORKFLOW_NOT_FOUND", false],
      [new ReviewerOpsError("REVIEW_PERMISSION_DENIED"), "REVIEW_PERMISSION_DENIED", false],
      [new ReviewerOpsError("REVIEW_INVALID_TRANSITION", { from: "A", to: "B" }), "REVIEW_INVALID_TRANSITION", false],
      // A lost race is a CONFLICT, not a stage error.
      [new ReviewerOpsError("REVIEW_INVALID_TRANSITION", { reason: "concurrent_change" }), "REVIEW_CONFLICT", false],
      [new ReviewOperationError("workflow_not_found"), "REVIEW_WORKFLOW_NOT_FOUND", false],
      [new ReviewOperationError("note_required"), "REVIEW_NOTE_REQUIRED", false],
      [new ReviewOperationError("already_assigned_elsewhere"), "REVIEW_CONFLICT", false],
      [new ReviewOperationError("invalid_stage_transition", { reason: "concurrent_change" }), "REVIEW_CONFLICT", false],
      [new ReviewOperationError("invalid_stage_transition", { from: "X" }), "REVIEW_INVALID_TRANSITION", false],
      [new ReviewOperationError("already_in_stage"), "REVIEW_INVALID_TRANSITION", false],
      [new Error("anything else"), "REVIEW_ITEM_FAILED", true],
      ["a string", "REVIEW_ITEM_FAILED", true],
    ];
    for (const [err, code, unexpected] of cases) {
      expect(classifyBulkItemError(err), String(code)).toEqual({ code, unexpected });
    }
  });
});
