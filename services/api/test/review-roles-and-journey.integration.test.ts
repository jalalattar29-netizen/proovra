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

import { createHash } from "node:crypto";

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
/**
 * REVIEW IS NOT FORENSIC CUSTODY (owner decision 2026-10-24): every custody
 * row of the record, whatever its type — Review activity must add none.
 */
const allCustody = (ev: string) => prisma.custodyEvent.count({ where: { evidenceId: ev } });
/** Review activity is in the tenant audit, keyed to the workflow. */
const reviewAudits = async (ev: string, action: string) =>
  prisma.adminAuditLog.count({ where: { resourceId: (await workflowOf(ev)).id, action } });
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

  it("an external reviewer — an accepted portal grant on THIS record — gains nothing on the internal review routes", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "external-grant");
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    // The external reviewer is a PROOVRA account outside workspace A, invited
    // to review exactly this record through the external portal.
    const reviewer = await prisma.user.findUniqueOrThrow({ where: { id: B.memberUserId }, select: { email: true } });
    const rawPortalToken = "ext-" + ev;
    await prisma.externalReviewGrant.create({
      data: {
        teamId: A.teamId,
        scopeKind: "EVIDENCE",
        evidenceId: ev,
        tokenHash: createHash("sha256").update(rawPortalToken).digest("hex"),
        reviewerEmail: reviewer.email!,
        state: "ACTIVE",
        invitedByUserId: A.adminUserId,
        expiresAtUtc: new Date(Date.now() + 86_400_000),
        acceptedAtUtc: new Date(),
      },
    });
    // Signed in as themselves: the internal review routes stay closed.
    expect((await call(B.memberToken, "GET", `/v1/evidence/${ev}/review-workspace`)).status).toBe(404);
    expect((await claim(B.memberToken, ev, A.teamId)).status).toBe(404);
    expect((await decide(B.memberToken, ev, "ESCALATE", "x")).status).toBe(404);
    expect((await patchWorkflow(B.memberToken, ev, { status: "IN_REVIEW" })).status).toBe(404);
    // The portal credential is not a session on the internal routes.
    for (const res of [
      await call(rawPortalToken, "GET", `/v1/evidence/${ev}/review-workspace`),
      await claim(rawPortalToken, ev, A.teamId),
      await decide(rawPortalToken, ev, "ESCALATE", "x"),
    ]) {
      expect([401, 404]).toContain(res.status);
    }
    const wf = await workflowOf(ev);
    expect(wf.assignedToUserId).toBeNull();
    expect(wf.status).toBe("NOT_STARTED");
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

  it("a verdict on the decision route writes no custody; it is ONE tenant-audit decision, and an idempotent replay records nothing", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "custody-parity");
    await claimed(ev);
    const custodyBefore = await allCustody(ev);
    const auditBefore = await reviewAudits(ev, "review.decision.recorded");
    expect((await decide(A.memberToken, ev, "APPROVE_INTERNAL")).status).toBe(200);
    expect((await decide(A.memberToken, ev, "APPROVE_INTERNAL")).status).toBe(200); // idempotent replay
    expect(await allCustody(ev)).toBe(custodyBefore);
    expect((await reviewAudits(ev, "review.decision.recorded")) - auditBefore).toBe(1);
    const row = await prisma.adminAuditLog.findFirstOrThrow({
      where: { resourceId: (await workflowOf(ev)).id, action: "review.decision.recorded" },
      orderBy: { createdAt: "desc" },
    });
    expect(row).toMatchObject({ userId: A.memberUserId, resultingState: "APPROVED_INTERNAL", reasonCode: "REVIEW_DECISION_RECORDED" });
  });
});

// ===========================================================================
// Second independent audit (2026-10-23) — five state-machine defects
// ===========================================================================

