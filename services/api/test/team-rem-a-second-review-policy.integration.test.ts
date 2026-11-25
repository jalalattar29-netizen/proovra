/**
 * Team remediation — Stage A (2026-11-24): the second-review TRIGGER POLICY and
 * the integrity of the two-person rule, against a real PostgreSQL and the real
 * routes. Every case fails on the behaviour at e4e908e88.
 *
 *   T-013  an escalation the automatic overdue sweep raised alone does not force
 *          an independent second review; a person's escalation and a legal hold
 *          still do.
 *   T-015  the outcome says why a second review is required and returns
 *          `no_eligible_second_reviewer` when nobody can give it; the lineage
 *          read says so BEFORE anyone submits.
 *   T-160  the owner is told (once per round) when nobody can give it.
 *   T-016  the assignee / first reviewer cannot resolve the forcing escalation;
 *          an independent owner or admin can. Refusals are audited.
 *   T-017  resolving the escalation never finalises the first verdict and never
 *          leaves a "resolved" lineage on a review that is still in review.
 *   T-011  a plain verdict during a conflict is refused with use_adjudication.
 *   T-018  an UNRESOLVED adjudication opens a new round: the next decision is
 *          accepted and again needs an independent second reviewer.
 *   T-014  the explicit, idempotent, audited re-evaluation of pre-existing
 *          rounds held only by automatic escalations.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { placeInCollaborationTeam } from "./support/place-in-collaboration-team.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let requiredLegalVersions: Record<string, unknown>;
let ensurePersonalWorkspace: typeof import("../src/services/platform-context/workspace-bootstrap.service.js").ensurePersonalWorkspace;
let reevaluate: typeof import("../src/services/reviewer-ops/second-review-reevaluation.service.js").reevaluateSecondReviewPolicyHolds;

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
async function newUser(label: string): Promise<Actor> {
  seq += 1;
  const email = `trem-a-${label}-${Date.now()}-${seq}@test.proovra.local`;
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

async function teamWorkspace(owner: Actor): Promise<string> {
  const space = await ensurePersonalWorkspace({ userId: owner.userId });
  const updated = await prisma.entitlement.updateMany({ where: { userId: owner.userId }, data: { plan: "TEAM", active: true } });
  if (updated.count === 0) await prisma.entitlement.create({ data: { userId: owner.userId, plan: "TEAM" } });
  return space.teamId;
}

/** A review already IN_REVIEW and held by `assignee`. */
async function inReview(teamId: string, ownerUserId: string, assignee: string, opts: { hold?: boolean } = {}) {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: { title: `trem-a ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "CREATED", teamId, organizationId: t.organizationId, ownerUserId },
      select: { id: true },
    })
  ).id;
  const workflowId = (
    await prisma.evidenceReviewWorkflow.create({
      data: { evidenceId, teamId, status: "IN_REVIEW", workspaceType: "TEAM", assignedToUserId: assignee, assignedAtUtc: new Date() } as never,
      select: { id: true },
    })
  ).id;
  if (opts.hold) {
    await prisma.evidenceLegalHold.create({
      data: { scope: "EVIDENCE", evidenceId, teamId, status: "ACTIVE", title: "Hold", placedByUserId: ownerUserId } as never,
    });
  }
  return { evidenceId, workflowId };
}

/** Exactly what the reconcile sweep writes (reviewer-operations-engine runReconcile). */
async function automaticOverdueEscalation(teamId: string, workflowId: string, evidenceId: string, createdAt?: Date) {
  return prisma.reviewEscalation.create({
    data: {
      teamId,
      workflowId,
      evidenceId,
      reason: "REVIEW_OVERDUE",
      severity: "HIGH",
      status: "OPEN",
      safeSummary: "Review past due — automatic escalation by reviewer ops reconcile.",
      createdByUserId: null,
      fingerprint: randomUUID(),
      ...(createdAt ? { createdAt } : {}),
    } as never,
  });
}

const ops = (teamId: string) => ({
  reject: (a: Actor, wf: string, note = "custody gap") =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/reject`, { teamId, note }),
  approve: (a: Actor, wf: string, note = "looks complete") =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/approve`, { teamId, note }),
  decide: (a: Actor, wf: string, decision: string, rationale = `why ${decision}`) =>
    call(a.token, "POST", `/v1/reviewer-ops/workspace/${wf}/decisions`, { teamId, decision, rationale }),
  lineage: (a: Actor, wf: string) => call(a.token, "GET", `/v1/reviewer-ops/workspace/${wf}/decisions?teamId=${teamId}`),
  workspace: (a: Actor, wf: string) => call(a.token, "GET", `/v1/reviewer-ops/workspace/${wf}?teamId=${teamId}`),
  escalate: (a: Actor, wf: string, reason = "INTEGRITY_RISK", severity = "HIGH") =>
    call(a.token, "POST", "/v1/reviewer-ops/escalations", { teamId, workflowId: wf, reason, severity, safeSummary: "Hash mismatch on upload" }),
  resolveEsc: (a: Actor, id: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/escalations/${id}/resolve`, { teamId, resolutionNote: "checked" }),
  suppressEsc: (a: Actor, id: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/escalations/${id}/suppress`, { teamId, suppressionReason: "noise" }),
  reassign: (a: Actor, wf: string, to: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/reassign`, { teamId, newAssigneeUserId: to }),
});

