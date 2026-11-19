/**
 * PRO-BL1-01 variant B — plan change, against live PostgreSQL (review
 * HIGH-MONEY-DISCLOSURE, gaps G1 and G3).
 *
 * WHAT IS REAL HERE
 * ---------------------------------------------------------------------------
 * `resolvePersonalPlanTransition`, `applyPersonalPlanChange`, the intent columns
 * (`provider_intent_key`), `provider_schedule_id` and the pending-plan columns,
 * all on a real database. Only the Stripe TRANSPORT is replaced, by a fake that
 * implements Stripe's idempotency contract (a repeated `Idempotency-Key` returns
 * the STORED first response without executing; the same key with another path is
 * refused) and keeps the live state of subscriptions and schedules. The price
 * verification is stubbed at its boundary (it has its own suite).
 *
 * The unit suite (`billing-plan-transition.test.ts`) runs on a mocked DB whose
 * `findUnique` never returns a stored intent, so it mints a new key on every
 * call and cannot see a replay. This one can.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps } from "./point7/product-fixtures.js";

type FakeSchedule = {
  id: string;
  status: "active" | "released";
  subscription: string;
  phases: Array<{ start_date: number; end_date?: number; items: Array<{ price: string }> }>;
};
type FakeSubscription = {
  status: "active";
  currency: "eur";
  current_period_end: number;
  price: string;
  schedule: string | null;
};

const PERIOD_START = Math.floor(new Date("2026-12-01T00:00:00.000Z").getTime() / 1000);
const PERIOD_END = Math.floor(new Date("2027-01-01T00:00:00.000Z").getTime() / 1000);

const FAKE = vi.hoisted(() => ({
  subs: new Map<string, FakeSubscription>(),
  schedules: new Map<string, FakeSchedule>(),
  /** key -> { path, response }: Stripe's idempotency store. */
  stored: new Map<string, { path: string; response: Record<string, unknown> }>(),
  keys: [] as Array<{ key: string; path: string; replayed: boolean }>,
  /** Execute the next POST whose path matches, then lose its answer (a timeout). */
  loseAnswerOn: null as RegExp | null,
  seq: 0,
}));

