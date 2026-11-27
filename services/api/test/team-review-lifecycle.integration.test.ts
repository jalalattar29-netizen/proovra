/**
 * TEAM-SPEC (2026-11-23) — the Team review lifecycle against a real PostgreSQL
 * and the real routes.
 *
 * Subject: a TEAM-plan Personal Workspace (owner + invited ADMIN / MEMBER /
 * MEMBER / VIEWER), plus an ENTERPRISE organization for compatibility.
 *
 *   R3  decision authority — FIRST (and request-info) by the assignee only,
 *       review.assign confers nothing; SECOND by the reassigned, independent
 *       reviewer; ADJUDICATION only through the explicit decisions door by an
 *       independent OWNER/ADMIN; Approve in a conflict → use_adjudication.
 *   §2.3 outcome — FIRST-only approve reports stageRecorded FIRST,
 *       statusChanged false and persists NO reviewer_review_approved event.
 *   §2.4 NEEDS_INFORMATION exit (response-received).
 *   §2.5 viewer actions.  §2.6 reassignment independence.
 *   §2.2 CLOSE refused while the round awaits SECOND / adjudication.
 *   §2.7 ACTIVE escalations + total.  §2.12 reconcile skips non-entitled.
 *   Concurrency: a reassignment racing the old assignee's decision.
 *
 * Every assertion that matters reads the persisted rows (workflow, decision
 * log, workflow events, tenant audit, security events), not only HTTP.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REVIEWER_OPS_CRON_HEADER } from "@proovra/shared";

import { bootIntegrationHarness, type IntegrationHarness, type TeamFixture } from "./integration-harness.js";
import { placeInCollaborationTeam } from "./support/place-in-collaboration-team.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let requiredLegalVersions: Record<string, unknown>;
let runReconcile: typeof import("../src/services/reviewer-ops/reviewer-operations-engine.service.js")["runReconcile"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route bodies are asserted field by field
type Res = { status: number; body: any; raw: string };

type Actor = { userId: string; token: string };
type TeamWs = {
  teamId: string;
  owner: Actor;
  admin: Actor;
  member: Actor;
  member2: Actor;
  viewer: Actor;
};

let T: TeamWs; // TEAM-plan Personal Workspace
let E: TeamFixture; // ENTERPRISE organization
let B: TeamFixture; // another workspace

async function call(
  token: string,
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  const res = await harness.app.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    payload: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  let body: unknown = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, raw: res.body };
}

let seq = 0;
async function newUser(label: string): Promise<Actor> {
  seq += 1;
  const email = `trl-${label}-${Date.now()}-${seq}@test.proovra.local`;
  const user = await prisma.user.create({
    data: { email, firstName: "TRL", lastName: label, provider: "EMAIL", providerUserId: email },
    select: { id: true },
  });
  await prisma.userLegalAcceptance.createMany({
    data: Object.entries(requiredLegalVersions).map(([policyKey, policyVersion]) => ({
      userId: user.id,
      policyKey,
      policyVersion: policyVersion as string,
      source: "integration-harness",
    })),
  });
  return { userId: user.id, token: await harness.mintSessionToken(user.id, email) };
}

async function freshWorkflow(teamId: string, ownerUserId: string, title: string) {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: { title, type: "PHOTO", status: "CREATED", teamId, organizationId: t.organizationId, ownerUserId },
      select: { id: true },
    })
  ).id;
  const workflowId = (
    await prisma.evidenceReviewWorkflow.create({
      data: { evidenceId, teamId, status: "NOT_STARTED", workspaceType: "TEAM" },
      select: { id: true },
    })
  ).id;
  return { evidenceId, workflowId };
}

const wfRow = (id: string) => prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id } });
const decisionRows = (workflowId: string) =>
  prisma.workflowReviewDecision.findMany({ where: { workflowId }, orderBy: { decidedAt: "asc" } });
const securityEvents = (eventType: string, workflowId: string) =>
  prisma.securityEvent.findMany({
    where: { eventType, details: { path: ["workflowId"], equals: workflowId } },
  });

/** safeEmitSecurityEvent is fire-and-forget: wait until the row lands. */
async function waitForSecurityEvents(eventType: string, workflowId: string, atLeast: number) {
  for (let i = 0; i < 40; i += 1) {
    const rows = await securityEvents(eventType, workflowId);
    if (rows.length >= atLeast) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return securityEvents(eventType, workflowId);
}

const ops = (ws: { teamId: string }) => ({
  assign: (a: Actor, workflowId: string, to: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/assign`, { teamId: ws.teamId, assignedToUserId: to }),
  reassign: (a: Actor, workflowId: string, to: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/reassign`, { teamId: ws.teamId, newAssigneeUserId: to }),
  start: (a: Actor, workflowId: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/start`, { teamId: ws.teamId }),
  pause: (a: Actor, workflowId: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/pause`, { teamId: ws.teamId, pausedReason: "waiting on counsel" }),
  resume: (a: Actor, workflowId: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/resume`, { teamId: ws.teamId }),
  requestInfo: (a: Actor, workflowId: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/request-info`, { teamId: ws.teamId, note: "need the original file" }),
  responseReceived: (a: Actor, workflowId: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/response-received`, { teamId: ws.teamId, note: "file arrived" }),
  approve: (a: Actor, workflowId: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/approve`, { teamId: ws.teamId, note: "Looks complete" }),
  reject: (a: Actor, workflowId: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/reject`, { teamId: ws.teamId, note: "custody gap" }),
  decide: (a: Actor, workflowId: string, decision: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/workspace/${workflowId}/decisions`, {
      teamId: ws.teamId,
      decision,
      rationale: `rationale for ${decision}`,
    }),
  close: (a: Actor, evidenceId: string) =>
    call(a.token, "POST", `/v1/review-operations/evidence/${evidenceId}/decision`, { decision: "CLOSE", note: "done" }),
  workspace: (a: Actor, workflowId: string) =>
    call(a.token, "GET", `/v1/reviewer-ops/workspace/${workflowId}?teamId=${ws.teamId}`),
});

function action(res: Res, name: string): { allowed: boolean; reason?: string } {
  const found = (res.body.viewer.actions as Array<{ action: string; allowed: boolean; reason?: string }>).find(
    (a) => a.action === name,
  );
  if (!found) throw new Error(`no viewer action ${name}`);
  return found;
}

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ REQUIRED_LEGAL_VERSIONS: requiredLegalVersions } = await import("../src/legal/legal-versioning.js"));
  ({ runReconcile } = await import("../src/services/reviewer-ops/reviewer-operations-engine.service.js"));
  E = harness.fixtures.teamA;
  B = harness.fixtures.teamB;

  // The TEAM-plan Personal Workspace: the owner's plan is TEAM; members are
  // invited into the SAME workspace (TEAM-SPEC §0, R1).
  const { ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js");
  const owner = await newUser("owner");
  const space = await ensurePersonalWorkspace({ userId: owner.userId });
  const updated = await prisma.entitlement.updateMany({ where: { userId: owner.userId }, data: { plan: "TEAM", active: true } });
  if (updated.count === 0) await prisma.entitlement.create({ data: { userId: owner.userId, plan: "TEAM" } });
  const admin = await newUser("admin");
  const member = await newUser("member");
  const member2 = await newUser("member2");
  const viewer = await newUser("viewer");
  for (const [u, role] of [
    [admin, "ADMIN"],
    [member, "MEMBER"],
    [member2, "MEMBER"],
    [viewer, "VIEWER"],
  ] as const) {
    await prisma.teamMember.create({ data: { teamId: space.teamId, userId: u.userId, role, status: "ACTIVE" } });
  }
  await placeInCollaborationTeam(prisma, {
    workspaceId: space.teamId,
    createdByUserId: owner.userId,
    userIds: [admin.userId, member.userId, member2.userId, viewer.userId],
  });
  T = { teamId: space.teamId, owner, admin, member, member2, viewer };

  await prisma.team.update({ where: { id: E.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
  await placeInCollaborationTeam(prisma, {
    workspaceId: E.teamId,
    createdByUserId: E.ownerUserId,
    userIds: [E.adminUserId, E.memberUserId, E.viewerUserId],
  });
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe("TEAM personal workspace — assignment → start → request info → response received → decision", () => {
  it("only the assignee decides; review.assign confers nothing; the NEEDS_INFORMATION exit works", async () => {
    const o = ops(T);
    const { workflowId } = await freshWorkflow(T.teamId, T.owner.userId, "trl-lifecycle");

    expect((await o.assign(T.owner, workflowId, T.member.userId)).status).toBe(200);
    const memberView = await o.workspace(T.member, workflowId);
    expect(memberView.status, memberView.raw).toBe(200);
    expect(memberView.body.viewer).toMatchObject({ userId: T.member.userId, isAssignee: true });
    expect(action(memberView, "start").allowed).toBe(true);
    expect(memberView.body.allowedLifecycleTransitions).toBeDefined();

    // Start is the assignee's.
    expect((await o.start(T.owner, workflowId)).body.error.details.reason).toBe("actor_not_assignee");
    expect((await o.start(T.member, workflowId)).status).toBe(200);

    // FIRST decision by a non-assignee is refused — the OWNER holds review.assign.
    const ownerView = await o.workspace(T.owner, workflowId);
    expect(ownerView.body.viewer.isAssignee).toBe(false);
    expect(action(ownerView, "approve")).toEqual({ action: "approve", allowed: false, reason: "not_assignee" });
    expect(action(ownerView, "reassign").allowed).toBe(true);
    for (const [label, res] of [
      ["owner approve", await o.approve(T.owner, workflowId)],
      ["admin request-info", await o.requestInfo(T.admin, workflowId)],
      ["member2 reject", await o.reject(T.member2, workflowId)],
    ] as const) {
      expect(res.status, label).toBe(403);
      expect(res.body.error.code, label).toBe("REVIEW_PERMISSION_DENIED");
      expect(res.body.error.details.reason, label).toBe("not_assignee");
    }
    const viaDecisions = await o.decide(T.owner, workflowId, "APPROVE");
    expect(viaDecisions.status).toBe(403);
    expect(viaDecisions.body.error.code).toBe("not_assignee");
    expect(viaDecisions.body.error.details.reason).toBe("not_assignee");
    // A viewer has no decision permission at all.
    expect((await o.approve(T.viewer, workflowId)).status).toBe(403);
    expect(await decisionRows(workflowId)).toHaveLength(0);

    // Pause / resume — the assignee's clock; a viewer is refused.
    expect((await o.pause(T.viewer, workflowId)).status).toBe(403);
    expect((await o.pause(T.member, workflowId)).status).toBe(200);
    expect((await wfRow(workflowId)).slaPausedAtUtc).not.toBeNull();
    expect(action(await o.workspace(T.member, workflowId), "resume").allowed).toBe(true);
    expect((await o.resume(T.member, workflowId)).status).toBe(200);
    expect((await wfRow(workflowId)).slaPausedAtUtc).toBeNull();

    // Request info — a workflow action (review remediation F-04): no decision
    // slot, status moved, the review now waits for information.
    const asked = await o.requestInfo(T.member, workflowId);
    expect(asked.status, asked.raw).toBe(200);
    expect(asked.body.outcome).toEqual({
      stageRecorded: "NONE",
      statusChanged: true,
      reviewState: "first_required",
      nextRequirement: "information",
      idempotent: false,
    });
    expect(await decisionRows(workflowId)).toHaveLength(0);
    expect((await wfRow(workflowId)).status).toBe("NEEDS_INFO");
    expect(await waitForSecurityEvents("reviewer_information_requested", workflowId, 1)).toHaveLength(1);

    // Approve from NEEDS_INFORMATION is refused with a clear reason.
    const early = await o.approve(T.member, workflowId);
    expect(early.status).toBe(409);
    expect(early.body.error.details.reason).toBe("decision_not_from_stage");
    const waiting = await o.workspace(T.member, workflowId);
    expect(action(waiting, "approve")).toMatchObject({ allowed: false, reason: "decision_not_from_stage" });
    expect(action(waiting, "record_response").allowed).toBe(true);
    expect(action(await o.workspace(T.admin, workflowId), "record_response")).toMatchObject({ allowed: false, reason: "not_assignee" });

    // The exit: assignee only, status CAS, event + audit.
    const auditBefore = await prisma.adminAuditLog.count({ where: { resourceId: workflowId } });
    const notMine = await o.responseReceived(T.admin, workflowId);
    expect(notMine.status).toBe(403);
    expect(notMine.body.error.details.reason).toBe("not_assignee");
    const received = await o.responseReceived(T.member, workflowId);
    expect(received.status, received.raw).toBe(200);
    expect((await wfRow(workflowId)).status).toBe("RESPONSE_RECEIVED");
    expect(
      await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId, eventType: "RESPONSE_RECEIVED", actorUserId: T.member.userId } }),
    ).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { resourceId: workflowId } })).toBeGreaterThan(auditBefore);
    const again = await o.responseReceived(T.member, workflowId);
    expect(again.status).toBe(409);
    expect(again.body.error.details.reason).toBe("not_awaiting_information");

    // The decision — terminal, so approved + completed fire.
    const approved = await o.approve(T.member, workflowId);
    expect(approved.status, approved.raw).toBe(200);
    expect(approved.body.outcome).toMatchObject({ stageRecorded: "FIRST", statusChanged: true, reviewState: "resolved", nextRequirement: null });
    expect((await wfRow(workflowId)).status).toBe("APPROVED_INTERNAL");
    const log = await decisionRows(workflowId);
    expect(log.map((d) => [d.round, d.stage, d.decision, d.reviewerUserId])).toEqual([
      [0, "FIRST", "APPROVE", T.member.userId],
    ]);
    expect(await waitForSecurityEvents("reviewer_review_approved", workflowId, 1)).toHaveLength(1);
  });
});

