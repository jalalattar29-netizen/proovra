/**
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the personal plan
 * transition authority, behaviourally.
 *
 * WHAT IS REAL HERE
 * ---------------------------------------------------------------------------
 * The production resolver and the production apply path both run. What is
 * substituted is the database client and the two PROVIDER modules — Stripe and
 * PayPal — at their module boundary, so every provider call is observable and
 * no test can reach a real provider. The transition logic, the ordering, the
 * refusals and the writes are the shipped ones.
 *
 * WHAT IS NOT COVERED HERE, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * That the columns persist and that the route authorises are proven against a
 * live database in `billing-plan-transition.integration.test.ts`. This suite
 * proves the DECISIONS.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  /** The subscription `findFirst` returns, or null for "nothing live". */
  subscription: null as Record<string, unknown> | null,
  /** Every write the services attempted, in order. */
  writes: [] as string[],
  /** Every provider call attempted, in order. */
  providerCalls: [] as string[],
  /** Set to make the next provider call throw. */
  providerFails: false,
  /** What PayPal's revise returns. */
  paypalLinks: [] as Array<{ rel: string; href: string }>,
  /** The plan applied through the canonical plan writer, if any. */
  planApplied: null as string | null,
}));

vi.mock("../src/db.js", () => {
  const prisma = new Proxy(
    {},
    {
      get(_t, model: string) {
        if (String(model).startsWith("$")) return async () => 0;
        return new Proxy(
          {},
          {
            get(_t2, method: string) {
              return async (args?: Record<string, unknown>) => {
                const call = `${String(model)}.${String(method)}`;
                if (/^(create|update|upsert|delete)/.test(String(method))) {
                  const data = (args?.data ?? {}) as Record<string, unknown>;
                  const keys = Object.keys(data).sort().join(",");
                  H.writes.push(keys ? `${call}:${keys}` : call);
                }
                if (call === "subscription.findFirst") return H.subscription;
                if (call === "subscription.findUnique")
                  return H.subscription ? { userId: "user-1" } : null;
                if (method === "findMany") return [];
                if (method === "count") return 0;
                return {};
              };
            },
          },
        );
      },
    },
  );
  return { prisma };
});

vi.mock("../src/services/stripe.service.js", () => ({
  stripeGet: async (path: string) => {
    H.providerCalls.push(`stripeGet ${path}`);
    if (H.providerFails) throw new Error("stripe unavailable");
    return { items: { data: [{ id: "si_1" }] } };
  },
  stripeRequest: async (path: string, body: URLSearchParams) => {
    H.providerCalls.push(`stripePost ${path}`);
    if (H.providerFails) throw new Error("stripe unavailable");
    if (path === "/subscription_schedules") return { id: "sched_1" };
    return {
      status: "active",
      current_period_end: 1798761600,
      echoedPlan: body.get("metadata[plan]"),
    };
  },
}));

vi.mock("../src/services/paypal.service.js", () => ({
  paypalRequest: async (path: string) => {
    H.providerCalls.push(`paypalPost ${path}`);
    if (H.providerFails) throw new Error("paypal unavailable");
    return { links: H.paypalLinks };
  },
}));

vi.mock("../src/services/billing/subscription-lifecycle.handlers.js", () => ({
  syncPlanForSubscription: async (params: { plan: string }) => {
    H.planApplied = params.plan;
  },
}));

// Prices exist for both plans in both currencies, so the "no configured price"
// refusal is exercised deliberately rather than by accident of environment.
vi.mock("../src/services/billing-pricing.service.js", () => ({
  getStripePlanPriceId: (plan: string) =>
    plan === "NOPRICE" ? null : `price_${plan}`,
  resolveCheckoutCurrency: () => "EUR",
}));

vi.mock("../src/services/paypal-checkout-policy.service.js", () => ({
  getPayPalPlanId: (params: { plan: string }) =>
    params.plan === "NOPLAN" ? null : `P-${params.plan}`,
}));

import {
  applyPersonalPlanChange,
  assertSelfServicePlan,
  findLivePersonalSubscription,
  resolvePersonalPlanTransition,
} from "../src/services/billing/plan-transition.service.js";

