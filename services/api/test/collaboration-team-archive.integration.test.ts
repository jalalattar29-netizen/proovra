/**
 * ARCHIVE COLLABORATION TEAM — Section G proofs (2026-10-28).
 *
 * Real routes and real services against a real PostgreSQL. A Collaboration
 * Team is never customer-deleted; archiving needs the canonical permission,
 * the exact team name and a RECENT STEP-UP bound to this actor, Workspace,
 * group and purpose, and it commits its lifecycle, access, work and audit
 * effects together. Restore re-checks everything that admits a group.
 *
 * Passkey, Enterprise IdP and SCIM step-up paths are proven in their own
 * files (step-up-passkey / step-up-idp integration tests); here the step-up
 * is the real authenticator-app ceremony.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

type Prisma = import("@prisma/client").PrismaClient;
const WS = "x-proovra-workspace-id";
const HEADER = "x-proovra-step-up-challenge-id";

describe("Archive Collaboration Team — Section G (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let ct: typeof import("../src/services/collaboration-team/collaboration-team.service.js");
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let legalVersions: Record<string, string>;
  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    ct = await import("../src/services/collaboration-team/collaboration-team.service.js");
    legalVersions = (await import("../src/legal/legal-versioning.js")).REQUIRED_LEGAL_VERSIONS as Record<string, string>;
    stepUp = createStepUpCeremony({
      prisma,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    await plan(A().teamId, "TEAM");
    await plan(B().teamId, "TEAM");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // The ladder purposes bound how many challenges a person may START in a
  // window; every test here starts its own, so the window is cleared first.
  beforeEach(async () => {
    await prisma.stepUpChallenge.deleteMany({ where: { initiatedByUserId: { in: [A().ownerUserId, B().ownerUserId] } } });
  });

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const owner = () => A().ownerUserId;
  const headersA = () => ({ ...bearer(A().ownerToken), [WS]: A().teamId });
  const errorCode = (res: { json: () => unknown }) => {
    const b = res.json() as { code?: string; error?: { code?: string } };
    return b.error?.code ?? b.code;
  };

  async function plan(teamId: string, next: "FREE" | "PRO" | "TEAM") {
    await prisma.team.updateMany({ where: { id: teamId }, data: { billingPlan: next, billingStatus: "ACTIVE" } });
  }

  async function person(role: "MEMBER" | "VIEWER" = "MEMBER") {
    const email = `g-arch-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "G", lastName: "Archive", provider: "EMAIL", providerUserId: email },
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
    await prisma.teamMember.create({ data: { teamId: A().teamId, userId: user.id, role, status: "ACTIVE" } });
    return user.id;
  }

  /** A fresh ACTIVE group in workspace A; earlier active groups are archived so capacity never decides a case. */
  async function group(name = `G archive ${tag()}`) {
    await prisma.collaborationTeam.updateMany({
      where: { workspaceId: A().teamId, status: "ACTIVE" },
      data: { status: "ARCHIVED", archivedAtUtc: new Date() },
    });
    const { id } = await ct.createCollaborationTeam({ workspaceId: A().teamId, actorUserId: owner(), name });
    return { id, name };
  }

  function approved(resourceId: string, purpose = "COLLABORATION_TEAM_ARCHIVE") {
    return stepUp.approvedHeader({
      token: A().ownerToken,
      userId: owner(),
      teamId: A().teamId,
      purpose,
      resourceKind: "collaboration_team",
      resourceId,
    });
  }

  function archive(teamId: string, confirmName: string, extra: Record<string, string> = {}) {
    return h.app.inject({
      method: "POST",
      url: `/v1/collaboration-teams/${teamId}/archive`,
      headers: { ...headersA(), ...extra },
      payload: { confirmName },
    });
  }

  const status = async (teamId: string) =>
    (await prisma.collaborationTeam.findUniqueOrThrow({ where: { id: teamId } })).status;
  const archiveAudits = (teamId: string) =>
    prisma.adminAuditLog.count({ where: { action: "collaboration_team.archived", resourceId: teamId, outcome: "success" } });

  // 1 — permission
  it("1. archive is refused without the archive permission (a group MEMBER), and nothing changes", async () => {
    const g = await group();
    const member = A().memberUserId;
    await ct.addExistingMember({ teamId: g.id, actorUserId: owner(), userIdToAdd: member, role: "MEMBER" });
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/collaboration-teams/${g.id}/archive`,
      headers: { ...bearer(A().memberToken), [WS]: A().teamId },
      payload: { confirmName: g.name },
    });
    expect(res.statusCode).toBe(404);
    const impact = await h.app.inject({
      method: "GET",
      url: `/v1/collaboration-teams/${g.id}/archive-impact`,
      headers: { ...bearer(A().memberToken), [WS]: A().teamId },
    });
    expect(impact.statusCode).toBe(404);
    // The service refuses the same actor regardless of route.
    await expect(ct.archiveCollaborationTeam({ teamId: g.id, actorUserId: member })).rejects.toMatchObject({
      httpStatus: 403,
    });
    await h.handlersSettled();
    expect(await status(g.id)).toBe("ACTIVE");
    expect(await archiveAudits(g.id)).toBe(0);
  });

  // 2 — non-enumeration
  it("2. a foreign or hidden group is non-enumerating: the same 404 as a group that does not exist", async () => {
    const g = await group();
    const foreign = await h.app.inject({
      method: "POST",
      url: `/v1/collaboration-teams/${g.id}/archive`,
      headers: { ...bearer(B().ownerToken), [WS]: B().teamId },
      payload: { confirmName: g.name },
    });
    const missing = await h.app.inject({
      method: "POST",
      url: `/v1/collaboration-teams/${randomUUID()}/archive`,
      headers: { ...bearer(B().ownerToken), [WS]: B().teamId },
      payload: { confirmName: g.name },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(missing.json());
    const impact = await h.app.inject({
      method: "GET",
      url: `/v1/collaboration-teams/${g.id}/archive-impact`,
      headers: { ...bearer(B().ownerToken), [WS]: B().teamId },
    });
    expect(impact.statusCode).toBe(404);
    expect(await status(g.id)).toBe("ACTIVE");
  });

  it("2b. an archived group is named only to someone who may see it: a non-member gets the opaque 404, not 409", async () => {
    const g = await group();
    expect((await archive(g.id, g.name, await approved(g.id))).statusCode).toBe(200);
    // A workspace MEMBER who holds the workspace permission but is not in the
    // group: the only gate left is visibility, and it must not say "archived"
    // about a group this person cannot see.
    const outsider = await h.app.inject({
      method: "POST",
      url: `/v1/collaboration-teams/${g.id}/archive`,
      headers: { ...bearer(A().memberToken), [WS]: A().teamId },
      payload: { confirmName: g.name },
    });
    const missing = await h.app.inject({
      method: "POST",
      url: `/v1/collaboration-teams/${randomUUID()}/archive`,
      headers: { ...bearer(A().memberToken), [WS]: A().teamId },
      payload: { confirmName: g.name },
    });
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json()).toEqual(missing.json());
    // The Lead, who may see it, is told it is archived.
    const lead = await archive(g.id, g.name);
    expect(lead.statusCode).toBe(409);
    expect(errorCode(lead)).toBe("collaboration_team_archived");
  });

  // 3 / 11 — no mutation before step-up; a failed or expired step-up mutates nothing
  it("3/11. no archive, access or work mutation happens before a successful step-up", async () => {
    const g = await group();
    const kase = await prisma.case.create({ data: { name: `G case ${tag()}`, teamId: A().teamId, ownerUserId: owner() } });
    const task = await ct.createAssignment({ teamId: g.id, actorUserId: owner(), targetType: "CASE", targetId: kase.id });
    const invite = await prisma.collaborationTeamInvite.create({
      data: {
        teamId: g.id,
        workspaceId: A().teamId,
        channel: "EMAIL",
        email: `pending-${tag()}@test.proovra.local`,
        tokenHash: randomUUID().replace(/-/g, ""),
        expiresAtUtc: new Date(Date.now() + 86_400_000),
        createdByUserId: owner(),
      },
    });
    const untouched = async () => {
      await h.handlersSettled();
      expect(await status(g.id)).toBe("ACTIVE");
      expect((await prisma.collaborationTeamAssignment.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("OPEN");
      expect((await prisma.collaborationTeamInvite.findUniqueOrThrow({ where: { id: invite.id } })).status).toBe("PENDING");
      expect(await archiveAudits(g.id)).toBe(0);
    };

    // No step-up at all.
    const none = await archive(g.id, g.name);
    expect(none.statusCode).toBe(401);
    expect(errorCode(none)).toBe("STEP_UP_REQUIRED");
    await untouched();

    // A wrong name is refused BEFORE a step-up is spent.
    const header = await approved(g.id);
    const wrongName = await archive(g.id, g.name.toUpperCase(), header);
    expect(wrongName.statusCode).toBe(400);
    expect(errorCode(wrongName)).toBe("ARCHIVE_CONFIRMATION_MISMATCH");
    await untouched();
    expect((await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id: header[HEADER]! } })).status).toBe("APPROVED");

    // An expired approval.
    await prisma.stepUpChallenge.update({ where: { id: header[HEADER]! }, data: { expiresAtUtc: new Date(Date.now() - 1000) } });
    const expired = await archive(g.id, g.name, header);
    expect(expired.statusCode).toBe(401);
    await untouched();

    // A cancelled (never approved) challenge.
    const started = await h.app.inject({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      headers: bearer(A().ownerToken),
      payload: { teamId: A().teamId, purpose: "COLLABORATION_TEAM_ARCHIVE", resourceKind: "collaboration_team", resourceId: g.id },
    });
    expect(started.statusCode, started.body).toBe(200);
    const pendingId = (started.json() as { challenge: { id: string } }).challenge.id;
    const pending = await archive(g.id, g.name, { [HEADER]: pendingId });
    expect(pending.statusCode).toBe(401);
    await untouched();
  });

  // 12 / 13 — replay and reuse
  it("12/13. an approval cannot be replayed, nor reused for another group, Workspace or operation", async () => {
    const g = await group();
    const other = await prisma.collaborationTeam.create({
      data: { workspaceId: A().teamId, name: `G other ${tag()}`, createdByUserId: owner(), status: "ACTIVE" },
    });

    // Bound to ANOTHER group.
    const forOther = await approved(other.id);
    expect((await archive(g.id, g.name, forOther)).statusCode).toBe(401);
    // Bound to ANOTHER operation (same group).
    const otherPurpose = await approved(g.id, "CASE_DELETE");
    expect((await archive(g.id, g.name, otherPurpose)).statusCode).toBe(401);
    // Bound to ANOTHER Workspace: B's owner cannot spend A's approval on a B group.
    const bGroup = await ct.createCollaborationTeam({ workspaceId: B().teamId, actorUserId: B().ownerUserId, name: `G b ${tag()}` });
    const forA = await approved(g.id);
    const crossWs = await h.app.inject({
      method: "POST",
      url: `/v1/collaboration-teams/${bGroup.id}/archive`,
      headers: { ...bearer(B().ownerToken), [WS]: B().teamId, ...forA },
      payload: { confirmName: (await prisma.collaborationTeam.findUniqueOrThrow({ where: { id: bGroup.id } })).name },
    });
    expect(crossWs.statusCode).toBe(401);
    await h.handlersSettled();
    expect(await status(g.id)).toBe("ACTIVE");
    expect(await status(bGroup.id)).toBe("ACTIVE");

    // Spent once...
    const ok = await archive(g.id, g.name, forA);
    expect(ok.statusCode, ok.body).toBe(200);
    // ...and never again: restore, then replay the same approval.
    await ct.unarchiveCollaborationTeam({ teamId: g.id, actorUserId: owner() });
    const replay = await archive(g.id, g.name, forA);
    expect(replay.statusCode).toBe(401);
    await h.handlersSettled();
    expect(await status(g.id)).toBe("ACTIVE");
  });

  // 14 / 15 — concurrency and audit
  it("14/15. concurrent archives make ONE transition and ONE success audit, which carries no secret", async () => {
    const g = await group();
    const [h1, h2] = [await approved(g.id), await approved(g.id)];
    const results = await Promise.all([archive(g.id, g.name, h1), archive(g.id, g.name, h2)]);
    for (const r of results) expect([200, 409]).toContain(r.statusCode);
    await h.handlersSettled();
    expect(await status(g.id)).toBe("ARCHIVED");
    expect(await archiveAudits(g.id)).toBe(1);
    expect(
      await prisma.collaborationTeamActivity.count({ where: { teamId: g.id, eventType: "TEAM_ARCHIVED" } }),
    ).toBe(1);

    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "collaboration_team.archived", resourceId: g.id, outcome: "success" },
    });
    expect(audit.userId).toBe(owner());
    expect(audit.workspaceId).toBe(A().teamId);
    const meta = audit.metadata as Record<string, unknown>;
    expect(meta.stepUpMethod).toBe("AUTHENTICATOR_APP");
    expect(meta.affected).toMatchObject({ cancelledAssignments: 0, revokedInvites: 0 });
    const serialized = JSON.stringify(audit);
    for (const secret of [h1[HEADER], h2[HEADER], A().ownerToken]) {
      expect(serialized).not.toContain(secret!);
    }
    expect(serialized).not.toMatch(/"code"\s*:\s*"\d{6}"/);
  });

  // 16 / 18 — archive preserves history, releases a slot, and freezes the group
  it("16/18. archive keeps the row and its history, frees one active slot, and the group takes no new work, grant, post or member", async () => {
    // TEAM sells 5 active Collaboration Teams: fill them.
    {
      const g = await group();
      for (let i = 0; i < 4; i += 1) {
        await ct.createCollaborationTeam({ workspaceId: A().teamId, actorUserId: owner(), name: `G fill ${tag()}` });
      }
      const member = await person("MEMBER");
      await ct.addExistingMember({ teamId: g.id, actorUserId: owner(), userIdToAdd: member, role: "MEMBER" });
      const kase = await prisma.case.create({ data: { name: `G case ${tag()}`, teamId: A().teamId, ownerUserId: owner() } });
      const task = await ct.createAssignment({ teamId: g.id, actorUserId: owner(), targetType: "CASE", targetId: kase.id });
      await prisma.collaborationTeamComment.create({
        data: { teamId: g.id, workspaceId: A().teamId, authorUserId: owner(), targetType: "TEAM", body: "history" },
      });

      // At capacity: a third group is refused.
      await expect(
        ct.createCollaborationTeam({ workspaceId: A().teamId, actorUserId: owner(), name: `G third ${tag()}` }),
      ).rejects.toMatchObject({ code: "TEAM_LIMIT_REACHED" });

      const res = await archive(g.id, g.name, await approved(g.id));
      expect(res.statusCode, res.body).toBe(200);

      const row = await prisma.collaborationTeam.findUniqueOrThrow({ where: { id: g.id } });
      expect(row).toMatchObject({ status: "ARCHIVED", archivedByUserId: owner() });
      expect(row.archivedAtUtc).not.toBeNull();
      expect(await prisma.collaborationTeamMember.count({ where: { teamId: g.id, userId: member } })).toBe(1);
      expect((await prisma.collaborationTeamAssignment.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("CANCELLED");
      expect(await prisma.collaborationTeamComment.count({ where: { teamId: g.id } })).toBe(1);
      expect(await prisma.collaborationTeamActivity.count({ where: { teamId: g.id } })).toBeGreaterThan(1);

      // One slot freed: a new group fits.
      const third = await ct.createCollaborationTeam({ workspaceId: A().teamId, actorUserId: owner(), name: `G third ${tag()}` });
      expect(third.id).toEqual(expect.any(String));

      // Frozen: no new work, grant, post or member.
      const h0 = headersA();
      const assign = await h.app.inject({
        method: "POST",
        url: `/v1/collaboration-teams/${g.id}/assignments`,
        headers: h0,
        payload: { targetType: "CASE", targetId: kase.id },
      });
      expect(assign.statusCode).toBe(409);
      const grant = await h.app.inject({
        method: "POST",
        url: `/v1/cases/${kase.id}/team-access`,
        headers: h0,
        payload: { collaborationTeamId: g.id },
      });
      expect(grant.statusCode).toBe(409);
      const post = await h.app.inject({
        method: "POST",
        url: `/v1/collaboration-teams/${g.id}/comments`,
        headers: h0,
        payload: { targetType: "TEAM", body: "after archive" },
      });
      expect(post.statusCode).toBe(409);
      const add = await h.app.inject({
        method: "POST",
        url: `/v1/collaboration-teams/${g.id}/members`,
        headers: h0,
        payload: { userId: await person("MEMBER") },
      });
      expect(add.statusCode).toBe(409);
      expect(await prisma.collaborationTeamComment.count({ where: { teamId: g.id } })).toBe(1);
    }
  });

  it("18. a pending invitation is revoked by the archive, and an invite link to an archived group is refused", async () => {
    const g = await group();
    const raw = randomUUID();
    const { createHash } = await import("node:crypto");
    const invitee = await person("MEMBER");
    const email = (await prisma.user.findUniqueOrThrow({ where: { id: invitee } })).email!;
    const invite = await prisma.collaborationTeamInvite.create({
      data: {
        teamId: g.id,
        workspaceId: A().teamId,
        channel: "EMAIL",
        email,
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        expiresAtUtc: new Date(Date.now() + 86_400_000),
        createdByUserId: owner(),
      },
    });
    expect((await archive(g.id, g.name, await approved(g.id))).statusCode).toBe(200);
    expect((await prisma.collaborationTeamInvite.findUniqueOrThrow({ where: { id: invite.id } })).status).toBe("REVOKED");
    // Even a link revived by hand cannot join an archived group.
    await prisma.collaborationTeamInvite.update({ where: { id: invite.id }, data: { status: "PENDING", revokedAtUtc: null } });
    await expect(ct.acceptInvite({ rawToken: raw, actorUserId: invitee })).rejects.toMatchObject({
      code: "collaboration_team_archived",
    });
    expect(await prisma.collaborationTeamMember.count({ where: { teamId: g.id, userId: invitee } })).toBe(0);
  });

  // 17 — restore rechecks
  it("17. restore re-checks plan entitlement, the active-Team count and per-Team member capacity", async () => {
    const g = await group();
    expect((await archive(g.id, g.name, await approved(g.id))).statusCode).toBe(200);
    try {
      // Plan entitlement: a plan without Collaboration Teams restores nothing.
      await plan(A().teamId, "FREE");
      await expect(ct.unarchiveCollaborationTeam({ teamId: g.id, actorUserId: owner() })).rejects.toMatchObject({
        code: "TEAM_PLAN_REQUIRED",
      });
      await plan(A().teamId, "TEAM");

      // Per-Team capacity: eleven accepted non-owner members (a group that
      // was archived over today's 10-per-Team limit) cannot return.
      const extra: string[] = [];
      for (let i = 0; i < 11; i += 1) {
        const id = await person("MEMBER");
        extra.push(id);
        await prisma.collaborationTeamMember.create({
          data: { teamId: g.id, userId: id, role: "MEMBER", status: "ACTIVE" },
        });
      }
      await expect(ct.unarchiveCollaborationTeam({ teamId: g.id, actorUserId: owner() })).rejects.toMatchObject({
        code: "TEAM_MEMBER_LIMIT_REACHED",
      });
      await prisma.collaborationTeamMember.deleteMany({ where: { teamId: g.id, userId: { in: extra } } });

      // Fill the active-Team limit (5 on TEAM) with other groups.
      for (let i = 0; i < 5; i += 1) {
        await ct.createCollaborationTeam({ workspaceId: A().teamId, actorUserId: owner(), name: `G fill ${tag()}` });
      }
      await expect(ct.unarchiveCollaborationTeam({ teamId: g.id, actorUserId: owner() })).rejects.toMatchObject({
        code: "TEAM_LIMIT_REACHED",
      });
      expect(await status(g.id)).toBe("ARCHIVED");
      // Free one slot: restore succeeds through the route.
      const filler = await prisma.collaborationTeam.findFirstOrThrow({
        where: { workspaceId: A().teamId, status: "ACTIVE", name: { startsWith: "G fill" } },
      });
      await prisma.collaborationTeam.update({ where: { id: filler.id }, data: { status: "ARCHIVED", archivedAtUtc: new Date() } });
      const restored = await h.app.inject({
        method: "POST",
        url: `/v1/collaboration-teams/${g.id}/unarchive`,
        headers: headersA(),
        payload: {},
      });
      expect(restored.statusCode, restored.body).toBe(200);
      expect(await status(g.id)).toBe("ACTIVE");
      expect(await prisma.collaborationTeamActivity.count({ where: { teamId: g.id, eventType: "TEAM_REOPENED" } })).toBe(1);
    } finally {
      await plan(A().teamId, "TEAM");
    }
  });

  it("17. restore re-checks the workspace lifecycle: a closed workspace restores nothing", async () => {
    const g = await group();
    expect((await archive(g.id, g.name, await approved(g.id))).statusCode).toBe(200);
    const closedAt = new Date();
    await prisma.team.update({ where: { id: A().teamId }, data: { closedAtUtc: closedAt } });
    try {
      await expect(ct.unarchiveCollaborationTeam({ teamId: g.id, actorUserId: owner() })).rejects.toMatchObject({
        code: "WORKSPACE_NOT_ACTIVE",
      });
      expect(await status(g.id)).toBe("ARCHIVED");
    } finally {
      await prisma.team.update({ where: { id: A().teamId }, data: { closedAtUtc: null } });
    }
  });

  // 20 — no hard delete
  it("20. no customer hard-delete route remains reachable", async () => {
    const g = await group();
    const del = await h.app.inject({ method: "DELETE", url: `/v1/collaboration-teams/${g.id}`, headers: headersA() });
    expect(del.statusCode).toBe(404);
    expect(await prisma.collaborationTeam.findUnique({ where: { id: g.id } })).not.toBeNull();
  });

  // 21 — downgrade / contract change never deletes archived history
  it("21. a downgrade or an Enterprise contract change leaves an archived group and its history in place", async () => {
    const g = await group();
    await prisma.collaborationTeamComment.create({
      data: { teamId: g.id, workspaceId: A().teamId, authorUserId: owner(), targetType: "TEAM", body: "kept" },
    });
    expect((await archive(g.id, g.name, await approved(g.id))).statusCode).toBe(200);
    const before = await prisma.collaborationTeamActivity.count({ where: { teamId: g.id } });
    try {
      await plan(A().teamId, "FREE");
      await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "ENTERPRISE" } });
      await plan(A().teamId, "PRO");
      const row = await prisma.collaborationTeam.findUniqueOrThrow({ where: { id: g.id } });
      expect(row.status).toBe("ARCHIVED");
      expect(await prisma.collaborationTeamComment.count({ where: { teamId: g.id } })).toBe(1);
      expect(await prisma.collaborationTeamActivity.count({ where: { teamId: g.id } })).toBe(before);
    } finally {
      await plan(A().teamId, "TEAM");
    }
  });

  it("the impact preview counts what archiving would affect, for the archiver only", async () => {
    const g = await group();
    const member = await person("MEMBER");
    await ct.addExistingMember({ teamId: g.id, actorUserId: owner(), userIdToAdd: member, role: "MEMBER" });
    const res = await h.app.inject({ method: "GET", url: `/v1/collaboration-teams/${g.id}/archive-impact`, headers: headersA() });
    expect(res.statusCode, res.body).toBe(200);
    const impact = (res.json() as { impact: Record<string, unknown> }).impact;
    expect(impact).toMatchObject({
      teamId: g.id,
      teamName: g.name,
      acceptedMembers: 2,
      caseGrants: 0,
      openAssignments: 0,
      pendingInvites: 0,
      restore: { requestable: true },
    });
    expect(impact.preserved).toEqual(expect.arrayContaining(["team_record", "membership_history", "audit_history"]));
  });
});
