/**
 * WORKSPACE AND COLLABORATION RECONCILIATION — CLOSURE, part 4:
 * TEAM as a commercial plan, end to end, against live PostgreSQL 16.
 *
 * "TEAM is purchasable" is a sentence, not a proof. The claim the model
 * actually rests on is stronger and has several parts, and every one of them
 * would be a serious defect if it were wrong:
 *
 *   * a TEAM purchase reaches the person's PERSONAL entitlement, and writes no
 *     Enterprise billing column;
 *   * it CREATES no workspace and TRANSFORMS none — same ids, same kinds, same
 *     evidence, cases, members and groups;
 *   * the entitlement it writes changes exactly two things: seats 5 → 10 and
 *     collaboration groups 2 → 5;
 *   * a duplicate webhook delivery changes nothing;
 *   * an unsigned or wrongly-signed webhook changes nothing;
 *   * TEAM → PRO evicts nobody, names what is over, blocks growth and leaves
 *     corrective and security actions available;
 *   * a FREE person invited into a TEAM workspace spends one of ITS seats,
 *     acts there by their workspace role, and gains nothing in their own.
 *
 * The provider is not contacted. The webhook is the point where provider truth
 * enters the system, and it is driven here exactly as Stripe drives it: a raw
 * body, a real HMAC over it with the configured secret, through the real route.
 */

import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedPersonalTenant,
  seedUser,
  type FixtureDeps,
} from "./point7/product-fixtures.js";

type Prisma = typeof import("../src/db.js")["prisma"];

