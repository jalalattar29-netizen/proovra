/**
 * TEAM-SPEC R3 (2026-11-23) — the second-review / adjudication HANDOFF against
 * a real PostgreSQL and the real routes.
 *
 *   - queue slices AWAITING_SECOND_REVIEW / AWAITING_ADJUDICATION (projection,
 *     paging, reach) and the console aggregator's handoff sections;
 *   - the workspace projection's `handoff` block (requirement, first reviewer,
 *     eligible count from THE assignee authority, staffing);
 *   - the inbox "Assign an independent second reviewer" item for assignment
 *     managers only (never the first reviewer), gone after reassignment;
 *   - REVIEW_SECOND_REVIEW_REQUIRED written once per manager (holders of
 *     review.assign), never to the first reviewer, never again on a replay;
 *   - a single-occupant TEAM personal workspace: the owner's FIRST decision
 *     stands as FIRST only, staffing = no_eligible_reviewer, deciding again and
 *     reassigning to self are refused, and nothing reduces the requirement;
 *   - adjudication staffing when no independent OWNER/ADMIN exists.
 *
 * Every assertion that matters reads persisted rows.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { placeInCollaborationTeam } from "./support/place-in-collaboration-team.js";
import { expectFaithfulInboxMessages } from "./helpers/inbox-message-fidelity.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let requiredLegalVersions: Record<string, unknown>;
// Loaded in beforeAll, after the harness has pointed the app at the test DB.
let renderTransactionalTemplate: typeof import("../src/services/notifications/templates.js")["renderTransactionalTemplate"];
let classifyCurrentRounds: typeof import("../src/services/reviewer-ops/review-handoff.service.js")["classifyCurrentRounds"];
let loadCurrentRoundDecisionState: typeof import("../src/services/reviewer-ops/review-decision.service.js")["loadCurrentRoundDecisionState"];
let reviewEmailLink: typeof import("../src/services/review-operations/review-notifications.service.js")["reviewEmailLink"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route bodies are asserted field by field
type Res = { status: number; body: any; raw: string };
type Actor = { userId: string; token: string };

let T: { teamId: string; owner: Actor; admin: Actor; member: Actor; member2: Actor; viewer: Actor };
let S: { teamId: string; owner: Actor };

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
  return { status: res.statusCode, body, raw: res.body };
}

let seq = 0;
async function newUser(label: string): Promise<Actor> {
  seq += 1;
  const email = `trh-${label}-${Date.now()}-${seq}@test.proovra.local`;
  const user = await prisma.user.create({
    data: { email, firstName: "TRH", lastName: label, displayName: `TRH ${label}`, provider: "EMAIL", providerUserId: email },
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

async function teamPersonalWorkspace(owner: Actor): Promise<string> {
  const { ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js");
  const space = await ensurePersonalWorkspace({ userId: owner.userId });
  const updated = await prisma.entitlement.updateMany({ where: { userId: owner.userId }, data: { plan: "TEAM", active: true } });
  if (updated.count === 0) await prisma.entitlement.create({ data: { userId: owner.userId, plan: "TEAM" } });
  return space.teamId;
}

/** A review whose evidence is under an ACTIVE legal hold, so a second review is required. */
async function heldWorkflow(teamId: string, ownerUserId: string, title: string) {
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
  await prisma.evidenceLegalHold.create({
    data: { scope: "EVIDENCE", evidenceId, teamId, status: "ACTIVE", title: "Hold", placedByUserId: ownerUserId } as never,
  });
  return { evidenceId, workflowId };
}

