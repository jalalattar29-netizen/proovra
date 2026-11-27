/**
 * Review remediation (2026-11-27) — the server contract of BEHAVIOUR-SPEC
 * (docs/review/remediation-2026-11-27): ordinary versus independent review,
 * request information as a workflow action, eligibility without unexplained
 * placement, the full member scan, challenge supersede, and the escalation
 * projection that follows the mutation's own rule. Real routes, real
 * PostgreSQL, persisted rows asserted.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { placeInCollaborationTeam } from "./support/place-in-collaboration-team.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let requiredLegalVersions: Record<string, unknown>;
let ensurePersonalWorkspace: typeof import("../src/services/platform-context/workspace-bootstrap.service.js").ensurePersonalWorkspace;
let countEligibleSecondReviewers: typeof import("../src/services/reviewer-ops/review-handoff.service.js").countEligibleSecondReviewers;
let reconcile: typeof import("../src/services/reviewer-ops/review-remediation-reconcile.service.js").reconcileReviewRemediation;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route bodies are asserted field by field
type Res = { status: number; body: any; raw: string };
type Actor = { userId: string; token: string };

async function call(token: string, method: "GET" | "POST", url: string, payload?: unknown): Promise<Res> {
  const res = await harness.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
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
async function newUser(label: string, id?: string): Promise<Actor> {
  seq += 1;
  const email = `rrem-${label}-${Date.now()}-${seq}@test.proovra.local`;
  const user = await prisma.user.create({
    data: { ...(id ? { id } : {}), email, firstName: "RRem", lastName: label, displayName: `RRem ${label}`, provider: "EMAIL", providerUserId: email },
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

async function teamWorkspace(owner: Actor): Promise<string> {
  const space = await ensurePersonalWorkspace({ userId: owner.userId });
  const updated = await prisma.entitlement.updateMany({ where: { userId: owner.userId }, data: { plan: "TEAM", active: true } });
  if (updated.count === 0) await prisma.entitlement.create({ data: { userId: owner.userId, plan: "TEAM" } });
  return space.teamId;
}

async function inReview(teamId: string, ownerUserId: string, assignee: string) {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: { title: `rrem ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "CREATED", teamId, organizationId: t.organizationId, ownerUserId },
      select: { id: true },
    })
  ).id;
  const workflowId = (
    await prisma.evidenceReviewWorkflow.create({
      data: { evidenceId, teamId, status: "IN_REVIEW", workspaceType: "TEAM", assignedToUserId: assignee, assignedAtUtc: new Date() } as never,
      select: { id: true },
    })
  ).id;
  return { evidenceId, workflowId };
}

const ops = (teamId: string) => ({
  decide: (a: Actor, wf: string, decision: string, rationale = `why ${decision}`) =>
    call(a.token, "POST", `/v1/reviewer-ops/workspace/${wf}/decisions`, { teamId, decision, rationale }),
  lineage: (a: Actor, wf: string) => call(a.token, "GET", `/v1/reviewer-ops/workspace/${wf}/decisions?teamId=${teamId}`),
  workspace: (a: Actor, wf: string) => call(a.token, "GET", `/v1/reviewer-ops/workspace/${wf}?teamId=${teamId}`),
  escalate: (a: Actor, wf: string, reason: string, extra: Record<string, unknown> = {}) =>
    call(a.token, "POST", "/v1/reviewer-ops/escalations", { teamId, workflowId: wf, reason, severity: "WARNING", safeSummary: "audit", ...extra }),
  requestIndependent: (a: Actor, wf: string, note = "Second pair of eyes please") =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/request-independent-review`, { teamId, note }),
  listEscalations: (a: Actor) => call(a.token, "GET", `/v1/reviewer-ops/escalations?teamId=${teamId}&status=ACTIVE&limit=200`),
  reassign: (a: Actor, wf: string, to: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/reassign`, { teamId, newAssigneeUserId: to }),
  responseReceived: (a: Actor, wf: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/response-received`, { teamId, note: "log arrived" }),
  start: (a: Actor, wf: string) => call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/start`, { teamId }),
  challenge: (a: Actor, wf: string, originalDecisionId: string) =>
    call(a.token, "POST", `/v1/reviewer/work/${wf}/disagree?teamId=${teamId}`, { originalDecisionId, rationale: "ignored the log" }),
  transition: (a: Actor, id: string, to: string, extra: Record<string, unknown> = {}) =>
    call(a.token, "POST", `/v1/reviewer/disagreements/${id}/transition?teamId=${teamId}`, { to, ...extra }),
});

const wfRow = (id: string) => prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id } });
const decisionRows = (workflowId: string) =>
  prisma.workflowReviewDecision.findMany({ where: { workflowId }, orderBy: { decidedAt: "asc" } });

let S: { teamId: string; owner: Actor };
let T: { teamId: string; owner: Actor; admin: Actor; member: Actor; member2: Actor };

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ REQUIRED_LEGAL_VERSIONS: requiredLegalVersions } = await import("../src/legal/legal-versioning.js"));
  ({ ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js"));
  ({ countEligibleSecondReviewers } = await import("../src/services/reviewer-ops/review-handoff.service.js"));
  ({ reconcileReviewRemediation: reconcile } = await import("../src/services/reviewer-ops/review-remediation-reconcile.service.js"));

  const solo = await newUser("solo");
  S = { teamId: await teamWorkspace(solo), owner: solo };

  const owner = await newUser("owner");
  const teamId = await teamWorkspace(owner);
  const admin = await newUser("admin");
  const member = await newUser("member");
  const member2 = await newUser("member2");
  for (const [u, role] of [
    [admin, "ADMIN"],
    [member, "MEMBER"],
    [member2, "MEMBER"],
  ] as const) {
    await prisma.teamMember.create({ data: { teamId, userId: u.userId, role, status: "ACTIVE" } });
  }
  T = { teamId, owner, admin, member, member2 };
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe("§2 ordinary versus independent review", () => {
  it("a manually raised ADMINISTRATIVE escalation does not force a second decision: one decision finalizes (F-02)", async () => {
    const o = ops(S.teamId);
    const r = await inReview(S.teamId, S.owner.userId, S.owner.userId);
    const esc = await o.escalate(S.owner, r.workflowId, "WORKFLOW_STALLED");
    expect(esc.status, esc.raw).toBe(201);
    expect(esc.body.escalation).toMatchObject({ forcesIndependentReview: false, independenceCause: null });
    const stored = await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: esc.body.escalation.id } });
    expect(stored.requiresIndependentReview).toBe(false);
    expect((await wfRow(r.workflowId)).escalatedByUserId).toBe(S.owner.userId); // F-29
    const lin = await o.lineage(S.owner, r.workflowId);
    expect(lin.body.secondReview.required).toBe(false);
    const res = await o.decide(S.owner, r.workflowId, "REJECT");
    expect(res.status, res.raw).toBe(201);
    expect(res.body.outcome).toMatchObject({ stageRecorded: "FIRST", reviewState: "resolved", nextRequirement: null });
    expect(String((await wfRow(r.workflowId)).status)).toBe("REJECTED_INSUFFICIENT");
  });

  it("an explicit request requires it; the first decision is recorded even with nobody eligible, and never finalizes (F-01, F-06)", async () => {
    const o = ops(S.teamId);
    const r = await inReview(S.teamId, S.owner.userId, S.owner.userId);
    const esc = await o.escalate(S.owner, r.workflowId, "WORKFLOW_STALLED", { requireIndependentReview: true, independenceNote: "unusual source" });
    expect(esc.body.escalation).toMatchObject({ forcesIndependentReview: true, independenceCause: "independent_review_requested" });
    const lin = await o.lineage(S.owner, r.workflowId);
    expect(lin.body.secondReview).toMatchObject({
      required: true,
      cause: "independent_review_requested",
      eligibleReviewerCount: 0,
      staffing: "no_eligible_second_reviewer",
    });
    expect(lin.body.secondReview.escalation).toMatchObject({ requestedByUserId: S.owner.userId, note: "unusual source" });
    expect(lin.body.secondReview.escalation.requestedByName).toBeTruthy();
    const ws = await o.workspace(S.owner, r.workflowId);
    expect(ws.body.viewer.actions.find((a: { action: string }) => a.action === "reject")).toMatchObject({ allowed: true });
    const first = await o.decide(S.owner, r.workflowId, "REJECT");
    expect(first.status, first.raw).toBe(201);
    expect(first.body.outcome).toMatchObject({
      stageRecorded: "FIRST",
      statusChanged: false,
      nextRequirement: "second_review",
      secondReview: { staffing: "no_eligible_second_reviewer" },
    });
    expect(String((await wfRow(r.workflowId)).status)).toBe("IN_REVIEW");
    const again = await o.decide(S.owner, r.workflowId, "APPROVE");
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("same_reviewer_blocked");
  });

  it("an integrity reason always requires it, even when the raiser did not ask", async () => {
    const o = ops(S.teamId);
    const r = await inReview(S.teamId, S.owner.userId, S.owner.userId);
    const esc = await o.escalate(S.owner, r.workflowId, "INTEGRITY_RISK", { requireIndependentReview: false });
    expect(esc.body.escalation).toMatchObject({ forcesIndependentReview: true, independenceCause: "integrity_escalation" });
    expect((await o.lineage(S.owner, r.workflowId)).body.secondReview.cause).toBe("integrity_escalation");
  });

  it("a person-raised escalation recorded before the change (NULL) keeps the legacy rule; the automatic sweep's never forces", async () => {
    const o = ops(S.teamId);
    const r = await inReview(S.teamId, S.owner.userId, S.owner.userId);
    await prisma.reviewEscalation.create({
      data: {
        teamId: S.teamId, workflowId: r.workflowId, evidenceId: r.evidenceId, reason: "REVIEW_OVERDUE", severity: "HIGH",
        status: "OPEN", safeSummary: "auto", createdByUserId: null, fingerprint: randomUUID(),
      } as never,
    });
    expect((await o.lineage(S.owner, r.workflowId)).body.secondReview.required).toBe(false);
    await prisma.reviewEscalation.create({
      data: {
        teamId: S.teamId, workflowId: r.workflowId, evidenceId: r.evidenceId, reason: "WORKFLOW_STALLED", severity: "WARNING",
        status: "OPEN", safeSummary: "legacy", createdByUserId: S.owner.userId, fingerprint: randomUUID(),
      } as never,
    });
    expect((await o.lineage(S.owner, r.workflowId)).body.secondReview.cause).toBe("legacy_escalation");
    // The owner-approved reconciliation reclassifies it; only then does it stop forcing.
    const dry = await reconcile({ teamId: S.teamId }, prisma);
    expect(dry.categories.legacy_administrative_escalations.count).toBeGreaterThanOrEqual(1);
    expect(dry.categories.legacy_administrative_escalations.applied).toBe(0);
    expect((await o.lineage(S.owner, r.workflowId)).body.secondReview.cause).toBe("legacy_escalation");
    const applied = await reconcile({ teamId: S.teamId, apply: ["legacy_administrative_escalations"] }, prisma);
    expect(applied.categories.legacy_administrative_escalations.applied).toBeGreaterThanOrEqual(1);
    expect((await o.lineage(S.owner, r.workflowId)).body.secondReview.required).toBe(false);
    const again = await reconcile({ teamId: S.teamId, apply: ["legacy_administrative_escalations"] }, prisma);
    expect(again.categories.legacy_administrative_escalations.applied).toBe(0); // idempotent
  });

  it("the explicit Request independent review action and the workspace policy both require it", async () => {
    const o = ops(S.teamId);
    const r = await inReview(S.teamId, S.owner.userId, S.owner.userId);
    const req = await o.requestIndependent(S.owner, r.workflowId);
    expect(req.status, req.raw).toBe(201);
    expect(req.body.escalation).toMatchObject({ reason: "INDEPENDENT_REVIEW_REQUESTED", independenceCause: "independent_review_requested" });
    const ws = await o.workspace(S.owner, r.workflowId);
    expect(ws.body.viewer.actions.find((a: { action: string }) => a.action === "request_independent_review")).toMatchObject({
      allowed: false,
      reason: "independent_review_already_required",
    });
    // The server enforces what the page offers (§4): a second request is refused, nothing new is raised.
    const twice = await o.requestIndependent(S.owner, r.workflowId);
    expect(twice.status, twice.raw).toBe(409);
    expect(twice.body.error.details.reason).toBe("independent_review_already_required");
    expect(await prisma.reviewEscalation.count({ where: { workflowId: r.workflowId, reason: "INDEPENDENT_REVIEW_REQUESTED" } })).toBe(1);

    const r2 = await inReview(S.teamId, S.owner.userId, S.owner.userId);
    await prisma.workspaceGovernancePolicy.upsert({
      where: { teamId: S.teamId },
      create: { teamId: S.teamId, reviewRequiresIndependentApproval: true } as never,
      update: { reviewRequiresIndependentApproval: true },
    });
    expect((await o.lineage(S.owner, r2.workflowId)).body.secondReview.cause).toBe("workspace_policy");
    await prisma.workspaceGovernancePolicy.update({ where: { teamId: S.teamId }, data: { reviewRequiresIndependentApproval: false } });
  });
});

describe("§5 request information is a workflow action", () => {
  it("before a first decision: no decision row, NEEDS_INFO, event with requester; response → start → one decision finalizes (F-04)", async () => {
    const o = ops(S.teamId);
    const r = await inReview(S.teamId, S.owner.userId, S.owner.userId);
    const res = await o.decide(S.owner, r.workflowId, "REQUEST_INFO", "Please attach the device log.");
    expect(res.status, res.raw).toBe(201);
    expect(res.body.decision).toBeNull();
    expect(res.body.outcome).toMatchObject({ stageRecorded: "NONE", statusChanged: true, nextRequirement: "information" });
    expect(await decisionRows(r.workflowId)).toHaveLength(0);
    expect(String((await wfRow(r.workflowId)).status)).toBe("NEEDS_INFO");
    const ev = await prisma.evidenceReviewWorkflowEvent.findFirstOrThrow({ where: { workflowId: r.workflowId, eventType: "NEEDS_MORE_INFO" } });
    expect(ev.nextValue).toMatchObject({ requestedByUserId: S.owner.userId, requestedFrom: { role: "evidence_owner" } });
    expect(ev.note).toBe("Please attach the device log.");
    const replay = await o.decide(S.owner, r.workflowId, "REQUEST_INFO", "Please attach the device log.");
    expect(replay.status).toBe(200);
    expect(replay.body.outcome.idempotent).toBe(true);
    expect((await o.responseReceived(S.owner, r.workflowId)).status).toBe(200);
    expect((await o.start(S.owner, r.workflowId)).status).toBe(200);
    const fin = await o.decide(S.owner, r.workflowId, "APPROVE");
    expect(fin.status, fin.raw).toBe(201);
    expect(String((await wfRow(r.workflowId)).status)).toBe("APPROVED_INTERNAL");
    // F-20 — the finalizing decision event carries a coding snapshot key only when a schema is bound (none here).
    const done = await prisma.evidenceReviewWorkflowEvent.findFirstOrThrow({
      where: { workflowId: r.workflowId, eventType: "DECISION_LOGGED" },
      orderBy: { createdAt: "desc" },
    });
    expect((done.nextValue as Record<string, unknown>).codingSnapshot).toBeUndefined();
  });

  it("after a first decision: the request supersedes it, the round advances and the requirement is carried", async () => {
    const o = ops(T.teamId);
    const r = await inReview(T.teamId, T.owner.userId, T.member.userId);
    await o.requestIndependent(T.member, r.workflowId);
    const first = await o.decide(T.member, r.workflowId, "REJECT");
    expect(first.status, first.raw).toBe(201);
    expect(first.body.outcome.nextRequirement).toBe("second_review");
    expect((await o.reassign(T.owner, r.workflowId, T.member2.userId)).status).toBe(200);
    const before = await wfRow(r.workflowId);
    const ask = await o.decide(T.member2, r.workflowId, "REQUEST_INFO", "Which device captured this?");
    expect(ask.status, ask.raw).toBe(201);
    const after = await wfRow(r.workflowId);
    expect(after.decisionRound).toBe(before.decisionRound + 1);
    const ev = await prisma.evidenceReviewWorkflowEvent.findFirstOrThrow({
      where: { workflowId: r.workflowId, eventType: "NEEDS_MORE_INFO" },
      orderBy: { createdAt: "desc" },
    });
    expect(ev.nextValue).toMatchObject({ supersededDecisionId: first.body.decision.id, carriedSecondReviewCause: "independent_review_requested" });
    expect((await decisionRows(r.workflowId)).filter((d) => d.round === after.decisionRound)).toHaveLength(0);
    expect((await o.responseReceived(T.member2, r.workflowId)).status).toBe(200);
    expect((await o.start(T.member2, r.workflowId)).status).toBe(200);
    const lin = await o.lineage(T.member2, r.workflowId);
    expect(lin.body).toMatchObject({ state: "first_required", secondReview: { required: true } });
  });
});

describe("§3 eligibility", () => {
  it("Team review needs no Collaboration Team placement unless the workspace policy says so; then losing placement releases held reviews (F-31)", async () => {
    const r = await inReview(T.teamId, T.owner.userId, T.owner.userId);
    const wf = { teamId: T.teamId, evidenceId: r.evidenceId };
    try {
    const unplaced = await countEligibleSecondReviewers(wf, T.owner.userId);
    expect(unplaced).toBeGreaterThanOrEqual(3); // admin, member, member2 — none placed
    await prisma.workspaceGovernancePolicy.upsert({
      where: { teamId: T.teamId },
      create: { teamId: T.teamId, reviewRequiresTeamPlacement: true } as never,
      update: { reviewRequiresTeamPlacement: true },
    });
    expect(await countEligibleSecondReviewers(wf, T.owner.userId)).toBe(0);
    const groupId = await placeInCollaborationTeam(prisma, { workspaceId: T.teamId, createdByUserId: T.owner.userId, userIds: [T.member.userId] });
    await prisma.collaborationTeamMember.create({ data: { teamId: groupId, userId: T.owner.userId, role: "LEAD", status: "ACTIVE" } });
    expect(await countEligibleSecondReviewers(wf, T.owner.userId)).toBe(1);
    const held = await inReview(T.teamId, T.owner.userId, T.member.userId);
    const { removeMember } = await import("../src/services/collaboration-team/collaboration-team.service.js");
    const membership = await prisma.collaborationTeamMember.findFirstOrThrow({ where: { teamId: groupId, userId: T.member.userId } });
    await removeMember({ teamId: groupId, actorUserId: T.owner.userId, memberId: membership.id });
    const row = await wfRow(held.workflowId);
    expect(row.assignedToUserId).toBeNull();
    const ev = await prisma.evidenceReviewWorkflowEvent.findFirstOrThrow({ where: { workflowId: held.workflowId, eventType: "UNASSIGNED" } });
    expect((ev.nextValue as Record<string, unknown>).reason).toBe("review_placement_lost");
    } finally {
      await prisma.workspaceGovernancePolicy.update({ where: { teamId: T.teamId }, data: { reviewRequiresTeamPlacement: false } });
    }
  });

  it("counts every member, not a 200-member sample: an eligible reviewer sorting after 230 others is found (F-32)", async () => {
    const owner = await newUser("big-owner");
    const teamId = await teamWorkspace(owner);
    const viewers = Array.from({ length: 230 }, () => randomUUID()).sort();
    await prisma.user.createMany({
      data: viewers.map((id, i) => ({ id, email: `rrem-v${i}-${Date.now()}@test.proovra.local`, provider: "EMAIL", providerUserId: `rrem-v${i}-${id}` })),
    });
    await prisma.teamMember.createMany({ data: viewers.map((userId) => ({ teamId, userId, role: "VIEWER", status: "ACTIVE" })) });
    const late = await newUser("late", "ffffffff-ffff-4fff-bfff-ffffffffffff");
    await prisma.teamMember.create({ data: { teamId, userId: late.userId, role: "MEMBER", status: "ACTIVE" } });
    const r = await inReview(teamId, owner.userId, owner.userId);
    expect(await countEligibleSecondReviewers({ teamId, evidenceId: r.evidenceId }, owner.userId)).toBe(1);
  });
});

describe("§4 one authority for actions", () => {
  it("escalation rows carry the viewer's moves from the mutation's own rule (F-03); adjudication is offered only to an independent owner/admin (F-08)", async () => {
    const o = ops(T.teamId);
    const r = await inReview(T.teamId, T.owner.userId, T.owner.userId);
    const forcing = await o.requestIndependent(T.owner, r.workflowId);
    const admin = await o.escalate(T.owner, r.workflowId, "WORKFLOW_STALLED");
    const list = await o.listEscalations(T.owner);
    const row = (id: string) => list.body.escalations.find((e: { id: string }) => e.id === id);
    const resolveOf = (e: { viewerActions: Array<{ action: string; allowed: boolean; reason?: string }> }) =>
      e.viewerActions.find((a) => a.action === "resolve");
    expect(resolveOf(row(forcing.body.escalation.id))).toMatchObject({ allowed: false, reason: "resolver_is_assignee" });
    expect(resolveOf(row(admin.body.escalation.id))).toMatchObject({ allowed: true });
    const refused = await call(T.owner.token, "POST", `/v1/reviewer-ops/escalations/${forcing.body.escalation.id}/resolve`, {
      teamId: T.teamId,
      resolutionNote: "x",
    });
    expect(refused.status).toBe(403);

    // Conflict: owner FIRST approve, admin SECOND reject.
    expect((await o.decide(T.owner, r.workflowId, "APPROVE")).status).toBe(201);
    expect((await o.reassign(T.owner, r.workflowId, T.admin.userId)).status).toBe(200);
    const second = await o.decide(T.admin, r.workflowId, "REJECT");
    expect(second.body.outcome.nextRequirement).toBe("adjudication");
    expect((await o.lineage(T.owner, r.workflowId)).body.callerContext.nextAction).toBe("blocked_adjudicator_not_independent");
    const ws = await o.workspace(T.owner, r.workflowId);
    expect(ws.body.viewer.actions.find((a: { action: string }) => a.action === "adjudicate")).toMatchObject({
      allowed: false,
      reason: "adjudicator_not_independent",
    });
  });

  it("a challenge is offered only for someone else's recorded decision (F-07); OVERTURNED supersedes through the canonical lifecycle (F-11)", async () => {
    const o = ops(T.teamId);
    const r = await inReview(T.teamId, T.owner.userId, T.member.userId);
    let ws = await o.workspace(T.owner, r.workflowId);
    expect(ws.body.viewer.actions.find((a: { action: string }) => a.action === "challenge")).toMatchObject({
      allowed: false,
      reason: "no_challengeable_decision",
    });
    const dec = await o.decide(T.member, r.workflowId, "APPROVE");
    expect(String((await wfRow(r.workflowId)).status)).toBe("APPROVED_INTERNAL");
    ws = await o.workspace(T.owner, r.workflowId);
    expect(ws.body.viewer.challengeableDecisionIds).toEqual([dec.body.decision.id]);
    const filed = await o.challenge(T.owner, r.workflowId, dec.body.decision.id);
    expect(filed.status, filed.raw).toBe(201);
    const id = filed.body.disagreementId;
    expect((await o.transition(T.admin, id, "UNDER_SECOND_REVIEW")).status).toBe(200);
    const res = await o.transition(T.admin, id, "RESOLVED_OVERTURNED", { verdict: "REJECT", rationale: "device log contradicts" });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.superseded).toBe("reopen");
    const row = await wfRow(r.workflowId);
    expect(String(row.status)).toBe("REOPENED");
    expect(row.decisionRound).toBeGreaterThan(0);
    expect(await decisionRows(r.workflowId)).toHaveLength(1); // history kept
  });
});