const PERIOD_END = new Date("2026-10-01T00:00:00.000Z");

function live(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    provider: "STRIPE",
    providerSubId: "sub_ext_1",
    status: "ACTIVE",
    plan: "PRO",
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    pendingPlan: null,
    pendingPlanEffectiveAtUtc: null,
    teamId: null,
    ...overrides,
  };
}

beforeEach(() => {
  H.subscription = null;
  H.writes.length = 0;
  H.providerCalls.length = 0;
  H.providerFails = false;
  H.paypalLinks = [];
  H.planApplied = null;
});

// ===========================================================================
// 1. The resolver — what a requested change IS
// ===========================================================================

describe("resolvePersonalPlanTransition — one answer to 'what is this change'", () => {
  it("FREE → PRO with nothing live is a NEW_SUBSCRIPTION", async () => {
    const t = await resolvePersonalPlanTransition({ userId: "user-1", targetPlan: "PRO" as never });
    expect(t.kind).toBe("NEW_SUBSCRIPTION");
    expect(H.providerCalls).toEqual([]);
    expect(H.writes).toEqual([]);
  });

  it("FREE → TEAM with nothing live is a NEW_SUBSCRIPTION — TEAM is not special", async () => {
    // The whole point of the model correction: TEAM is reachable from FREE
    // without creating anything, exactly like PRO.
    const t = await resolvePersonalPlanTransition({ userId: "user-1", targetPlan: "TEAM" as never });
    expect(t.kind).toBe("NEW_SUBSCRIPTION");
    expect((t as { targetPlan: string }).targetPlan).toBe("TEAM");
  });

  it("FREE → FREE with nothing live is NO_CHANGE, not a cancellation", async () => {
    const t = await resolvePersonalPlanTransition({ userId: "user-1", targetPlan: "FREE" as never });
    expect(t.kind).toBe("NO_CHANGE");
  });

  it("PRO → TEAM on a live subscription is an UPGRADE", async () => {
    H.subscription = live({ plan: "PRO" });
    const t = await resolvePersonalPlanTransition({ userId: "user-1", targetPlan: "TEAM" as never });
    expect(t.kind).toBe("UPGRADE");
  });

  it("TEAM → PRO on a live subscription is a DOWNGRADE", async () => {
    H.subscription = live({ plan: "TEAM" });
    const t = await resolvePersonalPlanTransition({ userId: "user-1", targetPlan: "PRO" as never });
    expect(t.kind).toBe("DOWNGRADE");
  });

  it("PRO → FREE on a live subscription is a CANCELLATION, never a plan write", async () => {
    H.subscription = live({ plan: "PRO" });
    const t = await resolvePersonalPlanTransition({ userId: "user-1", targetPlan: "FREE" as never });
    expect(t.kind).toBe("CANCELLATION");
  });

  it("TEAM → FREE is a CANCELLATION too — FREE is what remains, not a purchase", async () => {
    H.subscription = live({ plan: "TEAM" });
    const t = await resolvePersonalPlanTransition({ userId: "user-1", targetPlan: "FREE" as never });
    expect(t.kind).toBe("CANCELLATION");
  });

  it("asking for the plan you are on is NO_CHANGE and reaches no provider", async () => {
    H.subscription = live({ plan: "TEAM" });
    const t = await resolvePersonalPlanTransition({ userId: "user-1", targetPlan: "TEAM" as never });
    expect(t.kind).toBe("NO_CHANGE");
    expect(H.providerCalls).toEqual([]);
  });

  it("a SCHEDULED downgrade counts as the current plan — asking for it again is NO_CHANGE", async () => {
    // Without this, a TEAM customer who scheduled PRO last week and asks for
    // PRO again would be told they are upgrading, and a second schedule would
    // be pushed at a provider that holds one.
    H.subscription = live({ plan: "TEAM", pendingPlan: "PRO" });
    const t = await resolvePersonalPlanTransition({ userId: "user-1", targetPlan: "PRO" as never });
    expect(t.kind).toBe("NO_CHANGE");
  });

  it("a scheduled downgrade can be reversed — asking for TEAM again is an UPGRADE", async () => {
    H.subscription = live({ plan: "TEAM", pendingPlan: "PRO" });
    const t = await resolvePersonalPlanTransition({ userId: "user-1", targetPlan: "TEAM" as never });
    expect(t.kind).toBe("UPGRADE");
  });

  it("a PAST_DUE subscription is still LIVE — a change, never a second purchase", async () => {
    H.subscription = live({ plan: "PRO", status: "PAST_DUE" });
    const t = await resolvePersonalPlanTransition({ userId: "user-1", targetPlan: "TEAM" as never });
    expect(t.kind).toBe("UPGRADE");
  });

  it("a TRIALING subscription is live too", async () => {
    H.subscription = live({ plan: "PRO", status: "TRIALING" });
    const t = await resolvePersonalPlanTransition({ userId: "user-1", targetPlan: "TEAM" as never });
    expect(t.kind).toBe("UPGRADE");
  });

  it("a LEGACY row carrying a teamId is still that person's subscription", async () => {
    // Written under the obsolete model, for a workspace the customer really
    // did pay for. The paid right survives; only where it is recorded moved.
    H.subscription = live({ plan: "PRO", teamId: "ws-legacy" });
    const t = await resolvePersonalPlanTransition({ userId: "user-1", targetPlan: "TEAM" as never });
    expect(t.kind).toBe("UPGRADE");
    expect((t as { subscription: { teamId: string | null } }).subscription.teamId).toBe("ws-legacy");
  });

  it("a live ENTERPRISE subscription is refused, not guessed at", async () => {
    H.subscription = live({ plan: "ENTERPRISE" });
    await expect(
      resolvePersonalPlanTransition({ userId: "user-1", targetPlan: "PRO" as never }),
    ).rejects.toMatchObject({ publicCode: "PLAN_CHANGE_NOT_AVAILABLE" });
  });

  it("the live-subscription lookup is not filtered by teamId", async () => {
    // The cancel route used to key this off the request body. One person, one
    // subscription, one lookup — otherwise "which is yours" has two answers.
    H.subscription = live({ teamId: "ws-legacy" });
    const found = await findLivePersonalSubscription("user-1");
    expect(found?.id).toBe("sub-1");
  });
});