describe("TEAM personal workspace — second review, reassignment, conflict and adjudication", () => {
  it("FIRST-only approve emits no approval; SECOND needs reassignment; conflict needs adjudication by an independent admin", async () => {
    const o = ops(T);
    const { evidenceId, workflowId } = await freshWorkflow(T.teamId, T.owner.userId, "trl-second-review");
    // An ACTIVE legal hold requires a second review.
    await prisma.evidenceLegalHold.create({
      data: { scope: "EVIDENCE", evidenceId, teamId: T.teamId, status: "ACTIVE", title: "Hold", placedByUserId: T.owner.userId } as never,
    });
    expect((await o.assign(T.admin, workflowId, T.member.userId)).status).toBe(200);
    expect((await o.start(T.member, workflowId)).status).toBe(200);

    const first = await o.approve(T.member, workflowId);
    expect(first.status, first.raw).toBe(200);
    expect(first.body.outcome).toMatchObject({
      stageRecorded: "FIRST",
      statusChanged: false,
      reviewState: "second_required",
      nextRequirement: "second_review",
      idempotent: false,
    });
    expect((await wfRow(workflowId)).status).toBe("IN_REVIEW");
    // The first-decision signal is written (tenant audit, synchronously).
    expect(
      await prisma.adminAuditLog.count({ where: { resourceId: workflowId, action: "reviewer.first_decision_recorded" } }),
    ).toBe(1);

    // Idempotent replay: reported as such, emits nothing new.
    const replay = await o.approve(T.member, workflowId);
    expect(replay.status).toBe(200);
    expect(replay.body.outcome).toMatchObject({ idempotent: true, statusChanged: false, stageRecorded: "FIRST" });
    expect(
      await prisma.adminAuditLog.count({ where: { resourceId: workflowId, action: "reviewer.first_decision_recorded" } }),
    ).toBe(1);

    // The first reviewer cannot also be the second; a non-assignee cannot be it.
    const self = await o.reject(T.member, workflowId);
    expect(self.status).toBe(409);
    expect(self.body.error.details.reason).toBe("same_reviewer_blocked");
    const notAssigned = await o.approve(T.admin, workflowId);
    expect(notAssigned.status).toBe(403);
    expect(notAssigned.body.error.details.reason).toBe("second_stage_needs_reassignment");
    expect(action(await o.workspace(T.admin, workflowId), "approve").reason).toBe("second_stage_needs_reassignment");

    // CLOSE cannot skip the pending second review.
    const close = await o.close(T.member, evidenceId);
    expect(close.status, close.raw).toBe(409);
    expect(close.body.error.code).toBe("second_review_pending");
    expect(close.body.error.details.reason).toBe("second_review_pending");
    expect(action(await o.workspace(T.member, workflowId), "archive").reason).toBe("second_review_pending");
    expect((await wfRow(workflowId)).status).toBe("IN_REVIEW");

    // Reassignment back to the first reviewer is refused; to another works.
    const back = await o.reassign(T.admin, workflowId, T.member.userId);
    expect(back.status, back.raw).toBe(422);
    expect(back.body.error.details.reason).toBe("second_reviewer_not_independent");
    expect((await wfRow(workflowId)).assignedToUserId).toBe(T.member.userId);
    expect((await o.reassign(T.admin, workflowId, T.owner.userId)).status).toBe(200);
    expect(action(await o.workspace(T.owner, workflowId), "reject").allowed).toBe(true);
    expect(action(await o.workspace(T.member, workflowId), "approve").reason).toBe("same_reviewer_blocked");

    // SECOND disagrees → conflict (ESCALATED), not terminal: no rejection event.
    const second = await o.reject(T.owner, workflowId);
    expect(second.status, second.raw).toBe(200);
    expect(second.body.outcome).toEqual({
      stageRecorded: "SECOND",
      statusChanged: true,
      reviewState: "conflict_detected",
      nextRequirement: "adjudication",
      idempotent: false,
    });
    expect((await wfRow(workflowId)).status).toBe("ESCALATED");
    expect((await o.close(T.owner, evidenceId)).body.error.code).toBe("second_review_pending");

    // Approve / Reject cannot adjudicate — not even for an OWNER or an
    // independent ADMIN.
    for (const actor of [T.owner, T.admin]) {
      const res = await o.approve(actor, workflowId);
      expect(res.status, res.raw).toBe(409);
      expect(res.body.error.details.reason).toBe("use_adjudication");
    }
    expect(action(await o.workspace(T.admin, workflowId), "adjudicate").allowed).toBe(true);
    expect(action(await o.workspace(T.owner, workflowId), "adjudicate").reason).toBe("adjudicator_not_independent");
    expect(action(await o.workspace(T.member2, workflowId), "adjudicate").reason).toBe("adjudicator_role_required");

    // Adjudication door: a participant is refused, an independent ADMIN resolves.
    const participant = await o.decide(T.owner, workflowId, "UPHOLD_SECOND");
    expect(participant.status).toBe(409);
    expect(participant.body.error.code).toBe("adjudicator_not_independent");
    expect(participant.body.error.details.reason).toBe("adjudicator_not_independent");
    const notAdmin = await o.decide(T.member2, workflowId, "UPHOLD_FIRST");
    expect(notAdmin.status).toBe(403);
    expect(notAdmin.body.error.details.reason).toBe("adjudicator_role_required");
    const adjudicated = await o.decide(T.admin, workflowId, "UPHOLD_FIRST");
    expect(adjudicated.status, adjudicated.raw).toBe(201);
    expect(adjudicated.body.outcome).toEqual({
      stageRecorded: "ADJUDICATION",
      statusChanged: true,
      reviewState: "resolved",
      nextRequirement: null,
      idempotent: false,
    });
    expect((await wfRow(workflowId)).status).toBe("APPROVED_INTERNAL");
    expect((await decisionRows(workflowId)).map((d) => [d.stage, d.decision, d.reviewerUserId])).toEqual([
      ["FIRST", "APPROVE", T.member.userId],
      ["SECOND", "REJECT", T.owner.userId],
      ["ADJUDICATION", "UPHOLD_FIRST", T.admin.userId],
    ]);

    // Exactly ONE approval event — the adjudication's. The FIRST-only approve
    // and its replay persisted none; the conflict persisted no rejection.
    const approvals = await waitForSecurityEvents("reviewer_review_approved", workflowId, 1);
    expect(approvals).toHaveLength(1);
    expect((approvals[0]!.details as { stageRecorded?: string }).stageRecorded).toBe("ADJUDICATION");
    expect(await securityEvents("reviewer_review_rejected", workflowId)).toHaveLength(0);
  });
});

