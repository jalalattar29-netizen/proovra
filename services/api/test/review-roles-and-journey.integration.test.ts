/**
 * Evidence Review — role × plan matrix and ONE end-to-end journey, against a
 * real PostgreSQL and the real routes (2026-10-23).
 *
 * MATRIX. For every caller the Evidence page can have — Owner, Admin, a
 * permitted reviewer (Member), Viewer, a user outside the workspace, another
 * workspace's admin, a Personal-space user — and every plan shape — FREE (no
 * review entitlement), TEAM, ENTERPRISE — it asserts BOTH what the server
 * does when the action is attempted AND what the review workspace offers, so
 * the page can never offer what the server refuses or hide what it allows.
 *
 * JOURNEY. One record, one sequence, every repaired rule interacting: claim
 * (and its idempotent repeat), a version-checked start, a stale edit refused,
 * a verdict, a second verdict refused, the legacy approval refused, Reopen
 * into round 1, an escalation routed to the admins, a second-review verdict
 * by a different reviewer resolving both the round and the escalation,
 * Reopen into round 2, a second escalation closed by Close — and finally the
 * full decision log, the events and the escalation records, checked as a
 * whole.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness, type TeamFixture } from "./integration-harness.js";

let harness: IntegrationHarness;
let A: TeamFixture;
let B: TeamFixture;
let prisma: typeof import("../src/db.js").prisma;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route bodies are asserted field by field
type Res = { status: number; body: any };

async function call(token: string, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown): Promise<Res> {
  const res = await harness.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
    payload: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  let body: unknown = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body };
}

async function freshEvidence(team: TeamFixture, title: string): Promise<string> {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: team.teamId }, select: { organizationId: true } });
  return (
    await prisma.evidence.create({
      data: { title, type: "PHOTO", status: "CREATED", teamId: team.teamId, organizationId: t.organizationId, ownerUserId: team.ownerUserId },
      select: { id: true },
    })
  ).id;
}

const setPlan = (team: TeamFixture, plan: "FREE" | "TEAM" | "ENTERPRISE") =>
  prisma.team.update({
    where: { id: team.teamId },
    data: { billingPlan: plan, billingStatus: plan === "FREE" ? "INACTIVE" : "ACTIVE" },
  });
const patchWorkflow = (token: string, ev: string, body: Record<string, unknown>) =>
  call(token, "PATCH", `/v1/evidence/${ev}/reviewer-workflow`, body);
const claim = (token: string, ev: string, teamId: string) =>
  call(token, "POST", `/v1/review-operations/evidence/${ev}/claim`, { teamId });
const decide = (token: string, ev: string, decision: string, note?: string) =>
  call(token, "POST", `/v1/review-operations/evidence/${ev}/decision`, {
    decision,
    note: note ?? null,
    ...(decision === "ESCALATE" ? { escalationReason: note } : {}),
  });
const workflowOf = (ev: string) => prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { evidenceId: ev } });
async function offered(token: string, ev: string) {
  const res = await call(token, "GET", `/v1/evidence/${ev}/review-workspace`);
  if (res.status !== 200) return { status: res.status, actions: null, attention: null };
  const actions = Object.fromEntries(
    (res.body.reviewWorkflow.availableActions as Array<{ action: string; enabled: boolean; blockedBy: string | null }>).map((a) => [a.action, a]),
  );
  return { status: 200, actions, attention: res.body.attention as { items: Array<{ code: string }> } };
}

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  A = harness.fixtures.teamA;
  B = harness.fixtures.teamB;
  ({ prisma } = await import("../src/db.js"));
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

// ===========================================================================
// The matrix
// ===========================================================================

describe("role × plan matrix — what the server does equals what the page is offered", () => {
  for (const plan of ["TEAM", "ENTERPRISE"] as const) {
    it(`${plan}: Owner, Admin and a permitted reviewer may claim; the page offers Claim and Start review`, async () => {
      await setPlan(A, plan);
      for (const [label, token, userId] of [
        ["owner", A.ownerToken, A.ownerUserId],
        ["admin", A.adminToken, A.adminUserId],
        ["reviewer (member)", A.memberToken, A.memberUserId],
      ] as const) {
        const ev = await freshEvidence(A, `${plan}-${label}`);
        expect((await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" })).status).toBe(200);
        const o = await offered(token, ev);
        expect(o.actions!.CLAIM.enabled, label).toBe(true);
        expect(o.attention!.items.map((i) => i.code), label).toContain("REVIEW_NOT_STARTED");
        const res = await claim(token, ev, A.teamId);
        expect(res.status, label).toBe(200);
        expect((await workflowOf(ev)).assignedToUserId, label).toBe(userId);
      }
    });

    it(`${plan}: a Viewer is refused (403) and offered nothing — one non-permission sentence`, async () => {
      await setPlan(A, plan);
      const ev = await freshEvidence(A, `${plan}-viewer`);
      await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
      const o = await offered(A.viewerToken, ev);
      expect(Object.values(o.actions!).every((a) => !a.enabled)).toBe(true);
      expect(o.actions!.CLAIM.blockedBy).toBe("NOT_PERMITTED");
      expect(o.attention!.items.map((i) => i.code)).not.toContain("REVIEW_NOT_STARTED");
      expect((await claim(A.viewerToken, ev, A.teamId)).status).toBe(403);
      expect((await decide(A.viewerToken, ev, "ESCALATE", "x")).status).toBe(403);
      expect((await workflowOf(ev)).assignedToUserId).toBeNull();
    });
  }

  it("FREE (review not included): every role is refused by the server AND offered nothing by the page", async () => {
    for (const [label, token] of [
      ["owner", A.ownerToken],
      ["admin", A.adminToken],
      ["reviewer (member)", A.memberToken],
    ] as const) {
      // A workflow created while the plan included review, then the plan lapsed.
      await setPlan(A, "TEAM");
      const ev = await freshEvidence(A, `free-${label}`);
      await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
      await setPlan(A, "FREE");
      // The editor PATCH and the bulk route are refused too (audit F6).
      const edit = await patchWorkflow(token, ev, { priority: "HIGH" });
      expect(edit.status, label).toBe(403);
      expect(edit.body.error.code, label).toBe("reviewer_operations_not_included");
      const bulk = await call(token, "POST", "/v1/review-operations/bulk", {
        teamId: A.teamId,
        evidenceIds: [ev],
        action: "ESCALATE",
        note: "bulk while not included",
      });
      expect(bulk.status, label).toBe(404);
      expect(bulk.body.error.code, label).toBe("reviewer_operations_not_included");
      expect(await prisma.reviewEscalation.count({ where: { evidenceId: ev } }), label).toBe(0);
      const o = await offered(token, ev);
      expect(Object.values(o.actions!).every((a) => !a.enabled), label).toBe(true);
      expect(o.actions!.CLAIM.blockedBy, label).toBe("NOT_INCLUDED");
      expect(o.attention!.items.map((i) => i.code), label).not.toContain("REVIEW_NOT_STARTED");
      const res = await claim(token, ev, A.teamId);
      // 404 (the route file's anti-enumeration posture), with its own code.
      expect(res.status, label).toBe(404);
      expect(res.body.error.code, label).toBe("reviewer_operations_not_included");
      expect((await decide(token, ev, "ESCALATE", "x")).body.error.code, label).toBe("reviewer_operations_not_included");
      const wf = await workflowOf(ev);
      expect(wf.assignedToUserId, label).toBeNull();
      expect(wf.status, label).toBe("NOT_STARTED");
    }
  });

  it("outsiders learn nothing: a user of another workspace, its admin, and a Personal-space user get 404", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "outsiders");
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    for (const [label, token] of [
      ["member outside the workspace", B.memberToken],
      ["another workspace's admin", B.adminToken],
      ["personal-space user", harness.fixtures.personal.token],
    ] as const) {
      expect((await call(token, "GET", `/v1/evidence/${ev}/review-workspace`)).status, label).toBe(404);
      expect((await claim(token, ev, A.teamId)).status, label).toBe(404);
      expect((await decide(token, ev, "ESCALATE", "x")).status, label).toBe(404);
    }
    expect((await workflowOf(ev)).assignedToUserId).toBeNull();
    expect(await prisma.reviewEscalation.count({ where: { evidenceId: ev } })).toBe(0);
  });

  it("a Personal-space record has no review workflow to offer or act on", async () => {
    const P = harness.fixtures.personal;
    const o = await offered(P.token, P.evidenceId);
    expect(o.status).toBe(200);
    expect(Object.values(o.actions!).every((a) => !a.enabled)).toBe(true);
    expect(o.attention!.items.map((i) => i.code)).not.toContain("REVIEW_NOT_STARTED");
  });
});

// ===========================================================================
// The journey
// ===========================================================================

describe("one journey: rounds, concurrency, escalation routing, Close and the legacy approval, together", () => {
  it("runs end to end and leaves a coherent record", async () => {
    await setPlan(A, "ENTERPRISE");
    const ev = await freshEvidence(A, "journey");
    expect((await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" })).status).toBe(200);

    // Claim, and its idempotent repeat.
    expect((await claim(A.memberToken, ev, A.teamId)).status).toBe(200);
    expect((await claim(A.memberToken, ev, A.teamId)).status).toBe(200);

    // Version-checked start; the same version again is stale.
    const v0 = (await workflowOf(ev)).updatedAt.toISOString();
    expect((await patchWorkflow(A.memberToken, ev, { status: "IN_REVIEW", expectedUpdatedAt: v0 })).status).toBe(200);
    expect((await patchWorkflow(A.adminToken, ev, { priority: "HIGH", expectedUpdatedAt: v0 })).status).toBe(409);

    // Round 0: approve; a different verdict is refused; the legacy approval is refused.
    expect((await decide(A.memberToken, ev, "APPROVE_INTERNAL")).status).toBe(200);
    expect((await workflowOf(ev)).status).toBe("APPROVED_INTERNAL");
    expect((await decide(A.memberToken, ev, "REJECT_INSUFFICIENT", "no")).status).toBe(409);
    expect((await patchWorkflow(A.adminToken, ev, { status: "READY_FOR_EXTERNAL_REVIEW" })).status).toBe(400);

    // Reopen → round 1; resume; escalate → an escalation for the admins.
    expect((await decide(A.memberToken, ev, "REOPEN", "new material")).status).toBe(200);
    let wf = await workflowOf(ev);
    expect(wf.decisionRound).toBe(1);
    expect((await patchWorkflow(A.memberToken, ev, { status: "IN_REVIEW", expectedUpdatedAt: wf.updatedAt.toISOString() })).status).toBe(200);
    expect((await decide(A.memberToken, ev, "ESCALATE", "needs a second opinion")).status).toBe(200);
    wf = await workflowOf(ev);
    expect(wf.status).toBe("ESCALATED");
    const esc1 = await prisma.reviewEscalation.findFirstOrThrow({ where: { workflowId: wf.id, status: "OPEN" } });
    expect(esc1.assignedToUserId).toBeNull();
    const adminInbox = await call(A.adminToken, "GET", "/v1/me/inbox");
    const item1 = (adminInbox.body.items as Array<{ id: string; title: string }>).find((i) => i.id === `review_escalation:${esc1.id}`);
    expect(item1?.title).toMatch(/^Review escalated to your workspace's admins/);

    // An escalated review takes a second, independent verdict: the reviewer
    // rejects (FIRST, round 1) and the review waits; the admin rejects
    // (SECOND) and the round resolves — which resolves the escalation.
    expect((await decide(A.memberToken, ev, "REJECT_INSUFFICIENT", "insufficient")).status).toBe(200);
    expect((await workflowOf(ev)).status).toBe("ESCALATED");
    expect((await decide(A.memberToken, ev, "REJECT_INSUFFICIENT", "again")).status).toBe(200); // idempotent replay
    const second = await decide(A.adminToken, ev, "REJECT_INSUFFICIENT", "agreed, insufficient");
    expect(second.status).toBe(200);
    expect((await workflowOf(ev)).status).toBe("REJECTED_INSUFFICIENT");
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: esc1.id } })).status).toBe("RESOLVED");

    // Reopen → round 2; escalate again; Close resolves that escalation.
    expect((await decide(A.adminToken, ev, "REOPEN", "one more look")).status).toBe(200);
    expect((await workflowOf(ev)).decisionRound).toBe(2);
    wf = await workflowOf(ev);
    expect((await patchWorkflow(A.adminToken, ev, { status: "IN_REVIEW", expectedUpdatedAt: wf.updatedAt.toISOString() })).status).toBe(200);
    expect((await decide(A.adminToken, ev, "ESCALATE", "outside counsel")).status).toBe(200);
    const esc2 = await prisma.reviewEscalation.findFirstOrThrow({ where: { workflowId: wf.id, status: "OPEN" } });
    expect((await decide(A.adminToken, ev, "CLOSE")).status).toBe(200);
    expect((await workflowOf(ev)).status).toBe("CLOSED");
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: esc2.id } })).status).toBe("RESOLVED");

    // The record as a whole.
    const decisions = await prisma.workflowReviewDecision.findMany({ where: { workflowId: wf.id }, orderBy: { decidedAt: "asc" } });
    expect(decisions.map((d) => [d.round, d.stage, d.decision, d.reviewerUserId])).toEqual([
      [0, "FIRST", "APPROVE", A.memberUserId],
      [1, "FIRST", "REJECT", A.memberUserId],
      [1, "SECOND", "REJECT", A.adminUserId],
    ]);
    const events = (await prisma.evidenceReviewWorkflowEvent.findMany({ where: { evidenceId: ev }, orderBy: { createdAt: "asc" } })).map((e) => e.eventType);
    expect(events.filter((e) => e === "CREATED")).toHaveLength(1);
    expect(events.filter((e) => e === "CLAIMED")).toHaveLength(1);
    expect(events.filter((e) => e === "REOPENED")).toHaveLength(2);
    expect(events.filter((e) => e === "ESCALATED")).toHaveLength(2);
    expect(events.filter((e) => e === "CLOSED")).toHaveLength(1);
    expect(events.filter((e) => e === "DECISION_LOGGED")).toHaveLength(3);
    expect(await prisma.reviewEscalation.count({ where: { workflowId: wf.id } })).toBe(2);
    expect(await prisma.reviewEscalation.count({ where: { workflowId: wf.id, status: "OPEN" } })).toBe(0);
    // The stale edit and the refused verdicts left no trace.
    expect((await workflowOf(ev)).priority).toBe("NORMAL");
  });
});

// ===========================================================================
// Independent-audit findings (2026-10-23) — each reproduced, then held
// ===========================================================================

describe("audit findings — second review, reconcile, races, editor Close, Begin review, custody", () => {
  const holdOn = (ev: string) =>
    prisma.evidenceLegalHold.create({
      data: {
        scope: "EVIDENCE",
        evidenceId: ev,
        teamId: A.teamId,
        status: "ACTIVE",
        title: "Litigation hold",
        placedByUserId: A.ownerUserId,
      } as never,
    });
  const begin = async (token: string, ev: string) => {
    const wf = await workflowOf(ev);
    const res = await patchWorkflow(token, ev, { status: "IN_REVIEW", expectedUpdatedAt: wf.updatedAt.toISOString() });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };
  const claimed = async (ev: string) => {
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    expect((await claim(A.memberToken, ev, A.teamId)).status).toBe(200);
    await begin(A.memberToken, ev);
  };

  it("F1/F2 — under a legal hold a request for information is the FIRST of two reviews: the second reviewer is offered a verdict, the first waits, and a disagreement goes to adjudication in the SAME round", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "f1-second-review");
    await holdOn(ev);
    await claimed(ev);
    expect((await decide(A.memberToken, ev, "REQUEST_MORE_INFO", "need the original")).status).toBe(200);
    let wf = await workflowOf(ev);
    // The round is not finished: a second review is required.
    expect(wf.decisionRound).toBe(0);
    expect((await offered(A.memberToken, ev)).actions!.APPROVE_INTERNAL.blockedBy).toBe("AWAITING_SECOND_REVIEWER");
    expect((await offered(A.adminToken, ev)).actions!.APPROVE_INTERNAL.enabled).toBe(true);
    expect((await decide(A.adminToken, ev, "APPROVE_INTERNAL")).status).toBe(200);
    wf = await workflowOf(ev);
    const rows = await prisma.workflowReviewDecision.findMany({ where: { workflowId: wf.id }, orderBy: { decidedAt: "asc" } });
    expect(rows.map((r) => [r.round, r.stage, r.decision])).toEqual([
      [0, "FIRST", "REQUEST_INFO"],
      [0, "SECOND", "APPROVE"],
    ]);
    expect(wf.decisionRound).toBe(0);
    expect((await offered(A.memberToken, ev)).actions!.APPROVE_INTERNAL.enabled).toBe(false);
  });

  it("F3 — reconcile never undoes a review that continued after a request for information", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "f3-reconcile");
    await claimed(ev);
    expect((await decide(A.memberToken, ev, "REQUEST_MORE_INFO", "need more")).status).toBe(200);
    expect((await workflowOf(ev)).status).toBe("NEEDS_INFO");
    await begin(A.memberToken, ev); // the review resumes
    const { reconcileWorkflowProjection } = await import("../src/services/reviewer-ops/review-decision.service.js");
    const res = await reconcileWorkflowProjection((await workflowOf(ev)).id);
    expect(res.repaired).toBe(false);
    expect((await workflowOf(ev)).status).toBe("IN_REVIEW");
    // ...and a verdict can still be recorded after the resume.
    expect((await offered(A.memberToken, ev)).actions!.APPROVE_INTERNAL.enabled).toBe(true);
    expect((await decide(A.memberToken, ev, "APPROVE_INTERNAL")).status).toBe(200);
    expect((await workflowOf(ev)).status).toBe("APPROVED_INTERNAL");
  });

  it("F4 — two concurrent Escalate clicks: exactly one wins and exactly one escalation exists", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "f4-race");
    await claimed(ev);
    const results = await Promise.all([
      decide(A.memberToken, ev, "ESCALATE", "first"),
      decide(A.adminToken, ev, "ESCALATE", "second"),
    ]);
    const statuses = results.map((r) => r.status).sort();
    // Either the loser lost the conditional update (409) or arrived after the
    // move (the stage matrix refuses Escalated → Escalated, 409/422).
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);
    const wf = await workflowOf(ev);
    expect(wf.status).toBe("ESCALATED");
    expect(wf.escalationLevel).toBe(1);
    const escalations = await prisma.reviewEscalation.findMany({ where: { workflowId: wf.id } });
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.id).toBe(wf.activeEscalationId);
  });

  it("F5/F10 — the editor cannot close an escalated review, nor create one in a lifecycle state", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "f5-editor-close");
    await claimed(ev);
    expect((await decide(A.memberToken, ev, "ESCALATE", "help")).status).toBe(200);
    const close = await patchWorkflow(A.adminToken, ev, { status: "CLOSED" });
    expect(close.status).toBeGreaterThanOrEqual(400);
    expect((await workflowOf(ev)).status).toBe("ESCALATED");
    expect(await prisma.reviewEscalation.count({ where: { evidenceId: ev, status: "OPEN" } })).toBe(1);
    // The Close decision is the path, and it resolves the escalation.
    expect((await decide(A.adminToken, ev, "CLOSE", "resolved offline")).status).toBe(200);
    expect(await prisma.reviewEscalation.count({ where: { evidenceId: ev, status: "OPEN" } })).toBe(0);

    for (const status of ["ESCALATED", "REOPENED"]) {
      const fresh = await freshEvidence(A, `f10-${status}`);
      expect((await patchWorkflow(A.adminToken, fresh, { status })).status, status).toBeGreaterThanOrEqual(400);
      expect(await prisma.evidenceReviewWorkflow.count({ where: { evidenceId: fresh } }), status).toBe(0);
    }
  });

  it("F7 — after Claim the page offers Begin review to the review's owner only, and a verdict after it", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "f7-begin");
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    expect((await offered(A.memberToken, ev)).actions!.BEGIN_REVIEW.blockedBy).toBe("CLAIM_FIRST");
    expect((await claim(A.memberToken, ev, A.teamId)).status).toBe(200);
    expect((await offered(A.memberToken, ev)).actions!.BEGIN_REVIEW.enabled).toBe(true);
    expect((await offered(A.adminToken, ev)).actions!.BEGIN_REVIEW.blockedBy).toBe("OWNED_BY_SOMEONE_ELSE");
    await begin(A.memberToken, ev);
    const after = await offered(A.memberToken, ev);
    expect(after.actions!.BEGIN_REVIEW.enabled).toBe(false);
    expect(after.actions!.APPROVE_INTERNAL.enabled).toBe(true);
  });

  it("F12 — an unassigned escalation the engine raised is not titled as a reviewer's escalation", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "f12-engine");
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    const wf = await workflowOf(ev);
    const { createEscalation } = await import("../src/services/reviewer-ops/escalation-engine.service.js");
    const opened = await createEscalation({
      teamId: A.teamId,
      workflowId: wf.id,
      reason: "NO_REVIEWER_ASSIGNED",
      safeSummary: "No reviewer is assigned.",
      severity: "WARNING",
      evidenceId: ev,
      createdByUserId: null,
      routeToWorkspaceAdmins: true,
    } as never);
    expect(opened.ok).toBe(true);
    const id = (opened as unknown as { escalation: { id: string } }).escalation.id;
    const inbox = await call(A.adminToken, "GET", "/v1/me/inbox");
    const item = (inbox.body.items as Array<{ id: string; title: string }>).find((i) => i.id === `review_escalation:${id}`);
    expect(item?.title).toMatch(/^Escalation for your workspace's admins/);
  });

  it("ET-CUS-12 parity — a status-setting decision on the decision route is on custody; an idempotent replay is not", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "custody-parity");
    await claimed(ev);
    const count = () => prisma.custodyEvent.count({ where: { evidenceId: ev, eventType: "REVIEW_DECISION_RECORDED" } });
    const before = await count();
    expect((await decide(A.memberToken, ev, "APPROVE_INTERNAL")).status).toBe(200);
    expect((await decide(A.memberToken, ev, "APPROVE_INTERNAL")).status).toBe(200);
    expect((await count()) - before).toBe(1);
    const last = await prisma.custodyEvent.findFirstOrThrow({
      where: { evidenceId: ev, eventType: "REVIEW_DECISION_RECORDED" },
      orderBy: { sequence: "desc" },
    });
    expect(last.payload).toMatchObject({ status: "APPROVED_INTERNAL", actorUserId: A.memberUserId });
  });
});
