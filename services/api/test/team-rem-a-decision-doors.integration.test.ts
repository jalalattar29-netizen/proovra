/**
 * Team remediation — Stage A (2026-11-24): one decision authority behind every
 * door, the viewer-action projection, the lineage read, and the lifecycle
 * adapters. Every case fails on the behaviour at e4e908e88.
 *
 *   T-010  one input schema on every door (non-empty rationale, 4000 chars,
 *          the authority code as details.reason).
 *   T-009 / T-019 / T-020 / T-021  viewer actions: reopen, escalate (+ the
 *          forcing hint), no Start on a review already in review, and no
 *          pause of an unassigned review by a plain reviewer.
 *   T-003  focus mode's next item is never the caller's own first-of-two.
 *   T-023 / T-024  every round in the history; External Review verdicts
 *          read-only and advisory.
 *   T-171  the Evidence-page door emits the outcome signals (first-decision audit).
 *   T-161  a single Archive is audited as itself, with its own text.
 *   T-166  the mobile PATCH adapter keeps the hand-off independence and the
 *          Close guard.
 *   T-170  a person's escalation tells whoever holds the review.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { placeInCollaborationTeam } from "./support/place-in-collaboration-team.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let requiredLegalVersions: Record<string, unknown>;
let invitations: typeof import("../src/services/external-review/portal-invitation.service.js");
let ensurePersonalWorkspace: typeof import("../src/services/platform-context/workspace-bootstrap.service.js").ensurePersonalWorkspace;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route bodies are asserted field by field
type Res = { status: number; body: any; raw: string };
type Actor = { userId: string; token: string };

async function call(token: string, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await harness.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
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
  await harness.handlersSettled();
  return { status: res.statusCode, body, raw: res.body };
}

let seq = 0;
async function newUser(label: string): Promise<Actor> {
  seq += 1;
  const email = `trem-ad-${label}-${Date.now()}-${seq}@test.proovra.local`;
  const user = await prisma.user.create({
    data: { email, firstName: "RemA", lastName: label, displayName: `RemA ${label}`, provider: "EMAIL", providerUserId: email },
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

async function review(status: string, assignee: string | null, opts: { hold?: boolean } = {}) {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: T.teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: { title: `trem-ad ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "CREATED", teamId: T.teamId, organizationId: t.organizationId, ownerUserId: T.owner.userId },
      select: { id: true },
    })
  ).id;
  const workflowId = (
    await prisma.evidenceReviewWorkflow.create({
      data: {
        evidenceId,
        teamId: T.teamId,
        status,
        workspaceType: "TEAM",
        assignedToUserId: assignee,
        assignedAtUtc: assignee ? new Date() : null,
      } as never,
      select: { id: true },
    })
  ).id;
  if (opts.hold) {
    await prisma.evidenceLegalHold.create({
      data: { scope: "EVIDENCE", evidenceId, teamId: T.teamId, status: "ACTIVE", title: "Hold", placedByUserId: T.owner.userId } as never,
    });
  }
  return { evidenceId, workflowId };
}

let T: { teamId: string; owner: Actor; admin: Actor; member: Actor; member2: Actor };
const tid = () => T.teamId;
const legacy = (a: Actor, wf: string, verb: "approve" | "reject" | "request-info", note?: unknown) =>
  call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/${verb}`, { teamId: tid(), ...(note !== undefined ? { note } : {}) });
const canonical = (a: Actor, wf: string, decision: string, rationale?: string) =>
  call(a.token, "POST", `/v1/reviewer-ops/workspace/${wf}/decisions`, { teamId: tid(), decision, ...(rationale !== undefined ? { rationale } : {}) });
const evidenceDoor = (a: Actor, evidenceId: string, decision: string, note?: string | null) =>
  call(a.token, "POST", `/v1/review-operations/evidence/${evidenceId}/decision`, { decision, note });
const workspace = (a: Actor, wf: string) => call(a.token, "GET", `/v1/reviewer-ops/workspace/${wf}?teamId=${tid()}`);
const lineage = (a: Actor, wf: string) => call(a.token, "GET", `/v1/reviewer-ops/workspace/${wf}/decisions?teamId=${tid()}`);
const action = (res: Res, name: string) =>
  (res.body.viewer.actions as Array<{ action: string; allowed: boolean; reason?: string }>).find((x) => x.action === name);
const wfRow = (id: string) => prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ REQUIRED_LEGAL_VERSIONS: requiredLegalVersions } = await import("../src/legal/legal-versioning.js"));
  ({ ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js"));
  invitations = await import("../src/services/external-review/portal-invitation.service.js");
  const owner = await newUser("owner");
  const space = await ensurePersonalWorkspace({ userId: owner.userId });
  const updated = await prisma.entitlement.updateMany({ where: { userId: owner.userId }, data: { plan: "TEAM", active: true } });
  if (updated.count === 0) await prisma.entitlement.create({ data: { userId: owner.userId, plan: "TEAM" } });
  const admin = await newUser("admin");
  const member = await newUser("member");
  const member2 = await newUser("member2");
  for (const [u, role] of [
    [admin, "ADMIN"],
    [member, "MEMBER"],
    [member2, "MEMBER"],
  ] as const) {
    await prisma.teamMember.create({ data: { teamId: space.teamId, userId: u.userId, role, status: "ACTIVE" } });
  }
  await placeInCollaborationTeam(prisma, {
    workspaceId: space.teamId,
    createdByUserId: owner.userId,
    userIds: [admin.userId, member.userId, member2.userId],
  });
  T = { teamId: space.teamId, owner, admin, member, member2 };
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe("T-010 — one input schema on every door", () => {
  it("refuses an approval with no rationale on the legacy door (it was approved), with the authority code", async () => {
    const r = await review("IN_REVIEW", T.member.userId);
    const res = await legacy(T.member, r.workflowId, "approve");
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error.details.reason).toBe("rationale_required");
    expect(String((await wfRow(r.workflowId)).status)).toBe("IN_REVIEW");
    const ws = await legacy(T.member, r.workflowId, "approve", "   ");
    expect(ws.status).toBe(400);
    expect(ws.body.error.details.reason).toBe("rationale_required");
    const can = await canonical(T.member, r.workflowId, "APPROVE", "   ");
    expect(can.status).toBe(400);
    expect(can.body.error.details.reason).toBe("rationale_required");
    const ev = await evidenceDoor(T.member, r.evidenceId, "APPROVE_INTERNAL", "  ");
    expect(ev.body.error.details.reason).toBe("rationale_required");
    expect(await prisma.workflowReviewDecision.count({ where: { workflowId: r.workflowId } })).toBe(0);
  });

  it("accepts a 1001-character reason on the legacy door (it was refused at 1000) and refuses 4001 everywhere", async () => {
    const r = await review("IN_REVIEW", T.member.userId);
    const long = "a".repeat(4001);
    for (const res of [
      await legacy(T.member, r.workflowId, "reject", long),
      await canonical(T.member, r.workflowId, "REJECT", long),
    ]) {
      expect(res.status, res.raw).toBe(400);
      expect(res.body.error.details.reason).toBe("rationale_too_long");
    }
    const ok = await legacy(T.member, r.workflowId, "reject", "b".repeat(1001));
    expect(ok.status, ok.raw).toBe(200);
    expect(String((await wfRow(r.workflowId)).status)).toBe("REJECTED_INSUFFICIENT");
  });
});

describe("viewer actions (T-009 / T-019 / T-020 / T-021)", () => {
  it("projects reopen, escalate with its forcing hint, Start only before the review started, and the pause rule", async () => {
    const rejected = await review("REJECTED_INSUFFICIENT", T.member.userId);
    const ownerView = await workspace(T.owner, rejected.workflowId);
    expect(ownerView.status, ownerView.raw).toBe(200);
    expect(action(ownerView, "reopen")).toMatchObject({ allowed: true });

    const inReview = await review("IN_REVIEW", T.member.userId);
    await prisma.reviewEscalation.create({
      data: {
        teamId: T.teamId,
        workflowId: inReview.workflowId,
        evidenceId: inReview.evidenceId,
        reason: "REVIEW_OVERDUE",
        severity: "HIGH",
        status: "OPEN",
        safeSummary: "auto",
        fingerprint: randomUUID(),
      } as never,
    });
    const memberView = await workspace(T.member, inReview.workflowId);
    expect(action(memberView, "start")).toMatchObject({ allowed: false, reason: "already_started" });
    expect(action(memberView, "reject")).toMatchObject({ allowed: true });
    expect(action(memberView, "escalate")).toMatchObject({ allowed: true });
    expect(action(memberView, "reopen")).toMatchObject({ allowed: false });
    // Review remediation (2026-11-27): an ordinary Escalate is administrative
    // and adds no second reviewer; independence is a separate, explicit request.
    // (The former viewer.escalationForcesIndependentReview hint is gone: the
    // Escalate dialog states the effect of the explicit choice instead.)
    expect(memberView.body.viewer).not.toHaveProperty("escalationForcesIndependentReview");
    // The automatic escalation forces nothing (T-013), and says so.
    expect(memberView.body.openEscalation.forcesIndependentReview).toBe(false);

    const assigned = await review("ASSIGNED", T.member.userId);
    expect(action(await workspace(T.member, assigned.workflowId), "start")).toMatchObject({ allowed: true });

    const unassigned = await review("QUEUED", null);
    expect(action(await workspace(T.member, unassigned.workflowId), "pause")).toMatchObject({
      allowed: false,
      reason: "review_assign_required",
    });
    const paused = await call(T.member.token, "POST", `/v1/reviewer-ops/reviews/${unassigned.workflowId}/pause`, {
      teamId: T.teamId,
      pausedReason: "waiting",
    });
    expect(paused.status, paused.raw).toBe(403);
    expect((await wfRow(unassigned.workflowId)).slaPausedAtUtc).toBeNull();
    expect(action(await workspace(T.admin, unassigned.workflowId), "pause")).toMatchObject({ allowed: true });
  });
});

describe("T-003 — focus mode's next item", () => {
  it("is not the review the caller just decided first of two", async () => {
    const held = await review("IN_REVIEW", T.member2.userId, { hold: true });
    const other = await review("ASSIGNED", T.member2.userId);
    await prisma.evidenceReviewWorkflow.update({ where: { id: held.workflowId }, data: { priority: "URGENT" } as never });
    const before = await call(T.member2.token, "GET", `/v1/reviewer/workspace?teamId=${T.teamId}`);
    expect(before.status, before.raw).toBe(200);
    expect(before.body.workspace.activeReview.workflowId).toBe(held.workflowId);
    expect((await legacy(T.member2, held.workflowId, "reject", "gap")).body.outcome).toMatchObject({ nextRequirement: "second_review" });
    const after = await call(T.member2.token, "GET", `/v1/reviewer/workspace?teamId=${T.teamId}`);
    expect(after.body.workspace.activeReview?.workflowId).not.toBe(held.workflowId);
    expect(after.body.workspace.activeReview?.workflowId).toBe(other.workflowId);
  });
});

describe("T-023 / T-024 — the history", () => {
  it("lists a request for information (a workflow action, not a decision) and External Review verdicts as advisory", async () => {
    const r = await review("IN_REVIEW", T.member.userId);
    expect((await legacy(T.member, r.workflowId, "request-info", "need the original file")).status).toBe(200);
    expect(
      (await call(T.member.token, "POST", `/v1/reviewer-ops/reviews/${r.workflowId}/response-received`, { teamId: T.teamId })).status,
    ).toBe(200);
    const res = await lineage(T.owner, r.workflowId);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.state).toBe("first_required");
    // Review remediation (F-04): no decision slot was used; the history names
    // the request, who asked, of whom, and why.
    expect(res.body.rounds).toHaveLength(0);
    expect(res.body.informationRequests).toHaveLength(1);
    expect(res.body.informationRequests[0]).toMatchObject({
      requestedInRound: 0,
      requestedBy: { userId: T.member.userId },
      requestedFrom: { role: "evidence_owner" },
      reason: "need the original file",
      supersededDecisionId: null,
    });

    // An External Review verdict on the same review.
    const issued = await invitations.issueInvitation({
      teamId: T.teamId,
      invitedByUserId: T.owner.userId,
      reviewerEmail: "outside@example.test",
      role: "EXTERNAL_REVIEWER",
      mfaRequired: false,
      scope: { kind: "EVIDENCE", evidenceId: r.evidenceId },
      expiresAtUtc: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    } as never);
    if (!issued.ok) throw new Error("invitation not issued");
    await prisma.externalReviewDecision.create({
      data: {
        teamId: T.teamId,
        grantId: issued.grantId,
        workflowId: r.workflowId,
        verdict: "REJECT",
        rationale: "Timestamp gap",
        reviewerEmail: "outside@example.test",
        reviewerDisplay: "Outside Counsel",
      },
    });
    const withExternal = await lineage(T.owner, r.workflowId);
    expect(withExternal.body.externalFeedback).toEqual([
      expect.objectContaining({ verdict: "REJECT", rationale: "Timestamp gap", advisory: true, reviewer: { email: "outside@example.test", displayName: "Outside Counsel" } }),
    ]);
    // Advisory: it decides nothing.
    expect(withExternal.body.state).toBe("first_required");
  });
});

describe("T-171 — the Evidence-page door emits the outcome signals", () => {
  it("writes the first-decision audit row for a first-of-two verdict recorded there", async () => {
    const r = await review("IN_REVIEW", T.member.userId, { hold: true });
    const res = await evidenceDoor(T.member, r.evidenceId, "APPROVE_INTERNAL", "complete");
    expect(res.status, res.raw).toBe(200);
    expect(res.body.outcome).toMatchObject({ stageRecorded: "FIRST", nextRequirement: "second_review" });
    expect(
      await prisma.adminAuditLog.count({ where: { resourceId: r.workflowId, action: "reviewer.first_decision_recorded" } }),
    ).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { resourceId: r.workflowId, action: "reviewer.review_completed" } })).toBe(0);
  });
});

describe("T-161 — a single Archive", () => {
  it("is audited as an archive from the review page, never as a bulk triage", async () => {
    const r = await review("IN_REVIEW", T.member.userId);
    const res = await call(T.owner.token, "POST", `/v1/reviewer-ops/reviews/${r.workflowId}/archive`, { teamId: T.teamId });
    expect(res.status, res.raw).toBe(200);
    expect(String((await wfRow(r.workflowId)).status)).toBe("CLOSED");
    const closed = await prisma.evidenceReviewWorkflowEvent.findFirst({ where: { workflowId: r.workflowId, eventType: "CLOSED" } });
    expect(closed?.note).toBe("Archived from the review page.");
    const audit = await prisma.adminAuditLog.findFirst({ where: { resourceId: r.workflowId, action: "reviewer.review.archive" } });
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).toContain("REVIEW_PAGE");
    // A member cannot archive (unchanged authority).
    const r2 = await review("IN_REVIEW", T.member.userId);
    expect((await call(T.member.token, "POST", `/v1/reviewer-ops/reviews/${r2.workflowId}/archive`, { teamId: T.teamId })).status).toBe(403);
  });
});

describe("T-166 — the mobile reviewer-workflow PATCH is an adapter over the canonical rules", () => {
  it("refuses handing the second review back to the first reviewer and closing a review awaiting it", async () => {
    const r = await review("IN_REVIEW", T.member.userId, { hold: true });
    expect((await legacy(T.member, r.workflowId, "approve", "fine")).body.outcome).toMatchObject({ nextRequirement: "second_review" });
    // Reassign away, then try to hand it straight back to the first reviewer.
    expect(
      (await call(T.owner.token, "POST", `/v1/reviewer-ops/reviews/${r.workflowId}/reassign`, { teamId: T.teamId, newAssigneeUserId: T.member2.userId })).status,
    ).toBe(200);
    const back = await call(
      T.owner.token,
      "PATCH",
      `/v1/evidence/${r.evidenceId}/reviewer-workflow`,
      { assignedToUserId: T.member.userId },
      { "x-proovra-workspace-id": T.teamId },
    );
    expect(back.status, back.raw).toBe(422);
    expect(back.raw).toContain("second_reviewer_not_independent");
    expect((await wfRow(r.workflowId)).assignedToUserId).toBe(T.member2.userId);
    const close = await call(
      T.owner.token,
      "PATCH",
      `/v1/evidence/${r.evidenceId}/reviewer-workflow`,
      { status: "CLOSED" },
      { "x-proovra-workspace-id": T.teamId },
    );
    expect(close.status, close.raw).toBe(422);
    expect(close.raw).toContain("second_review_pending");
    expect(String((await wfRow(r.workflowId)).status)).toBe("IN_REVIEW");
  });
});

describe("T-170 — a person's escalation tells whoever holds the review", () => {
  it("notifies the assignee (never the person who raised it)", async () => {
    const r = await review("IN_REVIEW", T.member.userId);
    const raised = await call(T.admin.token, "POST", "/v1/reviewer-ops/escalations", {
      teamId: T.teamId,
      workflowId: r.workflowId,
      reason: "VERIFICATION_MISMATCH",
      severity: "HIGH",
      safeSummary: "Signature does not verify",
    });
    expect(raised.status, raised.raw).toBe(201);
    const sent = await prisma.notificationDelivery.findMany({
      where: { evidenceId: r.evidenceId, eventType: "REVIEW_ESCALATED" },
      select: { recipientUserId: true },
    });
    expect(sent.map((s) => s.recipientUserId)).toEqual([T.member.userId]);
    // The assignee raising one on their own review is not told about it.
    const r2 = await review("IN_REVIEW", T.member.userId);
    expect(
      (await call(T.member.token, "POST", "/v1/reviewer-ops/escalations", {
        teamId: T.teamId,
        workflowId: r2.workflowId,
        reason: "INTEGRITY_RISK",
        severity: "HIGH",
        safeSummary: "Hash mismatch",
      })).status,
    ).toBe(201);
    expect(await prisma.notificationDelivery.count({ where: { evidenceId: r2.evidenceId, eventType: "REVIEW_ESCALATED" } })).toBe(0);
  });
});