describe("concurrency — a reassignment racing the old assignee's decision", () => {
  it("leaves exactly one consistent outcome", async () => {
    const o = ops(T);
    for (let i = 0; i < 3; i += 1) {
      const { workflowId } = await freshWorkflow(T.teamId, T.owner.userId, `trl-race-${i}`);
      expect((await o.assign(T.admin, workflowId, T.member.userId)).status).toBe(200);
      expect((await o.start(T.member, workflowId)).status).toBe(200);
      const [reassigned, approved] = await Promise.all([
        o.reassign(T.admin, workflowId, T.member2.userId),
        o.approve(T.member, workflowId),
      ]);
      await harness.handlersSettled();
      const row = await wfRow(workflowId);
      const log = await decisionRows(workflowId);
      const okReassign = reassigned.status === 200;
      const okApprove = approved.status === 200;
      expect(okReassign !== okApprove, `race ${i}: reassign ${reassigned.status} approve ${approved.status}`).toBe(true);
      if (okApprove) {
        expect(log.map((d) => d.reviewerUserId)).toEqual([T.member.userId]);
        expect(row.status).toBe("APPROVED_INTERNAL");
        expect(row.assignedToUserId).toBe(T.member.userId);
      } else {
        expect(log).toHaveLength(0);
        expect(row.assignedToUserId).toBe(T.member2.userId);
        expect([403, 409]).toContain(approved.status);
        expect(["not_assignee", "stale_decision"]).toContain(approved.body.error.details.reason);
      }
    }
  });
});

