/**
 * DOM-13 — SSO AND SCIM BELONG TO THE ORGANIZATION (owner decision
 * 2026-10-25), proven against a real PostgreSQL.
 *
 *   - one configuration per Organization, seen and managed from any of its
 *     Workspaces; one live connection per provider;
 *   - Organization SCIM groups project into one or more Workspaces through the
 *     provisioning authority (membership stays a Workspace fact);
 *   - a directory deactivation ends access in every Workspace of the
 *     Organization, and reactivation restores exactly what it ended;
 *   - suspension and closure/termination end identity access across every
 *     Workspace;
 *   - Organizations are isolated: the same external subject in two
 *     Organizations is two identities, and a group cannot name another
 *     Organization's user;
 *   - only an Organization identity role may change the configuration;
 *   - the forward migration reconciles legacy per-workspace duplicates.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  HERE,
  "../prisma/migrations/20281026000700_organization_scoped_identity/migration.sql",
);

describe("DOM-13 — Organization-scoped SSO and SCIM (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let fixtures: typeof import("./point7/product-fixtures.js");
  let sso: typeof import("../src/services/access-control/sso.service.js");
  let scim: typeof import("../src/services/access-control/scim.service.js");
  let groups: typeof import("../src/services/access-control/scim-groups.service.js");
  let loginPolicy: typeof import("../src/services/access-control/sso-login-policy.service.js");
  let orgLifecycle: typeof import("../src/services/organization/org-lifecycle.service.js");
  let orgClosure: typeof import("../src/services/organization/org-closure.service.js");
  let signJwt: typeof import("../src/services/jwt.js").signJwt;

  const tag = () => randomUUID().slice(0, 8);

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    fixtures = await import("./point7/product-fixtures.js");
    sso = await import("../src/services/access-control/sso.service.js");
    scim = await import("../src/services/access-control/scim.service.js");
    groups = await import("../src/services/access-control/scim-groups.service.js");
    loginPolicy = await import("../src/services/access-control/sso-login-policy.service.js");
    orgLifecycle = await import("../src/services/organization/org-lifecycle.service.js");
    orgClosure = await import("../src/services/organization/org-closure.service.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const deps = () => ({
    prisma: prisma as never,
    tag: `dom13-${tag()}`,
    mintToken: (userId: string, email: string) =>
      signJwt(
        { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
        process.env.AUTH_JWT_SECRET as string,
        3600,
      ),
  });

  /** An Enterprise Organization with two open Workspaces. */
  async function organization() {
    const t = await fixtures.seedOrganizationTenant(deps());
    const w2 = await prisma.team.create({
      data: {
        name: `dom13-w2-${tag()}`,
        ownerUserId: t.owner.userId,
        billingOwnerUserId: t.owner.userId,
        isPersonal: false,
        organizationId: t.organizationId,
        workspaceKind: "ORGANIZATION",
        billingPlan: "ENTERPRISE",
        billingStatus: "ACTIVE",
      },
      select: { id: true },
    });
    await prisma.teamMember.create({ data: { teamId: w2.id, userId: t.owner.userId, role: "OWNER", status: "ACTIVE" } });
    return { orgId: t.organizationId, w1: t.workspaceId, w2: w2.id, owner: t.owner };
  }

  async function directory(o: { orgId: string; w1: string; owner: { userId: string } }) {
    const { projection } = await scim.createScimToken(
      { teamId: o.w1, actorUserId: o.owner.userId, name: `dir-${tag()}`, scopes: ["users.read", "users.write", "users.deactivate", "groups.read", "groups.write"] },
      prisma,
    );
    return { teamId: o.w1, organizationId: o.orgId, tokenId: projection.id, baseUrl: "https://scim.test/v2/scim" };
  }

  async function pushUser(ctx: Awaited<ReturnType<typeof directory>>, externalId: string, email: string) {
    const out = await scim.scimCreateUser(
      ctx,
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: email, externalId, emails: [{ value: email, primary: true }], active: true } as never,
      prisma,
    );
    expect(out.ok, JSON.stringify(out)).toBe(true);
    return (out as { user: { id: string } }).user.id;
  }

  const memberOf = (teamId: string, userId: string) =>
    prisma.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } }, select: { role: true, status: true } });

  // ---------------------------------------------------------------------------

  it("one configuration per Organization: created from one Workspace, listed and managed from the other", async () => {
    const o = await organization();
    const created = await sso.createSsoConnection(
      { teamId: o.w1, provider: "OKTA", displayName: "Okta", issuerUrl: "https://okta.example.test", clientId: "c1", clientSecret: "dom13-secret-value", actorUserId: o.owner.userId } as never,
      prisma,
    );
    const row = await prisma.ssoConnection.findUniqueOrThrow({ where: { id: created.projection.id } });
    expect(row.organizationId).toBe(o.orgId);
    const fromW2 = await sso.listSsoConnections({ teamId: o.w2 }, prisma);
    expect(fromW2.map((c) => c.id)).toContain(created.projection.id);
    const activated = await sso.transitionSsoConnection(
      { teamId: o.w2, id: created.projection.id, nextStatus: "ACTIVE", actorUserId: o.owner.userId },
      prisma,
    );
    expect(activated.status).toBe("ACTIVE");
  });

  it("duplicate-provider prevention: a second live connection for one provider in one Organization is refused", async () => {
    const o = await organization();
    const a = await sso.createSsoConnection(
      { teamId: o.w1, provider: "AZURE_AD", displayName: "Entra A", issuerUrl: "https://login.example.test/a", clientId: "a", clientSecret: "dom13-secret-value", actorUserId: o.owner.userId } as never,
      prisma,
    );
    await sso.transitionSsoConnection({ teamId: o.w1, id: a.projection.id, nextStatus: "ACTIVE", actorUserId: o.owner.userId }, prisma);
    const b = await sso.createSsoConnection(
      { teamId: o.w2, provider: "AZURE_AD", displayName: "Entra B", issuerUrl: "https://login.example.test/b", clientId: "b", clientSecret: "dom13-secret-value", actorUserId: o.owner.userId } as never,
      prisma,
    );
    await expect(
      sso.transitionSsoConnection({ teamId: o.w2, id: b.projection.id, nextStatus: "ACTIVE", actorUserId: o.owner.userId }, prisma),
    ).rejects.toMatchObject({ code: "SSO_CONNECTION_EXISTS" });
    expect(await prisma.ssoConnection.count({ where: { organizationId: o.orgId, provider: "AZURE_AD", status: "ACTIVE" } })).toBe(1);
    // A different Organization may run the same provider.
    const other = await organization();
    const c = await sso.createSsoConnection(
      { teamId: other.w1, provider: "AZURE_AD", displayName: "Entra C", issuerUrl: "https://login.example.test/c", clientId: "c", clientSecret: "dom13-secret-value", actorUserId: other.owner.userId } as never,
      prisma,
    );
    await expect(
      sso.transitionSsoConnection({ teamId: other.w1, id: c.projection.id, nextStatus: "ACTIVE", actorUserId: other.owner.userId }, prisma),
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("group placement: one Organization group projects into two Workspaces with its own role in each", async () => {
    const o = await organization();
    const ctx = await directory(o);
    const u = await pushUser(ctx, `ext-${tag()}`, `dom13-${tag()}@example.test`);
    expect(await memberOf(o.w1, u)).toMatchObject({ status: "ACTIVE", role: "MEMBER" });
    expect(await memberOf(o.w2, u)).toBeNull();

    const created = await groups.scimCreateGroup(
      ctx,
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Reviewers", externalId: `g-${tag()}`, mappedRole: "ADMIN", members: [{ value: u }] } as never,
      prisma,
    );
    expect(created.ok).toBe(true);
    const groupId = (created as { group: { id: string } }).group.id;
    expect(await memberOf(o.w1, u)).toMatchObject({ role: "ADMIN" });

    const added = await groups.addScimGroupProjection(
      { organizationId: o.orgId, groupId, workspaceId: o.w2, mappedRole: "VIEWER", actorUserId: o.owner.userId },
      prisma,
    );
    expect(added.applied).toBe(1);
    expect(await memberOf(o.w2, u)).toMatchObject({ status: "ACTIVE", role: "VIEWER" });
    await expect(
      groups.addScimGroupProjection({ organizationId: o.orgId, groupId, workspaceId: o.w2, mappedRole: "MEMBER", actorUserId: o.owner.userId }, prisma),
    ).rejects.toMatchObject({ reason: "projection_exists" });

    // The group resource lists the member once, across both Workspaces.
    const read = await groups.scimReadGroup(ctx, groupId, prisma);
    expect(read!.members.map((m) => m.value)).toEqual([u]);

    // Removal undoes only what the group granted: ADMIN → MEMBER in W1; the
    // VIEWER in W2 is NOT elevated.
    const removed = await groups.scimPatchGroup(
      ctx,
      groupId,
      { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "remove", path: "members", value: [{ value: u }] }] } as never,
      prisma,
    );
    expect(removed.ok).toBe(true);
    expect(await memberOf(o.w1, u)).toMatchObject({ role: "MEMBER" });
    expect(await memberOf(o.w2, u)).toMatchObject({ role: "VIEWER" });
  });

  it("a directory deactivation ends access in EVERY Workspace of the Organization; reactivation restores exactly that", async () => {
    const o = await organization();
    const ctx = await directory(o);
    const u = await pushUser(ctx, `ext-${tag()}`, `dom13-${tag()}@example.test`);
    const g = await groups.scimCreateGroup(
      ctx,
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Staff", externalId: `g-${tag()}`, mappedRole: "MEMBER", members: [{ value: u }] } as never,
      prisma,
    );
    await groups.addScimGroupProjection(
      { organizationId: o.orgId, groupId: (g as { group: { id: string } }).group.id, workspaceId: o.w2, mappedRole: "MEMBER", actorUserId: o.owner.userId },
      prisma,
    );
    expect(await memberOf(o.w2, u)).toMatchObject({ status: "ACTIVE" });

    await scim.scimDeactivateUser(ctx, u, prisma);
    expect(await memberOf(o.w1, u)).toMatchObject({ status: "SUSPENDED" });
    expect(await memberOf(o.w2, u)).toMatchObject({ status: "SUSPENDED" });
    // The owner of both Workspaces is untouched by a directory push.
    expect(await memberOf(o.w2, o.owner.userId)).toMatchObject({ status: "ACTIVE", role: "OWNER" });

    // An administrator's own suspension elsewhere is not undone by the directory.
    const w3 = await prisma.team.create({
      data: { name: `dom13-w3-${tag()}`, ownerUserId: o.owner.userId, isPersonal: false, organizationId: o.orgId, workspaceKind: "ORGANIZATION", billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" },
      select: { id: true },
    });
    await prisma.teamMember.create({ data: { teamId: w3.id, userId: u, role: "MEMBER", status: "SUSPENDED", suspensionReason: "admin decision" } });

    await scim.scimReactivateUser(ctx, u, prisma);
    expect(await memberOf(o.w1, u)).toMatchObject({ status: "ACTIVE" });
    expect(await memberOf(o.w2, u)).toMatchObject({ status: "ACTIVE" });
    expect(await memberOf(w3.id, u)).toMatchObject({ status: "SUSPENDED" });
  });

  it("cross-organization isolation: the same external subject is two identities; a group cannot name another Organization's user", async () => {
    const a = await organization();
    const b = await organization();
    const ctxA = await directory(a);
    const ctxB = await directory(b);
    const subject = `shared-${tag()}`;
    const ua = await pushUser(ctxA, subject, `a-${tag()}@example.test`);
    const ub = await pushUser(ctxB, subject, `b-${tag()}@example.test`);
    expect(ua).not.toBe(ub);
    expect(await prisma.externalIdentityMapping.count({ where: { provider: "GENERIC_SCIM", externalSubjectId: subject } })).toBe(2);

    const gB = await groups.scimCreateGroup(
      ctxB,
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "B", externalId: `g-${tag()}`, mappedRole: "MEMBER" } as never,
      prisma,
    );
    const patched = await groups.scimPatchGroup(
      ctxB,
      (gB as { group: { id: string } }).group.id,
      { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "add", path: "members", value: [{ value: ua }] }] } as never,
      prisma,
    );
    expect(patched).toMatchObject({ ok: false, status: 409, detail: "group_member_unresolved" });
    expect(await memberOf(b.w1, ua)).toBeNull();
    // B's credential cannot read A's group, and a projection into A's workspace is refused.
    const gA = await groups.scimCreateGroup(
      ctxA,
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "A", externalId: `g-${tag()}`, mappedRole: "MEMBER" } as never,
      prisma,
    );
    expect(await groups.scimReadGroup(ctxB, (gA as { group: { id: string } }).group.id, prisma)).toBeNull();
    await expect(
      groups.addScimGroupProjection(
        { organizationId: b.orgId, groupId: (gB as { group: { id: string } }).group.id, workspaceId: a.w1, mappedRole: "MEMBER", actorUserId: b.owner.userId },
        prisma,
      ),
    ).rejects.toMatchObject({ reason: "workspace_not_in_organization" });
  });

  it("a manual link is checked within the Organization: another Organization holding the same subject neither blocks nor is revealed", async () => {
    const { linkExternalIdentity } = await import("../src/services/identity/external-identity.service.js");
    const a = await organization();
    const b = await organization();
    const person = async (teamId: string) => {
      const email = `link-${tag()}@example.test`;
      const u = await prisma.user.create({ data: { email, provider: "EMAIL", providerUserId: email }, select: { id: true } });
      await prisma.teamMember.create({ data: { teamId, userId: u.id, role: "MEMBER", status: "ACTIVE" } });
      return u.id;
    };
    const subject = `okta|${tag()}`;
    const ub = await person(b.w1);
    await linkExternalIdentity({ teamId: b.w1, userId: ub, provider: "OKTA", externalSubjectId: subject, actorUserId: b.owner.userId }, prisma);
    const ua = await person(a.w1);
    const linked = await linkExternalIdentity({ teamId: a.w1, userId: ua, provider: "OKTA", externalSubjectId: subject, actorUserId: a.owner.userId }, prisma);
    expect(linked.organizationId).toBe(a.orgId);
    // Within one Organization the subject is still one person.
    const ua2 = await person(a.w2);
    await expect(
      linkExternalIdentity({ teamId: a.w2, userId: ua2, provider: "OKTA", externalSubjectId: subject, actorUserId: a.owner.userId }, prisma),
    ).rejects.toMatchObject({ code: "external_subject_already_mapped" });
  });

  it("suspension disables identity across every Workspace, and resume restores exactly it", async () => {
    const o = await organization();
    const conn = await sso.createSsoConnection(
      { teamId: o.w2, provider: "OKTA", displayName: "Okta", issuerUrl: "https://okta.example.test", clientId: "c", clientSecret: "dom13-secret-value", actorUserId: o.owner.userId } as never,
      prisma,
    );
    await sso.transitionSsoConnection({ teamId: o.w2, id: conn.projection.id, nextStatus: "ACTIVE", actorUserId: o.owner.userId }, prisma);
    const raw = await scim.createScimToken(
      { teamId: o.w1, actorUserId: o.owner.userId, name: "dir", scopes: ["users.read"] },
      prisma,
    );
    const authorization = `Bearer ${raw.tokenOnce}`;
    expect((await scim.authenticateScimRequest({ authorizationHeader: authorization, remoteIp: null }, prisma)).ok).toBe(true);

    await orgLifecycle.suspendOrganization({ organizationId: o.orgId, actorUserId: o.owner.userId, reason: "dom13" });
    expect((await prisma.ssoConnection.findUniqueOrThrow({ where: { id: conn.projection.id } })).status).toBe("SUSPENDED");
    expect(await scim.authenticateScimRequest({ authorizationHeader: authorization, remoteIp: null }, prisma)).toMatchObject({ ok: false });
    for (const teamId of [o.w1, o.w2]) {
      expect(await loginPolicy.enforceSsoLoginPolicy({ teamId, email: "", restrictToVerifiedDomains: false }, prisma)).toMatchObject({
        ok: false,
        reason: "sso_organization_inactive",
      });
    }
    // An administrator cannot re-arm a suspended connection.
    await expect(
      sso.transitionSsoConnection({ teamId: o.w1, id: conn.projection.id, nextStatus: "ACTIVE", actorUserId: o.owner.userId }, prisma),
    ).rejects.toMatchObject({ code: "SSO_INVALID_TRANSITION" });

    await orgLifecycle.resumeOrganization({ organizationId: o.orgId, actorUserId: o.owner.userId });
    expect((await prisma.ssoConnection.findUniqueOrThrow({ where: { id: conn.projection.id } })).status).toBe("ACTIVE");
    expect((await scim.authenticateScimRequest({ authorizationHeader: authorization, remoteIp: null }, prisma)).ok).toBe(true);
  });

  it("termination ends identity across every Workspace: connections and credentials revoked, groups archived, links unlinked", async () => {
    const o = await organization();
    const ctx = await directory(o);
    const u = await pushUser(ctx, `ext-${tag()}`, `dom13-${tag()}@example.test`);
    const g = await groups.scimCreateGroup(
      ctx,
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "All", externalId: `g-${tag()}`, mappedRole: "MEMBER", members: [{ value: u }] } as never,
      prisma,
    );
    const conn = await sso.createSsoConnection(
      { teamId: o.w2, provider: "OKTA", displayName: "Okta", issuerUrl: "https://okta.example.test", clientId: "c", clientSecret: "dom13-secret-value", actorUserId: o.owner.userId } as never,
      prisma,
    );
    await sso.transitionSsoConnection({ teamId: o.w2, id: conn.projection.id, nextStatus: "ACTIVE", actorUserId: o.owner.userId }, prisma);

    await orgClosure.executeOrganizationClosure({ organizationId: o.orgId, requestedByUserId: o.owner.userId, terminateContract: true });

    const c = await prisma.ssoConnection.findUniqueOrThrow({ where: { id: conn.projection.id } });
    expect(c).toMatchObject({ status: "REVOKED", revokedReason: "ORGANIZATION_TERMINATED" });
    expect(await prisma.scimProvisioningToken.count({ where: { organizationId: o.orgId, status: { not: "REVOKED" } } })).toBe(0);
    expect((await prisma.scimGroup.findUniqueOrThrow({ where: { id: (g as { group: { id: string } }).group.id } })).status).toBe("ARCHIVED");
    expect(await prisma.scimGroupWorkspaceProjection.count({ where: { organizationId: o.orgId, status: "ACTIVE" } })).toBe(0);
    expect(await prisma.externalIdentityMapping.count({ where: { organizationId: o.orgId, unlinkedAtUtc: null } })).toBe(0);
    for (const teamId of [o.w1, o.w2]) {
      expect(await loginPolicy.enforceSsoLoginPolicy({ teamId, email: "", restrictToVerifiedDomains: false }, prisma)).toMatchObject({
        ok: false,
        reason: "sso_organization_inactive",
      });
    }
    expect(
      await prisma.organizationAuditEvent.count({ where: { organizationId: o.orgId, eventType: "ORG_IDENTITY_ENDED" } }),
    ).toBe(1);
  });

  it("only an Organization identity role changes the configuration — a Workspace admin alone is refused", async () => {
    const o = await organization();
    const email = `wsadmin-${tag()}@example.test`;
    const admin = await prisma.user.create({ data: { email, provider: "EMAIL", providerUserId: email }, select: { id: true } });
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: admin.id, policyKey, policyVersion: policyVersion as string, source: "integration-harness",
      })),
    });
    await prisma.teamMember.create({ data: { teamId: o.w2, userId: admin.id, role: "ADMIN", status: "ACTIVE" } });
    await prisma.organizationMembership.create({ data: { organizationId: o.orgId, userId: admin.id, role: "ORG_MEMBER" } });
    const token = deps().mintToken(admin.id, email);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/admin/identity/providers",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { teamId: o.w2, provider: "OKTA", displayName: "Rogue", issuerUrl: "https://okta.example.test", clientId: "x", clientSecret: "dom13-secret-value" },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain("ORGANIZATION_IDENTITY_ADMIN_REQUIRED");
    expect(await prisma.ssoConnection.count({ where: { organizationId: o.orgId } })).toBe(0);

    // Promoted to ORG_SECURITY_ADMIN, the same request passes the authority
    // gate and stops at step-up (a sensitive change still needs a fresh factor).
    await prisma.organizationMembership.updateMany({ where: { organizationId: o.orgId, userId: admin.id }, data: { role: "ORG_SECURITY_ADMIN" } });
    const again = await h.app.inject({
      method: "POST",
      url: "/v1/admin/identity/providers",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { teamId: o.w2, provider: "OKTA", displayName: "Okta", issuerUrl: "https://okta.example.test", clientId: "x", clientSecret: "dom13-secret-value" },
    });
    expect(again.body).not.toContain("ORGANIZATION_IDENTITY_ADMIN_REQUIRED");
    expect(again.statusCode).toBe(401);
    expect(again.body).toContain("STEP_UP_REQUIRED");
  });

  it("the forward migration reconciles legacy per-workspace duplicates and is idempotent", async () => {
    const o = await organization();
    const pool = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await pool.connect();
    try {
      // Recreate the pre-migration world: no Organization-level keys.
      await pool.query(`DROP INDEX IF EXISTS "sso_connections_org_provider_live_uk"`);
      await pool.query(`DROP INDEX IF EXISTS "scim_groups_org_external_id_live_uk"`);
      const older = await prisma.ssoConnection.create({
        data: { teamId: o.w1, organizationId: o.orgId, provider: "GOOGLE_WORKSPACE", displayName: "G1", status: "ACTIVE", createdByUserId: o.owner.userId, allowedEmailDomains: [], createdAt: new Date(Date.now() - 60_000) },
      });
      const newer = await prisma.ssoConnection.create({
        data: { teamId: o.w2, organizationId: o.orgId, provider: "GOOGLE_WORKSPACE", displayName: "G2", status: "ACTIVE", createdByUserId: o.owner.userId, allowedEmailDomains: [] },
      });
      const externalId = `legacy-${tag()}`;
      const g1 = await prisma.scimGroup.create({
        data: { teamId: o.w1, organizationId: o.orgId, displayName: "Legacy", externalId, mappedRole: "ADMIN", status: "ACTIVE", createdAt: new Date(Date.now() - 60_000) },
      });
      const g2 = await prisma.scimGroup.create({
        data: { teamId: o.w2, organizationId: o.orgId, displayName: "Legacy", externalId, mappedRole: "VIEWER", status: "ACTIVE" },
      });

      const sql = readFileSync(MIGRATION, "utf8");
      await pool.query(sql);

      expect((await prisma.ssoConnection.findUniqueOrThrow({ where: { id: older.id } })).status).toBe("ACTIVE");
      expect(await prisma.ssoConnection.findUniqueOrThrow({ where: { id: newer.id } })).toMatchObject({
        status: "DISABLED",
        revokedReason: "DUPLICATE_PROVIDER_IN_ORGANIZATION",
      });
      expect((await prisma.scimGroup.findUniqueOrThrow({ where: { id: g1.id } })).status).toBe("ACTIVE");
      expect((await prisma.scimGroup.findUniqueOrThrow({ where: { id: g2.id } })).status).toBe("ARCHIVED");
      const projections = await prisma.scimGroupWorkspaceProjection.findMany({
        where: { scimGroupId: g1.id, status: "ACTIVE" },
        select: { workspaceId: true, mappedRole: true },
        orderBy: { createdAt: "asc" },
      });
      expect(projections).toEqual(
        expect.arrayContaining([
          { workspaceId: o.w1, mappedRole: "ADMIN" },
          { workspaceId: o.w2, mappedRole: "VIEWER" },
        ]),
      );
      expect(projections).toHaveLength(2);

      // Idempotent.
      const before = await prisma.scimGroupWorkspaceProjection.count({ where: { organizationId: o.orgId } });
      await pool.query(sql);
      expect(await prisma.scimGroupWorkspaceProjection.count({ where: { organizationId: o.orgId } })).toBe(before);
      const keys = await pool.query(
        `SELECT indexname FROM pg_indexes WHERE indexname IN ('sso_connections_org_provider_live_uk','scim_groups_org_external_id_live_uk','external_identity_mappings_org_provider_subject_uk')`,
      );
      expect(keys.rowCount).toBe(3);
    } finally {
      await pool.end();
    }
  });
});
