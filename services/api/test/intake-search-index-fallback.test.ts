/**
 * A COMPLETED RECORD THAT NOTHING CAN FIND.
 *
 * External Intake creates and completes an entire evidence record inside one
 * public request, from someone who is not a user of the product and will never
 * come back to retry. Its searchability then depends on a single call to
 * `enqueueSearchIndexingJob` — which by design NEVER THROWS: a missing
 * `REDIS_URL`, a dead connection or an unreachable queue all come back as
 * `{ enqueued: false, reason }`.
 *
 * The fanout recorded that truthfully and moved on, which left a signed,
 * valid, perfectly good record that no search surface could return. Reproduced
 * against the local fixture: nine search-indexing jobs sat unprocessed in
 * `bull:search-indexing:wait`, the workspace held zero search documents, and
 * `/v1/search` answered every one of the six identity probes with no rows.
 * A single synchronous reindex made all six succeed — the projection and the
 * query were right the whole time; nothing had written the document.
 *
 * So a lost enqueue now falls back to writing the index inline, through the
 * SAME canonical indexer the worker runs. Not a second implementation, not a
 * second opinion about what a document contains — the queue stays the primary
 * path because indexing belongs off the request, and this is only what happens
 * when the primary path is unavailable.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueSearchIndexingJobMock = vi.fn();
vi.mock("../src/queue/search-queue.js", () => ({
  enqueueSearchIndexingJob: enqueueSearchIndexingJobMock,
}));

const indexEvidenceMock = vi.fn();
vi.mock("../src/services/search/evidence-indexing.service.js", () => ({
  indexEvidence: indexEvidenceMock,
}));

// The fanout's other steps are not what this file is about; every one of them
// reaches a queue, a database or a provider probe, so they are stubbed and the
// search step is exercised on its own.
vi.mock("../src/queue/media-intelligence-queue.js", () => ({
  enqueueMediaIntelligenceAnalysis: vi.fn().mockResolvedValue({ queued: true }),
}));
vi.mock("../src/queue/graph-reconcile-queue.js", () => ({
  enqueueGraphReconcileJob: vi.fn().mockResolvedValue({ queued: true }),
}));
vi.mock("../src/db.js", () => ({
  prisma: {
    evidence: { findUnique: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/services/redaction/providers/azure-document-intelligence-client.js", () => ({
  probeAzureDocumentIntelligence: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../src/services/redaction/providers/deepgram-client.js", () => ({
  probeDeepgram: vi.fn().mockResolvedValue({ ok: true }),
}));

const { runEvidenceFinalizationFanout } = await import(
  "../src/services/evidence-finalization-fanout.service.js"
);

const INPUT = {
  teamId: "11111111-1111-4111-8111-111111111111",
  evidenceId: "22222222-2222-4222-8222-222222222222",
  reason: "evidence_completed" as const,
  signatureVersion: 1,
};

describe("search indexing survives an unreachable queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the index inline when the enqueue does not happen", async () => {
    enqueueSearchIndexingJobMock.mockResolvedValue({
      enqueued: false,
      reason: "queue_unavailable",
    });
    indexEvidenceMock.mockResolvedValue({ documentId: "doc-1", created: true });

    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const result = await runEvidenceFinalizationFanout(INPUT, logger as never);

    // The record reached the index — through the canonical indexer, for the
    // same workspace and the same evidence.
    expect(indexEvidenceMock).toHaveBeenCalledTimes(1);
    expect(indexEvidenceMock).toHaveBeenCalledWith({
      teamId: INPUT.teamId,
      evidenceId: INPUT.evidenceId,
    });

    // …and the outcome says so, rather than reporting a gap that no longer
    // exists.
    expect(result.searchIndexingEnqueued).toBe(true);

    // The failed enqueue is still recorded. The fallback is a repair, not a
    // reason to stop reporting that the queue was unreachable.
    expect(result.failureReasons).toContain("search_indexing:queue_unavailable");
    const logged = logger.warn.mock.calls.map((c) => c[1]);
    expect(logged).toContain("finalize_fanout.search_indexing_not_enqueued");
    expect(logged).toContain("finalize_fanout.search_indexing_indexed_inline");
  });

  it("does not index inline when the queue accepted the job", async () => {
    /*
     * The queue is the primary path and stays it. Indexing inline on the happy
     * path would put the projection's work back into the request this design
     * took it out of, and would double every index write.
     */
    enqueueSearchIndexingJobMock.mockResolvedValue({
      enqueued: true,
      jobId: "job-1",
    });

    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const result = await runEvidenceFinalizationFanout(INPUT, logger as never);

    expect(indexEvidenceMock).not.toHaveBeenCalled();
    expect(result.searchIndexingEnqueued).toBe(true);
    expect(
      result.failureReasons.filter((r) => r.startsWith("search_indexing")),
    ).toEqual([]);
  });

  it("still completes when the inline index itself fails", async () => {
    /*
     * Evidence completion has never depended on the index and does not start
     * now. A database that cannot take the document is recorded and the
     * finalization stands — the alternative is refusing a contributor's
     * submission because a search row could not be written.
     */
    enqueueSearchIndexingJobMock.mockResolvedValue({
      enqueued: false,
      reason: "queue_unavailable",
    });
    indexEvidenceMock.mockRejectedValue(new Error("index write failed"));

    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const result = await runEvidenceFinalizationFanout(INPUT, logger as never);

    expect(result.searchIndexingEnqueued).toBe(false);
    expect(
      result.failureReasons.some((r) => r.startsWith("search_indexing_inline:")),
    ).toBe(true);
    expect(logger.warn.mock.calls.map((c) => c[1])).toContain(
      "finalize_fanout.search_indexing_inline_failed",
    );
  });
});
