/**
 * RT-001, AUTHZ-009, IDENT-018, IDENT-019, IDENT-022, on the real routes.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  registerSessionForToken,
  seedOrganizationTenant,
  seedUser,
  type FixtureDeps,
  type OrganizationTenant,
} from "./point7/product-fixtures.js";

describe("Sessions, step-up and provider claims (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];
  let governance: typeof import("../src/services/governance/governance-policy.service.js");
  let auth: typeof import("../src/services/auth.service.js");
  let adaptive: typeof import("../src/services/access-control/adaptive-auth.service.js");
  let revocation: typeof import("../src/services/identity-security/session-revocation.service.js");
  let passwords: typeof import("../src/services/email-password-auth.service.js");
  let deps: FixtureDeps;
  const tag = `iss-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const savedKey = process.env.INTERNAL_API_KEY;

  const mint = (userId: string, email: string, claims: Record<string, unknown> = {}) =>
    signJwt(
      {
        sub: userId,
        provider: "EMAIL",
        email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
        ...claims,
      } as never,
      process.env.AUTH_JWT_SECRET!,
      60 * 60,
    );

  const get = (url: string, token: string) =>
    harness.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  async function securityPolicy(org: OrganizationTenant, rule: Record<string, unknown>) {
    const created = await governance.createPolicy({
      prisma: prisma as never,
      teamId: org.workspaceId,
      kind: "SECURITY",
      slug: `sec-${randomUUID().slice(0, 8)}`,
      name: "security",
      summary: "security",
      enforcementMode: "BLOCK",
      rule,
      state: "ACTIVE",
      createdByUserId: org.owner.userId,
    });
    if (!created.ok) throw new Error("policy");
    await governance.activatePolicy({
      prisma: prisma as never,
      teamId: org.workspaceId,
      policyId: created.policyId,
      actorUserId: org.owner.userId,
    });
    await governance.assignPolicy({
      prisma: prisma as never,
      teamId: org.workspaceId,
      policyId: created.policyId,
      scope: "WORKSPACE",
      scopeTargetId: org.workspaceId,
      assignedByUserId: org.owner.userId,
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    governance = await import("../src/services/governance/governance-policy.service.js");
    auth = await import("../src/services/auth.service.js");
    adaptive = await import("../src/services/access-control/adaptive-auth.service.js");
    revocation = await import("../src/services/identity-security/session-revocation.service.js");
    passwords = await import("../src/services/email-password-auth.service.js");
    deps = { prisma: prisma as never, tag, mintToken: (u, e) => mint(u, e) };
  }, 180_000);

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.INTERNAL_API_KEY;
    else process.env.INTERNAL_API_KEY = savedKey;
    await harness?.cleanup();
  });

  it("RT-001: a malformed step-up id is an ordinary refusal, and a real shape is still looked up", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const patch = (id: string) =>
      harness.app.inject({
        method: "PATCH",
        url: "/v1/security-policy",
        headers: {
          authorization: `Bearer ${org.owner.token}`,
          "x-proovra-step-up-challenge-id": id,
        },
        payload: { organizationId: org.organizationId, noPersonalSpace: true },
      });
    for (const id of ["undefined", "null", "not-a-uuid", "1' OR '1'='1"]) {
      const res = await patch(id);
      expect(res.statusCode, `${id}: ${res.body}`).toBe(401);
      expect((res.json() as { error: { code: string } }).error.code).toBe("STEP_UP_REQUIRED");
    }
    expect((await patch(randomUUID())).statusCode).toBe(401);
  });

  it("AUTHZ-009: the internal key needs the floor and the exact value", async () => {
    const run = (key: string) =>
      harness.app.inject({
        method: "POST",
        url: "/v1/admin/demo-requests/follow-up/run",
        headers: { "x-internal-key": key },
        payload: {},
      });
    process.env.INTERNAL_API_KEY = "short";
    expect([401, 403]).toContain((await run("short")).statusCode);

    const key = `internal-${randomUUID()}`;
    process.env.INTERNAL_API_KEY = key;
    expect([401, 403]).toContain((await run(`${key}x`)).statusCode);
    expect([401, 403]).not.toContain((await run(key)).statusCode);
  });

  it("IDENT-018: requireSaml lets a SAML session in and keeps a password session out", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    const member = org.members[0]!;
    await securityPolicy(org, { requireSaml: true });
    const url = `/v1/teams/${org.workspaceId}/members`;

    expect((await get(url, member.token)).statusCode).toBe(404);
    const conn = await prisma.ssoConnection.create({
      data: {
        teamId: org.workspaceId,
        organizationId: org.organizationId,
        provider: "GENERIC_SAML",
        status: "ACTIVE",
        displayName: "idp",
        createdByUserId: org.owner.userId,
        allowedEmailDomains: [],
      } as never,
      select: { id: true },
    });
    const samlToken = mint(member.userId, "member@example.test", { authMethod: "SAML", ssoConnId: conn.id });
    await registerSessionForToken(deps, member.userId, samlToken);
    const res = await get(url, samlToken);
    expect(res.statusCode, res.body).toBe(200);
  });

  it("IDENT-018: requireMfa keeps out a session with no verified factor and admits one with it", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    const member = org.members[0]!;
    await securityPolicy(org, { requireMfa: true });
    const url = `/v1/teams/${org.workspaceId}/members`;
    expect((await get(url, member.token)).statusCode).toBe(404);
    const withFactor = mint(member.userId, "member@example.test", { mfaAt: Math.floor(Date.now() / 1000) });
    await registerSessionForToken(deps, member.userId, withFactor);
    const res = await get(url, withFactor);
    expect(res.statusCode, res.body).toBe(200);
  });

  for (const [riskScore, expected] of [[70, "REQUIRE_REAUTH"], [95, "BLOCK"]] as const) {
  it(`IDENT-019: a ${expected} decision ends the session on its next request`, async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    const member = org.members[0]!;
    const token = mint(member.userId, "member@example.test");
    await registerSessionForToken(deps, member.userId, token, org.workspaceId);
    const url = `/v1/teams/${org.workspaceId}/members`;
    expect((await get(url, token)).statusCode).toBe(200);

    const sid = (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { sid: string }).sid;
    const session = await prisma.authenticatedSession.findFirstOrThrow({
      where: { userId: member.userId, sessionIdHash: revocation.hashSessionId(sid) },
    });
    await prisma.authenticatedSession.update({ where: { id: session.id }, data: { riskScore } });

    const decided = await adaptive.decideAdaptiveAuth(
      {
        teamId: org.workspaceId,
        userId: member.userId,
        sessionId: session.id,
        highPrivilegeAction: true,
        workspaceRequiresStepUp: false,
      },
      prisma as never,
    );
    expect(decided.decision).toBe(expected);
    expect((await get(url, token)).statusCode).toBe(401);
  });
  }

  it("IDENT-019: a password sign-in is scored, not left blank", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const person = await seedUser(deps, "scored");
    const row = await prisma.user.update({
      where: { id: person.userId },
      data: {
        passwordHash: passwords.hashPassword("Correct-horse-9-battery"),
        emailVerifiedAt: new Date(),
        currentWorkspaceId: org.workspaceId,
      },
      select: { email: true },
    });
    await prisma.teamMember.create({
      data: { teamId: org.workspaceId, userId: person.userId, role: "MEMBER", status: "ACTIVE" },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: org.organizationId, userId: person.userId, role: "ORG_MEMBER" },
    });
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/email/login",
      payload: { email: row.email, password: "Correct-horse-9-battery" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const session = await prisma.authenticatedSession.findFirstOrThrow({ where: { userId: person.userId } });
    expect(session.riskScore).not.toBeNull();
  });

  it("IDENT-019: signing in again from the same browser is not a suspicious session; a sign-in with no device is", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const person = await seedUser(deps, "again");
    const row = await prisma.user.update({
      where: { id: person.userId },
      data: {
        passwordHash: passwords.hashPassword("Correct-horse-9-battery"),
        emailVerifiedAt: new Date(),
        currentWorkspaceId: org.workspaceId,
      },
      select: { email: true },
    });
    await prisma.teamMember.create({
      data: { teamId: org.workspaceId, userId: person.userId, role: "MEMBER", status: "ACTIVE" },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: org.organizationId, userId: person.userId, role: "ORG_MEMBER" },
    });
    const browser = { "user-agent": "Mozilla/5.0 (integration) Chrome/131", "accept-language": "en-GB" };
    const signIn = (headers: Record<string, string>) =>
      harness.app.inject({
        method: "POST",
        url: "/v1/auth/email/login",
        headers,
        payload: { email: row.email, password: "Correct-horse-9-battery" },
      });
    const condition = () =>
      prisma.operationalIncident.count({
        where: { teamId: org.workspaceId, sourceId: "identity.security_condition", status: { not: "RESOLVED" } },
      });

    // The fixture's own session is not one of these sign-ins.
    const seeded = (await prisma.authenticatedSession.findMany({ where: { userId: person.userId }, select: { id: true } })).map((s) => s.id);
    for (let i = 0; i < 3; i += 1) expect((await signIn(browser)).statusCode).toBe(200);
    const sessions = await prisma.authenticatedSession.findMany({
      where: { userId: person.userId, id: { notIn: seeded } },
      orderBy: { issuedAtUtc: "asc" },
    });
    expect(sessions).toHaveLength(3);
    for (const s of sessions) {
      expect(s.deviceIdHash).toMatch(/^[0-9a-f]{64}$/);
      expect(s.riskScore).toBe(0);
    }
    expect(new Set(sessions.map((s) => s.deviceIdHash)).size).toBe(1);
    expect(await condition()).toBe(0);

    // The signal still stands for what it is for: a session with no device at all.
    expect((await signIn({ "user-agent": "" })).statusCode).toBe(200);
    const bare = await prisma.authenticatedSession.findFirstOrThrow({
      where: { userId: person.userId, deviceIdHash: null, id: { notIn: seeded } },
    });
    expect(bare.riskScore).toBeGreaterThanOrEqual(30);
    await expect.poll(condition, { timeout: 10_000 }).toBe(1);
  });

  it("IDENT-022: an address the provider does not vouch for gets no stamp and no guest row", async () => {
    const email = `guest-${randomUUID().slice(0, 8)}@example.test`;
    const guest = await prisma.user.create({
      data: { email, provider: "GUEST", providerUserId: `guest-${randomUUID()}` },
      select: { id: true },
    });

    const unvouched = await auth.upsertUser({
      provider: "GOOGLE",
      providerUserId: `google-${randomUUID()}`,
      email,
      emailVerified: false,
    });
    expect(unvouched.id).not.toBe(guest.id);
    expect(unvouched.emailVerifiedAt).toBeNull();
    const untouched = await prisma.user.findUniqueOrThrow({ where: { id: guest.id }, select: { provider: true } });
    expect(untouched.provider).toBe("GUEST");

    const vouched = await auth.upsertUser({
      provider: "GOOGLE",
      providerUserId: `google-${randomUUID()}`,
      email,
      emailVerified: true,
    });
    expect(vouched.id).toBe(guest.id);
    expect(vouched.emailVerifiedAt).not.toBeNull();
  });
});
