/**
 * The scheduled billing sweeps say what they did not do.
 *
 *   * The dependent-cancellation retry sweep reports obligations it could not
 *     attribute to a workspace and a condition sweep that was truncated.
 *   * The reconciliation sweep reports discrepancies (paid, not credited)
 *     instead of folding them into a success line.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    workspaceStorageAddon: { findMany: vi.fn(async () => [] as unknown[]) },
    billingCheckoutAttempt: { findMany: vi.fn(async () => [] as unknown[]) },
    payment: { findMany: vi.fn(async () => [] as unknown[]) },
    subscription: { findMany: vi.fn(async () => [] as unknown[]) },
    evidenceCreditLedgerEntry: { findMany: vi.fn(async () => [] as unknown[]) },
  },
  sync: vi.fn(),
  reconcile: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../src/utils/logger.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  log: (...a: unknown[]) => h.log(...a),
  warn: (...a: unknown[]) => h.warn(...a),
}));
vi.mock("../src/services/billing/dependent-cancellation-conditions.service.js", () => ({
  syncDependentCancellationConditions: (...a: unknown[]) => h.sync(...a),
}));
vi.mock("../src/services/billing/reconciliation/reconciliation.service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reconcileBillingAccount: (...a: unknown[]) => h.reconcile(...a),
}));

const retryJob = await import("../src/jobs/dependent-cancellation-retry.job.js");
const reconJob = await import("../src/jobs/billing-reconciliation.job.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dependent-cancellation retry sweep", () => {
  it("returns and warns about unattributable obligations and a truncated condition sweep", async () => {
    h.sync.mockResolvedValue({ opened: 3, scanned: 1000, skippedUnscoped: 2, truncated: true });
    const r = await retryJob.runDependentCancellationRetrySweep();
    expect(r).toMatchObject({
      conditionsOpened: 3,
      conditionsSkippedUnscoped: 2,
      conditionsTruncated: true,
    });
    expect(h.warn).toHaveBeenCalledWith(
      "billing.dependent_cancellation.conditions_incomplete",
      { scanned: 1000, skippedUnscoped: 2, truncated: true },
    );
  });

  it("a complete sweep raises no warning", async () => {
    h.sync.mockResolvedValue({ opened: 1, scanned: 1, skippedUnscoped: 0, truncated: false });
    const r = await retryJob.runDependentCancellationRetrySweep();
    expect(r.conditionsTruncated).toBe(false);
    expect(h.warn).not.toHaveBeenCalledWith(
      "billing.dependent_cancellation.conditions_incomplete",
      expect.anything(),
    );
  });
});

describe("billing reconciliation sweep", () => {
  it("sums and reports discrepancies and unavailable bindings", async () => {
    h.prisma.billingCheckoutAttempt.findMany.mockResolvedValue([{ userId: "u-1" }, { userId: "u-2" }]);
    h.reconcile
      .mockResolvedValueOnce({ outcome: "ACTION_REQUIRED", discrepancies: 1, unavailable: 0 })
      .mockResolvedValueOnce({ outcome: "UPDATED", discrepancies: 0, unavailable: 2 });
    const r = await reconJob.runBillingReconciliationSweep({ providers: {} });
    expect(r).toEqual({ attempted: 2, updated: 1, failed: 0, discrepancies: 1, unavailable: 2 });
    expect(h.warn).toHaveBeenCalledWith("billing.reconciliation.discrepancies_found", {
      discrepancies: 1,
    });
  });
});
