/**
 * Closure 2 ("sem" item 2) — billing ownership after an organization
 * ownership transfer (decision E), on the real routes and a live PostgreSQL.
 *
 * Decision E keeps the payer through the transfer. What this proves:
 *   - GET /v1/orgs/:id/payer states who pays, where they stand now, which
 *     provider agreements bill the organization and whom, what closure waits
 *     on, and bounded guidance — for the owner before, the new owner and the
 *     former owner after, and refuses everyone else;
 *   - the new owner holds no hidden liability AND cannot cancel the former
 *     owner's agreement (cancellation is the purchaser's own act);
 *   - the former payer may leave, but only after acknowledging they keep
 *     paying (409 with guidance first; nothing written); a non-payer leaves as
 *     before;
 *   - organization closure names the other payer.
 * No provider is called; no price, quota or entitlement changes.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, SeededUser } from "./point7/product-fixtures.js";

describe("sem item 2 — the payer after an organization ownership transfer", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let fx: typeof import("./point7/product-fixtures.js");
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
    ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
    const jwt = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `sempay-${Date.now().toString(36)}`,
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

  type Org = { orgId: string; workspaceId: string; owner: SeededUser; subscriptionId: string };

  async function withPassword(userId: string) {
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(PASSWORD), displayName: `user-${userId.slice(0, 4)}` } });
  }

  async function organization(): Promise<Org> {
    const t = await fx.seedOrganizationTenant(deps);
    await withPassword(t.owner.userId);
    await prisma.enterpriseContract.update({
      where: { organizationId: t.organizationId },
      data: { contractOwnerUserId: t.owner.userId },
    });
    const sub = await prisma.subscription.create({
      data: {
        userId: t.owner.userId,
        teamId: t.workspaceId,
        provider: "STRIPE",
        providerSubId: `sub_${randomUUID().slice(0, 12)}`,
        status: "ACTIVE",
        plan: "TEAM",
        currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
      } as never,
      select: { id: true },
    });
    return { orgId: t.organizationId, workspaceId: t.workspaceId, owner: t.owner, subscriptionId: sub.id };
  }

  async function member(o: Org, role: "ORG_ADMIN" | "ORG_MEMBER" | "ORG_BILLING_ADMIN") {
    const u = await fx.seedUser(deps, `m-${role.toLowerCase()}`);
    await withPassword(u.userId);
    await prisma.organizationMembership.create({ data: { organizationId: o.orgId, userId: u.userId, role } });
    await prisma.teamMember.create({ data: { teamId: o.workspaceId, userId: u.userId, role: "MEMBER", status: "ACTIVE" } });
    return u;
  }

  const payerOf = (o: Org, who: { token: string }) =>
    h.app.inject({ method: "GET", url: `/v1/orgs/${o.orgId}/payer`, headers: bearer(who.token) });
  const leave = (o: Org, who: { token: string }, body: Record<string, unknown> = {}) =>
    h.app.inject({ method: "POST", url: `/v1/orgs/${o.orgId}/leave`, headers: bearer(who.token), payload: body });

  async function transfer(o: Org, to: SeededUser) {
    const made = await h.app.inject({
      method: "POST",
      url: `/v1/orgs/${o.orgId}/transfer-ownership`,
      headers: bearer(o.owner.token),
      payload: { targetUserId: to.userId, ...proof },
    });
    expect(made.statusCode, made.body).toBe(202);
    const offerId = (made.json() as { offer: { id: string } }).offer.id;
    const ok = await h.app.inject({
      method: "POST",
      url: `/v1/orgs/${o.orgId}/ownership-offer/${offerId}/accept`,
      headers: bearer(to.token),
      payload: proof,
    });
    expect(ok.statusCode, ok.body).toBe(200);
  }

  const subscriptionRow = (o: Org) =>
    prisma.subscription.findUniqueOrThrow({
      where: { id: o.subscriptionId },
      select: { userId: true, teamId: true, status: true, cancelAtPeriodEnd: true, canceledAtUtc: true },
    });

  type Payer = {
    billingOwner: { userId: string; membership: string } | null;
    contractOwnerUserId: string | null;
    viewerIsPayer: boolean;
    state: string;
    agreements: Array<{ id: string; state: string; payerUserId: string; payerIsViewer: boolean; payerIsBillingOwner: boolean }>;
    closure: { renewing: number; blockedByAgreements: boolean };
    guidance: string[];
  };

  it("before and after a transfer: the payer projection states who pays, for whom, and what each viewer can and cannot do", async () => {
    const o = await organization();
    const recipient = await member(o, "ORG_ADMIN");

    const before = await payerOf(o, o.owner);
    expect(before.statusCode, before.body).toBe(200);
    const b = (before.json() as { payer: Payer }).payer;
    expect(b).toMatchObject({
      state: "PAYER_IS_OWNER",
      viewerIsPayer: true,
      billingOwner: { userId: o.owner.userId, membership: "OWNER" },
      closure: { renewing: 1, blockedByAgreements: true },
    });
    expect(b.agreements).toEqual([
      expect.objectContaining({ id: o.subscriptionId, state: "RENEWING", payerUserId: o.owner.userId, payerIsViewer: true }),
    ]);
    expect(b.guidance).not.toContain("PAYER_UNCHANGED_BY_OWNERSHIP_TRANSFER");

    await transfer(o, recipient);

    const asNewOwner = (await payerOf(o, recipient).then((r) => r.json())) as { payer: Payer };
    expect(asNewOwner.payer).toMatchObject({
      state: "PAYER_IS_MEMBER_NOT_OWNER",
      viewerIsPayer: false,
      billingOwner: { userId: o.owner.userId, membership: "MEMBER" },
      contractOwnerUserId: o.owner.userId,
    });
    expect(asNewOwner.payer.agreements[0]).toMatchObject({ payerIsViewer: false, payerIsBillingOwner: true });
    expect(asNewOwner.payer.guidance).toEqual(
      expect.arrayContaining([
        "PAYER_UNCHANGED_BY_OWNERSHIP_TRANSFER",
        "HANDOVER_VIA_ACCOUNT_MANAGER",
        "PAYER_CANCELS_IN_OWN_BILLING",
        "VIEWER_CANNOT_CANCEL_PAYER_AGREEMENT",
        "CLOSURE_WAITS_FOR_AGREEMENTS_TO_END",
      ]),
    );
    expect(asNewOwner.payer.guidance).not.toContain("VIEWER_REMAINS_LIABLE_UNTIL_CANCELLED");

    const asFormer = (await payerOf(o, o.owner).then((r) => r.json())) as { payer: Payer };
    expect(asFormer.payer).toMatchObject({ state: "PAYER_IS_MEMBER_NOT_OWNER", viewerIsPayer: true });
    expect(asFormer.payer.guidance).toContain("VIEWER_REMAINS_LIABLE_UNTIL_CANCELLED");
  });

  it("refusals: a plain member who pays nothing gets 403; a non-member gets 404; the billing administrator reads it", async () => {
    const o = await organization();
    const plain = await member(o, "ORG_MEMBER");
    const billingAdmin = await member(o, "ORG_BILLING_ADMIN");
    const outsider = await fx.seedUser(deps, "outsider");
    expect((await payerOf(o, plain)).statusCode).toBe(403);
    expect((await payerOf(o, outsider)).statusCode).toBe(404);
    const ok = await payerOf(o, billingAdmin);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as { payer: Payer }).payer.viewerIsPayer).toBe(false);
  });

  it("review M-1: a plain member who pays for one add-on sees only their own agreement — no billing owner, no contract owner, nobody else's subscription", async () => {
    const o = await organization();
    const alice = await member(o, "ORG_MEMBER");
    const addon = await prisma.workspaceStorageAddon.create({
      data: {
        teamId: o.workspaceId,
        ownerUserId: alice.userId,
        addonKey: "TEAM_100_GB",
        extraStorageBytes: BigInt(10 * 1024 ** 3),
        status: "ACTIVE",
        billingCycle: "MONTHLY",
        externalSubscriptionId: `sub_addon_${randomUUID().slice(0, 10)}`,
        currentPeriodEnd: new Date(Date.now() + 10 * 86_400_000),
      } as never,
      select: { id: true },
    });
    const res = await payerOf(o, alice);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { payer: Payer; scope?: string };
    expect(body.payer.billingOwner).toBeNull();
    expect(body.payer.contractOwnerUserId).toBeNull();
    expect(body.payer.state).toBe("VIEWER_OWN_AGREEMENTS_ONLY");
    expect(body.payer.guidance).not.toContain("PAYER_UNCHANGED_BY_OWNERSHIP_TRANSFER");
    expect(body.payer.agreements.map((a) => a.id)).toEqual([addon.id]);
    expect(body.payer.agreements[0]).toMatchObject({ payerIsViewer: true });
    expect(res.body).not.toContain(o.owner.userId);
    expect(res.body).not.toContain(o.subscriptionId);
    expect(body.payer.guidance).not.toContain("VIEWER_CANNOT_CANCEL_PAYER_AGREEMENT");
    expect(body.scope).toBe("own");
    // The owner (a billing role) still reads the whole projection, both agreements.
    const full = (await payerOf(o, o.owner).then((r) => r.json())) as { payer: Payer };
    expect(full.payer.agreements.map((a) => a.id).sort()).toEqual([addon.id, o.subscriptionId].sort());
  });

  it("the new owner has no hidden liability and cannot cancel the former owner's agreement", async () => {
    const o = await organization();
    const recipient = await member(o, "ORG_ADMIN");
    await transfer(o, recipient);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/billing/subscription/cancel",
      headers: bearer(recipient.token),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "SUBSCRIPTION_NOT_FOUND" } });
    expect(await subscriptionRow(o)).toMatchObject({
      userId: o.owner.userId,
      teamId: o.workspaceId,
      status: "ACTIVE",
      cancelAtPeriodEnd: false,
      canceledAtUtc: null,
    });
    // Nothing bills the new owner.
    expect(await prisma.subscription.count({ where: { userId: recipient.userId } })).toBe(0);
  });

  it("the former payer may leave only after acknowledging they keep paying; nothing moves; the projection then says the payer left; closure names the other payer", async () => {
    const o = await organization();
    const recipient = await member(o, "ORG_ADMIN");
    await transfer(o, recipient);

    const refused = await leave(o, o.owner);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({
      error: {
        code: "PAYER_OBLIGATION_ACKNOWLEDGEMENT_REQUIRED",
        details: {
          isBillingOwner: true,
          isContractOwner: true,
          renewingAgreements: [expect.objectContaining({ id: o.subscriptionId })],
          guidance: ["PAYER_CANCELS_IN_OWN_BILLING", "HANDOVER_VIA_ACCOUNT_MANAGER"],
        },
      },
    });
    expect(
      await prisma.organizationMembership.findFirstOrThrow({
        where: { organizationId: o.orgId, userId: o.owner.userId },
        select: { status: true },
      }),
    ).toEqual({ status: "ACTIVE" });

    const left = await leave(o, o.owner, { acknowledgePayerObligation: true });
    expect(left.statusCode, left.body).toBe(200);
    expect(
      await prisma.organizationMembership.findFirstOrThrow({
        where: { organizationId: o.orgId, userId: o.owner.userId },
        select: { status: true },
      }),
    ).toEqual({ status: "REVOKED" });
    // Leaving moved no liability.
    expect(await subscriptionRow(o)).toMatchObject({ userId: o.owner.userId, status: "ACTIVE", cancelAtPeriodEnd: false });
    expect(
      await prisma.organization.findUniqueOrThrow({ where: { id: o.orgId }, select: { billingOwnerUserId: true } }),
    ).toEqual({ billingOwnerUserId: o.owner.userId });

    const after = (await payerOf(o, recipient).then((r) => r.json())) as { payer: Payer };
    expect(after.payer).toMatchObject({ state: "PAYER_LEFT_ORGANIZATION", billingOwner: { membership: "LEFT" } });

    const closure = await h.app.inject({ method: "GET", url: `/v1/orgs/${o.orgId}/closure`, headers: bearer(recipient.token) });
    expect(closure.statusCode, closure.body).toBe(200);
    const blocker = (closure.json() as { blockers: Array<{ code: string; billedToOtherPayer?: number; message: string }> }).blockers.find(
      (x) => x.code === "BILLING_SUBSCRIPTION_ACTIVE",
    );
    expect(blocker).toMatchObject({ billedToOtherPayer: 1 });
    expect(blocker!.message).toMatch(/another person/);
  });

  it("controls: a member who pays nothing leaves without acknowledgement; a payer whose agreement is already stopping and who holds no owner record leaves without it too", async () => {
    const o = await organization();
    const plain = await member(o, "ORG_MEMBER");
    const ok = await leave(o, plain);
    expect(ok.statusCode, ok.body).toBe(200);

    const stopping = await member(o, "ORG_MEMBER");
    await prisma.subscription.create({
      data: {
        userId: stopping.userId,
        teamId: o.workspaceId,
        provider: "STRIPE",
        providerSubId: `sub_${randomUUID().slice(0, 12)}`,
        status: "ACTIVE",
        plan: "TEAM",
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000),
      } as never,
    });
    const ok2 = await leave(o, stopping);
    expect(ok2.statusCode, ok2.body).toBe(200);

    const renewing = await member(o, "ORG_MEMBER");
    await prisma.subscription.create({
      data: {
        userId: renewing.userId,
        teamId: o.workspaceId,
        provider: "STRIPE",
        providerSubId: `sub_${randomUUID().slice(0, 12)}`,
        status: "ACTIVE",
        plan: "TEAM",
        currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000),
      } as never,
    });
    const refused = await leave(o, renewing);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: "PAYER_OBLIGATION_ACKNOWLEDGEMENT_REQUIRED" } });
  });
});
