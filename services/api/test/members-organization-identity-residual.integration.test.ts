/**
 * Members re-audit — the residual DOM-13 defects, proven against a real
 * PostgreSQL:
 *
 *   N-5 / DOM-13  the per-workspace identity readers are Organization-scoped
 *                 (drift, managed-membership projection, identity-link list
 *                 and unlink, the SSO outage probe) while membership stays
 *                 Workspace-scoped — seen from a SIBLING workspace, and never
 *                 across Organizations;
 *   N-4           an archived, merged duplicate SCIM group keeps answering for
 *                 its survivor, so the sibling directory's PATCH / remove still
 *                 deprovisions (and a DELETE ends only its own workspace's reach);
 *   D-12          Organization identity rows (SCIM credential, identity link,
 *                 SSO connection, SSO callback attempt, SCIM group) refuse a raw
 *                 DELETE of the workspace they were configured from.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const migration = (name: string) => path.resolve(HERE, `../prisma/migrations/${name}/migration.sql`);
const ORG_IDENTITY = migration("20281026000700_organization_scoped_identity");
const MERGED_INTO = migration("20281026001200_scim_group_merged_into");
const OUTLIVE = migration("20281026001300_identity_rows_outlive_workspace");

describe("DOM-13 residual — Organization-scoped readers, merged groups, rows that outlive a workspace (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let conn: pg.Client;
  let fixtures: typeof import("./point7/product-fixtures.js");
  let scim: typeof import("../src/services/access-control/scim.service.js");
  let groups: typeof import("../src/services/access-control/scim-groups.service.js");
  let reconciliation: typeof import("../src/services/access-control/scim-reconciliation.service.js");
  let identity: typeof import("../src/services/identity/external-identity.service.js");
  let probes: typeof import("../src/services/operations/operations-source-probes.js");
  let signJwt: typeof import("../src/services/jwt.js").signJwt;

  const tag = () => randomUUID().slice(0, 8);

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    fixtures = await import("./point7/product-fixtures.js");
    scim = await import("../src/services/access-control/scim.service.js");
    groups = await import("../src/services/access-control/scim-groups.service.js");
    reconciliation = await import("../src/services/access-control/scim-reconciliation.service.js");
    identity = await import("../src/services/identity/external-identity.service.js");
    probes = await import("../src/services/operations/operations-source-probes.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
    conn = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await conn.connect();
  }, 900_000);

  afterAll(async () => {
    await conn?.end();
    await h?.cleanup();
  }, 300_000);

  const deps = () => ({
    prisma: prisma as never,
    tag: `dom13r-${tag()}`,
    mintToken: (userId: string, email: string) =>
      signJwt(
        { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
        process.env.AUTH_JWT_SECRET as string,
        3600,
      ),
  });

  async function workspace(orgId: string, ownerUserId: string, withOwner = true) {
    const w = await prisma.team.create({
      data: {
        name: `dom13r-w-${tag()}`,
        ownerUserId,
        billingOwnerUserId: ownerUserId,
        isPersonal: false,
        organizationId: orgId,
        workspaceKind: "ORGANIZATION",
        billingPlan: "ENTERPRISE",
        billingStatus: "ACTIVE",
      },
      select: { id: true },
    });
    if (withOwner) await prisma.teamMember.create({ data: { teamId: w.id, userId: ownerUserId, role: "OWNER", status: "ACTIVE" } });
    return w.id;
  }

  /** An Enterprise Organization with two open Workspaces. */
  async function organization() {
    const t = await fixtures.seedOrganizationTenant(deps());
    const w2 = await workspace(t.organizationId, t.owner.userId);
    return { orgId: t.organizationId, w1: t.workspaceId, w2, owner: t.owner };
  }

  async function directory(o: { orgId: string; owner: { userId: string } }, teamId: string) {
    const { projection } = await scim.createScimToken(
      { teamId, actorUserId: o.owner.userId, name: `dir-${tag()}`, scopes: ["users.read", "users.write", "users.deactivate", "groups.read", "groups.write"] },
      prisma,
    );
    return { teamId, organizationId: o.orgId, tokenId: projection.id, baseUrl: "https://scim.test/v2/scim" };
  }

  async function pushUser(ctx: Awaited<ReturnType<typeof directory>>, externalId: string) {
    const email = `dom13r-${tag()}@example.test`;
    const out = await scim.scimCreateUser(
      ctx,
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: email, externalId, emails: [{ value: email, primary: true }], active: true } as never,
      prisma,
    );
    expect(out.ok, JSON.stringify(out)).toBe(true);
    return (out as { user: { id: string } }).user.id;
  }

  async function plainMember(teamId: string, role: "ADMIN" | "MEMBER" = "MEMBER") {
    const email = `dom13r-plain-${tag()}@example.test`;
    const u = await prisma.user.create({ data: { email, provider: "EMAIL", providerUserId: email }, select: { id: true } });
    await prisma.teamMember.create({ data: { teamId, userId: u.id, role, status: "ACTIVE" } });
    return u.id;
  }

  const memberOf = (teamId: string, userId: string) =>
    prisma.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } }, select: { role: true, status: true } });

  /** A directory-provisioned user who also holds a membership in the sibling workspace. */
  async function directoryUserInSibling(o: Awaited<ReturnType<typeof organization>>) {
    const ctx = await directory(o, o.w1);
    const u = await pushUser(ctx, `ext-${tag()}`);
    const g = await groups.scimCreateGroup(
      ctx,
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Staff", externalId: `g-${tag()}`, mappedRole: "MEMBER", members: [{ value: u }] } as never,
      prisma,
    );
    await groups.addScimGroupProjection(
      { organizationId: o.orgId, groupId: (g as { group: { id: string } }).group.id, workspaceId: o.w2, mappedRole: "ADMIN", actorUserId: o.owner.userId },
      prisma,
    );
    expect(await memberOf(o.w2, u)).toMatchObject({ status: "ACTIVE", role: "ADMIN" });
    return { ctx, u };
  }

  // ---------------------------------------------------------------------------
  // N-5 / DOM-13 — readers
  // ---------------------------------------------------------------------------

  it("drift from a sibling workspace: a directory-provisioned member is not an orphan; a manual one is; an unlinked identity is seen; another Organization sees none of it", async () => {
    const o = await organization();
    const other = await organization();
    const { u } = await directoryUserInSibling(o);
    const manual = await plainMember(o.w2, "ADMIN");

    const drift = await reconciliation.detectScimDrift({ teamId: o.w2, actorUserId: o.owner.userId }, prisma);
    const orphans = drift.items.filter((i) => i.category === "ORPHAN_LOCAL_MEMBERSHIP").map((i) => i.subject.id);
    expect(orphans).not.toContain(u);
    expect(orphans).toContain(manual); // positive control

    // The directory unlinks the identity (mapping configured from w1) while the
    // person still holds an active membership in w2.
    await prisma.externalIdentityMapping.updateMany({ where: { organizationId: o.orgId, userId: u }, data: { unlinkedAtUtc: new Date() } });
    const after = await reconciliation.detectScimDrift({ teamId: o.w2, actorUserId: o.owner.userId }, prisma);
    expect(after.items.some((i) => i.category === "UNLINKED_IDENTITY_ACTIVE_USER" && i.subject.id === u)).toBe(true);

    const foreign = await reconciliation.detectScimDrift({ teamId: other.w1, actorUserId: other.owner.userId }, prisma);
    expect(foreign.items.some((i) => i.subject.id === u)).toBe(false);
  });

  it("managed-membership projection from a sibling workspace lists the directory-managed member; another Organization does not", async () => {
    const o = await organization();
    const other = await organization();
    const { u } = await directoryUserInSibling(o);
    const fromW2 = await scim.projectScimManagedMembership({ teamId: o.w2 }, prisma);
    const row = fromW2.members.find((m) => m.userId === u);
    expect(row).toMatchObject({ directoryLink: "LINKED", membershipStatus: "ACTIVE", role: "ADMIN" });
    const foreign = await scim.projectScimManagedMembership({ teamId: other.w1 }, prisma);
    expect(foreign.members.some((m) => m.userId === u)).toBe(false);
  });

  it("identity links: listed and unlinked from a sibling workspace for its own members; refused for a non-member and across Organizations", async () => {
    const o = await organization();
    const other = await organization();
    const person = await plainMember(o.w1);
    await prisma.teamMember.create({ data: { teamId: o.w2, userId: person, role: "MEMBER", status: "ACTIVE" } });
    const outsider = await plainMember(o.w1); // in w1 only
    const link = await identity.linkExternalIdentity(
      { teamId: o.w1, userId: person, provider: "OKTA", externalSubjectId: `okta|${tag()}`, actorUserId: o.owner.userId },
      prisma,
    );
    const outsiderLink = await identity.linkExternalIdentity(
      { teamId: o.w1, userId: outsider, provider: "OKTA", externalSubjectId: `okta|${tag()}`, actorUserId: o.owner.userId },
      prisma,
    );

    const listed = await identity.listExternalIdentityMappings({ teamId: o.w2, activeOnly: true }, prisma);
    expect(listed.map((m) => m.id)).toContain(link.id);
    expect(listed.map((m) => m.id)).not.toContain(outsiderLink.id);
    expect((await identity.listExternalIdentityMappings({ teamId: other.w1 }, prisma)).map((m) => m.id)).not.toContain(link.id);

    await expect(
      identity.unlinkExternalIdentity({ teamId: other.w1, mappingId: link.id, actorUserId: other.owner.userId }, prisma),
    ).rejects.toMatchObject({ code: "mapping_not_found" });
    await expect(
      identity.unlinkExternalIdentity({ teamId: o.w2, mappingId: outsiderLink.id, actorUserId: o.owner.userId }, prisma),
    ).rejects.toMatchObject({ code: "mapping_not_found" });
    const unlinked = await identity.unlinkExternalIdentity({ teamId: o.w2, mappingId: link.id, actorUserId: o.owner.userId }, prisma);
    expect(unlinked.unlinkedAtUtc).not.toBeNull();
  });

  it("the SSO outage probe answers from a sibling workspace, and never across Organizations", async () => {
    const o = await organization();
    const other = await organization();
    const conn1 = await prisma.ssoConnection.create({
      data: {
        teamId: o.w1,
        organizationId: o.orgId,
        provider: "OKTA",
        displayName: "Okta",
        status: "ACTIVE",
        createdByUserId: o.owner.userId,
        allowedEmailDomains: [],
        outageDetectedAtUtc: new Date(),
      } as never,
      select: { id: true },
    });
    const observe = async (teamId: string) =>
      probes.probeSource(
        "identity.idp_outage_state",
        await probes.buildProbeContext({ teamId, fingerprint: `idp_outage:${conn1.id}`, client: prisma, evidenceWhere: {}, outputEntitledWhere: null }),
      );
    expect((await observe(o.w1)).activity).toBe("ACTIVE");
    expect((await observe(o.w2)).activity).toBe("ACTIVE");
    expect((await observe(other.w1)).activity).toBe("NOT_APPLICABLE");
    await prisma.ssoConnection.update({ where: { id: conn1.id }, data: { outageDetectedAtUtc: null } });
    expect((await observe(o.w2)).activity).toBe("RECOVERED");
  });

  // ---------------------------------------------------------------------------
  // N-4 — a merged duplicate group keeps answering for its survivor
  // ---------------------------------------------------------------------------

  it("N-4: after the merge, the sibling directory's PATCH remove through the archived id still deprovisions; DELETE ends only its own workspace's reach", async () => {
    const o = await organization();
    const other = await organization();
    const ctx1 = await directory(o, o.w1);
    const ctx2 = await directory(o, o.w2); // the sibling workspace's own directory app
    const u = await pushUser(ctx1, `ext-${tag()}`);
    const externalId = `legacy-${tag()}`;

    // The pre-merge world: each workspace's directory created the same IdP
    // group; w2's granted u ADMIN there (provenance recorded under w2's group).
    await conn.query(`DROP INDEX IF EXISTS "scim_groups_org_external_id_live_uk"`);
    const g1 = await prisma.scimGroup.create({
      data: { teamId: o.w1, organizationId: o.orgId, displayName: "Legacy", externalId, mappedRole: "ADMIN", status: "ACTIVE", createdAt: new Date(Date.now() - 60_000) },
    });
    const g2 = await prisma.scimGroup.create({
      data: { teamId: o.w2, organizationId: o.orgId, displayName: "Legacy", externalId, mappedRole: "ADMIN", status: "ACTIVE" },
    });
    const m2 = await prisma.teamMember.create({ data: { teamId: o.w2, userId: u, role: "ADMIN", status: "ACTIVE" } });
    await prisma.membershipGrant.create({
      data: { teamMemberId: m2.id, source: "IDP_GROUP", intent: "GROUP_MAPPING", externalRef: `scim-group:${g2.id}`, grantedRole: "ADMIN" } as never,
    });
    // A group w2's directory DELETED before the merge (and a live one of the
    // same external id elsewhere): it must NOT become an alias.
    const deletedExternalId = `deleted-${tag()}`;
    const deleted = await prisma.scimGroup.create({
      data: { teamId: o.w2, organizationId: o.orgId, displayName: "Gone", externalId: deletedExternalId, mappedRole: "MEMBER", status: "ARCHIVED", createdAt: new Date(Date.now() - 120_000) },
    });
    await prisma.scimGroup.create({
      data: { teamId: o.w1, organizationId: o.orgId, displayName: "Gone", externalId: deletedExternalId, mappedRole: "MEMBER", status: "ACTIVE" },
    });

    await conn.query(readFileSync(ORG_IDENTITY, "utf8")); // the merge, as released
    expect((await prisma.scimGroup.findUniqueOrThrow({ where: { id: g2.id } })).status).toBe("ARCHIVED");
    await conn.query(readFileSync(MERGED_INTO, "utf8"));
    await conn.query(readFileSync(MERGED_INTO, "utf8")); // idempotent
    expect((await prisma.scimGroup.findUniqueOrThrow({ where: { id: g2.id } })).mergedIntoGroupId).toBe(g1.id);
    expect((await prisma.scimGroup.findUniqueOrThrow({ where: { id: g1.id } })).mergedIntoGroupId).toBeNull();
    expect((await prisma.scimGroup.findUniqueOrThrow({ where: { id: deleted.id } })).mergedIntoGroupId).toBeNull();

    // Read through the archived id: answered by the survivor, under the id asked for.
    const read = await groups.scimReadGroup(ctx2, g2.id, prisma);
    expect(read).toMatchObject({ id: g2.id, externalId });
    // Another Organization's credential cannot reach it.
    const ctxOther = await directory(other, other.w1);
    expect(await groups.scimReadGroup(ctxOther, g2.id, prisma)).toBeNull();
    expect(
      await groups.scimPatchGroup(
        ctxOther,
        g2.id,
        { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "remove", path: "members", value: [{ value: u }] }] } as never,
        prisma,
      ),
    ).toMatchObject({ ok: false, status: 404 });

    // The deprovisioning path: remove u through the archived id.
    const removed = await groups.scimPatchGroup(
      ctx2,
      g2.id,
      { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "remove", path: "members", value: [{ value: u }] }] } as never,
      prisma,
    );
    expect(removed, JSON.stringify(removed)).toMatchObject({ ok: true });
    expect(await memberOf(o.w2, u)).toMatchObject({ status: "ACTIVE", role: "MEMBER" });

    // A deleted (never merged) group stays deleted.
    expect(
      await groups.scimPatchGroup(
        ctx2,
        deleted.id,
        { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "remove", path: "members", value: [{ value: u }] }] } as never,
        prisma,
      ),
    ).toMatchObject({ ok: false, status: 404, detail: "group_not_found" });

    // DELETE through the archived id ends the survivor's reach into w2 only.
    expect(await groups.scimDeleteGroup(ctx2, g2.id, prisma)).toEqual({ ok: true });
    expect((await prisma.scimGroup.findUniqueOrThrow({ where: { id: g1.id } })).status).toBe("ACTIVE");
    const reach = await prisma.scimGroupWorkspaceProjection.findMany({
      where: { scimGroupId: g1.id },
      select: { workspaceId: true, status: true },
    });
    expect(reach).toEqual(
      expect.arrayContaining([
        { workspaceId: o.w1, status: "ACTIVE" },
        { workspaceId: o.w2, status: "ARCHIVED" },
      ]),
    );
  });

  // ---------------------------------------------------------------------------
  // D-12 — Organization identity rows outlive the workspace they came from
  // ---------------------------------------------------------------------------

  it("D-12: a raw DELETE of the workspace a credential, identity link, SSO connection, callback attempt or SCIM group was configured from is refused, and the row remains", async () => {
    // The released state: each of these cascaded with the workspace. Recreate
    // it, then run the forward migration file whole (twice: idempotent).
    for (const tbl of ["scim_provisioning_tokens", "external_identity_mappings", "sso_callback_attempts", "sso_connections"]) {
      await conn.query(`ALTER TABLE "${tbl}" DROP CONSTRAINT IF EXISTS "${tbl}_team_id_fkey"`);
      await conn.query(
        `ALTER TABLE "${tbl}" ADD CONSTRAINT "${tbl}_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      );
    }
    await conn.query(readFileSync(OUTLIVE, "utf8"));
    await conn.query(readFileSync(OUTLIVE, "utf8")); // idempotent
    const rules = await conn.query(
      `SELECT conname, confdeltype::text AS rule FROM pg_constraint
        WHERE conname IN ('scim_provisioning_tokens_team_id_fkey','external_identity_mappings_team_id_fkey',
                          'sso_callback_attempts_team_id_fkey','sso_connections_team_id_fkey','scim_groups_team_id_fkey')
        ORDER BY conname`,
    );
    expect(rules.rows.map((r) => `${r.conname}=${r.rule}`)).toEqual([
      "external_identity_mappings_team_id_fkey=r",
      "scim_groups_team_id_fkey=r",
      "scim_provisioning_tokens_team_id_fkey=r",
      "sso_callback_attempts_team_id_fkey=r",
      "sso_connections_team_id_fkey=r",
    ]);

    const o = await organization();
    const host = await workspace(o.orgId, o.owner.userId); // holds the connection the attempt refers to
    const bare = () => workspace(o.orgId, o.owner.userId, false);
    const deleteWorkspace = (id: string) => conn.query(`DELETE FROM "teams" WHERE id = $1::uuid`, [id]);

    // Positive control: a workspace carrying none of these rows is deleted.
    const control = await bare();
    await deleteWorkspace(control);
    expect(await prisma.team.findUnique({ where: { id: control } })).toBeNull();

    const seeds: Array<[string, (teamId: string) => Promise<() => Promise<unknown>>]> = [
      [
        "scim_provisioning_tokens",
        async (teamId) => {
          const { projection } = await scim.createScimToken({ teamId, actorUserId: o.owner.userId, name: `t-${tag()}`, scopes: ["users.read"] }, prisma);
          return () => prisma.scimProvisioningToken.findUnique({ where: { id: projection.id } });
        },
      ],
      [
        "external_identity_mappings",
        async (teamId) => {
          const row = await prisma.externalIdentityMapping.create({
            data: { teamId, organizationId: o.orgId, userId: o.owner.userId, provider: "OKTA", externalSubjectId: `okta|${tag()}` },
          });
          return () => prisma.externalIdentityMapping.findUnique({ where: { id: row.id } });
        },
      ],
      [
        "sso_connections",
        async (teamId) => {
          const row = await prisma.ssoConnection.create({
            data: { teamId, organizationId: o.orgId, provider: "GENERIC_OIDC", displayName: "OIDC", status: "DISABLED", createdByUserId: o.owner.userId, allowedEmailDomains: [] } as never,
            select: { id: true },
          });
          return () => prisma.ssoConnection.findUnique({ where: { id: row.id } });
        },
      ],
      [
        "sso_callback_attempts",
        async (teamId) => {
          const connection = await prisma.ssoConnection.create({
            data: { teamId: host, organizationId: o.orgId, provider: "GENERIC_SAML", displayName: "SAML", status: "DISABLED", createdByUserId: o.owner.userId, allowedEmailDomains: [] } as never,
            select: { id: true },
          });
          const row = await prisma.ssoCallbackAttempt.create({
            data: {
              teamId,
              organizationId: o.orgId,
              ssoConnectionId: connection.id,
              stateHash: randomUUID().replace(/-/g, ""),
              nonceHash: randomUUID().replace(/-/g, ""),
              expiresAtUtc: new Date(Date.now() + 600_000),
            },
          });
          return () => prisma.ssoCallbackAttempt.findUnique({ where: { id: row.id } });
        },
      ],
      [
        "scim_groups",
        async (teamId) => {
          const row = await prisma.scimGroup.create({
            data: { teamId, organizationId: o.orgId, displayName: `G-${tag()}`, externalId: `g-${tag()}`, mappedRole: "MEMBER", status: "ARCHIVED" },
          });
          return () => prisma.scimGroup.findUnique({ where: { id: row.id } });
        },
      ],
    ];
    for (const [table, seed] of seeds) {
      const w = await bare();
      const stillThere = await seed(w);
      await expect(deleteWorkspace(w), table).rejects.toMatchObject({ code: "23503" });
      expect(await stillThere(), table).not.toBeNull();
      expect(await prisma.team.findUnique({ where: { id: w } }), table).not.toBeNull();
    }
  });
});