const wfRow = (id: string) => prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id } });
const deliveries = (evidenceId: string, eventType: string) =>
  prisma.notificationDelivery.findMany({ where: { evidenceId, eventType }, select: { recipientUserId: true } });

let S: { teamId: string; owner: Actor };
let T: { teamId: string; owner: Actor; admin: Actor; member: Actor; member2: Actor };

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ REQUIRED_LEGAL_VERSIONS: requiredLegalVersions } = await import("../src/legal/legal-versioning.js"));
  ({ ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js"));
  ({ reevaluateSecondReviewPolicyHolds: reevaluate } = await import(
    "../src/services/reviewer-ops/second-review-reevaluation.service.js"
  ));

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
  await placeInCollaborationTeam(prisma, {
    workspaceId: teamId,
    createdByUserId: owner.userId,
    userIds: [admin.userId, member.userId, member2.userId],
  });
  T = { teamId, owner, admin, member, member2 };
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe("T-013 — the trigger policy", () => {
  it("an automatic overdue escalation alone does not force a second review: the owner's reject finishes the review", async () => {
    const o = ops(S.teamId);
    const r = await inReview(S.teamId, S.owner.userId, S.owner.userId);
    const esc = await automaticOverdueEscalation(S.teamId, r.workflowId, r.evidenceId);
    const res = await o.reject(S.owner, r.workflowId, "chain of custody gap");
    expect(res.status, res.raw).toBe(200);
    expect(res.body.outcome).toMatchObject({ stageRecorded: "FIRST", statusChanged: true, reviewState: "resolved", nextRequirement: null });
    const row = await wfRow(r.workflowId);
    expect(String(row.status)).toBe("REJECTED_INSUFFICIENT");
    expect(row.rejectionReason).toBe("chain of custody gap");
    // PROOVRA resolves what was raised about a finished review.
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: esc.id } })).status).toBe("RESOLVED");
    // A first-only decision is never announced as needing a second reviewer.
    expect(await deliveries(r.evidenceId, "REVIEW_SECOND_REVIEWER_UNAVAILABLE")).toHaveLength(0);
  });

  it("a legal hold still forces it", async () => {
    const o = ops(S.teamId);
    const r = await inReview(S.teamId, S.owner.userId, S.owner.userId, { hold: true });
    const res = await o.reject(S.owner, r.workflowId);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.outcome).toMatchObject({ stageRecorded: "FIRST", nextRequirement: "second_review" });
    expect(String((await wfRow(r.workflowId)).status)).toBe("IN_REVIEW");
  });
});

