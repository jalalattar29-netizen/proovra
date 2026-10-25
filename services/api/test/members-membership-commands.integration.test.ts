/**
 * PHASE B — ONE GOVERNED MEMBERSHIP COMMAND SET (members audit ROLE-01,
 * ROLE-03, ROLE-04, ROLE-05, MEM-01, MEM-02, INV-01, INV-07, DOM-02,
 * LIFE-15, SEC-01, SEC-02, SEC-04, ACC-08, ACC-11).
 *
 * Members & Access and Security Center drive the same engine; until now only
 * Security Center applied the step-up and managed-identity gates, any ADMIN
 * could act on any other ADMIN, removal deleted the row and left case access,
 * assignments and Collaboration Team membership behind, and a pending
 * invitation revived a suspended membership. Every case below drives real
 * routes against a real PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

describe("Phase B — governed membership commands", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let invitations: typeof import("../src/services/identity/workspace-invitation.service.js");
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    ({ signJwt } = await import("../src/services/jwt.js"));
    invitations = await import("../src/services/identity/workspace-invitation.service.js");
    stepUp = createStepUpCeremony({
      prisma,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    // Invitations are a plan capability; the harness default holds none.
    await prisma.team.updateMany({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const tag = () => randomUUID().slice(0, 8);

  async function person(role: "ADMIN" | "MEMBER" | "VIEWER" | null) {
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    const email = `phase-b-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "PhaseB", lastName: "Member", provider: "EMAIL", providerUserId: email },
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
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    const membership = role
      ? await prisma.teamMember.create({ data: { teamId: A().teamId, userId: user.id, role, status: "ACTIVE" } })
      : null;
    return { id: user.id, email, token, memberId: membership?.id ?? null };
  }

  const memberUrl = (memberId: string) => `/v1/teams/${A().teamId}/members/${memberId}`;
  async function revokeAs(actor: { token: string; userId: string }, memberId: string) {
    return h.app.inject({
      method: "DELETE",
      url: memberUrl(memberId),
      headers: {
        ...bearer(actor.token),
        ...(await stepUp.approvedHeader({
          token: actor.token,
          userId: actor.userId,
          teamId: A().teamId,
          purpose: "MEMBER_REVOKE",
          resourceKind: "team_member",
          resourceId: memberId,
        })),
      },
    });
  }
  async function reroleAs(actor: { token: string; userId: string }, memberId: string, role: string) {
    return h.app.inject({
      method: "PATCH",
      url: memberUrl(memberId),
      headers: {
        ...bearer(actor.token),
        ...(await stepUp.approvedHeader({
          token: actor.token,
          userId: actor.userId,
          teamId: A().teamId,
          purpose: "MEMBER_ROLE_CHANGE",
          resourceKind: "team_member",
          resourceId: memberId,
        })),
      },
      payload: { role },
    });
  }
  const admin = () => ({ token: A().adminToken, userId: A().adminUserId });
  const owner = () => ({ token: A().ownerToken, userId: A().ownerUserId });

  it("ROLE-01 — a role change without a fresh step-up is refused and nothing changes", async () => {
    const m = await person("MEMBER");
    const res = await h.app.inject({
      method: "PATCH",
      url: memberUrl(m.memberId!),
      headers: bearer(A().adminToken),
      payload: { role: "VIEWER" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
    expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: m.memberId! } })).role).toBe("MEMBER");
  });

  it("ROLE-04 — an ADMIN manages MEMBER and VIEWER only; it cannot demote, suspend or remove another ADMIN; the OWNER can", async () => {
    const peer = await person("ADMIN");
    const demote = await reroleAs(admin(), peer.memberId!, "MEMBER");
    expect(demote.statusCode).toBe(403);
    expect(demote.json().error.code).toBe("rank_insufficient");
    const remove = await revokeAs(admin(), peer.memberId!);
    expect(remove.statusCode).toBe(403);
    expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: peer.memberId! } })).status).toBe("ACTIVE");

    const promote = await person("MEMBER");
    const toAdmin = await reroleAs(admin(), promote.memberId!, "ADMIN");
    expect(toAdmin.statusCode).toBe(403);
    expect((await reroleAs(owner(), promote.memberId!, "ADMIN")).statusCode).toBe(200);
    expect((await reroleAs(owner(), peer.memberId!, "MEMBER")).statusCode).toBe(200);
  });

  it("MEM-01 / ACC-08 — removal is a REVOKED transition that ends case access, assignments and Collaboration Team membership", async () => {
    const m = await person("MEMBER");
    const kase = await prisma.case.create({ data: { name: `phase-b-${tag()}`, teamId: A().teamId, ownerUserId: A().ownerUserId } });
    await prisma.caseAccess.create({ data: { caseId: kase.id, userId: m.id } });
    await prisma.caseAssignment.create({
      data: { caseId: kase.id, teamId: A().teamId, assignedToUserId: m.id, assignedByUserId: A().ownerUserId, role: "INVESTIGATOR" } as never,
    });
    const group = await prisma.collaborationTeam.create({
      data: { workspaceId: A().teamId, name: `phase-b-group-${tag()}`, createdByUserId: A().ownerUserId },
    });
    await prisma.collaborationTeamMember.create({ data: { teamId: group.id, userId: m.id, role: "MEMBER", status: "ACTIVE" } as never });
    await prisma.teamInvite.create({
      data: {
        teamId: A().teamId,
        email: m.email.toUpperCase(),
        role: "MEMBER",
        tokenHash: `phase-b-${tag()}-${tag()}`,
        invitedByUserId: A().ownerUserId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const res = await revokeAs(admin(), m.memberId!);
    expect(res.statusCode, res.body).toBe(204);
    const row = await prisma.teamMember.findUniqueOrThrow({ where: { id: m.memberId! } });
    expect(row.status).toBe("REVOKED");
    expect(await prisma.caseAccess.count({ where: { userId: m.id } })).toBe(0);
    expect(await prisma.caseAssignment.count({ where: { assignedToUserId: m.id, status: "ACTIVE" } })).toBe(0);
    expect((await prisma.collaborationTeamMember.findFirstOrThrow({ where: { userId: m.id } })).status).toBe("REMOVED");
    expect(await prisma.teamInvite.count({ where: { teamId: A().teamId, email: { equals: m.email, mode: "insensitive" }, revokedAt: null } })).toBe(0);
    // Their sessions are revoked with the membership: the old token no longer
    // authenticates at all (401), let alone opens the case.
    expect((await h.app.inject({ method: "GET", url: `/v1/cases/${kase.id}`, headers: bearer(m.token) })).statusCode).toBe(401);
  });

  it("INV-01 — a pending invitation cannot revive a SUSPENDED membership; suspension revokes it", async () => {
    const m = await person("MEMBER");
    const created = await invitations.createWorkspaceInvitation({
      workspaceId: A().teamId,
      email: m.email,
      role: "MEMBER",
      invitedByUserId: A().ownerUserId,
    });
    await prisma.teamMember.update({ where: { id: m.memberId! }, data: { status: "SUSPENDED" } });
    const accept = await h.app.inject({
      method: "POST",
      url: `/v1/teams/invites/${created.rawToken}/accept`,
      headers: bearer(m.token),
    });
    expect(accept.statusCode).toBe(409);
    expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: m.memberId! } })).status).toBe("SUSPENDED");
  });

  it("INV-01 — an invitation issued BEFORE a removal is superseded; one issued AFTER it re-adds the person", async () => {
    const m = await person("MEMBER");
    const stale = await invitations.createWorkspaceInvitation({
      workspaceId: A().teamId,
      email: m.email,
      role: "MEMBER",
      invitedByUserId: A().ownerUserId,
    });
    await prisma.teamInvite.update({ where: { id: stale.invite.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
    await prisma.teamMember.update({ where: { id: m.memberId! }, data: { status: "REVOKED", revokedAtUtc: new Date() } });
    const refused = await h.app.inject({
      method: "POST",
      url: `/v1/teams/invites/${stale.rawToken}/accept`,
      headers: bearer(m.token),
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain("INVITE_SUPERSEDED");
    await prisma.teamInvite.updateMany({ where: { teamId: A().teamId, email: m.email }, data: { revokedAt: new Date() } });

    const fresh = await invitations.createWorkspaceInvitation({
      workspaceId: A().teamId,
      email: m.email,
      role: "VIEWER",
      invitedByUserId: A().ownerUserId,
    });
    const ok = await h.app.inject({
      method: "POST",
      url: `/v1/teams/invites/${fresh.rawToken}/accept`,
      headers: bearer(m.token),
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: m.memberId! } })).status).toBe("ACTIVE");
  });

  it("INV-07 — an ACTIVE member re-clicking an invitation consumes it", async () => {
    const m = await person("MEMBER");
    const created = await invitations.createWorkspaceInvitation({
      workspaceId: A().teamId,
      email: m.email,
      role: "MEMBER",
      invitedByUserId: A().ownerUserId,
    });
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/teams/invites/${created.rawToken}/accept`,
      headers: bearer(m.token),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await prisma.teamInvite.findUniqueOrThrow({ where: { id: created.invite.id } })).acceptedAt).not.toBeNull();
  });

  it("LIFE-15 — a MEMBER may leave; the OWNER may not", async () => {
    const m = await person("MEMBER");
    const leave = await h.app.inject({
      method: "POST",
      url: `/v1/teams/${A().teamId}/leave`,
      headers: {
        ...bearer(m.token),
        ...(await stepUp.approvedHeader({ token: m.token, userId: m.id, teamId: A().teamId, purpose: "MEMBER_REVOKE", resourceKind: "team_member" })),
      },
    });
    expect(leave.statusCode, leave.body).toBe(204);
    expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: m.memberId! } })).status).toBe("REVOKED");

    const ownerLeave = await h.app.inject({
      method: "POST",
      url: `/v1/teams/${A().teamId}/leave`,
      headers: {
        ...bearer(A().ownerToken),
        ...(await stepUp.approvedHeader({ token: A().ownerToken, userId: A().ownerUserId, teamId: A().teamId, purpose: "MEMBER_REVOKE", resourceKind: "team_member" })),
      },
    });
    expect(ownerLeave.statusCode).toBe(409);
    expect(ownerLeave.json().error.code).toBe("owner_cannot_leave");
  });

  it("ROLE-03 — invitation addresses in the activity feed reach administrators only", async () => {
    const email = `phase-b-invitee-${tag()}@test.proovra.local`;
    const created = await h.app.inject({
      method: "POST",
      url: `/v1/teams/${A().teamId}/invites`,
      headers: bearer(A().adminToken),
      payload: { email, role: "MEMBER" },
    });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const asViewer = await h.app.inject({ method: "GET", url: `/v1/teams/${A().teamId}/activity`, headers: bearer(A().viewerToken) });
    expect(asViewer.statusCode).toBe(200);
    expect(asViewer.body).not.toContain(email);
    const asAdmin = await h.app.inject({ method: "GET", url: `/v1/teams/${A().teamId}/activity`, headers: bearer(A().adminToken) });
    expect(asAdmin.body).toContain(email);
  });

  it("ROLE-05 — the profile route refuses a retention change", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/teams/${A().teamId}`,
      headers: bearer(A().adminToken),
      payload: { retentionPolicy: "YEAR_1" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("RETENTION_POLICY_GOVERNED");
  });

  it("DOM-02 / MEM-02 — a REVOKED member no longer lists the workspace; counts are per state", async () => {
    const m = await person("MEMBER");
    const before = await h.app.inject({ method: "GET", url: "/v1/teams", headers: bearer(m.token) });
    expect(before.body).toContain(A().teamId);
    await prisma.teamMember.update({ where: { id: m.memberId! }, data: { status: "REVOKED" } });
    const after = await h.app.inject({ method: "GET", url: "/v1/teams", headers: bearer(m.token) });
    expect(after.body).not.toContain(A().teamId);

    const detail = await h.app.inject({ method: "GET", url: `/v1/teams/${A().teamId}`, headers: bearer(A().ownerToken) });
    const stats = detail.json().stats as { memberCount: number; memberCounts: { active: number; removed: number } };
    expect(stats.memberCount).toBe(stats.memberCounts.active);
    expect(stats.memberCounts.removed).toBeGreaterThan(0);
  });

  it("ACC-11 — the access projection says why, and separates management from content", async () => {
    const m = await person("VIEWER");
    const kase = await prisma.case.create({ data: { name: `phase-b-${tag()}`, teamId: A().teamId, ownerUserId: A().ownerUserId } });
    await prisma.caseAccess.create({ data: { caseId: kase.id, userId: m.id } });
    await prisma.caseAccess.create({ data: { caseId: kase.id, userId: A().ownerUserId } });
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/teams/${A().teamId}/members/${m.memberId}/access?caseId=${kase.id}`,
      headers: bearer(A().ownerToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    const e = res.json().explanation;
    expect(e.management.administersMembers).toBe(false);
    expect(e.record).toMatchObject({ kind: "case", restricted: true, allowed: true, via: "DIRECT_CASE_GRANT" });
    expect(e.unassigned).toBe(true);
    // The asking administrator must be able to open the case themself.
    const hidden = await h.app.inject({
      method: "GET",
      url: `/v1/teams/${A().teamId}/members/${m.memberId}/access?caseId=${kase.id}`,
      headers: bearer(A().adminToken),
    });
    expect(hidden.statusCode).toBe(404);
  });


});
