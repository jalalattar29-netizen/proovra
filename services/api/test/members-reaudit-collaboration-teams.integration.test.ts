/**
 * MEMBERS RE-AUDIT — PACKAGE D1a: Collaboration Teams (members audit CT-03,
 * CT-04, CT-06, CT-12, CT-13, CT-14, SEC-03).
 *
 * Real routes and real services against a real PostgreSQL:
 *
 *   - CT-12  a refused creation writes its `denied` audit row; a bulk add
 *            answers with a per-person reason code;
 *   - CT-13  the server applies the type and status filters and the sort,
 *            across pages;
 *   - CT-14  the pending-invitation count the entitlement reports is the
 *            workspace invitations that are actually pending;
 *   - CT-03  reinstating a suspended member is refused on a plan without
 *            Collaboration Team places, though the group has room;
 *   - CT-04  EVIDENCE and REVIEW task targets follow the record's own access,
 *            as CASE targets do;
 *   - CT-06  each ineligible assignee is refused with its specific code;
 *   - no customer hard-delete route remains (2026-10-28: Collaboration Teams
 *            are archived, never deleted).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = import("@prisma/client").PrismaClient;
const WS = "x-proovra-workspace-id";

describe("Members re-audit D1a — Collaboration Teams (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let ct: typeof import("../src/services/collaboration-team/collaboration-team.service.js");
  let invitations: typeof import("../src/services/identity/workspace-invitation.service.js");
  let legalVersions: Record<string, string>;
  let orgA: string;
  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    ct = await import("../src/services/collaboration-team/collaboration-team.service.js");
    invitations = await import("../src/services/identity/workspace-invitation.service.js");
    legalVersions = (await import("../src/legal/legal-versioning.js")).REQUIRED_LEGAL_VERSIONS as Record<string, string>;
    orgA = (await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } })).organizationId;
    // TEAM includes Collaboration Teams and Team tasks; workspace B stays on
    // the harness default (FREE), which includes neither.
    await plan(A().teamId, "TEAM");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const owner = () => A().ownerUserId;

  async function plan(teamId: string, next: "FREE" | "PRO" | "TEAM") {
    await prisma.team.updateMany({ where: { id: teamId }, data: { billingPlan: next, billingStatus: "ACTIVE" } });
  }

  async function person(role: "MEMBER" | "VIEWER" | null = "MEMBER") {
    const email = `d1a-ct-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "D1a", lastName: "Collab", provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legalVersions).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion,
        source: "integration-harness",
      })),
    });
    if (role) await prisma.teamMember.create({ data: { teamId: A().teamId, userId: user.id, role, status: "ACTIVE" } });
    return user.id;
  }

  /** A fresh ACTIVE group in workspace A; earlier groups are archived so capacity never decides a case. */
  async function group(opts: { name?: string; teamType?: string } = {}) {
    await prisma.collaborationTeam.updateMany({
      where: { workspaceId: A().teamId, status: "ACTIVE" },
      data: { status: "ARCHIVED", archivedAtUtc: new Date() },
    });
    const { id } = await ct.createCollaborationTeam({
      workspaceId: A().teamId,
      actorUserId: owner(),
      name: opts.name ?? `D1a group ${tag()}`,
      teamType: (opts.teamType as never) ?? null,
    });
    return id;
  }

  const codeOf = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string }) => e.code ?? "unknown",
    );

  const errorCode = (res: { json: () => unknown }) => {
    const b = res.json() as { code?: string; error?: { code?: string } };
    return b.error?.code ?? b.code;
  };

  // ===========================================================================
  // CT-12
  // ===========================================================================

  it("CT-12 — a creation refused by the plan writes a denied collaboration_team.created audit row with its reason", async () => {
    const name = `d1a denied ${tag()}`;
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/collaboration-teams",
      headers: { ...bearer(B().ownerToken), [WS]: B().teamId },
      payload: { name },
    });
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    const reason = errorCode(res);
    expect(reason).toEqual(expect.any(String));
    expect(await prisma.collaborationTeam.count({ where: { name } })).toBe(0);

    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "collaboration_team.created", workspaceId: B().teamId, outcome: "denied" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.userId).toBe(B().ownerUserId);
    expect((audit.metadata as Record<string, unknown>).reason).toBe(reason);
  });

  it("CT-12 — a bulk add answers per person: added, or refused with that person's own reason code", async () => {
    const teamId = await group();
    const member = await person("MEMBER");
    const outsider = await person(null);
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/collaboration-teams/${teamId}/members/bulk`,
      headers: { ...bearer(A().ownerToken), [WS]: A().teamId },
      payload: { userIds: [member, outsider], role: "MEMBER" },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { added: string[]; failed: Array<{ userId: string; reason: string }> };
    expect(body.added).toEqual([member]);
    expect(body.failed).toEqual([{ userId: outsider, reason: "COLLABORATION_MEMBER_NOT_IN_WORKSPACE" }]);

    // A plan refusal keeps its own code too: FREE has no group places, so the
    // one growth-lock code (billing-guards assertTeamsFeatureIncluded).
    const late = await person("MEMBER");
    await plan(A().teamId, "FREE");
    try {
      const refused = await h.app.inject({
        method: "POST",
        url: `/v1/collaboration-teams/${teamId}/members/bulk`,
        headers: { ...bearer(A().ownerToken), [WS]: A().teamId },
        payload: { userIds: [late] },
      });
      if (refused.statusCode === 409) {
        const failed = (refused.json() as { failed: Array<{ userId: string; reason: string }> }).failed;
        expect(failed).toEqual([{ userId: late, reason: "TEAM_INVITES_NOT_INCLUDED" }]);
      } else {
        // Refused before the per-person loop by the plan gate: still typed.
        expect(refused.statusCode).toBeGreaterThanOrEqual(400);
        expect(refused.statusCode).toBeLessThan(500);
        expect(errorCode(refused)).toEqual(expect.any(String));
      }
      expect(await prisma.collaborationTeamMember.count({ where: { teamId, userId: late } })).toBe(0);
    } finally {
      await plan(A().teamId, "TEAM");
    }
  });

  // ===========================================================================
  // CT-13
  // ===========================================================================

  it("CT-13 — the server applies the type and status filters and the name sort, across pages", async () => {
    await group(); // archives whatever was active
    const run = tag();
    const make = async (name: string, teamType: string) =>
      (await ct.createCollaborationTeam({ workspaceId: A().teamId, actorUserId: owner(), name, teamType: teamType as never })).id;
    const legalB = await make(`${run} b-legal`, "LEGAL");
    const legalA = await make(`${run} a-legal`, "LEGAL");
    const inv = await make(`${run} c-investigation`, "INVESTIGATION");
    const archived = await make(`${run} d-legal-archived`, "LEGAL");
    await ct.archiveCollaborationTeam({ teamId: archived, actorUserId: owner() });

    const page = (q: string) =>
      h.app.inject({
        method: "GET",
        url: `/v1/collaboration-teams?scope=all&q=${encodeURIComponent(run)}&${q}`,
        headers: { ...bearer(A().ownerToken), [WS]: A().teamId },
      });
    const ids = (res: { json: () => unknown }) => (res.json() as { teams: Array<{ id: string }> }).teams.map((t) => t.id);

    // Type filter + NAME_ASC, one row per page: the order is the database's.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const res = await page(`type=LEGAL&sort=NAME_ASC&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.statusCode, res.body).toBe(200);
      seen.push(...ids(res));
      cursor = (res.json() as { nextCursor: string | null }).nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([legalA, legalB]);

    const investigation = await page("type=INVESTIGATION");
    expect(ids(investigation)).toEqual([inv]);

    const onlyArchived = await page("status=ARCHIVED&includeArchived=true");
    expect(ids(onlyArchived)).toEqual([archived]);

    const active = await page("status=ACTIVE&sort=NAME_ASC");
    expect(ids(active)).toEqual([legalA, legalB, inv]);
  });

  // ===========================================================================
  // CT-14
  // ===========================================================================

  it("CT-14 — the entitlement's pending-invitation count is the workspace invitations actually pending", async () => {
    const read = async () => {
      const res = await h.app.inject({
        method: "GET",
        url: "/v1/collaboration-teams/entitlement",
        headers: { ...bearer(A().ownerToken), [WS]: A().teamId },
      });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { invitations: { pending: number } }).invitations.pending;
    };
    const base = await read();
    const mk = (suffix: string) =>
      invitations.createWorkspaceInvitation({
        workspaceId: A().teamId,
        email: `d1a-ct14-${suffix}-${tag()}@invitee.test`,
        role: "MEMBER",
        invitedByUserId: owner(),
      });
    await mk("pending-1");
    await mk("pending-2");
    const expired = await mk("expired");
    const revoked = await mk("revoked");
    const accepted = await mk("accepted");
    await prisma.teamInvite.update({ where: { id: expired.invite.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await invitations.revokeWorkspaceInvitation({ workspaceId: A().teamId, inviteId: revoked.invite.id, actorUserId: owner() });
    await prisma.teamInvite.update({ where: { id: accepted.invite.id }, data: { acceptedAt: new Date() } });

    expect(await read()).toBe(base + 2);
  });

  // ===========================================================================
  // CT-03 — reinstatement respects the plan, not only the group's room.
  // ===========================================================================

  it("CT-03 — after a downgrade to a plan with no group places, reinstating a suspended member is refused though the group has room", async () => {
    const teamId = await group();
    const m = await person("MEMBER");
    const { id: memberId } = await ct.addExistingMember({ teamId, actorUserId: owner(), userIdToAdd: m, role: "MEMBER" });
    await ct.suspendMember({ teamId, actorUserId: owner(), memberId });
    await plan(A().teamId, "FREE");
    try {
      // The plan's growth lock (no group places on FREE), not the group's room.
      expect(await codeOf(ct.reinstateMember({ teamId, actorUserId: owner(), memberId }))).toBe(
        "TEAM_INVITES_NOT_INCLUDED",
      );
      expect((await prisma.collaborationTeamMember.findUniqueOrThrow({ where: { id: memberId } })).status).toBe("SUSPENDED");
    } finally {
      await plan(A().teamId, "TEAM");
    }
    // Control: on TEAM the same reinstatement is allowed.
    await expect(ct.reinstateMember({ teamId, actorUserId: owner(), memberId })).resolves.toBeUndefined();
    expect((await prisma.collaborationTeamMember.findUniqueOrThrow({ where: { id: memberId } })).status).toBe("ACTIVE");
  });

  // ===========================================================================
  // CT-04 / CT-06 — task targets and assignees.
  // ===========================================================================

  async function restrictedEvidence(allowed: string[]) {
    const evidence = await prisma.evidence.create({
      data: {
        title: `D1a ${tag()}`,
        type: "PHOTO",
        status: "CREATED",
        teamId: A().teamId,
        organizationId: orgA,
        ownerUserId: owner(),
      } as never,
      select: { id: true },
    });
    const kase = await prisma.case.create({
      data: { name: `D1a restricted ${tag()}`, teamId: A().teamId, ownerUserId: owner() },
      select: { id: true },
    });
    for (const userId of allowed) await prisma.caseAccess.create({ data: { caseId: kase.id, userId } });
    await prisma.caseEvidenceLink.create({ data: { caseId: kase.id, evidenceId: evidence.id } });
    return evidence.id;
  }

  it("CT-04 — EVIDENCE and REVIEW targets follow the record's access: picker, write and assignee", async () => {
    const teamId = await group();
    const insider = await person("MEMBER");
    const outsider = await person("MEMBER");
    await ct.addExistingMember({ teamId, actorUserId: owner(), userIdToAdd: insider, role: "ADMIN" });
    // ADMIN in the group, like the insider: both may create tasks, so the only
    // difference the assertions below observe is access to the record.
    await ct.addExistingMember({ teamId, actorUserId: owner(), userIdToAdd: outsider, role: "ADMIN" });
    const evidenceId = await restrictedEvidence([insider]);
    const review = await prisma.evidenceReviewWorkflow.create({
      data: { teamId: A().teamId, evidenceId, workspaceType: "TEAM" },
      select: { id: true },
    });

    for (const [targetType, targetId] of [
      ["EVIDENCE", evidenceId],
      ["REVIEW", review.id],
    ] as const) {
      const forInsider = await ct.listAssignableTargets({ workspaceId: A().teamId, actorUserId: insider, targetType });
      const forOutsider = await ct.listAssignableTargets({ workspaceId: A().teamId, actorUserId: outsider, targetType });
      expect(forInsider.targets.map((t) => t.id)).toContain(targetId);
      expect(forOutsider.targets.map((t) => t.id)).not.toContain(targetId);

      // An actor off the access list cannot create the task: the not-found answer.
      expect(await codeOf(ct.createAssignment({ teamId, actorUserId: outsider, targetType, targetId }))).toBe("team_not_found");
      // An assignee off the access list cannot be handed it.
      expect(
        await codeOf(ct.createAssignment({ teamId, actorUserId: insider, targetType, targetId, assigneeUserId: outsider })),
      ).toBe("TASK_ASSIGNEE_NO_RECORD_ACCESS");
      await expect(
        ct.createAssignment({ teamId, actorUserId: insider, targetType, targetId, assigneeUserId: insider }),
      ).resolves.toMatchObject({ id: expect.any(String) });
    }
  });

  it("CT-06 — a VIEWER, a suspended member and a non-member are refused with TASK_ASSIGNEE_NOT_ELIGIBLE", async () => {
    const teamId = await group();
    const viewer = await person("MEMBER");
    await ct.addExistingMember({ teamId, actorUserId: owner(), userIdToAdd: viewer, role: "VIEWER" });
    const suspended = await person("MEMBER");
    await ct.addExistingMember({ teamId, actorUserId: owner(), userIdToAdd: suspended, role: "MEMBER" });
    await prisma.teamMember.updateMany({ where: { teamId: A().teamId, userId: suspended }, data: { status: "SUSPENDED" } });
    const nonMember = await person("MEMBER");
    const kase = await prisma.case.create({
      data: { name: `D1a open ${tag()}`, teamId: A().teamId, ownerUserId: owner() },
      select: { id: true },
    });
    for (const assigneeUserId of [viewer, suspended, nonMember]) {
      expect(
        await codeOf(ct.createAssignment({ teamId, actorUserId: owner(), targetType: "CASE", targetId: kase.id, assigneeUserId })),
      ).toBe("TASK_ASSIGNEE_NOT_ELIGIBLE");
    }
    // The route answers with the same typed code, not a generic invalid.
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/collaboration-teams/${teamId}/assignments`,
      headers: { ...bearer(A().ownerToken), [WS]: A().teamId },
      payload: { targetType: "CASE", targetId: kase.id, assigneeUserId: viewer },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(errorCode(res)).toBe("TASK_ASSIGNEE_NOT_ELIGIBLE");
  });

  // ===========================================================================
  // 2026-10-28 — a Collaboration Team is never customer-deleted. The former
  // SEC-03 delete (and its disposability projection) is gone; retirement is
  // the step-up-gated archive (collaboration-team-archive.integration.test.ts).
  // ===========================================================================

  it("no customer hard-delete route remains reachable", async () => {
    const teamId = await group();
    const headers = { ...bearer(A().ownerToken), [WS]: A().teamId };
    const del = await h.app.inject({ method: "DELETE", url: `/v1/collaboration-teams/${teamId}`, headers });
    expect(del.statusCode, del.body).toBe(404);
    const disp = await h.app.inject({ method: "GET", url: `/v1/collaboration-teams/${teamId}/disposability`, headers });
    expect(disp.statusCode, disp.body).toBe(404);
    await h.handlersSettled();
    expect(await prisma.collaborationTeam.findUnique({ where: { id: teamId } })).not.toBeNull();
  });
});