describe("second audit — escalation atomicity, settled requests, repeated requests, every escalation, Close stands", () => {
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
  const openEscalations = (ev: string) =>
    prisma.reviewEscalation.count({ where: { evidenceId: ev, status: { in: ["OPEN", "ACKNOWLEDGED", "REASSIGNED"] } } });

  it("#1 — Escalate is one transaction: a failure after the escalation row leaves neither the move nor the escalation", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "audit2-atomic");
    await claimed(ev);
    // Fail the LAST write of an Escalate (the workflow's escalation pointer),
    // after the escalation row and its outbox row were written.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION audit2_fail_pointer() RETURNS trigger AS $$
      BEGIN
        IF NEW.escalation_reason = 'FAIL-INJECT' AND NEW.active_escalation_id IS DISTINCT FROM OLD.active_escalation_id THEN
          RAISE EXCEPTION 'injected failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER audit2_fail_pointer BEFORE UPDATE ON evidence_review_workflows FOR EACH ROW EXECUTE FUNCTION audit2_fail_pointer()`,
    );
    try {
      const res = await decide(A.memberToken, ev, "ESCALATE", "FAIL-INJECT");
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS audit2_fail_pointer ON evidence_review_workflows`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS audit2_fail_pointer()`);
    }
    const wf = await workflowOf(ev);
    expect(wf.status).toBe("IN_REVIEW");
    expect(wf.escalationLevel).toBe(0);
    expect(await prisma.reviewEscalation.count({ where: { evidenceId: ev } })).toBe(0);
    // And the review can still be escalated afterwards.
    expect((await decide(A.memberToken, ev, "ESCALATE", "real reason")).status).toBe(200);
    expect(await openEscalations(ev)).toBe(1);
  });

  it("#1 — Escalate racing Close: exactly one wins and the record is consistent either way", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "audit2-race-close");
    await claimed(ev);
    const [esc, close] = await Promise.all([
      decide(A.memberToken, ev, "ESCALATE", "needs counsel"),
      decide(A.adminToken, ev, "CLOSE", "closing"),
    ]);
    expect([esc.status, close.status].filter((s) => s === 200)).toHaveLength(1);
    const wf = await workflowOf(ev);
    if (wf.status === "ESCALATED") {
      expect(await openEscalations(ev)).toBe(1);
    } else {
      expect(wf.status).toBe("CLOSED");
      expect(await openEscalations(ev)).toBe(0);
    }
  });

  it("#2 — a request that settled its round stays settled when the review is escalated: the next verdict opens a new round, never a 'disagreement'", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "audit2-settled");
    await claimed(ev);
    expect((await decide(A.memberToken, ev, "REQUEST_MORE_INFO", "need the original")).status).toBe(200);
    expect((await workflowOf(ev)).status).toBe("NEEDS_INFO");
    expect((await decide(A.memberToken, ev, "ESCALATE", "counsel please")).status).toBe(200);
    // The page offers the admin a verdict — not adjudication.
    expect((await offered(A.adminToken, ev)).actions!.APPROVE_INTERNAL.enabled).toBe(true);
    expect((await decide(A.adminToken, ev, "APPROVE_INTERNAL")).status).toBe(200);
    let wf = await workflowOf(ev);
    expect(wf.decisionRound).toBe(1);
    const rows = await prisma.workflowReviewDecision.findMany({ where: { workflowId: wf.id }, orderBy: { decidedAt: "asc" } });
    expect(rows.map((r) => [r.round, r.stage, r.decision])).toEqual([
      [0, "FIRST", "REQUEST_INFO"],
      [1, "FIRST", "APPROVE"],
    ]);
    // An escalated review takes a second review: the admin waits, the member decides.
    expect(wf.status).toBe("ESCALATED");
    expect((await offered(A.adminToken, ev)).actions!.APPROVE_INTERNAL.blockedBy).toBe("AWAITING_SECOND_REVIEWER");
    expect((await offered(A.memberToken, ev)).actions!.APPROVE_INTERNAL.enabled).toBe(true);
    expect((await decide(A.memberToken, ev, "APPROVE_INTERNAL")).status).toBe(200);
    wf = await workflowOf(ev);
    expect(wf.status).toBe("APPROVED_INTERNAL");
    expect(await openEscalations(ev)).toBe(0);
  });

  it("#3 — the same reviewer may request information again after the review resumed; while it still waits, a repeat is a replay", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "audit2-again");
    await claimed(ev);
    expect((await decide(A.memberToken, ev, "REQUEST_MORE_INFO", "first ask")).status).toBe(200);
    const replay = await decide(A.memberToken, ev, "REQUEST_MORE_INFO", "first ask");
    expect(replay.status).toBe(200);
    expect((await workflowOf(ev)).decisionRound).toBe(0);
    await begin(A.memberToken, ev); // resumed
    expect((await offered(A.memberToken, ev)).actions!.REQUEST_MORE_INFO.enabled).toBe(true);
    expect((await decide(A.memberToken, ev, "REQUEST_MORE_INFO", "second ask")).status).toBe(200);
    const wf = await workflowOf(ev);
    expect(wf.status).toBe("NEEDS_INFO");
    expect(wf.decisionRound).toBe(1);
    expect(
      await prisma.workflowReviewDecision.count({ where: { workflowId: wf.id, decision: "REQUEST_INFO" } }),
    ).toBe(2);
  });

  it("#4 — Close resolves EVERY open escalation on the review, not only the newest", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "audit2-every");
    await claimed(ev);
    expect((await decide(A.memberToken, ev, "ESCALATE", "first")).status).toBe(200);
    await begin(A.adminToken, ev); // an admin resumes the review
    expect((await decide(A.memberToken, ev, "ESCALATE", "again")).status).toBe(200);
    expect(await openEscalations(ev)).toBe(2);
    expect((await decide(A.adminToken, ev, "CLOSE", "handled")).status).toBe(200);
    expect(await openEscalations(ev)).toBe(0);
  });

  it("#5 — the reconciler never undoes a Close: approved-then-closed and conflict-then-closed stay Closed", async () => {
    await setPlan(A, "TEAM");
    const { reconcileWorkflowProjection } = await import("../src/services/reviewer-ops/review-decision.service.js");
    const ev = await freshEvidence(A, "audit2-close-approved");
    await claimed(ev);
    expect((await decide(A.memberToken, ev, "APPROVE_INTERNAL")).status).toBe(200);
    expect((await decide(A.adminToken, ev, "CLOSE", "done")).status).toBe(200);
    expect(await reconcileWorkflowProjection((await workflowOf(ev)).id)).toMatchObject({ repaired: false, reason: "closed_after_decisions" });
    expect((await workflowOf(ev)).status).toBe("CLOSED");

    const ev2 = await freshEvidence(A, "audit2-close-conflict");
    await prisma.evidenceLegalHold.create({
      data: { scope: "EVIDENCE", evidenceId: ev2, teamId: A.teamId, status: "ACTIVE", title: "Hold", placedByUserId: A.ownerUserId } as never,
    });
    await claimed(ev2);
    expect((await decide(A.memberToken, ev2, "APPROVE_INTERNAL")).status).toBe(200);
    expect((await decide(A.adminToken, ev2, "REJECT_INSUFFICIENT", "no")).status).toBe(200);
    expect((await workflowOf(ev2)).status).toBe("ESCALATED");
    // A disagreement: the page offers the owner the deciding verdict (the
    // authority accepts it as adjudication) and tells the member who decides.
    expect((await offered(A.ownerToken, ev2)).actions!.APPROVE_INTERNAL.enabled).toBe(true);
    expect((await offered(A.memberToken, ev2)).actions!.APPROVE_INTERNAL.blockedBy).toBe("ADJUDICATION_REQUIRED");
    expect((await decide(A.adminToken, ev2, "CLOSE", "settled elsewhere")).status).toBe(200);
    await reconcileWorkflowProjection((await workflowOf(ev2)).id);
    expect((await workflowOf(ev2)).status).toBe("CLOSED");
  });
});

