/**
 * PHASE C — ONE COLLABORATION CAPACITY RULE (members audit ENT-04, ENT-05,
 * CT-02, CT-03, CT-09, CT-11, CT-15, CT-17).
 *
 * Owner decision 2026-10-25: capacity is per ACTIVE Collaboration Team — PRO 2
 * groups of up to 5 accepted members, TEAM 5 groups of up to 10. The workspace
 * owner never consumes a place, pending invitations consume nothing, an
 * archived group frees its slot, and there is NO workspace-wide pool. Every
 * writer that makes someone an effective group member asks the same rule under
 * the same per-group lock.
 *
 * Every case drives the real services against a real PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Phase C — collaboration capacity", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let ct: typeof import("../src/services/collaboration-team/collaboration-team.service.js");
  let invitations: typeof import("../src/services/identity/workspace-invitation.service.js");
  // The Personal Workspace: one per person, carrying FREE, PRO and TEAM alike,
  // and the workspace where self-serve collaboration happens.
  const W = () => h.fixtures.personal;
  const created: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    ({ signJwt } = await import("../src/services/jwt.js"));
    ct = await import("../src/services/collaboration-team/collaboration-team.service.js");
    invitations = await import("../src/services/identity/workspace-invitation.service.js");
  }, 900_000);

  afterEach(async () => {
    // Each case starts from a workspace with no active groups, so the group
    // count of one case never decides another.
    await prisma.collaborationTeam.updateMany({
      where: { id: { in: created.splice(0) } },
      data: { status: "ARCHIVED", archivedAtUtc: new Date() },
    });
  });

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const owner = () => W().userId;

  async function plan(next: "FREE" | "PRO" | "TEAM") {
    // A Personal Workspace is governed by its owner's entitlement.
    await prisma.entitlement.updateMany({ where: { userId: owner() }, data: { active: false } });
    await prisma.entitlement.create({ data: { userId: owner(), plan: next, active: true, credits: 0 } });
  }

  async function person(opts: { member?: boolean } = { member: true }) {
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    const email = `phase-c-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "PhaseC", lastName: "Member", provider: "EMAIL", providerUserId: email },
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
    if (opts.member !== false) {
      await prisma.teamMember.create({
        data: { teamId: W().teamId, userId: user.id, role: "MEMBER", status: "ACTIVE" },
      });
    }
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, email, token };
  }

  async function group() {
    // The owner creates the group and becomes its LEAD — a place that is
    // never counted against the capacity.
    const { id } = await ct.createCollaborationTeam({
      workspaceId: W().teamId,
      actorUserId: owner(),
      name: `Capacity ${tag()}`,
    });
    created.push(id);
    return id;
  }

  async function add(teamId: string, userId: string) {
    return ct.addExistingMember({ teamId, actorUserId: owner(), userIdToAdd: userId, role: "MEMBER" });
  }

  async function fill(teamId: string, n: number) {
    const people = [];
    for (let i = 0; i < n; i += 1) {
      const p = await person();
      await add(teamId, p.id);
      people.push(p);
    }
    return people;
  }

  const refusalOf = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string }) => e.code ?? "unknown",
    );

  it("CT-17 — PRO: five members fit beside the owner; the sixth is refused", async () => {
    await plan("PRO");
    const teamId = await group();
    await fill(teamId, 5);
    const sixth = await person();
    expect(await refusalOf(add(teamId, sixth.id))).toBe("TEAM_MEMBER_LIMIT_REACHED");
    expect(
      await prisma.collaborationTeamMember.count({ where: { teamId, status: "ACTIVE" } }),
    ).toBe(6); // the owner LEAD + 5
  });

  it("TEAM: ten members fit beside the owner; the eleventh is refused", async () => {
    await plan("TEAM");
    const teamId = await group();
    await fill(teamId, 10);
    const eleventh = await person();
    expect(await refusalOf(add(teamId, eleventh.id))).toBe("TEAM_MEMBER_LIMIT_REACHED");
  });

  it("CT-15 — adding someone already in the group is idempotent, even when the group is full", async () => {
    await plan("PRO");
    const teamId = await group();
    const [first] = await fill(teamId, 5);
    const existing = await prisma.collaborationTeamMember.findFirstOrThrow({
      where: { teamId, userId: first!.id },
      select: { id: true },
    });
    await expect(add(teamId, first!.id)).resolves.toEqual({ id: existing.id });
    // Concurrent duplicates neither 500 nor create a second row.
    const fresh = await person();
    const teamId2 = await group();
    const results = await Promise.allSettled([add(teamId2, fresh.id), add(teamId2, fresh.id), add(teamId2, fresh.id)]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await prisma.collaborationTeamMember.count({ where: { teamId: teamId2, userId: fresh.id } })).toBe(1);
  });

  it("CT-02 — concurrent adds into the last place: exactly one wins", async () => {
    await plan("PRO");
    const teamId = await group();
    await fill(teamId, 4);
    const contenders = await Promise.all([person(), person(), person(), person(), person()]);
    const results = await Promise.allSettled(contenders.map((p) => add(teamId, p.id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason.code).toBe("TEAM_MEMBER_LIMIT_REACHED");
    }
    expect(
      await prisma.collaborationTeamMember.count({
        where: { teamId, status: "ACTIVE", userId: { not: owner() } },
      }),
    ).toBe(5);
  });

  it("CT-03 — reinstating a suspended member re-asks the capacity", async () => {
    await plan("PRO");
    const teamId = await group();
    const people = await fill(teamId, 5);
    const suspended = await prisma.collaborationTeamMember.findFirstOrThrow({
      where: { teamId, userId: people[0]!.id },
      select: { id: true },
    });
    await ct.suspendMember({ teamId, actorUserId: owner(), memberId: suspended.id });
    // The freed place is taken by somebody else …
    const replacement = await person();
    await add(teamId, replacement.id);
    // … so putting the suspended member back would make six.
    expect(
      await refusalOf(ct.reinstateMember({ teamId, actorUserId: owner(), memberId: suspended.id })),
    ).toBe("TEAM_MEMBER_LIMIT_REACHED");
    expect(
      (await prisma.collaborationTeamMember.findUniqueOrThrow({ where: { id: suspended.id } })).status,
    ).toBe("SUSPENDED");
  });

  it("the same person in two groups takes a place in each — nothing is pooled across groups", async () => {
    await plan("PRO");
    const g1 = await group();
    const g2 = await group();
    const shared = await fill(g1, 5);
    for (const p of shared) await add(g2, p.id);
    const extra = await person();
    expect(await refusalOf(add(g1, extra.id))).toBe("TEAM_MEMBER_LIMIT_REACHED");
    expect(await refusalOf(add(g2, extra.id))).toBe("TEAM_MEMBER_LIMIT_REACHED");
  });

  it("CT-11 — an archived group frees its slot and accepts no new members", async () => {
    await plan("PRO");
    const g1 = await group();
    await group();
    expect(
      await refusalOf(ct.createCollaborationTeam({ workspaceId: W().teamId, actorUserId: owner(), name: `Third ${tag()}` })),
    ).toBe("TEAM_LIMIT_REACHED");
    await ct.archiveCollaborationTeam({ teamId: g1, actorUserId: owner() });
    const p = await person();
    await expect(add(g1, p.id)).rejects.toMatchObject({ code: "collaboration_team_archived", httpStatus: 409 });
    const third = await group();
    expect(third).toBeTruthy();
  });

  it("PRO holds exactly 2 active Collaboration Teams and TEAM exactly 5; FREE holds none", async () => {
    await plan("PRO");
    await group();
    await group();
    expect(
      await refusalOf(ct.createCollaborationTeam({ workspaceId: W().teamId, actorUserId: owner(), name: `x ${tag()}` })),
    ).toBe("TEAM_LIMIT_REACHED");
    await plan("TEAM");
    for (let i = 0; i < 3; i += 1) await group();
    expect(
      await refusalOf(ct.createCollaborationTeam({ workspaceId: W().teamId, actorUserId: owner(), name: `y ${tag()}` })),
    ).toBe("TEAM_LIMIT_REACHED");
    await plan("FREE");
    await prisma.collaborationTeam.updateMany({
      where: { id: { in: created.splice(0) } },
      data: { status: "ARCHIVED", archivedAtUtc: new Date() },
    });
    expect(
      await refusalOf(ct.createCollaborationTeam({ workspaceId: W().teamId, actorUserId: owner(), name: `z ${tag()}` })),
    ).toBe("TEAM_PLAN_REQUIRED");
  });

  it("concurrent creation for the last active-Team slot: exactly one wins", async () => {
    await plan("PRO");
    await group();
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map((i) =>
        ct.createCollaborationTeam({ workspaceId: W().teamId, actorUserId: owner(), name: `race ${i} ${tag()}` }),
      ),
    );
    const won = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>[];
    expect(won).toHaveLength(1);
    created.push(won[0]!.value.id);
    expect(
      await prisma.collaborationTeam.count({ where: { workspaceId: W().teamId, status: "ACTIVE" } }),
    ).toBe(2);
  });

  it("pending invitations consume no place in a group", async () => {
    await plan("PRO");
    const teamId = await group();
    await fill(teamId, 4);
    for (let i = 0; i < 3; i += 1) {
      const invitee = await person({ member: false });
      await invitations.createWorkspaceInvitation({
        workspaceId: W().teamId,
        email: invitee.email,
        role: "MEMBER",
        invitedByUserId: owner(),
      });
    }
    const fifth = await person();
    await expect(add(teamId, fifth.id)).resolves.toBeTruthy();
  });

  it("reinstate versus add for the last place: exactly one wins, under the same lock", async () => {
    await plan("PRO");
    const teamId = await group();
    const people = await fill(teamId, 5);
    const suspended = await prisma.collaborationTeamMember.findFirstOrThrow({
      where: { teamId, userId: people[0]!.id },
      select: { id: true },
    });
    await ct.suspendMember({ teamId, actorUserId: owner(), memberId: suspended.id });
    const newcomer = await person();
    const results = await Promise.allSettled([
      ct.reinstateMember({ teamId, actorUserId: owner(), memberId: suspended.id }),
      add(teamId, newcomer.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await prisma.collaborationTeamMember.count({
        where: { teamId, status: "ACTIVE", userId: { not: owner() } },
      }),
    ).toBe(5);
  });

  it("restoring an archived group re-checks the plan's member capacity", async () => {
    await plan("TEAM");
    const teamId = await group();
    await fill(teamId, 7);
    await ct.archiveCollaborationTeam({ teamId, actorUserId: owner() });
    await plan("PRO");
    expect(
      await refusalOf(ct.unarchiveCollaborationTeam({ teamId, actorUserId: owner() })),
    ).toBe("TEAM_MEMBER_LIMIT_REACHED");
    expect((await prisma.collaborationTeam.findUniqueOrThrow({ where: { id: teamId } })).status).toBe("ARCHIVED");
    await plan("TEAM");
    await expect(ct.unarchiveCollaborationTeam({ teamId, actorUserId: owner() })).resolves.toBeUndefined();
  });

  it("every writer that grows a group takes the same per-group lock", async () => {
    // Behaviour is proven above (add × add, reinstate × add, accept). This pins
    // that no writer reaches the membership row without the shared authority.
    const svc = readFileSync(
      new URL("../src/services/collaboration-team/collaboration-team.service.ts", import.meta.url),
      "utf8",
    );
    for (const fn of ["addExistingMember", "reinstateMember", "unarchiveCollaborationTeam", "acceptInvite"]) {
      const start = svc.indexOf(`export async function ${fn}(`);
      expect(start, fn).toBeGreaterThan(-1);
      const next = svc.indexOf("\nexport async function ", start + 10);
      const body = svc.slice(start, next < 0 ? undefined : next);
      expect(body, fn).toMatch(/lockAndAssertCollaborationTeamMemberCapacity\(tx,/);
    }
    const guards = readFileSync(
      new URL("../src/services/collaboration-team/billing-guards.ts", import.meta.url),
      "utf8",
    );
    // ONE lock key, one helper, taken by the capacity guard and by every
    // leadership writer alike.
    expect(guards).toMatch(/pg_advisory_xact_lock\(hashtext\(\$\{`collaboration-team-members:\$\{teamId\}`\}\)\)/);
    expect(guards).toMatch(/export async function lockAndAssertCollaborationTeamMemberCapacity[\s\S]{0,700}?await lockCollaborationTeamMembership\(tx, input\.teamId\)/);
    for (const fn of ["changeMemberRole", "suspendMember", "removeMember"]) {
      const start = svc.indexOf(`export async function ${fn}(`);
      const next = svc.indexOf("\nexport async function ", start + 10);
      expect(svc.slice(start, next), fn).toMatch(/lockCollaborationTeamMembership\(tx, input\.teamId\)/);
    }
  });

  it("CT-18 — a group ADMIN cannot suspend, remove or demote a LEAD; a LEAD can", async () => {
    await plan("TEAM");
    const teamId = await group();
    const lead = await person();
    const admin = await person();
    await add(teamId, lead.id);
    await add(teamId, admin.id);
    const rows = await prisma.collaborationTeamMember.findMany({
      where: { teamId, userId: { in: [lead.id, admin.id] } },
      select: { id: true, userId: true },
    });
    const leadRow = rows.find((r) => r.userId === lead.id)!.id;
    const adminRow = rows.find((r) => r.userId === admin.id)!.id;
    await ct.changeMemberRole({ teamId, actorUserId: owner(), memberId: leadRow, role: "LEAD" });
    await ct.changeMemberRole({ teamId, actorUserId: owner(), memberId: adminRow, role: "ADMIN" });

    // A group ADMIN holds suspend and remove — but not over a LEAD.
    for (const attempt of [
      () => ct.suspendMember({ teamId, actorUserId: admin.id, memberId: leadRow }),
      () => ct.removeMember({ teamId, actorUserId: admin.id, memberId: leadRow }),
    ]) {
      expect(await refusalOf(attempt())).toBe("LEAD_PROTECTED");
    }
    // Role changes are not an ADMIN's authority at all.
    expect(
      await refusalOf(ct.changeMemberRole({ teamId, actorUserId: admin.id, memberId: leadRow, role: "MEMBER" })),
    ).toBe("team_forbidden");
    const after = await prisma.collaborationTeamMember.findUniqueOrThrow({ where: { id: leadRow } });
    expect({ role: after.role, status: after.status }).toEqual({ role: "LEAD", status: "ACTIVE" });
    // A LEAD (here the owner, who created the group) may.
    await ct.changeMemberRole({ teamId, actorUserId: owner(), memberId: leadRow, role: "MEMBER" });
  });

  it("CT-18 — two concurrent demotions of the last two LEADs leave exactly one LEAD", async () => {
    await plan("TEAM");
    const teamId = await group();
    const second = await person();
    await add(teamId, second.id);
    const rows = await prisma.collaborationTeamMember.findMany({
      where: { teamId, userId: { in: [owner(), second.id] } },
      select: { id: true, userId: true },
    });
    const ownerRow = rows.find((r) => r.userId === owner())!.id;
    const secondRow = rows.find((r) => r.userId === second.id)!.id;
    await ct.changeMemberRole({ teamId, actorUserId: owner(), memberId: secondRow, role: "LEAD" });
    const results = await Promise.allSettled([
      ct.changeMemberRole({ teamId, actorUserId: owner(), memberId: secondRow, role: "MEMBER" }),
      ct.changeMemberRole({ teamId, actorUserId: second.id, memberId: ownerRow, role: "MEMBER" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await prisma.collaborationTeamMember.count({ where: { teamId, role: "LEAD", status: "ACTIVE" } }),
    ).toBe(1);
  });

  it("ENT-04 — there is no workspace-wide pool: a TEAM workspace past the old ten-seat line still admits members", async () => {
    await plan("TEAM");
    const nonOwner = await prisma.teamMember.count({
      where: { teamId: W().teamId, status: "ACTIVE", userId: { not: owner() } },
    });
    for (let i = nonOwner; i < 12; i += 1) await person();
    const invitee = await person({ member: false });
    const invite = await invitations.createWorkspaceInvitation({
      workspaceId: W().teamId,
      email: invitee.email,
      role: "MEMBER",
      invitedByUserId: owner(),
    });
    const accept = await h.app.inject({
      method: "POST",
      url: `/v1/teams/invites/${invite.rawToken}/accept`,
      headers: { authorization: `Bearer ${invitee.token}` },
    });
    expect(accept.statusCode).toBeLessThan(300);
    expect(
      await prisma.teamMember.count({ where: { teamId: W().teamId, userId: invitee.id, status: "ACTIVE" } }),
    ).toBe(1);
  });

  it("credits never grant collaboration — a FREE workspace admits nobody but the owner", async () => {
    await plan("FREE");
    const invitee = await person({ member: false });
    const refusal = await refusalOf(
      invitations.createWorkspaceInvitation({
        workspaceId: W().teamId,
        email: invitee.email,
        role: "MEMBER",
        invitedByUserId: owner(),
      }),
    );
    expect(refusal).toMatch(/NOT_INCLUDED/);
    await plan("TEAM");
  });
});
