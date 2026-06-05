/**
 * Evidence completion post-finalize fanout — logging contract.
 *
 * The audit found bare catches at evidence-complete.service.ts:1280-1295
 * (post-finalize fanout) and :1270-1272 (scan enqueue) that silently
 * swallowed failures. The repair replaces them with bounded
 * utils/logger.warn calls.
 *
 * These tests pin the new contract in place:
 *
 *   1. Completion still succeeds (the helper NEVER throws) when the
 *      fanout helper itself throws — but the failure is observable via
 *      logger.warn("evidence_complete.fanout_failed", ...).
 *   2. When enqueueGraphReconcileJob returns { queued: false } (the
 *      shape the graph-reconcile-queue uses when Redis is unavailable),
 *      we emit logger.warn("evidence_complete.graph_reconcile_not_queued").
 *   3. When enqueueGraphReconcileJob ITSELF throws, we emit
 *      logger.warn("evidence_complete.graph_reconcile_enqueue_failed").
 *   4. On the happy path (fanout ok + graph queued ok), we emit NO
 *      warnings — the log surface only fires on real failure.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — bound BEFORE the SUT import.
// ---------------------------------------------------------------------------

const evidenceFindUniqueMock = vi.fn();
vi.mock("../src/db.js", () => ({
  prisma: { evidence: { findUnique: evidenceFindUniqueMock } },
}));

const runEvidenceFinalizationFanoutMock = vi.fn();
vi.mock(
  "../src/services/evidence-finalization-fanout.service.js",
  () => ({
    runEvidenceFinalizationFanout: runEvidenceFinalizationFanoutMock,
  }),
);

const enqueueGraphReconcileJobMock = vi.fn();
vi.mock("../src/queue/graph-reconcile-queue.js", () => ({
  enqueueGraphReconcileJob: enqueueGraphReconcileJobMock,
}));

const logWarnMock = vi.fn();
vi.mock("../src/utils/logger.js", () => ({
  log: vi.fn(),
  warn: logWarnMock,
  error: vi.fn(),
}));

// All the OTHER imports completeEvidence pulls in are NOT exercised by
// runEvidenceCompletePostFinalize; we mock them as no-ops so the module
// loads without side effects.
vi.mock("../src/crypto.js", () => ({
  canonicalJson: () => "",
  sha256Hex: () => "",
}));
vi.mock("@proovra/shared-billing", () => ({ canPlanGenerateReports: () => false }));
vi.mock("../src/signing/signer.js", () => ({ getEvidenceSigner: () => null }));
vi.mock("../src/services/billing-enforcement.service.js", () => ({
  assertWorkspaceAllowsStorageGrowth: vi.fn(),
  consumeWorkspaceCompletionCredits: vi.fn(),
  resolveWorkspaceScopeForUser: vi.fn(),
}));
vi.mock("../src/storage.js", () => ({
  applyDefaultObjectRetention: vi.fn(),
  getObjectStream: vi.fn(),
  headObject: vi.fn(),
}));
vi.mock("../src/stream-hash.js", () => ({ sha256HexFromStream: vi.fn() }));
vi.mock("../src/services/timestamp.service.js", () => ({
  createEvidenceTimestamp: vi.fn(),
}));
vi.mock("../src/queue/report-queue.js", () => ({
  enqueueGenerateReportJob: vi.fn(),
}));
vi.mock("../src/services/custody-events.service.js", () => ({
  appendCustodyEvent: vi.fn(),
  appendCustodyEventTx: vi.fn(),
}));
vi.mock("../src/services/integrations/webhook-dispatcher.js", () => ({
  emitWebhookEvent: vi.fn(),
}));
vi.mock("../src/services/security/file-security-scan.service.js", () => ({
  enqueueScan: vi.fn(),
  isMalwareScanningEnabled: () => false,
  runScan: vi.fn(),
}));
vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: vi.fn(),
}));
vi.mock("../src/services/reliability/upload-session.service.js", () => ({
  safeTransitionUploadSession: vi.fn(),
}));
vi.mock("../src/services/uploads/upload-session.service.js", () => ({
  evaluateUploadSessionFinalizeGate: vi.fn(),
}));

const { runEvidenceCompletePostFinalize } = await import(
  "../src/services/evidence-complete.service.js"
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  evidenceFindUniqueMock.mockReset();
  runEvidenceFinalizationFanoutMock.mockReset();
  enqueueGraphReconcileJobMock.mockReset();
  logWarnMock.mockReset();
});

describe("runEvidenceCompletePostFinalize — happy path", () => {
  it("emits no warnings when fanout + graph enqueue both succeed", async () => {
    evidenceFindUniqueMock.mockResolvedValueOnce({
      id: "ev-1",
      teamId: "team-1",
    });
    runEvidenceFinalizationFanoutMock.mockResolvedValueOnce({
      searchIndexingEnqueued: true,
      mediaIntelligenceEnqueued: true,
      graphReconcileEnqueued: true,
      perceptualHashEnqueued: false,
      ocrExtractionEnqueued: false,
      transcriptExtractionEnqueued: false,
      failureReasons: [],
    });
    enqueueGraphReconcileJobMock.mockResolvedValueOnce({
      queued: true,
      jobId: "graph-reconcile:team-1:evidence_completed:ev-1",
    });

    await expect(
      runEvidenceCompletePostFinalize({
        evidenceId: "ev-1",
        signingKeyVersion: 1,
      }),
    ).resolves.toBeUndefined();

    expect(logWarnMock).not.toHaveBeenCalled();
  });
});

describe("runEvidenceCompletePostFinalize — fanout helper throws", () => {
  it("returns normally AND emits fanout_failed warn (never throws to caller)", async () => {
    evidenceFindUniqueMock.mockResolvedValueOnce({
      id: "ev-2",
      teamId: "team-1",
    });
    runEvidenceFinalizationFanoutMock.mockRejectedValueOnce(
      new Error("redis connection refused"),
    );

    await expect(
      runEvidenceCompletePostFinalize({
        evidenceId: "ev-2",
        signingKeyVersion: 1,
      }),
    ).resolves.toBeUndefined();

    // The outer catch must have fired, NOT the queued:false branch.
    const warnCalls = logWarnMock.mock.calls;
    const codes = warnCalls.map((c) => c[0]);
    expect(codes).toContain("evidence_complete.fanout_failed");

    // The payload includes the evidence id and a bounded error message.
    const failCall = warnCalls.find(
      (c) => c[0] === "evidence_complete.fanout_failed",
    );
    expect(failCall).toBeTruthy();
    const payload = (failCall as unknown[])[1] as Record<string, unknown>;
    expect(payload.evidenceId).toBe("ev-2");
    expect(typeof payload.err).toBe("string");
    expect(payload.err).toContain("redis connection refused");
  });
});

describe("runEvidenceCompletePostFinalize — graph reconcile queued:false", () => {
  it("emits graph_reconcile_not_queued with the queue's reason", async () => {
    evidenceFindUniqueMock.mockResolvedValueOnce({
      id: "ev-3",
      teamId: "team-1",
    });
    runEvidenceFinalizationFanoutMock.mockResolvedValueOnce({
      searchIndexingEnqueued: true,
      mediaIntelligenceEnqueued: true,
      graphReconcileEnqueued: false,
      perceptualHashEnqueued: false,
      ocrExtractionEnqueued: false,
      transcriptExtractionEnqueued: false,
      failureReasons: [],
    });
    // The graph-reconcile-queue returns this shape when Redis is
    // unreachable (see graph-reconcile-queue.ts:113-120 boundedFailure).
    enqueueGraphReconcileJobMock.mockResolvedValueOnce({
      queued: false,
      jobId: "graph-reconcile:team-1:evidence_completed:ev-3",
      reason: "redis_unavailable",
    });

    await runEvidenceCompletePostFinalize({
      evidenceId: "ev-3",
      signingKeyVersion: 1,
    });

    const warnCalls = logWarnMock.mock.calls;
    const codes = warnCalls.map((c) => c[0]);
    expect(codes).toContain("evidence_complete.graph_reconcile_not_queued");
    expect(codes).not.toContain("evidence_complete.fanout_failed");

    const notQueuedCall = warnCalls.find(
      (c) => c[0] === "evidence_complete.graph_reconcile_not_queued",
    );
    const payload = (notQueuedCall as unknown[])[1] as Record<string, unknown>;
    expect(payload.evidenceId).toBe("ev-3");
    expect(payload.teamId).toBe("team-1");
    expect(payload.reason).toBe("redis_unavailable");
    expect(payload.jobId).toBe(
      "graph-reconcile:team-1:evidence_completed:ev-3",
    );
  });
});

describe("runEvidenceCompletePostFinalize — graph reconcile throws", () => {
  it("emits graph_reconcile_enqueue_failed (NOT fanout_failed) when enqueue itself throws", async () => {
    evidenceFindUniqueMock.mockResolvedValueOnce({
      id: "ev-4",
      teamId: "team-1",
    });
    runEvidenceFinalizationFanoutMock.mockResolvedValueOnce({
      searchIndexingEnqueued: true,
      mediaIntelligenceEnqueued: true,
      graphReconcileEnqueued: true,
      perceptualHashEnqueued: false,
      ocrExtractionEnqueued: false,
      transcriptExtractionEnqueued: false,
      failureReasons: [],
    });
    enqueueGraphReconcileJobMock.mockRejectedValueOnce(
      new Error("queue broker exploded"),
    );

    await runEvidenceCompletePostFinalize({
      evidenceId: "ev-4",
      signingKeyVersion: null,
    });

    const codes = logWarnMock.mock.calls.map((c) => c[0]);
    expect(codes).toContain("evidence_complete.graph_reconcile_enqueue_failed");
    expect(codes).not.toContain("evidence_complete.fanout_failed");
  });
});

describe("runEvidenceCompletePostFinalize — evidence row vanished", () => {
  it("no-ops silently when the row is gone (no warnings, no throw)", async () => {
    evidenceFindUniqueMock.mockResolvedValueOnce(null);

    await runEvidenceCompletePostFinalize({
      evidenceId: "ev-gone",
      signingKeyVersion: null,
    });

    expect(runEvidenceFinalizationFanoutMock).not.toHaveBeenCalled();
    expect(enqueueGraphReconcileJobMock).not.toHaveBeenCalled();
    expect(logWarnMock).not.toHaveBeenCalled();
  });
});