describe("membership and isolation", () => {
  it("a removed member is refused; another workspace's actor reads 404", async () => {
    const o = ops(T);
    const leaver = await newUser("leaver");
    await prisma.teamMember.create({ data: { teamId: T.teamId, userId: leaver.userId, role: "MEMBER", status: "ACTIVE" } });
    await placeInCollaborationTeam(prisma, { workspaceId: T.teamId, createdByUserId: T.owner.userId, userIds: [leaver.userId] });
    const { workflowId } = await freshWorkflow(T.teamId, T.owner.userId, "trl-removed");
    expect((await o.assign(T.admin, workflowId, leaver.userId)).status).toBe(200);
    expect((await o.start(leaver, workflowId)).status).toBe(200);
    await prisma.teamMember.updateMany({ where: { teamId: T.teamId, userId: leaver.userId }, data: { status: "REVOKED" } });
    const refused = await o.approve(leaver, workflowId);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("REVIEW_ACTOR_BLOCKED");
    expect(await decisionRows(workflowId)).toHaveLength(0);

    const foreignRead = await call(B.ownerToken, "GET", `/v1/reviewer-ops/workspace/${workflowId}?teamId=${T.teamId}`);
    expect(foreignRead.status).toBe(404);
    const foreignApprove = await call(B.ownerToken, "POST", `/v1/reviewer-ops/reviews/${workflowId}/approve`, { teamId: T.teamId });
    expect(foreignApprove.status).toBe(404);
    // Its own (entitled) workspace id does not reach this workflow either.
    await prisma.team.update({ where: { id: B.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
    const crossed = await call(B.ownerToken, "POST", `/v1/reviewer-ops/reviews/${workflowId}/approve`, { teamId: B.teamId });
    expect(crossed.status).toBe(404);
    expect(await decisionRows(workflowId)).toHaveLength(0);
  });
});

describe("escalations — ACTIVE = OPEN ∪ ACKNOWLEDGED ∪ REASSIGNED, with total", () => {
  it("lists an ACKNOWLEDGED escalation under ACTIVE, counts total under the same filters, reports dedup", async () => {
    const one = await freshWorkflow(T.teamId, T.owner.userId, "trl-esc-1");
    const two = await freshWorkflow(T.teamId, T.owner.userId, "trl-esc-2");
    const raise = (workflowId: string) =>
      call(T.admin.token, "POST", "/v1/reviewer-ops/escalations", {
        teamId: T.teamId,
        workflowId,
        reason: "REVIEW_OVERDUE",
        severity: "HIGH",
        safeSummary: "needs a supervisor",
      });
    const a = await raise(one.workflowId);
    expect(a.status, a.raw).toBe(201);
    expect(a.body.created).toBe(true);
    const dup = await raise(one.workflowId);
    expect(dup.status).toBe(200);
    expect(dup.body.created).toBe(false);
    const b = await raise(two.workflowId);
    expect(b.status).toBe(201);
    const ack = await call(T.admin.token, "POST", `/v1/reviewer-ops/escalations/${b.body.escalation.id}/acknowledge`, { teamId: T.teamId });
    expect(ack.status, ack.raw).toBe(200);
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: b.body.escalation.id } })).status).toBe("ACKNOWLEDGED");

    const list = (q: string) => call(T.admin.token, "GET", `/v1/reviewer-ops/escalations?teamId=${T.teamId}${q}`);
    const open = await list("&status=OPEN");
    expect(open.status, open.raw).toBe(200);
    expect(open.body.total).toBe(1);
    const active = await list("&status=ACTIVE");
    expect(active.body.total).toBe(2);
    expect(new Set(active.body.escalations.map((e: { status: string }) => e.status))).toEqual(new Set(["OPEN", "ACKNOWLEDGED"]));
    const page = await list("&status=ACTIVE&limit=1");
    expect(page.body.escalations).toHaveLength(1);
    expect(page.body.total).toBe(2);
    const all = await list("&status=ALL");
    expect(all.body.total).toBe(await prisma.reviewEscalation.count({ where: { teamId: T.teamId } }));

    const consoleRes = await call(T.admin.token, "GET", `/v1/reviewer-ops/console?teamId=${T.teamId}`);
    expect(consoleRes.status, consoleRes.raw.slice(0, 300)).toBe(200);
    expect(consoleRes.body.escalations.count).toBe(2);
    expect(consoleRes.body.escalations.rows.map((e: { status: string }) => e.status)).toContain("ACKNOWLEDGED");
  });
});