vi.mock("../src/services/stripe.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const StripeHttpError = actual.StripeHttpError as new (...args: unknown[]) => Error;
  const refuse = (message: string, status = 400) => {
    const err = Object.create(StripeHttpError.prototype) as Error & { status: number };
    err.message = message;
    err.status = status;
    return err;
  };
  const scheduleView = (s: FakeSchedule) => ({
    id: s.id,
    status: s.status,
    subscription: s.subscription,
    phases: s.phases.map((p) => ({ ...p, items: p.items.map((i) => ({ ...i })) })),
  });
  const subscriptionView = (id: string, s: FakeSubscription) => ({
    id,
    status: s.status,
    currency: s.currency,
    current_period_end: s.current_period_end,
    schedule: s.schedule,
    items: { data: [{ id: `si_${id}`, price: { id: s.price } }] },
  });
  const execute = (path: string, body: URLSearchParams): Record<string, unknown> => {
    if (path === "/subscription_schedules") {
      const subId = body.get("from_subscription") ?? "";
      const sub = FAKE.subs.get(subId);
      if (!sub) throw refuse("no such subscription", 404);
      if (sub.schedule) throw refuse("subscription already has a schedule");
      FAKE.seq += 1;
      const schedule: FakeSchedule = {
        id: `sub_sched_${FAKE.seq}`,
        status: "active",
        subscription: subId,
        phases: [{ start_date: PERIOD_START, end_date: sub.current_period_end, items: [{ price: sub.price }] }],
      };
      FAKE.schedules.set(schedule.id, schedule);
      sub.schedule = schedule.id;
      return scheduleView(schedule);
    }
    const release = /^\/subscription_schedules\/([^/]+)\/release$/.exec(path);
    if (release) {
      const schedule = FAKE.schedules.get(decodeURIComponent(release[1]!));
      if (!schedule) throw refuse("no such schedule", 404);
      if (schedule.status === "released") throw refuse("schedule already released");
      schedule.status = "released";
      const sub = FAKE.subs.get(schedule.subscription);
      if (sub && sub.schedule === schedule.id) sub.schedule = null;
      return scheduleView(schedule);
    }
    const update = /^\/subscription_schedules\/([^/]+)$/.exec(path);
    if (update) {
      const schedule = FAKE.schedules.get(decodeURIComponent(update[1]!));
      if (!schedule) throw refuse("no such schedule", 404);
      if (schedule.status === "released") throw refuse("a released schedule cannot be updated");
      const end = Number(body.get("phases[0][end_date]"));
      schedule.phases = [
        {
          start_date: Number(body.get("phases[0][start_date]")),
          end_date: end,
          items: [{ price: body.get("phases[0][items][0][price]") ?? "" }],
        },
        { start_date: end, items: [{ price: body.get("phases[1][items][0][price]") ?? "" }] },
      ];
      return scheduleView(schedule);
    }
    const subUpdate = /^\/subscriptions\/([^/]+)$/.exec(path);
    if (subUpdate) {
      const id = decodeURIComponent(subUpdate[1]!);
      const sub = FAKE.subs.get(id);
      if (!sub) throw refuse("no such subscription", 404);
      const price = body.get("items[0][price]");
      if (price) sub.price = price;
      return subscriptionView(id, sub);
    }
    throw new Error(`fake stripe: unhandled POST ${path}`);
  };
  return {
    ...actual,
    stripeRequest: async (path: string, body: URLSearchParams, options: { idempotencyKey?: string | null } = {}) => {
      const key = options.idempotencyKey ?? null;
      if (key) {
        const hit = FAKE.stored.get(key);
        if (hit) {
          FAKE.keys.push({ key, path, replayed: true });
          // Stripe refuses a key reused for a different request.
          if (hit.path !== path) throw refuse("idempotency key reused with different parameters");
          return JSON.parse(JSON.stringify(hit.response)) as Record<string, unknown>;
        }
        FAKE.keys.push({ key, path, replayed: false });
      }
      const response = execute(path, body);
      if (key) FAKE.stored.set(key, { path, response: JSON.parse(JSON.stringify(response)) as Record<string, unknown> });
      if (FAKE.loseAnswerOn?.test(path)) {
        FAKE.loseAnswerOn = null;
        throw new Error("socket hang up");
      }
      return response;
    },
    stripeGet: async (path: string) => {
      const schedule = /^\/subscription_schedules\/([^/]+)$/.exec(path);
      if (schedule) {
        const s = FAKE.schedules.get(decodeURIComponent(schedule[1]!));
        if (!s) throw refuse("no such schedule", 404);
        return scheduleView(s);
      }
      const sub = /^\/subscriptions\/([^/]+)$/.exec(path);
      if (sub) {
        const id = decodeURIComponent(sub[1]!);
        const s = FAKE.subs.get(id);
        if (!s) throw refuse("no such subscription", 404);
        return subscriptionView(id, s);
      }
      throw new Error(`fake stripe: unhandled GET ${path}`);
    },
    stripeRequestRaw: async () => ({}),
  };
});

// The plan prices and their verification are configuration, not what is tested.
vi.mock("../src/services/billing-pricing.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getStripePlanPriceId: (plan: string) => `price_${plan}` };
});
vi.mock("../src/services/billing/commercial-offer.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, requireVerifiedStripePrice: async () => "verified" };
});

