/**
 * IDENT-008 — mandatory SSO cannot be set, or left standing, with no way in.
 *
 * Accepted with no connection, it locked the whole Organization out, the
 * administrator who set it included, until PROOVRA staff intervened.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";
import { registerSessionForToken, seedOrganizationTenant, type FixtureDeps, type OrganizationTenant } from "./point7/product-fixtures.js";

describe("Mandatory SSO readiness (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];
  let policySvc: typeof import("../src/services/identity/org-security-policy.service.js");
  let sso: typeof import("../src/services/access-control/sso.service.js");
  let bootstrap: typeof import("../src/services/platform-context/workspace-bootstrap.service.js");
  let deps: FixtureDeps;
  const tag = `msr-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

  const mint = (userId: string, email: string) =>
    signJwt(
      { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
      process.env.AUTH_JWT_SECRET!,
      60 * 60,
    );

  const connection = (org: OrganizationTenant, status: string, provider = "GENERIC_SAML") =>
    prisma.ssoConnection.create({
      data: {
        teamId: org.workspaceId,
        organizationId: org.organizationId,
        provider,
        status,
        displayName: "idp",
        createdByUserId: org.owner.userId,
        allowedEmailDomains: [],
      } as never,
      select: { id: true },
    });

  const required = (organizationId: string) =>
    prisma.organizationSecurityPolicy.findUniqueOrThrow({
      where: { organizationId },
      select: { ssoRequired: true, allowedAuthMethods: true, policyVersion: true },
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    policySvc = await import("../src/services/identity/org-security-policy.service.js");
    sso = await import("../src/services/access-control/sso.service.js");
    bootstrap = await import("../src/services/platform-context/workspace-bootstrap.service.js");
    deps = { prisma: prisma as never, tag, mintToken: mint };
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("the route refuses it with no ACTIVE connection and writes nothing", async () => {
    const org = await seedOrganizationTenant(deps, {});
    await connection(org, "PENDING");
    const before = await required(org.organizationId);
    const stepUp = createStepUpCeremony({
      prisma: prisma as never,
      inject: (o) => harness.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    const headers = await stepUp.approvedHeader({
      userId: org.owner.userId,
      token: org.owner.token,
      teamId: org.workspaceId,
      purpose: "ORG_SECURITY_POLICY_UPDATE",
    });
    const res = await harness.app.inject({
      method: "PATCH",
      url: "/v1/security-policy",
      headers: { authorization: `Bearer ${org.owner.token}`, ...headers },
      payload: { organizationId: org.organizationId, ssoRequired: true },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe("SSO_REQUIRED_NO_ACTIVE_CONNECTION");
    expect(await required(org.organizationId)).toEqual(before);
  });

  it("from the console, an ACTIVE connection is not enough: the administrator must have signed in through it", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const conn = await connection(org, "ACTIVE");
    const stepUp = createStepUpCeremony({
      prisma: prisma as never,
      inject: (o) => harness.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    const patch = (token: string, headers: Record<string, string>) =>
      harness.app.inject({
        method: "PATCH",
        url: "/v1/security-policy",
        headers: { authorization: `Bearer ${token}`, ...headers },
        payload: { organizationId: org.organizationId, ssoRequired: true },
      });

    // A password session would be refused by the very policy it sets.
    const before = await required(org.organizationId);
    const refused = await patch(
      org.owner.token,
      await stepUp.approvedHeader({ userId: org.owner.userId, token: org.owner.token, teamId: org.workspaceId, purpose: "ORG_SECURITY_POLICY_UPDATE" }),
    );
    expect(refused.statusCode, refused.body).toBe(409);
    expect((refused.json() as { error: { code: string } }).error.code).toBe("SSO_REQUIRED_ACTOR_NOT_SIGNED_IN_WITH_SSO");
    expect(await required(org.organizationId)).toEqual(before);

    // The same administrator, signed in through the connection.
    const ssoToken = signJwt(
      {
        sub: org.owner.userId,
        provider: "EMAIL",
        email: org.owner.email,
        authMethod: "SAML",
        ssoConnId: conn.id,
        authAt: Math.floor(Date.now() / 1000),
      } as never,
      process.env.AUTH_JWT_SECRET!,
      60 * 60,
    );
    await registerSessionForToken(deps, org.owner.userId, ssoToken);
    const accepted = await patch(
      ssoToken,
      await stepUp.approvedHeader({ userId: org.owner.userId, token: ssoToken, teamId: org.workspaceId, purpose: "ORG_SECURITY_POLICY_UPDATE" }),
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await required(org.organizationId)).ssoRequired).toBe(true);
  });

  it("narrowing the allowed methods to SSO alone is the same lockout", async () => {
    const org = await seedOrganizationTenant(deps, {});
    await expect(
      policySvc.applySecurityPolicyPatch({
        organizationId: org.organizationId,
        actorUserId: org.owner.userId,
        patch: { allowedAuthMethods: ["SSO"] },
      }),
    ).rejects.toMatchObject({ code: "SSO_REQUIRED_NO_ACTIVE_CONNECTION" });
  });

  it("with an ACTIVE connection it is accepted, and other changes are untouched", async () => {
    const org = await seedOrganizationTenant(deps, {});
    await policySvc.applySecurityPolicyPatch({
      organizationId: org.organizationId,
      actorUserId: org.owner.userId,
      patch: { allowedAuthMethods: ["PASSWORD", "SSO"] },
    });
    await connection(org, "ACTIVE");
    await policySvc.applySecurityPolicyPatch({
      organizationId: org.organizationId,
      actorUserId: org.owner.userId,
      patch: { ssoRequired: true },
    });
    expect((await required(org.organizationId)).ssoRequired).toBe(true);
  });

  it("the last connection of a mandatory-SSO Organization cannot be taken away", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const conn = await connection(org, "ACTIVE");
    await policySvc.applySecurityPolicyPatch({
      organizationId: org.organizationId,
      actorUserId: org.owner.userId,
      patch: { ssoRequired: true },
    });
    await expect(
      sso.transitionSsoConnection({ teamId: org.workspaceId, id: conn.id, nextStatus: "DISABLED", actorUserId: org.owner.userId }),
    ).rejects.toMatchObject({ code: "SSO_LAST_REQUIRED_CONNECTION" });
    const row = await prisma.ssoConnection.findUniqueOrThrow({ where: { id: conn.id }, select: { status: true } });
    expect(row.status).toBe("ACTIVE");

    // With the requirement lifted first, the same transition goes through.
    await policySvc.applySecurityPolicyPatch({
      organizationId: org.organizationId,
      actorUserId: org.owner.userId,
      patch: { ssoRequired: false },
    });
    await sso.transitionSsoConnection({ teamId: org.workspaceId, id: conn.id, nextStatus: "DISABLED", actorUserId: org.owner.userId });
    const after = await prisma.ssoConnection.findUniqueOrThrow({ where: { id: conn.id }, select: { status: true } });
    expect(after.status).toBe("DISABLED");
  });

  it("a second ACTIVE connection leaves a way in, so the first can go", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const first = await connection(org, "ACTIVE", "GENERIC_SAML");
    await connection(org, "ACTIVE", "OKTA");
    await policySvc.applySecurityPolicyPatch({
      organizationId: org.organizationId,
      actorUserId: org.owner.userId,
      patch: { ssoRequired: true },
    });
    await sso.transitionSsoConnection({ teamId: org.workspaceId, id: first.id, nextStatus: "DISABLED", actorUserId: org.owner.userId });
    const row = await prisma.ssoConnection.findUniqueOrThrow({ where: { id: first.id }, select: { status: true } });
    expect(row.status).toBe("DISABLED");
  });

  describe("while SSO is the only way in, who may change the policy (IDENT-008 recovery)", () => {
    /** An Organization that already requires SSO, with one ACTIVE connection. */
    async function requiringSso() {
      const org = await seedOrganizationTenant(deps, { memberCount: 1 });
      const conn = await connection(org, "ACTIVE");
      await policySvc.applySecurityPolicyPatch({
        organizationId: org.organizationId,
        actorUserId: org.owner.userId,
        patch: { ssoRequired: true },
      });
      return { org, conn };
    }
    const tokenFor = async (userId: string, email: string, extra: Record<string, unknown>) => {
      const token = signJwt(
        { sub: userId, provider: "EMAIL", email, authAt: Math.floor(Date.now() / 1000), ...extra } as never,
        process.env.AUTH_JWT_SECRET!,
        60 * 60,
      );
      await registerSessionForToken(deps, userId, token);
      return token;
    };
    const patchAs = async (
      org: OrganizationTenant,
      userId: string,
      token: string,
      payload: Record<string, unknown>,
      /** Owner recovery: the step-up is answered in the owner's personal workspace. */
      anchor: { teamId: string; resourceKind?: string; resourceId?: string } = { teamId: org.workspaceId },
    ) => {
      const stepUp = createStepUpCeremony({
        prisma: prisma as never,
        inject: (o) => harness.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
      });
      const headers = await stepUp.approvedHeader({ userId, token, purpose: "ORG_SECURITY_POLICY_UPDATE", ...anchor });
      return harness.app.inject({
        method: "PATCH",
        url: "/v1/security-policy",
        headers: { authorization: "Bearer " + token, ...headers },
        payload: { organizationId: org.organizationId, ...payload },
      });
    };
    const code = (r: { json: () => unknown }) => (r.json() as { error: { code: string } }).error.code;
    // The product's own bootstrap (the personal space a person gets on first sign-in).
    const personalWorkspace = async (userId: string) =>
      (await bootstrap.ensurePersonalWorkspace({ userId })).teamId;
    /** A plain PATCH with no step-up header: refusals that need no ceremony. */
    const bare = (org: OrganizationTenant, token: string, payload: Record<string, unknown>) =>
      harness.app.inject({
        method: "PATCH",
        url: "/v1/security-policy",
        headers: { authorization: "Bearer " + token },
        payload: { organizationId: org.organizationId, ...payload },
      });
    const recoveries = (organizationId: string) =>
      prisma.organizationAuditEvent.count({ where: { organizationId, eventType: "ORG_SSO_RECOVERY_OVERRIDE" } });

    it("an administrator signed in with a password cannot rewrite the policy, nor switch SSO off", async () => {
      const { org } = await requiringSso();
      const admin = org.members[0]!;
      await prisma.organizationMembership.updateMany({
        where: { organizationId: org.organizationId, userId: admin.userId },
        data: { role: "ORG_ADMIN" },
      });
      const token = await tokenFor(admin.userId, admin.email, { authMethod: "PASSWORD", mfaAt: Math.floor(Date.now() / 1000) });
      const before = await required(org.organizationId);
      const off = await bare(org, token, { ssoRequired: false });
      expect(off.statusCode, off.body).toBe(409);
      expect(code(off)).toBe("SSO_REQUIRED_POLICY_EDIT_NEEDS_SSO");
      const other = await bare(org, token, { idleTimeoutSeconds: 900 });
      expect(other.statusCode, other.body).toBe(409);
      expect(code(other)).toBe("SSO_REQUIRED_POLICY_EDIT_NEEDS_SSO");
      expect(await required(org.organizationId)).toEqual(before);
    });

    it("the owner without a two-factor sign-in cannot switch it off", async () => {
      const { org } = await requiringSso();
      const token = await tokenFor(org.owner.userId, org.owner.email, { authMethod: "PASSWORD" });
      const res = await bare(org, token, { ssoRequired: false });
      expect(res.statusCode, res.body).toBe(409);
      expect(code(res)).toBe("SSO_REQUIRED_POLICY_EDIT_NEEDS_SSO");
      expect((await required(org.organizationId)).ssoRequired).toBe(true);
    });

    it("the owner, signed in with password and two-factor, can switch only the requirement off, and it is on the Organization's trail", async () => {
      const { org } = await requiringSso();
      const token = await tokenFor(org.owner.userId, org.owner.email, { authMethod: "PASSWORD", mfaAt: Math.floor(Date.now() / 1000) });
      const personal = await personalWorkspace(org.owner.userId);
      // Riding anything else on the recovery is refused.
      const mixed = await bare(org, token, { ssoRequired: false, idleTimeoutSeconds: 900 });
      expect(mixed.statusCode, mixed.body).toBe(409);
      expect((await required(org.organizationId)).ssoRequired).toBe(true);
      expect(await recoveries(org.organizationId)).toBe(0);
      // Without the step-up, nothing changes.
      const noStepUp = await bare(org, token, { ssoRequired: false });
      expect(noStepUp.statusCode, noStepUp.body).toBe(401);
      expect((await required(org.organizationId)).ssoRequired).toBe(true);

      // The console saves its whole form: unchanged fields ride along and are not a change.
      const stored = await prisma.organizationSecurityPolicy.findUniqueOrThrow({
        where: { organizationId: org.organizationId },
        select: { idleTimeoutSeconds: true, allowedAuthMethods: true },
      });
      const off = await patchAs(
        org,
        org.owner.userId,
        token,
        { ssoRequired: false, idleTimeoutSeconds: stored.idleTimeoutSeconds, allowedAuthMethods: stored.allowedAuthMethods },
        { teamId: personal, resourceKind: "organization", resourceId: org.organizationId },
      );
      expect(off.statusCode, off.body).toBe(200);
      expect((await required(org.organizationId)).ssoRequired).toBe(false);
      expect(await recoveries(org.organizationId)).toBe(1);
    });

    it("a session that came through the Organization's SSO edits as before (control)", async () => {
      const { org, conn } = await requiringSso();
      const admin = org.members[0]!;
      await prisma.organizationMembership.updateMany({
        where: { organizationId: org.organizationId, userId: admin.userId },
        data: { role: "ORG_ADMIN" },
      });
      const token = await tokenFor(admin.userId, admin.email, { authMethod: "SAML", ssoConnId: conn.id });
      const res = await patchAs(org, admin.userId, token, { idleTimeoutSeconds: 900 });
      expect(res.statusCode, res.body).toBe(200);
      expect(await recoveries(org.organizationId)).toBe(0);
    });
  });
});
