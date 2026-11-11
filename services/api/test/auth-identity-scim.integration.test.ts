/**
 * Round 3, batch auth-identity — the SCIM directory's reach, through the real
 * /v2/scim routes against a disposable PostgreSQL 16.
 *
 *   PRO-012 (AUTH-06)  writes sent as application/scim+json are accepted
 *   PRO-013 (AUTH-07)  active=true does not undo an administrator's suspension
 *   PRO-014 (AUTH-08)  deactivation reaches only people the directory manages
 *   PRO-030 (AUTH-24)  groups name only directory people; a lowered mapping lowers its grant
 *   IDENT-013          a directory creates accounts only in a domain its Organization proved
 *
 * Every refusal sits next to its authorized control, and the durable rows
 * (users, memberships, sessions) are re-read.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, OrganizationTenant } from "./point7/product-fixtures.js";

type Json = Record<string, unknown>;

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const SCIM_JSON = "application/scim+json";

describe("auth-identity remediation — SCIM directory reach (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let jwt: typeof import("../src/services/jwt.js");
  let fx: typeof import("./point7/product-fixtures.js");
  let scim: typeof import("../src/services/access-control/scim.service.js");
  let deps: FixtureDeps;

  let org: OrganizationTenant;
  let domain: string;
  let token: string;

  const scimCall = (method: string, url: string, payload?: unknown, contentType = SCIM_JSON) =>
    harness.app.inject({
      method: method as never,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": contentType } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  const me = (t: string) =>
    harness.app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${t}` } });
  const member = (userId: string) =>
    prisma.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: org.workspaceId, userId } } });

  /** A directory person, provisioned the way an IdP does it. */
  async function directoryUser(label: string): Promise<{ id: string; email: string; token: string }> {
    const email = `${label}-${randomUUID().slice(0, 6)}@${domain}`;
    const res = await scimCall("POST", "/v2/scim/Users", {
      schemas: [USER],
      userName: email,
      externalId: `ext-${randomUUID()}`,
      emails: [{ value: email, primary: true }],
      active: true,
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = (JSON.parse(res.body) as Json).id as string;
    const t = deps.mintToken(id, email);
    await fx.registerSessionForToken(deps, id, t, org.workspaceId);
    return { id, email, token: t };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    jwt = await import("../src/services/jwt.js");
    fx = await import("./point7/product-fixtures.js");
    scim = await import("../src/services/access-control/scim.service.js");
    deps = {
      prisma: prisma as never,
      tag: `r3sc-${Date.now().toString(36)}`,
      mintToken: (userId: string, email: string) =>
        jwt.signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET as string,
          3600,
        ),
    };
    org = await fx.seedOrganizationTenant(deps, { memberCount: 1 });
    domain = `${randomUUID().slice(0, 8)}.scim-verified.example`;
    await prisma.organizationDomain.create({
      data: {
        organizationId: org.organizationId,
        domain,
        verifiedAt: new Date(),
        verificationToken: randomUUID(),
        createdByUserId: org.owner.userId,
      } as never,
    });
    const created = await scim.createScimToken({
      teamId: org.workspaceId,
      name: "rem3",
      scopes: ["users.read", "users.write", "users.deactivate", "groups.read", "groups.write"],
      actorUserId: org.owner.userId,
    } as never);
    token = (created as unknown as { tokenOnce: string }).tokenOnce;
  }, 300_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 300_000);

  it("IDENT-013: the directory creates an account in its proved domain, and none for any other address", async () => {
    const outside = `someone-${randomUUID().slice(0, 6)}@unproven-${randomUUID().slice(0, 6)}.example`;
    const refused = await scimCall("POST", "/v2/scim/Users", {
      schemas: [USER],
      userName: outside,
      externalId: `ext-${randomUUID()}`,
      emails: [{ value: outside, primary: true }],
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.body).toContain("email_domain_not_verified");
    expect(await prisma.user.count({ where: { email: outside } })).toBe(0);
    // Control (also PRO-012: the create is sent as application/scim+json).
    const inside = await directoryUser("inside");
    expect(await prisma.externalIdentityMapping.count({ where: { userId: inside.id, organizationId: org.organizationId } })).toBe(1);
  });

  it("AUD-0044: a userName already held is 409 uniqueness; a deactivated user stays readable with active=false", async () => {
    const u = await directoryUser("unique");
    const before = await prisma.externalIdentityMapping.findFirstOrThrow({
      where: { userId: u.id, organizationId: org.organizationId },
      select: { externalSubjectId: true },
    });
    // The same userName under another externalId (the audit's second POST).
    const dup = await scimCall("POST", "/v2/scim/Users", {
      schemas: [USER],
      userName: u.email,
      emails: [{ value: u.email, primary: true }],
      active: true,
    });
    expect(dup.statusCode, dup.body).toBe(409);
    expect((JSON.parse(dup.body) as Json).scimType).toBe("uniqueness");
    const after = await prisma.externalIdentityMapping.findMany({
      where: { userId: u.id, organizationId: org.organizationId },
      select: { externalSubjectId: true },
    });
    expect(after).toEqual([before]);

    // Deactivate: still a resource, read and filtered, with active=false.
    const off = await scimCall("PATCH", `/v2/scim/Users/${u.id}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(off.statusCode, off.body).toBe(200);
    const read = await scimCall("GET", `/v2/scim/Users/${u.id}`);
    expect(read.statusCode, read.body).toBe(200);
    expect((JSON.parse(read.body) as Json).active).toBe(false);
    const listed = await scimCall("GET", `/v2/scim/Users?filter=${encodeURIComponent(`userName eq "${u.email}"`)}`);
    expect(listed.statusCode, listed.body).toBe(200);
    const list = JSON.parse(listed.body) as { totalResults: number; Resources: Json[] };
    expect(list.totalResults).toBe(1);
    expect(list.Resources[0]).toMatchObject({ id: u.id, active: false });

    // Reactivate: active=true again, still one resource.
    const on = await scimCall("PATCH", `/v2/scim/Users/${u.id}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "active", value: true }],
    });
    expect(on.statusCode, on.body).toBe(200);
    const again = JSON.parse((await scimCall("GET", `/v2/scim/Users?filter=${encodeURIComponent(`userName eq "${u.email}"`)}`)).body) as { totalResults: number; Resources: Json[] };
    expect(again.totalResults).toBe(1);
    expect(again.Resources[0]).toMatchObject({ id: u.id, active: true });
  });

  it("PRO-012: a deprovisioning PATCH sent as application/scim+json takes effect; JSON keeps working", async () => {
    const u = await directoryUser("media");
    expect((await me(u.token)).statusCode).toBe(200);
    const off = await scimCall("PATCH", `/v2/scim/Users/${u.id}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(String(off.headers["content-type"])).toContain(SCIM_JSON);
    expect((await member(u.id)).status).toBe("SUSPENDED");
    expect((await me(u.token)).statusCode).toBe(401);
    // A malformed scim+json body is a SCIM 400, not a 415 and not a crash.
    const bad = await harness.app.inject({
      method: "PATCH",
      url: `/v2/scim/Users/${u.id}`,
      headers: { authorization: `Bearer ${token}`, "content-type": SCIM_JSON },
      payload: "{not json",
    });
    expect(bad.statusCode).toBe(400);
    // application/json still works.
    const on = await scimCall(
      "PATCH",
      `/v2/scim/Users/${u.id}`,
      { schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: true }] },
      "application/json",
    );
    expect(on.statusCode, on.body).toBe(200);
    expect((await member(u.id)).status).toBe("ACTIVE");
  });

  it("PRO-013: active=true restores the directory's own suspension, never an administrator's", async () => {
    const u = await directoryUser("suspend");
    const activate = () =>
      scimCall("PATCH", `/v2/scim/Users/${u.id}`, {
        schemas: [PATCH],
        Operations: [{ op: "replace", path: "active", value: true }],
      });
    // Control: the directory's own suspension is undone by its own push.
    await scimCall("PATCH", `/v2/scim/Users/${u.id}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect((await member(u.id)).status).toBe("SUSPENDED");
    expect((await activate()).statusCode).toBe(200);
    expect((await member(u.id)).status).toBe("ACTIVE");

    // An administrator's suspension (the row the suspend route writes).
    await prisma.teamMember.update({
      where: { teamId_userId: { teamId: org.workspaceId, userId: u.id } },
      data: {
        status: "SUSPENDED",
        suspendedAtUtc: new Date(),
        suspendedByUserId: org.owner.userId,
        suspensionReason: "administrator suspension",
      },
    });
    const pushed = await activate();
    expect(pushed.statusCode, pushed.body).toBe(409);
    expect(pushed.body).toContain("membership_suspended_by_administrator");
    const after = await member(u.id);
    expect(after.status).toBe("SUSPENDED");
    expect(after.suspensionReason).toBe("administrator suspension");
  });

  it("PRO-014: DELETE reaches a directory person, and is 404 for a member the directory does not manage", async () => {
    const manual = org.members[0]!;
    expect((await me(manual.token)).statusCode).toBe(200);
    expect((await scimCall("GET", `/v2/scim/Users/${manual.userId}`)).statusCode).toBe(404);
    const del = await scimCall("DELETE", `/v2/scim/Users/${manual.userId}`);
    expect(del.statusCode).toBe(404);
    expect((await member(manual.userId)).status).toBe("ACTIVE");
    expect((await me(manual.token)).statusCode).toBe(200);
    const off = await scimCall("PATCH", `/v2/scim/Users/${manual.userId}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(off.statusCode).toBe(404);
    expect((await member(manual.userId)).status).toBe("ACTIVE");

    // Control: a directory person is deprovisioned, and a repeat is harmless.
    const u = await directoryUser("deprov");
    expect((await scimCall("DELETE", `/v2/scim/Users/${u.id}`)).statusCode).toBe(204);
    expect((await member(u.id)).status).toBe("SUSPENDED");
    expect((await me(u.token)).statusCode).toBe(401);
    expect((await scimCall("DELETE", `/v2/scim/Users/${u.id}`)).statusCode).toBe(204);
  });

  it("PRO-030: a group names only directory people, and lowering its mapping lowers what it granted", async () => {
    const manual = org.members[0]!;
    const refused = await scimCall("POST", "/v2/scim/Groups", {
      schemas: [GROUP],
      displayName: `rem3 admins ${randomUUID().slice(0, 4)}`,
      mappedRole: "ADMIN",
      members: [{ value: manual.userId }],
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect((await member(manual.userId)).role).toBe("MEMBER");

    const granted = await directoryUser("grp-a");
    const kept = await directoryUser("grp-b");
    const create = await scimCall("POST", "/v2/scim/Groups", {
      schemas: [GROUP],
      displayName: `rem3 admins ${randomUUID().slice(0, 4)}`,
      mappedRole: "ADMIN",
      members: [{ value: granted.id }, { value: kept.id }],
    });
    expect(create.statusCode, create.body).toBe(201);
    const gid = (JSON.parse(create.body) as Json).id as string;
    expect((await member(granted.id)).role).toBe("ADMIN");
    expect((await member(kept.id)).role).toBe("ADMIN");

    // An administrator appoints `kept` ADMIN in their own right afterwards.
    const keptRow = await member(kept.id);
    await prisma.membershipGrant.create({
      data: {
        teamMemberId: keptRow.id,
        source: "MANUAL",
        intent: "ADMIN_ASSIGNMENT",
        grantedByUserId: org.owner.userId,
        grantedRole: "ADMIN",
      } as never,
    });

    const lowered = await scimCall("PATCH", `/v2/scim/Groups/${gid}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "mappedRole", value: "MEMBER" }],
    });
    expect(lowered.statusCode, lowered.body).toBe(200);
    expect((await member(granted.id)).role).toBe("MEMBER");
    expect((await member(kept.id)).role).toBe("ADMIN");
  });
});
