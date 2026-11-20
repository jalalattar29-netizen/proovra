/**
 * Matrix review NEW-RG-07-4 / NEW-RG-26-3 — the acceptance re-check (DEC-28:
 * "pending invitations cannot be used to exercise authority the inviter no
 * longer possesses; the owner may explicitly reauthorize within the role
 * ceiling"; DEC-18: one role ceiling).
 *
 * NEW-RG-26-3 revokes an inviter's invitations on demotion or suspension going
 * forward and NEW-RG-07-4 re-applies the ceiling on resend, but nobody asked at
 * ACCEPT time. An invitation issued before those fixes — an ADMIN invitation
 * from an ADMIN (pre PRO-T1-04 ceiling), or any invitation from someone since
 * demoted, suspended or removed — was still accepted at its stored role. Both
 * acceptance authorities (workspace invitations: `acceptWorkspaceInvitation`,
 * the web and native `/v1/teams/invites/accept`; organization invitations:
 * `acceptOrganizationInvite`, `/v1/org-invites/accept`) now refuse it with
 * 409 INVITE_INVITER_AUTHORITY_LOST before their claim: nothing is granted and
 * the invitation stays pending, so an owner's resend re-authorizes it.
 *
 * Live PostgreSQL through the real routes. The "pre-fix" invitations are
 * written as rows because the current routes refuse to create them.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, OrganizationTenant, SeededUser } from "./point7/product-fixtures.js";

describe("NEW-RG-07-4 / NEW-RG-26-3 — acceptance re-checks the inviter's authority (DEC-28)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let fx: typeof import("./point7/product-fixtures.js");
  let invitations: typeof import("../src/services/identity/workspace-invitation.service.js");
  let deps: FixtureDeps;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const jwt = await import("../src/services/jwt.js");
    fx = await import("./point7/product-fixtures.js");
    invitations = await import("../src/services/identity/workspace-invitation.service.js");
    deps = {
      prisma: prisma as never,
      tag: `rg263-${Date.now().toString(36)}`,
      mintToken: (userId: string, email: string) =>
        jwt.signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET as string,
          3600,
        ),
    };
  }, 300_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 300_000);

  // ---------------------------------------------------------------------------
  // Workspace invitations
  // ---------------------------------------------------------------------------

  async function workspaceMember(
    org: OrganizationTenant,
    label: string,
    role: "ADMIN" | "MEMBER" | "VIEWER",
  ): Promise<SeededUser & { teamMemberId: string }> {
    const u = await fx.seedUser(deps, label);
    const tm = await prisma.teamMember.create({
      data: { teamId: org.workspaceId, userId: u.userId, role, status: "ACTIVE" },
      select: { id: true },
    });
    return { ...u, teamMemberId: tm.id };
  }

  /** A pending invitation as the database holds it (the current routes would refuse some of these). */
  async function workspaceInvite(org: OrganizationTenant, invitedByUserId: string, role: "ADMIN" | "MEMBER" | "VIEWER") {
    const invitee = await fx.seedUser(deps, `ws-invitee-${role.toLowerCase()}`);
    const raw = `wsit_v1_${randomUUID()}`;
    const row = await prisma.teamInvite.create({
      data: {
        teamId: org.workspaceId,
        email: invitee.email,
        role,
        tokenHash: sha(raw),
        invitedByUserId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      select: { id: true },
    });
    return { invitee, raw, inviteId: row.id };
  }

  const acceptWorkspace = (token: string, raw: string) =>
    harness.app.inject({ method: "POST", url: "/v1/teams/invites/accept", headers: auth(token), payload: { token: raw } });

  async function expectWorkspaceRefused(org: OrganizationTenant, inv: Awaited<ReturnType<typeof workspaceInvite>>) {
    const res = await acceptWorkspace(inv.invitee.token, inv.raw);
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: "INVITE_INVITER_AUTHORITY_LOST" } });
    // Nothing granted, and the invitation is still pending (re-authorizable).
    expect(await prisma.teamMember.findFirst({ where: { teamId: org.workspaceId, userId: inv.invitee.userId } })).toBeNull();
    const row = await prisma.teamInvite.findUniqueOrThrow({ where: { id: inv.inviteId }, select: { acceptedAt: true, revokedAt: true } });
    expect(row).toEqual({ acceptedAt: null, revokedAt: null });
  }

  it("workspace: an ADMIN invitation issued by an ADMIN (before the ceiling) is refused; the owner's resend re-authorizes it and it is then accepted as ADMIN", async () => {
    const org = await fx.seedOrganizationTenant(deps);
    const admin = await workspaceMember(org, "ws-admin-a", "ADMIN");
    const inv = await workspaceInvite(org, admin.userId, "ADMIN");
    await expectWorkspaceRefused(org, inv);

    const resent = await invitations.resendWorkspaceInvitation({
      workspaceId: org.workspaceId,
      inviteId: inv.inviteId,
      actorUserId: org.owner.userId,
    });
    expect((await prisma.teamInvite.findUniqueOrThrow({ where: { id: inv.inviteId } })).invitedByUserId).toBe(org.owner.userId);
    const ok = await acceptWorkspace(inv.invitee.token, resent.rawToken);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ role: "ADMIN", alreadyMember: false });
  });

  it("workspace: a MEMBER invitation from an ADMIN later demoted, suspended or removed is refused", async () => {
    const org = await fx.seedOrganizationTenant(deps);
    for (const after of [
      { role: "MEMBER" as const },
      { status: "SUSPENDED" as const },
      { status: "REVOKED" as const, revokedAtUtc: new Date() },
    ]) {
      const admin = await workspaceMember(org, "ws-admin-b", "ADMIN");
      const inv = await workspaceInvite(org, admin.userId, "MEMBER");
      // The transition is written as a pre-fix one would have left it: the
      // invitation survived it (NEW-RG-26-3 now revokes going forward).
      await prisma.teamMember.update({ where: { id: admin.teamMemberId }, data: after as never });
      await expectWorkspaceRefused(org, inv);
    }
  });

  it("workspace: an inviter who still holds the authority — an ADMIN for MEMBER, the owner for ADMIN — is accepted (positive controls)", async () => {
    const org = await fx.seedOrganizationTenant(deps);
    const admin = await workspaceMember(org, "ws-admin-c", "ADMIN");
    const byAdmin = await workspaceInvite(org, admin.userId, "MEMBER");
    const a = await acceptWorkspace(byAdmin.invitee.token, byAdmin.raw);
    expect(a.statusCode, a.body).toBe(200);
    expect(JSON.parse(a.body)).toMatchObject({ role: "MEMBER", alreadyMember: false });

    const byOwner = await workspaceInvite(org, org.owner.userId, "ADMIN");
    const b = await acceptWorkspace(byOwner.invitee.token, byOwner.raw);
    expect(b.statusCode, b.body).toBe(200);
    expect(JSON.parse(b.body)).toMatchObject({ role: "ADMIN", alreadyMember: false });
  });

  // ---------------------------------------------------------------------------
  // Organization invitations
  // ---------------------------------------------------------------------------

  async function orgAdmin(org: OrganizationTenant, label: string) {
    const u = await fx.seedUser(deps, label);
    const m = await prisma.organizationMembership.create({
      data: { organizationId: org.organizationId, userId: u.userId, role: "ORG_ADMIN" },
      select: { id: true },
    });
    await prisma.teamMember.create({ data: { teamId: org.workspaceId, userId: u.userId, role: "MEMBER", status: "ACTIVE" } });
    return { ...u, orgMembershipId: m.id };
  }

  async function orgInvite(
    org: OrganizationTenant,
    invitedByUserId: string,
    assignmentRole: "ADMIN" | "MEMBER" = "MEMBER",
  ) {
    const invitee = await fx.seedUser(deps, "org-invitee");
    const raw = randomUUID();
    const row = await prisma.organizationInvite.create({
      data: {
        organizationId: org.organizationId,
        email: invitee.email,
        role: "ORG_MEMBER",
        tokenHash: sha(raw),
        invitedByUserId,
        expiresAt: new Date(Date.now() + 86_400_000),
        workspaceAssignments: [{ teamId: org.workspaceId, role: assignmentRole }],
      } as never,
      select: { id: true },
    });
    return { invitee, raw, inviteId: row.id };
  }

  const acceptOrg = (token: string, raw: string) =>
    harness.app.inject({ method: "POST", url: "/v1/org-invites/accept", headers: auth(token), payload: { token: raw } });

  async function expectOrgRefused(org: OrganizationTenant, inv: Awaited<ReturnType<typeof orgInvite>>) {
    const res = await acceptOrg(inv.invitee.token, inv.raw);
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: "INVITE_INVITER_AUTHORITY_LOST" } });
    expect(
      await prisma.organizationMembership.findFirst({ where: { organizationId: org.organizationId, userId: inv.invitee.userId } }),
    ).toBeNull();
    expect(await prisma.teamMember.findFirst({ where: { teamId: org.workspaceId, userId: inv.invitee.userId } })).toBeNull();
    const row = await prisma.organizationInvite.findUniqueOrThrow({
      where: { id: inv.inviteId },
      select: { acceptedAt: true, revokedAt: true },
    });
    expect(row).toEqual({ acceptedAt: null, revokedAt: null });
    // The refusal is on the organization's audit timeline.
    const audit = await prisma.organizationAuditEvent.findFirst({
      where: { organizationId: org.organizationId, eventType: "ORG_INVITE_ACCEPT_REJECTED", targetId: inv.inviteId },
      select: { metadata: true },
    });
    expect(audit?.metadata).toMatchObject({ reason: "inviter_authority_lost" });
  }

  it("organization: an invitation from an ORG_ADMIN later demoted, suspended or removed is refused", async () => {
    const org = await fx.seedOrganizationTenant(deps);
    for (const after of [
      { role: "ORG_MEMBER" as const },
      { status: "SUSPENDED" as const, suspendedAtUtc: new Date() },
      { status: "REVOKED" as const, revokedAtUtc: new Date() },
    ]) {
      const admin = await orgAdmin(org, "org-admin-a");
      const inv = await orgInvite(org, admin.userId);
      await prisma.organizationMembership.update({ where: { id: admin.orgMembershipId }, data: after as never });
      await expectOrgRefused(org, inv);
    }
  });

  it("organization: a workspace ADMIN assignment from an ORG_ADMIN (before the ceiling) is refused; the owner's resend re-authorizes it", async () => {
    const org = await fx.seedOrganizationTenant(deps);
    const admin = await orgAdmin(org, "org-admin-b");
    const inv = await orgInvite(org, admin.userId, "ADMIN");
    await expectOrgRefused(org, inv);

    const resend = await harness.app.inject({
      method: "POST",
      url: `/v1/orgs/${org.organizationId}/invites/${inv.inviteId}/resend`,
      headers: auth(org.owner.token),
      payload: {},
    });
    expect(resend.statusCode, resend.body).toBe(200);
    expect((await prisma.organizationInvite.findUniqueOrThrow({ where: { id: inv.inviteId } })).invitedByUserId).toBe(
      org.owner.userId,
    );
    // The resend rotated the link; the fresh one is returned once to the owner.
    const acceptUrl = (JSON.parse(resend.body) as { acceptUrl: string | null }).acceptUrl;
    expect(acceptUrl).toBeTruthy();
    const fresh = decodeURIComponent(/\/org-invites\/([^/]+)\/accept/.exec(acceptUrl as string)![1]);
    const ok = await acceptOrg(inv.invitee.token, fresh);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(
      await prisma.teamMember.findFirstOrThrow({
        where: { teamId: org.workspaceId, userId: inv.invitee.userId },
        select: { role: true, status: true },
      }),
    ).toEqual({ role: "ADMIN", status: "ACTIVE" });
  });

  it("organization: an ORG_ADMIN who still holds the role is accepted (positive control)", async () => {
    const org = await fx.seedOrganizationTenant(deps);
    const admin = await orgAdmin(org, "org-admin-c");
    const inv = await orgInvite(org, admin.userId);
    const ok = await acceptOrg(inv.invitee.token, inv.raw);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(
      await prisma.organizationMembership.findFirstOrThrow({
        where: { organizationId: org.organizationId, userId: inv.invitee.userId },
        select: { role: true, status: true },
      }),
    ).toEqual({ role: "ORG_MEMBER", status: "ACTIVE" });
    expect(
      await prisma.teamMember.findFirstOrThrow({
        where: { teamId: org.workspaceId, userId: inv.invitee.userId },
        select: { role: true },
      }),
    ).toEqual({ role: "MEMBER" });
  });
});
