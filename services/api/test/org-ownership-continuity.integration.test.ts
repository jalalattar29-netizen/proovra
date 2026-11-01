/**
 * AUTHZ-008, PROV-011, PROV-012 — the owners of an organization, on real routes
 * and a real PostgreSQL: never zero live owners, under concurrency, and the
 * workspace, billing and contract owners stay coherent through a transfer.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = import("@prisma/client").PrismaClient;

describe("organization ownership continuity (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let fixtures: typeof import("./point7/product-fixtures.js");
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const STEP_UP_PASSWORD = "Owner-Password-1234";

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    fixtures = await import("./point7/product-fixtures.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const deps = () => ({
    prisma: prisma as never,
    tag: `own-${tag()}`,
    mintToken: (userId: string, email: string) =>
      signJwt(
        { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
        process.env.AUTH_JWT_SECRET as string,
        3600,
      ),
  });

  async function organization() {
    const d = deps();
    const t = await fixtures.seedOrganizationTenant(d);
    const { hashPassword } = await import("../src/services/email-password-auth.service.js");
    await prisma.user.update({ where: { id: t.owner.userId }, data: { passwordHash: hashPassword(STEP_UP_PASSWORD) } });
    await prisma.enterpriseContract.update({
      where: { organizationId: t.organizationId },
      data: { contractOwnerUserId: t.owner.userId },
    });
    return { orgId: t.organizationId, workspaceId: t.workspaceId, owner: t.owner, d };
  }

  async function member(
    o: { orgId: string; workspaceId: string; d: ReturnType<typeof deps> },
    role: "ORG_OWNER" | "ORG_ADMIN" | "ORG_MEMBER",
    opts: { workspace?: boolean } = { workspace: true },
  ) {
    const user = await fixtures.seedUser(o.d, role.toLowerCase());
    const row = await prisma.organizationMembership.create({
      data: { organizationId: o.orgId, userId: user.userId, role },
      select: { id: true },
    });
    if (opts.workspace !== false) {
      await prisma.teamMember.create({
        data: { teamId: o.workspaceId, userId: user.userId, role: "MEMBER", status: "ACTIVE" },
      });
    }
    return { ...user, membershipId: row.id };
  }

  const liveOwners = (orgId: string) =>
    prisma.organizationMembership.count({ where: { organizationId: orgId, role: "ORG_OWNER", status: "ACTIVE" } });

  const transfer = (o: { orgId: string; owner: { token: string } }, targetUserId: string) =>
    h.app.inject({
      method: "POST",
      url: `/v1/orgs/${o.orgId}/transfer-ownership`,
      headers: bearer(o.owner.token),
      payload: { targetUserId, stepUp: { method: "password", currentPassword: STEP_UP_PASSWORD } },
    });

  it("AUTHZ-008 — two owners demoting each other: exactly one demotion lands, one live owner remains", async () => {
    const o = await organization();
    const b = await member(o, "ORG_OWNER");
    const a = await prisma.organizationMembership.findFirstOrThrow({
      where: { organizationId: o.orgId, userId: o.owner.userId },
      select: { id: true },
    });

    const [first, second] = await Promise.all([
      h.app.inject({
        method: "PATCH",
        url: `/v1/orgs/${o.orgId}/members/${b.membershipId}`,
        headers: bearer(o.owner.token),
        payload: { role: "ORG_ADMIN" },
      }),
      h.app.inject({
        method: "PATCH",
        url: `/v1/orgs/${o.orgId}/members/${a.id}`,
        headers: bearer(b.token),
        payload: { role: "ORG_ADMIN" },
      }),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 403]);
    expect(await liveOwners(o.orgId)).toBe(1);
  });

  it("AUTHZ-008 — one demotion and one suspension of the two owners cannot both land", async () => {
    const o = await organization();
    const b = await member(o, "ORG_OWNER");
    const a = await prisma.organizationMembership.findFirstOrThrow({
      where: { organizationId: o.orgId, userId: o.owner.userId },
      select: { id: true },
    });
    const results = await Promise.all([
      h.app.inject({
        method: "POST",
        url: `/v1/orgs/${o.orgId}/members/${b.membershipId}/suspend`,
        headers: bearer(o.owner.token),
        payload: {},
      }),
      h.app.inject({
        method: "DELETE",
        url: `/v1/orgs/${o.orgId}/members/${a.id}`,
        headers: bearer(b.token),
      }),
    ]);
    expect(results.filter((r) => r.statusCode === 200).length).toBeLessThanOrEqual(1);
    expect(await liveOwners(o.orgId)).toBeGreaterThanOrEqual(1);
  });

  it("PROV-012 — ownership cannot land on a suspended or removed member, by transfer or by promotion", async () => {
    const o = await organization();
    const suspended = await member(o, "ORG_MEMBER");
    await prisma.organizationMembership.update({
      where: { id: suspended.membershipId },
      data: { status: "SUSPENDED", suspendedAtUtc: new Date() },
    });
    const removed = await member(o, "ORG_MEMBER");
    await prisma.organizationMembership.update({
      where: { id: removed.membershipId },
      data: { status: "REVOKED", revokedAtUtc: new Date() },
    });

    for (const target of [suspended, removed]) {
      const moved = await transfer(o, target.userId);
      expect(moved.statusCode, moved.body).toBe(409);
      expect(moved.json()).toMatchObject({ error: { code: "OWNER_TARGET_NOT_ACTIVE" } });
      const promoted = await h.app.inject({
        method: "PATCH",
        url: `/v1/orgs/${o.orgId}/members/${target.membershipId}`,
        headers: bearer(o.owner.token),
        payload: { role: "ORG_OWNER" },
      });
      expect(promoted.statusCode, promoted.body).toBe(409);
    }
    expect(await liveOwners(o.orgId)).toBe(1);
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId: o.orgId, userId: o.owner.userId, role: "ORG_OWNER" },
      }),
    ).toBe(1);
  });

  it("PROV-011 — a transfer moves the workspace owner, billing owner and contract owner together, and the new owner can act as one", async () => {
    const o = await organization();
    const next = await member(o, "ORG_ADMIN");

    const res = await transfer(o, next.userId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ contractOwnerTransferred: true, workspacesTransferred: 1 });

    expect(await prisma.team.findUniqueOrThrow({ where: { id: o.workspaceId } })).toMatchObject({
      ownerUserId: next.userId,
      billingOwnerUserId: next.userId,
    });
    expect(await prisma.enterpriseContract.findUniqueOrThrow({ where: { organizationId: o.orgId } })).toMatchObject({
      contractOwnerUserId: next.userId,
    });
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: o.orgId } })).toMatchObject({
      billingOwnerUserId: next.userId,
    });
    expect(
      await prisma.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: o.workspaceId, userId: next.userId } } }),
    ).toMatchObject({ role: "OWNER", status: "ACTIVE" });
    expect(
      await prisma.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: o.workspaceId, userId: o.owner.userId } } }),
    ).toMatchObject({ role: "ADMIN", status: "ACTIVE" });

    // The former owner may now leave, and the workspace still has its owner.
    const left = await h.app.inject({ method: "POST", url: `/v1/orgs/${o.orgId}/leave`, headers: bearer(o.owner.token) });
    expect(left.statusCode, left.body).toBe(200);
    expect(
      await prisma.teamMember.count({ where: { teamId: o.workspaceId, role: "OWNER", status: "ACTIVE" } }),
    ).toBe(1);
  });

  it("PROV-011 — a successor who is not in the workspace joins it, and a full workspace refuses with nothing moved", async () => {
    const o = await organization();
    await prisma.enterpriseContract.update({ where: { organizationId: o.orgId }, data: { seatCount: 1 } });
    await member(o, "ORG_MEMBER");
    const outsider = await member(o, "ORG_ADMIN", { workspace: false });

    const refused = await transfer(o, outsider.userId);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: "WORKSPACE_SEAT_LIMIT_REACHED" } });
    expect(await liveOwners(o.orgId)).toBe(1);
    expect(await prisma.team.findUniqueOrThrow({ where: { id: o.workspaceId } })).toMatchObject({
      ownerUserId: o.owner.userId,
    });
    expect(
      await prisma.organizationMembership.findFirstOrThrow({ where: { organizationId: o.orgId, userId: o.owner.userId } }),
    ).toMatchObject({ role: "ORG_OWNER" });

    await prisma.enterpriseContract.update({ where: { organizationId: o.orgId }, data: { seatCount: 5 } });
    const moved = await transfer(o, outsider.userId);
    expect(moved.statusCode, moved.body).toBe(200);
    expect(
      await prisma.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: o.workspaceId, userId: outsider.userId } } }),
    ).toMatchObject({ role: "OWNER", status: "ACTIVE" });
  });

  it("PROV-011 — nobody removes or walks away from a workspace they own", async () => {
    const o = await organization();
    const admin = await member(o, "ORG_ADMIN");
    // The state an earlier transfer left behind.
    await prisma.team.update({ where: { id: o.workspaceId }, data: { ownerUserId: admin.userId } });

    const leave = await h.app.inject({ method: "POST", url: `/v1/orgs/${o.orgId}/leave`, headers: bearer(admin.token) });
    expect(leave.statusCode, leave.body).toBe(409);
    expect(leave.json()).toMatchObject({ error: { code: "OWNERSHIP_TRANSFER_REQUIRED" } });

    const removal = await h.app.inject({
      method: "DELETE",
      url: `/v1/orgs/${o.orgId}/members/${admin.membershipId}`,
      headers: bearer(o.owner.token),
    });
    expect(removal.statusCode, removal.body).toBe(409);
    expect(
      await prisma.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: o.workspaceId, userId: admin.userId } } }),
    ).toMatchObject({ status: "ACTIVE" });
  });

  it("control: an ordinary member can still leave and be removed", async () => {
    const o = await organization();
    const a = await member(o, "ORG_MEMBER");
    const b = await member(o, "ORG_MEMBER");
    expect(
      (await h.app.inject({ method: "POST", url: `/v1/orgs/${o.orgId}/leave`, headers: bearer(a.token) })).statusCode,
    ).toBe(200);
    expect(
      (
        await h.app.inject({
          method: "DELETE",
          url: `/v1/orgs/${o.orgId}/members/${b.membershipId}`,
          headers: bearer(o.owner.token),
        })
      ).statusCode,
    ).toBe(200);
  });
});
