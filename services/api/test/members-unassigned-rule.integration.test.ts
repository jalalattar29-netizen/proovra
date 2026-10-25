/**
 * THE UNASSIGNED-MEMBER RULE (owner decision 2026-10-25) — who may be given work.
 *
 * On PRO and TEAM Personal Workspaces, a non-owner member who is not placed in
 * an ACTIVE Collaboration Team cannot be given a reviewer assignment, cannot
 * claim queue work, cannot be routed an escalation, cannot carry a case, and is
 * not offered as an operator for queue work. Placement is necessary, not
 * sufficient: a placed member still needs the capability and the object's
 * reach. The workspace OWNER is exempt from placement only. Enterprise follows
 * its contract: direct eligible assignment by default, placement when the
 * contract says so.
 *
 * Every case drives the real assignment authority and its writers against a
 * real PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("the unassigned-member rule (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let review: typeof import("../src/services/review-operations/review-operations.service.js");
  let escalations: typeof import("../src/services/reviewer-ops/escalation-engine.service.js");
  let cases: typeof import("../src/services/cases/case-lifecycle.service.js");
  let operators: typeof import("../src/services/operations/assignable-operators.service.js");
  let fixtures: typeof import("./point7/product-fixtures.js");
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  const W = () => h.fixtures.personal;
  const owner = () => W().userId;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    review = await import("../src/services/review-operations/review-operations.service.js");
    escalations = await import("../src/services/reviewer-ops/escalation-engine.service.js");
    cases = await import("../src/services/cases/case-lifecycle.service.js");
    operators = await import("../src/services/operations/assignable-operators.service.js");
    fixtures = await import("./point7/product-fixtures.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
    await setPlan("TEAM");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);

  async function setPlan(plan: "PRO" | "TEAM") {
    await prisma.entitlement.updateMany({ where: { userId: owner(), active: true }, data: { active: false } });
    await prisma.entitlement.create({ data: { userId: owner(), plan, active: true, credits: 0 } });
  }

  async function member(teamId: string, role: "ADMIN" | "MEMBER" = "MEMBER") {
    const email = `unassigned-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, displayName: "Member", provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.teamMember.create({ data: { teamId, userId: user.id, role, status: "ACTIVE" } });
    return user.id;
  }

  async function place(workspaceId: string, userId: string, status: "ACTIVE" | "ARCHIVED" = "ACTIVE") {
    const group = await prisma.collaborationTeam.create({
      data: { workspaceId, name: `Group ${tag()}`, createdByUserId: owner(), status },
      select: { id: true },
    });
    await prisma.collaborationTeamMember.create({ data: { teamId: group.id, userId, status: "ACTIVE" } });
    return group.id;
  }

  async function evidenceIn(teamId: string, ownerUserId: string, restrictedTo?: string[]) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    const evidence = await prisma.evidence.create({
      data: { title: `E ${tag()}`, type: "PHOTO", status: "CREATED", teamId, organizationId: team.organizationId, ownerUserId },
      select: { id: true },
    });
    let caseId: string | null = null;
    if (restrictedTo) {
      const c = await prisma.case.create({ data: { name: `C ${tag()}`, teamId, ownerUserId }, select: { id: true } });
      caseId = c.id;
      for (const userId of restrictedTo) await prisma.caseAccess.create({ data: { caseId: c.id, userId } });
      await prisma.caseEvidenceLink.create({ data: { caseId: c.id, evidenceId: evidence.id } });
    }
    const wf = await prisma.evidenceReviewWorkflow.create({
      data: { teamId, evidenceId: evidence.id, workspaceType: "PERSONAL", status: "QUEUED" as never },
      select: { id: true, evidenceId: true },
    });
    return { evidenceId: evidence.id, workflowId: wf.id, caseId };
  }

  const codeOf = (p: Promise<unknown>) =>
    p.then(
      () => "OK",
      (e: { code?: string }) => e.code ?? "unknown",
    );

  async function openEscalation(teamId: string, workflowId: string, evidenceId: string) {
    const created = await escalations.createEscalation({
      teamId,
      workflowId,
      evidenceId,
      reason: "REVIEW_OVERDUE",
      safeSummary: "Review past due",
      routeToWorkspaceAdmins: true,
    } as never);
    if (!created.ok) throw new Error(`escalation not created: ${created.code}`);
    return created.escalation.id;
  }

  for (const plan of ["TEAM", "PRO"] as const) {
    it(`${plan}: an unassigned member receives no review, no claim, no escalation, no case and no queue work`, async () => {
      await setPlan(plan);
      const unassigned = await member(W().teamId);
      const work = await evidenceIn(W().teamId, owner());

      expect(
        await codeOf(review.assignReviewer({ evidenceId: work.evidenceId, assignedToUserId: unassigned, actorUserId: owner() })),
      ).toBe("assignee_not_placed");
      expect(await codeOf(review.claimReviewerWorkflow({ evidenceId: work.evidenceId, actorUserId: unassigned }))).toBe(
        "assignee_not_placed",
      );
      const escalationId = await openEscalation(W().teamId, work.workflowId, work.evidenceId);
      expect(
        await codeOf(
          escalations.reassignEscalation({
            teamId: W().teamId,
            escalationId,
            actorUserId: owner(),
            newAssigneeUserId: unassigned,
          }),
        ),
      ).toBe("REVIEW_ASSIGNEE_NOT_PLACED");
      const caseRow = await prisma.case.create({ data: { name: `Open ${tag()}`, teamId: W().teamId, ownerUserId: owner() }, select: { id: true } });
      expect(
        await codeOf(
          cases.addCaseAssignment({ caseId: caseRow.id, assignedToUserId: unassigned, role: "INVESTIGATOR", actorUserId: owner() } as never),
        ),
      ).toBe("assignee_not_placed");
      const offered = (await operators.listAssignableOperators({ teamId: W().teamId })).map((o) => o.userId);
      expect(offered).not.toContain(unassigned);
      expect(offered).toContain(owner());

      // Nothing moved.
      expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: work.workflowId } })).assignedToUserId).toBeNull();
      expect(await prisma.caseAssignment.count({ where: { caseId: caseRow.id } })).toBe(0);
    });
  }

  it("placement in an ACTIVE Collaboration Team lets the same work through; an ARCHIVED one does not place", async () => {
    await setPlan("TEAM");
    const placed = await member(W().teamId);
    await place(W().teamId, placed);
    const archivedOnly = await member(W().teamId);
    await place(W().teamId, archivedOnly, "ARCHIVED");

    const work = await evidenceIn(W().teamId, owner());
    const moved = await review.assignReviewer({ evidenceId: work.evidenceId, assignedToUserId: placed, actorUserId: owner() });
    expect(moved.assignedToUserId).toBe(placed);
    const claimWork = await evidenceIn(W().teamId, owner());
    expect(await codeOf(review.claimReviewerWorkflow({ evidenceId: claimWork.evidenceId, actorUserId: placed }))).toBe("OK");
    const caseRow = await prisma.case.create({ data: { name: `Open ${tag()}`, teamId: W().teamId, ownerUserId: owner() }, select: { id: true } });
    expect(
      await codeOf(cases.addCaseAssignment({ caseId: caseRow.id, assignedToUserId: placed, role: "INVESTIGATOR", actorUserId: owner() } as never)),
    ).toBe("OK");
    expect((await operators.listAssignableOperators({ teamId: W().teamId })).map((o) => o.userId)).toContain(placed);

    const other = await evidenceIn(W().teamId, owner());
    expect(
      await codeOf(review.assignReviewer({ evidenceId: other.evidenceId, assignedToUserId: archivedOnly, actorUserId: owner() })),
    ).toBe("assignee_not_placed");
  });

  it("placement does not replace reach: a placed member off a restricted case's list is refused", async () => {
    await setPlan("TEAM");
    const insider = await member(W().teamId);
    const outsider = await member(W().teamId);
    await place(W().teamId, insider);
    await place(W().teamId, outsider);
    const work = await evidenceIn(W().teamId, owner(), [insider]);
    expect(
      await codeOf(review.assignReviewer({ evidenceId: work.evidenceId, assignedToUserId: outsider, actorUserId: owner() })),
    ).toBe("assignee_not_eligible");
    expect(
      await codeOf(
        cases.addCaseAssignment({ caseId: work.caseId!, assignedToUserId: outsider, role: "INVESTIGATOR", actorUserId: owner() } as never),
      ),
    ).toBe("invalid_assignee");
    expect((await review.assignReviewer({ evidenceId: work.evidenceId, assignedToUserId: insider, actorUserId: owner() })).assignedToUserId).toBe(insider);
  });

  it("the OWNER needs no placement, but still needs reach", async () => {
    await setPlan("TEAM");
    const work = await evidenceIn(W().teamId, owner());
    expect((await review.assignReviewer({ evidenceId: work.evidenceId, assignedToUserId: owner(), actorUserId: owner() })).assignedToUserId).toBe(owner());

    // A restricted case another member owns, whose list does not name the
    // workspace owner: workspace ownership alone does not reach it.
    const caseOwner = await member(W().teamId);
    await place(W().teamId, caseOwner);
    const restricted = await evidenceIn(W().teamId, caseOwner, [caseOwner]);
    expect(
      await codeOf(review.assignReviewer({ evidenceId: restricted.evidenceId, assignedToUserId: owner(), actorUserId: caseOwner })),
    ).toBe("assignee_not_eligible");
  });

  it("what the page offers equals what the server does: an unplaced member is offered no Claim, and Claim is refused", async () => {
    const A = h.fixtures.teamA;
    await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    const work = await evidenceIn(A.teamId, A.ownerUserId);
    const get = () =>
      h.app.inject({ method: "GET", url: `/v1/evidence/${work.evidenceId}/review-workspace`, headers: { authorization: `Bearer ${A.memberToken}` } });
    const claimAction = async () => {
      const res = await get();
      expect(res.statusCode, res.body).toBe(200);
      return (res.json().reviewWorkflow.availableActions as Array<{ action: string; enabled: boolean; blockedBy: string | null }>).find(
        (x) => x.action === "CLAIM",
      )!;
    };
    expect(await claimAction()).toMatchObject({ enabled: false, blockedBy: "NOT_PLACED" });
    const refused = await h.app.inject({
      method: "POST",
      url: `/v1/review-operations/evidence/${work.evidenceId}/claim`,
      headers: { authorization: `Bearer ${A.memberToken}` },
      payload: { teamId: A.teamId },
    });
    expect(refused.statusCode).toBe(422);
    await place(A.teamId, A.memberUserId);
    expect(await claimAction()).toMatchObject({ enabled: true, blockedBy: null });
    const ok = await h.app.inject({
      method: "POST",
      url: `/v1/review-operations/evidence/${work.evidenceId}/claim`,
      headers: { authorization: `Bearer ${A.memberToken}` },
      payload: { teamId: A.teamId },
    });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("ENTERPRISE: direct eligible assignment by default; the contract may require placement", async () => {
    const deps = {
      prisma: prisma as never,
      tag: `unassigned-${tag()}`,
      mintToken: (userId: string, email: string) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET as string,
          3600,
        ),
    };
    const org = await fixtures.seedOrganizationTenant(deps, {});
    const direct = await member(org.workspaceId);
    const work = await evidenceIn(org.workspaceId, org.owner.userId);
    expect(
      (await review.assignReviewer({ evidenceId: work.evidenceId, assignedToUserId: direct, actorUserId: org.owner.userId })).assignedToUserId,
    ).toBe(direct);

    await prisma.enterpriseContract.update({
      where: { organizationId: org.organizationId },
      data: { assignmentRequiresTeamPlacement: true },
    });
    const next = await evidenceIn(org.workspaceId, org.owner.userId);
    expect(
      await codeOf(review.assignReviewer({ evidenceId: next.evidenceId, assignedToUserId: direct, actorUserId: org.owner.userId })),
    ).toBe("assignee_not_placed");
    const groupId = await place(org.workspaceId, direct);
    expect(groupId).toBeTruthy();
    expect(
      (await review.assignReviewer({ evidenceId: next.evidenceId, assignedToUserId: direct, actorUserId: org.owner.userId })).assignedToUserId,
    ).toBe(direct);
  });
});
