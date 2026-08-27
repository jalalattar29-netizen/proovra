/**
 * Phase R4 — SIGNED-without-report lifecycle recovery reconciler.
 *
 * Behavioural coverage (finding F4): the reconciler must detect evidence
 * durably stuck at SIGNED with no Report row and idempotently re-enqueue
 * the report job — while skipping plan-ineligible evidence so it never
 * churns. Deps are mocked (the real `./queue.js` opens a Redis connection
 * at import time, so mocking is required, not just convenient).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const enqueueReportJob = vi.fn();
const resolveEffectivePlanForEvidence = vi.fn();

vi.mock("../src/db.js", () => ({
  prisma: { evidence: { findMany: (...args: unknown[]) => findMany(...args) } },
}));
// PHASE 12 — POINT 5. The recovery persists a durable
// `ReportGenerationRequest` through the shared authority and then enqueues that
// row's id, so the two collaborators are mocked separately: the authority
// stands in for "intent was recorded and scheduled", and the queue module stays
// mocked because importing it opens a real Redis connection.
vi.mock("../src/queue.js", () => ({
  enqueueReportGenerationRequest: vi.fn(async () => ({
    enqueued: true,
    jobId: "report-req",
  })),
}));
vi.mock("../src/report-generation-authority.js", () => ({
  requestReportGenerationFromWorker: (...args: unknown[]) =>
    enqueueReportJob(...args),
}));
vi.mock("../src/workspace-billing.js", () => ({
  resolveEffectivePlanForEvidence: (...args: unknown[]) =>
    resolveEffectivePlanForEvidence(...args),
  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — recovery now asks how the
  // record was FUNDED before deciding it is plan-ineligible, so a report the
  // customer paid for with an evidence credit is not silently abandoned on a
  // FREE account. These cases are all plan-funded.
  resolveEvidenceFundingSource: async () => "PLAN",
}));
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// A plan can generate reports unless it is FREE (enough to exercise the skip).
vi.mock("@proovra/shared-billing", () => ({
  // The outputs a record earns follow its plan AND its funding. FREE grants no
  // report on a plan-funded record; a credit-funded one always does.
  resolveEvidenceOutputEntitlements: (input: {
    plan: string;
    funding: string;
  }) => ({
    reportsIncluded: input.funding === "EVIDENCE_CREDIT" || input.plan !== "FREE",
    verificationPackageIncluded:
      input.funding === "EVIDENCE_CREDIT" || input.plan !== "FREE",
    publicVerifyIncluded: true,
  }),
}));

import { runLifecycleRecovery } from "../src/lifecycle-recovery.js";

beforeEach(() => {
  findMany.mockReset();
  enqueueReportJob.mockReset();
  resolveEffectivePlanForEvidence.mockReset();
});

describe("Phase R4 — lifecycle recovery reconciler", () => {
  it("queries only SIGNED, non-deleted, report-less evidence within an age window", async () => {
    findMany.mockResolvedValue([]);
    await runLifecycleRecovery({ trigger: "test" });

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      take: number;
      orderBy: unknown;
    };
    expect(arg.where.status).toBe("SIGNED");
    expect(arg.where.deletedAt).toBeNull();
    expect(arg.where.reports).toEqual({ none: {} });
    // Age window: signedAtUtc bounded on both ends.
    const signed = arg.where.signedAtUtc as { gte: Date; lte: Date };
    expect(signed.gte).toBeInstanceOf(Date);
    expect(signed.lte).toBeInstanceOf(Date);
    expect(signed.gte.getTime()).toBeLessThan(signed.lte.getTime());
    // Bounded batch.
    expect(arg.take).toBeGreaterThan(0);
    expect(arg.take).toBeLessThanOrEqual(1000);
  });

  it("re-enqueues eligible stuck evidence and reports the count", async () => {
    findMany.mockResolvedValue([
      { id: "ev-1", ownerUserId: "u1", teamId: "t1" },
      { id: "ev-2", ownerUserId: "u2", teamId: null },
    ]);
    resolveEffectivePlanForEvidence.mockResolvedValue("TEAM");
    enqueueReportJob.mockResolvedValue({ enqueued: true });

    const res = await runLifecycleRecovery({ trigger: "test" });

    // PHASE 12 — POINT 5. The recovery no longer says "enqueue a report for
    // this evidence id"; it says "record a lifecycle_recovery request, from
    // this machine principal, for this evidence" — and the enqueue is what the
    // authority does with that record. The purpose and the principal are
    // asserted because they are what makes the resulting request auditable.
    expect(enqueueReportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceId: "ev-1",
        purpose: "lifecycle_recovery",
        machineId: "worker.lifecycle-recovery",
      }),
    );
    expect(enqueueReportJob).toHaveBeenCalledWith(
      expect.objectContaining({ evidenceId: "ev-2" }),
    );
    expect(res.reenqueued).toBe(2);
    expect(res.scanned).toBe(2);
    expect(res.skippedIneligiblePlan).toBe(0);
  });

  it("skips plan-ineligible evidence — never enqueues a report the plan may not have", async () => {
    findMany.mockResolvedValue([{ id: "free-ev", ownerUserId: "u", teamId: null }]);
    resolveEffectivePlanForEvidence.mockResolvedValue("FREE");

    const res = await runLifecycleRecovery({ trigger: "test" });

    expect(enqueueReportJob).not.toHaveBeenCalled();
    expect(res.reenqueued).toBe(0);
    expect(res.skippedIneligiblePlan).toBe(1);
  });

  it("counts idempotent no-op enqueues (existing job) separately from fresh re-enqueues", async () => {
    findMany.mockResolvedValue([{ id: "ev-dup", ownerUserId: "u", teamId: "t" }]);
    resolveEffectivePlanForEvidence.mockResolvedValue("TEAM");
    enqueueReportJob.mockResolvedValue({ enqueued: false, reason: "already-queued" });

    const res = await runLifecycleRecovery({ trigger: "test" });

    expect(res.reenqueued).toBe(0);
    expect(res.skippedExistingJob).toBe(1);
  });

  it("isolates per-evidence failures without aborting the sweep", async () => {
    findMany.mockResolvedValue([
      { id: "bad", ownerUserId: "u", teamId: "t" },
      { id: "good", ownerUserId: "u", teamId: "t" },
    ]);
    resolveEffectivePlanForEvidence.mockResolvedValue("TEAM");
    enqueueReportJob
      .mockRejectedValueOnce(new Error("redis down"))
      .mockResolvedValueOnce({ enqueued: true });

    const res = await runLifecycleRecovery({ trigger: "test" });

    expect(res.failed).toBe(1);
    expect(res.reenqueued).toBe(1);
  });
});

describe("Phase R4 — scheduler wiring (source contract)", () => {
  const indexSrc = readFileSync(
    fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    "utf8",
  );

  it("imports and schedules the reconciler with an env kill-switch + start/stop", () => {
    expect(indexSrc).toContain('from "./lifecycle-recovery.js"');
    expect(indexSrc).toContain('envBoolean("LIFECYCLE_RECOVERY_ENABLED"');
    expect(indexSrc).toContain("startLifecycleRecoveryScheduler()");
    expect(indexSrc).toContain("stopLifecycleRecoveryScheduler()");
    // Guarded by a re-entrancy flag like the sibling reconcilers.
    expect(indexSrc).toContain("lifecycleRecoveryRunning");
  });
});
