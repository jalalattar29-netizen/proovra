/** Phase A7 — durable ledger reserve→reconcile→release (behavioral, in-memory store). */
import { describe, expect, it } from "vitest";

import {
  reserveAiBudget,
  reconcileAiUsage,
  releaseAiReservation,
  crossedThresholds,
  dayUtcOf,
  monthUtcOf,
  platformMonthlyLimitFromEnv,
  type LedgerStore,
  type LedgerLimits,
  type LedgerReserveInput,
} from "../src/services/ai/ai-usage-ledger.service.js";

function memStore() {
  const reservations = new Map<string, { id: string; status: string; actual: bigint | null }>();
  const daily = new Map<string, { operations: number; costUsdMicros: bigint }>();
  const monthly = new Map<string, { operations: number; costUsdMicros: bigint }>();
  let seq = 0;
  const store: LedgerStore = {
    async createReservation(input) {
      if (reservations.has(input.requestId)) return null;
      const id = `res-${++seq}`;
      reservations.set(input.requestId, { id, status: "reserved", actual: null });
      return id;
    },
    async getDailyUsage(ws, day) {
      return daily.get(`${ws}|${day}`) ?? { operations: 0, costUsdMicros: 0n };
    },
    async getMonthlyUsage(ws, month) {
      return monthly.get(`${ws}|${month}`) ?? { operations: 0, costUsdMicros: 0n };
    },
    async incrementRollups(ws, day, month, cost) {
      const d = daily.get(`${ws}|${day}`) ?? { operations: 0, costUsdMicros: 0n };
      daily.set(`${ws}|${day}`, { operations: d.operations + 1, costUsdMicros: d.costUsdMicros + cost });
      const m = monthly.get(`${ws}|${month}`) ?? { operations: 0, costUsdMicros: 0n };
      monthly.set(`${ws}|${month}`, { operations: m.operations + 1, costUsdMicros: m.costUsdMicros + cost });
    },
    async markCompleted(id, actual) {
      for (const r of reservations.values()) if (r.id === id) { r.status = "completed"; r.actual = actual; }
    },
    async markFailed(id) {
      for (const r of reservations.values()) if (r.id === id) r.status = "failed";
    },
  };
  return { store, reservations, daily, monthly };
}

const NOW = new Date("2026-07-12T12:00:00Z");
const NO_LIMITS: LedgerLimits = { dailyOperationLimit: null, monthlyOperationLimit: null, dailyCostLimitUsdMicros: null, monthlyCostLimitUsdMicros: null };

function input(over: Partial<LedgerReserveInput> = {}): LedgerReserveInput {
  return {
    workspaceId: "ws-1", userId: "u-1", feature: "CASE_COPILOT", provider: "openai",
    model: "gpt-4.1-mini", requestId: `rq-${Math.random()}`, estimatedCostUsdMicros: 250_000n, ...over,
  };
}

describe("A7 — reserve → reconcile → release", () => {
  it("reserve increments rollups; reconcile records actual; release marks failed", async () => {
    const { store, daily, reservations } = memStore();
    const d1 = await reserveAiBudget(store, NO_LIMITS, input({ requestId: "a" }), NOW);
    expect(d1.allowed).toBe(true);
    expect(daily.get(`ws-1|${dayUtcOf(NOW)}`)?.operations).toBe(1);
    if (d1.allowed) await reconcileAiUsage(store, d1.reservationId, 123n);
    expect([...reservations.values()][0]).toMatchObject({ status: "completed", actual: 123n });

    const d2 = await reserveAiBudget(store, NO_LIMITS, input({ requestId: "b" }), NOW);
    if (d2.allowed) await releaseAiReservation(store, d2.reservationId);
    expect([...reservations.values()][1]?.status).toBe("failed");
  });

  it("duplicate requestId is idempotent (DUPLICATE_REQUEST, no double count)", async () => {
    const { store, daily } = memStore();
    await reserveAiBudget(store, NO_LIMITS, input({ requestId: "same" }), NOW);
    const dup = await reserveAiBudget(store, NO_LIMITS, input({ requestId: "same" }), NOW);
    expect(dup).toMatchObject({ allowed: false, code: "DUPLICATE_REQUEST" });
    expect(daily.get(`ws-1|${dayUtcOf(NOW)}`)?.operations).toBe(1);
  });

  it("daily op limit is a hard deny", async () => {
    const { store } = memStore();
    const limits: LedgerLimits = { ...NO_LIMITS, dailyOperationLimit: 2 };
    expect((await reserveAiBudget(store, limits, input(), NOW)).allowed).toBe(true);
    expect((await reserveAiBudget(store, limits, input(), NOW)).allowed).toBe(true);
    const third = await reserveAiBudget(store, limits, input(), NOW);
    expect(third).toMatchObject({ allowed: false, code: "DAILY_OP_LIMIT" });
  });

  it("monthly cost limit is a hard deny at the ceiling", async () => {
    const { store } = memStore();
    const limits: LedgerLimits = { ...NO_LIMITS, monthlyCostLimitUsdMicros: 500_000n };
    expect((await reserveAiBudget(store, limits, input(), NOW)).allowed).toBe(true);   // 250k
    expect((await reserveAiBudget(store, limits, input(), NOW)).allowed).toBe(true);   // 500k
    const over = await reserveAiBudget(store, limits, input(), NOW);
    expect(over).toMatchObject({ allowed: false, code: "MONTHLY_COST_LIMIT" });
  });

  it("survives across rollup periods (month key distinct)", async () => {
    const { store, monthly } = memStore();
    await reserveAiBudget(store, NO_LIMITS, input(), new Date("2026-07-31T23:00:00Z"));
    await reserveAiBudget(store, NO_LIMITS, input(), new Date("2026-08-01T01:00:00Z"));
    expect(monthly.get(`ws-1|2026-07`)?.operations).toBe(1);
    expect(monthly.get(`ws-1|2026-08`)?.operations).toBe(1);
    expect(monthUtcOf(new Date("2026-08-01T01:00:00Z"))).toBe("2026-08");
  });

  it("concurrent reserves with unique ids all count (multi-replica shape)", async () => {
    const { store, daily } = memStore();
    await Promise.all(Array.from({ length: 10 }, () => reserveAiBudget(store, NO_LIMITS, input(), NOW)));
    expect(daily.get(`ws-1|${dayUtcOf(NOW)}`)?.operations).toBe(10);
  });
});