describe("WCR closure — TEAM as a commercial plan (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let deps: FixtureDeps;
  let webhookSecret: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    /**
     * A LOCAL webhook secret, set for this process only.
     *
     * The harness does not configure one, and the route REFUSES when it is
     * missing — correctly, and that refusal is itself worth having, but it
     * would make every case below pass for the wrong reason. Setting a local
     * value means the signature under test is the real HMAC the route
     * verifies, over the exact bytes delivered, rather than a bypass.
     *
     * It is a random per-run value that exists only in this process. Nothing
     * external is contacted: the webhook is where provider TRUTH enters the
     * system, and driving it directly is what proves the entry point.
     */
    webhookSecret =
      process.env.STRIPE_WEBHOOK_SECRET ??
      `whsec_local_${randomUUID().replace(/-/g, "")}`;
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    deps = {
      prisma: prisma as never,
      tag: `wcrc-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          {
            sub: userId,
            provider: "EMAIL",
            email,
            authMethod: "PASSWORD",
            authAt: Math.floor(Date.now() / 1000),
          },
          secret,
          60 * 60,
        ),
    };
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // -------------------------------------------------------------------------
  // The provider boundary, driven the way the provider drives it
  // -------------------------------------------------------------------------

  function stripeEvent(opts: {
    id?: string;
    type: string;
    userId: string;
    plan: string;
    subscriptionId: string;
    status: string;
  }) {
    return JSON.stringify({
      id: opts.id ?? `evt_${randomUUID().replace(/-/g, "")}`,
      type: opts.type,
      data: {
        object: {
          id: opts.subscriptionId,
          status: opts.status,
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
          metadata: { userId: opts.userId, plan: opts.plan },
        },
      },
    });
  }

  /** A genuine Stripe signature header over these exact bytes. */
  function sign(raw: string, opts: { secret?: string; nowSec?: number } = {}) {
    const t = opts.nowSec ?? Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", opts.secret ?? webhookSecret)
      .update(`${t}.${raw}`)
      .digest("hex");
    return `t=${t},v1=${v1}`;
  }

  const deliver = (raw: string, signature: string | null) =>
    h.app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        ...(signature ? { "stripe-signature": signature } : {}),
      },
      payload: raw,
    });

  const entitlementOf = (userId: string) =>
    prisma.entitlement.findFirst({
      where: { userId, active: true },
      select: { plan: true },
    });

  async function capabilitiesOf(userId: string) {
    const { getPersonalWorkspaceScope } = await import(
      "../src/services/workspace-billing.service.js"
    );
    const { getPlanCapabilities } = await import("@proovra/shared-billing");
    const scope = await getPersonalWorkspaceScope(userId);
    return getPlanCapabilities(scope.plan);
  }

  /** Everything a purchase must leave exactly as it found it. */
  async function shapeOf(userId: string) {
    const workspaces = await prisma.team.findMany({
      where: { ownerUserId: userId },
      select: {
        id: true,
        workspaceKind: true,
        isPersonal: true,
        organizationId: true,
      },
      orderBy: { id: "asc" },
    });
    const ids = workspaces.map((w) => w.id);
    return {
      workspaces,
      organizations: await prisma.organization.count({
        where: { billingOwnerUserId: userId },
      }),
      evidence: await prisma.evidence.count({ where: { teamId: { in: ids } } }),
      cases: await prisma.case.count({ where: { teamId: { in: ids } } }),
      members: await prisma.teamMember.count({ where: { teamId: { in: ids } } }),
      groups: await prisma.collaborationTeam.count({
        where: { workspaceId: { in: ids } },
      }),
    };
  }

  // =========================================================================
  // Signature + idempotency
  // =========================================================================

  describe("the provider boundary", () => {
    it("an UNSIGNED delivery is refused and changes nothing", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const raw = stripeEvent({
        type: "customer.subscription.updated",
        userId: t.owner.userId,
        plan: "TEAM",
        subscriptionId: `sub_${randomUUID().slice(0, 8)}`,
        status: "active",
      });
      const res = await deliver(raw, null);
      expect(res.statusCode).toBe(400);
      expect((await entitlementOf(t.owner.userId))?.plan).toBe("PRO");
    });

    it("a WRONGLY-signed delivery is refused and changes nothing", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const raw = stripeEvent({
        type: "customer.subscription.updated",
        userId: t.owner.userId,
        plan: "TEAM",
        subscriptionId: `sub_${randomUUID().slice(0, 8)}`,
        status: "active",
      });
      const res = await deliver(raw, sign(raw, { secret: "not-the-secret" }));
      expect(res.statusCode).toBe(400);
      expect((await entitlementOf(t.owner.userId))?.plan).toBe("PRO");
    });

    it("a signature over DIFFERENT bytes is refused", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const raw = stripeEvent({
        type: "customer.subscription.updated",
        userId: t.owner.userId,
        plan: "TEAM",
        subscriptionId: `sub_${randomUUID().slice(0, 8)}`,
        status: "active",
      });
      const other = stripeEvent({
        type: "customer.subscription.updated",
        userId: t.owner.userId,
        plan: "PRO",
        subscriptionId: `sub_${randomUUID().slice(0, 8)}`,
        status: "active",
      });
      const res = await deliver(raw, sign(other));
      expect(res.statusCode).toBe(400);
      expect((await entitlementOf(t.owner.userId))?.plan).toBe("PRO");
    });

    it("a DUPLICATE delivery is a no-op, and the second one is recorded once", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const eventId = `evt_${randomUUID().replace(/-/g, "")}`;
      const raw = stripeEvent({
        id: eventId,
        type: "customer.subscription.updated",
        userId: t.owner.userId,
        plan: "TEAM",
        subscriptionId: `sub_${randomUUID().slice(0, 8)}`,
        status: "active",
      });
      const signature = sign(raw);

      const first = await deliver(raw, signature);
      expect(first.statusCode).toBe(200);
      const afterFirst = await shapeOf(t.owner.userId);

      const second = await deliver(raw, signature);
      expect(second.statusCode).toBe(200);
      const afterSecond = await shapeOf(t.owner.userId);

      expect(afterSecond).toEqual(afterFirst);
      expect(
        await prisma.stripeWebhookEvent.count({
          where: { stripeEventId: eventId },
        }),
      ).toBe(1);
      // One subscription row, not two.
      expect(
        await prisma.subscription.count({ where: { userId: t.owner.userId } }),
      ).toBe(1);
    });
  });

  // =========================================================================
  // PRO → TEAM
  // =========================================================================

  describe("PRO → TEAM", () => {
    it("writes the PERSONAL entitlement, creates nothing, and raises exactly two limits", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const beforeCaps = await capabilitiesOf(t.owner.userId);
      expect(beforeCaps.maxWorkspaceSeats).toBe(5);
      expect(beforeCaps.maxCollaborationTeamsPerWorkspace).toBe(2);

      // Make the "nothing is transformed" assertion non-vacuous: the workspace
      // holds real work before the purchase.
      await prisma.evidence.create({
        data: {
          ownerUserId: t.owner.userId,
          teamId: t.personalTeamId,
          organizationId: t.personalOrganizationId,
          type: "PHOTO",
        },
      });
      const withWork = await shapeOf(t.owner.userId);
      expect(withWork.evidence).toBeGreaterThan(0);

      const raw = stripeEvent({
        type: "customer.subscription.updated",
        userId: t.owner.userId,
        plan: "TEAM",
        subscriptionId: `sub_${randomUUID().slice(0, 8)}`,
        status: "active",
      });
      expect((await deliver(raw, sign(raw))).statusCode).toBe(200);

      // The entitlement moved …
      expect((await entitlementOf(t.owner.userId))?.plan).toBe("TEAM");
      const afterCaps = await capabilitiesOf(t.owner.userId);
      expect(afterCaps.maxWorkspaceSeats).toBe(10);
      expect(afterCaps.maxCollaborationTeamsPerWorkspace).toBe(5);

      // … and NOTHING else did.
      const after = await shapeOf(t.owner.userId);
      expect(after).toEqual(withWork);
      expect(after.workspaces.every((w) => w.workspaceKind === "PERSONAL")).toBe(
        true,
      );

      // No Enterprise billing state was written on the way.
      const ws = await prisma.team.findUniqueOrThrow({
        where: { id: t.personalTeamId },
        select: {
          billingPlan: true,
          billingStatus: true,
          includedSeats: true,
          organizationId: true,
        },
      });
      expect(ws.billingPlan).not.toBe("TEAM");
      expect(ws.includedSeats ?? 0).toBe(0);
      // The personal workspace is backed by an internal SYSTEM container, and
      // buying TEAM must not turn it into a CUSTOMER organization with a
      // contract — that is what "TEAM is a plan, not a workspace" means at the
      // level of the rows.
      const orgs = await prisma.organization.findMany({
        where: { id: ws.organizationId! },
        select: { kind: true, status: true },
      });
      for (const org of orgs) {
        expect(org.kind).toBe("SYSTEM");
      }
      expect(
        await prisma.enterpriseContract.count({
          where: { organizationId: ws.organizationId! },
        }),
      ).toBe(0);
    });

    it("the seat authority reports the new ceiling for the SAME workspace", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const seats = await import(
        "../src/services/billing/workspace-seats.service.js"
      );
      expect(
        (await seats.resolveWorkspaceSeatState(t.personalTeamId, prisma as never))
          .limit,
      ).toBe(5);

      const raw = stripeEvent({
        type: "customer.subscription.updated",
        userId: t.owner.userId,
        plan: "TEAM",
        subscriptionId: `sub_${randomUUID().slice(0, 8)}`,
        status: "active",
      });
      expect((await deliver(raw, sign(raw))).statusCode).toBe(200);

      const after = await seats.resolveWorkspaceSeatState(
        t.personalTeamId,
        prisma as never,
      );
      expect(after.limit).toBe(10);
      expect(after.plan).toBe("TEAM");
    });
  });

  // =========================================================================
  // TEAM → PRO
  // =========================================================================

  describe("TEAM → PRO", () => {
    it("evicts nobody, names what is over, blocks growth, and leaves corrective actions", async () => {
      const t = await seedPersonalTenant(deps, "TEAM");
      const invites = await import(
        "../src/services/identity/workspace-invitation.service.js"
      );
      const svc = await import(
        "../src/services/collaboration-team/collaboration-team.service.js"
      );

      // Fill past what PRO allows: seven active members and three groups.
      for (let i = 0; i < 6; i += 1) {
        const email = `wcrc-down-${i}-${randomUUID().slice(0, 6)}@x.test`;
        const created = await invites.createWorkspaceInvitation(
          {
            workspaceId: t.personalTeamId,
            email,
            role: "MEMBER",
            invitedByUserId: t.owner.userId,
          },
          prisma as never,
        );
        const u = await seedUser(deps, `down-${i}`);
        await prisma.user.update({ where: { id: u.userId }, data: { email } });
        await invites.acceptWorkspaceInvitation(
          { rawToken: created.rawToken, actorUserId: u.userId },
          prisma as never,
        );
      }
      for (const name of ["one", "two", "three"]) {
        await svc.createCollaborationTeam({
          workspaceId: t.personalTeamId,
          actorUserId: t.owner.userId,
          name: `down ${name}`,
        });
      }
      const beforeMembers = await prisma.teamMember.count({
        where: { teamId: t.personalTeamId, status: "ACTIVE" },
      });
      const beforeGroups = await prisma.collaborationTeam.count({
        where: { workspaceId: t.personalTeamId, status: "ACTIVE" },
      });
      expect(beforeMembers).toBe(7);
      expect(beforeGroups).toBe(3);

      const raw = stripeEvent({
        type: "customer.subscription.updated",
        userId: t.owner.userId,
        plan: "PRO",
        subscriptionId: `sub_${randomUUID().slice(0, 8)}`,
        status: "active",
      });
      expect((await deliver(raw, sign(raw))).statusCode).toBe(200);
      expect((await entitlementOf(t.owner.userId))?.plan).toBe("PRO");

      // NOBODY was evicted and nothing was archived. A downgrade is a change of
      // what you may ADD, never a deletion of what you have.
      expect(
        await prisma.teamMember.count({
          where: { teamId: t.personalTeamId, status: "ACTIVE" },
        }),
      ).toBe(beforeMembers);
      expect(
        await prisma.collaborationTeam.count({
          where: { workspaceId: t.personalTeamId, status: "ACTIVE" },
        }),
      ).toBe(beforeGroups);

      // The projection NAMES what is over, rather than reporting a generic
      // problem the surface has to guess at.
      const { resolveCollaborationEntitlement } = await import(
        "../src/services/collaboration-team/collaboration-entitlement.service.js"
      );
      const projection = await resolveCollaborationEntitlement(t.personalTeamId);
      expect(projection.workspaceSeats.limit).toBe(5);
      expect(projection.workspaceSeats.used).toBe(7);
      expect(projection.workspaceSeats.overLimit).toBe(true);
      expect(projection.collaborationTeams.limit).toBe(2);
      expect(projection.collaborationTeams.used).toBe(3);
      expect(projection.exceededDimensions).toEqual(
        expect.arrayContaining(["WORKSPACE_SEATS", "COLLABORATION_TEAMS"]),
      );
      expect(projection.upgradeHref).toBeTruthy();

      // GROWTH is blocked — a new group and a new member both refuse.
      let groupOutcome = "ALLOWED";
      try {
        await svc.createCollaborationTeam({
          workspaceId: t.personalTeamId,
          actorUserId: t.owner.userId,
          name: "one too many",
        });
      } catch (err) {
        groupOutcome = (err as { code?: string }).code ?? "UNTYPED";
      }
      expect(groupOutcome).not.toBe("ALLOWED");

      const email = `wcrc-blocked-${randomUUID().slice(0, 6)}@x.test`;
      const created = await invites.createWorkspaceInvitation(
        {
          workspaceId: t.personalTeamId,
          email,
          role: "MEMBER",
          invitedByUserId: t.owner.userId,
        },
        prisma as never,
      );
      const blocked = await seedUser(deps, "blocked");
      await prisma.user.update({
        where: { id: blocked.userId },
        data: { email },
      });
      let acceptOutcome = "ALLOWED";
      try {
        await invites.acceptWorkspaceInvitation(
          { rawToken: created.rawToken, actorUserId: blocked.userId },
          prisma as never,
        );
      } catch (err) {
        acceptOutcome = (err as { code?: string }).code ?? "UNTYPED";
      }
      expect(acceptOutcome).toBe("WORKSPACE_SEAT_LIMIT_REACHED");

      // CORRECTIVE actions remain available — an over-limit workspace must be
      // able to get back under the limit, and to revoke access in a hurry.
      const removable = await prisma.teamMember.findFirstOrThrow({
        where: {
          teamId: t.personalTeamId,
          status: "ACTIVE",
          role: "MEMBER",
        },
        select: { id: true, userId: true },
      });
      const membership = await import(
        "../src/services/identity/membership-provisioning.service.js"
      );
      await membership.changeMemberRole(
        {
          teamId: t.personalTeamId,
          teamMemberId: removable.id,
          actorUserId: t.owner.userId,
          newRole: "VIEWER",
          ipAddress: null,
          userAgent: null,
        },
        prisma as never,
      );
      expect(
        (
          await prisma.teamMember.findUniqueOrThrow({
            where: { id: removable.id },
            select: { role: true },
          })
        ).role,
      ).toBe("VIEWER");

      const groups = await prisma.collaborationTeam.findFirstOrThrow({
        where: { workspaceId: t.personalTeamId, status: "ACTIVE" },
        select: { id: true },
      });
      await svc.archiveCollaborationTeam({
        teamId: groups.id,
        actorUserId: t.owner.userId,
      });
      expect(
        await prisma.collaborationTeam.count({
          where: { workspaceId: t.personalTeamId, status: "ACTIVE" },
        }),
      ).toBe(beforeGroups - 1);
    });
  });

  // =========================================================================
  // Subscription states
  // =========================================================================

  describe("subscription states", () => {
    it("CANCELED returns the person to FREE; TRIALING leaves the entitlement alone", async () => {
      const t = await seedPersonalTenant(deps, "TEAM");
      const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;

      const trialing = stripeEvent({
        type: "customer.subscription.updated",
        userId: t.owner.userId,
        plan: "PRO",
        subscriptionId,
        status: "trialing",
      });
      expect((await deliver(trialing, sign(trialing))).statusCode).toBe(200);
      // A trial does not silently move a paid entitlement.
      expect((await entitlementOf(t.owner.userId))?.plan).toBe("TEAM");

      const canceled = stripeEvent({
        type: "customer.subscription.deleted",
        userId: t.owner.userId,
        plan: "TEAM",
        subscriptionId,
        status: "canceled",
      });
      expect((await deliver(canceled, sign(canceled))).statusCode).toBe(200);
      expect((await entitlementOf(t.owner.userId))?.plan).toBe("FREE");

      // And FREE means what it says: one seat, no groups.
      const caps = await capabilitiesOf(t.owner.userId);
      expect(caps.maxWorkspaceSeats).toBe(1);
      expect(caps.maxCollaborationTeamsPerWorkspace).toBe(0);
    });
  });

  // =========================================================================

  // =========================================================================
  // The purchase DECISION, up to the provider boundary
  // =========================================================================

  describe("the purchase decision", () => {
    it("the pricing offer includes TEAM, and it is purchasable for a personal workspace", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const res = await h.app.inject({
        method: "GET",
        url: "/v1/billing/pricing",
        headers: { authorization: `Bearer ${t.owner.token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.stringify(res.json())).toContain("TEAM");

      const { canPlanPurchasePersonalWorkspacePlan, getPlanCapabilities } =
        await import("@proovra/shared-billing");
      expect(canPlanPurchasePersonalWorkspacePlan("TEAM")).toBe(true);
      // …and buying it is what raises these two, which is the whole offer.
      expect(getPlanCapabilities("TEAM").maxWorkspaceSeats).toBe(10);
      expect(getPlanCapabilities("TEAM").maxCollaborationTeamsPerWorkspace).toBe(5);
    });

    it("the checkout SUBJECT is the personal account, and a duplicate is refused before any provider call", async () => {
      /**
       * The provider session itself is a network call, and this suite contacts
       * nothing external — so what is proven here is every decision the route
       * makes BEFORE it: which subject pays, and whether a checkout is the
       * right operation at all.
       *
       * That boundary is the one that mattered. A `teamId` in the body used to
       * select an Owned Workspace as the payer, which is how TEAM became a
       * purchase FOR a different workspace instead of an upgrade of this one.
       */
      const t = await seedPersonalTenant(deps, "TEAM");
      await prisma.subscription.create({
        data: {
          userId: t.owner.userId,
          provider: "STRIPE",
          providerSubId: `sub_live_${randomUUID().slice(0, 8)}`,
          status: "ACTIVE",
          plan: "TEAM",
        },
      });

      const res = await h.app.inject({
        method: "POST",
        url: "/v1/billing/checkout/stripe",
        headers: {
          authorization: `Bearer ${t.owner.token}`,
          "content-type": "application/json",
        },
        payload: { plan: "TEAM", currency: "USD" },
      });
      // Someone who already holds it has a plan CHANGE, not a checkout — and
      // the refusal happens before any session is created.
      expect(res.statusCode).toBe(409);
      expect(
        await prisma.subscription.count({ where: { userId: t.owner.userId } }),
      ).toBe(1);
    });

    it("a plan nobody may buy self-service is refused before any provider call", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      for (const plan of ["ENTERPRISE", "PAYG"]) {
        const res = await h.app.inject({
          method: "POST",
          url: "/v1/billing/checkout/stripe",
          headers: {
            authorization: `Bearer ${t.owner.token}`,
            "content-type": "application/json",
          },
          payload: { plan, currency: "USD" },
        });
        expect(res.statusCode, plan).toBeGreaterThanOrEqual(400);
        expect(res.statusCode, plan).toBeLessThan(500);
      }
      expect(
        await prisma.subscription.count({ where: { userId: t.owner.userId } }),
      ).toBe(0);
    });
  });
  // A FREE person inside a TEAM workspace
  // =========================================================================

  describe("a FREE person inside a TEAM workspace", () => {
    it("spends one of ITS seats, acts by their workspace role, and gains nothing in their own", async () => {
      const host = await seedPersonalTenant(deps, "TEAM");
      const guest = await seedPersonalTenant(deps, "FREE");

      const invites = await import(
        "../src/services/identity/workspace-invitation.service.js"
      );
      const seats = await import(
        "../src/services/billing/workspace-seats.service.js"
      );
      const before = await seats.resolveWorkspaceSeatState(
        host.personalTeamId,
        prisma as never,
      );

      const created = await invites.createWorkspaceInvitation(
        {
          workspaceId: host.personalTeamId,
          email: guest.owner.email,
          role: "ADMIN",
          invitedByUserId: host.owner.userId,
        },
        prisma as never,
      );
      await invites.acceptWorkspaceInvitation(
        { rawToken: created.rawToken, actorUserId: guest.owner.userId },
        prisma as never,
      );

      // ONE seat, in the HOST workspace.
      const after = await seats.resolveWorkspaceSeatState(
        host.personalTeamId,
        prisma as never,
      );
      expect(after.used).toBe(before.used + 1);
      expect(after.limit).toBe(10);

      // They act there by their WORKSPACE ROLE — ADMIN, which the host granted
      // — and not by their own plan.
      const member = await prisma.teamMember.findFirstOrThrow({
        where: { teamId: host.personalTeamId, userId: guest.owner.userId },
        select: { role: true, status: true },
      });
      expect(member).toEqual({ role: "ADMIN", status: "ACTIVE" });

      // Their OWN entitlement is untouched: still FREE.
      expect((await entitlementOf(guest.owner.userId))?.plan).toBe("FREE");
      const ownCaps = await capabilitiesOf(guest.owner.userId);
      expect(ownCaps.maxWorkspaceSeats).toBe(1);
      expect(ownCaps.maxCollaborationTeamsPerWorkspace).toBe(0);

      // And their own workspace gained nothing: no group can be created there.
      const svc = await import(
        "../src/services/collaboration-team/collaboration-team.service.js"
      );
      let outcome = "ALLOWED";
      try {
        await svc.createCollaborationTeam({
          workspaceId: guest.personalTeamId,
          actorUserId: guest.owner.userId,
          name: "not mine to make",
        });
      } catch (err) {
        outcome = (err as { code?: string }).code ?? "UNTYPED";
      }
      expect(outcome).toBe("TEAM_PLAN_REQUIRED");

      // The capability is resolved per WORKSPACE: the same person CAN act in
      // the host's, which is what makes the refusal above about the workspace
      // rather than about them.
      const hostSeats = await seats.resolveWorkspaceSeatState(
        host.personalTeamId,
        prisma as never,
      );
      expect(hostSeats.featureIncluded).toBe(true);
      const guestSeats = await seats.resolveWorkspaceSeatState(
        guest.personalTeamId,
        prisma as never,
      );
      expect(guestSeats.featureIncluded).toBe(false);
    });
  });
});
