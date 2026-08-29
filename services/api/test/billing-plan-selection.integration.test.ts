/**
 * BILLING PLAN SELECTION — which flow an account is in, against live
 * PostgreSQL 16.
 *
 * THE DEFECT THIS SUITE EXISTS TO STOP RETURNING
 * ---------------------------------------------------------------------------
 * A FREE customer opened plan management and was shown:
 *
 *     Upgrade to Pro: Pro starts straight away. Your provider charges the
 *     difference for the rest of this period, and nothing you have already
 *     recorded changes.
 *
 *     End subscription
 *     Your account moves to Free on the same workspace.
 *
 * and, on pressing it, was told "You will move to Pro at the end of this
 * billing period" — without ever being shown a payment method, and without a
 * single cent leaving their account.
 *
 * Every one of those sentences is false for a FREE account. It has no paid
 * subscription, no billing period, no remaining-period difference to charge,
 * and nothing for a provider to cancel.
 *
 * WHY IT HAPPENED
 * ---------------------------------------------------------------------------
 * Two authorities that can disagree were read as one. The ENTITLEMENT said
 * FREE; a non-terminal `Subscription` row said PRO or TEAM. Both the projection
 * and the plan-transition resolver believed the row alone, so the account was
 * projected as a SUBSCRIPTION (mode MANAGE), both tiers came back as UPGRADEs,
 * and the transition compared the request against the ROW's plan — resolving a
 * FREE customer's request for PRO as a TEAM → PRO downgrade and scheduling it
 * at period end.
 *
 * These are behaviour tests over the real projection and the real resolver
 * against a real database. The stale row is seeded EXACTLY as production
 * carried it, because a fixture that cannot reproduce the defect cannot prove
 * it is gone.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps } from "./point7/product-fixtures.js";
import type { BillingAccountProjection } from "../src/services/billing/billing-account-projection.service.js";

describe("BILLING PLAN SELECTION (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let project: typeof import(
    "../src/services/billing/billing-account-projection.service.js"
  )["buildBillingAccountProjection"];
  let resolveTransition: typeof import(
    "../src/services/billing/plan-transition.service.js"
  )["resolvePersonalPlanTransition"];

  /** Every billing capability a self-service owner holds on their own account. */
  const owner = (id: string) =>
    ({
      type: "PERSONAL" as const,
      id,
      displayName: "Personal",
      capabilities: [
        "BILLING_VIEW",
        "BILLING_MANAGE",
        "BILLING_CANCEL",
        "BILLING_AMOUNT_VIEW",
        "BILLING_ADDON_PURCHASE",
      ] as never,
      billingOwnerMissing: false,
    });

  /** A viewer who may look and may not act. */
  const readOnly = (id: string) =>
    ({
      type: "PERSONAL" as const,
      id,
      displayName: "Personal",
      capabilities: ["BILLING_VIEW"] as never,
      billingOwnerMissing: false,
    });

  async function projectFor(
    userId: string,
    account = owner(userId),
  ): Promise<BillingAccountProjection> {
    return project({ account, viewerUserId: userId });
  }

  /**
   * A non-terminal provider subscription row.
   *
   * `plan` is deliberately a parameter: the whole defect lives in the case
   * where it disagrees with the account's entitlement.
   */
  async function seedSubscriptionRow(
    userId: string,
    plan: "PRO" | "TEAM",
    over: Record<string, unknown> = {},
  ) {
    return prisma.subscription.create({
      data: {
        userId,
        provider: "STRIPE",
        providerSubId: `sub-${randomUUID()}`,
        status: "ACTIVE",
        plan,
        currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        teamId: null,
        ...over,
      },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ buildBillingAccountProjection: project } = await import(
      "../src/services/billing/billing-account-projection.service.js"
    ));
    ({ resolvePersonalPlanTransition: resolveTransition } = await import(
      "../src/services/billing/plan-transition.service.js"
    ));

    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `bsel-${Date.now().toString(36)}`,
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
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  // =========================================================================
  // 1. FREE — the flow the defect broke
  // =========================================================================

  describe("a FREE account", () => {
    it("is CHOOSING, and is offered a purchase rather than a change", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const p = await projectFor(t.owner.userId);

      expect(p.actions.planManagement.mode).toBe("CHOOSE");
      expect(p.actions.planManagement.label).toBe("Choose a plan");
      expect(p.plan.accessKind).toBe("FREE");

      // Both tiers, both as PURCHASES. The verb is what the drawer renders.
      const offers = p.planOffers ?? [];
      expect(offers.map((o) => o.planKey).sort()).toEqual(["PRO", "TEAM"]);
      for (const o of offers) {
        expect(o.action).toBe("CHECKOUT");
        expect(o.actionLabel).toMatch(/^Subscribe to /);
      }
    });

    it("has nothing to cancel and nothing scheduled", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const p = await projectFor(t.owner.userId);

      expect(p.actions.canRequestCancellation).toBe(false);
      expect(p.plan.scheduledChange ?? null).toBeNull();
      expect(p.plan.cancelAtPeriodEnd ?? false).toBe(false);
    });

    it("is STILL choosing when a stale paid subscription row survives", async () => {
      /*
       * THE PRODUCTION STATE, REPRODUCED.
       *
       * Entitlement FREE, a live TEAM row beside it — a binding left behind by
       * a plan that was taken away, a webhook that never landed, or a link
       * lost to a migration. Before the correction this projected as a
       * SUBSCRIPTION and the customer was offered two upgrades and an
       * "End subscription" they had no subscription for.
       */
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      await seedSubscriptionRow(t.owner.userId, "TEAM");

      const p = await projectFor(t.owner.userId);

      expect(p.actions.planManagement.mode).toBe("CHOOSE");
      expect(p.plan.accessKind).not.toBe("SUBSCRIPTION");
      expect(p.actions.canRequestCancellation).toBe(false);
      for (const o of p.planOffers ?? []) {
        expect(o.action).toBe("CHECKOUT");
      }
    });

    it("cannot be transitioned through the paid plan-change authority", async () => {
      // The SERVER's refusal, independent of what any page decides to open.
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      await seedSubscriptionRow(t.owner.userId, "TEAM");

      for (const target of ["PRO", "TEAM"] as const) {
        const transition = await resolveTransition({
          userId: t.owner.userId,
          targetPlan: target as never,
        });
        expect(transition.kind).toBe("NEW_SUBSCRIPTION");
      }
    });

    it("has no scheduled plan change written by asking", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const row = await seedSubscriptionRow(t.owner.userId, "TEAM");

      await resolveTransition({ userId: t.owner.userId, targetPlan: "PRO" as never });

      const after = await prisma.subscription.findUniqueOrThrow({
        where: { id: row.id },
        select: { pendingPlan: true, pendingPlanEffectiveAtUtc: true, plan: true },
      });
      expect(after.pendingPlan).toBeNull();
      expect(after.pendingPlanEffectiveAtUtc).toBeNull();
      // And the stale row is not "repaired" by a read path either.
      expect(after.plan).toBe("TEAM");
    });

    it("cannot buy storage capacity, and is told which plans include it", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const p = await projectFor(t.owner.userId);

      expect(p.actions.canBuyStorageAddon).toBe(false);
      expect(p.storageAddons ?? null).toBeNull();
      expect(p.storageAddonsLocked?.reason).toBe(
        "Additional storage is available with Pro and Team.",
      );
      expect(p.storageAddonsLocked?.unlockedByPlan).toBe("PRO");
    });
  });

  // =========================================================================
  // 2. A real subscription — the flow that must keep working
  // =========================================================================

  for (const [plan, other, direction] of [
    ["PRO", "TEAM", "UPGRADE"],
    ["TEAM", "PRO", "DOWNGRADE"],
  ] as const) {
    describe(`a real ${plan} subscription`, () => {
      it("is MANAGED, with the move and the cancellation the server authorizes", async () => {
        const t = await seedPersonalTenant(deps, plan, { credits: 0 });
        await seedSubscriptionRow(t.owner.userId, plan);

        const p = await projectFor(t.owner.userId);

        expect(p.actions.planManagement.mode).toBe("MANAGE");
        expect(p.actions.planManagement.label).toBe("Manage plan");
        expect(p.plan.accessKind).toBe("SUBSCRIPTION");
        expect(p.actions.canRequestCancellation).toBe(true);

        const offers = p.planOffers ?? [];
        expect(offers.map((o) => o.planKey)).toEqual([other]);
        expect(offers[0]!.action).toBe(direction);
        expect(offers[0]!.actionLabel).toBe(
          `Move to ${other === "PRO" ? "Pro" : "Team"}`,
        );
      });

      it("never claims a proration nobody calculated", async () => {
        const t = await seedPersonalTenant(deps, plan, { credits: 0 });
        await seedSubscriptionRow(t.owner.userId, plan);

        const p = await projectFor(t.owner.userId);
        for (const o of p.planOffers ?? []) {
          expect(o.effectSummary).not.toMatch(/charges the difference/i);
          expect(o.effectSummary).not.toMatch(/prorat/i);
        }
      });

      it("resolves the move through the paid transition authority", async () => {
        const t = await seedPersonalTenant(deps, plan, { credits: 0 });
        await seedSubscriptionRow(t.owner.userId, plan);

        const transition = await resolveTransition({
          userId: t.owner.userId,
          targetPlan: other as never,
        });
        expect(transition.kind).toBe(direction);
      });
    });
  }

  it("a scheduled change is REVIEWED, not re-offered", async () => {
    const t = await seedPersonalTenant(deps, "TEAM", { credits: 0 });
    await seedSubscriptionRow(t.owner.userId, "TEAM", {
      pendingPlan: "PRO",
      pendingPlanEffectiveAtUtc: new Date("2026-12-01T00:00:00.000Z"),
    });

    const p = await projectFor(t.owner.userId);
    expect(p.actions.planManagement.mode).toBe("REVIEW_SCHEDULED");
    expect(p.actions.planManagement.label).toBe("Review plan change");
    expect(p.plan.scheduledChange?.displayName).toBe("Pro");
  });

  // =========================================================================
  // 3. Granted access — real access, no billing relationship
  // =========================================================================

  it("granted paid access is VIEWED, never managed or cancelled", async () => {
    // A paid tier with NO subscription row: provisioned, comped, or granted.
    const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
    const p = await projectFor(t.owner.userId);

    expect(p.plan.accessKind).toBe("GRANTED");
    expect(p.actions.planManagement.mode).toBe("VIEW_ACCESS");
    expect(p.actions.planManagement.label).toBe("View access details");
    expect(p.actions.canRequestCancellation).toBe(false);
    // No price, so no renewal and no billing-period language can be rendered.
    expect(p.plan.priceCents ?? null).toBeNull();
    expect(p.plan.currentPeriodEndUtc ?? null).toBeNull();
  });

  // =========================================================================
  // 4. A viewer who may not act
  // =========================================================================

  it("a read-only viewer sees the plan and can do nothing to it", async () => {
    const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
    const p = await projectFor(t.owner.userId, readOnly(t.owner.userId));

    expect(p.actions.planManagement.enabled).toBe(false);
    expect(p.actions.canStartCheckout).toBe(false);
    expect(p.actions.canRequestCancellation).toBe(false);
    expect(p.actions.canBuyEvidenceCredits).toBe(false);
    // No catalogue is even projected to a viewer who cannot buy from it.
    expect(p.planOffers ?? null).toBeNull();
  });

  // =========================================================================
  // 5. Credits are projected ONCE
  // =========================================================================

  it("the credit balance is one fact from one authority", async () => {
    const t = await seedPersonalTenant(deps, "FREE", { credits: 4 });
    const p = await projectFor(t.owner.userId);

    expect(p.wallet?.availableCredits).toBe(4);
    // The admission projection carries the SAME number rather than a second
    // count of it — which is what let two cards disagree on the page.
    expect(p.evidenceAdmission?.creditsAvailable).toBe(4);
    expect(p.actions.canBuyEvidenceCredits).toBe(true);
  });
});