describe("PRO-BL1-01 variant B — plan change replay contract (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let transitions: typeof import("../src/services/billing/plan-transition.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    transitions = await import("../src/services/billing/plan-transition.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `bpr-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          secret,
          60 * 60,
        ),
    };
  }, 900_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 300_000);

  beforeEach(() => {
    FAKE.stored.clear();
    FAKE.keys.length = 0;
    FAKE.loseAnswerOn = null;
  });

  async function seedStripeTeam() {
    const t = await seedPersonalTenant(deps, "TEAM", { credits: 0 });
    const providerSubId = `sub_${randomUUID().replace(/-/g, "")}`;
    FAKE.subs.set(providerSubId, {
      status: "active",
      currency: "eur",
      current_period_end: PERIOD_END,
      price: "price_TEAM",
      schedule: null,
    });
    const sub = await prisma.subscription.create({
      data: {
        userId: t.owner.userId,
        provider: "STRIPE",
        providerSubId,
        status: "ACTIVE",
        plan: "TEAM",
        currentPeriodEnd: new Date(PERIOD_END * 1000),
        activatedAtUtc: new Date(),
      },
      select: { id: true },
    });
    return { userId: t.owner.userId, subscriptionId: sub.id, providerSubId };
  }

  /** What the route does: resolve the transition, then apply it at the provider. */
  async function change(userId: string, targetPlan: "PRO" | "TEAM") {
    const transition = await transitions.resolvePersonalPlanTransition({ userId, targetPlan });
    if (transition.kind !== "UPGRADE" && transition.kind !== "DOWNGRADE") {
      throw new Error(`unexpected transition ${transition.kind}`);
    }
    return transitions.applyPersonalPlanChange({ transition, currency: "EUR" });
  }

  const row = (id: string) => prisma.subscription.findUniqueOrThrow({ where: { id } });
  const liveScheduleOf = (providerSubId: string) => {
    const id = FAKE.subs.get(providerSubId)!.schedule;
    return id ? FAKE.schedules.get(id)! : null;
  };
  const updateKeys = () => FAKE.keys.filter((k) => /^\/subscription_schedules\/[^/]+$/.test(k.path));

  it("a schedule update that TIMES OUT after executing never records a downgrade on the released schedule", async () => {
    const s = await seedStripeTeam();

    // Attempt 1 — Stripe creates the schedule and executes the phase update, and
    // the answer to the update is lost. The schedule created here is released.
    FAKE.loseAnswerOn = /^\/subscription_schedules\/[^/]+$/;
    await expect(change(s.userId, "PRO")).rejects.toMatchObject({ publicCode: "PLAN_CHANGE_OUTCOME_UNKNOWN" });
    const afterTimeout = await row(s.subscriptionId);
    expect(afterTimeout.pendingPlan).toBeNull();
    expect(afterTimeout.providerScheduleId).toBeNull();
    // Unknown outcome: the intent stays open so the retry reuses its key.
    expect(afterTimeout.providerIntentKey).toMatch(/^proovra-plan-/);
    expect(liveScheduleOf(s.providerSubId)).toBeNull();
    expect([...FAKE.schedules.values()].filter((x) => x.subscription === s.providerSubId)[0]!.status).toBe("released");

    // Attempt 2 (the retry, same intent) — Stripe REPLAYS the stored "created"
    // and "updated" answers for the schedule that is now released. Before the
    // read-back this recorded pendingPlan=PRO on a schedule that does not exist
    // (and the caller then ended TEAM-only add-ons for real).
    await expect(change(s.userId, "PRO")).rejects.toMatchObject({ publicCode: "PLAN_CHANGE_PROVIDER_FAILED" });
    const replayed = FAKE.keys.filter((k) => k.replayed);
    expect(replayed.map((k) => k.path)).toEqual(
      expect.arrayContaining(["/subscription_schedules", expect.stringMatching(/^\/subscription_schedules\/sub_sched_\d+$/)]),
    );
    const afterReplay = await row(s.subscriptionId);
    expect(afterReplay.pendingPlan).toBeNull();
    expect(afterReplay.pendingPlanEffectiveAtUtc).toBeNull();
    expect(afterReplay.providerScheduleId).toBeNull();
    // The stale intent is closed: the next attempt is a new one.
    expect(afterReplay.providerIntentKey).toBeNull();
    expect(liveScheduleOf(s.providerSubId)).toBeNull();

    // Attempt 3 — a NEW intent, a new key, and Stripe really executes it.
    const done = await change(s.userId, "PRO");
    expect(done).toMatchObject({ kind: "DOWNGRADE", targetPlan: "PRO", providerConfirmed: true });
    const live = liveScheduleOf(s.providerSubId);
    expect(live).not.toBeNull();
    expect(live!.status).toBe("active");
    expect(live!.phases[1]).toMatchObject({ start_date: PERIOD_END, items: [{ price: "price_PRO" }] });
    const recorded = await row(s.subscriptionId);
    expect(recorded.pendingPlan).toBe("PRO");
    expect(recorded.providerScheduleId).toBe(live!.id);
    expect(recorded.providerIntentKey).toBeNull();
    expect(new Set(updateKeys().map((k) => k.key)).size).toBe(2);
  });

  it("downgrade -> withdraw -> downgrade: the second downgrade is a new intent on a new, live schedule", async () => {
    const s = await seedStripeTeam();

    await change(s.userId, "PRO");
    const first = liveScheduleOf(s.providerSubId)!;
    expect((await row(s.subscriptionId)).pendingPlan).toBe("PRO");

    // Withdraw ("Keep Team"): the schedule is released and forgotten.
    const kept = await change(s.userId, "TEAM");
    expect(kept.kind).toBe("UPGRADE");
    expect(first.status).toBe("released");
    const withdrawn = await row(s.subscriptionId);
    expect(withdrawn.pendingPlan).toBeNull();
    expect(withdrawn.providerScheduleId).toBeNull();
    expect(withdrawn.providerIntentKey).toBeNull();

    await change(s.userId, "PRO");
    const second = liveScheduleOf(s.providerSubId)!;
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("active");
    expect(second.phases[1]).toMatchObject({ items: [{ price: "price_PRO" }] });
    expect((await row(s.subscriptionId)).providerScheduleId).toBe(second.id);
    // Nothing was answered from the idempotency store.
    expect(FAKE.keys.filter((k) => k.replayed)).toHaveLength(0);
    expect(new Set(updateKeys().map((k) => k.key)).size).toBe(2);
  });

  it("a withdrawal closes a plan-change intent left open by a lost answer", async () => {
    const s = await seedStripeTeam();
    await change(s.userId, "PRO");
    // A later change whose answer is lost on an EXISTING schedule: the intent
    // stays open and the schedule is not released by the failure path.
    await prisma.subscription.update({
      where: { id: s.subscriptionId },
      data: { pendingPlan: null, pendingPlanEffectiveAtUtc: null },
    });
    FAKE.loseAnswerOn = /^\/subscription_schedules\/[^/]+$/;
    await expect(change(s.userId, "PRO")).rejects.toMatchObject({ publicCode: "PLAN_CHANGE_OUTCOME_UNKNOWN" });
    expect((await row(s.subscriptionId)).providerIntentKey).toMatch(/^proovra-plan-/);

    // The provider's webhook records the scheduled change; the customer withdraws it.
    await prisma.subscription.update({
      where: { id: s.subscriptionId },
      data: { pendingPlan: "PRO", pendingPlanEffectiveAtUtc: new Date(PERIOD_END * 1000) },
    });
    await change(s.userId, "TEAM");
    const withdrawn = await row(s.subscriptionId);
    expect(withdrawn.providerIntentKey).toBeNull();
    expect(liveScheduleOf(s.providerSubId)).toBeNull();

    // Downgrading again is a new intent: executed, verified, recorded.
    await change(s.userId, "PRO");
    const live = liveScheduleOf(s.providerSubId)!;
    expect(live.phases[1]).toMatchObject({ items: [{ price: "price_PRO" }] });
    expect((await row(s.subscriptionId)).pendingPlan).toBe("PRO");
  });
});