const ops = (teamId: string) => ({
  assign: (a: Actor, wf: string, to: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/assign`, { teamId, assignedToUserId: to }),
  reassign: (a: Actor, wf: string, to: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/reassign`, { teamId, newAssigneeUserId: to }),
  start: (a: Actor, wf: string) => call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/start`, { teamId }),
  approve: (a: Actor, wf: string) => call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/approve`, { teamId, note: "Looks complete" }),
  reject: (a: Actor, wf: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/reject`, { teamId, note: "custody gap" }),
  decide: (a: Actor, wf: string, decision: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/workspace/${wf}/decisions`, { teamId, decision, rationale: `why ${decision}` }),
  workspace: (a: Actor, wf: string) => call(a.token, "GET", `/v1/reviewer-ops/workspace/${wf}?teamId=${teamId}`),
  queue: (a: Actor, queue: string, extra = "") =>
    call(a.token, "GET", `/v1/reviewer-ops/queue?teamId=${teamId}&queue=${queue}${extra}`),
  console: (a: Actor) => call(a.token, "GET", `/v1/reviewer-ops/console?teamId=${teamId}`),
});

const queueIds = (res: Res): string[] => (res.body.rows as Array<{ workflowId: string }>).map((r) => r.workflowId);
const wfRow = (id: string) => prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id } });
const secondReviewMails = (evidenceId: string) =>
  prisma.notificationDelivery.findMany({
    where: { eventType: "REVIEW_SECOND_REVIEW_REQUIRED", evidenceId },
    select: { recipientUserId: true, status: true, templateKey: true },
  });