describe("A7 — threshold alerts", () => {
  it("returns crossed 50/75/90/100 marks", () => {
    expect(crossedThresholds(0n, 500_000n, 1_000_000n)).toEqual([50]);
    expect(crossedThresholds(500_000n, 1_000_000n, 1_000_000n)).toEqual([75, 90, 100]);
    expect(crossedThresholds(0n, 100n, null)).toEqual([]);
  });
});

describe("BILLING-014 / OPS-013 — the platform's monthly AI ceiling is durable and spans every workspace", () => {
  function withPlatform() {
    const m = memStore();
    m.store.getPlatformMonthlyUsage = async (month) => {
      let sum = 0n;
      for (const [key, v] of m.monthly) if (key.endsWith(`|${month}`)) sum += v.costUsdMicros;
      return { costUsdMicros: sum };
    };
    return m;
  }

  it("refuses a reservation that would take the platform over its ceiling, whichever workspace asks", async () => {
    const { store } = withPlatform();
    const limits: LedgerLimits = { ...NO_LIMITS, platformMonthlyCostLimitUsdMicros: 600_000n };
    expect((await reserveAiBudget(store, limits, input({ workspaceId: "ws-a" }), NOW)).allowed).toBe(true);
    expect((await reserveAiBudget(store, limits, input({ workspaceId: "ws-b" }), NOW)).allowed).toBe(true);
    // Each workspace is far under any limit of its own; together they are at 500k of 600k.
    expect(await reserveAiBudget(store, limits, input({ workspaceId: "ws-c" }), NOW)).toEqual({
      allowed: false,
      code: "PLATFORM_MONTHLY_COST_LIMIT",
    });
  });

  it("a reservation that fits is allowed, and a new month starts from zero", async () => {
    const { store } = withPlatform();
    const limits: LedgerLimits = { ...NO_LIMITS, platformMonthlyCostLimitUsdMicros: 300_000n };
    expect((await reserveAiBudget(store, limits, input(), NOW)).allowed).toBe(true);
    expect((await reserveAiBudget(store, limits, input(), NOW)).allowed).toBe(false);
    expect((await reserveAiBudget(store, limits, input(), new Date("2026-08-01T00:00:01Z"))).allowed).toBe(true);
  });

  it("with no ceiling configured nothing changes; a store that cannot read the total refuses rather than guesses", async () => {
    const plain = memStore();
    expect((await reserveAiBudget(plain.store, NO_LIMITS, input(), NOW)).allowed).toBe(true);
    expect(await reserveAiBudget(plain.store, { ...NO_LIMITS, platformMonthlyCostLimitUsdMicros: 1_000_000n }, input(), NOW)).toEqual({
      allowed: false,
      code: "PLATFORM_MONTHLY_COST_LIMIT",
    });
  });

  it("AI_PLATFORM_MONTHLY_BUDGET_USD is dollars; anything unusable means no ceiling", () => {
    expect(platformMonthlyLimitFromEnv("250")).toBe(250_000_000n);
    expect(platformMonthlyLimitFromEnv("12.5")).toBe(12_500_000n);
    for (const raw of [undefined, "", " ", "0", "-5", "abc"]) expect(platformMonthlyLimitFromEnv(raw)).toBeNull();
  });
});
