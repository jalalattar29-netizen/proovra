/**
 * Closure 2 ("sem" item 5, PRO-W1-04) — the MISSING PACKAGE pass, flag OFF:
 * a package owed by a report request that COMMITTED its report and then went
 * FAILED_TERMINAL is re-asked (package-only, that version, owed) once the
 * technical terminal has rested; an integrity terminal or a still-resting one
 * is not; a plain missing package with no committed run stays behind the flag.
 * The live-database proof is services/api/test/sem-w1-04-owed-package-recovery
 * .integration.test.ts; this pins the decision on the rows the scan returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
const requestFromWorker = vi.fn();
const issuance = vi.fn();

vi.mock("../src/db.js", () => ({
  prisma: {
    evidence: { findMany: async () => [] },
    reportGenerationRequest: { findMany: async () => [], findFirst: async () => null },
    subscription: { findMany: async () => [] },
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
  },
}));
vi.mock("../src/queue.js", () => ({
  enqueueReportGenerationRequest: vi.fn(async () => ({ enqueued: true })),
}));
vi.mock("../src/report-generation-authority.js", () => ({
  OWED_TECHNICAL_RETRY_BACKOFF_MS: 30 * 60 * 1000,
  requestReportGenerationFromWorker: (...a: unknown[]) => requestFromWorker(...a),
}));
vi.mock("../src/output-issuance.js", () => ({
  resolveEvidenceOutputIssuance: (...a: unknown[]) => issuance(...a),
}));
vi.mock("../src/workspace-billing.js", () => ({ packageRebuildFitsStorage: async () => true }));
vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { runFirstIssuanceReconciliation, resetFirstIssuanceCursors } = await import(
  "../src/first-issuance-reconciliation.js"
);

const NOW = new Date("2026-11-21T12:00:00Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  owner_user_id: "u",
  team_id: "t",
  version: 3,
  gate_blocked: false,
  owed_reason: null,
  owed_completed_at: null,
  ...over,
});

beforeEach(() => {
  resetFirstIssuanceCursors();
  delete process.env.OUTPUT_PACKAGE_RECOVERY_ENABLED;
  queryRaw.mockReset();
  requestFromWorker.mockReset().mockResolvedValue({ enqueued: true, requestId: "r" });
  issuance.mockReset().mockResolvedValue({
    decision: "ENTITLED",
    reportsIncluded: true,
    verificationPackageIncluded: true,
    mayIssueHistoricalFirstOutputs: true,
  });
});
afterEach(() => delete process.env.OUTPUT_PACKAGE_RECOVERY_ENABLED);

describe("PRO-W1-04 — owed package after a committed report, flag off", () => {
  it("re-asks a rested TECHNICAL terminal package-only, for exactly that version, as owed", async () => {
    queryRaw.mockResolvedValue([row("owed", { owed_reason: "RETRY_BUDGET_EXHAUSTED", owed_completed_at: minutesAgo(45) })]);
    const s = await runFirstIssuanceReconciliation({ now: NOW });
    expect(requestFromWorker).toHaveBeenCalledTimes(1);
    expect(requestFromWorker.mock.calls[0][0]).toMatchObject({
      evidenceId: "owed",
      packageForReportVersion: 3,
      owed: true,
      purpose: "package_recovery",
    });
    expect(s.packageOwedRecovered).toBe(1);
  });

  it("does not re-ask an integrity terminal, a terminal still resting, an unentitled record, or a plain missing package", async () => {
    queryRaw.mockResolvedValue([
      row("integrity", { owed_reason: "REPORT_INTEGRITY_MISMATCH", owed_completed_at: minutesAgo(600) }),
      row("resting", { owed_reason: "RETRY_BUDGET_EXHAUSTED", owed_completed_at: minutesAgo(10) }),
      row("plain"),
    ]);
    const s = await runFirstIssuanceReconciliation({ now: NOW });
    expect(requestFromWorker).not.toHaveBeenCalled();
    expect(s.packageOwedNotTechnical).toBe(1);
    expect(s.packageOwedResting).toBe(1);

    queryRaw.mockResolvedValue([row("unentitled", { owed_reason: "RETRY_BUDGET_EXHAUSTED", owed_completed_at: minutesAgo(45) })]);
    issuance.mockResolvedValue({ decision: "NOT_ENTITLED", verificationPackageIncluded: false });
    resetFirstIssuanceCursors();
    await runFirstIssuanceReconciliation({ now: NOW });
    expect(requestFromWorker).not.toHaveBeenCalled();
  });
});
