/**
 * Closure evidence (WS-ORG rows) — behavioural proofs through the real routes
 * and services against a disposable PostgreSQL:
 *
 *   PRO-A2C-03  clearing a stored SAML externalId override is privilege-affecting
 *               (step-up), an unchanged mapping is not
 *   PRO-A2Z-03  SSO health classifies an OIDC connection by its failures, not by a
 *               missing SAML certificate; a SAML connection without one stays
 *               UNCONFIGURED
 *   PRO-A2Z-04  a SCIM group's members are the people the group granted (live
 *               provenance), not every holder of the mapped role; a removal ends
 *               the listing
 *   PRO-T2-12   a lapsed Organization can still remove its verified domain claim
 *               (role and step-up still apply); adding a claim stays plan-gated
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { makeEnterpriseOrganizationWorkspace } from "./support/enterprise-organization.js";
import type { FixtureDeps } from "./point7/product-fixtures.js";

type Json = Record<string, unknown>;
type Res = { statusCode: number; body: string };

describe("closure evidence — WS-ORG rows (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let fx: typeof import("./point7/product-fixtures.js");
  let scim: typeof import("../src/services/access-control/scim.service.js");
  let groups: typeof import("../src/services/access-control/scim-groups.service.js");
  let jwt: typeof import("../src/services/jwt.js");
  let ceremony: ReturnType<(typeof import("./support/step-up-ceremony.js"))["createStepUpCeremony"]>;
  let clearRates: () => Promise<unknown>;
  let deps: FixtureDeps;
  let ip = 1;
  const tag = () => randomUUID().slice(0, 8);

  const call = (method: string, url: string, token: string, payload?: unknown, extra: Record<string, string> = {}): Promise<Res> =>
    h.app.inject({
      method: method as never,
      url,
      remoteAddress: `198.18.1.${(ip++ % 250) + 1}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    }) as unknown as Promise<Res>;
  const json = (r: Res) => JSON.parse(r.body) as Json;
  const errorCode = (r: Res) => ((json(r).error ?? {}) as { code?: string }).code;

  async function enterpriseOrg(memberCount = 0) {
    const o = await fx.seedOrganizationTenant(deps, { memberCount });
    await makeEnterpriseOrganizationWorkspace(prisma, o.workspaceId);
    await prisma.user.update({ where: { id: o.owner.userId }, data: { currentWorkspaceId: o.workspaceId } });
    return o;
  }

  async function connection(o: { organizationId: string; workspaceId: string; owner: { userId: string } }, data: Json) {
    return prisma.ssoConnection.create({
      data: {
        teamId: o.workspaceId,
        organizationId: o.organizationId,
        displayName: `evid-${tag()}`,
        createdByUserId: o.owner.userId,
        allowedEmailDomains: [],
        status: "ACTIVE",
        ...data,
      } as never,
      select: { id: true },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    fx = await import("./point7/product-fixtures.js");
    scim = await import("../src/services/access-control/scim.service.js");
    groups = await import("../src/services/access-control/scim-groups.service.js");
    jwt = await import("../src/services/jwt.js");
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    const { createStepUpCeremony } = await import("./support/step-up-ceremony.js");
    ceremony = createStepUpCeremony({ prisma: prisma as never, inject: (o) => h.app.inject(o as never) as never });
    deps = {
      prisma: prisma as never,
      tag: `evidorg-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        jwt.signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
  }, 300_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // PRO-A2C-03
  // ===========================================================================
  describe("PRO-A2C-03: clearing the SAML externalId override needs a step-up", () => {
    const stored = { email: "mail", name: "displayName", externalId: "employeeNumber", groupClaim: null, defaultRole: "MEMBER", groupRoleMap: [] };

    it("refused: clearing the stored override without a step-up answers STEP_UP_REQUIRED and the override stays", async () => {
      await clearRates();
      const o = await enterpriseOrg();
      const conn = await connection(o, {
        provider: "GENERIC_SAML",
        samlEntityId: `https://idp.evid.test/${tag()}`,
        samlSsoUrl: "https://idp.evid.test/sso",
        samlAttributeMapping: stored,
      });
      const cleared = { ...stored, externalId: null };
      const r = await call("PUT", "/v1/saml/mapping", o.owner.token, { teamId: o.workspaceId, connectionId: conn.id, mapping: cleared, acknowledgePrivilegeImpact: true });
      expect(r.statusCode, r.body).toBe(401);
      expect(errorCode(r)).toBe("STEP_UP_REQUIRED");
      expect((await prisma.ssoConnection.findUniqueOrThrow({ where: { id: conn.id } })).samlAttributeMapping).toEqual(stored);

      // allowed: the same clear with a bound step-up is applied and recorded as privilege-affecting.
      const stepUp = await ceremony.approvedHeader({
        token: o.owner.token,
        userId: o.owner.userId,
        teamId: o.workspaceId,
        purpose: "SAML_MAPPING_PRIVILEGE_UPDATE",
        resourceKind: "saml_connection",
        resourceId: conn.id,
      });
      const ok = await call("PUT", "/v1/saml/mapping", o.owner.token, { teamId: o.workspaceId, connectionId: conn.id, mapping: cleared, acknowledgePrivilegeImpact: true }, stepUp);
      expect(ok.statusCode, ok.body).toBe(200);
      expect((json(ok).result as Json).privilegeAffecting).toBe(true);
      expect((await prisma.ssoConnection.findUniqueOrThrow({ where: { id: conn.id } })).samlAttributeMapping).toMatchObject({ externalId: null });
    });

    it("control: re-saving the mapping with the override unchanged needs no step-up", async () => {
      await clearRates();
      const o = await enterpriseOrg();
      const conn = await connection(o, {
        provider: "GENERIC_SAML",
        samlEntityId: `https://idp.evid.test/${tag()}`,
        samlSsoUrl: "https://idp.evid.test/sso",
        samlAttributeMapping: stored,
      });
      const r = await call("PUT", "/v1/saml/mapping", o.owner.token, { teamId: o.workspaceId, connectionId: conn.id, mapping: { ...stored, name: "cn" } });
      expect(r.statusCode, r.body).toBe(200);
      expect((json(r).result as Json).privilegeAffecting).toBe(false);
    });
  });

  // ===========================================================================
  // PRO-A2Z-03
  // ===========================================================================
  describe("PRO-A2Z-03: SSO health classification", () => {
    it("an active OIDC connection with no failures is HEALTHY; a SAML connection with no certificate is UNCONFIGURED", async () => {
      await clearRates();
      const o = await enterpriseOrg();
      const oidc = await connection(o, { provider: "GENERIC_OIDC", issuerUrl: `https://op.evid.test/${tag()}`, clientId: `evid-${tag()}` });
      const saml = await connection(o, {
        provider: "GENERIC_SAML",
        samlEntityId: `https://idp.evid.test/${tag()}`,
        samlSsoUrl: "https://idp.evid.test/sso",
      });
      const r = await call("GET", `/v1/sso/health?teamId=${o.workspaceId}`, o.owner.token);
      expect(r.statusCode, r.body).toBe(200);
      const conns = (json(r).snapshot as { connections: Array<{ connectionId: string; health: string }> }).connections;
      expect(conns.find((c) => c.connectionId === oidc.id)?.health).toBe("HEALTHY");
      expect(conns.find((c) => c.connectionId === saml.id)?.health).toBe("UNCONFIGURED");
    });
  });

  // ===========================================================================
  // PRO-A2Z-04
  // ===========================================================================
  describe("PRO-A2Z-04: SCIM group membership is read by grant", () => {
    it("the group lists the member it granted, never an invited holder of the same role; a removal ends the listing", async () => {
      const t = await fx.seedOrganizationTenant(deps);
      const domain = await fx.verifyOrganizationDomain(deps, t.organizationId, t.owner.userId);
      const { projection } = await scim.createScimToken(
        { teamId: t.workspaceId, actorUserId: t.owner.userId, name: `dir-${tag()}`, scopes: ["users.read", "users.write", "users.deactivate", "groups.read", "groups.write"] },
        prisma as never,
      );
      const ctx = { teamId: t.workspaceId, organizationId: t.organizationId, tokenId: projection.id, baseUrl: "https://scim.test/v2/scim" };
      const email = `evid-${tag()}@${domain}`;
      const pushed = await scim.scimCreateUser(
        ctx as never,
        { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: email, externalId: `ext-${tag()}`, emails: [{ value: email, primary: true }], active: true } as never,
        prisma as never,
      );
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      const directoryUser = (pushed as { user: { id: string } }).user.id;
      // An invited member holding the mapped role, never pushed by the directory.
      const invitedEmail = `evid-invited-${tag()}@example.test`;
      const invited = await prisma.user.create({ data: { email: invitedEmail, provider: "EMAIL", providerUserId: invitedEmail }, select: { id: true } });
      await prisma.teamMember.create({ data: { teamId: t.workspaceId, userId: invited.id, role: "MEMBER", status: "ACTIVE" } });

      const created = await groups.scimCreateGroup(
        ctx as never,
        { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Staff", externalId: `g-${tag()}`, mappedRole: "MEMBER", members: [{ value: directoryUser }] } as never,
        prisma as never,
      );
      expect(created.ok, JSON.stringify(created)).toBe(true);
      const groupId = (created as { group: { id: string } }).group.id;
      const memberIds = async () => ((await groups.scimReadGroup(ctx as never, groupId, prisma as never))?.members ?? []).map((m) => m.value);

      const listed = await memberIds();
      expect(listed).toContain(directoryUser);
      expect(listed).not.toContain(invited.id);
      expect(listed).not.toContain(t.owner.userId);

      const removed = await groups.scimPatchGroup(
        ctx as never,
        groupId,
        { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "remove", path: "members", value: [{ value: directoryUser }] }] } as never,
        prisma as never,
      );
      expect(removed, JSON.stringify(removed)).toMatchObject({ ok: true });
      expect(await memberIds()).not.toContain(directoryUser);
    });
  });

  // ===========================================================================
  // PRO-T2-12
  // ===========================================================================
  describe("PRO-T2-12: a lapsed Organization removes its verified domain claim", () => {
    async function lapsedOrgWithClaim() {
      await clearRates();
      const o = await enterpriseOrg(1);
      const domain = await fx.verifyOrganizationDomain(deps, o.organizationId, o.owner.userId);
      const row = await prisma.organizationDomain.findFirstOrThrow({ where: { organizationId: o.organizationId, domain } });
      // The plan lapses.
      await prisma.team.updateMany({ where: { organizationId: o.organizationId }, data: { billingStatus: "CANCELED" } as never });
      await prisma.enterpriseContract.updateMany({ where: { organizationId: o.organizationId }, data: { status: "TERMINATED" } as never });
      return { o, row };
    }
    const claim = (id: string) => prisma.organizationDomain.findUnique({ where: { id } });

    it("allowed: the owner removes the claim with a step-up (no plan refusal); without one it is the step-up demand, not a plan refusal", async () => {
      const { o, row } = await lapsedOrgWithClaim();
      const url = `/v1/orgs/${o.organizationId}/domains/${row.id}`;
      const bare = await call("DELETE", url, o.owner.token);
      expect(bare.statusCode, bare.body).toBe(401);
      expect(errorCode(bare)).toBe("STEP_UP_REQUIRED");
      expect(await claim(row.id)).not.toBeNull();

      const stepUp = await ceremony.approvedHeader({
        token: o.owner.token,
        userId: o.owner.userId,
        teamId: o.workspaceId,
        purpose: "ORG_DOMAIN_REMOVE",
        resourceKind: "organization_domain",
        resourceId: row.id,
      });
      const ok = await call("DELETE", url, o.owner.token, undefined, stepUp);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await claim(row.id)).toBeNull();
    });

    it("refused: an Organization member without a domain-write role cannot remove it; the claim stays", async () => {
      const { o, row } = await lapsedOrgWithClaim();
      const member = o.members[0]!;
      const r = await call("DELETE", `/v1/orgs/${o.organizationId}/domains/${row.id}`, member.token);
      expect([403, 404]).toContain(r.statusCode);
      expect(await claim(row.id)).not.toBeNull();
    });

    it("control: adding a new claim on the lapsed Organization is still refused by the plan", async () => {
      const { o } = await lapsedOrgWithClaim();
      const r = await call("POST", `/v1/orgs/${o.organizationId}/domains`, o.owner.token, { domain: `evid-${tag()}.example` });
      expect(r.statusCode, r.body).toBe(402);
    });
  });
});
