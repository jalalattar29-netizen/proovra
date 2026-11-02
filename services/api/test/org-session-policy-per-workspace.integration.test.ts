/**
 * AUTHZ-001 / IDENT-001 / MOBILE-001 — organization security policy follows the
 * workspace a request acts in, not the workspace recorded at login.
 *
 * Every session here starts in Personal, which is what a normal member's login
 * writes on the session row. Before the repair none of these sessions was ever
 * evaluated against the Organization: a password session read and downloaded
 * from a workspace that requires SSO. Real routes, real tenant rows, real tokens.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  registerSessionForToken,
  seedOrganizationTenant,
  seedPersonalTenant,
  type FixtureDeps,
  type OrganizationTenant,
} from "./point7/product-fixtures.js";

describe("Organization security policy per workspace (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];
  let deps: FixtureDeps;
  const tag = `osp-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

  const get = (url: string, token: string) =>
    harness.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  function mint(
    userId: string,
    email: string,
    claims: Record<string, unknown> = { authMethod: "PASSWORD" },
  ): string {
    return signJwt(
      { sub: userId, provider: "EMAIL", email, authAt: Math.floor(Date.now() / 1000), ...claims } as never,
      process.env.AUTH_JWT_SECRET!,
      60 * 60,
    );
  }

  async function orgRecord(org: OrganizationTenant) {
    const row = await prisma.evidence.create({
      data: { ownerUserId: org.owner.userId, teamId: org.workspaceId, organizationId: org.organizationId, type: "PHOTO" },
      select: { id: true },
    });
    return row.id;
  }

  async function connection(org: OrganizationTenant) {
    return prisma.ssoConnection.create({
      data: {
        teamId: org.workspaceId,
        organizationId: org.organizationId,
        provider: "GENERIC_SAML",
        status: "ACTIVE",
        displayName: "test idp",
        createdByUserId: org.owner.userId,
        allowedEmailDomains: [],
      } as never,
      select: { id: true },
    });
  }

  const requireSso = (org: OrganizationTenant) =>
    prisma.organizationSecurityPolicy.update({
      where: { organizationId: org.organizationId },
      data: { ssoRequired: true },
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    deps = {
      prisma: prisma as never,
      tag,
      mintToken: (userId, email) => mint(userId, email),
    };
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("a password session reads the Organization only until the Organization requires SSO", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    const member = org.members[0]!;
    const recordId = await orgRecord(org);

    const before = await get(`/v1/evidence/${recordId}`, member.token);
    expect(before.statusCode, before.body).toBe(200);
    const listedBefore = await get(`/v1/evidence?teamId=${org.workspaceId}`, member.token);
    expect(listedBefore.statusCode, listedBefore.body).toBe(200);

    await requireSso(org);

    const detail = await get(`/v1/evidence/${recordId}`, member.token);
    expect(detail.statusCode, detail.body).toBe(404);
    const list = await get(`/v1/evidence?teamId=${org.workspaceId}`, member.token);
    expect(list.statusCode, list.body).toBe(404);
    const roster = await get(`/v1/teams/${org.workspaceId}/members`, member.token);
    expect(roster.statusCode, roster.body).toBe(404);
  });

  it("a session anchored in the Organization is refused with the rule, so a client can say what to do", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    const member = org.members[0]!;
    await prisma.authenticatedSession.updateMany({
      where: { userId: member.userId },
      data: { teamId: org.workspaceId },
    });
    const allowed = await get("/v1/auth/me", member.token);
    expect(allowed.statusCode, allowed.body).toBe(200);

    await requireSso(org);

    const refused = await get("/v1/auth/me", member.token);
    expect(refused.statusCode, refused.body).toBe(401);
    expect(refused.json().error.code).toBe("UNAUTHORIZED");
    expect(refused.json().error.details).toMatchObject({
      reason: "reauthentication_required",
      policy: "mandatory_sso_required",
    });
  });

  it("the same session keeps its Personal workspace, which no Organization governs", async () => {
    const personal = await seedPersonalTenant(deps, "FREE");
    const org = await seedOrganizationTenant(deps);
    await prisma.teamMember.create({
      data: { teamId: org.workspaceId, userId: personal.owner.userId, role: "MEMBER", status: "ACTIVE" },
    });
    await requireSso(org);
    const own = await prisma.evidence.create({
      data: {
        ownerUserId: personal.owner.userId,
        teamId: personal.personalTeamId,
        organizationId: personal.personalOrganizationId,
        type: "PHOTO",
      },
      select: { id: true },
    });
    const detail = await get(`/v1/evidence/${own.id}`, personal.owner.token);
    expect(detail.statusCode, detail.body).toBe(200);
  });

  it("an SSO session through this Organization's connection is admitted, another Organization's is not", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    const other = await seedOrganizationTenant(deps);
    const member = org.members[0]!;
    const recordId = await orgRecord(org);
    await requireSso(org);
    const own = await connection(org);
    const foreign = await connection(other);

    const good = mint(member.userId, member.email, { authMethod: "SAML", ssoConnId: own.id });
    await registerSessionForToken(deps, member.userId, good);
    const admitted = await get(`/v1/evidence/${recordId}`, good);
    expect(admitted.statusCode, admitted.body).toBe(200);

    const bad = mint(member.userId, member.email, { authMethod: "SAML", ssoConnId: foreign.id });
    await registerSessionForToken(deps, member.userId, bad);
    const refused = await get(`/v1/evidence/${recordId}`, bad);
    expect(refused.statusCode, refused.body).toBe(404);
  });

  it("an MFA policy governs a live session: no second factor, no entry", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    const member = org.members[0]!;
    const recordId = await orgRecord(org);
    await prisma.organizationSecurityPolicy.update({
      where: { organizationId: org.organizationId },
      data: { mfaPolicyLevel: "ALL_MEMBERS" },
    });

    const noFactor = await get(`/v1/evidence/${recordId}`, member.token);
    expect(noFactor.statusCode, noFactor.body).toBe(404);

    const verified = mint(member.userId, member.email, {
      authMethod: "PASSWORD",
      mfaAt: Math.floor(Date.now() / 1000),
    });
    await registerSessionForToken(deps, member.userId, verified);
    const withFactor = await get(`/v1/evidence/${recordId}`, verified);
    expect(withFactor.statusCode, withFactor.body).toBe(200);
  });

  it("the session age limit applies to a session that started outside the Organization", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    const member = org.members[0]!;
    const recordId = await orgRecord(org);
    await prisma.organizationSecurityPolicy.update({
      where: { organizationId: org.organizationId },
      data: { maxSessionAgeSeconds: 60 },
    });
    const stale = mint(member.userId, member.email, {
      authMethod: "PASSWORD",
      authAt: Math.floor(Date.now() / 1000) - 3600,
    });
    await registerSessionForToken(deps, member.userId, stale);
    const refused = await get(`/v1/evidence/${recordId}`, stale);
    expect(refused.statusCode, refused.body).toBe(404);
    const fresh = await get(`/v1/evidence/${recordId}`, member.token);
    expect(fresh.statusCode, fresh.body).toBe(200);
  });

  it("deciding another person's access never applies the caller's session", async () => {
    const { evaluateMemberAccess } = await import("../src/services/identity/access-policy.service.js");
    const { bindRequestSession } = await import("../src/services/auth/request-session-context.js");
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    await requireSso(org);
    bindRequestSession({
      userId: org.owner.userId,
      policyMethod: "PASSWORD",
      ssoConnId: null,
      authAtMs: Date.now(),
      issuedAtSec: Math.floor(Date.now() / 1000),
      lastSeenAtMs: Date.now(),
      mfaAtSec: null,
      clientIp: "127.0.0.1",
    });
    const decision = await evaluateMemberAccess({
      teamId: org.workspaceId,
      userId: org.members[0]!.userId,
      permission: "evidence.read",
    });
    expect(decision.allowed).toBe(true);
  });

  it("an administrator sees and revokes a member's session that started elsewhere, and a quarantine follows it", async () => {
    const { listActiveSessions, revokeActiveSession } = await import(
      "../src/services/access-control/session-inventory.service.js"
    );
    const { quarantineSession, isSessionQuarantined } = await import(
      "../src/services/access-control/session-quarantine.service.js"
    );
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    const other = await seedOrganizationTenant(deps);
    const member = org.members[0]!;

    const page = await listActiveSessions({ teamId: org.workspaceId, userId: member.userId });
    expect(page.sessions).toHaveLength(1);
    const sessionId = page.sessions[0]!.id;

    // A foreign administrator cannot reach it: the owner is not their member.
    const foreign = await quarantineSession({
      teamId: other.workspaceId,
      sessionId,
      actorUserId: other.owner.userId,
      reason: "MANUAL_OPERATOR",
    });
    expect(foreign).toBeNull();

    const quarantined = await quarantineSession({
      teamId: org.workspaceId,
      sessionId,
      actorUserId: org.owner.userId,
      reason: "MANUAL_OPERATOR",
    });
    expect(quarantined).not.toBeNull();
    expect(await isSessionQuarantined({ sessionId })).toBe(true);

    const revoked = await revokeActiveSession({
      teamId: org.workspaceId,
      sessionId,
      actorUserId: org.owner.userId,
    });
    expect(revoked.ok).toBe(true);
    const afterRevoke = await get("/v1/evidence", member.token);
    expect(afterRevoke.statusCode).toBe(401);
  });
});