describe("ENTERPRISE organization — compatibility", () => {
  it("the same assignee authority, outcome and viewer actions", async () => {
    const o = ops(E);
    const owner = { userId: E.ownerUserId, token: E.ownerToken };
    const admin = { userId: E.adminUserId, token: E.adminToken };
    const member = { userId: E.memberUserId, token: E.memberToken };
    const { workflowId } = await freshWorkflow(E.teamId, E.ownerUserId, "trl-enterprise");
    expect((await o.assign(admin, workflowId, member.userId)).status).toBe(200);
    expect((await o.start(member, workflowId)).status).toBe(200);
    const ownerTry = await o.approve(owner, workflowId);
    expect(ownerTry.status).toBe(403);
    expect(ownerTry.body.error.details.reason).toBe("not_assignee");
    const view = await o.workspace(member, workflowId);
    expect(view.body.viewer.isAssignee).toBe(true);
    expect(action(view, "approve").allowed).toBe(true);
    const done = await o.approve(member, workflowId);
    expect(done.status, done.raw).toBe(200);
    expect(done.body.outcome).toMatchObject({ stageRecorded: "FIRST", statusChanged: true, reviewState: "resolved" });
    expect((await wfRow(workflowId)).status).toBe("APPROVED_INTERNAL");
    expect(await waitForSecurityEvents("reviewer_review_approved", workflowId, 1)).toHaveLength(1);
  });
});

