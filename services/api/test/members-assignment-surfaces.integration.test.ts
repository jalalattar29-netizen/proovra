/**
 * EVERY ASSIGNMENT WRITER, OVER HTTP (members re-audit, package B — owner
 * decision 5, 2026-10-25).
 *
 * On PRO and TEAM a non-owner member who is not placed in an ACTIVE
 * Collaboration Team cannot be handed review, queue, escalation, operational
 * or case work; placement is necessary, never sufficient (capability and reach
 * still apply). The one authority is
 * services/assignment/assignee-eligibility.ts (`assertWorkAssigneeEligible`).
 *
 * This suite drives every writer through its real route against a real
 * PostgreSQL — the review console's assign / reassign, claim, bulk ASSIGN,
 * escalation create with a named assignee and escalation reassign, the
 * Operations incident and workflow assign and the Operations bulk sweep, the
 * legacy `PATCH /v1/evidence/:id/reviewer-workflow`, and case assignment — and
 * proves each refuses an unplaced member and accepts a placed eligible one.
 * It also carries the behavioural proofs for re-audit defects 1-5, 10 and 20,
 * ENT-11, REV-05 and SEC-13. The unit suites that `vi.mock` placement-policy
 * point here for the placement proof.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { placeInCollaborationTeam } from "./support/place-in-collaboration-team.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

type Person = { id: string; token: string; memberId: string | null };

describe("every assignment writer obeys the one assignee authority (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let escalations: typeof import("../src/services/reviewer-ops/escalation-engine.service.js");
  let bulk: typeof import("../src/services/dashboard/bulk-actions.service.js");
  let legal: typeof import("../src/legal/legal-versioning.js");
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  const A = () => h.fixtures.teamA;
  const owner = () => A().ownerUserId;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    ({ signJwt } = await import("../src/services/jwt.js"));
    escalations = await import("../src/services/reviewer-ops/escalation-engine.service.js");
    bulk = await import("../src/services/dashboard/bulk-actions.service.js");
    legal = await import("../src/legal/legal-versioning.js");
    stepUp = createStepUpCeremony({ prisma, inject: (o) => h.app.inject(o as never) as never });
    await setPlan("TEAM");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);

  async function setPlan(plan: "FREE" | "PRO" | "TEAM") {
    await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: plan, billingStatus: "ACTIVE" } as never });
  }

  /**
   * PRO and TEAM are sold on a Personal Workspace, whose plan is its owner's
   * entitlement (team A is an ORGANIZATION workspace: its plan is the
   * Organization's, so it can never be on PRO).
   */
  const P = () => h.fixtures.personal;
  async function setPersonalPlan(plan: "FREE" | "PRO" | "TEAM") {
    await prisma.entitlement.updateMany({ where: { userId: P().userId }, data: { active: false } });
    await prisma.entitlement.create({ data: { userId: P().userId, plan, active: true, credits: 0 } });
  }

  async function person(
    role: "ADMIN" | "MEMBER" | "VIEWER" | null,
    opts: { placed?: boolean; workspaceId?: string; workspaceOwnerId?: string } = {},
  ): Promise<Person> {
    const workspaceId = opts.workspaceId ?? A().teamId;
    const workspaceOwnerId = opts.workspaceOwnerId ?? owner();
    const email = `assign-surfaces-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "Assign", lastName: "Surface", provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legal.REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "integration-harness",
      })),
    });
    let memberId: string | null = null;
    if (role) {
      memberId = (
        await prisma.teamMember.create({
          data: { teamId: workspaceId, userId: user.id, role, status: "ACTIVE" },
          select: { id: true },
        })
      ).id;
      if (opts.placed) {
        await placeInCollaborationTeam(prisma, { workspaceId, createdByUserId: workspaceOwnerId, userIds: [user.id] });
      }
    }
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, token, memberId };
  }

  async function restrictedCase(userIds: string[]) {
    const c = await prisma.case.create({
      data: { name: `Restricted ${tag()}`, teamId: A().teamId, ownerUserId: owner() },
      select: { id: true },
    });
    for (const userId of userIds) await prisma.caseAccess.create({ data: { caseId: c.id, userId } });
    return c.id;
  }

  async function workflow(opts: { restrictedTo?: string[]; assignedTo?: string } = {}) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const evidence = await prisma.evidence.create({
      data: {
        title: `Assign ${tag()}`,
        type: "PHOTO",
        status: "CREATED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: owner(),
      } as never,
      select: { id: true },
    });
    let caseId: string | null = null;
    if (opts.restrictedTo) {
      caseId = await restrictedCase(opts.restrictedTo);
      await prisma.caseEvidenceLink.create({ data: { caseId, evidenceId: evidence.id } });
    }
    const wf = await prisma.evidenceReviewWorkflow.create({
      data: {
        teamId: A().teamId,
        evidenceId: evidence.id,
        workspaceType: "TEAM",
        status: (opts.assignedTo ? "ASSIGNED" : "QUEUED") as never,
        assignedToUserId: opts.assignedTo ?? null,
      },
      select: { id: true, evidenceId: true },
    });
    return { workflowId: wf.id, evidenceId: wf.evidenceId, caseId };
  }

  const post = (url: string, token: string, payload: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}`, ...headers }, payload: payload as never });
  const patch = (url: string, token: string, payload: unknown) =>
    h.app.inject({ method: "PATCH", url, headers: { authorization: `Bearer ${token}` }, payload: payload as never });
  const errorCode = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code;
  const assigneeOf = async (workflowId: string) =>
    (await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: workflowId } })).assignedToUserId;

  async function openEscalation(workflowId: string, evidenceId: string) {
    const created = await escalations.createEscalation({
      teamId: A().teamId,
      workflowId,
      evidenceId,
      reason: "REVIEW_OVERDUE",
      safeSummary: "Review past due",
      routeToWorkspaceAdmins: true,
    } as never);
    if (!created.ok) throw new Error(`escalation not created: ${created.code}`);
    return created.escalation.id;
  }

  // ===========================================================================
  // The review console (reviewer-ops) and the review-operations surface
  // ===========================================================================

  it("console assign: an unplaced member is refused 422 NOT_PLACED, a placed one is assigned", async () => {
    await setPlan("TEAM");
    const unplaced = await person("MEMBER");
    const placed = await person("MEMBER", { placed: true });
    const wf = await workflow();
    const url = `/v1/reviewer-ops/reviews/${wf.workflowId}/assign`;
    const refused = await post(url, A().ownerToken, { teamId: A().teamId, assignedToUserId: unplaced.id });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(errorCode(refused)).toBe("REVIEW_ASSIGNEE_NOT_PLACED");
    expect(await assigneeOf(wf.workflowId)).toBeNull();
    const ok = await post(url, A().ownerToken, { teamId: A().teamId, assignedToUserId: placed.id });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await assigneeOf(wf.workflowId)).toBe(placed.id);
  });

  it("console reassign: an unplaced member is refused, a placed one takes the review", async () => {
    await setPlan("TEAM");
    const first = await person("MEMBER", { placed: true });
    const unplaced = await person("MEMBER");
    const second = await person("MEMBER", { placed: true });
    const wf = await workflow({ assignedTo: first.id });
    const url = `/v1/reviewer-ops/reviews/${wf.workflowId}/reassign`;
    const refused = await post(url, A().ownerToken, { teamId: A().teamId, newAssigneeUserId: unplaced.id });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(errorCode(refused)).toBe("REVIEW_ASSIGNEE_NOT_PLACED");
    expect(await assigneeOf(wf.workflowId)).toBe(first.id);
    const ok = await post(url, A().ownerToken, { teamId: A().teamId, newAssigneeUserId: second.id });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await assigneeOf(wf.workflowId)).toBe(second.id);
  });

  it("claim: an unplaced member cannot claim queue work, a placed one can", async () => {
    await setPlan("TEAM");
    const unplaced = await person("MEMBER");
    const placed = await person("MEMBER", { placed: true });
    const wf = await workflow();
    const url = `/v1/review-operations/evidence/${wf.evidenceId}/claim`;
    const refused = await post(url, unplaced.token, { teamId: A().teamId });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(errorCode(refused)).toBe("assignee_not_placed");
    const ok = await post(url, placed.token, { teamId: A().teamId });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await assigneeOf(wf.workflowId)).toBe(placed.id);
  });

  it("bulk ASSIGN: an unplaced member is refused per item and nothing moves; a placed one is assigned", async () => {
    await setPlan("TEAM");
    const unplaced = await person("MEMBER");
    const placed = await person("MEMBER", { placed: true });
    const wf = await workflow();
    const send = (assignedToUserId: string) =>
      post("/v1/review-operations/bulk", A().ownerToken, {
        teamId: A().teamId,
        evidenceIds: [wf.evidenceId],
        action: "ASSIGN",
        assignedToUserId,
      });
    const refused = await send(unplaced.id);
    expect(refused.statusCode, refused.body).toBe(200);
    expect((refused.json() as { result: { items: Array<{ ok: boolean; reason?: string }> } }).result.items[0]).toMatchObject({
      ok: false,
      reason: "assignee_not_placed",
    });
    expect(await assigneeOf(wf.workflowId)).toBeNull();
    const ok = await send(placed.id);
    expect((ok.json() as { result: { succeeded: number } }).result.succeeded).toBe(1);
    expect(await assigneeOf(wf.workflowId)).toBe(placed.id);
  });

  it("defect 20 — escalation create with an unplaced named assignee is a typed 422, never a 500; a placed one is routed", async () => {
    await setPlan("TEAM");
    const unplaced = await person("MEMBER");
    const placed = await person("MEMBER", { placed: true });
    const wf = await workflow();
    const create = (assignedToUserId: string) =>
      post("/v1/reviewer-ops/escalations", A().ownerToken, {
        teamId: A().teamId,
        workflowId: wf.workflowId,
        reason: "REVIEW_OVERDUE",
        severity: "WARNING",
        safeSummary: "Review past due",
        assignedToUserId,
      });
    const refused = await create(unplaced.id);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(errorCode(refused)).toBe("REVIEW_ASSIGNEE_NOT_PLACED");
    expect(await prisma.reviewEscalation.count({ where: { workflowId: wf.workflowId } })).toBe(0);
    const ok = await create(placed.id);
    expect([200, 201], ok.body).toContain(ok.statusCode);
    expect((ok.json() as { escalation: { assignedToUserId: string | null } }).escalation.assignedToUserId).toBe(placed.id);
  });

  it("escalation reassign: an unplaced member is refused 422, a placed one receives it", async () => {
    await setPlan("TEAM");
    const unplaced = await person("MEMBER");
    const placed = await person("MEMBER", { placed: true });
    const wf = await workflow();
    const escalationId = await openEscalation(wf.workflowId, wf.evidenceId);
    const url = `/v1/reviewer-ops/escalations/${escalationId}/reassign`;
    const refused = await post(url, A().ownerToken, { teamId: A().teamId, newAssigneeUserId: unplaced.id });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(errorCode(refused)).toBe("REVIEW_ASSIGNEE_NOT_PLACED");
    const ok = await post(url, A().ownerToken, { teamId: A().teamId, newAssigneeUserId: placed.id });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: escalationId } })).assignedToUserId).toBe(placed.id);
  });

  // ===========================================================================
  // REV-05 / defect 4 — the ASSIGNER needs review.assign everywhere
  // ===========================================================================

  it("REV-05 — a member granted evidence_request.review but not review.assign cannot hand out reviews; review.assign can", async () => {
    await setPlan("TEAM");
    const assigner = await person("VIEWER", { placed: true });
    const grant = (permission: string) =>
      prisma.memberCapabilityGrant.create({
        data: { teamMemberId: assigner.memberId!, teamId: A().teamId, permission, grantedByUserId: owner() },
      });
    await grant("evidence_request.review");
    const target = await person("MEMBER", { placed: true });
    const target2 = await person("MEMBER", { placed: true });
    const wf = await workflow();
    const assigned = await workflow({ assignedTo: target.id });
    const escalationId = await openEscalation(assigned.workflowId, assigned.evidenceId);

    const attempts = () => [
      post(`/v1/reviewer-ops/reviews/${wf.workflowId}/assign`, assigner.token, { teamId: A().teamId, assignedToUserId: target.id }),
      post(`/v1/reviewer-ops/reviews/${assigned.workflowId}/reassign`, assigner.token, {
        teamId: A().teamId,
        newAssigneeUserId: target2.id,
      }),
      post(`/v1/reviewer-ops/escalations/${escalationId}/reassign`, assigner.token, {
        teamId: A().teamId,
        newAssigneeUserId: target2.id,
      }),
      post("/v1/reviewer-ops/escalations", assigner.token, {
        teamId: A().teamId,
        workflowId: wf.workflowId,
        reason: "REVIEW_OVERDUE",
        severity: "WARNING",
        safeSummary: "Needs another reviewer",
        assignedToUserId: target.id,
      }),
      patch(`/v1/evidence/${wf.evidenceId}/reviewer-workflow`, assigner.token, { assignedToUserId: target2.id }),
    ];
    for (const res of await Promise.all(attempts())) {
      expect(res.statusCode, res.body).toBe(403);
    }
    expect(await assigneeOf(wf.workflowId)).toBeNull();
    expect(await assigneeOf(assigned.workflowId)).toBe(target.id);
    expect(await prisma.reviewEscalation.count({ where: { workflowId: wf.workflowId } })).toBe(0);

    await grant("review.assign");
    const ok = await post(`/v1/reviewer-ops/reviews/${wf.workflowId}/assign`, assigner.token, {
      teamId: A().teamId,
      assignedToUserId: target.id,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await assigneeOf(wf.workflowId)).toBe(target.id);
    const reassigned = await post(`/v1/reviewer-ops/escalations/${escalationId}/reassign`, assigner.token, {
      teamId: A().teamId,
      newAssigneeUserId: target2.id,
    });
    expect(reassigned.statusCode, reassigned.body).toBe(200);
  });

  // ===========================================================================
  // ACC-07 / defect 1 — the legacy reviewer-workflow PATCH
  // ===========================================================================

  it("ACC-07 — the legacy PATCH refuses an unplaced member, a VIEWER, a former member and a CaseAccess-only stranger; accepts a placed member", async () => {
    await setPlan("TEAM");
    const unplaced = await person("MEMBER");
    const viewer = await person("VIEWER", { placed: true });
    const former = await person("MEMBER", { placed: true });
    await prisma.teamMember.updateMany({ where: { teamId: A().teamId, userId: former.id }, data: { status: "REVOKED" } as never });
    const stranger = await person(null);
    const placed = await person("MEMBER", { placed: true });

    const open = await workflow();
    const restricted = await workflow({ restrictedTo: [stranger.id, former.id, placed.id, owner()] });
    const send = (evidenceId: string, assignedToUserId: string) =>
      patch(`/v1/evidence/${evidenceId}/reviewer-workflow`, A().ownerToken, { assignedToUserId });

    const notPlaced = await send(open.evidenceId, unplaced.id);
    expect(notPlaced.statusCode, notPlaced.body).toBe(422);
    expect(errorCode(notPlaced)).toBe("REVIEW_ASSIGNEE_NOT_PLACED");
    for (const [evidenceId, who] of [
      [open.evidenceId, viewer.id],
      [open.evidenceId, former.id],
      [restricted.evidenceId, former.id],
      [restricted.evidenceId, stranger.id],
    ] as const) {
      const res = await send(evidenceId, who);
      expect(res.statusCode, res.body).toBe(422);
      expect(errorCode(res)).toBe("REVIEW_ASSIGNEE_NOT_ELIGIBLE");
    }
    expect(await assigneeOf(open.workflowId)).toBeNull();
    expect(await assigneeOf(restricted.workflowId)).toBeNull();

    const ok = await send(restricted.evidenceId, placed.id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await assigneeOf(restricted.workflowId)).toBe(placed.id);
    const openOk = await send(open.evidenceId, placed.id);
    expect(openOk.statusCode, openOk.body).toBe(200);
    expect(await assigneeOf(open.workflowId)).toBe(placed.id);
  });

  // ===========================================================================
  // Defect 5 — the eligibility check and the write are one transaction
  // ===========================================================================

  it("defect 5 — a Collaboration Team archive racing an assignment never leaves an unplaced assignee", async () => {
    await setPlan("TEAM");
    const member = await person("MEMBER");
    const groupId = await placeInCollaborationTeam(prisma, {
      workspaceId: A().teamId,
      createdByUserId: owner(),
      userIds: [member.id],
    });
    const wf = await workflow();
    let assignment: ReturnType<typeof post> | null = null;
    let sawAssignmentWait = false;

    // The archive is in flight (written, not committed) when the assignment
    // arrives. The assignment's placement read must wait for it — and then see
    // it — rather than read the still-committed ACTIVE row and assign.
    await prisma.$transaction(
      async (tx) => {
        await tx.collaborationTeam.update({
          where: { id: groupId },
          data: { status: "ARCHIVED", archivedAtUtc: new Date() },
        });
        assignment = post(`/v1/reviewer-ops/reviews/${wf.workflowId}/assign`, A().ownerToken, {
          teamId: A().teamId,
          assignedToUserId: member.id,
        });
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const rows = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'`;
          if (rows[0]!.n > 0) {
            sawAssignmentWait = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    const res = await assignment!;
    expect(sawAssignmentWait, "the assignment waited on the archive's row lock").toBe(true);
    expect(res.statusCode, res.body).toBe(422);
    expect(errorCode(res)).toBe("REVIEW_ASSIGNEE_NOT_PLACED");
    expect(await assigneeOf(wf.workflowId)).toBeNull();
  });

  // ===========================================================================
  // Defect 10 — queue counts obey restricted-case reach
  // ===========================================================================

  it("defect 10 — queue counts leave out reviews on restricted cases the caller is not on", async () => {
    await setPlan("TEAM");
    const insider = await person("MEMBER", { placed: true });
    const outsider = await person("MEMBER", { placed: true });
    await workflow({ restrictedTo: [insider.id] });
    const counts = async (who: Person) => {
      const res = await h.app.inject({
        method: "GET",
        url: `/v1/review-operations/queue-counts?teamId=${A().teamId}`,
        headers: { authorization: `Bearer ${who.token}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { counts: { unassigned: number; byStage: Record<string, number> } }).counts;
    };
    const inside = await counts(insider);
    const outside = await counts(outsider);
    // Both see every unrestricted workflow; only the insider sees this one.
    expect(inside.unassigned - outside.unassigned).toBe(1);
    expect(inside.byStage.QUEUED! - outside.byStage.QUEUED!).toBe(1);
  });

  // ===========================================================================
  // Operations — incident and workflow assign, and the bulk sweep (defect 2)
  // ===========================================================================

  async function incident() {
    return prisma.operationalIncident.create({
      data: {
        teamId: A().teamId,
        scope: "WORKSPACE",
        category: "REPORT",
        severity: "WARNING",
        status: "OPEN",
        fingerprint: `assign-surfaces:${tag()}`,
        title: "Report generation failed",
        safeSummary: "A report job failed.",
      } as never,
      select: { id: true },
    });
  }

  async function opsWorkflow(evidenceId: string | null = null) {
    return prisma.operationalWorkflow.create({
      data: {
        teamId: A().teamId,
        workflowKey: `assign-surfaces-${randomUUID()}`,
        workflowType: "REPORT_RETRY",
        title: "Report generation failed",
        safeSummary: "A report job failed and needs another attempt.",
        evidenceId,
      },
      select: { id: true },
    });
  }

  it("Operations incident and workflow assign: an unplaced member is refused, a placed one owns it", async () => {
    await setPlan("TEAM");
    const unplaced = await person("MEMBER");
    const placed = await person("MEMBER", { placed: true });
    const inc = await incident();
    const refusedIncident = await post(`/v1/ops/incidents/${inc.id}/assign`, A().ownerToken, {
      teamId: A().teamId,
      assigneeUserId: unplaced.id,
    });
    expect(refusedIncident.statusCode, refusedIncident.body).toBe(400);
    const okIncident = await post(`/v1/ops/incidents/${inc.id}/assign`, A().ownerToken, {
      teamId: A().teamId,
      assigneeUserId: placed.id,
    });
    expect(okIncident.statusCode, okIncident.body).toBe(200);

    const wf = await opsWorkflow();
    const refusedWf = await post(`/v1/ops/workflows/${wf.id}/assign`, A().ownerToken, {
      teamId: A().teamId,
      assigneeUserId: unplaced.id,
    });
    expect(refusedWf.statusCode, refusedWf.body).toBe(400);
    const okWf = await post(`/v1/ops/workflows/${wf.id}/assign`, A().ownerToken, {
      teamId: A().teamId,
      assigneeUserId: placed.id,
    });
    expect(okWf.statusCode, okWf.body).toBe(200);
    expect((await prisma.operationalWorkflow.findUniqueOrThrow({ where: { id: wf.id } })).assignedOwnerUserId).toBe(placed.id);
  });

  it("defect 2 — the Operations bulk sweep refuses an unplaced assignee up front, and decides reach per target", async () => {
    await setPlan("TEAM");
    const unplaced = await person("MEMBER");
    const placed = await person("MEMBER", { placed: true });
    const open = await opsWorkflow();
    const closedTo = await workflow({ restrictedTo: [owner()] });
    const restrictedTarget = await opsWorkflow(closedTo.evidenceId);
    const header = () =>
      stepUp.approvedHeader({
        token: A().ownerToken,
        userId: owner(),
        teamId: A().teamId,
        purpose: "REVIEWER_OPS_BULK_ACTION",
        resourceKind: "workspace",
        resourceId: A().teamId,
      });
    const sweep = async (assigneeUserId: string) =>
      post(
        "/v1/ops/bulk-actions",
        A().ownerToken,
        { teamId: A().teamId, actionType: "BULK_ASSIGN_WORKFLOWS", targetIds: [open.id, restrictedTarget.id], assigneeUserId },
        await header(),
      );

    const refused = await sweep(unplaced.id);
    expect(refused.statusCode, refused.body).toBe(400);
    expect((refused.json() as { error: string }).error).toBe("invalid_assignee");

    const ran = await sweep(placed.id);
    expect(ran.statusCode, ran.body).toBe(200);
    const owners = async (id: string) =>
      (await prisma.operationalWorkflow.findUniqueOrThrow({ where: { id } })).assignedOwnerUserId;
    expect(await owners(open.id)).toBe(placed.id);
    // The placed member is off the restricted case: that target is refused.
    expect(await owners(restrictedTarget.id)).toBeNull();
    const item = await prisma.bulkOperationalActionItem.findFirstOrThrow({
      where: { targetId: restrictedTarget.id },
      orderBy: { createdAt: "desc" },
    });
    expect(item).toMatchObject({ status: "FAILED", errorCode: "invalid_assignee" });

    // The runner itself (not only the route's pre-check) refuses placement.
    const direct = await opsWorkflow();
    const run = await bulk.runBulkAction({
      teamId: A().teamId,
      actionType: "BULK_ASSIGN_WORKFLOWS",
      targetIds: [direct.id],
      assigneeUserId: unplaced.id,
      actorUserId: owner(),
    });
    expect(run).toMatchObject({ succeeded: 0, failed: 1 });
    expect(
      await prisma.bulkOperationalActionItem.findFirstOrThrow({ where: { runId: run.runId, targetId: direct.id } }),
    ).toMatchObject({ status: "FAILED", errorCode: "assignee_not_placed" });
    expect(await owners(direct.id)).toBeNull();
  });

  // ===========================================================================
  // Case assignment — ENT-11 (owner decision 5: PRO and TEAM receive work)
  // ===========================================================================

  for (const plan of ["TEAM", "PRO"] as const) {
    it(`ENT-11 — ${plan}: a case goes to a placed member and is refused to an unplaced one`, async () => {
      await setPersonalPlan(plan);
      const where = { workspaceId: P().teamId, workspaceOwnerId: P().userId };
      const unplaced = await person("MEMBER", where);
      const placed = await person("MEMBER", { ...where, placed: true });
      const c = await prisma.case.create({
        data: { name: `Assignable ${tag()}`, teamId: P().teamId, ownerUserId: P().userId },
        select: { id: true },
      });
      const url = `/v1/cases/${c.id}/assignments`;
      const refused = await post(url, P().token, { assignedToUserId: unplaced.id, role: "INVESTIGATOR" });
      expect(refused.statusCode, refused.body).toBe(422);
      expect(errorCode(refused)).toBe("assignee_not_placed");
      const ok = await post(url, P().token, { assignedToUserId: placed.id, role: "INVESTIGATOR" });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await prisma.caseAssignment.count({ where: { caseId: c.id } })).toBe(1);
    });
  }

  it("ENT-11 — FREE: a Personal Workspace without collaboration refuses case assignment with a typed entitlement answer", async () => {
    await setPersonalPlan("FREE");
    try {
      const member = await person("MEMBER", { workspaceId: P().teamId, workspaceOwnerId: P().userId });
      const c = await prisma.case.create({
        data: { name: `Free ${tag()}`, teamId: P().teamId, ownerUserId: P().userId },
        select: { id: true },
      });
      const res = await post(`/v1/cases/${c.id}/assignments`, P().token, { assignedToUserId: member.id, role: "INVESTIGATOR" });
      expect(res.statusCode, res.body).toBe(403);
      expect(errorCode(res)).toBe("ENTITLEMENT_REQUIRED");
      expect(await prisma.caseAssignment.count({ where: { caseId: c.id } })).toBe(0);
    } finally {
      await setPersonalPlan("TEAM");
    }
  });

  // ===========================================================================
  // Defect 3 — a discussion thread's resolver must reach its evidence
  // ===========================================================================

  it("defect 3 — a thread about restricted-case evidence goes only to someone on the case", async () => {
    await setPlan("TEAM");
    const insider = await person("MEMBER");
    const outsider = await person("MEMBER", { placed: true });
    const wf = await workflow({ restrictedTo: [owner(), insider.id] });
    const created = await post("/v1/collaboration/threads", A().ownerToken, {
      teamId: A().teamId,
      evidenceId: wf.evidenceId,
      kind: "EVIDENCE_GENERAL",
      visibility: "INTERNAL",
      title: "Chain of custody question",
    });
    expect(created.statusCode, created.body).toBe(201);
    const threadId = (created.json() as { thread: { id: string } }).thread.id;
    const assign = (assignedToUserId: string) =>
      post(`/v1/collaboration/threads/${threadId}/assign`, A().ownerToken, { teamId: A().teamId, assignedToUserId });

    const refused = await assign(outsider.id);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(errorCode(refused)).toBe("assignee_not_eligible");
    expect(await prisma.discussionParticipant.count({ where: { threadId, userId: outsider.id } })).toBe(0);
    // Placement is not required of a resolver (see discussion.service): an
    // unplaced member on the case may resolve it.
    const ok = await assign(insider.id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await prisma.discussionThread.findUniqueOrThrow({ where: { id: threadId } })).assignedToUserId).toBe(insider.id);
  });

  // ===========================================================================
  // SEC-13 — evidence mutation audits commit before the response
  // ===========================================================================

  it("SEC-13 — an evidence archive's audit row exists when the response returns, and a failed audit write fails the request", async () => {
    await setPlan("TEAM");
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const make = () =>
      prisma.evidence.create({
        data: {
          title: `Audit ${tag()}`,
          type: "PHOTO",
          status: "CREATED",
          teamId: A().teamId,
          organizationId: team.organizationId,
          ownerUserId: owner(),
        } as never,
        select: { id: true },
      });
    const archive = (id: string) => post(`/v1/evidence/${id}/archive`, A().ownerToken, {});

    const audited = await make();
    const ok = await archive(audited.id);
    expect(ok.statusCode, ok.body).toBe(200);
    // Read once, immediately — no polling: the row was written before the reply.
    expect(
      await prisma.adminAuditLog.count({ where: { action: "evidence.archive", resourceId: audited.id } }),
    ).toBe(1);

    // A real database refusal of exactly this audit row.
    const failing = await make();
    const fn = `sec13_refuse_${tag()}`;
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit refused'; END $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE INSERT ON admin_audit_logs FOR EACH ROW
         WHEN (NEW.action = 'evidence.archive' AND NEW.resource_id = '${failing.id}') EXECUTE FUNCTION ${fn}()`,
    );
    try {
      const res = await archive(failing.id);
      // The mutation's success is not reported without its audit.
      expect(res.statusCode, res.body).toBe(500);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER ${fn} ON admin_audit_logs`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    }
  });
});
