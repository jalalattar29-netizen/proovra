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
});