describe("SLA policy and reconcile entitlement", () => {
  it("SLA policy PUT is not refused for an R1-eligible PERSONAL workspace on plan or kind", async () => {
    const res = await call(T.owner.token, "POST", "/v1/reviewer-ops/sla-policy", {
      teamId: T.teamId,
      flags: { reviewerInactivityHours: 48 },
    });
    // The owner holds governance.policy.manage; what remains is the step-up
    // ceremony (or success) — never an entitlement / kind refusal.
    expect(JSON.stringify(res.body)).not.toContain("ENTITLEMENT_REQUIRED");
    expect(JSON.stringify(res.body)).not.toContain("governance_policy_manage_required");
    expect(JSON.stringify(res.body)).not.toContain("WORKSPACE_NOT_FOUND");
    expect(res.status).toBeLessThan(500);
    // A member without the governance permission is refused by role, not plan.
    const member = await call(T.member.token, "POST", "/v1/reviewer-ops/sla-policy", { teamId: T.teamId, flags: {} });
    expect(member.status).toBe(403);
    expect(member.body.error.reason).toBe("governance_policy_manage_required");
  });

  it("reconcile skips a PRO workspace (nothing escalated, nothing deleted) and runs for TEAM", async () => {
    const P = harness.fixtures.personal;
    await prisma.entitlement.updateMany({ where: { userId: P.userId }, data: { plan: "PRO" } });
    const { workflowId } = await freshWorkflow(P.teamId, P.userId, "trl-pro-overdue");
    await prisma.evidenceReviewWorkflow.update({
      where: { id: workflowId },
      data: { escalationDueAtUtc: new Date(Date.now() - 3_600_000), dueAt: new Date(Date.now() - 3_600_000) },
    });
    const before = await prisma.evidenceReviewWorkflow.count({ where: { teamId: P.teamId } });
    const skipped = await runReconcile({ teamId: P.teamId }, prisma);
    expect(skipped.skippedReason).toBe("reviewer_operations_not_included");
    expect(skipped.escalationsCreated).toBe(0);
    expect(await prisma.reviewEscalation.count({ where: { workflowId } })).toBe(0);
    expect(await prisma.evidenceReviewWorkflow.count({ where: { teamId: P.teamId } })).toBe(before);

    // The worker's route path skips it too.
    process.env.REVIEWER_OPS_CRON_SECRET = "team-review-lifecycle-cron-secret-0123";
    const viaRoute = await call("", "POST", "/v1/reviewer-ops/reconcile", { teamId: P.teamId }, {
      [REVIEWER_OPS_CRON_HEADER]: process.env.REVIEWER_OPS_CRON_SECRET,
    });
    expect(viaRoute.status, viaRoute.raw).toBe(200);
    expect(viaRoute.body.perTeam[0].skippedReason).toBe("reviewer_operations_not_included");
    expect(await prisma.reviewEscalation.count({ where: { workflowId } })).toBe(0);

    const team = await runReconcile({ teamId: T.teamId }, prisma);
    expect(team.skippedReason).toBeUndefined();
  });
});

