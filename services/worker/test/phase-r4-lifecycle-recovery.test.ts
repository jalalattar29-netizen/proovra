/**
 * Lifecycle recovery — FIRST-ISSUANCE RECONCILIATION (2026-09-29).
 *
 * Replaces the Phase R4 "SIGNED, 15 min – 7 days, current plan includes
 * reports ⇒ generate" coverage. The rule now (Decision A):
 *
 *   * a finalized record with no report is issued its FIRST report (and its
 *     package) only when the ONE issuance decision says ENTITLED and
 *     `mayIssueHistoricalFirstOutputs` — a confirmed paid subscription or a
 *     credit-funded record. Trial, grace, Free and UNRESOLVED schedule nothing.
 *   * records signed more than 7 days ago need
 *     OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED (the backfill gate);
 *   * a REPORTED record whose LATEST report has no package gets a package-only
 *     request for exactly that version, only with OUTPUT_PACKAGE_RECOVERY_ENABLED;
 *   * records with live requests are skipped; nothing forces a new version.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const evidenceFindMany = vi.fn();
const requestFindMany = vi.fn();
const queryRaw = vi.fn();
const requestFromWorker = vi.fn();
const issuance = vi.fn();

vi.mock("../src/db.js", () => ({
  prisma: {
    evidence: { findMany: (...a: unknown[]) => evidenceFindMany(...a) },
    reportGenerationRequest: { findMany: (...a: unknown[]) => requestFindMany(...a) },
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
  },
}));
vi.mock("../src/queue.js", () => ({
  enqueueReportGenerationRequest: vi.fn(async () => ({ enqueued: true })),
}));
vi.mock("../src/report-generation-authority.js", () => ({
  requestReportGenerationFromWorker: (...a: unknown[]) => requestFromWorker(...a),
  reconcileStrandedReportRequests: vi.fn(async () => ({
    reenqueued: 0,
    leasesReleased: 0,
    terminalRepaired: 0,
  })),
}));
vi.mock("../src/output-issuance.js", () => ({
  resolveEvidenceOutputIssuance: (...a: unknown[]) => issuance(...a),
}));
vi.mock("../src/ots-initialization-reconciler.js", () => ({
  runOtsInitializationReconciler: vi.fn(async () => ({ scanned: 0, enqueued: 0 })),
}));
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { runFirstIssuanceReconciliation, resetFirstIssuanceCursors } = await import(
  "../src/first-issuance-reconciliation.js"
);
const { runLifecycleRecovery } = await import("../src/lifecycle-recovery.js");

const NOW = new Date("2026-09-29T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() - n * 86400_000);
const paid = {
  decision: "ENTITLED",
  basis: "PAID_SUBSCRIPTION",
  reportsIncluded: true,
  verificationPackageIncluded: true,
  mayIssueHistoricalFirstOutputs: true,
};

beforeEach(() => {
  resetFirstIssuanceCursors();
  evidenceFindMany.mockReset().mockResolvedValue([]);
  requestFindMany.mockReset().mockResolvedValue([]);
  queryRaw.mockReset().mockResolvedValue([]);
  requestFromWorker.mockReset().mockResolvedValue({ enqueued: true, requestId: "r1" });
  issuance.mockReset().mockResolvedValue(paid);
});
afterEach(() => {
  delete process.env.OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED;
  delete process.env.OUTPUT_PACKAGE_RECOVERY_ENABLED;
});

describe("first issuance", () => {
  it("scans finalized, usable, report-less records with NO upper age bound", async () => {
    await runFirstIssuanceReconciliation({ now: NOW });
    const where = evidenceFindMany.mock.calls[0][0].where;
    expect(where.status).toBe("SIGNED");
    expect(where.deletedAt).toBeNull();
    expect(where.reports).toEqual({ none: {} });
    expect(where.lifecycleState.in).not.toContain("TRASHED");
    expect(where.lifecycleState.in).not.toContain("DESTROYED");
    expect(where.signedAtUtc.gte).toBeUndefined();
  });

  it("issues the first report for a recent record under a confirmed paid subscription — never forced", async () => {
    evidenceFindMany.mockResolvedValue([
      { id: "e1", ownerUserId: "u", teamId: "t", signedAtUtc: days(2) },
    ]);
    const res = await runFirstIssuanceReconciliation({ now: NOW });
    expect(res.firstIssueScheduled).toBe(1);
    const call = requestFromWorker.mock.calls[0][0];
    expect(call.evidenceId).toBe("e1");
    expect(call).not.toHaveProperty("forceRegenerate");
    expect(call.packageForReportVersion).toBeUndefined();
  });

  it.each([
    ["Free plan", { ...paid, decision: "NOT_ENTITLED", basis: "FREE_PLAN", mayIssueHistoricalFirstOutputs: false }],
    ["trial", { ...paid, basis: "TRIAL", mayIssueHistoricalFirstOutputs: false }],
    ["payment grace", { ...paid, basis: "PAYMENT_GRACE", mayIssueHistoricalFirstOutputs: false }],
    ["lapsed", { ...paid, decision: "NOT_ENTITLED", basis: "PAYMENT_LAPSED", mayIssueHistoricalFirstOutputs: false }],
  ])("schedules nothing for a %s subject", async (_label, decision) => {
    issuance.mockResolvedValue(decision);
    evidenceFindMany.mockResolvedValue([
      { id: "e1", ownerUserId: "u", teamId: "t", signedAtUtc: days(2) },
    ]);
    const res = await runFirstIssuanceReconciliation({ now: NOW });
    expect(requestFromWorker).not.toHaveBeenCalled();
    expect(res.firstIssueSkippedNotEntitled).toBe(1);
  });

  it("an UNRESOLVED entitlement schedules nothing and is counted apart", async () => {
    issuance.mockResolvedValue({ ...paid, decision: "UNRESOLVED", mayIssueHistoricalFirstOutputs: false });
    evidenceFindMany.mockResolvedValue([
      { id: "e1", ownerUserId: "u", teamId: "t", signedAtUtc: days(2) },
    ]);
    const res = await runFirstIssuanceReconciliation({ now: NOW });
    expect(requestFromWorker).not.toHaveBeenCalled();
    expect(res.unresolved).toBe(1);
  });

  it("holds historical records behind the backfill gate, and issues them once it is on", async () => {
    evidenceFindMany.mockResolvedValue([
      { id: "old", ownerUserId: "u", teamId: "t", signedAtUtc: days(90) },
    ]);
    let res = await runFirstIssuanceReconciliation({ now: NOW });
    expect(res.firstIssueSkippedHistoricalGate).toBe(1);
    expect(requestFromWorker).not.toHaveBeenCalled();

    process.env.OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED = "true";
    resetFirstIssuanceCursors();
    res = await runFirstIssuanceReconciliation({ now: NOW });
    expect(res.firstIssueScheduled).toBe(1);
    expect(requestFromWorker.mock.calls[0][0].purpose).toBe("first_issuance");
  });

  it("skips a record that already has live work", async () => {
    evidenceFindMany.mockResolvedValue([
      { id: "e1", ownerUserId: "u", teamId: "t", signedAtUtc: days(2) },
    ]);
    requestFindMany.mockResolvedValue([{ evidenceId: "e1" }]);
    await runFirstIssuanceReconciliation({ now: NOW });
    expect(requestFromWorker).not.toHaveBeenCalled();
  });

  it("a dry run decides and counts but schedules nothing", async () => {
    evidenceFindMany.mockResolvedValue([
      { id: "e1", ownerUserId: "u", teamId: "t", signedAtUtc: days(2) },
    ]);
    const res = await runFirstIssuanceReconciliation({ now: NOW, dryRun: true });
    expect(res.firstIssueScheduled).toBe(1);
    expect(requestFromWorker).not.toHaveBeenCalled();
  });
});

describe("missing package for the latest report", () => {
  it("does not run unless enabled", async () => {
    await runFirstIssuanceReconciliation({ now: NOW });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("requests the package for EXACTLY the latest report version (v7), never a new report", async () => {
    process.env.OUTPUT_PACKAGE_RECOVERY_ENABLED = "true";
    queryRaw.mockResolvedValue([{ id: "e7", owner_user_id: "u", team_id: "t", version: 7 }]);
    const res = await runFirstIssuanceReconciliation({ now: NOW });
    expect(res.packageScheduled).toBe(1);
    const call = requestFromWorker.mock.calls.at(-1)![0];
    expect(call.packageForReportVersion).toBe(7);
    expect(call.purpose).toBe("package_recovery");
  });

  it("does not recover a package the subject is not entitled to now", async () => {
    process.env.OUTPUT_PACKAGE_RECOVERY_ENABLED = "true";
    issuance.mockResolvedValue({ ...paid, decision: "NOT_ENTITLED", basis: "SUBSCRIPTION_ENDED", verificationPackageIncluded: false });
    queryRaw.mockResolvedValue([{ id: "e7", owner_user_id: "u", team_id: "t", version: 7 }]);
    const res = await runFirstIssuanceReconciliation({ now: NOW });
    expect(res.packageSkippedNotEntitled).toBe(1);
    expect(requestFromWorker).not.toHaveBeenCalled();
  });
});

describe("lifecycle recovery tick", () => {
  it("runs first issuance, the stranded-request reconciler and the OTS initializer", async () => {
    const res = await runLifecycleRecovery({ trigger: "test" });
    expect(res).toBeTruthy();
    expect(evidenceFindMany).toHaveBeenCalled();
  });

  it("a failing first-issuance scan cannot stop the other halves", async () => {
    evidenceFindMany.mockRejectedValue(new Error("scan exploded"));
    const res = await runLifecycleRecovery({ trigger: "test" });
    expect(res.failed).toBeGreaterThanOrEqual(1);
  });
});

describe("scheduler wiring (source contract)", () => {
  const indexSrc = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
  it("schedules the reconciler with a kill-switch, a re-entrancy flag and a cross-replica lock", () => {
    expect(indexSrc).toContain('from "./lifecycle-recovery.js"');
    expect(indexSrc).toContain('envBoolean("LIFECYCLE_RECOVERY_ENABLED"');
    expect(indexSrc).toContain("startLifecycleRecoveryScheduler()");
    expect(indexSrc).toContain("stopLifecycleRecoveryScheduler()");
    expect(indexSrc).toContain("lifecycleRecoveryRunning");
    expect(indexSrc).toMatch(/withCronLock\("lifecycle-recovery"/);
  });
});
