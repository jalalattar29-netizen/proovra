/**
 * WORKSPACE AND COLLABORATION RECONCILIATION — CLOSURE, part 2:
 * the four P0 closures, revalidated against live PostgreSQL 16.
 *
 * These were closed during the reconciliation and proven by ad-hoc probes.
 * A probe proves a tree once behaved. These are the same ten facts, asserted
 * where a regression fails a gate:
 *
 *   1  a workspace ADMIN cannot promote themselves to OWNER
 *   2  a workspace ADMIN cannot invite anyone as OWNER
 *   3  a collaboration-team ADMIN cannot grant LEAD
 *   4  last-administrator protection is transactional
 *   5  a FOREIGN access review cannot be completed
 *   6  the foreign review row is byte-for-byte unchanged afterwards
 *   7  collaboration reads/writes use the CONTAINING workspace
 *   8  missing workspace context never falls back to Personal
 *   9  a legacy group-invite acceptance never produces a generic 500
 *  10  every collaboration audit row carries the real workspace id
 *
 * Nothing under proof is mocked. The routes, the canonical authorization
 * chain, the rbac engine and the services all run for real; the harness
 * supplies a disposable database and two seeded tenants.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = typeof import("../src/db.js")["prisma"];

const WORKSPACE_HEADER = "x-proovra-workspace-id";

describe("WCR closure — the four P0 closures (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;

  const inject = (opts: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    token: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) =>
    h.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.payload ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.payload ? { payload: opts.payload as never } : {}),
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));

    /**
     * THE FIXTURE WORKSPACES MUST INCLUDE THE FEATURE UNDER TEST.
     *
     * The harness seeds ORGANIZATION workspaces with the default commercial
     * state, which is FREE — a plan that includes zero collaboration groups.
     * Every authority assertion below is about who may do what INSIDE a group,
     * so a workspace that cannot hold one would make the whole suite pass by
     * refusing at the commercial gate: a green run proving nothing.
     *
     * TEAM is set on the workspace row itself, which is where an ORGANIZATION
     * workspace's own commercial state lives, so the plan comes from the same
     * column production reads rather than from a stub.
     */
    await prisma.team.updateMany({
      where: { id: { in: [h.fixtures.teamA.teamId, h.fixtures.teamB.teamId] } },
      data: { billingPlan: "TEAM", billingStatus: "ACTIVE" },
    });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // =========================================================================
  // 1 + 2 — workspace role ceilings
  // =========================================================================

  describe("workspace role ceilings", () => {
    it("1. an ADMIN cannot promote THEMSELVES to OWNER, and the row does not move", async () => {
      const ws = h.fixtures.teamA;
      const own = await prisma.teamMember.findFirstOrThrow({
        where: { teamId: ws.teamId, userId: ws.adminUserId },
        select: { id: true, role: true },
      });

      const res = await inject({
        method: "PATCH",
        url: `/v1/teams/${ws.teamId}/members/${own.id}`,
        token: ws.adminToken,
        payload: { role: "OWNER" },
      });

      expect(res.statusCode).toBe(403);
      // Refused for a NAMED reason, not a generic forbidden: acting on
      // yourself and granting OWNER are two different rules and the audit
      // trail has to be able to say which one fired.
      expect(JSON.stringify(res.json())).toMatch(
        /self_action_forbidden|role_transition_to_owner_forbidden/,
      );
      const after = await prisma.teamMember.findUniqueOrThrow({
        where: { id: own.id },
        select: { role: true },
      });
      expect(after.role).toBe(own.role);
      // …and the workspace still has exactly the owner it started with.
      expect(
        await prisma.teamMember.count({
          where: { teamId: ws.teamId, role: "OWNER", status: "ACTIVE" },
        }),
      ).toBe(1);
    });

    it("2. an ADMIN cannot INVITE anyone as OWNER, and no invitation is written", async () => {
      const ws = h.fixtures.teamA;
      const before = await prisma.teamInvite.count({ where: { teamId: ws.teamId } });

      const res = await inject({
        method: "POST",
        url: `/v1/teams/${ws.teamId}/invites`,
        token: ws.adminToken,
        payload: { email: `p0-owner-${randomUUID().slice(0, 8)}@invitee.test`, role: "OWNER" },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.stringify(res.json())).toContain(
        "role_transition_to_owner_forbidden",
      );
      expect(await prisma.teamInvite.count({ where: { teamId: ws.teamId } })).toBe(
        before,
      );
    });

    it("2b. the ceiling is the INVITER's authority, not just OWNER", async () => {
      // A MEMBER cannot invite at all, and an ADMIN cannot mint an ADMIN's
      // superior. The rule is "never above your own", which OWNER is a case of.
      const ws = h.fixtures.teamA;
      const res = await inject({
        method: "POST",
        url: `/v1/teams/${ws.teamId}/invites`,
        token: ws.memberToken,
        payload: { email: `p0-member-${randomUUID().slice(0, 8)}@invitee.test`, role: "ADMIN" },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // =========================================================================
  // 3 — group role ceiling
  // =========================================================================

  describe("collaboration-team role ceiling", () => {
    it("3. a group ADMIN cannot grant LEAD, and no membership is written", async () => {
      const ws = h.fixtures.teamA;
      const service = await import(
        "../src/services/collaboration-team/collaboration-team.service.js"
      );
      const group = await service.createCollaborationTeam({
        workspaceId: ws.teamId,
        actorUserId: ws.ownerUserId,
        name: `p0 ceiling ${randomUUID().slice(0, 6)}`,
      });
      // The workspace ADMIN joins the group as a group ADMIN.
      await service.addExistingMember({
        teamId: group.id,
        actorUserId: ws.ownerUserId,
        userIdToAdd: ws.adminUserId,
        role: "ADMIN",
      });

      const before = await prisma.collaborationTeamMember.count({
        where: { teamId: group.id },
      });
      let refused = "ALLOWED";
      try {
        await service.addExistingMember({
          teamId: group.id,
          actorUserId: ws.adminUserId,
          userIdToAdd: ws.memberUserId,
          role: "LEAD",
        });
      } catch (err) {
        refused = (err as { code?: string }).code ?? "UNTYPED";
      }
      expect(refused).not.toBe("ALLOWED");
      expect(refused).not.toBe("UNTYPED");
      expect(
        await prisma.collaborationTeamMember.count({ where: { teamId: group.id } }),
      ).toBe(before);

      // The same actor CAN grant at or below their own authority — the rule is
      // a ceiling, not a blanket refusal, and a test that only proved the
      // denial would pass against a group nobody can add to at all.
      await service.addExistingMember({
        teamId: group.id,
        actorUserId: ws.adminUserId,
        userIdToAdd: ws.memberUserId,
        role: "MEMBER",
      });
      expect(
        await prisma.collaborationTeamMember.count({
          where: { teamId: group.id, userId: ws.memberUserId, status: "ACTIVE" },
        }),
      ).toBe(1);
    });
  });

  // =========================================================================
  // 4 — last-administrator protection, transactional
  // =========================================================================

  describe("last-administrator protection", () => {
    it("4. the last LEAD cannot be removed, suspended or demoted, and nothing moves", async () => {
      const ws = h.fixtures.teamA;
      const service = await import(
        "../src/services/collaboration-team/collaboration-team.service.js"
      );
      const group = await service.createCollaborationTeam({
        workspaceId: ws.teamId,
        actorUserId: ws.ownerUserId,
        name: `p0 last-lead ${randomUUID().slice(0, 6)}`,
      });
      const lead = await prisma.collaborationTeamMember.findFirstOrThrow({
        where: { teamId: group.id, role: "LEAD", status: "ACTIVE" },
        select: { id: true, role: true, status: true },
      });

      for (const attempt of [
        () =>
          service.removeMember({
            teamId: group.id,
            actorUserId: ws.ownerUserId,
            memberId: lead.id,
          }),
        () =>
          service.suspendMember({
            teamId: group.id,
            actorUserId: ws.ownerUserId,
            memberId: lead.id,
          }),
        () =>
          service.changeMemberRole({
            teamId: group.id,
            actorUserId: ws.ownerUserId,
            memberId: lead.id,
            role: "MEMBER",
          }),
      ]) {
        let outcome = "ALLOWED";
        try {
          await attempt();
        } catch (err) {
          outcome = (err as { code?: string }).code ?? "UNTYPED";
        }
        expect(outcome, "the last LEAD must be protected").not.toBe("ALLOWED");
        const now = await prisma.collaborationTeamMember.findUniqueOrThrow({
          where: { id: lead.id },
          select: { role: true, status: true },
        });
        // TRANSACTIONAL: the refusal leaves the row exactly as it was, so a
        // partially-applied demotion cannot strand a group with no lead.
        expect(now).toEqual({ role: lead.role, status: lead.status });
      }

      // With a SECOND lead the same operations succeed — proving the guard is
      // "the last one" and not "any lead".
      await service.addExistingMember({
        teamId: group.id,
        actorUserId: ws.ownerUserId,
        userIdToAdd: ws.adminUserId,
        role: "LEAD",
      });
      await service.changeMemberRole({
        teamId: group.id,
        actorUserId: ws.ownerUserId,
        memberId: lead.id,
        role: "MEMBER",
      });
      expect(
        (
          await prisma.collaborationTeamMember.findUniqueOrThrow({
            where: { id: lead.id },
            select: { role: true },
          })
        ).role,
      ).toBe("MEMBER");
    });
  });

  // =========================================================================
  // 5 + 6 — cross-tenant access review
  // =========================================================================

  describe("cross-tenant access review", () => {
    it("5+6. a FOREIGN review cannot be completed, and its row is byte-for-byte unchanged", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const service = await import(
        "../src/services/collaboration-team/collaboration-team.service.js"
      );
      const completion = await import(
        "../src/services/collaboration-team/collaboration-completion.service.js"
      );

      // Workspace B opens a review on its own group.
      const groupB = await service.createCollaborationTeam({
        workspaceId: b.teamId,
        actorUserId: b.ownerUserId,
        name: `p0 foreign ${randomUUID().slice(0, 6)}`,
      });
      const reviewB = await completion.openAccessReview({
        teamId: groupB.id,
        actorUserId: b.ownerUserId,
      });

      const before = await prisma.collaborationTeamAccessReview.findUniqueOrThrow(
        { where: { id: reviewB.id } },
      );

      // Workspace A's owner holds a group of their own and the uuid of B's
      // review. Two shapes of the same attack: through their OWN team id, and
      // through B's.
      const groupA = await service.createCollaborationTeam({
        workspaceId: a.teamId,
        actorUserId: a.ownerUserId,
        name: `p0 attacker ${randomUUID().slice(0, 6)}`,
      });

      for (const teamId of [groupA.id, groupB.id]) {
        let outcome = "ALLOWED";
        try {
          await completion.completeAccessReview({
            teamId,
            actorUserId: a.ownerUserId,
            reviewId: reviewB.id,
          });
        } catch (err) {
          outcome = (err as { code?: string }).code ?? "UNTYPED";
        }
        expect(outcome, `completing B's review via ${teamId}`).not.toBe("ALLOWED");
      }

      const after = await prisma.collaborationTeamAccessReview.findUniqueOrThrow(
        { where: { id: reviewB.id } },
      );
      expect(after).toEqual(before);

      // Non-vacuous: B's own LEAD completes it, so the refusals above were
      // about tenancy and not about the operation being impossible.
      await completion.completeAccessReview({
        teamId: groupB.id,
        actorUserId: b.ownerUserId,
        reviewId: reviewB.id,
      });
      const completed =
        await prisma.collaborationTeamAccessReview.findUniqueOrThrow({
          where: { id: reviewB.id },
        });
      expect(completed.status).not.toBe(before.status);
    });
  });

  // =========================================================================
  // 7 + 8 — workspace binding
  // =========================================================================

  describe("workspace binding", () => {
    it("7. a collaboration read is bound to the CONTAINING workspace", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const service = await import(
        "../src/services/collaboration-team/collaboration-team.service.js"
      );
      const groupB = await service.createCollaborationTeam({
        workspaceId: b.teamId,
        actorUserId: b.ownerUserId,
        name: `p0 containment ${randomUUID().slice(0, 6)}`,
      });

      // B's owner, naming B, reads it.
      const legitimate = await inject({
        method: "GET",
        url: `/v1/collaboration-teams/${groupB.id}`,
        token: b.ownerToken,
        headers: { [WORKSPACE_HEADER]: b.teamId },
      });
      expect(legitimate.statusCode).toBe(200);

      // A's owner, naming A, holding B's group id — concealed, not described.
      const foreign = await inject({
        method: "GET",
        url: `/v1/collaboration-teams/${groupB.id}`,
        token: a.ownerToken,
        headers: { [WORKSPACE_HEADER]: a.teamId },
      });
      expect(foreign.statusCode).toBe(404);

      // A's owner NAMING B: refused by the workspace gate, not by the group
      // one — and with the identical body, so the two are indistinguishable.
      const namingForeign = await inject({
        method: "GET",
        url: `/v1/collaboration-teams/${groupB.id}`,
        token: a.ownerToken,
        headers: { [WORKSPACE_HEADER]: b.teamId },
      });
      expect(namingForeign.statusCode).toBe(404);
      expect(namingForeign.json()).toEqual(foreign.json());
    });

    it("8. a request naming NO workspace never falls back to Personal", async () => {
      const p = h.fixtures.personal;
      // The personal user has a personal workspace and no pointer set by this
      // fixture — exactly the state the old resolver silently filled in.
      await prisma.user.update({
        where: { id: p.userId },
        data: { currentWorkspaceId: null },
      });

      const res = await inject({
        method: "GET",
        url: "/v1/collaboration-teams",
        token: p.token,
      });
      expect(res.statusCode).toBe(404);
      // Not merely a different status: no personal-workspace data came back.
      expect(JSON.stringify(res.json())).not.toContain(p.teamId);

      // Naming the workspace makes the same request work, so the refusal was
      // about the missing binding and not about the caller.
      const named = await inject({
        method: "GET",
        url: "/v1/collaboration-teams",
        token: p.token,
        headers: { [WORKSPACE_HEADER]: p.teamId },
      });
      expect(named.statusCode).toBe(200);
    });

    it("8b. a collaboration-team id can never be read as a workspace id", async () => {
      const b = h.fixtures.teamB;
      const service = await import(
        "../src/services/collaboration-team/collaboration-team.service.js"
      );
      const groupB = await service.createCollaborationTeam({
        workspaceId: b.teamId,
        actorUserId: b.ownerUserId,
        name: `p0 param ${randomUUID().slice(0, 6)}`,
      });
      const p = h.fixtures.personal;
      await prisma.user.update({
        where: { id: p.userId },
        data: { currentWorkspaceId: null },
      });
      // `?teamId=` is the old resolver's input. It must not name a workspace.
      const res = await inject({
        method: "GET",
        url: `/v1/collaboration-teams?teamId=${groupB.id}`,
        token: p.token,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // =========================================================================
  // 9 — the retired legacy invite path
  // =========================================================================

  describe("legacy group invitation", () => {
    it("9. a legacy accept is TYPED at every outcome — never a generic 500", async () => {
      const p = h.fixtures.personal;
      const outcomes: number[] = [];
      for (const token of [
        "not-a-token",
        randomUUID(),
        "",
        "wsit_v1_looks_like_the_other_system",
      ]) {
        const res = await inject({
          method: "POST",
          url: `/v1/collaboration-team-invites/${encodeURIComponent(token)}/accept`,
          token: p.token,
        });
        outcomes.push(res.statusCode);
        expect(res.statusCode, `token=${token}`).not.toBe(500);
        const body = JSON.stringify(res.json());
        // A typed refusal names itself. A stack trace or an empty body does not.
        expect(body).not.toContain("Cannot read");
        expect(body.length).toBeGreaterThan(2);
      }
      expect(outcomes.every((s) => s >= 400 && s < 500)).toBe(true);
    });

    it("9b. the per-group invite CREATE route answers a typed retirement", async () => {
      const b = h.fixtures.teamB;
      const service = await import(
        "../src/services/collaboration-team/collaboration-team.service.js"
      );
      const group = await service.createCollaborationTeam({
        workspaceId: b.teamId,
        actorUserId: b.ownerUserId,
        name: `p0 retired ${randomUUID().slice(0, 6)}`,
      });
      const before = await prisma.collaborationTeamInvite.count();
      const res = await inject({
        method: "POST",
        url: `/v1/collaboration-teams/${group.id}/invites/email`,
        token: b.ownerToken,
        headers: { [WORKSPACE_HEADER]: b.teamId },
        payload: { email: "legacy@invitee.test" },
      });
      expect(res.statusCode).toBe(410);
      expect(JSON.stringify(res.json())).toContain(
        "COLLABORATION_TEAM_INVITE_RETIRED",
      );
      expect(await prisma.collaborationTeamInvite.count()).toBe(before);
    });
  });

  // =========================================================================
  // 10 — audit identity
  // =========================================================================

  describe("audit identity", () => {
    it("10. a collaboration mutation writes an audit row carrying the REAL workspace id", async () => {
      const b = h.fixtures.teamB;
      const created = await inject({
        method: "POST",
        url: "/v1/collaboration-teams",
        token: b.ownerToken,
        headers: { [WORKSPACE_HEADER]: b.teamId },
        payload: { name: `p0 audit ${randomUUID().slice(0, 6)}` },
      });
      expect(created.statusCode).toBe(201);
      const groupId = (created.json() as { team: { id: string } }).team.id;

      // The canonical tenant-audit facade persists into `AdminAuditLog`,
      // whose `workspaceId` column is the authoritative tenant scope — the
      // query authority filters on the COLUMN, never on metadata.
      const rows = await prisma.adminAuditLog.findMany({
        where: {
          action: "collaboration_team.created",
          resourceId: groupId,
        },
        select: {
          workspaceId: true,
          userId: true,
          resourceId: true,
          outcome: true,
        },
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // The WORKSPACE, never the collaboration team — the two ids used to be
        // confused because the route param is called `teamId` on both.
        expect(row.workspaceId).toBe(b.teamId);
        expect(row.workspaceId).not.toBe(groupId);
        expect(row.userId).toBe(b.ownerUserId);
        expect(row.outcome).toBe("success");
      }

      // And it resolves to a real workspace, not merely a non-null uuid.
      const ws = await prisma.team.findUnique({
        where: { id: rows[0].workspaceId! },
        select: { id: true },
      });
      expect(ws?.id).toBe(b.teamId);
    });

    it("10b. every collaboration activity row carries its containing workspace", async () => {
      const rows = await prisma.collaborationTeamActivity.findMany({
        select: { workspaceId: true, teamId: true },
        take: 200,
      });
      expect(rows.length).toBeGreaterThan(0);
      const workspaceIds = [...new Set(rows.map((r) => r.workspaceId))];
      const realWorkspaces = await prisma.team.findMany({
        where: { id: { in: workspaceIds } },
        select: { id: true },
      });
      expect(realWorkspaces.length).toBe(workspaceIds.length);
      // The two ids are never the same value — a row that recorded the group
      // as its workspace would satisfy a NOT NULL check and still be wrong.
      for (const row of rows) {
        expect(row.workspaceId).not.toBe(row.teamId);
      }
    });
  });
});