async function inboxItems(a: Actor): Promise<Array<{ itemKey?: string; id?: string; href?: string; context?: Record<string, unknown> }>> {
  const res = await call(a.token, "GET", "/v1/me/inbox?pageSize=100");
  expect(res.status, res.raw).toBe(200);
  expectFaithfulInboxMessages(res.body.items as never);
  return res.body.items;
}
const keyOf = (i: { itemKey?: string; id?: string }) => i.itemKey ?? i.id ?? "";
async function inboxKeys(a: Actor): Promise<string[]> {
  return (await inboxItems(a)).map(keyOf);
}

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ REQUIRED_LEGAL_VERSIONS: requiredLegalVersions } = await import("../src/legal/legal-versioning.js"));
  ({ renderTransactionalTemplate } = await import("../src/services/notifications/templates.js"));
  ({ classifyCurrentRounds } = await import("../src/services/reviewer-ops/review-handoff.service.js"));
  ({ loadCurrentRoundDecisionState } = await import("../src/services/reviewer-ops/review-decision.service.js"));
  ({ reviewEmailLink } = await import("../src/services/review-operations/review-notifications.service.js"));

  const owner = await newUser("owner");
  const teamId = await teamPersonalWorkspace(owner);
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
    await prisma.teamMember.create({ data: { teamId, userId: u.userId, role, status: "ACTIVE" } });
  }
  await placeInCollaborationTeam(prisma, {
    workspaceId: teamId,
    createdByUserId: owner.userId,
    userIds: [admin.userId, member.userId, member2.userId, viewer.userId],
  });
  T = { teamId, owner, admin, member, member2, viewer };

  const solo = await newUser("solo");
  S = { teamId: await teamPersonalWorkspace(solo), owner: solo };
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe("second-review handoff — queue slice, handoff block, notification", () => {
  it("a FIRST decision under a second-review requirement is discoverable and tells the assignment managers once", async () => {
    const o = ops(T.teamId);
    const a = await heldWorkflow(T.teamId, T.owner.userId, "trh-a");
    const b = await heldWorkflow(T.teamId, T.owner.userId, "trh-b");
    const plain = await heldWorkflow(T.teamId, T.owner.userId, "trh-undecided");

    // A — the MEMBER is the first reviewer.
    expect((await o.assign(T.admin, a.workflowId, T.member.userId)).status).toBe(200);
    expect((await o.start(T.member, a.workflowId)).status).toBe(200);
    const first = await o.approve(T.member, a.workflowId);
    expect(first.status, first.raw).toBe(200);
    expect(first.body.outcome).toMatchObject({ stageRecorded: "FIRST", nextRequirement: "second_review", idempotent: false });

    // B — the ADMIN (who holds review.assign) is the first reviewer.
    expect((await o.assign(T.owner, b.workflowId, T.admin.userId)).status).toBe(200);
    expect((await o.start(T.admin, b.workflowId)).status).toBe(200);
    expect((await o.approve(T.admin, b.workflowId)).body.outcome).toMatchObject({ nextRequirement: "second_review" });

    // plain — assigned, nothing decided.
    expect((await o.assign(T.owner, plain.workflowId, T.member2.userId)).status).toBe(200);

    // Notification rows: once per assignment manager (OWNER + ADMIN hold
    // review.assign; a MEMBER does not), never the first reviewer.
    const mailsA = await secondReviewMails(a.evidenceId);
    expect(mailsA.map((m) => m.recipientUserId).sort()).toEqual([T.owner.userId, T.admin.userId].sort());
    expect(mailsA.every((m) => m.templateKey === "REVIEW_SECOND_REVIEW_REQUIRED")).toBe(true);
    const mailsB = await secondReviewMails(b.evidenceId);
    expect(mailsB.map((m) => m.recipientUserId)).toEqual([T.owner.userId]);
    // A replay notifies nobody.
    expect((await o.approve(T.member, a.workflowId)).body.outcome).toMatchObject({ idempotent: true });
    expect(await secondReviewMails(a.evidenceId)).toHaveLength(2);
    expect(await secondReviewMails(plain.evidenceId)).toHaveLength(0);
    // The email links to the review inspector.
    const rendered = renderTransactionalTemplate("REVIEW_SECOND_REVIEW_REQUIRED", {
      kind: "ReviewAssigned",
      data: {
        workspaceName: "W",
        requestTitle: "Evidence x",
        reviewerName: null,
        requestUrl: reviewEmailLink({ id: a.workflowId, evidenceId: a.evidenceId }),
      },
    } as never) as { subject: string; html: string };
    expect(rendered.subject).toContain("Second review required");
    expect(rendered.html).toContain(`/reviewer-ops/${a.workflowId}`);

    // Queue slice: both awaiting workflows, not the undecided one; paging works.
    const awaiting = await o.queue(T.admin, "AWAITING_SECOND_REVIEW");
    expect(awaiting.status, awaiting.raw).toBe(200);
    expect(queueIds(awaiting)).toEqual(expect.arrayContaining([a.workflowId, b.workflowId]));
    expect(queueIds(awaiting)).not.toContain(plain.workflowId);
    expect(awaiting.body.rows[0]).toHaveProperty("lifecycleState");
    expect(queueIds(await o.queue(T.admin, "AWAITING_ADJUDICATION"))).not.toContain(a.workflowId);
    const page1 = await o.queue(T.admin, "AWAITING_SECOND_REVIEW", "&limit=1");
    expect(page1.body.rows).toHaveLength(1);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await o.queue(T.admin, "AWAITING_SECOND_REVIEW", `&limit=1&cursor=${page1.body.nextCursor}`);
    expect(page2.body.rows).toHaveLength(1);
    expect(queueIds(page2)).not.toEqual(queueIds(page1));
    expect([...queueIds(page1), ...queueIds(page2)].sort()).toEqual([a.workflowId, b.workflowId].sort());
    expect((await o.queue(T.admin, "AWAITING_NOTHING")).status).toBe(400);

    // Console aggregator section.
    const consoleRes = await o.console(T.admin);
    expect(consoleRes.status, consoleRes.raw).toBe(200);
    expect(consoleRes.body.awaitingSecondReview.status).toBe("ok");
    expect(consoleRes.body.awaitingSecondReview.count).toBe(2);
    expect(consoleRes.body.awaitingAdjudication.count).toBe(0);

    // Handoff block: OWNER, ADMIN and MEMBER2 can take the second review (the
    // VIEWER lacks the decision permission; the first reviewer is excluded).
    const adminView = await o.workspace(T.admin, a.workflowId);
    expect(adminView.status, adminView.raw).toBe(200);
    expect(adminView.body.handoff).toEqual({
      requirement: "second_review",
      firstReviewerUserId: T.member.userId,
      firstReviewerDisplayName: "TRH member",
      // T-086 / E2E-08 — masked, never the full address.
      firstReviewerMaskedEmail: expect.stringMatching(/^[^@]\*\*\*@[^@]+$/),
      secondReviewerUserId: null,
      awaitingAssignment: true,
      eligibleReviewerCount: 3,
      staffing: "ok",
    });
    // Review remediation (F-36): with no requirement there is nothing to staff.
    expect((await o.workspace(T.admin, plain.workflowId)).body.handoff).toMatchObject({
      requirement: null,
      staffing: "not_required",
      eligibleReviewerCount: 0,
    });

    // Inbox: the assignment managers get an actionable item; the first
    // reviewer and a member without review.assign do not.
    const itemA = `review_decision:assign_second:${a.workflowId}:0`;
    const adminItem = (await inboxItems(T.admin)).find((i) => keyOf(i) === itemA);
    expect(adminItem, "admin sees the hand-off item").toBeTruthy();
    expect(adminItem!.href).toBe(`/reviewer-ops/${a.workflowId}`);
    expect(adminItem!.context).toMatchObject({ workflowId: a.workflowId, teamId: T.teamId });
    expect(await inboxKeys(T.owner)).toContain(itemA);
    expect(await inboxKeys(T.member)).not.toContain(itemA);
    expect(await inboxKeys(T.member2)).not.toContain(itemA);
    // The admin is B's first reviewer: no hand-off item for B for them; the owner gets it.
    expect(await inboxKeys(T.admin)).not.toContain(`review_decision:assign_second:${b.workflowId}:0`);
    expect(await inboxKeys(T.owner)).toContain(`review_decision:assign_second:${b.workflowId}:0`);

    // Reassignment to an independent reviewer completes the handoff.
    expect((await o.reassign(T.admin, a.workflowId, T.member2.userId)).status).toBe(200);
    expect((await o.workspace(T.admin, a.workflowId)).body.handoff).toMatchObject({
      requirement: "second_review",
      awaitingAssignment: false,
    });
    expect(await inboxKeys(T.admin)).not.toContain(itemA);
    expect(await inboxKeys(T.owner)).not.toContain(itemA);

    // SECOND disagrees → conflict → adjudication handoff.
    const second = await o.reject(T.member2, a.workflowId);
    expect(second.status, second.raw).toBe(200);
    expect(second.body.outcome).toMatchObject({ stageRecorded: "SECOND", nextRequirement: "adjudication" });
    expect((await o.workspace(T.member, a.workflowId)).body.handoff).toMatchObject({
      requirement: "adjudication",
      firstReviewerUserId: T.member.userId,
      secondReviewerUserId: T.member2.userId,
      eligibleReviewerCount: 2,
      staffing: "ok",
    });
    expect(queueIds(await o.queue(T.admin, "AWAITING_ADJUDICATION"))).toContain(a.workflowId);
    expect(queueIds(await o.queue(T.admin, "AWAITING_SECOND_REVIEW"))).not.toContain(a.workflowId);
    // The conflict sent no further second-review mail.
    expect(await secondReviewMails(a.evidenceId)).toHaveLength(2);
  });

  it("with no independent OWNER/ADMIN left, adjudication stays pending with a staffing explanation", async () => {
    const o = ops(T.teamId);
    const c = await heldWorkflow(T.teamId, T.owner.userId, "trh-no-adjudicator");
    expect((await o.assign(T.owner, c.workflowId, T.admin.userId)).status).toBe(200);
    expect((await o.start(T.admin, c.workflowId)).status).toBe(200);
    expect((await o.approve(T.admin, c.workflowId)).status).toBe(200);
    expect((await o.reassign(T.admin, c.workflowId, T.owner.userId)).status).toBe(200);
    const second = await o.reject(T.owner, c.workflowId);
    expect(second.body.outcome).toMatchObject({ reviewState: "conflict_detected", nextRequirement: "adjudication" });

    const view = await o.workspace(T.member2, c.workflowId);
    expect(view.body.handoff).toMatchObject({
      requirement: "adjudication",
      eligibleReviewerCount: 0,
      staffing: "no_eligible_adjudicator",
    });
    // Neither participant can adjudicate; the review stays pending.
    for (const actor of [T.owner, T.admin]) {
      const res = await o.decide(actor, c.workflowId, "UPHOLD_FIRST");
      expect(res.status, res.raw).toBe(409);
      expect(res.body.error.code).toBe("adjudicator_not_independent");
    }
    expect((await wfRow(c.workflowId)).status).toBe("ESCALATED");
    expect(await prisma.workflowReviewDecision.count({ where: { workflowId: c.workflowId, stage: "ADJUDICATION" } })).toBe(0);
  });
});