describe("Review activity is audited exactly once, in the action's own transaction — never custody", () => {
  const ready = async (ev: string) => {
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    expect((await claim(A.memberToken, ev, A.teamId)).status).toBe(200);
    const wf = await workflowOf(ev);
    expect((await patchWorkflow(A.memberToken, ev, { status: "IN_REVIEW", expectedUpdatedAt: wf.updatedAt.toISOString() })).status).toBe(200);
  };

  it("a double-clicked verdict is ONE audited decision and no custody", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "custody-double");
    await ready(ev);
    const custodyBefore = await allCustody(ev);
    const before = await reviewAudits(ev, "review.decision.recorded");
    const results = await Promise.all([decide(A.memberToken, ev, "APPROVE_INTERNAL"), decide(A.memberToken, ev, "APPROVE_INTERNAL")]);
    expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect((await reviewAudits(ev, "review.decision.recorded")) - before).toBe(1);
    expect(await allCustody(ev)).toBe(custodyBefore);
  });

  it("Escalate, a verdict, Close and Reopen are each one audit entry under its own action; none writes custody", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "custody-lifecycle");
    await ready(ev);
    const custodyBefore = await allCustody(ev);
    expect((await decide(A.memberToken, ev, "ESCALATE", "counsel")).status).toBe(200);
    expect(await reviewAudits(ev, "review.escalation.created")).toBe(1);
    // Escalated → a second review is required: the FIRST verdict moves no
    // stage, but it is still a recorded decision.
    expect((await decide(A.memberToken, ev, "APPROVE_INTERNAL")).status).toBe(200);
    expect((await workflowOf(ev)).status).toBe("ESCALATED");
    expect(await reviewAudits(ev, "review.decision.recorded")).toBe(1);
    expect((await decide(A.adminToken, ev, "CLOSE", "done")).status).toBe(200);
    expect((await decide(A.adminToken, ev, "REOPEN", "more")).status).toBe(200);
    expect(await reviewAudits(ev, "review.closed")).toBe(1);
    expect(await reviewAudits(ev, "review.reopened")).toBe(1);
    expect(await allCustody(ev)).toBe(custodyBefore);
  });

  it("bulk Mark in review, Escalate and Close are audited too, and write no custody", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "custody-bulk");
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    const custodyBefore = await allCustody(ev);
    for (const action of ["MARK_IN_REVIEW", "ESCALATE", "CLOSE"]) {
      const res = await call(A.adminToken, "POST", "/v1/review-operations/bulk", {
        teamId: A.teamId,
        evidenceIds: [ev],
        action,
        note: "bulk " + action,
      });
      expect(res.status, action + " " + JSON.stringify(res.body)).toBe(200);
    }
    expect((await workflowOf(ev)).status).toBe("CLOSED");
    expect(await reviewAudits(ev, "review.state.changed")).toBe(1);
    expect(await reviewAudits(ev, "review.escalation.created")).toBe(1);
    expect(await reviewAudits(ev, "review.closed")).toBe(1);
    expect(await allCustody(ev)).toBe(custodyBefore);
  });
});

// ===========================================================================
// Third independent audit (2026-10-23) — the remaining P3s
// ===========================================================================