describe("the decisions door — the inspector's single verdict entry (TEAM-UI-SPEC §2)", () => {
  it("screens the rationale for public-authenticity overclaims like the approve door, and writes nothing", async () => {
    const o = ops(T);
    const { workflowId } = await freshWorkflow(T.teamId, T.owner.userId, "trl-overclaim");
    expect((await o.assign(T.owner, workflowId, T.member.userId)).status).toBe(200);
    expect((await o.start(T.member, workflowId)).status).toBe(200);
    const refused = await call(T.member.token, "POST", `/v1/reviewer-ops/workspace/${workflowId}/decisions`, {
      teamId: T.teamId,
      decision: "APPROVE",
      rationale: "This record is legally admissible and tamper-proof.",
    });
    expect(refused.status, refused.raw).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "REVIEW_PERMISSION_DENIED", details: { reason: "forbidden_wording" } });
    expect(await prisma.workflowReviewDecision.count({ where: { workflowId } })).toBe(0);
    // The same assignee, with ordinary wording, is served through the same door.
    const ok = await o.decide(T.member, workflowId, "APPROVE");
    expect(ok.status, ok.raw).toBeLessThan(300);
    expect(ok.body.outcome).toMatchObject({ stageRecorded: "FIRST" });
  });
});

// =============================================================================
// Round 2 (2026-11-25) — viewer-action divergences #2, #3, #4: the Review page
// offers exactly the moves the server accepts. Both read the canonical stage
// rules in @proovra/shared (verdictStageRefusal / stageMoveRefusal) over the
// PERSISTED stage; each case below reads the offer, then tries the real door.
// =============================================================================

describe("round 2 — the Review page offers exactly the moves the server accepts", () => {
  async function at(status: string, extra: Record<string, unknown> = {}) {
    const w = await freshWorkflow(T.teamId, T.owner.userId, `r2-${status.toLowerCase()}`);
    await prisma.evidenceReviewWorkflow.update({
      where: { id: w.workflowId },
      data: { status: status as never, assignedToUserId: T.member.userId, assignedAtUtc: new Date(), ...extra },
    });
    return w;
  }
  const o = () => ops(T);

  it("#2 a reopened review: Approve, Reject and Archive are not offered and are refused; Start is, then Approve works", async () => {
    const w = await at("REOPENED");
    const before = await o().workspace(T.member, w.workflowId);
    expect(before.status, before.raw).toBe(200);
    expect(action(before, "approve")).toMatchObject({ allowed: false, reason: "decision_not_from_stage" });
    expect(action(before, "reject")).toMatchObject({ allowed: false, reason: "decision_not_from_stage" });
    expect(action(before, "archive").allowed).toBe(false);
    expect(action(before, "start").allowed).toBe(true);

    const refused = await o().approve(T.member, w.workflowId);
    expect(refused.status, refused.raw).not.toBe(200);
    expect(refused.raw).toContain("decision_not_from_stage");
    const archive = await call(T.owner.token, "POST", `/v1/reviewer-ops/reviews/${w.workflowId}/archive`, { teamId: T.teamId });
    expect(archive.status, archive.raw).not.toBe(200);

    expect((await o().start(T.member, w.workflowId)).status).toBe(200);
    const after = await o().workspace(T.member, w.workflowId);
    expect(action(after, "approve").allowed).toBe(true);
    const approved = await o().approve(T.member, w.workflowId);
    expect(approved.status, approved.raw).toBe(200);
  });

  it("#3 an escalated review nobody started: Approve is not offered and is refused; Start is offered", async () => {
    const w = await at("ASSIGNED");
    await prisma.reviewEscalation.create({
      data: {
        teamId: T.teamId,
        workflowId: w.workflowId,
        evidenceId: w.evidenceId,
        reason: "REVIEWER_ESCALATED",
        severity: "WARNING",
        status: "OPEN",
        safeSummary: "escalated before start",
        fingerprint: `r2-esc-${w.workflowId}`,
      } as never,
    });
    const ws = await o().workspace(T.member, w.workflowId);
    expect(action(ws, "approve")).toMatchObject({ allowed: false, reason: "decision_not_from_stage" });
    expect(action(ws, "start").allowed).toBe(true);
    const refused = await o().approve(T.member, w.workflowId);
    expect(refused.status, refused.raw).not.toBe(200);
    expect(refused.raw).toContain("decision_not_from_stage");
  });

  it("#4 Start is offered and accepted from Escalated, Response received and Needs information; never from In review", async () => {
    for (const status of ["ESCALATED", "RESPONSE_RECEIVED", "NEEDS_INFO"]) {
      const w = await at(status);
      const ws = await o().workspace(T.member, w.workflowId);
      expect(action(ws, "start").allowed, status).toBe(true);
      const started = await o().start(T.member, w.workflowId);
      expect(started.status, `${status}: ${started.raw}`).toBe(200);
      expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: w.workflowId } })).status).toBe("IN_REVIEW");
    }
    const inReview = await at("IN_REVIEW");
    const ws = await o().workspace(T.member, inReview.workflowId);
    expect(action(ws, "start")).toMatchObject({ allowed: false, reason: "already_started" });
    const again = await o().start(T.member, inReview.workflowId);
    expect(again.status, again.raw).not.toBe(200);
    expect(again.raw).toContain("already_started");
  });

  it("a handed-over in-review review: its new assignee is offered Start and the door accepts it, once", async () => {
    const w = await freshWorkflow(T.teamId, T.owner.userId, "r2-handover-start");
    expect((await o().assign(T.owner, w.workflowId, T.member.userId)).status).toBe(200);
    expect((await o().start(T.member, w.workflowId)).status).toBe(200);
    expect((await o().reassign(T.owner, w.workflowId, T.member2.userId)).status).toBe(200);
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: w.workflowId } })).status).toBe("IN_REVIEW");

    const offered = action(await o().workspace(T.member2, w.workflowId), "start");
    expect(offered.allowed, JSON.stringify(offered)).toBe(true);
    const started = await o().start(T.member2, w.workflowId);
    expect(started.status, started.raw).toBe(200);

    // Now the assignee has started it: a second Start is the no-op T-020 refuses, on both.
    expect(action(await o().workspace(T.member2, w.workflowId), "start")).toMatchObject({ allowed: false, reason: "already_started" });
    const again = await o().start(T.member2, w.workflowId);
    expect(again.status, again.raw).not.toBe(200);
    expect(again.raw).toContain("already_started");
  });

  it("for every open stage, Approve and Start are offered exactly when the door accepts them", async () => {
    const stages = ["NOT_STARTED", "QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO", "RESPONSE_RECEIVED", "ESCALATED", "REOPENED"];
    for (const verb of ["approve", "start"] as const) {
      for (const status of stages) {
        const w = await at(status);
        const offered = action(await o().workspace(T.member, w.workflowId), verb).allowed;
        const res = await o()[verb](T.member, w.workflowId);
        expect(res.status === 200, `${verb} from ${status}: offered=${offered}, door=${res.status} ${res.raw}`).toBe(offered);
      }
    }
  });
});

