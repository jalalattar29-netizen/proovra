/**
 * EVERY WRITER THAT HANDS SOMEBODY WORK, AND EVERY DEPARTURE THAT ENDS IT
 * (members re-audit 2, slice B: B1-B6, B9-B11 — owner decision 5, 2026-10-25).
 *
 * On PRO and TEAM a non-owner member who is not placed in an ACTIVE
 * Collaboration Team cannot be handed team tasks, reviewer assignments, queue
 * work or escalations; placement is necessary, never sufficient (capability
 * and record reach still apply). The ONE authority is
 * services/assignment/assignee-eligibility.ts (`assertWorkAssigneeEligible`).
 * A Personal Workspace's plan is its OWNER's entitlement; an ORGANIZATION
 * workspace's plan is the organization's (team A).
 *
 * This suite proves, against a real PostgreSQL, the writers the second
 * re-audit found outside that authority — the escalation default assignee
 * (B1), QC samples (B2), the Evidence Request reviewer (B3), single Operations
 * workflow and incident assign (B4), in-write placement (B5), the case-role
 * capability (B6), the second-review take (B10) and the SIU assignees (B11) —
 * and that a departure releases the work the person can no longer hold (B1,
 * B9). The companion suite members-assignment-surfaces.integration.test.ts
 * covers the writers that were already in line.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { placeInCollaborationTeam } from "./support/place-in-collaboration-team.js";

type Person = { id: string; token: string; memberId: string | null };

describe("the one assignee authority holds for every writer, and a departure releases held work (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let legal: typeof import("../src/legal/legal-versioning.js");
  let escalations: typeof import("../src/services/reviewer-ops/escalation-engine.service.js");
  let qc: typeof import("../src/services/reviewer-workspace/qc-sample.service.js");
  let requests: typeof import("../src/services/evidence-request.service.js");
  let disagreements: typeof import("../src/services/reviewer-workspace/reviewer-disagreement.service.js");
  let siu: typeof import("../src/services/siu/siu-profile.service.js");
  let rbac: typeof import("../src/services/identity/rbac.service.js");
  let reach: typeof import("../src/services/identity/standing-reach.js");
  let groups: typeof import("../src/services/collaboration-team/collaboration-team.service.js");
  let operators: typeof import("../src/services/operations/assignable-operators.service.js");
  let incidents: typeof import("../src/services/observability/incident.service.js");
  let bulk: typeof import("../src/services/dashboard/bulk-actions.service.js");
  const A = () => h.fixtures.teamA;
  const P = () => h.fixtures.personal;
  const owner = () => A().ownerUserId;

  beforeAll(async () => {
    process.env.EVIDENCE_REQUESTS_ENABLED = "true";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    ({ signJwt } = await import("../src/services/jwt.js"));
    legal = await import("../src/legal/legal-versioning.js");
    escalations = await import("../src/services/reviewer-ops/escalation-engine.service.js");
    qc = await import("../src/services/reviewer-workspace/qc-sample.service.js");
    requests = await import("../src/services/evidence-request.service.js");
    disagreements = await import("../src/services/reviewer-workspace/reviewer-disagreement.service.js");
    siu = await import("../src/services/siu/siu-profile.service.js");
    rbac = await import("../src/services/identity/rbac.service.js");
    reach = await import("../src/services/identity/standing-reach.js");
    groups = await import("../src/services/collaboration-team/collaboration-team.service.js");
    operators = await import("../src/services/operations/assignable-operators.service.js");
    incidents = await import("../src/services/observability/incident.service.js");
    bulk = await import("../src/services/dashboard/bulk-actions.service.js");
    await setPlan("TEAM");
    await setPersonalPlan("TEAM");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);

  /** Team A is an ORGANIZATION workspace: its plan is the organization's. */
  async function setPlan(plan: "FREE" | "PRO" | "TEAM") {
    await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: plan, billingStatus: "ACTIVE" } as never });
  }

  /** A Personal Workspace's plan is its OWNER's entitlement. */
  async function setPersonalPlan(plan: "FREE" | "PRO" | "TEAM") {
    await prisma.entitlement.updateMany({ where: { userId: P().userId }, data: { active: false } });
    await prisma.entitlement.create({ data: { userId: P().userId, plan, active: true, credits: 0 } });
  }

  type Where = { workspaceId: string; workspaceOwnerId: string };
  const inA = (): Where => ({ workspaceId: A().teamId, workspaceOwnerId: owner() });
  const inP = (): Where => ({ workspaceId: P().teamId, workspaceOwnerId: P().userId });

  async function person(
    role: "ADMIN" | "MEMBER" | "VIEWER" | null,
    opts: { placed?: boolean } & Partial<Where> = {},
  ): Promise<Person> {
    const workspaceId = opts.workspaceId ?? A().teamId;
    const workspaceOwnerId = opts.workspaceOwnerId ?? owner();
    const email = `assignee-writers-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "Assignee", lastName: "Writer", provider: "EMAIL", providerUserId: email },
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

  async function restrictedCase(where: Where, userIds: string[]) {
    const c = await prisma.case.create({
      data: { name: `Restricted ${tag()}`, teamId: where.workspaceId, ownerUserId: where.workspaceOwnerId },
      select: { id: true },
    });
    for (const userId of userIds) await prisma.caseAccess.create({ data: { caseId: c.id, userId } });
    return c.id;
  }

  async function evidenceIn(where: Where) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: where.workspaceId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: {
          title: `Writers ${tag()}`,
          type: "PHOTO",
          status: "CREATED",
          teamId: where.workspaceId,
          organizationId: team.organizationId,
          ownerUserId: where.workspaceOwnerId,
        } as never,
        select: { id: true },
      })
    ).id;
  }

  async function workflow(opts: { restrictedTo?: string[]; assignedTo?: string; where?: Where } = {}) {
    const where = opts.where ?? inA();
    const evidenceId = await evidenceIn(where);
    let caseId: string | null = null;
    if (opts.restrictedTo) {
      caseId = await restrictedCase(where, opts.restrictedTo);
      await prisma.caseEvidenceLink.create({ data: { caseId, evidenceId } });
    }
    const wf = await prisma.evidenceReviewWorkflow.create({
      data: {
        teamId: where.workspaceId,
        evidenceId,
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
  const put = (url: string, token: string, payload: unknown) =>
    h.app.inject({ method: "PUT", url, headers: { authorization: `Bearer ${token}` }, payload: payload as never });
  const errorCode = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code;

  /**
   * The member's ONLY group is archived (written, not committed) while
   * `trigger` runs; the writer must wait on the placement lock and then refuse.
   * Returns the writer's result and whether it waited.
   */
  async function raceAgainstArchive<T>(groupId: string, trigger: () => Promise<T>) {
    let pending: Promise<T> | null = null;
    let waited = false;
    await prisma.$transaction(
      async (tx) => {
        await tx.collaborationTeam.update({
          where: { id: groupId },
          data: { status: "ARCHIVED", archivedAtUtc: new Date() },
        });
        pending = trigger();
        // A rejection is inspected by the caller after the archive commits.
        pending.catch(() => {});
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const rows = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'`;
          if (rows[0]!.n > 0) {
            waited = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    return { result: pending! as Promise<T>, waited };
  }

  // ===========================================================================
  // B1 — the escalation default assignee
  // ===========================================================================

  it("B1 — an automatic escalation goes to the review's assignee only while they still pass the authority; otherwise it is raised UNASSIGNED", async () => {
    await setPlan("TEAM");
    const placed = await person("MEMBER", { placed: true });
    const unplaced = await person("MEMBER");
    const suspended = await person("MEMBER", { placed: true });
    await prisma.teamMember.updateMany({ where: { teamId: A().teamId, userId: suspended.id }, data: { status: "SUSPENDED" } as never });
    const offCase = await person("MEMBER", { placed: true });

    // Exactly what the SLA reconcile sends: no assignee named.
    const raise = async (wf: { workflowId: string; evidenceId: string }) => {
      const res = await escalations.createEscalation({
        teamId: A().teamId,
        workflowId: wf.workflowId,
        reason: "REVIEW_OVERDUE",
        safeSummary: "Review past due — automatic escalation by reviewer ops reconcile.",
        conditionMessage: { code: "ops.review.escalation.overdue_auto" },
        severity: "HIGH",
        evidenceId: wf.evidenceId,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error(res.code);
      expect(res.created).toBe(true);
      return res.escalation.assignedToUserId;
    };

    // Positive control: a still-eligible assignee keeps the escalation.
    expect(await raise(await workflow({ assignedTo: placed.id }))).toBe(placed.id);
    // Not placed, suspended, or no longer on the restricted case: raised, unassigned.
    expect(await raise(await workflow({ assignedTo: unplaced.id }))).toBeNull();
    expect(await raise(await workflow({ assignedTo: suspended.id }))).toBeNull();
    expect(await raise(await workflow({ assignedTo: offCase.id, restrictedTo: [owner()] }))).toBeNull();
  });

  it("B1 — a NAMED escalation assignee is still refused (not silently dropped) when the authority says no", async () => {
    await setPlan("TEAM");
    const unplaced = await person("MEMBER");
    const wf = await workflow();
    await expect(
      escalations.createEscalation({
        teamId: A().teamId,
        workflowId: wf.workflowId,
        reason: "REVIEW_OVERDUE",
        safeSummary: "Needs a reviewer",
        severity: "WARNING",
        evidenceId: wf.evidenceId,
        assignedToUserId: unplaced.id,
        bypassDedup: true,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_ASSIGNEE_NOT_PLACED" });
    expect(await prisma.reviewEscalation.count({ where: { workflowId: wf.workflowId } })).toBe(0);
  });

  // ===========================================================================
  // B1 — a departure releases the work the person held
  // ===========================================================================

  async function holdEverything(holder: Person) {
    const groupId = await placeInCollaborationTeam(prisma, {
      workspaceId: A().teamId,
      createdByUserId: owner(),
      userIds: [holder.id],
    });
    const review = await workflow({ assignedTo: holder.id });
    const escalation = await prisma.reviewEscalation.create({
      data: {
        teamId: A().teamId,
        workflowId: review.workflowId,
        evidenceId: review.evidenceId,
        reason: "REVIEW_OVERDUE",
        severity: "WARNING",
        status: "OPEN",
        safeSummary: "Overdue",
        assignedToUserId: holder.id,
        fingerprint: randomUUID(),
      },
      select: { id: true },
    });
    const task = await prisma.collaborationTeamAssignment.create({
      data: {
        teamId: groupId,
        workspaceId: A().teamId,
        assigneeUserId: holder.id,
        assignedByUserId: owner(),
        targetType: "REVIEW",
        targetId: review.workflowId,
        status: "IN_PROGRESS",
      },
      select: { id: true },
    });
    const opsWorkflow = await prisma.operationalWorkflow.create({
      data: {
        teamId: A().teamId,
        workflowKey: `writers-${randomUUID()}`,
        workflowType: "REPORT_RETRY",
        title: "Report generation failed",
        safeSummary: "A report job failed and needs another attempt.",
        status: "ASSIGNED",
        assignedOwnerUserId: holder.id,
        assignedByUserId: owner(),
        assignedAtUtc: new Date(),
      },
      select: { id: true },
    });
    const incident = await prisma.operationalIncident.create({
      data: {
        teamId: A().teamId,
        scope: "WORKSPACE",
        category: "REPORT",
        severity: "WARNING",
        status: "OPEN",
        fingerprint: `writers:${tag()}`,
        title: "Report generation failed",
        safeSummary: "A report job failed.",
        assignedOperatorUserId: holder.id,
        assignedByUserId: owner(),
        assignedAtUtc: new Date(),
      } as never,
      select: { id: true },
    });
    const sample = await prisma.qcSample.create({
      data: { teamId: A().teamId, workflowId: review.workflowId, state: "ASSIGNED", qcReviewerUserId: holder.id, assignedAtUtc: new Date() },
      select: { id: true },
    });
    const request = await prisma.evidenceRequest.create({
      data: {
        teamId: A().teamId,
        requestType: "CLARIFICATION",
        title: "Please clarify",
        recipientMode: "INTERNAL_USER",
        requestedByUserId: owner(),
        assignedReviewerUserId: holder.id,
        status: "OPEN",
      } as never,
      select: { id: true },
    });
    // An open disagreement whose second review the holder took, and an SIU
    // profile naming them as adjuster (members re-audit B1 scope).
    const dispute = await prisma.reviewerDisagreement.create({
      data: {
        teamId: A().teamId,
        workflowId: review.workflowId,
        state: "UNDER_SECOND_REVIEW",
        challengerUserId: owner(),
        challengerRationale: "Disagree",
        secondReviewerUserId: holder.id,
      },
      select: { id: true },
    });
    const siuCase = await prisma.case.create({ data: { name: `SIU ${tag()}`, teamId: A().teamId, ownerUserId: owner() }, select: { id: true } });
    const siuProfile = await prisma.caseSiuProfile.create({
      data: { caseId: siuCase.id, teamId: A().teamId, claimType: "auto", investigationStatus: "OPEN", assignedAdjusterUserId: holder.id } as never,
      select: { id: true },
    });
    return { groupId, review, escalationId: escalation.id, taskId: task.id, opsWorkflowId: opsWorkflow.id, incidentId: incident.id, sampleId: sample.id, requestId: request.id, disputeId: dispute.id, siuProfileId: siuProfile.id };
  }

  async function expectReleased(holderId: string, held: Awaited<ReturnType<typeof holdEverything>>) {
    const wf = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: held.review.workflowId } });
    expect(wf.assignedToUserId).toBeNull();
    expect(String(wf.status)).toBe("QUEUED");
    const unassigned = await prisma.evidenceReviewWorkflowEvent.findFirstOrThrow({
      where: { workflowId: held.review.workflowId, eventType: "UNASSIGNED" },
    });
    expect(unassigned.previousValue).toMatchObject({ assignedToUserId: holderId });

    const esc = await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: held.escalationId } });
    expect(esc.assignedToUserId).toBeNull();
    expect(esc.status).toBe("OPEN");

    const task = await prisma.collaborationTeamAssignment.findUniqueOrThrow({ where: { id: held.taskId } });
    expect(task).toMatchObject({ assigneeUserId: null, status: "OPEN" });
    const taskEvent = await prisma.collaborationTeamActivity.findFirstOrThrow({
      where: { targetId: held.taskId, eventType: "ASSIGNMENT_REASSIGNED" },
    });
    expect(taskEvent.metadata).toMatchObject({ assigneeUserId: null, previousAssigneeUserId: holderId });

    const ops = await prisma.operationalWorkflow.findUniqueOrThrow({ where: { id: held.opsWorkflowId } });
    expect(ops).toMatchObject({ assignedOwnerUserId: null, status: "OPEN" });
    expect(await prisma.operationalWorkflowEvent.count({ where: { workflowId: held.opsWorkflowId } })).toBe(1);

    const inc = await prisma.operationalIncident.findUniqueOrThrow({ where: { id: held.incidentId } });
    expect(inc.assignedOperatorUserId).toBeNull();
    expect(await prisma.operationalIncidentEvent.count({ where: { incidentId: held.incidentId, eventType: "unassigned" } })).toBe(1);

    const sample = await prisma.qcSample.findUniqueOrThrow({ where: { id: held.sampleId } });
    expect(sample).toMatchObject({ qcReviewerUserId: null, state: "SAMPLED" });

    const er = await prisma.evidenceRequest.findUniqueOrThrow({ where: { id: held.requestId } });
    expect(er.assignedReviewerUserId).toBeNull();
    expect(
      await prisma.evidenceRequestEvent.count({ where: { evidenceRequestId: held.requestId, eventType: "EVIDENCE_REQUEST_UNASSIGNED" } }),
    ).toBe(1);

    const dispute = await prisma.reviewerDisagreement.findUniqueOrThrow({ where: { id: held.disputeId } });
    expect(dispute).toMatchObject({ state: "FILED", secondReviewerUserId: null });
    const siu = await prisma.caseSiuProfile.findUniqueOrThrow({ where: { id: held.siuProfileId } });
    expect(siu.assignedAdjusterUserId).toBeNull();

    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "workspace.member.work_released", resourceId: holderId },
    });
    expect(audit.metadata).toMatchObject({ disagreements: 1, siuAssignments: 1 });
    expect(audit.metadata).toMatchObject({
      reviewWorkflows: 1,
      escalations: 1,
      teamTasks: 1,
      operationsWorkflows: 1,
      incidents: 1,
      qcSamples: 1,
      evidenceRequests: 1,
    });
  }

  it("B1 — removing a member releases every piece of work they held (unassigned, history kept, audited); a colleague's work is untouched", async () => {
    await setPlan("TEAM");
    const departing = await person("MEMBER", { placed: true });
    const colleague = await person("MEMBER", { placed: true });
    const held = await holdEverything(departing);
    const colleagues = await holdEverything(colleague);

    await rbac.revokeMember({ teamId: A().teamId, teamMemberId: departing.memberId!, actorUserId: owner() });

    await expectReleased(departing.id, held);
    // The colleague still holds all of theirs.
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: colleagues.review.workflowId } })).assignedToUserId).toBe(colleague.id);
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: colleagues.escalationId } })).assignedToUserId).toBe(colleague.id);
    expect((await prisma.collaborationTeamAssignment.findUniqueOrThrow({ where: { id: colleagues.taskId } })).assigneeUserId).toBe(colleague.id);
    expect((await prisma.operationalWorkflow.findUniqueOrThrow({ where: { id: colleagues.opsWorkflowId } })).assignedOwnerUserId).toBe(colleague.id);
    expect((await prisma.operationalIncident.findUniqueOrThrow({ where: { id: colleagues.incidentId } })).assignedOperatorUserId).toBe(colleague.id);
    expect((await prisma.qcSample.findUniqueOrThrow({ where: { id: colleagues.sampleId } })).qcReviewerUserId).toBe(colleague.id);
    expect((await prisma.evidenceRequest.findUniqueOrThrow({ where: { id: colleagues.requestId } })).assignedReviewerUserId).toBe(colleague.id);
  });

  it("B1 — a member who leaves releases their work the same way", async () => {
    await setPlan("TEAM");
    const leaving = await person("MEMBER", { placed: true });
    const held = await holdEverything(leaving);
    await rbac.leaveWorkspace({ teamId: A().teamId, userId: leaving.id });
    await expectReleased(leaving.id, held);
  });

  it("B1 — the release a suspension makes (standing-reach `releaseWorkOnSuspension`) returns held work without ending reach", async () => {
    await setPlan("TEAM");
    const suspended = await person("MEMBER", { placed: true });
    const held = await holdEverything(suspended);
    await prisma.$transaction(async (tx) => {
      await reach.releaseWorkOnSuspension(tx as never, { teamId: A().teamId, userId: suspended.id, actorUserId: owner() });
    });
    await expectReleased(suspended.id, held);
    // Reach is not ended by a suspension: their group placement is intact.
    expect(await prisma.collaborationTeamMember.count({ where: { userId: suspended.id, status: "ACTIVE" } })).toBeGreaterThan(0);
  });

  it("B1 — the canonical workspace suspension (rbac.suspendMember) releases held work in its own transaction", async () => {
    await setPlan("TEAM");
    const suspended = await person("MEMBER", { placed: true });
    const held = await holdEverything(suspended);
    await rbac.suspendMember(
      { teamId: A().teamId, teamMemberId: suspended.memberId!, actorUserId: owner(), reason: "B1 wiring" },
      prisma,
    );
    expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: suspended.memberId! } })).status).toBe("SUSPENDED");
    await expectReleased(suspended.id, held);
  });

  // ===========================================================================
  // B9 — leaving ONE Collaboration Team releases that group's open tasks
  // ===========================================================================

  it("B9 — removing or suspending a group member hands their open tasks in THAT group back, unassigned, with the history kept", async () => {
    await setPlan("TEAM");
    const a = await person("MEMBER");
    const b = await person("MEMBER");
    const groupId = await placeInCollaborationTeam(prisma, { workspaceId: A().teamId, createdByUserId: owner(), userIds: [a.id, b.id] });
    await prisma.collaborationTeamMember.create({ data: { teamId: groupId, userId: owner(), role: "LEAD", status: "ACTIVE" } as never });
    const otherGroupId = await placeInCollaborationTeam(prisma, { workspaceId: A().teamId, createdByUserId: owner(), userIds: [a.id] });
    const c = await prisma.case.create({ data: { name: `B9 ${tag()}`, teamId: A().teamId, ownerUserId: owner() }, select: { id: true } });
    const task = (teamId: string, assigneeUserId: string, status: string) =>
      prisma.collaborationTeamAssignment.create({
        data: { teamId, workspaceId: A().teamId, assigneeUserId, assignedByUserId: owner(), targetType: "CASE", targetId: c.id, status },
        select: { id: true },
      });
    const aHere = await task(groupId, a.id, "IN_PROGRESS");
    const aElsewhere = await task(otherGroupId, a.id, "OPEN");
    const aDone = await task(groupId, a.id, "COMPLETED");
    const bHere = await task(groupId, b.id, "OPEN");
    const memberRow = (userId: string) =>
      prisma.collaborationTeamMember.findFirstOrThrow({ where: { teamId: groupId, userId }, select: { id: true } });
    const row = (id: string) => prisma.collaborationTeamAssignment.findUniqueOrThrow({ where: { id } });

    await groups.removeMember({ teamId: groupId, actorUserId: owner(), memberId: (await memberRow(a.id)).id });
    expect(await row(aHere.id)).toMatchObject({ assigneeUserId: null, status: "OPEN" });
    expect(
      (await prisma.collaborationTeamActivity.findFirstOrThrow({ where: { targetId: aHere.id, eventType: "ASSIGNMENT_REASSIGNED" } })).metadata,
    ).toMatchObject({ previousAssigneeUserId: a.id, reason: "group_member_removed" });
    // Another group's task, a finished task and a colleague's task are untouched.
    expect(await row(aElsewhere.id)).toMatchObject({ assigneeUserId: a.id, status: "OPEN" });
    expect(await row(aDone.id)).toMatchObject({ assigneeUserId: a.id, status: "COMPLETED" });
    expect(await row(bHere.id)).toMatchObject({ assigneeUserId: b.id });

    await groups.suspendMember({ teamId: groupId, actorUserId: owner(), memberId: (await memberRow(b.id)).id });
    expect(await row(bHere.id)).toMatchObject({ assigneeUserId: null, status: "OPEN" });
  });

  it("defect 4 (lead) — leaving a Collaboration Team ends the share links a member made on a case granted only to that team; someone on the case's own list keeps theirs", async () => {
    await setPlan("TEAM");
    const teamOnly = await person("MEMBER");
    const listed = await person("MEMBER");
    const groupId = await placeInCollaborationTeam(prisma, { workspaceId: A().teamId, createdByUserId: owner(), userIds: [teamOnly.id, listed.id] });
    await prisma.collaborationTeamMember.create({ data: { teamId: groupId, userId: owner(), role: "LEAD", status: "ACTIVE" } as never });
    // A restricted case, reachable through the group and — for `listed` — through its own list.
    const c = await prisma.case.create({ data: { name: `Grant ${tag()}`, teamId: A().teamId, ownerUserId: owner() }, select: { id: true } });
    await prisma.case.update({ where: { id: c.id }, data: { restrictedAtUtc: new Date() } as never });
    await prisma.caseAccess.create({ data: { caseId: c.id, userId: owner() } });
    await prisma.caseAccess.create({ data: { caseId: c.id, userId: listed.id } });
    await prisma.caseCollaborationTeamAccess.create({ data: { caseId: c.id, collaborationTeamId: groupId, grantedByUserId: owner() } });
    const evidenceId = await evidenceIn(inA());
    await prisma.caseEvidenceLink.create({ data: { caseId: c.id, evidenceId } });
    const link = async (createdByUserId: string) =>
      (
        await prisma.verificationShareToken.create({
          data: {
            evidenceId,
            teamId: A().teamId,
            tokenHash: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
            purpose: "OWNER_SHARE",
            createdByUserId,
            expiresAtUtc: new Date(Date.now() + 7 * 86_400_000),
          } as never,
          select: { id: true },
        })
      ).id;
    const teamOnlyLink = await link(teamOnly.id);
    const listedLink = await link(listed.id);
    const state = (id: string) =>
      prisma.verificationShareToken.findUniqueOrThrow({ where: { id }, select: { revokedAtUtc: true, revocationReason: true } });
    const memberRow = (userId: string) =>
      prisma.collaborationTeamMember.findFirstOrThrow({ where: { teamId: groupId, userId }, select: { id: true } });

    await groups.removeMember({ teamId: groupId, actorUserId: owner(), memberId: (await memberRow(teamOnly.id)).id });
    expect(await state(teamOnlyLink)).toMatchObject({ revocationReason: "CREATOR_LOST_RECORD_REACH" });
    expect((await state(teamOnlyLink)).revokedAtUtc).not.toBeNull();

    // Positive control: still on the case's own list after leaving the group.
    await groups.removeMember({ teamId: groupId, actorUserId: owner(), memberId: (await memberRow(listed.id)).id });
    expect((await state(listedLink)).revokedAtUtc).toBeNull();
  });

  // ===========================================================================
  // B2 — QC sample reviewer
  // ===========================================================================

  async function sampleFor(where: Where, opts: { restrictedTo?: string[] } = {}) {
    const wf = await workflow({ where, restrictedTo: opts.restrictedTo });
    return prisma.qcSample.create({
      data: { teamId: where.workspaceId, workflowId: wf.workflowId, state: "SAMPLED" },
      select: { id: true },
    });
  }
  const qcReviewerOf = async (id: string) => (await prisma.qcSample.findUniqueOrThrow({ where: { id } })).qcReviewerUserId;

  it("B2 — TEAM: QC review goes to a placed reviewer; unplaced, VIEWER and off-case members are refused (route and service)", async () => {
    await setPlan("TEAM");
    const unplaced = await person("MEMBER");
    const viewer = await person("VIEWER", { placed: true });
    const offCase = await person("MEMBER", { placed: true });
    const placed = await person("MEMBER", { placed: true });

    const sample = await sampleFor(inA());
    const url = `/v1/reviewer/qc/samples/${sample.id}/assign?teamId=${A().teamId}`;
    const refused = await post(url, A().ownerToken, { qcReviewerUserId: unplaced.id });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ denial: "NOT_PERMITTED", code: "REVIEW_ASSIGNEE_NOT_PLACED" });
    expect(await qcReviewerOf(sample.id)).toBeNull();

    const assign = (sampleId: string, qcReviewerUserId: string) =>
      qc.assignSample({ teamId: A().teamId, sampleId, qcReviewerUserId, actorUserId: owner() });
    expect(await assign(sample.id, unplaced.id)).toMatchObject({ ok: false, code: "REVIEW_ASSIGNEE_NOT_PLACED" });
    expect(await assign(sample.id, viewer.id)).toMatchObject({ ok: false, code: "REVIEW_ASSIGNEE_NOT_ELIGIBLE" });
    const restricted = await sampleFor(inA(), { restrictedTo: [owner(), placed.id] });
    expect(await assign(restricted.id, offCase.id)).toMatchObject({ ok: false, code: "REVIEW_ASSIGNEE_NOT_ELIGIBLE" });
    expect(await qcReviewerOf(restricted.id)).toBeNull();

    const ok = await post(url, A().ownerToken, { qcReviewerUserId: placed.id });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await qcReviewerOf(sample.id)).toBe(placed.id);
    expect(await assign(restricted.id, placed.id)).toEqual({ ok: true });
  });

  it("B2 — PRO (a Personal Workspace on its owner's entitlement): an unplaced member is refused QC review, a placed one is accepted", async () => {
    await setPersonalPlan("PRO");
    try {
      const unplaced = await person("MEMBER", inP());
      const placed = await person("MEMBER", { ...inP(), placed: true });
      const sample = await sampleFor(inP());
      const assign = (qcReviewerUserId: string) =>
        qc.assignSample({ teamId: P().teamId, sampleId: sample.id, qcReviewerUserId, actorUserId: P().userId });
      expect(await assign(unplaced.id)).toMatchObject({ ok: false, code: "REVIEW_ASSIGNEE_NOT_PLACED" });
      expect(await assign(placed.id)).toEqual({ ok: true });
      expect(await qcReviewerOf(sample.id)).toBe(placed.id);
    } finally {
      await setPersonalPlan("TEAM");
    }
  });

  // ===========================================================================
  // B3 — the Evidence Request assigned reviewer
  // ===========================================================================

  async function draftRequest(where: Where, opts: { caseId?: string | null } = {}) {
    return prisma.evidenceRequest.create({
      data: {
        teamId: where.workspaceId,
        caseId: opts.caseId ?? null,
        requestType: "CLARIFICATION",
        title: `Request ${tag()}`,
        recipientMode: "INTERNAL_USER",
        requestedByUserId: where.workspaceOwnerId,
        status: "DRAFT",
      } as never,
      select: { id: true },
    });
  }
  const reviewerOf = async (id: string) =>
    (await prisma.evidenceRequest.findUniqueOrThrow({ where: { id } })).assignedReviewerUserId;

  it("B3 — TEAM: the assign action, create and draft edit refuse an unplaced member, a VIEWER and someone off the case; a placed reviewer is accepted", async () => {
    await setPlan("TEAM");
    const unplaced = await person("MEMBER");
    const viewer = await person("VIEWER", { placed: true });
    const offCase = await person("MEMBER", { placed: true });
    const placed = await person("MEMBER", { placed: true });

    const req = await draftRequest(inA());
    const url = `/v1/evidence-requests/${req.id}/assign`;
    const notPlaced = await post(url, A().ownerToken, { assignedReviewerUserId: unplaced.id });
    expect(notPlaced.statusCode, notPlaced.body).toBe(422);
    expect(errorCode(notPlaced)).toBe("REVIEW_ASSIGNEE_NOT_PLACED");
    const notReviewer = await post(url, A().ownerToken, { assignedReviewerUserId: viewer.id });
    expect(notReviewer.statusCode, notReviewer.body).toBe(422);
    expect(errorCode(notReviewer)).toBe("REVIEW_ASSIGNEE_NOT_ELIGIBLE");
    expect(await reviewerOf(req.id)).toBeNull();
    const ok = await post(url, A().ownerToken, { assignedReviewerUserId: placed.id });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await reviewerOf(req.id)).toBe(placed.id);
    expect(
      await prisma.evidenceRequestEvent.count({ where: { evidenceRequestId: req.id, eventType: "EVIDENCE_REQUEST_ASSIGNED" } }),
    ).toBe(1);

    // A request about a restricted case: someone off the case is refused.
    const caseId = await restrictedCase(inA(), [owner(), placed.id]);
    const onCase = await draftRequest(inA(), { caseId });
    await expect(
      requests.assignEvidenceRequestReviewer({ id: onCase.id, teamId: A().teamId, actorUserId: owner(), assignedReviewerUserId: offCase.id }),
    ).rejects.toMatchObject({ code: "assignee_not_eligible" });
    await expect(
      requests.editDraftEvidenceRequest({ id: onCase.id, teamId: A().teamId, actorUserId: owner(), patch: { assignedReviewerUserId: offCase.id } }),
    ).rejects.toMatchObject({ code: "assignee_not_eligible" });
    expect(await reviewerOf(onCase.id)).toBeNull();
    // The draft edit refuses an unplaced member too.
    const draft = await draftRequest(inA());
    await expect(
      requests.editDraftEvidenceRequest({ id: draft.id, teamId: A().teamId, actorUserId: owner(), patch: { assignedReviewerUserId: unplaced.id } }),
    ).rejects.toMatchObject({ code: "assignee_not_placed" });
    expect(await reviewerOf(draft.id)).toBeNull();
    await requests.editDraftEvidenceRequest({ id: onCase.id, teamId: A().teamId, actorUserId: owner(), patch: { assignedReviewerUserId: placed.id } });
    expect(await reviewerOf(onCase.id)).toBe(placed.id);

    // Create names a reviewer through the same rule.
    const create = (assignedReviewerUserId: string) =>
      requests.createEvidenceRequest(
        {
          teamId: A().teamId,
          requestType: "CLARIFICATION",
          title: `Created ${tag()}`,
          recipientMode: "INTERNAL_USER",
          assignedReviewerUserId,
          createIntakeLink: false,
        } as never,
        { actorUserId: owner() } as never,
      );
    const before = await prisma.evidenceRequest.count({ where: { teamId: A().teamId } });
    await expect(create(viewer.id)).rejects.toMatchObject({ code: "assignee_not_eligible" });
    expect(await prisma.evidenceRequest.count({ where: { teamId: A().teamId } })).toBe(before);
    const created = await create(placed.id);
    expect(created.request.assignedReviewerUserId).toBe(placed.id);
  });

  it("B3 — PRO: an unplaced member is refused as a request's reviewer, a placed one is accepted", async () => {
    await setPersonalPlan("PRO");
    try {
      const unplaced = await person("MEMBER", inP());
      const placed = await person("MEMBER", { ...inP(), placed: true });
      const req = await draftRequest(inP());
      const assign = (assignedReviewerUserId: string) =>
        requests.assignEvidenceRequestReviewer({ id: req.id, teamId: P().teamId, actorUserId: P().userId, assignedReviewerUserId });
      await expect(assign(unplaced.id)).rejects.toMatchObject({ code: "assignee_not_placed" });
      await assign(placed.id);
      expect(await reviewerOf(req.id)).toBe(placed.id);
    } finally {
      await setPersonalPlan("TEAM");
    }
  });

  // ===========================================================================
  // B4 — single Operations workflow assign and incident assign
  // ===========================================================================

  it("B4 — single workflow assign checks reach to the workflow's evidence and case, as the bulk sweep does", async () => {
    await setPlan("TEAM");
    const insider = await person("MEMBER", { placed: true });
    const outsider = await person("MEMBER", { placed: true });
    const closed = await workflow({ restrictedTo: [owner(), insider.id] });
    const opsWorkflow = (data: { evidenceId?: string; caseId?: string }) =>
      prisma.operationalWorkflow.create({
        data: {
          teamId: A().teamId,
          workflowKey: `writers-${randomUUID()}`,
          workflowType: "REPORT_RETRY",
          title: "Report generation failed",
          safeSummary: "A report job failed and needs another attempt.",
          ...data,
        },
        select: { id: true },
      });
    const owners = async (id: string) => (await prisma.operationalWorkflow.findUniqueOrThrow({ where: { id } })).assignedOwnerUserId;
    for (const target of [await opsWorkflow({ evidenceId: closed.evidenceId }), await opsWorkflow({ caseId: closed.caseId! })]) {
      const url = `/v1/ops/workflows/${target.id}/assign`;
      const refused = await post(url, A().ownerToken, { teamId: A().teamId, assigneeUserId: outsider.id });
      expect(refused.statusCode, refused.body).toBe(400);
      expect((refused.json() as { error: string }).error).toBe("invalid_assignee");
      expect(await owners(target.id)).toBeNull();
      const ok = await post(url, A().ownerToken, { teamId: A().teamId, assigneeUserId: insider.id });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await owners(target.id)).toBe(insider.id);
    }
  });

  it("B4 — incident assign considers the condition's related evidence, and honours a delegated Operations grant (one rule, not a role list)", async () => {
    await setPlan("TEAM");
    const insider = await person("MEMBER", { placed: true });
    const outsider = await person("MEMBER", { placed: true });
    const closed = await workflow({ restrictedTo: [owner(), insider.id] });
    const incident = (relatedEvidenceId: string | null) =>
      prisma.operationalIncident.create({
        data: {
          teamId: A().teamId,
          scope: "WORKSPACE",
          category: "REPORT",
          severity: "WARNING",
          status: "OPEN",
          fingerprint: `writers:${tag()}`,
          title: "Report generation failed",
          safeSummary: "A report job failed.",
          relatedEvidenceId,
        } as never,
        select: { id: true },
      });
    const operatorOf = async (id: string) =>
      (await prisma.operationalIncident.findUniqueOrThrow({ where: { id } })).assignedOperatorUserId;

    const restricted = await incident(closed.evidenceId);
    const url = `/v1/ops/incidents/${restricted.id}/assign`;
    const refused = await post(url, A().ownerToken, { teamId: A().teamId, assigneeUserId: outsider.id });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(await operatorOf(restricted.id)).toBeNull();
    const ok = await post(url, A().ownerToken, { teamId: A().teamId, assigneeUserId: insider.id });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await operatorOf(restricted.id)).toBe(insider.id);

    // A VIEWER cannot own Operations work by role; a delegated grant of the
    // Operations permission is part of the same one rule.
    const viewer = await person("VIEWER", { placed: true });
    const open = await incident(null);
    const openUrl = `/v1/ops/incidents/${open.id}/assign`;
    const noGrant = await post(openUrl, A().ownerToken, { teamId: A().teamId, assigneeUserId: viewer.id });
    expect(noGrant.statusCode, noGrant.body).toBe(400);
    await prisma.memberCapabilityGrant.create({
      data: { teamMemberId: viewer.memberId!, teamId: A().teamId, permission: "operations.acknowledge", grantedByUserId: owner() },
    });
    const granted = await post(openUrl, A().ownerToken, { teamId: A().teamId, assigneeUserId: viewer.id });
    expect(granted.statusCode, granted.body).toBe(200);
    expect(await operatorOf(open.id)).toBe(viewer.id);
  });

  // ===========================================================================
  // B5 — placement is decided inside the write
  // ===========================================================================

  it("B5 — case assignment, escalation reassign, a REVIEW task and single Operations assign each wait on a racing archive and refuse", async () => {
    await setPlan("TEAM");
    await setPersonalPlan("TEAM");

    // Case assignment (Personal Workspace on TEAM).
    {
      const member = await person("MEMBER", inP());
      const groupId = await placeInCollaborationTeam(prisma, { workspaceId: P().teamId, createdByUserId: P().userId, userIds: [member.id] });
      const c = await prisma.case.create({ data: { name: `B5 ${tag()}`, teamId: P().teamId, ownerUserId: P().userId }, select: { id: true } });
      const { result, waited } = await raceAgainstArchive(groupId, () =>
        post(`/v1/cases/${c.id}/assignments`, P().token, { assignedToUserId: member.id, role: "INVESTIGATOR" }),
      );
      const res = await result;
      expect(waited, "case assignment waited on the archive").toBe(true);
      expect(res.statusCode, res.body).toBe(422);
      expect(errorCode(res)).toBe("assignee_not_placed");
      expect(await prisma.caseAssignment.count({ where: { caseId: c.id } })).toBe(0);
    }

    // Escalation reassign.
    {
      const member = await person("MEMBER");
      const groupId = await placeInCollaborationTeam(prisma, { workspaceId: A().teamId, createdByUserId: owner(), userIds: [member.id] });
      const wf = await workflow();
      const created = await escalations.createEscalation({
        teamId: A().teamId,
        workflowId: wf.workflowId,
        evidenceId: wf.evidenceId,
        reason: "REVIEW_OVERDUE",
        safeSummary: "Review past due",
        routeToWorkspaceAdmins: true,
      });
      if (!created.ok) throw new Error(created.code);
      const { result, waited } = await raceAgainstArchive(groupId, () =>
        escalations.reassignEscalation({
          teamId: A().teamId,
          escalationId: created.escalation.id,
          actorUserId: owner(),
          newAssigneeUserId: member.id,
        }),
      );
      expect(waited, "escalation reassign waited on the archive").toBe(true);
      await expect(result).rejects.toMatchObject({ code: "REVIEW_ASSIGNEE_NOT_PLACED" });
      expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: created.escalation.id } })).assignedToUserId).toBeNull();
    }

    // A Collaboration Team REVIEW task (the group that places the member is the task's group).
    {
      const member = await person("MEMBER");
      const groupId = await placeInCollaborationTeam(prisma, { workspaceId: A().teamId, createdByUserId: owner(), userIds: [member.id] });
      await prisma.collaborationTeamMember.create({ data: { teamId: groupId, userId: owner(), role: "LEAD", status: "ACTIVE" } as never });
      const wf = await workflow();
      const { result, waited } = await raceAgainstArchive(groupId, () =>
        post(
          `/v1/collaboration-teams/${groupId}/assignments`,
          A().ownerToken,
          { targetType: "REVIEW", targetId: wf.workflowId, assigneeUserId: member.id },
          { "x-proovra-workspace-id": A().teamId },
        ),
      );
      const res = await result;
      expect(waited, "the REVIEW task waited on the archive").toBe(true);
      expect(res.statusCode, res.body).toBe(409);
      expect(await prisma.collaborationTeamAssignment.count({ where: { targetId: wf.workflowId } })).toBe(0);
    }

    // Single Operations workflow assign.
    {
      const member = await person("MEMBER");
      const groupId = await placeInCollaborationTeam(prisma, { workspaceId: A().teamId, createdByUserId: owner(), userIds: [member.id] });
      const target = await prisma.operationalWorkflow.create({
        data: {
          teamId: A().teamId,
          workflowKey: `writers-${randomUUID()}`,
          workflowType: "REPORT_RETRY",
          title: "Report generation failed",
          safeSummary: "A report job failed and needs another attempt.",
        },
        select: { id: true },
      });
      const { result, waited } = await raceAgainstArchive(groupId, () =>
        post(`/v1/ops/workflows/${target.id}/assign`, A().ownerToken, { teamId: A().teamId, assigneeUserId: member.id }),
      );
      const res = await result;
      expect(waited, "the Operations assign waited on the archive").toBe(true);
      expect(res.statusCode, res.body).toBe(400);
      expect((await prisma.operationalWorkflow.findUniqueOrThrow({ where: { id: target.id } })).assignedOwnerUserId).toBeNull();
    }
  });

  it("B5 (third re-audit) — incident assign and the bulk workflow sweep each wait on a racing archive and refuse; placed, both assign", async () => {
    await setPlan("TEAM");
    const condition = () =>
      prisma.operationalIncident.create({
        data: {
          teamId: A().teamId,
          category: "EVIDENCE_INTEGRITY",
          severity: "HIGH",
          status: "OPEN",
          fingerprint: `tsa_failure:${randomUUID()}`,
          title: "B5 condition",
          safeSummary: "Integrity condition seeded for the placement race.",
        },
        select: { id: true },
      });
    const opsWorkflow = () =>
      prisma.operationalWorkflow.create({
        data: {
          teamId: A().teamId,
          workflowKey: `writers-${randomUUID()}`,
          workflowType: "REPORT_RETRY",
          title: "Report generation failed",
          safeSummary: "A report job failed and needs another attempt.",
        },
        select: { id: true },
      });

    // Incident assign (the shared writer behind the single and bulk routes).
    {
      const member = await person("MEMBER");
      const groupId = await placeInCollaborationTeam(prisma, { workspaceId: A().teamId, createdByUserId: owner(), userIds: [member.id] });
      const target = await condition();
      const { result, waited } = await raceAgainstArchive(groupId, () =>
        incidents.assignIncident({ incidentId: target.id, teamId: A().teamId, assigneeUserId: member.id, actorUserId: owner() }),
      );
      expect(waited, "incident assign waited on the archive").toBe(true);
      await expect(result).rejects.toMatchObject({ code: "invalid_assignee" });
      expect((await prisma.operationalIncident.findUniqueOrThrow({ where: { id: target.id } })).assignedOperatorUserId).toBeNull();
    }

    // Bulk workflow sweep.
    {
      const member = await person("MEMBER");
      const groupId = await placeInCollaborationTeam(prisma, { workspaceId: A().teamId, createdByUserId: owner(), userIds: [member.id] });
      const target = await opsWorkflow();
      const { result, waited } = await raceAgainstArchive(groupId, () =>
        bulk.runBulkAction({
          teamId: A().teamId,
          actionType: "BULK_ASSIGN_WORKFLOWS",
          targetIds: [target.id],
          assigneeUserId: member.id,
          actorUserId: owner(),
        }),
      );
      expect(waited, "the bulk sweep waited on the archive").toBe(true);
      const run = await result;
      expect(run).toMatchObject({ succeeded: 0, failed: 1 });
      expect((await prisma.operationalWorkflow.findUniqueOrThrow({ where: { id: target.id } })).assignedOwnerUserId).toBeNull();
    }

    // Positive controls: a placed member is assigned by both writers.
    {
      const member = await person("MEMBER", { placed: true });
      const incident = await condition();
      const assigned = await incidents.assignIncident({ incidentId: incident.id, teamId: A().teamId, assigneeUserId: member.id, actorUserId: owner() });
      expect(assigned.assignedOperatorUserId).toBe(member.id);
      const wf = await opsWorkflow();
      const run = await bulk.runBulkAction({
        teamId: A().teamId,
        actionType: "BULK_ASSIGN_WORKFLOWS",
        targetIds: [wf.id],
        assigneeUserId: member.id,
        actorUserId: owner(),
      });
      expect(run).toMatchObject({ succeeded: 1, failed: 0 });
      expect((await prisma.operationalWorkflow.findUniqueOrThrow({ where: { id: wf.id } })).assignedOwnerUserId).toBe(member.id);
    }
  });

  it("T-2 — leaving the workspace is never blocked by a legacy Collaboration Team row; the legacy role is kept on the timeline", async () => {
    await setPlan("TEAM");
    const leaver = await person("MEMBER");
    const stayer = await person("MEMBER", { placed: true });
    // Two groups: one whose STATUS has no canonical meaning (the leaver holds
    // a task there), one where the leaver's ROLE has none.
    const legacyStatusGroup = await placeInCollaborationTeam(prisma, { workspaceId: A().teamId, createdByUserId: owner(), userIds: [leaver.id] });
    const legacyRoleGroup = await placeInCollaborationTeam(prisma, { workspaceId: A().teamId, createdByUserId: owner(), userIds: [leaver.id] });
    const c = await prisma.case.create({ data: { name: `T2 ${tag()}`, teamId: A().teamId, ownerUserId: owner() }, select: { id: true } });
    const task = await prisma.collaborationTeamAssignment.create({
      data: {
        teamId: legacyStatusGroup,
        workspaceId: A().teamId,
        assignedByUserId: owner(),
        assigneeUserId: leaver.id,
        targetType: "CASE",
        targetId: c.id,
        status: "IN_PROGRESS",
      } as never,
      select: { id: true },
    });
    const roleRow = await prisma.collaborationTeamMember.findFirstOrThrow({
      where: { teamId: legacyRoleGroup, userId: leaver.id },
      select: { id: true },
    });
    // The real legacy state: each CHECK exists NOT VALID and the rows predate it.
    const legacy = async (table: string, constraint: string, column: string, id: string, value: string) => {
      const def = (
        await prisma.$queryRawUnsafe<Array<{ d: string }>>(
          `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1`,
          constraint,
        )
      )[0]!.d;
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DROP CONSTRAINT "${constraint}"`);
      await prisma.$executeRawUnsafe(`UPDATE "${table}" SET "${column}" = $1 WHERE id = $2::uuid`, value, id);
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" ${def.replace(/ NOT VALID$/, "")} NOT VALID`,
      );
    };
    await legacy("collaboration_teams", "collaboration_teams_status_vocab", "status", legacyStatusGroup, "DORMANT");
    await legacy("collaboration_team_members", "collaboration_team_members_role_vocab", "role", roleRow.id, "SUPERVISOR");

    await prisma.$transaction(async (tx) => {
      await reach.endStandingReach(tx as never, { teamId: A().teamId, userId: leaver.id }, { actorUserId: owner(), reason: "membership_ended" });
    });

    // The departure completed: no live group membership, the task released.
    expect(
      await prisma.collaborationTeamMember.count({ where: { userId: leaver.id, status: { not: "REMOVED" }, team: { workspaceId: A().teamId } } }),
    ).toBe(0);
    const released = await prisma.collaborationTeamAssignment.findUniqueOrThrow({ where: { id: task.id } });
    expect(released).toMatchObject({ assigneeUserId: null, status: "OPEN" });
    // The legacy role closed at the least role, its original value on the timeline.
    const closed = await prisma.collaborationTeamMember.findUniqueOrThrow({ where: { id: roleRow.id } });
    expect(closed).toMatchObject({ status: "REMOVED", role: "VIEWER" });
    const activity = await prisma.collaborationTeamActivity.findFirstOrThrow({
      where: { teamId: legacyRoleGroup, eventType: "MEMBER_REMOVED", targetId: leaver.id },
    });
    expect(activity.metadata).toMatchObject({ legacyRole: "SUPERVISOR", roleRecordedAs: "VIEWER" });
    // The legacy group itself is left for its operator.
    const group = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT status FROM collaboration_teams WHERE id = $1::uuid`,
      legacyStatusGroup,
    );
    expect(group[0]!.status).toBe("DORMANT");
    // Positive control: another member's placement is untouched.
    expect(
      await prisma.collaborationTeamMember.count({ where: { userId: stayer.id, status: "ACTIVE", team: { workspaceId: A().teamId } } }),
    ).toBeGreaterThan(0);

    // Operator cleanup so later tests see a clean, VALIDATED vocabulary — the
    // state 20281026001400 leaves a database with no legacy rows in.
    await prisma.$executeRawUnsafe(`UPDATE "collaboration_teams" SET "status" = 'ARCHIVED' WHERE id = $1::uuid`, legacyStatusGroup);
    await prisma.$executeRawUnsafe(`ALTER TABLE "collaboration_teams" VALIDATE CONSTRAINT "collaboration_teams_status_vocab"`);
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "collaboration_team_members" VALIDATE CONSTRAINT "collaboration_team_members_role_vocab"`,
    );
  });

  // ===========================================================================
  // B6 — a case role asks the capability of the work it carries
  // ===========================================================================

  it("B6 — a VIEWER cannot be made a case OWNER, INVESTIGATOR or REVIEWER; may be an OBSERVER; a MEMBER may investigate", async () => {
    await setPersonalPlan("TEAM");
    const viewer = await person("VIEWER", { ...inP(), placed: true });
    const member = await person("MEMBER", { ...inP(), placed: true });
    const c = await prisma.case.create({ data: { name: `B6 ${tag()}`, teamId: P().teamId, ownerUserId: P().userId }, select: { id: true } });
    const url = `/v1/cases/${c.id}/assignments`;
    for (const role of ["OWNER", "INVESTIGATOR", "REVIEWER"]) {
      const refused = await post(url, P().token, { assignedToUserId: viewer.id, role });
      expect(refused.statusCode, `${role}: ${refused.body}`).toBe(400);
      expect(errorCode(refused)).toBe("invalid_assignee");
    }
    expect(await prisma.caseAssignment.count({ where: { caseId: c.id } })).toBe(0);
    const observer = await post(url, P().token, { assignedToUserId: viewer.id, role: "OBSERVER" });
    expect(observer.statusCode, observer.body).toBe(200);
    const investigator = await post(url, P().token, { assignedToUserId: member.id, role: "INVESTIGATOR" });
    expect(investigator.statusCode, investigator.body).toBe(200);
  });

  // ===========================================================================
  // B10 — taking the second review
  // ===========================================================================

  it("B10 — an unplaced reviewer cannot take a second review; a placed one can", async () => {
    await setPlan("TEAM");
    const unplaced = await person("ADMIN");
    const offCase = await person("ADMIN", { placed: true });
    const placed = await person("ADMIN", { placed: true });
    const disputed = async (restrictedTo?: string[]) => {
      const wf = await workflow({ restrictedTo });
      return prisma.reviewerDisagreement.create({
        data: { teamId: A().teamId, workflowId: wf.workflowId, state: "FILED", challengerUserId: owner(), challengerRationale: "Disagree" },
        select: { id: true },
      });
    };
    const take = (disagreementId: string, actorUserId: string) =>
      disagreements.transitionDisagreement({ teamId: A().teamId, disagreementId, to: "UNDER_SECOND_REVIEW", actorUserId });
    const secondOf = async (id: string) =>
      prisma.reviewerDisagreement.findUniqueOrThrow({ where: { id }, select: { state: true, secondReviewerUserId: true } });

    const d = await disputed();
    expect(await take(d.id, unplaced.id)).toMatchObject({ ok: false, denial: "NOT_PERMITTED", code: "REVIEW_ASSIGNEE_NOT_PLACED" });
    expect(await secondOf(d.id)).toEqual({ state: "FILED", secondReviewerUserId: null });
    const restricted = await disputed([owner(), placed.id]);
    expect(await take(restricted.id, offCase.id)).toMatchObject({ ok: false, code: "REVIEW_ASSIGNEE_NOT_ELIGIBLE" });
    expect(await take(d.id, placed.id)).toEqual({ ok: true });
    expect(await secondOf(d.id)).toEqual({ state: "UNDER_SECOND_REVIEW", secondReviewerUserId: placed.id });
  });

  it("B10 — taking the supervisor review is the same act: an unplaced supervisor is refused; a placed one takes it", async () => {
    await setPlan("TEAM");
    const second = await person("ADMIN", { placed: true });
    const unplaced = await person("ADMIN");
    const placed = await person("ADMIN", { placed: true });
    const wf = await workflow({});
    const d = await prisma.reviewerDisagreement.create({
      data: { teamId: A().teamId, workflowId: wf.workflowId, state: "FILED", challengerUserId: owner(), challengerRationale: "Disagree" },
      select: { id: true },
    });
    const to = (state: "UNDER_SECOND_REVIEW" | "UNDER_SUPERVISOR_REVIEW", actorUserId: string) =>
      disagreements.transitionDisagreement({ teamId: A().teamId, disagreementId: d.id, to: state, actorUserId });
    expect(await to("UNDER_SECOND_REVIEW", second.id)).toEqual({ ok: true });
    expect(await to("UNDER_SUPERVISOR_REVIEW", unplaced.id)).toMatchObject({ ok: false, code: "REVIEW_ASSIGNEE_NOT_PLACED" });
    const row = () => prisma.reviewerDisagreement.findUniqueOrThrow({ where: { id: d.id }, select: { state: true, supervisorUserId: true } });
    expect(await row()).toEqual({ state: "UNDER_SECOND_REVIEW", supervisorUserId: null });
    expect(await to("UNDER_SUPERVISOR_REVIEW", placed.id)).toEqual({ ok: true });
    expect(await row()).toEqual({ state: "UNDER_SUPERVISOR_REVIEW", supervisorUserId: placed.id });
  });

  // ===========================================================================
  // B11 — the SIU profile's adjuster and SIU reviewer
  // ===========================================================================

  it("B11 — the SIU adjuster and SIU reviewer pass the authority for the case; an unchanged holder is not re-decided", async () => {
    await setPlan("TEAM");
    const unplaced = await person("MEMBER");
    const viewer = await person("VIEWER", { placed: true });
    const placed = await person("MEMBER", { placed: true });
    const stranger = await person(null);
    const c = await prisma.case.create({ data: { name: `B11 ${tag()}`, teamId: A().teamId, ownerUserId: owner() }, select: { id: true } });
    const url = `/v1/cases/${c.id}/siu-profile`;
    const profile = () => prisma.caseSiuProfile.findUnique({ where: { caseId: c.id } });

    const notPlaced = await put(url, A().ownerToken, { claimType: "auto", assignedAdjusterUserId: unplaced.id });
    expect(notPlaced.statusCode, notPlaced.body).toBe(422);
    expect(errorCode(notPlaced)).toBe("ASSIGNEE_NOT_PLACED");
    const foreign = await put(url, A().ownerToken, { claimType: "auto", assignedAdjusterUserId: stranger.id });
    expect(foreign.statusCode, foreign.body).toBe(422);
    expect(errorCode(foreign)).toBe("ASSIGNEE_NOT_ELIGIBLE");
    const viewerReviewer = await put(url, A().ownerToken, { claimType: "auto", assignedSIUReviewerUserId: viewer.id });
    expect(viewerReviewer.statusCode, viewerReviewer.body).toBe(422);
    expect(errorCode(viewerReviewer)).toBe("REVIEW_ASSIGNEE_NOT_ELIGIBLE");
    expect(await profile()).toBeNull();

    const ok = await put(url, A().ownerToken, {
      claimType: "auto",
      assignedAdjusterUserId: placed.id,
      assignedSIUReviewerUserId: placed.id,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await profile()).toMatchObject({ assignedAdjusterUserId: placed.id, assignedSiuReviewerUserId: placed.id });

    // The holder later loses placement; an unrelated edit that re-sends them is not refused.
    await prisma.collaborationTeamMember.updateMany({ where: { userId: placed.id }, data: { status: "REMOVED" } });
    const edit = await siu.upsertSiuProfile({
      caseId: c.id,
      teamId: A().teamId,
      actorUserId: owner(),
      patch: { claimType: "auto", claimNumber: "C-1", assignedAdjusterUserId: placed.id, assignedSIUReviewerUserId: placed.id },
    });
    expect(edit?.claimNumber ?? (await profile())?.claimNumber).toBe("C-1");
  });

  it("the Operations picker offers exactly whom the write accepts — a capability grant counts, a role without the permission does not", async () => {
    await setPlan("TEAM");
    const granted = await person("VIEWER", { placed: true });
    const plainViewer = await person("VIEWER", { placed: true });
    const member = await person("MEMBER", { placed: true });
    await prisma.memberCapabilityGrant.create({
      data: { teamMemberId: granted.memberId!, teamId: A().teamId, permission: "operations.acknowledge", grantedByUserId: owner() },
    });
    const offered = new Set(
      (await operators.listAssignableOperators({ teamId: A().teamId }, prisma)).map((o) => o.userId),
    );
    for (const p of [granted, plainViewer, member]) {
      const accepted = await operators.isAssignableOperator({ teamId: A().teamId, userId: p.id }, prisma);
      expect(offered.has(p.id), p.id).toBe(accepted);
    }
    expect(offered.has(granted.id)).toBe(true);
    expect(offered.has(plainViewer.id)).toBe(false);
  });
});
