/**
 * AUD-0020 — after an Owned workspace is transferred, the PREVIOUS owner's
 * account closure must not close it.
 *
 * Account closure closes only workspaces the person owns (LIFE-13). An Owned
 * workspace sits in an internal SYSTEM organization whose ORG_OWNER row stays
 * with the transferor, and closure archived that "solo" container with every
 * workspace in it: the new owner's workspace closed, their membership was
 * revoked, and they could not reopen it (no closure request existed).
 *
 * Shape seeded as the product created it (self-service POST /v1/teams before
 * 2026-08-28, mirrored by e2e/point7/_ui-fixtures.ts seedOwnedWorkspace): a
 * SYSTEM organization with the owner as ORG_OWNER, an OWNED workspace, and an
 * invited member at the workspace layer only. Transfer and closure run through
 * their product services; the new owner's access is read through the real route.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedUser, type FixtureDeps, type SeededUser } from "./point7/product-fixtures.js";

type Prisma = typeof import("../src/db.js")["prisma"];

describe("AUD-0020 — a transferred Owned workspace survives the former owner's account closure (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: Prisma;
  let deps: FixtureDeps;
  let accountClosure: typeof import("../src/services/identity/account-closure.service.js");
  let lifecycle: typeof import("../src/services/workspace/workspace-lifecycle.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    accountClosure = await import("../src/services/identity/account-closure.service.js");
    lifecycle = await import("../src/services/workspace/workspace-lifecycle.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `aud20-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt({ sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) }, secret, 3600),
    };
  }, 900_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 300_000);

  /** An Owned workspace in its SYSTEM container, with `member` invited at the workspace layer. */
  async function ownedWorkspace(owner: SeededUser, member: SeededUser) {
    const name = `aud20-${randomUUID().slice(0, 8)}`;
    const org = await prisma.organization.create({
      data: { name, billingOwnerUserId: owner.userId, status: "ACTIVE", kind: "SYSTEM" },
      select: { id: true },
    });
    await prisma.organizationMembership.create({ data: { organizationId: org.id, userId: owner.userId, role: "ORG_OWNER" } });
    const team = await prisma.team.create({
      data: {
        name,
        ownerUserId: owner.userId,
        billingOwnerUserId: owner.userId,
        isPersonal: false,
        organizationId: org.id,
        workspaceKind: "OWNED",
        billingPlan: "PRO",
        billingStatus: "INACTIVE",
      },
      select: { id: true },
    });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: owner.userId, role: "OWNER", status: "ACTIVE" } });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: member.userId, role: "MEMBER", status: "ACTIVE" } });
    return { teamId: team.id, organizationId: org.id };
  }

  const readWorkspace = (teamId: string, token: string) =>
    harness.app.inject({ method: "GET", url: `/v1/teams/${teamId}`, headers: { authorization: `Bearer ${token}` } });

  it("after transfer, the former owner's preflight and closure leave the new owner's workspace open and theirs", async () => {
    const a = await seedUser(deps, "former-owner");
    const b = await seedUser(deps, "new-owner");
    const w = await ownedWorkspace(a, b);
    await lifecycle.transferWorkspaceOwnership({ teamId: w.teamId, actorUserId: a.userId, newOwnerUserId: b.userId });
    expect((await readWorkspace(w.teamId, b.token)).statusCode).toBe(200);

    // The former owner's preflight: nothing about W blocks, and nothing says W closes.
    const pre = await harness.app.inject({
      method: "GET",
      url: "/v1/identity/account-closure",
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(pre.statusCode, pre.body).toBe(200);
    const preBody = JSON.parse(pre.body) as { blockers: unknown[]; consequences: Array<{ code: string }> };
    expect(preBody.blockers).toEqual([]);
    expect(preBody.consequences.map((c) => c.code)).not.toContain("WORKSPACE_MEMBERS_LOSE_ACCESS");

    await accountClosure.executeAccountClosure(a.userId);

    const team = await prisma.team.findUniqueOrThrow({ where: { id: w.teamId }, select: { closedAtUtc: true, ownerUserId: true } });
    expect(team).toEqual({ closedAtUtc: null, ownerUserId: b.userId });
    const bRow = await prisma.teamMember.findFirstOrThrow({ where: { teamId: w.teamId, userId: b.userId } });
    expect({ role: bRow.role, status: bRow.status }).toEqual({ role: "OWNER", status: "ACTIVE" });
    // The former owner's own access to W ends with their account.
    expect((await prisma.teamMember.findFirstOrThrow({ where: { teamId: w.teamId, userId: a.userId } })).status).toBe("REVOKED");
    // The container stays live; only the former owner's membership of it ends.
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: w.organizationId } })).status).toBe("ACTIVE");
    expect(await prisma.organizationMembership.count({ where: { organizationId: w.organizationId, userId: a.userId } })).toBe(0);
    // And the new owner still works in it.
    const res = await readWorkspace(w.teamId, b.token);
    expect(res.statusCode, res.body).toBe(200);
  });

  it("control: an Owned workspace the closing person still owns closes with the account (LIFE-13), its member losing access", async () => {
    const a = await seedUser(deps, "owner");
    const b = await seedUser(deps, "member");
    const w = await ownedWorkspace(a, b);

    const pre = await harness.app.inject({
      method: "GET",
      url: "/v1/identity/account-closure",
      headers: { authorization: `Bearer ${a.token}` },
    });
    const preBody = JSON.parse(pre.body) as { consequences: Array<{ code: string; count: number }> };
    expect(preBody.consequences).toEqual([expect.objectContaining({ code: "WORKSPACE_MEMBERS_LOSE_ACCESS", count: 1 })]);

    await accountClosure.executeAccountClosure(a.userId);

    expect((await prisma.team.findUniqueOrThrow({ where: { id: w.teamId } })).closedAtUtc).not.toBeNull();
    expect((await prisma.teamMember.findFirstOrThrow({ where: { teamId: w.teamId, userId: b.userId } })).status).toBe("REVOKED");
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: w.organizationId } })).status).toBe("ARCHIVED");
  });

  it("control: once the new owner closes their own account, the transferred workspace closes with it", async () => {
    const a = await seedUser(deps, "former-owner-2");
    const b = await seedUser(deps, "new-owner-2");
    const w = await ownedWorkspace(a, b);
    await lifecycle.transferWorkspaceOwnership({ teamId: w.teamId, actorUserId: a.userId, newOwnerUserId: b.userId });

    await accountClosure.executeAccountClosure(b.userId);

    expect((await prisma.team.findUniqueOrThrow({ where: { id: w.teamId } })).closedAtUtc).not.toBeNull();
    // The former owner, still a member (ADMIN after the transfer), loses access with the workspace.
    expect((await prisma.teamMember.findFirstOrThrow({ where: { teamId: w.teamId, userId: a.userId } })).status).toBe("REVOKED");
  });
});
