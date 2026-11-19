/* eslint-disable @typescript-eslint/no-explicit-any -- a stateful Prisma double. */
/**
 * WS-SCHED / PRO-G2Z-03 — retention reconciliation progresses across the
 * whole expired population.
 *
 * At base the sweep re-selected the oldest `batchSize` expired rows every run
 * and skipped the ones flagged inside the 24 h window, so record #201+ was
 * never flagged. Now flagged rows are excluded in the query until their window
 * passes. Custody append and the hold lookup are replaced at their module
 * boundary; the selection predicate is exercised for real by the double.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@proovra/shared-runtime", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  appendCustodyEventTx: vi.fn(async () => undefined),
}));
vi.mock("../src/services/governance/legal-hold.service.js", () => ({
  isEvidenceUnderAnyLegalHold: vi.fn(async () => false),
}));
vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: vi.fn(),
}));

import { reconcileRetention } from "../src/services/governance/retention-sweeper.service.js";

function store(count: number) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
    teamId: "t",
    retentionUntilUtc: new Date(Date.now() - (count - i) * 60_000),
    retentionReconciliationFlaggedAtUtc: null as Date | null,
    archivedAt: null,
    deletedAt: null,
  }));
  const matches = (r: any, w: any) => {
    if (!w.OR) return true;
    return w.OR.some((c: any) =>
      c.retentionReconciliationFlaggedAtUtc === null
        ? r.retentionReconciliationFlaggedAtUtc === null
        : r.retentionReconciliationFlaggedAtUtc !== null && r.retentionReconciliationFlaggedAtUtc <= c.retentionReconciliationFlaggedAtUtc.lte,
    );
  };
  const evidence = {
    findMany: async (args: any) =>
      rows
        .filter((r) => r.retentionUntilUtc <= args.where.retentionUntilUtc.lte && matches(r, args.where))
        .sort((a, b) => a.retentionUntilUtc.getTime() - b.retentionUntilUtc.getTime())
        .slice(0, args.take)
        .map((r) => ({ ...r })),
    update: async (args: any) => {
      const r = rows.find((x) => x.id === args.where.id)!;
      r.retentionReconciliationFlaggedAtUtc = args.data.retentionReconciliationFlaggedAtUtc;
      return r;
    },
  };
  const client = { evidence, $transaction: async (fn: any) => fn({ evidence }) };
  return { rows, client };
}

describe("reconcileRetention progress (PRO-G2Z-03)", () => {
  it("with 500 expired records three runs flag all 500; a fourth run inside 24 h selects none", async () => {
    const { rows, client } = store(500);
    for (let i = 0; i < 3; i += 1) await reconcileRetention({ batchSize: 200 }, client as never);
    expect(rows.filter((r) => r.retentionReconciliationFlaggedAtUtc !== null)).toHaveLength(500);
    const fourth = await reconcileRetention({ batchSize: 200 }, client as never);
    expect(fourth.scanned).toBe(0);
  });
});