describe("single-occupant TEAM personal workspace", () => {
  it("the owner's FIRST decision stands as FIRST only; nobody can be the second reviewer and nothing waives it", async () => {
    const o = ops(S.teamId);
    const w = await heldWorkflow(S.teamId, S.owner.userId, "trh-solo");
    const assigned = await o.assign(S.owner, w.workflowId, S.owner.userId);
    expect(assigned.status, assigned.raw).toBe(200);
    expect((await o.start(S.owner, w.workflowId)).status).toBe(200);

    const first = await o.approve(S.owner, w.workflowId);
    expect(first.status, first.raw).toBe(200);
    expect(first.body.outcome).toMatchObject({
      stageRecorded: "FIRST",
      statusChanged: false,
      reviewState: "second_required",
      nextRequirement: "second_review",
      idempotent: false,
    });

    const view = await o.workspace(S.owner, w.workflowId);
    expect(view.status, view.raw).toBe(200);
    expect(view.body.handoff).toEqual({
      requirement: "second_review",
      firstReviewerUserId: S.owner.userId,
      firstReviewerDisplayName: "TRH solo",
      // T-086 / E2E-08 — masked, never the full address.
      firstReviewerMaskedEmail: expect.stringMatching(/^[^@]\*\*\*@[^@]+$/),
      secondReviewerUserId: null,
      awaitingAssignment: true,
      eligibleReviewerCount: 0,
      staffing: "no_eligible_reviewer",
    });
    const approveAction = (view.body.viewer.actions as Array<{ action: string; reason?: string }>).find(
      (x) => x.action === "approve",
    );
    expect(approveAction?.reason).toBe("same_reviewer_blocked");

    // Deciding again is refused, through either door.
    const again = await o.reject(S.owner, w.workflowId);
    expect(again.status, again.raw).toBe(409);
    expect(again.body.error.details.reason).toBe("same_reviewer_blocked");
    const viaDoor = await o.decide(S.owner, w.workflowId, "REJECT");
    expect(viaDoor.status).toBe(409);
    expect(viaDoor.body.error.code).toBe("same_reviewer_blocked");
    // An identical approve is only the idempotent replay of the FIRST decision.
    expect((await o.approve(S.owner, w.workflowId)).body.outcome).toMatchObject({ idempotent: true, stageRecorded: "FIRST" });
    // Reassigning to self is refused.
    const self = await o.reassign(S.owner, w.workflowId, S.owner.userId);
    expect(self.status, self.raw).toBe(422);
    expect(self.body.error.details.reason).toBe("second_reviewer_not_independent");

    // Persisted: one FIRST decision, the review still open and pending.
    const log = await prisma.workflowReviewDecision.findMany({ where: { workflowId: w.workflowId } });
    expect(log.map((d) => [d.stage, d.decision, d.reviewerUserId])).toEqual([["FIRST", "APPROVE", S.owner.userId]]);
    const row = await wfRow(w.workflowId);
    expect(row.status).toBe("IN_REVIEW");
    expect(row.completedAtUtc).toBeNull();
    expect(row.assignedToUserId).toBe(S.owner.userId);
    // The only manager is the first reviewer: nobody is mailed.
    expect(await secondReviewMails(w.evidenceId)).toHaveLength(0);
    // Still discoverable as awaiting a second reviewer.
    expect(queueIds(await o.queue(S.owner, "AWAITING_SECOND_REVIEW"))).toContain(w.workflowId);
  });
});