// =============================================================================
// Round 2 (2026-11-25) — divergence #7: the request-for-information rollover.
// The console reads the round through the authority's read-only mirror
// (loadCurrentRoundDecisionState, continuedFrom); the Evidence page derives it
// inline (resolvedByRequestInfo → first_required). This pins that both answer
// the same, and that the authority accepts exactly what both offer.
// =============================================================================

describe("round 2 — request-for-information rollover: Review page and Evidence page agree with the authority", () => {
  type EvidenceOffer = { action: string; enabled: boolean; blockedBy: string | null; reason?: string };
  async function evidenceOffer(a: Actor, evidenceId: string, verb: string): Promise<EvidenceOffer> {
    const res = await call(a.token, "GET", `/v1/evidence/${evidenceId}/review-workspace`);
    expect(res.status, res.raw.slice(0, 300)).toBe(200);
    const found = (res.body.reviewWorkflow.availableActions as EvidenceOffer[]).find((x) => x.action === verb);
    if (!found) throw new Error(`no evidence action ${verb}`);
    return found;
  }

  it("after a request for information and the response, the next verdict is the assignee's FIRST verdict of a new round on both pages", async () => {
    const o = ops(T);
    const w = await freshWorkflow(T.teamId, T.owner.userId, "r2-request-info-rollover");
    await prisma.evidenceReviewWorkflow.update({
      where: { id: w.workflowId },
      data: { status: "IN_REVIEW", assignedToUserId: T.member.userId, assignedAtUtc: new Date() },
    });
    expect((await o.requestInfo(T.member, w.workflowId)).status).toBe(200);
    expect((await o.responseReceived(T.member, w.workflowId)).status).toBe(200);

    for (const [who, expectAllowed] of [
      [T.member, true], // the assignee
      [T.member2, false], // another reviewer: not the assignee
    ] as const) {
      const consoleApprove = action(await o.workspace(who, w.workflowId), "approve");
      const evidenceApprove = await evidenceOffer(who, w.evidenceId, "APPROVE_INTERNAL");
      expect(consoleApprove.allowed, `console for ${who === T.member ? "assignee" : "other"}`).toBe(expectAllowed);
      expect(evidenceApprove.enabled, `evidence for ${who === T.member ? "assignee" : "other"}`).toBe(expectAllowed);
      if (!expectAllowed) {
        expect(consoleApprove.reason).toBe("not_assignee");
        expect(evidenceApprove.reason).toBe("not_assignee");
      }
    }

    // The authority agrees: the other reviewer is refused, the assignee's verdict lands as FIRST.
    const refused = await o.approve(T.member2, w.workflowId);
    expect(refused.status, refused.raw).not.toBe(200);
    const accepted = await o.approve(T.member, w.workflowId);
    expect(accepted.status, accepted.raw).toBe(200);
    expect(accepted.body.outcome.stageRecorded).toBe("FIRST");
  });
});
