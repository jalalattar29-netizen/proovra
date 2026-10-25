/**
 * PHASE C — TEAM TASKS (members audit CT-01, CT-04, CT-05, CT-06, CT-07,
 * CT-08, CT-11, REV-04).
 *
 * A Collaboration Team assignment is an internal task. It is a TEAM /
 * Enterprise capability (PRO keeps Collaboration Teams for case access and
 * basic record review), it moves through an explicit state machine, an
 * assignee acts only on their own task unless they hold the supervisory
 * capability, and it never shows anyone a record they cannot reach. Every
 * case drives the real services against a real PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Phase C — Team tasks", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let ct: typeof import("../src/services/collaboration-team/collaboration-team.service.js");
  const W = () => h.fixtures.personal;
  const owner = () => W().userId;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    ct = await import("../src/services/collaboration-team/collaboration-team.service.js");
    await plan("TEAM");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);

  async function plan(next: "FREE" | "PRO" | "TEAM") {
    await prisma.entitlement.updateMany({ where: { userId: owner() }, data: { active: false } });
    await prisma.entitlement.create({ data: { userId: owner(), plan: next, active: true, credits: 0 } });
  }

  async function person(role: "MEMBER" | "VIEWER" = "MEMBER") {
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    const email = `phase-c-task-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "Task", lastName: "Member", provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "integration-harness",
      })),
    });
    await prisma.teamMember.create({
      data: { teamId: W().teamId, userId: user.id, role: role === "VIEWER" ? "VIEWER" : "MEMBER", status: "ACTIVE" },
    });
    return user.id;
  }

  async function group(): Promise<string> {
    // Keep the workspace under its active-group capacity between cases.
    await prisma.collaborationTeam.updateMany({
      where: { workspaceId: W().teamId, status: "ACTIVE" },
      data: { status: "ARCHIVED", archivedAtUtc: new Date() },
    });
    const { id } = await ct.createCollaborationTeam({
      workspaceId: W().teamId,
      actorUserId: owner(),
      name: `Tasks ${tag()}`,
    });
    return id;
  }

  async function join(teamId: string, userId: string, role: "MEMBER" | "VIEWER" | "ADMIN" = "MEMBER") {
    await ct.addExistingMember({ teamId, actorUserId: owner(), userIdToAdd: userId, role });
  }

  async function openCase(opts: { restrictedTo?: string[] } = {}) {
    const c = await prisma.case.create({
      data: { name: `Case ${tag()}`, teamId: W().teamId, ownerUserId: owner() },
      select: { id: true },
    });
    for (const userId of opts.restrictedTo ?? []) {
      await prisma.caseAccess.create({ data: { caseId: c.id, userId } });
    }
    return c.id;
  }

  async function task(teamId: string, caseId: string, assigneeUserId?: string) {
    return ct.createAssignment({
      teamId,
      actorUserId: owner(),
      targetType: "CASE",
      targetId: caseId,
      assigneeUserId: assigneeUserId ?? null,
    });
  }

  const codeOf = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string }) => e.code ?? "unknown",
    );

  it("CT-01 — PRO may not create Team tasks; TEAM may", async () => {
    await plan("TEAM");
    const teamId = await group();
    const caseId = await openCase();
    await plan("PRO");
    expect(await codeOf(task(teamId, caseId))).toBe("ENTITLEMENT_REQUIRED");
    await plan("TEAM");
    await expect(task(teamId, caseId)).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("CT-01 — after a downgrade the assignee can still finish; nobody can hand work on", async () => {
    await plan("TEAM");
    const teamId = await group();
    const a = await person();
    const b = await person();
    await join(teamId, a);
    await join(teamId, b);
    const caseId = await openCase();
    const { id } = await task(teamId, caseId, a);
    await plan("PRO");
    expect(
      await codeOf(ct.updateAssignment({ teamId, actorUserId: owner(), assignmentId: id, assigneeUserId: b })),
    ).toBe("ENTITLEMENT_REQUIRED");
    await expect(
      ct.updateAssignment({ teamId, actorUserId: a, assignmentId: id, status: "COMPLETED" }),
    ).resolves.toBeUndefined();
    await plan("TEAM");
  });

  it("CT-08 — the state machine refuses what it does not list; terminal is terminal", async () => {
    const teamId = await group();
    const caseId = await openCase();
    const { id } = await task(teamId, caseId);
    await ct.updateAssignment({ teamId, actorUserId: owner(), assignmentId: id, status: "IN_PROGRESS" });
    await ct.updateAssignment({ teamId, actorUserId: owner(), assignmentId: id, status: "COMPLETED" });
    expect(
      await codeOf(ct.updateAssignment({ teamId, actorUserId: owner(), assignmentId: id, status: "IN_PROGRESS" })),
    ).toBe("ASSIGNMENT_TRANSITION_INVALID");
    expect(
      await codeOf(ct.updateAssignment({ teamId, actorUserId: owner(), assignmentId: id, status: "REASSIGNED" })),
    ).toBe("ASSIGNMENT_TRANSITION_INVALID");
    // Re-asserting the current state is an idempotent no-op.
    await expect(
      ct.updateAssignment({ teamId, actorUserId: owner(), assignmentId: id, status: "COMPLETED" }),
    ).resolves.toBeUndefined();
  });

  it("CT-08 — two concurrent completions write once and record one event", async () => {
    const teamId = await group();
    const a = await person();
    await join(teamId, a);
    const caseId = await openCase();
    const { id } = await task(teamId, caseId, a);
    const results = await Promise.allSettled([
      ct.updateAssignment({ teamId, actorUserId: a, assignmentId: id, status: "COMPLETED" }),
      ct.updateAssignment({ teamId, actorUserId: a, assignmentId: id, status: "COMPLETED" }),
      ct.updateAssignment({ teamId, actorUserId: owner(), assignmentId: id, status: "COMPLETED" }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(
      await prisma.collaborationTeamActivity.count({
        where: { teamId, eventType: "ASSIGNMENT_COMPLETED", targetId: id },
      }),
    ).toBe(1);
  });

  it("CT-07 — an assignee finishes their own task; a peer cannot finish it for them", async () => {
    const teamId = await group();
    const a = await person();
    const peer = await person();
    await join(teamId, a);
    await join(teamId, peer);
    const caseId = await openCase();
    const { id } = await task(teamId, caseId, a);
    expect(
      await codeOf(ct.updateAssignment({ teamId, actorUserId: peer, assignmentId: id, status: "COMPLETED" })),
    ).not.toBeNull();
    await expect(
      ct.updateAssignment({ teamId, actorUserId: a, assignmentId: id, status: "IN_PROGRESS" }),
    ).resolves.toBeUndefined();
    await expect(
      ct.updateAssignment({ teamId, actorUserId: a, assignmentId: id, status: "COMPLETED" }),
    ).resolves.toBeUndefined();
    // An assignee cannot cancel — that is a supervisory act.
    const { id: second } = await task(teamId, caseId, a);
    expect(
      await codeOf(ct.updateAssignment({ teamId, actorUserId: a, assignmentId: second, status: "CANCELLED" })),
    ).not.toBeNull();
  });

  it("CT-06 — a VIEWER, a suspended member and a non-member cannot be handed work", async () => {
    const teamId = await group();
    const viewer = await person();
    await join(teamId, viewer, "VIEWER");
    const suspended = await person();
    await join(teamId, suspended);
    await prisma.teamMember.updateMany({
      where: { teamId: W().teamId, userId: suspended },
      data: { status: "SUSPENDED" },
    });
    const outsider = await person();
    const caseId = await openCase();
    for (const assignee of [viewer, suspended, outsider]) {
      expect(await codeOf(task(teamId, caseId, assignee))).not.toBeNull();
    }
  });

  it("CT-04 — restricted cases: the picker, the write and the assignee all follow the case's own access", async () => {
    const teamId = await group();
    const insider = await person();
    const outsider = await person();
    await join(teamId, insider, "ADMIN");
    await join(teamId, outsider);
    const restricted = await openCase({ restrictedTo: [insider] });

    // The picker offers it to someone on its access list, not to someone off it.
    const forInsider = await ct.listAssignableTargets({ workspaceId: W().teamId, actorUserId: insider, targetType: "CASE" });
    const forOutsider = await ct.listAssignableTargets({ workspaceId: W().teamId, actorUserId: outsider, targetType: "CASE" });
    expect(forInsider.targets.map((t) => t.id)).toContain(restricted);
    expect(forOutsider.targets.map((t) => t.id)).not.toContain(restricted);

    // An assignee off the access list cannot be handed it.
    expect(
      await codeOf(
        ct.createAssignment({ teamId, actorUserId: insider, targetType: "CASE", targetId: restricted, assigneeUserId: outsider }),
      ),
    ).not.toBeNull();
    const { id } = await ct.createAssignment({
      teamId,
      actorUserId: insider,
      targetType: "CASE",
      targetId: restricted,
      assigneeUserId: insider,
    });

    // The task list names the case only for those who may read it.
    const insiderPage = await ct.listAssignments({ teamId, actorUserId: insider });
    const outsiderPage = await ct.listAssignments({ teamId, actorUserId: outsider });
    expect(insiderPage.items.find((i) => i.id === id)?.target.resolved).toBe(true);
    expect(outsiderPage.items.find((i) => i.id === id)?.target).toMatchObject({ resolved: false, label: null });
  });

  it("CT-05 — a record's responsibility panel shows only the viewer's own groups", async () => {
    const g1 = await group();
    const memberOfG1 = await person();
    await join(g1, memberOfG1);
    const caseId = await openCase();
    await task(g1, caseId, memberOfG1);
    // A second group carries the same record; the first group's member is not in it.
    await prisma.collaborationTeam.update({ where: { id: g1 }, data: { status: "ACTIVE", archivedAtUtc: null } });
    const { id: g2 } = await ct.createCollaborationTeam({ workspaceId: W().teamId, actorUserId: owner(), name: `Other ${tag()}` });
    await task(g2, caseId);

    const seen = await ct.listResponsibilityForTarget({
      workspaceId: W().teamId,
      actorUserId: memberOfG1,
      targetType: "CASE",
      targetId: caseId,
    });
    expect(seen.assignments.map((a) => a.teamId)).toEqual([g1]);
  });

  it("CT-11 — archiving a group settles its open tasks through the state machine", async () => {
    const teamId = await group();
    const caseId = await openCase();
    const { id: open } = await task(teamId, caseId);
    const { id: done } = await task(teamId, caseId);
    await ct.updateAssignment({ teamId, actorUserId: owner(), assignmentId: done, status: "COMPLETED" });
    await ct.archiveCollaborationTeam({ teamId, actorUserId: owner() });
    const rows = await prisma.collaborationTeamAssignment.findMany({
      where: { id: { in: [open, done] } },
      select: { id: true, status: true },
    });
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [open]: "CANCELLED", [done]: "COMPLETED" });
    expect(
      await prisma.collaborationTeamActivity.count({
        where: { teamId, eventType: "ASSIGNMENT_CANCELLED", targetId: open },
      }),
    ).toBe(1);
  });
});