describe("third audit — side effects after commit, legacy rounds, console, custody only on change, stale escalations, inbox", () => {
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
  const openEscalations = (ev: string) =>
    prisma.reviewEscalation.count({ where: { evidenceId: ev, status: { in: ["OPEN", "ACKNOWLEDGED", "REASSIGNED"] } } });

  it("Escalate announces its escalation (security event, platform audit) only after commit — a rolled-back escalation is never announced", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "audit3-announce");
    await claimed(ev);
    const securityBefore = await prisma.securityEvent.count({ where: { teamId: A.teamId, eventType: "reviewer_escalation_created" } });
    const auditBefore = await prisma.adminAuditLog.count({ where: { workspaceId: A.teamId, action: "reviewer.escalation.create" } });
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION audit3_fail_pointer() RETURNS trigger AS $$
      BEGIN
        -- After createEscalation has returned: the Escalate event insert.
        IF NEW.note = 'FAIL-INJECT' AND NEW.event_type = 'ESCALATED' THEN
          RAISE EXCEPTION 'injected failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER audit3_fail_pointer BEFORE INSERT ON evidence_review_workflow_events FOR EACH ROW EXECUTE FUNCTION audit3_fail_pointer()`,
    );
    try {
      expect((await decide(A.memberToken, ev, "ESCALATE", "FAIL-INJECT")).status).toBeGreaterThanOrEqual(500);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS audit3_fail_pointer ON evidence_review_workflow_events`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS audit3_fail_pointer()`);
    }
    expect(await prisma.securityEvent.count({ where: { teamId: A.teamId, eventType: "reviewer_escalation_created" } })).toBe(securityBefore);
    expect(await prisma.adminAuditLog.count({ where: { workspaceId: A.teamId, action: "reviewer.escalation.create" } })).toBe(auditBefore);
    // A committed Escalate is announced, once — and the security events then
    // number exactly one more than before: the rolled-back attempt left no
    // (fire-and-forget) event behind.
    expect((await decide(A.memberToken, ev, "ESCALATE", "real reason")).status).toBe(200);
    const esc = await prisma.reviewEscalation.findFirstOrThrow({ where: { evidenceId: ev } });
    await expect
      .poll(() => prisma.adminAuditLog.count({ where: { action: "reviewer.escalation.create", resourceId: esc.id } }))
      .toBe(1);
    const securityNow = () =>
      prisma.securityEvent.count({ where: { teamId: A.teamId, eventType: "reviewer_escalation_created" } });
    await expect.poll(securityNow).toBeGreaterThanOrEqual(securityBefore + 1);
    await new Promise((r) => setTimeout(r, 750));
    expect(await securityNow()).toBe(securityBefore + 1);
  });

  it("a request recorded before rounds were logged still settles its round (legacy event without a round)", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "audit3-legacy");
    await claimed(ev);
    expect((await decide(A.memberToken, ev, "REQUEST_MORE_INFO", "need the original")).status).toBe(200);
    const wf0 = await workflowOf(ev);
    // As an earlier build wrote it: the same event, with no round.
    await prisma.$executeRawUnsafe(
      `UPDATE evidence_review_workflow_events SET next_value = next_value - 'round' WHERE workflow_id = $1::uuid AND event_type = 'DECISION_LOGGED'`,
      wf0.id,
    );
    expect((await decide(A.memberToken, ev, "ESCALATE", "counsel please")).status).toBe(200);
    expect((await offered(A.adminToken, ev)).actions!.APPROVE_INTERNAL.enabled).toBe(true);
    expect((await decide(A.adminToken, ev, "APPROVE_INTERNAL")).status).toBe(200);
    const wf = await workflowOf(ev);
    expect(wf.decisionRound).toBe(1);
    expect(
      (await prisma.workflowReviewDecision.findMany({ where: { workflowId: wf.id, round: 1 } })).map((r) => [r.stage, r.decision]),
    ).toEqual([["FIRST", "APPROVE"]]);
  });

  it("the reviewer console reads a settled round as the authority does", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "audit3-console");
    await claimed(ev);
    expect((await decide(A.memberToken, ev, "REQUEST_MORE_INFO", "need more")).status).toBe(200);
    expect((await decide(A.memberToken, ev, "ESCALATE", "counsel")).status).toBe(200);
    const wf = await workflowOf(ev);
    const res = await call(A.adminToken, "GET", `/v1/reviewer-ops/workspace/${wf.id}/decisions?teamId=${A.teamId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Settled by the request: the next verdict opens a new round, never "second".
    expect(res.body.state).toBe("resolved");
  });

  it("Review edits write no custody; the audit records only a real change (no status, the same status, bulk Mark in review on a review in review)", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "audit3-nochange");
    await claimed(ev); // IN_REVIEW
    const custodyBefore = await allCustody(ev);
    const statesBefore = await reviewAudits(ev, "review.state.changed");
    expect((await patchWorkflow(A.adminToken, ev, { priority: "HIGH" })).status).toBe(200);
    expect(await reviewAudits(ev, "review.priority.changed")).toBe(1);
    expect((await patchWorkflow(A.adminToken, ev, { status: "IN_REVIEW" })).status).toBe(200);
    const bulk = await call(A.adminToken, "POST", "/v1/review-operations/bulk", {
      teamId: A.teamId,
      evidenceIds: [ev],
      action: "MARK_IN_REVIEW",
      note: "already",
    });
    expect(bulk.status).toBe(200);
    expect((await reviewAudits(ev, "review.state.changed")) - statesBefore).toBe(0);
    // A real editor status change is audited, once.
    expect((await patchWorkflow(A.adminToken, ev, { status: "CLOSED" })).status).toBe(200);
    expect(await reviewAudits(ev, "review.closed")).toBe(1);
    expect(await allCustody(ev)).toBe(custodyBefore);
  });

  it("an escalation a failed Close left open is resolved by Reopen and by the reconciler", async () => {
    await setPlan(A, "TEAM");
    const { reconcileWorkflowProjection } = await import("../src/services/reviewer-ops/review-decision.service.js");
    const ev = await freshEvidence(A, "audit3-stale");
    await claimed(ev);
    expect((await decide(A.memberToken, ev, "APPROVE_INTERNAL")).status).toBe(200);
    expect((await decide(A.memberToken, ev, "REOPEN", "more")).status).toBe(200);
    await begin(A.memberToken, ev);
    expect((await decide(A.memberToken, ev, "ESCALATE", "help")).status).toBe(200);
    expect((await decide(A.adminToken, ev, "CLOSE", "done")).status).toBe(200);
    // As if the Close's resolution had failed after commit:
    await prisma.reviewEscalation.updateMany({ where: { evidenceId: ev }, data: { status: "OPEN", resolvedAtUtc: null } });
    expect(await openEscalations(ev)).toBe(1);
    await reconcileWorkflowProjection((await workflowOf(ev)).id);
    expect(await openEscalations(ev)).toBe(0);
    expect((await workflowOf(ev)).status).toBe("CLOSED");
    // And Reopen clears one too.
    await prisma.reviewEscalation.updateMany({ where: { evidenceId: ev }, data: { status: "OPEN", resolvedAtUtc: null } });
    expect((await decide(A.adminToken, ev, "REOPEN", "again")).status).toBe(200);
    expect(await openEscalations(ev)).toBe(0);
  });

  it("the inbox says 'awaiting peer review' only while a second reviewer is actually awaited", async () => {
    await setPlan(A, "TEAM");
    const awaiting = async (wfId: string) =>
      ((await call(A.memberToken, "GET", "/v1/me/inbox")).body.items as Array<{ id: string }>).some(
        (i) => i.id === `review_decision:awaiting_second:${wfId}`,
      );
    const single = await freshEvidence(A, "audit3-inbox-single");
    await claimed(single);
    expect((await decide(A.memberToken, single, "APPROVE_INTERNAL")).status).toBe(200);
    expect(await awaiting((await workflowOf(single)).id)).toBe(false);

    const held = await freshEvidence(A, "audit3-inbox-held");
    await prisma.evidenceLegalHold.create({
      data: { scope: "EVIDENCE", evidenceId: held, teamId: A.teamId, status: "ACTIVE", title: "Hold", placedByUserId: A.ownerUserId } as never,
    });
    await claimed(held);
    expect((await decide(A.memberToken, held, "APPROVE_INTERNAL")).status).toBe(200);
    expect(await awaiting((await workflowOf(held)).id)).toBe(true);
    // The hold is released while the review is still open: nobody is
    // awaited any more, and the inbox stops saying so.
    expect((await workflowOf(held)).status).toBe("IN_REVIEW");
    await prisma.evidenceLegalHold.updateMany({ where: { evidenceId: held }, data: { status: "RELEASED" } as never });
    expect(await awaiting((await workflowOf(held)).id)).toBe(false);
  });
});

// ===========================================================================
// Fourth independent audit (2026-10-23)
// ===========================================================================

describe("fourth audit — opening a review is not a decision; the reconciler resolves only what preceded the close", () => {

  it("opening a workflow — by record completion or the editor — and every later Review change write no custody; they are audited", async () => {
    await setPlan(A, "TEAM");
    const { upsertEvidenceReviewerWorkflow } = await import("../src/services/evidence-review/reviewer-workflow.service.js");
    // Exactly what completion's fan-out passes (evidence-complete.service.ts).
    const completed = await freshEvidence(A, "audit4-completion");
    const completedBefore = await allCustody(completed);
    await upsertEvidenceReviewerWorkflow({
      evidenceId: completed,
      workspaceType: "TEAM",
      teamId: A.teamId,
      actorUserId: A.ownerUserId,
      status: "NOT_STARTED",
      priority: "NORMAL",
      note: "Created automatically on Capture finalization.",
    } as never);
    expect(await prisma.evidenceReviewWorkflow.count({ where: { evidenceId: completed } })).toBe(1);
    expect(await allCustody(completed)).toBe(completedBefore);
    expect(await reviewAudits(completed, "review.workflow.created")).toBe(1);
    // The editor opening one, then a real state change: audited, never custody.
    const edited = await freshEvidence(A, "audit4-editor");
    const editedBefore = await allCustody(edited);
    expect((await patchWorkflow(A.adminToken, edited, { status: "NOT_STARTED" })).status).toBe(200);
    expect((await claim(A.memberToken, edited, A.teamId)).status).toBe(200);
    const wf = await workflowOf(edited);
    expect((await patchWorkflow(A.memberToken, edited, { status: "IN_REVIEW", expectedUpdatedAt: wf.updatedAt.toISOString() })).status).toBe(200);
    expect(await reviewAudits(edited, "review.claimed")).toBe(1);
    expect(await reviewAudits(edited, "review.state.changed")).toBe(1);
    expect(await allCustody(edited)).toBe(editedBefore);
  });

  it("the reconciler leaves an escalation raised after its read of the closed review", async () => {
    await setPlan(A, "TEAM");
    const { reconcileWorkflowProjection } = await import("../src/services/reviewer-ops/review-decision.service.js");
    const ev = await freshEvidence(A, "audit4-window");
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    expect((await claim(A.memberToken, ev, A.teamId)).status).toBe(200);
    let wf = await workflowOf(ev);
    expect((await patchWorkflow(A.memberToken, ev, { status: "IN_REVIEW", expectedUpdatedAt: wf.updatedAt.toISOString() })).status).toBe(200);
    expect((await decide(A.memberToken, ev, "APPROVE_INTERNAL")).status).toBe(200);
    expect((await decide(A.memberToken, ev, "REOPEN", "more")).status).toBe(200);
    wf = await workflowOf(ev);
    expect((await patchWorkflow(A.memberToken, ev, { status: "IN_REVIEW", expectedUpdatedAt: wf.updatedAt.toISOString() })).status).toBe(200);
    expect((await decide(A.memberToken, ev, "ESCALATE", "help")).status).toBe(200);
    expect((await decide(A.adminToken, ev, "CLOSE", "done")).status).toBe(200);
    // An escalation raised AFTER the closed state the reconciler reads (as a
    // Reopen + Escalate racing it would raise) is not the closed review's.
    await prisma.reviewEscalation.updateMany({
      where: { evidenceId: ev },
      data: { status: "OPEN", resolvedAtUtc: null, createdAt: new Date(Date.now() + 3_600_000) },
    });
    await reconcileWorkflowProjection((await workflowOf(ev)).id);
    expect(await prisma.reviewEscalation.count({ where: { evidenceId: ev, status: "OPEN" } })).toBe(1);
  });
});

// ===========================================================================
// Workflow state vs current-round decision (owner decision 2026-10-24)
// ===========================================================================

describe("workflow state and decision are separate — Close never decides, races never lose a verdict", () => {
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
  const outcome = async (ev: string) => {
    const res = await call(A.adminToken, "GET", `/v1/evidence/${ev}/review-workspace`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.reviewWorkflow as { workflowState: string; decision: string; decisionLabel: string };
  };

  it("Reject then Close: Workflow Closed · Decision Not accepted; Close wrote no decision row", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "decision-reject-close");
    await claimed(ev);
    expect((await decide(A.memberToken, ev, "REJECT_INSUFFICIENT", "insufficient")).status).toBe(200);
    const rowsBefore = await prisma.workflowReviewDecision.count({ where: { workflowId: (await workflowOf(ev)).id } });
    expect((await decide(A.adminToken, ev, "CLOSE", "done")).status).toBe(200);
    expect(await outcome(ev)).toMatchObject({ workflowState: "CLOSED", decision: "NOT_ACCEPTED", decisionLabel: "Not accepted" });
    expect(await prisma.workflowReviewDecision.count({ where: { workflowId: (await workflowOf(ev)).id } })).toBe(rowsBefore);
  });

  it("Close racing a verdict resolves deterministically: an accepted Approve is never lost", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "decision-race");
    await claimed(ev);
    const [approve, close] = await Promise.all([
      decide(A.memberToken, ev, "APPROVE_INTERNAL"),
      decide(A.adminToken, ev, "CLOSE", "closing"),
    ]);
    expect([approve.status, close.status].some((x) => x === 200)).toBe(true);
    const o = await outcome(ev);
    if (approve.status === 200) {
      // The verdict was accepted: whatever happened to the workflow, it decided Approved.
      expect(o.decision).toBe("APPROVED");
      expect(await prisma.workflowReviewDecision.count({ where: { workflowId: (await workflowOf(ev)).id, decision: "APPROVE" } })).toBe(1);
    } else {
      // Close won and the verdict was refused: no decision, no row.
      expect(o).toMatchObject({ workflowState: "CLOSED", decision: "NO_DECISION" });
      expect(await prisma.workflowReviewDecision.count({ where: { workflowId: (await workflowOf(ev)).id } })).toBe(0);
    }
    if (close.status === 200) expect(o.workflowState).toBe("CLOSED");
  });

  it("bulk-triage Close never records a verdict (it used to record REJECT for every review it closed)", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "decision-bulk-close");
    await claimed(ev);
    const wf = await workflowOf(ev);
    const { executeBulkTriage } = await import("../src/services/reviewer-ops/bulk-triage.service.js");
    const result = await executeBulkTriage(
      { teamId: A.teamId, actorUserId: A.adminUserId, isReviewerCapable: true, isServiceAccount: false } as never,
      { teamId: A.teamId, workflowIds: [wf.id], action: "CLOSE", note: "bulk close" } as never,
    );
    expect(JSON.stringify(result)).not.toMatch(/"ok":false/);
    expect((await workflowOf(ev)).status).toBe("CLOSED");
    expect(await prisma.workflowReviewDecision.count({ where: { workflowId: wf.id } })).toBe(0);
    expect(await outcome(ev)).toMatchObject({ workflowState: "CLOSED", decision: "NO_DECISION" });
  });

  it("the export governance gate reads the decision: Approved then Closed is still reviewed; Reopened is not", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "decision-gate");
    await claimed(ev);
    const { evidenceIsReviewed } = await import("../src/services/governance.service.js");
    expect(await evidenceIsReviewed(ev)).toBe(false);
    expect((await decide(A.memberToken, ev, "APPROVE_INTERNAL")).status).toBe(200);
    expect(await evidenceIsReviewed(ev)).toBe(true);
    expect((await decide(A.adminToken, ev, "CLOSE", "done")).status).toBe(200);
    expect(await evidenceIsReviewed(ev)).toBe(true);
    expect((await decide(A.adminToken, ev, "REOPEN", "again")).status).toBe(200);
    expect(await evidenceIsReviewed(ev)).toBe(false);
  });
});

describe("a lifecycle move that commits between a verdict's read and its write is never overwritten (deterministic interleaving)", () => {
  it("Close commits after the verdict read the review: the verdict is refused and rolled back; the review stays Closed with no decision", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "decision-interleave");
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    expect((await claim(A.memberToken, ev, A.teamId)).status).toBe(200);
    const wf0 = await workflowOf(ev);
    expect((await patchWorkflow(A.memberToken, ev, { status: "IN_REVIEW", expectedUpdatedAt: wf0.updatedAt.toISOString() })).status).toBe(200);
    const wf = await workflowOf(ev);
    const { recordReviewDecision } = await import("../src/services/reviewer-ops/review-decision.service.js");
    let interleaved = false;
    // The verdict's own transaction, with one seam: right after it reads the
    // review, a Close commits from ANOTHER connection.
    const client = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
          (target as typeof prisma).$transaction(async (tx) => {
            const wrapped = new Proxy(tx, {
              get(t, p2, r2) {
                const model = Reflect.get(t, p2, r2);
                if (p2 !== "evidenceReviewWorkflow") return model;
                return new Proxy(model as object, {
                  get(m, method, r3) {
                    const f = Reflect.get(m, method, r3) as (...a: unknown[]) => Promise<unknown>;
                    if (method !== "findFirst") return f;
                    return async (...args: unknown[]) => {
                      const read = await f.apply(m, args);
                      if (!interleaved) {
                        interleaved = true;
                        await prisma.evidenceReviewWorkflow.update({ where: { id: wf.id }, data: { status: "CLOSED", closedAt: new Date() } });
                      }
                      return read;
                    };
                  },
                });
              },
            });
            return fn(wrapped);
          }, opts as never);
      },
    });
    await expect(
      recordReviewDecision(
        { workflowId: wf.id, teamId: A.teamId, actorUserId: A.memberUserId, decision: "APPROVE", rationale: null, actorIsAdjudicator: false } as never,
        client as never,
      ),
    ).rejects.toMatchObject({ code: "stale_decision" });
    expect(interleaved).toBe(true);
    const after = await workflowOf(ev);
    expect(after.status).toBe("CLOSED");
    expect(await prisma.workflowReviewDecision.count({ where: { workflowId: wf.id } })).toBe(0);
  });
});

describe("fifth audit — one decision derivation, legacy verdicts survive Close, claim and assign are atomic", () => {
  const begin = async (token: string, ev: string) => {
    const wf = await workflowOf(ev);
    const res = await patchWorkflow(token, ev, { status: "IN_REVIEW", expectedUpdatedAt: wf.updatedAt.toISOString() });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };
  const outcome = async (ev: string) => {
    const res = await call(A.adminToken, "GET", `/v1/evidence/${ev}/review-workspace`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.reviewWorkflow as { workflowState: string; decision: string; decisionLabel: string };
  };
  const hold = (ev: string) =>
    prisma.evidenceLegalHold.create({
      data: {
        teamId: A.teamId,
        evidenceId: ev,
        scope: "EVIDENCE",
        status: "ACTIVE",
        title: "Fifth-audit hold",
        reason: "second review required",
        placedByUserId: A.ownerUserId,
      } as never,
    });

  it("a first approval made while a second review was required is Approved everywhere once the requirement is lifted (P2-1)", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "fifth-live-requirement");
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    expect((await claim(A.memberToken, ev, A.teamId)).status).toBe(200);
    await begin(A.memberToken, ev);
    const h = await hold(ev);
    expect((await decide(A.memberToken, ev, "APPROVE_INTERNAL")).status).toBe(200);
    // Logged at decision time as "second review required": no decision yet.
    expect((await outcome(ev)).decision).toBe("NO_DECISION");
    const { evidenceIsReviewed } = await import("../src/services/governance.service.js");
    expect(await evidenceIsReviewed(ev)).toBe(false);

    await prisma.evidenceLegalHold.update({ where: { id: h.id }, data: { status: "RELEASED" } as never });
    // The authority now derives the round as resolved and refuses another verdict...
    const second = await decide(A.adminToken, ev, "APPROVE_INTERNAL");
    expect(second.status, JSON.stringify(second.body)).not.toBe(200);
    // ...and every reader agrees with it: Approved, and the export gate passes.
    expect((await outcome(ev)).decision).toBe("APPROVED");
    expect(await evidenceIsReviewed(ev)).toBe(true);
    const wf = await workflowOf(ev);
    const { loadCurrentReviewDecisions } = await import("../src/services/evidence-review/review-outcome.service.js");
    const batch = await loadCurrentReviewDecisions([{ id: wf.id, teamId: wf.teamId, evidenceId: ev, status: String(wf.status), decisionRound: wf.decisionRound }]);
    expect(batch.get(wf.id)).toBe("APPROVED");
  });

  it("a verdict already reached stands when a requirement arrives afterwards (a hold placed on an approved record)", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "fifth-reached-stands");
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    expect((await claim(A.memberToken, ev, A.teamId)).status).toBe(200);
    await begin(A.memberToken, ev);
    expect((await decide(A.memberToken, ev, "APPROVE_INTERNAL")).status).toBe(200);
    expect((await outcome(ev)).decision).toBe("APPROVED");
    await hold(ev);
    expect((await outcome(ev)).decision).toBe("APPROVED");
  });

  it("Close never erases a legacy verdict: approved before the decision log existed, then Closed, still reads Approved (P2-2)", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "fifth-legacy-close");
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    const wf0 = await workflowOf(ev);
    // The legacy shape: a verdict status written directly, with its history
    // event, and no decision rows at all (round 0).
    await prisma.evidenceReviewWorkflow.update({ where: { id: wf0.id }, data: { status: "APPROVED_INTERNAL" } });
    await prisma.evidenceReviewWorkflowEvent.create({
      data: { workflowId: wf0.id, evidenceId: ev, actorUserId: A.adminUserId, eventType: "STATUS_CHANGED", previousValue: { status: "IN_REVIEW" }, nextValue: { status: "APPROVED_INTERNAL" } },
    });
    expect(await prisma.workflowReviewDecision.count({ where: { workflowId: wf0.id } })).toBe(0);
    expect((await outcome(ev)).decision).toBe("APPROVED");

    expect((await decide(A.adminToken, ev, "CLOSE", "done")).status).toBe(200);
    expect(await outcome(ev)).toMatchObject({ workflowState: "CLOSED", decision: "APPROVED" });
    const { evidenceIsReviewed } = await import("../src/services/governance.service.js");
    expect(await evidenceIsReviewed(ev)).toBe(true);

    // Reopen starts a new round with no decision.
    expect((await decide(A.adminToken, ev, "REOPEN", "again")).status).toBe(200);
    expect((await outcome(ev)).decision).toBe("NO_DECISION");
  });

  it("a legacy verdict followed by a Reopen in the same round-0 history reads No decision (Reopen ends the verdict)", async () => {
    const { loadCurrentReviewDecisions } = await import("../src/services/evidence-review/review-outcome.service.js");
    const ev = await freshEvidence(A, "fifth-legacy-reopened");
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    const wf = await workflowOf(ev);
    const t0 = Date.now();
    const steps = [["STATUS_CHANGED", "APPROVED_INTERNAL"], ["REOPENED", "REOPENED"], ["CLOSED", "CLOSED"]] as const;
    for (const [i, [eventType, to]] of steps.entries()) {
      await prisma.evidenceReviewWorkflowEvent.create({
        data: { workflowId: wf.id, evidenceId: ev, actorUserId: A.adminUserId, eventType, nextValue: { status: to }, createdAt: new Date(t0 + 1000 * (i + 1)) },
      });
    }
    const got = await loadCurrentReviewDecisions([{ id: wf.id, teamId: wf.teamId, evidenceId: ev, status: "CLOSED", decisionRound: 0 }]);
    expect(got.get(wf.id)).toBe("NO_DECISION");
  });

  /** A client whose transactions fail at the reviewer-audit write. */
  const failingAuditClient = () =>
    new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
          (target as typeof prisma).$transaction(async (tx) => {
            const wrapped = new Proxy(tx, {
              get(t, p2, r2) {
                const model = Reflect.get(t, p2, r2);
                if (p2 !== "evidenceReviewerAuditEvent") return model;
                return new Proxy(model as object, {
                  get(m, method, r3) {
                    if (method === "create") {
                      return async () => {
                        throw new Error("injected audit failure");
                      };
                    }
                    return Reflect.get(m, method, r3);
                  },
                });
              },
            });
            return fn(wrapped);
          }, opts as never);
      },
    });

  it("claim: a failed audit write leaves no claim, no history event and no tenant audit; the retry then succeeds and is audited (P2-3)", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "fifth-claim-atomic");
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    const before = await workflowOf(ev);
    const { claimReviewerWorkflow } = await import("../src/services/review-operations/review-operations.service.js");
    await expect(claimReviewerWorkflow({ evidenceId: ev, actorUserId: A.memberUserId }, failingAuditClient() as never)).rejects.toThrow(/injected audit failure/);
    const after = await workflowOf(ev);
    expect(after.assignedToUserId).toBeNull();
    expect(after.status).toBe(before.status);
    expect(await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId: before.id, eventType: "CLAIMED" } })).toBe(0);
    expect(await reviewAudits(ev, "review.claimed")).toBe(0);
    // The retry is not swallowed by the idempotent no-op: nothing was claimed.
    expect((await claim(A.memberToken, ev, A.teamId)).status).toBe(200);
    expect((await workflowOf(ev)).assignedToUserId).toBe(A.memberUserId);
    expect(await reviewAudits(ev, "review.claimed")).toBe(1);
    expect(await allCustody(ev)).toBe(0);
  });

  it("assign: a failed audit write leaves the assignment unchanged and unaudited (P2-3)", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "fifth-assign-atomic");
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    const before = await workflowOf(ev);
    const { assignReviewer } = await import("../src/services/review-operations/review-operations.service.js");
    await expect(
      assignReviewer({ evidenceId: ev, assignedToUserId: A.memberUserId, actorUserId: A.adminUserId }, failingAuditClient() as never),
    ).rejects.toThrow(/injected audit failure/);
    const after = await workflowOf(ev);
    expect(after.assignedToUserId).toBe(before.assignedToUserId);
    expect(after.status).toBe(before.status);
    expect(await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId: before.id, eventType: { in: ["ASSIGNED", "REASSIGNED"] } } })).toBe(0);
    await assignReviewer({ evidenceId: ev, assignedToUserId: A.memberUserId, actorUserId: A.adminUserId });
    expect((await workflowOf(ev)).assignedToUserId).toBe(A.memberUserId);
    expect(await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId: before.id, eventType: "ASSIGNED" } })).toBe(1);
  });

  it("Start is conditional: a Close that commits after Start read the review is never undone", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "fifth-start-close");
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    expect((await claim(A.memberToken, ev, A.teamId)).status).toBe(200);
    const wf = await workflowOf(ev);
    const { startReview } = await import("../src/services/reviewer-ops/reviewer-operations-engine.service.js");
    // Start reads the review, then a Close commits from another connection before Start writes.
    let interleaved = false;
    const client = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return async (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => {
          if (!interleaved) {
            interleaved = true;
            await prisma.evidenceReviewWorkflow.update({ where: { id: wf.id }, data: { status: "CLOSED", closedAt: new Date() } });
          }
          return (target as typeof prisma).$transaction(fn as never, opts as never);
        };
      },
    });
    await expect(
      startReview({ teamId: A.teamId, actorUserId: A.memberUserId, isReviewerCapable: true, isServiceAccount: false } as never, { workflowId: wf.id }, client as never),
    ).rejects.toMatchObject({ code: "REVIEW_INVALID_TRANSITION" });
    expect(interleaved).toBe(true);
    expect((await workflowOf(ev)).status).toBe("CLOSED");
  });
});

describe("sixth audit — refused assignments are 409s, bulk priority is audited, claims race deterministically", () => {
  const engineCtx = (actorUserId: string) =>
    ({ teamId: A.teamId, actorUserId, isReviewerCapable: true, isServiceAccount: false }) as never;
  /** A client whose FIRST transaction is preceded by a concurrent commit. */
  const interleaving = (before: () => Promise<unknown>) => {
    let done = false;
    const client = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return async (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => {
          if (!done) {
            done = true;
            await before();
          }
          return (target as typeof prisma).$transaction(fn as never, opts as never);
        };
      },
    });
    return { client, fired: () => done };
  };

  it("reviewer-ops assign refused by a concurrent claim is the engine's 409 refusal, never an unmapped error (P2-A)", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "sixth-assign-refused");
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    const wf = await workflowOf(ev);
    const { assignReviewerToWorkflow, ReviewerOpsError } = await import("../src/services/reviewer-ops/reviewer-operations-engine.service.js");
    const { client, fired } = interleaving(() =>
      prisma.evidenceReviewWorkflow.update({ where: { id: wf.id }, data: { assignedToUserId: A.memberUserId, status: "ASSIGNED" } }),
    );
    const err = await assignReviewerToWorkflow(engineCtx(A.adminUserId), { workflowId: wf.id, assignedToUserId: A.adminUserId }, client as never).then(
      () => null,
      (e: unknown) => e,
    );
    expect(fired()).toBe(true);
    expect(err).toBeInstanceOf(ReviewerOpsError);
    expect(err).toMatchObject({ code: "REVIEW_INVALID_TRANSITION" });
    // The concurrent claim stands; the refused assignment wrote nothing.
    expect((await workflowOf(ev)).assignedToUserId).toBe(A.memberUserId);
    expect(await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId: wf.id, eventType: { in: ["ASSIGNED", "REASSIGNED"] } } })).toBe(0);
  });

  it("of two claims on an unassigned review already in progress, exactly one wins; the loser is refused (P3)", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "sixth-claim-race");
    await patchWorkflow(A.adminToken, ev, { status: "IN_REVIEW" });
    const wf = await workflowOf(ev);
    expect(wf.assignedToUserId).toBeNull();
    const { claimReviewerWorkflow } = await import("../src/services/review-operations/review-operations.service.js");
    // The admin's claim commits after the member's claim read the review.
    const { client } = interleaving(() =>
      prisma.evidenceReviewWorkflow.update({ where: { id: wf.id }, data: { assignedToUserId: A.adminUserId } }),
    );
    await expect(claimReviewerWorkflow({ evidenceId: ev, actorUserId: A.memberUserId }, client as never)).rejects.toMatchObject({
      code: "invalid_stage_transition",
    });
    expect((await workflowOf(ev)).assignedToUserId).toBe(A.adminUserId);
    expect(await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId: wf.id, eventType: "CLAIMED" } })).toBe(0);
  });

  it("bulk-triage priority: one PRIORITY_CHANGED event and one review.priority.changed audit per changed row; an unchanged row writes nothing (P2-B)", async () => {
    await setPlan(A, "TEAM");
    const ev = await freshEvidence(A, "sixth-bulk-priority");
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    const wf = await workflowOf(ev);
    const { executeBulkTriage } = await import("../src/services/reviewer-ops/bulk-triage.service.js");
    const run = (action: string) =>
      executeBulkTriage(
        { teamId: A.teamId, actorUserId: A.adminUserId, isReviewerCapable: true, isServiceAccount: false } as never,
        { teamId: A.teamId, workflowIds: [wf.id], action, note: "bulk priority" } as never,
      );
    const custodyBefore = await allCustody(ev);
    expect(JSON.stringify(await run("PRIORITY_URGENT"))).not.toMatch(/"ok":false/);
    expect(String((await workflowOf(ev)).priority)).toBe("URGENT");
    expect(await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId: wf.id, eventType: "PRIORITY_CHANGED", nextValue: { path: ["priority"], equals: "URGENT" } } })).toBe(1);
    expect(await reviewAudits(ev, "review.priority.changed")).toBe(1);
    // Repeating it changes nothing and records nothing.
    await run("PRIORITY_URGENT");
    expect(await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId: wf.id, eventType: "PRIORITY_CHANGED", nextValue: { path: ["priority"], equals: "URGENT" } } })).toBe(1);
    expect(await reviewAudits(ev, "review.priority.changed")).toBe(1);
    expect(await allCustody(ev)).toBe(custodyBefore);
  });

  it("a legacy verdict that moved back into review before it was closed no longer stands (P3)", async () => {
    const { loadCurrentReviewDecisions } = await import("../src/services/evidence-review/review-outcome.service.js");
    const ev = await freshEvidence(A, "sixth-legacy-back-to-review");
    await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    const wf = await workflowOf(ev);
    const t0 = Date.now() + 60_000;
    const steps = [["STATUS_CHANGED", "APPROVED_INTERNAL"], ["STATUS_CHANGED", "IN_REVIEW"], ["ASSIGNED", null], ["CLOSED", "CLOSED"]] as const;
    for (const [i, [eventType, to]] of steps.entries()) {
      await prisma.evidenceReviewWorkflowEvent.create({
        data: {
          workflowId: wf.id,
          evidenceId: ev,
          actorUserId: A.adminUserId,
          eventType,
          nextValue: to ? { status: to } : { assignedToUserId: A.memberUserId },
          createdAt: new Date(t0 + 1000 * (i + 1)),
        },
      });
    }
    const ref = { id: wf.id, teamId: wf.teamId, evidenceId: ev, status: "CLOSED", decisionRound: 0 };
    expect((await loadCurrentReviewDecisions([ref])).get(wf.id)).toBe("NO_DECISION");
    // A never-decided open review reads no decision without scanning history.
    expect((await loadCurrentReviewDecisions([{ ...ref, status: "IN_REVIEW" }])).get(wf.id)).toBe("NO_DECISION");
  });
});