describe("batched current-round classification", () => {
  it("equals loadCurrentRoundDecisionState row for row, including the request-for-information rounds", async () => {
    const o = ops(T.teamId);
    // A request for information (a workflow action — no decision row), the
    // review still waiting for it, and a legal hold placed afterwards.
    const t = await prisma.team.findUniqueOrThrow({ where: { id: T.teamId }, select: { organizationId: true } });
    async function plainWorkflow(title: string) {
      const evidenceId = (
        await prisma.evidence.create({
          data: { title, type: "PHOTO", status: "CREATED", teamId: T.teamId, organizationId: t.organizationId, ownerUserId: T.owner.userId },
          select: { id: true },
        })
      ).id;
      const workflowId = (
        await prisma.evidenceReviewWorkflow.create({
          data: { evidenceId, teamId: T.teamId, status: "NOT_STARTED", workspaceType: "TEAM" },
          select: { id: true },
        })
      ).id;
      return { evidenceId, workflowId };
    }
    const settled = await plainWorkflow("trh-eq-settled");
    expect((await o.assign(T.owner, settled.workflowId, T.member.userId)).status).toBe(200);
    expect((await o.start(T.member, settled.workflowId)).status).toBe(200);
    const asked = await call(T.member.token, "POST", `/v1/reviewer-ops/reviews/${settled.workflowId}/request-info`, {
      teamId: T.teamId,
      note: "need the original",
    });
    expect(asked.status, asked.raw).toBe(200);
    await prisma.evidenceLegalHold.create({
      data: { scope: "EVIDENCE", evidenceId: settled.evidenceId, teamId: T.teamId, status: "ACTIVE", title: "Late hold", placedByUserId: T.owner.userId } as never,
    });
    // A request-for-information round the review has moved on from (response
    // received): the next submission opens a new round.
    const movedOn = await plainWorkflow("trh-eq-moved-on");
    expect((await o.assign(T.owner, movedOn.workflowId, T.member.userId)).status).toBe(200);
    expect((await o.start(T.member, movedOn.workflowId)).status).toBe(200);
    expect(
      (await call(T.member.token, "POST", `/v1/reviewer-ops/reviews/${movedOn.workflowId}/request-info`, { teamId: T.teamId, note: "need it" })).status,
    ).toBe(200);
    expect(
      (await call(T.member.token, "POST", `/v1/reviewer-ops/reviews/${movedOn.workflowId}/response-received`, { teamId: T.teamId, note: "got it" })).status,
    ).toBe(200);

    // A single-review round, approved with no requirement: resolved.
    const approvedOnce = await plainWorkflow("trh-eq-resolved");
    expect((await o.assign(T.owner, approvedOnce.workflowId, T.member.userId)).status).toBe(200);
    expect((await o.start(T.member, approvedOnce.workflowId)).status).toBe(200);
    expect((await o.approve(T.member, approvedOnce.workflowId)).status).toBe(200);

    const all = await prisma.evidenceReviewWorkflow.findMany({
      where: { teamId: { in: [T.teamId, S.teamId] } },
      select: { id: true, teamId: true, evidenceId: true, status: true, decisionRound: true },
    });
    expect(all.length).toBeGreaterThanOrEqual(7);
    const refs = all.map((w) => ({ ...w, status: String(w.status) }));
    const batched = await classifyCurrentRounds(refs, prisma);
    const states = new Set<string>();
    for (const w of refs) {
      const perRow = await loadCurrentRoundDecisionState({ ...w, teamId: w.teamId! }, prisma);
      expect(batched.get(w.id), `workflow ${w.id} (${w.status})`).toBe(perRow.state);
      states.add(perRow.state);
    }
    // Review remediation (F-04): the request used no decision slot, so the
    // round still awaits its FIRST decision (the late hold will require a
    // second one after it).
    expect(batched.get(settled.workflowId)).toBe("first_required");
    expect(batched.get(movedOn.workflowId)).toBe("first_required");
    // The seeded rows cover every state the slices distinguish.
    for (const st of ["first_required", "second_required", "conflict_detected", "resolved"]) expect(states).toContain(st);
  });
});