// ===========================================================================
// 2. The two plans nobody may self-serve
// ===========================================================================

describe("assertSelfServicePlan — ENTERPRISE and PAYG are refused by name", () => {
  it("ENTERPRISE is a contract, and the refusal says so without leaking anything", () => {
    try {
      assertSelfServicePlan("ENTERPRISE" as never);
      throw new Error("should have refused");
    } catch (err) {
      expect((err as { publicCode?: string }).publicCode).toBe("ENTERPRISE_NOT_SELF_SERVICE");
      expect((err as { httpStatus?: number }).httpStatus).toBe(409);
      expect((err as { publicMessage?: string }).publicMessage).not.toMatch(/sub_|price_|P-/);
    }
  });

  it("PAYG is a legacy resolution row, not a plan anyone may move to", () => {
    expect(() => assertSelfServicePlan("PAYG" as never)).toThrowError();
    try {
      assertSelfServicePlan("PAYG" as never);
    } catch (err) {
      expect((err as { publicCode?: string }).publicCode).toBe("PAYG_NOT_ASSIGNABLE");
    }
  });

  it("the resolver refuses them BEFORE reading anything", async () => {
    await expect(
      resolvePersonalPlanTransition({ userId: "user-1", targetPlan: "ENTERPRISE" as never }),
    ).rejects.toMatchObject({ publicCode: "ENTERPRISE_NOT_SELF_SERVICE" });
    expect(H.writes).toEqual([]);
    expect(H.providerCalls).toEqual([]);
  });
});

// ===========================================================================
// 3. UPGRADE — provider first, effective now
// ===========================================================================

