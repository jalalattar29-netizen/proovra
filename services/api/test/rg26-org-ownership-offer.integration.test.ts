/**
 * NEW-RG-26-4 / owner decision E (DEC-18) — organization ownership moves by
 * OFFER, recipient ACCEPTANCE and step-up, on the real routes and a live
 * PostgreSQL.
 *
 * Before: POST /v1/orgs/:id/transfer-ownership made the target the
 * organization owner (and the owner, billing owner and contract owner of the
 * organization's workspaces) in one call, with no acceptance by the target.
 *
 * Now the route records an offer (202, nothing moves); the named recipient
 * accepts with their own step-up at POST /v1/orgs/:id/ownership-offer/:id/accept.
 * Authority and eligibility are judged again at acceptance, competing offers
 * and acceptances are serialized, and the payer (Organization / Team
 * billingOwnerUserId, the contract owner, provider subscriptions) never moves.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, SeededUser } from "./point7/product-fixtures.js";

describe("NEW-RG-26-4 — organization ownership by offer, acceptance and step-up", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let fx: typeof import("./point7/product-fixtures.js");
  let hashPassword: (typeof import("../src/services/email-password-auth.service.js"))["hashPassword"];
  let scim: typeof import("../src/services/access-control/scim.service.js");
  let provisioningSvc: typeof import("../src/services/identity/membership-provisioning.service.js");
  let offerSvc: typeof import("../src/services/organization/org-ownership-offer.service.js");
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
    scim = await import("../src/services/access-control/scim.service.js");
    provisioningSvc = await import("../src/services/identity/membership-provisioning.service.js");
    offerSvc = await import("../src/services/organization/org-ownership-offer.service.js");
    const jwt = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `rg264-${Date.now().toString(36)}`,
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
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(PASSWORD) } });
  }

  async function organization(): Promise<Org> {
    const t = await fx.seedOrganizationTenant(deps);
    await withPassword(t.owner.userId);
    await prisma.enterpriseContract.update({
      where: { organizationId: t.organizationId },
      data: { contractOwnerUserId: t.owner.userId },
    });
    // A provider subscription the outgoing owner pays for this workspace.
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

  async function member(o: Org, role: "ORG_ADMIN" | "ORG_MEMBER" | "ORG_AUDITOR" = "ORG_ADMIN") {
    const u = await fx.seedUser(deps, `m-${role.toLowerCase()}`);
    await withPassword(u.userId);
    const m = await prisma.organizationMembership.create({
      data: { organizationId: o.orgId, userId: u.userId, role },
      select: { id: true },
    });
    await prisma.teamMember.create({ data: { teamId: o.workspaceId, userId: u.userId, role: "MEMBER", status: "ACTIVE" } });
    return { ...u, membershipId: m.id };
  }

  const offer = (o: Org, actor: { token: string }, targetUserId: string, body: Record<string, unknown> = proof) =>
    h.app.inject({
      method: "POST",
      url: `/v1/orgs/${o.orgId}/transfer-ownership`,
      headers: bearer(actor.token),
      payload: { targetUserId, ...body },
    });

  const act = (o: Org, actor: { token: string }, offerId: string, kind: "accept" | "decline" | "cancel", body: Record<string, unknown> = {}) =>
    h.app.inject({
      method: "POST",
      url: `/v1/orgs/${o.orgId}/ownership-offer/${offerId}/${kind}`,
      headers: bearer(actor.token),
      payload: body,
    });

  const owners = async (orgId: string) =>
    (
      await prisma.organizationMembership.findMany({
        where: { organizationId: orgId, role: "ORG_OWNER", status: "ACTIVE" },
        select: { userId: true },
      })
    ).map((r) => r.userId);

  /** Ownership and the payer are exactly as seeded. */
  async function expectNothingMoved(o: Org) {
    expect(await owners(o.orgId)).toEqual([o.owner.userId]);
    expect(await prisma.team.findUniqueOrThrow({ where: { id: o.workspaceId }, select: { ownerUserId: true } })).toEqual({
      ownerUserId: o.owner.userId,
    });
    expect(
      await prisma.teamMember.findUniqueOrThrow({
        where: { teamId_userId: { teamId: o.workspaceId, userId: o.owner.userId } },
        select: { role: true },
      }),
    ).toEqual({ role: "OWNER" });
  }

  async function expectPayerUnchanged(o: Org) {
    expect(
      await prisma.organization.findUniqueOrThrow({ where: { id: o.orgId }, select: { billingOwnerUserId: true } }),
    ).toEqual({ billingOwnerUserId: o.owner.userId });
    expect(
      await prisma.team.findUniqueOrThrow({ where: { id: o.workspaceId }, select: { billingOwnerUserId: true } }),
    ).toEqual({ billingOwnerUserId: o.owner.userId });
    expect(
      await prisma.enterpriseContract.findUniqueOrThrow({
        where: { organizationId: o.orgId },
        select: { contractOwnerUserId: true },
      }),
    ).toEqual({ contractOwnerUserId: o.owner.userId });
    expect(
      await prisma.subscription.findUniqueOrThrow({ where: { id: o.subscriptionId }, select: { userId: true, teamId: true } }),
    ).toEqual({ userId: o.owner.userId, teamId: o.workspaceId });
  }

  async function pendingOffer(o: Org, recipient: { token: string; userId: string }) {
    const res = await offer(o, o.owner, recipient.userId);
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json() as { transferred: boolean; pendingAcceptance: boolean; offer: { id: string; status: string } };
    expect(body).toMatchObject({ transferred: false, pendingAcceptance: true, offer: { status: "PENDING" } });
    return body.offer.id;
  }

  it("an offer moves nothing; only its two parties can read it; a non-owner cannot make one", async () => {
    const o = await organization();
    const admin = await member(o, "ORG_ADMIN");
    const recipient = await member(o, "ORG_MEMBER");

    // A non-owner (an ORG_ADMIN, with a valid step-up) is refused, and no offer exists.
    const refused = await offer(o, admin, recipient.userId);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: "owner_required" } });
    expect(await prisma.organizationOwnershipOffer.count({ where: { organizationId: o.orgId } })).toBe(0);

    const offerId = await pendingOffer(o, recipient);
    await expectNothingMoved(o);
    await expectPayerUnchanged(o);

    for (const [who, visible] of [
      [o.owner, true],
      [recipient, true],
      [admin, false],
    ] as const) {
      const read = await h.app.inject({ method: "GET", url: `/v1/orgs/${o.orgId}/ownership-offer`, headers: bearer(who.token) });
      expect(read.statusCode, read.body).toBe(200);
      const b = read.json() as { offer: { id: string } | null; billingOwnerUserId?: string | null };
      if (visible) {
        expect(b.offer?.id).toBe(offerId);
        expect(b.billingOwnerUserId).toBe(o.owner.userId);
      } else {
        expect(b.offer).toBeNull();
      }
    }
  });

  it("acceptance by anyone but the recipient is refused, and acceptance without step-up is refused", async () => {
    const o = await organization();
    const recipient = await member(o, "ORG_ADMIN");
    const other = await member(o, "ORG_ADMIN");
    const offerId = await pendingOffer(o, recipient);

    for (const intruder of [other, o.owner]) {
      const res = await act(o, intruder, offerId, "accept", proof);
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: "ownership_offer_not_found" } });
    }
    const noProof = await act(o, recipient, offerId, "accept", {});
    expect(noProof.statusCode, noProof.body).toBe(401);
    expect(noProof.json()).toMatchObject({ error: { code: "STEP_UP_REQUIRED" } });
    const wrongProof = await act(o, recipient, offerId, "accept", {
      stepUp: { method: "password", currentPassword: "not-the-password-0000" },
    });
    expect(wrongProof.statusCode, wrongProof.body).toBe(401);

    await expectNothingMoved(o);
    expect(
      await prisma.organizationOwnershipOffer.findUniqueOrThrow({ where: { id: offerId }, select: { status: true } }),
    ).toEqual({ status: "PENDING" });
  });

  it("the recipient's stepped-up acceptance moves ownership; the payer stays exactly as it was", async () => {
    const o = await organization();
    const recipient = await member(o, "ORG_ADMIN");
    const offerId = await pendingOffer(o, recipient);

    const ok = await act(o, recipient, offerId, "accept", proof);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({
      transferred: true,
      newOwnerUserId: recipient.userId,
      previousOwnerUserId: o.owner.userId,
      billingOwnerTransferred: false,
      contractOwnerTransferred: false,
      billingOwnerUserId: o.owner.userId,
      workspacesTransferred: 1,
    });
    expect(await owners(o.orgId)).toEqual([recipient.userId]);
    expect(
      await prisma.organizationMembership.findFirstOrThrow({
        where: { organizationId: o.orgId, userId: o.owner.userId },
        select: { role: true, status: true },
      }),
    ).toEqual({ role: "ORG_ADMIN", status: "ACTIVE" });
    expect(await prisma.team.findUniqueOrThrow({ where: { id: o.workspaceId }, select: { ownerUserId: true } })).toEqual({
      ownerUserId: recipient.userId,
    });
    expect(
      await prisma.teamMember.findUniqueOrThrow({
        where: { teamId_userId: { teamId: o.workspaceId, userId: recipient.userId } },
        select: { role: true },
      }),
    ).toEqual({ role: "OWNER" });
    // Decision E: no payment liability moved.
    await expectPayerUnchanged(o);
    expect(
      await prisma.organizationOwnershipOffer.findUniqueOrThrow({ where: { id: offerId }, select: { status: true } }),
    ).toEqual({ status: "ACCEPTED" });
    const audit = await prisma.organizationAuditEvent.findFirstOrThrow({
      where: { organizationId: o.orgId, eventType: "ORG_OWNERSHIP_TRANSFERRED" },
      select: { metadata: true },
    });
    expect(audit.metadata).toMatchObject({ offerId, billingOwnerTransferred: false, contractOwnerTransferred: false });

    // Accepting twice is refused (the offer is spent).
    const again = await act(o, recipient, offerId, "accept", proof);
    expect(again.statusCode, again.body).toBe(404);
  });

  it("an offerer who lost ownership before acceptance cannot have it completed", async () => {
    const o = await organization();
    const recipient = await member(o, "ORG_ADMIN");
    const offerId = await pendingOffer(o, recipient);
    // The offerer is suspended after offering.
    await prisma.organizationMembership.updateMany({
      where: { organizationId: o.orgId, userId: o.owner.userId },
      data: { status: "SUSPENDED", suspendedAtUtc: new Date(), statusChangedAtUtc: new Date() },
    });

    const res = await act(o, recipient, offerId, "accept", proof);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "ownership_offer_offerer_not_owner" } });
    expect(
      await prisma.organizationMembership.findFirstOrThrow({
        where: { organizationId: o.orgId, userId: recipient.userId },
        select: { role: true },
      }),
    ).toEqual({ role: "ORG_ADMIN" });
    expect(await prisma.team.findUniqueOrThrow({ where: { id: o.workspaceId }, select: { ownerUserId: true } })).toEqual({
      ownerUserId: o.owner.userId,
    });
    expect(
      await prisma.organizationOwnershipOffer.findUniqueOrThrow({ where: { id: offerId }, select: { status: true } }),
    ).toEqual({ status: "SUPERSEDED" });
  });

  it("a recipient who is no longer eligible at acceptance (suspended or removed) is refused; the offer stays open", async () => {
    for (const after of [
      { status: "SUSPENDED" as const, suspendedAtUtc: new Date() },
      { status: "REVOKED" as const, revokedAtUtc: new Date() },
    ]) {
      const o = await organization();
      const recipient = await member(o, "ORG_ADMIN");
      const offerId = await pendingOffer(o, recipient);
      await prisma.organizationMembership.update({
        where: { id: recipient.membershipId },
        data: { ...after, statusChangedAtUtc: new Date() } as never,
      });
      const res = await act(o, recipient, offerId, "accept", proof);
      // A removed person no longer reaches the organization at all.
      expect([404, 409], res.body).toContain(res.statusCode);
      if (res.statusCode === 409) expect(res.json()).toMatchObject({ error: { code: "OWNER_TARGET_NOT_ACTIVE" } });
      await expectNothingMoved(o);
      await expectPayerUnchanged(o);
      expect(
        await prisma.organizationOwnershipOffer.findUniqueOrThrow({ where: { id: offerId }, select: { status: true } }),
      ).toEqual({ status: "PENDING" });
    }
  });

  it("an open closure refuses acceptance", async () => {
    const o = await organization();
    const recipient = await member(o, "ORG_ADMIN");
    const offerId = await pendingOffer(o, recipient);
    await prisma.organizationClosureRequest.create({
      data: { organizationId: o.orgId, requestedByUserId: o.owner.userId, status: "COOLING_OFF" },
    });
    const res = await act(o, recipient, offerId, "accept", proof);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "closure_in_progress" } });
    await expectNothingMoved(o);
  });

  it("competing offers leave one open offer, and competing acceptances let exactly one win", async () => {
    const o = await organization();
    const a = await member(o, "ORG_ADMIN");
    const b = await member(o, "ORG_ADMIN");

    // Two offers at once: both are recorded in turn, the later supersedes.
    const [ra, rb] = await Promise.all([offer(o, o.owner, a.userId), offer(o, o.owner, b.userId)]);
    expect([ra.statusCode, rb.statusCode]).toEqual([202, 202]);
    const rows = await prisma.organizationOwnershipOffer.findMany({
      where: { organizationId: o.orgId },
      select: { id: true, status: true, toUserId: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "PENDING")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "SUPERSEDED")).toHaveLength(1);

    // Both recipients race to accept their offer: exactly one ownership change.
    const offerOf = (userId: string) => rows.find((r) => r.toUserId === userId)!.id;
    const [aa, ab] = await Promise.all([
      act(o, a, offerOf(a.userId), "accept", proof),
      act(o, b, offerOf(b.userId), "accept", proof),
    ]);
    const codes = [aa.statusCode, ab.statusCode].sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c >= 400)).toHaveLength(1);
    const winner = aa.statusCode === 200 ? a : b;
    expect(await owners(o.orgId)).toEqual([winner.userId]);
    await expectPayerUnchanged(o);

    // The same recipient accepting twice concurrently: one success, one refusal.
    const o2 = await organization();
    const c = await member(o2, "ORG_ADMIN");
    const offerId = await pendingOffer(o2, c);
    const [c1, c2] = await Promise.all([
      act(o2, c, offerId, "accept", proof),
      act(o2, c, offerId, "accept", proof),
    ]);
    expect([c1.statusCode, c2.statusCode].filter((s) => s === 200)).toHaveLength(1);
    expect(await owners(o2.orgId)).toEqual([c.userId]);
    expect(
      await prisma.organizationMembership.count({ where: { organizationId: o2.orgId, role: "ORG_OWNER" } }),
    ).toBe(1);
  });

  it("the recipient may decline and the offerer may withdraw; neither can settle for the other", async () => {
    const o = await organization();
    const recipient = await member(o, "ORG_ADMIN");
    const first = await pendingOffer(o, recipient);
    expect((await act(o, o.owner, first, "decline")).statusCode).toBe(404);
    const declined = await act(o, recipient, first, "decline");
    expect(declined.statusCode, declined.body).toBe(200);
    expect(declined.json()).toMatchObject({ offer: { status: "DECLINED" } });

    const second = await pendingOffer(o, recipient);
    expect((await act(o, recipient, second, "cancel")).statusCode).toBe(404);
    const cancelled = await act(o, o.owner, second, "cancel");
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ offer: { status: "CANCELLED" } });
    const late = await act(o, recipient, second, "accept", proof);
    expect(late.statusCode).toBe(404);
    await expectNothingMoved(o);
  });

  // -------------------------------------------------------------------------
  // Review follow-ups: expiry is recorded; acceptance vs. directory suspension.
  // -------------------------------------------------------------------------

  it("an expired offer is refused 410 AND recorded EXPIRED (the write is not rolled back)", async () => {
    const o = await organization();
    const recipient = await member(o, "ORG_ADMIN");
    const offerId = await pendingOffer(o, recipient);
    await prisma.organizationOwnershipOffer.update({
      where: { id: offerId },
      data: { expiresAtUtc: new Date(Date.now() - 60_000) },
    });
    // The read route already hides it; the accept is addressed by id.
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/orgs/${o.orgId}/ownership-offer/${offerId}/accept`,
      headers: bearer(recipient.token),
      payload: proof,
    });
    // The route's pre-check finds no live offer for the recipient (404); the
    // service is asked directly so the expiry branch itself is exercised.
    expect([404, 410], res.body).toContain(res.statusCode);
    await expect(
      offerSvc.acceptOrganizationOwnershipOffer({ organizationId: o.orgId, offerId, actorUserId: recipient.userId }),
    ).rejects.toMatchObject({ statusCode: 410, code: "ownership_offer_expired" });
    expect(
      await prisma.organizationOwnershipOffer.findUniqueOrThrow({ where: { id: offerId }, select: { status: true } }),
    ).toEqual({ status: "EXPIRED" });
    await expectNothingMoved(o);
  });

  /** Make a member reachable by this Organization's directory (PRO-014 / PRO-A2-02). */
  async function directoryManaged(o: Org, userId: string) {
    await prisma.user.update({
      where: { id: userId },
      data: { providerUserId: `scim-${o.orgId}:rg264-${randomUUID()}` },
    });
    await prisma.externalIdentityMapping.create({
      data: {
        teamId: o.workspaceId,
        organizationId: o.orgId,
        userId,
        provider: "GENERIC_SCIM",
        externalSubjectId: `rg264-${randomUUID()}`,
      },
    });
  }
  const deactivate = (o: Org, userId: string) =>
    scim.scimDeactivateUser(
      { teamId: o.workspaceId, organizationId: o.orgId, tokenId: randomUUID(), baseUrl: "https://local.test" },
      userId,
      prisma as never,
    );

  it("a directory suspension waits for the owners' lock an acceptance holds", async () => {
    const o = await organization();
    const target = await member(o, "ORG_MEMBER");
    await directoryManaged(o, target.userId);
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
    let done = false;
    const suspension = deactivate(o, target.userId).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(done, "the directory suspension ran while the owners' lock was held").toBe(false);
    release();
    await holder;
    await suspension;
    expect(done).toBe(true);
    expect(
      await prisma.organizationMembership.findUniqueOrThrow({ where: { id: target.membershipId }, select: { status: true } }),
    ).toEqual({ status: "SUSPENDED" });
  });

  it("a directory push never suspends the organization owner's governance membership", async () => {
    const o = await organization();
    await directoryManaged(o, o.owner.userId);
    await deactivate(o, o.owner.userId);
    expect(await owners(o.orgId)).toEqual([o.owner.userId]);
  });

  it("acceptance racing a directory suspension of the recipient never leaves the organization without one live owner", async () => {
    for (let i = 0; i < 3; i += 1) {
      const o = await organization();
      const recipient = await member(o, "ORG_ADMIN");
      await directoryManaged(o, recipient.userId);
      const offerId = await pendingOffer(o, recipient);
      await Promise.allSettled([act(o, recipient, offerId, "accept", proof), deactivate(o, recipient.userId)]);
      const rows = await prisma.organizationMembership.findMany({
        where: { organizationId: o.orgId, role: "ORG_OWNER" },
        select: { userId: true, status: true },
      });
      expect(rows.filter((r) => r.status === "ACTIVE"), JSON.stringify(rows)).toHaveLength(1);
      expect(rows.filter((r) => r.status !== "ACTIVE"), JSON.stringify(rows)).toHaveLength(0);
    }
  });

  it("the guarded role write refuses a membership that is not ACTIVE", async () => {
    const o = await organization();
    const m = await member(o, "ORG_MEMBER");
    await prisma.organizationMembership.update({
      where: { id: m.membershipId },
      data: { status: "SUSPENDED", suspendedAtUtc: new Date(), statusChangedAtUtc: new Date() } as never,
    });
    await expect(
      provisioningSvc.updateOrganizationMembershipRole(prisma as never, {
        organizationMembershipId: m.membershipId,
        role: "ORG_OWNER",
        actorUserId: o.owner.userId,
        requireActive: true,
      }),
    ).rejects.toMatchObject({ name: "OrgMembershipNotActiveError" });
    expect(
      await prisma.organizationMembership.findUniqueOrThrow({ where: { id: m.membershipId }, select: { role: true } }),
    ).toEqual({ role: "ORG_MEMBER" });
  });
});