describe("T-015 / T-160 / T-016 — a person's escalation in a one-person workspace", () => {
  it("states the requirement and the missing reviewer before and after submission, tells the owner once, and the owner cannot lift it", async () => {
    const o = ops(S.teamId);
    const r = await inReview(S.teamId, S.owner.userId, S.owner.userId);
    const raised = await o.escalate(S.owner, r.workflowId);
    expect(raised.status, raised.raw).toBe(201);
    expect(raised.body.escalation.forcesIndependentReview).toBe(true);
    const escId = raised.body.escalation.id as string;

    // BEFORE submission: the requirement, its cause and nobody eligible.
    const before = await o.lineage(S.owner, r.workflowId);
    expect(before.status, before.raw).toBe(200);
    expect(before.body.secondReview).toMatchObject({
      required: true,
      cause: "open_escalation",
      escalation: { reason: "INTEGRITY_RISK", severity: "HIGH" },
      eligibleReviewerCount: 0,
      staffing: "no_eligible_second_reviewer",
    });

    const first = await o.reject(S.owner, r.workflowId, "hash mismatch");
    expect(first.status, first.raw).toBe(200);
    expect(first.body.outcome).toMatchObject({
      stageRecorded: "FIRST",
      statusChanged: false,
      nextRequirement: "second_review",
      secondReview: { cause: "open_escalation", eligibleReviewerCount: 0, staffing: "no_eligible_second_reviewer" },
    });
    expect(String((await wfRow(r.workflowId)).status)).toBe("IN_REVIEW");

    // T-160 — the owner is told, once per round (a replay sends nothing more).
    expect((await deliveries(r.evidenceId, "REVIEW_SECOND_REVIEWER_UNAVAILABLE")).map((d) => d.recipientUserId)).toEqual([
      S.owner.userId,
    ]);
    expect((await o.reject(S.owner, r.workflowId, "hash mismatch")).body.outcome).toMatchObject({ idempotent: true });
    expect(await deliveries(r.evidenceId, "REVIEW_SECOND_REVIEWER_UNAVAILABLE")).toHaveLength(1);

    // T-016 — the assignee and first reviewer cannot resolve or suppress it.
    const resolved = await o.resolveEsc(S.owner, escId);
    expect(resolved.status, resolved.raw).toBe(403);
    expect(resolved.body.error.details.reason).toBe("resolver_is_assignee");
    const suppressed = await o.suppressEsc(S.owner, escId);
    expect(suppressed.status, suppressed.raw).toBe(403);
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: escId } })).status).toBe("OPEN");
    expect(
      await prisma.adminAuditLog.count({ where: { resourceId: escId, action: "reviewer.escalation.resolve_refused" } }),
    ).toBe(1);
    // ...and the requirement still stands.
    const after = await o.lineage(S.owner, r.workflowId);
    expect(after.body.state).toBe("second_required");
    expect(after.body.callerContext.nextAction).toBe("blocked_same_reviewer");
  });
});

describe("T-016 / T-017 — in a team", () => {
  it("only an independent owner or admin resolves the forcing escalation, and resolving it finalises nothing", async () => {
    const o = ops(T.teamId);
    const r = await inReview(T.teamId, T.owner.userId, T.member.userId);
    const raised = await o.escalate(T.member, r.workflowId);
    expect(raised.status, raised.raw).toBe(201);
    const escId = raised.body.escalation.id as string;
    const first = await o.reject(T.member, r.workflowId, "unexplained gap");
    expect(first.body.outcome).toMatchObject({
      stageRecorded: "FIRST",
      nextRequirement: "second_review",
      secondReview: { staffing: "ok" },
    });
    expect(first.body.outcome.secondReview.eligibleReviewerCount).toBeGreaterThanOrEqual(2);

    // The member (assignee, first reviewer, not an owner or admin) is refused.
    const byMember = await o.resolveEsc(T.member, escId);
    expect(byMember.status, byMember.raw).toBe(403);
    expect(byMember.body.error.details.reason).toBe("independent_resolver_required");

    // An independent admin may resolve it...
    const byAdmin = await o.resolveEsc(T.admin, escId);
    expect(byAdmin.status, byAdmin.raw).toBe(200);
    // ...but the recorded FIRST verdict still waits for its second reviewer:
    // never "resolved" while the review is in review, never finalised.
    const row = await wfRow(r.workflowId);
    expect(String(row.status)).toBe("IN_REVIEW");
    expect(row.rejectionReason).toBeNull();
    const lineage = await o.lineage(T.owner, r.workflowId);
    expect(lineage.body.state).toBe("second_required");
    expect((await o.workspace(T.owner, r.workflowId)).body.handoff).toMatchObject({ requirement: "second_review" });
    // The first reviewer still cannot decide again.
    const again = await o.approve(T.member, r.workflowId);
    expect(again.status).toBe(409);
    // The hand-off completes it.
    expect((await o.reassign(T.owner, r.workflowId, T.member2.userId)).status).toBe(200);
    const second = await o.reject(T.member2, r.workflowId, "confirmed gap");
    expect(second.status, second.raw).toBe(200);
    expect(second.body.outcome).toMatchObject({ stageRecorded: "SECOND", reviewState: "resolved" });
    expect(String((await wfRow(r.workflowId)).status)).toBe("REJECTED_INSUFFICIENT");
    // The hand-off assignee was told what it is (T-159).
    expect((await deliveries(r.evidenceId, "REVIEW_SECOND_REVIEW_ASSIGNED")).map((d) => d.recipientUserId)).toEqual([
      T.member2.userId,
    ]);
    // The governing requirement is described from the record (T-022).
    const done = await o.lineage(T.owner, r.workflowId);
    expect(done.body.governing).toMatchObject({ reviewers: 2, secondReviewRequired: true, cause: "open_escalation" });
  });
});