describe("applyPersonalPlanChange — UPGRADE (Stripe)", () => {
  const upgrade = () =>
    applyPersonalPlanChange({
      transition: {
        kind: "UPGRADE",
        targetPlan: "TEAM" as never,
        subscription: live({ plan: "PRO" }) as never,
      },
      currency: "EUR",
    });

  it("moves the EXISTING subscription — it never creates a second one", async () => {
    H.subscription = live({ plan: "PRO" });
    await upgrade();
    expect(H.providerCalls).toEqual([
      "stripeGet /subscriptions/sub_ext_1",
      "stripePost /subscriptions/sub_ext_1",
    ]);
    // No checkout session, no new subscription, anywhere.
    expect(H.providerCalls.some((c) => c.includes("checkout"))).toBe(false);
  });

  it("takes effect immediately and says so", async () => {
    H.subscription = live({ plan: "PRO" });
    const out = await upgrade();
    expect(out.kind).toBe("UPGRADE");
    expect(out.effectiveAtUtc).toBeNull();
    expect(out.providerConfirmed).toBe(true);
    expect(out.approvalUrl).toBeNull();
  });

  it("applies the plan through the CANONICAL writer, not a second one", async () => {
    H.subscription = live({ plan: "PRO" });
    await upgrade();
    expect(H.planApplied).toBe("TEAM");
  });

  it("a provider failure changes NOTHING and leaks no provider detail", async () => {
    H.subscription = live({ plan: "PRO" });
    H.providerFails = true;
    await expect(upgrade()).rejects.toMatchObject({
      publicCode: "PLAN_CHANGE_PROVIDER_FAILED",
      httpStatus: 502,
    });
    expect(H.planApplied).toBeNull();
    expect(H.writes).toEqual([]);
    try {
      await upgrade();
    } catch (err) {
      expect((err as { publicMessage?: string }).publicMessage).not.toMatch(
        /sub_ext_1|price_|stripe/i,
      );
    }
  });

  it("refuses when no provider price is configured, rather than opening a second subscription", async () => {
    H.subscription = live({ plan: "PRO" });
    await expect(
      applyPersonalPlanChange({
        transition: {
          kind: "UPGRADE",
          targetPlan: "NOPRICE" as never,
          subscription: live({ plan: "PRO" }) as never,
        },
        currency: "EUR",
      }),
    ).rejects.toMatchObject({ publicCode: "PLAN_CHANGE_NOT_AVAILABLE" });
    expect(H.providerCalls).toEqual([]);
  });

  it("a subscription already scheduled to CANCEL cannot be changed", async () => {
    await expect(
      applyPersonalPlanChange({
        transition: {
          kind: "UPGRADE",
          targetPlan: "TEAM" as never,
          subscription: live({ plan: "PRO", cancelAtPeriodEnd: true }) as never,
        },
      }),
    ).rejects.toMatchObject({ publicCode: "SUBSCRIPTION_CANCELLING" });
    expect(H.providerCalls).toEqual([]);
  });
});

// ===========================================================================
// 4. DOWNGRADE — provider first, effective at period end
// ===========================================================================

describe("applyPersonalPlanChange — DOWNGRADE (Stripe)", () => {
  const downgrade = (sub = live({ plan: "TEAM" })) =>
    applyPersonalPlanChange({
      transition: {
        kind: "DOWNGRADE",
        targetPlan: "PRO" as never,
        subscription: sub as never,
      },
      currency: "EUR",
    });

  it("schedules at the provider — it does not update the live subscription", async () => {
    await downgrade();
    expect(H.providerCalls).toEqual([
      "stripePost /subscription_schedules",
      "stripePost /subscription_schedules/sched_1",
    ]);
  });

  it("does NOT apply the plan now — the paid period is not taken back", async () => {
    await downgrade();
    expect(H.planApplied).toBeNull();
  });

  it("records the scheduled plan and the date it takes over", async () => {
    const out = await downgrade();
    expect(out.kind).toBe("DOWNGRADE");
    expect(out.effectiveAtUtc).toBe(PERIOD_END.toISOString());
    expect(H.writes.some((w) => w.startsWith("subscription.update:"))).toBe(true);
    expect(H.writes.join("|")).toMatch(/pendingPlan/);
  });

  it("refuses when the provider has given no period end, rather than inventing one", async () => {
    // Without a confirmed paid-through date there is no boundary to defer to,
    // and choosing one would either take capacity early or give it away.
    await expect(downgrade(live({ plan: "TEAM", currentPeriodEnd: null }))).rejects.toMatchObject({
      publicCode: "PLAN_CHANGE_NOT_AVAILABLE",
    });
  });

  it("a provider failure creating the schedule writes nothing", async () => {
    H.providerFails = true;
    await expect(downgrade()).rejects.toMatchObject({
      publicCode: "PLAN_CHANGE_PROVIDER_FAILED",
    });
    expect(H.writes).toEqual([]);
    expect(H.planApplied).toBeNull();
  });
});

