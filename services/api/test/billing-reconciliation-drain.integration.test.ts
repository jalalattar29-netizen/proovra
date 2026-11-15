/**
 * F-07 (Free-user audit 4d9b, capacity; 2026-11-15) — the billing
 * reconciliation sweep DRAINS a backlog within a time budget per tick, under
 * the same lease, in fair rotation, and backs off when a provider cannot be
 * asked. Live PostgreSQL 16 and the real `reconcileBillingAccount` authority;
 * the provider is SIMULATED (an injected ReconciliationProvider with a fixed
 * latency) — no provider is contacted.
 *
 * Before: one tick offered one batch of ACCOUNT_BATCH (20) accounts and
 * stopped; an account the provider reports in sync writes nothing and stays
 * oldest-touched, so the same 20 were offered every hour.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LATENCY_MS = 20;
const BACKLOG = 70;

describe("F-07 billing reconciliation drains a backlog within a per-tick budget (live PostgreSQL 16, simulated provider)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let job: typeof import("../src/jobs/billing-reconciliation.job.js");
  let billing: typeof import("../src/services/billing.service.js");
  const periodEnd = new Date(Date.now() + 20 * 86400_000);
  const refs = new Map<string, string>(); // providerSubId -> userId
  let asked: string[] = [];
  let unavailable = false;

  const fakeStripe = {
    provider: "STRIPE",
    async observePayment(ref: string) {
      return { kind: "PAYMENT", provider: "STRIPE", providerRef: ref, state: "PENDING", amountCents: null, currency: null, quantity: null, observedAtUtc: new Date() };
    },
    async observeSubscription(ref: string) {
      await sleep(LATENCY_MS);
      asked.push(ref);
      if (unavailable) {
        return {
          kind: "SUBSCRIPTION", provider: "STRIPE", providerRef: ref, state: "UNKNOWN", currentPeriodEndUtc: null,
          cancelAtPeriodEnd: false, observedAtUtc: null, recentPayments: [], failure: "PROVIDER_UNAVAILABLE",
        };
      }
      return {
        kind: "SUBSCRIPTION", provider: "STRIPE", providerRef: ref, state: "ACTIVE", currentPeriodEndUtc: periodEnd,
        cancelAtPeriodEnd: false, observedAtUtc: new Date(), recentPayments: [],
      };
    },
  };
  const providers = { STRIPE: fakeStripe, PAYPAL: { ...fakeStripe, provider: "PAYPAL" } } as never;

  /** A tick, retried while another process (another suite on this Redis) holds the sweep lease. */
  async function tick(input: { budgetMs: number; maxAccounts?: number }) {
    for (let i = 0; i < 40; i++) {
      const started = Date.now();
      // Scoped to this suite's accounts: in CI every integration suite shares one
      // database, and other suites' billing rows (other providers, open
      // attempts) would take the rounds and the provider-unavailable stop.
      const r = await job.runBillingReconciliationSweep({ providers, onlyUserIds: [...refs.values()], ...input });
      if (!r.skipped) return { ...r, elapsedMs: Date.now() - started };
      await sleep(250);
    }
    throw new Error("the sweep lease stayed held by another process");
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    job = await import("../src/jobs/billing-reconciliation.job.js");
    billing = await import("../src/services/billing.service.js");
    for (let i = 0; i < BACKLOG; i++) {
      const id = randomUUID();
      const email = `f07-drain-${id}@example.test`;
      await prisma.user.create({ data: { id, email, provider: "EMAIL", providerUserId: email } });
      await billing.ensureEntitlement(id);
      await billing.setPersonalPlan(id, "PRO");
      const providerSubId = `sub_f07_${i.toString().padStart(3, "0")}_${id.slice(0, 8)}`;
      await prisma.subscription.create({
        data: { userId: id, provider: "STRIPE", providerSubId, status: "ACTIVE", plan: "PRO", currentPeriodEnd: periodEnd, activatedAtUtc: new Date() },
      });
      refs.set(providerSubId, id);
    }
  }, 300_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  it("covers every account of a backlog larger than a batch within a few ticks, each tick inside its budget, nobody offered twice before everybody once", async () => {
    job.resetReconciliationCycle?.();
    asked = [];
    unavailable = false;
    const budgetMs = 6_000;
    const ticks: Array<{ attempted: number; elapsedMs: number; rounds?: number; stopReason?: string; unavailable: number }> = [];
    const firstSeenAtTick = new Map<string, number>();
    let coveredAt = -1;
    for (let t = 0; t < 3 && coveredAt < 0; t++) {
      const before = asked.length;
      const r = await tick({ budgetMs });
      ticks.push(r);
      for (const ref of asked.slice(before)) {
        if (refs.has(ref) && !firstSeenAtTick.has(ref)) firstSeenAtTick.set(ref, t);
      }
      if (firstSeenAtTick.size === BACKLOG) coveredAt = t;
    }
    const mine = asked.filter((ref) => refs.has(ref));
    const coverage = firstSeenAtTick.size;
    // Fair rotation: within the covering window no account was asked twice
    // before every account had been asked once.
    const firstFull = mine.findIndex((_, i) => new Set(mine.slice(0, i + 1)).size === BACKLOG);
    const window = firstFull >= 0 ? mine.slice(0, firstFull + 1) : mine;
    const perAccountMs = Math.max(...ticks.map((r) => r.elapsedMs / Math.max(1, r.attempted)));
    console.log(
      `[F-07 measurement, LOCAL, simulated provider ${LATENCY_MS} ms/read] backlog ${BACKLOG}, budget ${budgetMs} ms/tick: ` +
        ticks.map((r, i) => `tick${i + 1} attempted=${r.attempted} rounds=${r.rounds} stop=${r.stopReason} ${r.elapsedMs} ms`).join("; ") +
        `; distinct accounts offered ${coverage}/${BACKLOG}${coveredAt >= 0 ? ` (all by tick ${coveredAt + 1})` : ""}; ~${Math.round(perAccountMs)} ms/account`,
    );
    expect(coverage).toBe(BACKLOG);
    expect(coveredAt).toBeLessThanOrEqual(2);
    expect(new Set(window).size).toBe(window.length);
    for (const r of ticks) {
      expect(r.unavailable).toBe(0);
      // Bounded: the budget plus at most one account's reconciliation and one selection.
      expect(r.elapsedMs).toBeLessThan(budgetMs + 2_000);
    }
    // More than one round per tick: the old sweep stopped after ACCOUNT_BATCH.
    expect(ticks[0]!.attempted).toBeGreaterThan(job.ACCOUNT_BATCH);
  });

  it("stops at the per-tick account ceiling, and resumes with the accounts it has not offered", async () => {
    job.resetReconciliationCycle?.();
    asked = [];
    unavailable = false;
    const a = await tick({ budgetMs: 60_000, maxAccounts: 25 });
    expect(a.attempted).toBe(25);
    expect(a.stopReason).toBe("max_accounts");
    const firstMine = new Set(asked.filter((r) => refs.has(r)));
    const mark = asked.length;
    const b = await tick({ budgetMs: 60_000, maxAccounts: 25 });
    expect(b.attempted).toBe(25);
    const secondMine = asked.slice(mark).filter((r) => refs.has(r));
    expect(secondMine.some((r) => firstMine.has(r))).toBe(false);
  });

  it("a provider that cannot be asked ends the drain after its round (the existing no-retry-storm rule)", async () => {
    job.resetReconciliationCycle?.();
    asked = [];
    unavailable = true;
    try {
      const r = await tick({ budgetMs: 60_000 });
      expect(r.stopReason).toBe("provider_unavailable");
      expect(r.rounds).toBe(1);
      expect(r.attempted).toBeLessThanOrEqual(job.ACCOUNT_BATCH);
      expect(r.unavailable).toBeGreaterThan(0);
    } finally {
      unavailable = false;
    }
  });
});
