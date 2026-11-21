/**
 * Closure 2 ("sem" item 1) — a directory (SCIM) push and organization owners.
 *
 * Phase 1 made SCIM never suspend ANY ORG_OWNER's governance membership. The
 * rule is now owner CONTINUITY, the one the manual suspension, demotion and
 * removal routes already apply (LAST_OWNER_PROTECTED):
 *   - the LAST live owner is never suspended or deprovisioned by the directory
 *     (409 to the IdP, nothing written: no workspace suspension, no mapping
 *     unlink, no session revocation);
 *   - an owner may be suspended while ANOTHER live owner remains;
 *   - two concurrent suspensions of the only two owners leave one owner (the
 *     owners' advisory lock serializes the count and the suspension);
 *   - an ownership-offer acceptance racing a suspension of the offerer keeps
 *     exactly one live owner.
 * Live PostgreSQL, the real SCIM routes and the real service.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, SeededUser } from "./point7/product-fixtures.js";

describe("sem item 1 — SCIM protects the LAST live organization owner, not every owner", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let fx: typeof import("./point7/product-fixtures.js");
  let scim: typeof import("../src/services/access-control/scim.service.js");
  let hashPassword: (typeof import("../src/services/email-password-auth.service.js"))["hashPassword"];
  let deps: FixtureDeps;

  const PASSWORD = "Owner-Password-1234";
  const proof = { stepUp: { method: "password", currentPassword: PASSWORD } };
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    fx = await import("./point7/product-fixtures.js");
    scim = await import("../src/services/access-control/scim.service.js");
    ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
    const jwt = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `semscim-${Date.now().toString(36)}`,
      mintToken: (userId: string, email: string) =>
        jwt.signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET as string,
          3600,
        ),
    };
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  type Org = { orgId: string; workspaceId: string; owner: SeededUser & { membershipId: string } };

  async function organization(): Promise<Org> {
    const t = await fx.seedOrganizationTenant(deps);
    await prisma.user.update({ where: { id: t.owner.userId }, data: { passwordHash: await hashPassword(PASSWORD) } });
    const m = await prisma.organizationMembership.findFirstOrThrow({
      where: { organizationId: t.organizationId, userId: t.owner.userId },
      select: { id: true },
    });
    return { orgId: t.organizationId, workspaceId: t.workspaceId, owner: { ...t.owner, membershipId: m.id } };
  }

  /** A further member of the organization, with a non-owner workspace seat. */
  async function member(o: Org, role: "ORG_OWNER" | "ORG_ADMIN" | "ORG_MEMBER") {
    const u = await fx.seedUser(deps, `m-${role.toLowerCase()}`);
    await prisma.user.update({ where: { id: u.userId }, data: { passwordHash: await hashPassword(PASSWORD) } });
    const m = await prisma.organizationMembership.create({
      data: { organizationId: o.orgId, userId: u.userId, role },
      select: { id: true },
    });
    await prisma.teamMember.create({ data: { teamId: o.workspaceId, userId: u.userId, role: "MEMBER", status: "ACTIVE" } });
    return { ...u, membershipId: m.id };
  }

  /** Make a member reachable by this Organization's directory (PRO-014 / PRO-A2-02). */
  async function directoryManaged(o: Org, userId: string) {
    await prisma.user.update({
      where: { id: userId },
      data: { providerUserId: `scim-${o.orgId}:sem-${randomUUID()}` },
    });
    await prisma.externalIdentityMapping.create({
      data: {
        teamId: o.workspaceId,
        organizationId: o.orgId,
        userId,
        provider: "GENERIC_SCIM",
        externalSubjectId: `sem-${randomUUID()}`,
        displayName: "Before",
      },
    });
  }

  const ctxOf = (o: Org) => ({
    teamId: o.workspaceId,
    organizationId: o.orgId,
    tokenId: randomUUID(),
    baseUrl: "https://local.test",
  });
  const deactivate = (o: Org, userId: string) => scim.scimDeactivateUser(ctxOf(o), userId, prisma as never);

  const liveOwners = async (orgId: string) =>
    (
      await prisma.organizationMembership.findMany({
        where: { organizationId: orgId, role: "ORG_OWNER", status: "ACTIVE" },
        select: { userId: true },
      })
    )
      .map((r) => r.userId)
      .sort();

  const govStatus = async (membershipId: string) =>
    (await prisma.organizationMembership.findUniqueOrThrow({ where: { id: membershipId }, select: { status: true } }))
      .status;

  async function scimTokenFor(o: Org) {
    const created = await scim.createScimToken({
      teamId: o.workspaceId,
      name: "sem-owner",
      scopes: ["users.read", "users.write", "users.deactivate"],
      actorUserId: o.owner.userId,
    } as never);
    return (created as unknown as { tokenOnce: string }).tokenOnce;
  }
  const scimCall = (token: string, method: string, url: string, payload?: unknown) =>
    h.app.inject({
      method: method as never,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/scim+json" } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  it("one owner: the directory cannot suspend or deprovision them; 409 to the IdP and nothing is written", async () => {
    const o = await organization();
    await directoryManaged(o, o.owner.userId);
    // A non-owner workspace seat the owner also holds would be suspended by a
    // deactivation; it must survive the refusal.
    const extra = await prisma.team.create({
      data: {
        name: `sem-extra-${randomUUID().slice(0, 6)}`,
        ownerUserId: (await member(o, "ORG_ADMIN")).userId,
        isPersonal: false,
        organizationId: o.orgId,
        workspaceKind: "ORGANIZATION",
        billingPlan: "ENTERPRISE",
        billingStatus: "ACTIVE",
      },
      select: { id: true },
    });
    await prisma.teamMember.create({ data: { teamId: extra.id, userId: o.owner.userId, role: "MEMBER", status: "ACTIVE" } });

    // Service door.
    expect(await deactivate(o, o.owner.userId)).toEqual({ ok: false, lastOwnerProtected: true });
    // Route doors: DELETE, PATCH active:false, and a combined PATCH that would
    // also rename — refused with zero mutation (the rename does not land).
    const token = await scimTokenFor(o);
    const del = await scimCall(token, "DELETE", `/v2/scim/Users/${o.owner.userId}`);
    expect(del.statusCode, del.body).toBe(409);
    expect(del.json()).toMatchObject({ detail: "last_active_organization_owner" });
    const patch = await scimCall(token, "PATCH", `/v2/scim/Users/${o.owner.userId}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [
        { op: "replace", path: "displayName", value: "Renamed" },
        { op: "replace", path: "active", value: false },
      ],
    });
    expect(patch.statusCode, patch.body).toBe(409);
    expect(patch.json()).toMatchObject({ detail: "last_active_organization_owner" });

    expect(await liveOwners(o.orgId)).toEqual([o.owner.userId]);
    expect(await govStatus(o.owner.membershipId)).toBe("ACTIVE");
    const seats = await prisma.teamMember.findMany({
      where: { userId: o.owner.userId, team: { organizationId: o.orgId } },
      select: { status: true },
    });
    expect(seats.map((s) => s.status)).toEqual(["ACTIVE", "ACTIVE"]);
    const mapping = await prisma.externalIdentityMapping.findFirstOrThrow({
      where: { organizationId: o.orgId, userId: o.owner.userId },
      select: { unlinkedAtUtc: true, displayName: true },
    });
    expect(mapping).toEqual({ unlinkedAtUtc: null, displayName: "Before" });
    // The refusal is on the record for the operator.
    const denied = await prisma.adminAuditLog.count({
      where: { action: "scim.user.deactivate", outcome: "denied", resourceId: o.owner.userId },
    });
    expect(denied).toBeGreaterThanOrEqual(1);
  });

  it("several owners: an owner IS suspended while another live owner remains; the last one then is not", async () => {
    const o = await organization();
    const second = await member(o, "ORG_OWNER");
    await directoryManaged(o, second.userId);
    await directoryManaged(o, o.owner.userId);

    const token = await scimTokenFor(o);
    const del = await scimCall(token, "DELETE", `/v2/scim/Users/${second.userId}`);
    expect(del.statusCode, del.body).toBe(204);
    expect(await govStatus(second.membershipId)).toBe("SUSPENDED");
    expect(
      (
        await prisma.teamMember.findUniqueOrThrow({
          where: { teamId_userId: { teamId: o.workspaceId, userId: second.userId } },
          select: { status: true },
        })
      ).status,
    ).toBe("SUSPENDED");
    expect(await liveOwners(o.orgId)).toEqual([o.owner.userId]);

    // The remaining owner is now the last one.
    const last = await scimCall(token, "DELETE", `/v2/scim/Users/${o.owner.userId}`);
    expect(last.statusCode, last.body).toBe(409);
    expect(await liveOwners(o.orgId)).toEqual([o.owner.userId]);
  });

  it("concurrent suspensions of the only two owners leave exactly one live owner (lock-serialized)", async () => {
    for (let i = 0; i < 4; i += 1) {
      const o = await organization();
      const second = await member(o, "ORG_OWNER");
      await directoryManaged(o, o.owner.userId);
      await directoryManaged(o, second.userId);

      // Deterministic: both suspensions queue behind a held owners' lock and are
      // released together, so they truly contend for the count.
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const lockHeld = new Promise<void>((r) => (locked = r));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`org-owners:${o.orgId}`}))`;
          locked();
          await released;
        },
        { timeout: 30_000 },
      );
      await lockHeld;
      const both = Promise.all([deactivate(o, o.owner.userId), deactivate(o, second.userId)]);
      await new Promise((r) => setTimeout(r, 300));
      release();
      await holder;
      const results = await both;

      expect(results.filter((r) => r.ok), JSON.stringify(results)).toHaveLength(1);
      expect(results.filter((r) => r.lastOwnerProtected), JSON.stringify(results)).toHaveLength(1);
      const owners = await liveOwners(o.orgId);
      expect(owners, `round ${i}`).toHaveLength(1);
    }
  });

  it("an ownership acceptance racing a suspension of the offerer keeps exactly one live owner, in either order", async () => {
    const offer = (o: Org, targetUserId: string) =>
      h.app.inject({
        method: "POST",
        url: `/v1/orgs/${o.orgId}/transfer-ownership`,
        headers: bearer(o.owner.token),
        payload: { targetUserId, ...proof },
      });
    const accept = (o: Org, who: { token: string }, offerId: string) =>
      h.app.inject({
        method: "POST",
        url: `/v1/orgs/${o.orgId}/ownership-offer/${offerId}/accept`,
        headers: bearer(who.token),
        payload: proof,
      });

    // Ordered: the suspension of the sole owner comes first and is refused;
    // the acceptance then moves ownership; the directory's retry now suspends
    // the former owner (no longer an owner).
    {
      const o = await organization();
      const recipient = await member(o, "ORG_ADMIN");
      await directoryManaged(o, o.owner.userId);
      const made = await offer(o, recipient.userId);
      expect(made.statusCode, made.body).toBe(202);
      const offerId = (made.json() as { offer: { id: string } }).offer.id;
      expect(await deactivate(o, o.owner.userId)).toEqual({ ok: false, lastOwnerProtected: true });
      const ok = await accept(o, recipient, offerId);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await liveOwners(o.orgId)).toEqual([recipient.userId]);
      expect(await deactivate(o, o.owner.userId)).toEqual({ ok: true });
      expect(await govStatus(o.owner.membershipId)).toBe("SUSPENDED");
      expect(await liveOwners(o.orgId)).toEqual([recipient.userId]);
    }

    // Raced: whichever wins, one live owner and no suspended owner remain.
    for (let i = 0; i < 4; i += 1) {
      const o = await organization();
      const recipient = await member(o, "ORG_ADMIN");
      await directoryManaged(o, o.owner.userId);
      const made = await offer(o, recipient.userId);
      const offerId = (made.json() as { offer: { id: string } }).offer.id;
      await Promise.allSettled([accept(o, recipient, offerId), deactivate(o, o.owner.userId)]);
      const rows = await prisma.organizationMembership.findMany({
        where: { organizationId: o.orgId, role: "ORG_OWNER" },
        select: { userId: true, status: true },
      });
      expect(rows.filter((r) => r.status === "ACTIVE"), JSON.stringify(rows)).toHaveLength(1);
      expect(rows.filter((r) => r.status !== "ACTIVE"), JSON.stringify(rows)).toHaveLength(0);
    }
  });
});