describe("T-011 / T-018 — conflict and an unresolved adjudication", () => {
  it("refuses a plain verdict as adjudication, and UNRESOLVED opens a new round whose decision is accepted", async () => {
    const o = ops(T.teamId);
    const r = await inReview(T.teamId, T.owner.userId, T.member.userId, { hold: true });
    expect((await o.approve(T.member, r.workflowId)).body.outcome).toMatchObject({ nextRequirement: "second_review" });
    expect((await o.reassign(T.owner, r.workflowId, T.member2.userId)).status).toBe(200);
    expect((await o.reject(T.member2, r.workflowId)).body.outcome).toMatchObject({ nextRequirement: "adjudication" });

    // T-011 — the owner (no party) sends a plain REJECT through the adjudication door.
    const plain = await o.decide(T.owner, r.workflowId, "REJECT");
    expect(plain.status, plain.raw).toBe(409);
    expect(plain.body.error.details.reason).toBe("use_adjudication");
    expect(await prisma.workflowReviewDecision.count({ where: { workflowId: r.workflowId, stage: "ADJUDICATION" } })).toBe(0);

    // T-018 — UNRESOLVED is recorded and leaves a defined next step.
    const unresolved = await o.decide(T.owner, r.workflowId, "UNRESOLVED", "Both readings are plausible");
    expect(unresolved.status, unresolved.raw).toBe(201);
    const next = await o.lineage(T.owner, r.workflowId);
    expect(next.body.state).toBe("first_required");
    expect(next.body.round).toBe(1);
    expect(next.body.continuedFrom).toBe("unresolved_adjudication");
    expect(next.body.secondReview).toMatchObject({ required: true, cause: "unresolved_adjudication" });
    expect(next.body.rounds[0]).toMatchObject({ round: 0, settledBy: "unresolved_adjudication" });
    // The current assignee records the first decision of the new round.
    const fresh = await o.decide(T.member2, r.workflowId, "APPROVE", "Re-read with the new context");
    expect(fresh.status, fresh.raw).toBe(201);
    expect(fresh.body.outcome).toMatchObject({ stageRecorded: "FIRST", nextRequirement: "second_review" });
    expect((await wfRow(r.workflowId)).decisionRound).toBe(1);
    // The earlier round stays visible (T-023).
    const history = await o.lineage(T.owner, r.workflowId);
    expect(history.body.rounds.map((x: { round: number }) => x.round)).toEqual([0, 1]);
    expect(history.body.rounds[0].decisions.map((d: { stage: string }) => d.stage)).toEqual(["FIRST", "SECOND", "ADJUDICATION"]);
  });
});

