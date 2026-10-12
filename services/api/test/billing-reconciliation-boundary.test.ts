/**
 * Reconciliation at the Billing / Operations boundary.
 *
 *   * A credit purchase that does not match its price is a durable
 *     AMOUNT_MISMATCH review item, not only a counter the sweep discards.
 *   * Already-granted purchases are not candidates, so an older lost grant is
 *     never starved behind newer granted ones.
 *   * A Personal account's reconciliation attempts its payer's obligations and
 *     syncs ONLY that payer's conditions, never the global sweep.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Fn = ReturnType<typeof vi.fn>;

const h = vi.hoisted(() => {
  const models = new Map<string, Record<string, Fn>>();
  const defaults: Record<string, () => unknown> = {
    findMany: () => [],
    findFirst: () => null,
    findUnique: () => null,
    count: () => 0,
    updateMany: () => ({ count: 0 }),
    update: () => ({}),
    create: () => ({}),
    groupBy: () => [],
  };
  const model = (name: string) => {
    let m = models.get(name);
    if (!m) {
      m = {};
      for (const [k, d] of Object.entries(defaults)) m[k] = vi.fn(async () => d());
      models.set(name, m);
    }
    return m;
  };
  const prisma = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => model(prop),
  });
  return {
    prisma,
    model,
    reset: () => models.clear(),
    recordBillingReviewItem: vi.fn<(i: Record<string, unknown>) => Promise<unknown>>(async () => undefined),
    sync: vi.fn<(i?: Record<string, unknown>) => Promise<unknown>>(async () => ({
      opened: 0,
      scanned: 0,
      skippedUnscoped: 0,
      truncated: false,
    })),
    attemptPayer: vi.fn<(i: Record<string, unknown>) => Promise<unknown>>(async () => ({
      attempted: 0,
      confirmed: 0,
      failed: 0,
      escalated: 0,
    })),
    recordObligations: vi.fn(async () => ({ created: 0, alreadyOpen: 0 })),
  };
});

vi.mock("../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../src/services/billing/billing-review.service.js", () => ({
  recordBillingReviewItem: (i: Record<string, unknown>) => h.recordBillingReviewItem(i),
}));
vi.mock("../src/services/billing/dependent-cancellation-conditions.service.js", () => ({
  syncDependentCancellationConditions: (i?: Record<string, unknown>) => h.sync(i),
}));
vi.mock("../src/services/billing/dependent-cancellation.service.js", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    attemptPayerDependentCancellations: (i: Record<string, unknown>) => h.attemptPayer(i),
    recordDependentCancellationObligations: () => h.recordObligations(),
  };
});
vi.mock("../src/services/billing/checkout-attempt-recovery.service.js", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, reconcileCheckoutAttempts: vi.fn(async () => undefined) };
});
vi.mock("../src/services/observability/incident.service.js", () => ({
  recordIncident: vi.fn(async () => ({})),
  resolveConditionFromSourceRecovery: vi.fn(async () => ({ resolved: false })),
}));

const rec = await import("../src/services/billing/reconciliation/reconciliation.service.js");
const { emptySummary } = await import("../src/services/billing/reconciliation/types.js");

const binding = { provider: "PAYPAL" as never, providerPaymentId: "CAPTURE-1" };

function observation(over: Record<string, unknown> = {}) {
  return {
    state: "SUCCEEDED",
    observedAtUtc: null,
    amountCents: 999,
    currency: "USD",
    quantity: null,
    productKey: "EVIDENCE_CREDIT",
    attemptId: null,
    ...over,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.reset();
});

describe("validateCreditPurchase records a review item for every discrepancy", () => {
  it("an amount that does not match the attempt price is AMOUNT_MISMATCH, never a grant", async () => {
    h.model("billingCheckoutAttempt").findUnique!.mockResolvedValue({
      userId: "user-1",
      product: "EVIDENCE_CREDIT",
      amountCents: 1500,
      currency: "usd",
    });
    const summary = emptySummary();
    const ok = await rec.validateCreditPurchase(
      observation({ amountCents: 999 }),
      "user-1",
      "attempt-1",
      summary,
      binding,
    );
    expect(ok).toBe(false);
    expect(summary.discrepancies).toBe(1);
    expect(h.recordBillingReviewItem).toHaveBeenCalledTimes(1);
    expect(h.recordBillingReviewItem.mock.calls[0]![0]).toMatchObject({
      userId: "user-1",
      provider: "PAYPAL",
      providerResourceId: "CAPTURE-1",
      product: "EVIDENCE_CREDIT",
      reason: "AMOUNT_MISMATCH",
      detail: {
        source: "reconciliation",
        mismatch: "AMOUNT",
        observedAmountCents: 999,
        expectedAmountCents: 1500,
        expectedCurrency: "USD",
      },
    });
  });

  it("an unsupported currency and a wrong quantity are each recorded", async () => {
    const s1 = emptySummary();
    expect(
      await rec.validateCreditPurchase(observation({ currency: "GBP" }), "user-1", null, s1, binding),
    ).toBe(false);
    expect(h.recordBillingReviewItem.mock.calls[0]![0]).toMatchObject({
      detail: { mismatch: "CURRENCY" },
    });

    h.model("billingCheckoutAttempt").findUnique!.mockResolvedValue({
      userId: "user-1",
      product: "EVIDENCE_CREDIT",
      amountCents: 999,
      currency: "USD",
    });
    const s2 = emptySummary();
    expect(
      await rec.validateCreditPurchase(
        observation({ amountCents: 999, quantity: 999 }),
        "user-1",
        "attempt-1",
        s2,
        binding,
      ),
    ).toBe(false);
    expect(h.recordBillingReviewItem.mock.calls[1]![0]).toMatchObject({
      detail: { mismatch: "QUANTITY" },
    });
  });

  it("a review write that fails still counts the discrepancy and grants nothing", async () => {
    h.recordBillingReviewItem.mockRejectedValueOnce(new Error("db down"));
    const summary = emptySummary();
    const ok = await rec.validateCreditPurchase(
      observation({ currency: "GBP" }),
      "user-1",
      null,
      summary,
      binding,
    );
    expect(ok).toBe(false);
    expect(summary.discrepancies).toBe(1);
  });

  it("a matching purchase records nothing", async () => {
    h.model("billingCheckoutAttempt").findUnique!.mockResolvedValue({
      userId: "user-1",
      product: "EVIDENCE_CREDIT",
      amountCents: 999,
      currency: "USD",
    });
    const summary = emptySummary();
    expect(
      await rec.validateCreditPurchase(observation(), "user-1", "attempt-1", summary, binding),
    ).toBe(true);
    expect(summary.discrepancies).toBe(0);
    expect(h.recordBillingReviewItem).not.toHaveBeenCalled();
  });
});

describe("selectUngrantedCreditCandidates", () => {
  const pay = (i: number, product: string | null = "EVIDENCE_CREDIT") => ({
    id: `p-${String(i).padStart(3, "0")}`,
    provider: "STRIPE",
    providerPaymentId: `pi_${i}`,
    amountCents: 999,
    currency: "USD",
    status: "SUCCEEDED",
    providerStateAtUtc: null,
    product,
    checkoutAttemptId: null,
    createdAt: new Date(Date.UTC(2026, 0, 1) + (1000 - i) * 60_000),
  });

  it("an ungranted purchase behind a full page of granted ones is still reached", async () => {
    const page1 = Array.from({ length: rec.MAX_BINDINGS_PER_RUN }, (_, i) => pay(i, i === 0 ? null : "EVIDENCE_CREDIT"));
    const lost = pay(500);
    h.model("payment").findMany!.mockResolvedValueOnce(page1).mockResolvedValueOnce([lost]);
    h.model("evidenceCreditLedgerEntry").findMany!
      .mockResolvedValueOnce(page1.map((p) => ({ provider: "STRIPE", providerRef: p.providerPaymentId })))
      .mockResolvedValueOnce([]);
    const classify = vi.fn(async () => undefined);

    const out = await rec.selectUngrantedCreditCandidates("user-1", classify);

    expect(out.map((p) => p.id)).toEqual([lost.id]);
    // The granted historic row with no product is classified on the way past.
    expect(classify).toHaveBeenCalledWith(page1[0]!.id, "EVIDENCE_CREDIT");
    const second = h.model("payment").findMany!.mock.calls[1]![0];
    const last = page1[page1.length - 1]!;
    expect(second.where.AND[1]).toEqual({
      OR: [
        { createdAt: { lt: last.createdAt } },
        { createdAt: last.createdAt, id: { lt: last.id } },
      ],
    });
  });

  it("stops at the page budget", async () => {
    const full = () =>
      Array.from({ length: rec.MAX_BINDINGS_PER_RUN }, (_, i) => pay(i));
    h.model("payment").findMany!.mockImplementation(async () => full());
    h.model("evidenceCreditLedgerEntry").findMany!.mockImplementation(
      async (args: { where: { providerRef: { in: string[] } } }) =>
        args.where.providerRef.in.map((r) => ({ provider: "STRIPE", providerRef: r })),
    );
    const out = await rec.selectUngrantedCreditCandidates("user-1", vi.fn(async () => undefined));
    expect(out).toEqual([]);
    expect(h.model("payment").findMany).toHaveBeenCalledTimes(rec.MAX_CREDIT_CANDIDATE_PAGES);
  });
});

describe("Personal reconciliation converges only its payer's obligations", () => {
  it("attempts the payer's obligations and syncs that payer's conditions, not the global sweep", async () => {
    h.model("workspaceStorageAddon").count!.mockResolvedValue(2);
    const summary = await rec.reconcileBillingAccount({
      account: {
        type: "PERSONAL",
        id: "user-1",
        displayName: "",
        capabilities: [],
        billingOwnerMissing: false,
      } as never,
      providers: {},
    });
    expect(h.attemptPayer).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1" }));
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.sync).toHaveBeenCalledWith({ payerUserId: "user-1" });
    const countWhere = h.model("workspaceStorageAddon").count!.mock.calls[0]![0].where;
    expect(countWhere).toMatchObject({
      ownerUserId: "user-1",
      OR: [{ teamId: null }, { team: { ownerUserId: "user-1" } }],
    });
    expect(summary.actionRequired).toBe(2);
  });

  it("nothing owed, nothing synced", async () => {
    h.model("workspaceStorageAddon").count!.mockResolvedValue(0);
    await rec.reconcileBillingAccount({
      account: { type: "PERSONAL", id: "user-1", displayName: "", capabilities: [], billingOwnerMissing: false } as never,
      providers: {},
    });
    expect(h.sync).not.toHaveBeenCalled();
  });
});