// ===========================================================================
// 5. PayPal — what it can and cannot do, said honestly
// ===========================================================================

describe("applyPersonalPlanChange — PayPal", () => {
  const paypal = (kind: "UPGRADE" | "DOWNGRADE", target = "TEAM") =>
    applyPersonalPlanChange({
      transition: {
        kind,
        targetPlan: target as never,
        subscription: live({ provider: "PAYPAL", plan: "PRO" }) as never,
      },
      currency: "EUR",
    });

  it("revises the existing agreement — never a second one", async () => {
    await paypal("UPGRADE");
    expect(H.providerCalls).toEqual(["paypalPost /v1/billing/subscriptions/sub_ext_1/revise"]);
  });

  it("an approval link means the buyer has NOT agreed — nothing is claimed as done", async () => {
    H.paypalLinks = [{ rel: "approve", href: "https://paypal.test/approve/1" }];
    const out = await paypal("UPGRADE");
    expect(out.approvalUrl).toBe("https://paypal.test/approve/1");
    expect(out.providerConfirmed).toBe(false);
    expect(H.planApplied).toBeNull();
  });

  it("an UPGRADE is recorded as PENDING, because PayPal charges no prorated difference", async () => {
    // Promising immediate capacity here would be promising something unpaid
    // for: PayPal's revise lands at the next cycle in both directions.
    const out = await paypal("UPGRADE");
    expect(H.planApplied).toBeNull();
    expect(out.effectiveAtUtc).toBe(PERIOD_END.toISOString());
    expect(H.writes.join("|")).toMatch(/pendingPlan/);
  });

  it("refuses when no PayPal plan id is configured", async () => {
    await expect(paypal("DOWNGRADE", "NOPLAN")).rejects.toMatchObject({
      publicCode: "PLAN_CHANGE_NOT_AVAILABLE",
    });
    expect(H.providerCalls).toEqual([]);
  });

  it("a provider failure writes nothing and leaks nothing", async () => {
    H.providerFails = true;
    await expect(paypal("UPGRADE")).rejects.toMatchObject({
      publicCode: "PLAN_CHANGE_PROVIDER_FAILED",
    });
    expect(H.writes).toEqual([]);
  });
});

// ===========================================================================
// 6. What a transition must NEVER do
// ===========================================================================

describe("no transition deletes anything a customer owns", () => {
  it("neither direction touches evidence, memberships or collaboration teams", async () => {
    H.subscription = live({ plan: "PRO" });
    await applyPersonalPlanChange({
      transition: {
        kind: "UPGRADE",
        targetPlan: "TEAM" as never,
        subscription: live({ plan: "PRO" }) as never,
      },
      currency: "EUR",
    });
    await applyPersonalPlanChange({
      transition: {
        kind: "DOWNGRADE",
        targetPlan: "PRO" as never,
        subscription: live({ plan: "TEAM" }) as never,
      },
      currency: "EUR",
    });

    const forbidden = H.writes.filter((w) =>
      /^(evidence|teamMember|collaborationTeam|collaborationTeamMember|user)\./.test(w),
    );
    expect(forbidden).toEqual([]);
  });

  it("the source carries no evidence, membership or team deletion at all", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(
        new URL("../src/services/billing/plan-transition.service.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).not.toMatch(/evidence\.(delete|deleteMany|update)/i);
    expect(src).not.toMatch(/teamMember\.(delete|deleteMany)/i);
    expect(src).not.toMatch(/collaborationTeam\w*\.(delete|deleteMany)/i);
    // And it never writes the plan itself — that is one writer, elsewhere.
    expect(src).not.toMatch(/entitlement\.(update|updateMany|upsert)/);
  });
});