describe("T-014 — explicit re-evaluation of rounds held only by automatic escalations", () => {
  /** The shape the decision authority wrote before T-013: no recorded cause. */
  async function legacyFirstDecision(teamId: string, wf: { workflowId: string; evidenceId: string }, reviewer: string, decidedAt: Date) {
    await prisma.workflowReviewDecision.create({
      data: { workflowId: wf.workflowId, teamId, stage: "FIRST", round: 0, reviewerUserId: reviewer, decision: "REJECT", rationale: "legacy gap", decidedAt },
    });
    await prisma.evidenceReviewWorkflowEvent.create({
      data: {
        workflowId: wf.workflowId,
        evidenceId: wf.evidenceId,
        actorUserId: reviewer,
        eventType: "DECISION_LOGGED",
        previousValue: { stage: "IN_REVIEW" },
        nextValue: { stage: "IN_REVIEW", decisionStage: "FIRST", round: 0, decision: "REJECT", state: "second_required" },
        createdAt: decidedAt,
      } as never,
    });
  }

  it("dry-runs, applies once with an audit row, never touches a round a person's escalation held, and is idempotent", async () => {
    const o = ops(S.teamId);
    const t0 = new Date(Date.now() - 3 * 3600_000);
    const held = await inReview(S.teamId, S.owner.userId, S.owner.userId);
    await automaticOverdueEscalation(S.teamId, held.workflowId, held.evidenceId, new Date(t0.getTime() - 60_000));
    await legacyFirstDecision(S.teamId, held, S.owner.userId, t0);

    // Control: a person's escalation was active when the decision was made.
    const manual = await inReview(S.teamId, S.owner.userId, S.owner.userId);
    const m = await prisma.reviewEscalation.create({
      data: {
        teamId: S.teamId,
        workflowId: manual.workflowId,
        evidenceId: manual.evidenceId,
        reason: "INTEGRITY_RISK",
        severity: "HIGH",
        status: "RESOLVED",
        safeSummary: "x",
        createdByUserId: S.owner.userId,
        fingerprint: randomUUID(),
        createdAt: new Date(t0.getTime() - 60_000),
        resolvedAtUtc: new Date(t0.getTime() + 60_000),
      } as never,
    });
    expect(m.id).toBeTruthy();
    await legacyFirstDecision(S.teamId, manual, S.owner.userId, t0);

    // Before: the legacy round is not silently finalised by any reader.
    expect((await o.lineage(S.owner, held.workflowId)).body.state).toBe("second_required");

    const dry = await reevaluate({ teamId: S.teamId, dryRun: true });
    expect(dry.rows.find((x) => x.workflowId === held.workflowId)).toMatchObject({ outcome: "would_reevaluate" });
    expect(dry.rows.find((x) => x.workflowId === manual.workflowId)).toMatchObject({ outcome: "forcing_cause_at_decision" });
    expect(String((await wfRow(held.workflowId)).status)).toBe("IN_REVIEW");

    const run = await reevaluate({ teamId: S.teamId, dryRun: false });
    expect(run.rows.find((x) => x.workflowId === held.workflowId)).toMatchObject({ outcome: "reevaluated", toStage: "REJECTED_INSUFFICIENT" });
    const row = await wfRow(held.workflowId);
    expect(String(row.status)).toBe("REJECTED_INSUFFICIENT");
    expect(row.rejectionReason).toBe("legacy gap");
    expect(await prisma.workflowReviewDecision.count({ where: { workflowId: held.workflowId } })).toBe(1);
    expect(
      await prisma.adminAuditLog.count({ where: { resourceId: held.workflowId, action: "reviewer.second_review_policy.reevaluated" } }),
    ).toBe(1);
    expect((await o.lineage(S.owner, held.workflowId)).body.state).toBe("resolved");
    expect(String((await wfRow(manual.workflowId)).status)).toBe("IN_REVIEW");

    const again = await reevaluate({ teamId: S.teamId, dryRun: false });
    expect(again.reevaluated).toBe(0);
    expect(
      await prisma.adminAuditLog.count({ where: { resourceId: held.workflowId, action: "reviewer.second_review_policy.reevaluated" } }),
    ).toBe(1);
  });
});
