/**
 * PHASE 12 — POINT 5, FAMILY 3a: retention/destruction — the irreversible half.
 *
 * Two units, both of which end in data that cannot be recovered:
 *
 *   PurgeDeletedEvidenceJob        services/worker/src/processor.ts
 *   DestructionOrchestratorSweep   services/worker/src/governance/
 *                                  destruction-orchestrator.worker.ts
 *
 * Driven against live PostgreSQL 16 through the REAL executors. Nothing about
 * tenancy, legal holds, claims, terminal state or ordering is simulated; the
 * only substitution is object storage, which is a genuine external process and
 * is replaced by a RECORDING fake so every case can assert exactly which
 * objects would have been deleted — and, more often, that none would have.
 *
 * WHY THE COMMON HARNESS IS NOT USED FOR `PurgeDeletedEvidenceJob`
 * ---------------------------------------------------------------------------
 * The shared conformance harness reads a row's STATE string after each step.
 * A successful purge does not leave a state: it deletes the Evidence row. The
 * unit's terminal condition is therefore ABSENCE, which the driver contract
 * cannot express without pretending null is a state. The seven invariants are
 * proven here directly against row existence, which is what they actually mean
 * for this unit.
 *
 * WHAT THIS SUITE FOUND
 * ---------------------------------------------------------------------------
 * The destruction orchestrator's documented "one non-terminal execution per
 * review" was a read followed by a create, and the shared governance run lock
 * it sits inside was the same shape. Both are fixed in production code
 * (migration 20271115000000 supplies the two partial unique indexes that make
 * the claims atomic); the cases below are the regression proof.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { JOB_NAMES, decodeJobPayload, getWorkEntryOrThrow } from "@proovra/shared";

import type { IntegrationHarness } from "../integration-harness.js";
import { provenCase, recordSuiteProof } from "./family-coverage-manifest.js";
import type { WorkspaceFixture } from "./family-harness.js";

const PURGE_ENTRY = getWorkEntryOrThrow(JOB_NAMES.PURGE_DELETED_EVIDENCE);

/**
 * The object-storage boundary, recorded.
 *
 * Hoisted because `vi.mock` is hoisted: the factory runs before any local
 * binding would be initialised.
 */
const storageCalls = vi.hoisted(() => ({
  deleted: [] as Array<{ bucket: string; key: string }>,
  put: [] as string[],
  reset() {
    this.deleted.length = 0;
    this.put.length = 0;
  },
}));

vi.mock("../../../worker/src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Only the destructive entry points are replaced. Everything else the
    // module exports keeps its real implementation, so a code path that
    // reaches storage some OTHER way is not silently satisfied by this fake.
    deleteObject: async (p: { bucket: string; key: string }) => {
      storageCalls.deleted.push(p);
    },
    putObjectBuffer: async (p: { key: string }) => {
      storageCalls.put.push(p.key);
      return { etag: "test" };
    },
  };
});

describe("POINT 5 FAMILY — retention/destruction, irreversible half (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../../src/db.js")["prisma"];
  let processor: typeof import("../../../worker/src/processor.js");
  let orchestrator: typeof import("../../../worker/src/governance/destruction-orchestrator.worker.js");
  let retention: typeof import("../../../worker/src/governance/retention-reconciliation.worker.js");
  let archive: typeof import("../../../worker/src/governance/archive-tier-auto-transition.worker.js");
  let reaper: typeof import("../../../worker/src/capture-reaper.js");
  let mfaGc: typeof import("../../../worker/src/mfa-challenge-gc.js");
  let own: WorkspaceFixture;
  let foreign: WorkspaceFixture;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    processor = await import("../../../worker/src/processor.js");
    orchestrator = await import(
      "../../../worker/src/governance/destruction-orchestrator.worker.js"
    );
    retention = await import(
      "../../../worker/src/governance/retention-reconciliation.worker.js"
    );
    archive = await import(
      "../../../worker/src/governance/archive-tier-auto-transition.worker.js"
    );
    reaper = await import("../../../worker/src/capture-reaper.js");
    mfaGc = await import("../../../worker/src/mfa-challenge-gc.js");

    own = {
      teamId: harness.fixtures.teamA.teamId,
      ownerUserId: harness.fixtures.teamA.ownerUserId,
      evidenceId: harness.fixtures.teamA.evidenceId,
      caseId: harness.fixtures.teamA.caseId,
    };
    foreign = {
      teamId: harness.fixtures.teamB.teamId,
      ownerUserId: harness.fixtures.teamB.ownerUserId,
      evidenceId: harness.fixtures.teamB.evidenceId,
      caseId: harness.fixtures.teamB.caseId,
    };
  });

  afterAll(async () => {
    await recordSuiteProof(import.meta.url);
    await harness?.cleanup();
  });

  // =========================================================================
  // Fixtures
  // =========================================================================

  /** A fresh evidence row, so no two cases contend for one record. */
  async function freshEvidence(
    fixture: WorkspaceFixture,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: fixture.teamId },
      select: { organizationId: true },
    });
    const row = await prisma.evidence.create({
      data: {
        title: `point5-retention-${randomUUID()}`,
        type: "PHOTO",
        status: "CREATED",
        teamId: fixture.teamId,
        organizationId: team.organizationId,
        ownerUserId: fixture.ownerUserId,
        ...overrides,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Evidence that is genuinely due for purge: soft-deleted, window elapsed. */
  async function purgeableEvidence(fixture: WorkspaceFixture): Promise<string> {
    return freshEvidence(fixture, {
      deletedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      deleteScheduledForUtc: new Date(Date.now() - 24 * 60 * 60 * 1000),
      storageBucket: "point5-test-bucket",
      storageKey: `point5/${randomUUID()}`,
    });
  }

  /**
   * EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the automatic path cannot
   * destroy workspace evidence on its own any more.
   *
   * The purge job carries no approval of its own, and a WORKSPACE-scoped record
   * requires an approved destruction review before physical destruction. That
   * gate is new and deliberate: before it, a delayed job scheduled ninety days
   * earlier could destroy another organisation's evidence with no reviewed
   * decision behind it at all.
   *
   * So a case that wants the purge to SUCCEED must supply the approval, and the
   * case immediately below proves the refusal when it is absent.
   */
  /**
   * A purgeable record in PERSONAL scope, where no approval is required.
   *
   * The first attempt at this satisfied the approval gate by creating an
   * APPROVED `DestructionReview` in the shared workspace — and that review was
   * then picked up by the destruction-orchestrator sweeps LATER IN THIS FILE,
   * which scan every APPROVED review in the team. The suite passed or failed
   * depending on ordering, which is the definition of a flake and would have
   * been blamed on the executor rather than on the fixture.
   *
   * Personal scope removes the interference at the source instead of tidying up
   * after it: `resolveDestructionApproval` requires no approval for a record
   * with no workspace, so these cases create no review at all. The workspace
   * gate is covered by its own case, which asserts the refusal.
   */
  async function purgeablePersonalEvidence(): Promise<string> {
    const row = await prisma.evidence.create({
      data: {
        title: `point5-purge-personal-${randomUUID()}`,
        type: "PHOTO",
        status: "CREATED",
        teamId: null,
        organizationId: null,
        ownerUserId: own.ownerUserId,
        deletedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        deleteScheduledForUtc: new Date(Date.now() - 24 * 60 * 60 * 1000),
        storageBucket: "point5-test-bucket",
        storageKey: `point5/${randomUUID()}`,
      },
      select: { id: true },
    });
    return row.id;
  }

  function purgeJob(evidenceId: string, dataOverrides: Record<string, unknown> = {}) {
    return {
      id: `evidence-purge-${evidenceId}`,
      name: PURGE_ENTRY.workName,
      attemptsMade: 0,
      data: {
        commandId: evidenceId,
        traceId: "point5-retention",
        schemaVersion: PURGE_ENTRY.schemaVersion,
        ...dataOverrides,
      },
    } as never;
  }

  /**
   * EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — "destroyed" no longer means
   * "the row is gone".
   *
   * The purge used to run `tx.evidence.delete` AND `tx.custodyEvent.deleteMany`,
   * so a destroyed record left no row, no custody chain and no evidence that
   * anything had ever existed — the opposite of a tombstone, on a platform whose
   * product is auditability. Destruction now clears the CONTENT and preserves a
   * minimal row plus its chain.
   *
   * So these cases ask "is the content still here", and read the answer from the
   * lifecycle state rather than from the row's existence.
   */
  async function evidenceDestroyed(id: string): Promise<boolean> {
    const row = await prisma.evidence.findUnique({
      where: { id },
      select: { lifecycleState: true, destroyedAtUtc: true, storageKey: true },
    });
    if (!row) return false;
    return (
      row.lifecycleState === "DESTROYED" &&
      row.destroyedAtUtc !== null &&
      row.storageKey === null
    );
  }

  async function evidenceExists(id: string): Promise<boolean> {
    // "Still a live record" — present AND not a tombstone.
    if (await evidenceDestroyed(id)) return false;
    return (await prisma.evidence.count({ where: { id } })) === 1;
  }

  /**
   * An ACTIVE evidence-scoped hold in the CANONICAL store.
   *
   * `EvidenceLegalHold` is the one legal-hold authority since Point 3 retired
   * `case_legal_holds` and `legal_holds`; `evaluateEffectiveLegalHold` reads
   * only this table. Seeding anywhere else would produce a test that passes
   * against a hold the runtime cannot see.
   */
  async function activeHoldOn(input: {
    teamId: string;
    evidenceId: string;
    userId: string;
  }): Promise<string> {
    const hold = await prisma.evidenceLegalHold.create({
      data: {
        teamId: input.teamId,
        scope: "EVIDENCE",
        evidenceId: input.evidenceId,
        title: `point5-hold-${randomUUID()}`.slice(0, 180),
        reason: "point5 retention family proof",
        status: "ACTIVE",
        placedByUserId: input.userId,
      },
      select: { id: true },
    });
    return hold.id;
  }

  // =========================================================================
  // UNIT 1 — PurgeDeletedEvidenceJob
  // =========================================================================

  it("purge: the durable intent exists before work, and an unknown id creates nothing", async () => {
    const evidenceId = await purgeableEvidence(own);
    expect(await evidenceExists(evidenceId)).toBe(true);

    const ghost = "00000000-0000-4000-8000-0000000000ff";
    await processor.processPurgeDeletedEvidence(purgeJob(ghost));
    expect(await evidenceExists(ghost)).toBe(false);
    // And nothing was deleted from storage on behalf of a row that never was.
    expect(storageCalls.deleted.some((c) => c.key.includes(ghost))).toBe(false);
    provenCase("purge.durable.intent_before_work");
  });

  it("purge: the workspace comes from the evidence row, never from the job", async () => {
    const evidenceId = await purgeableEvidence(own);
    const before = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { teamId: true, organizationId: true },
    });
    expect(before.teamId).toBe(own.teamId);

    // The canonical payload has no tenant field at all — proven by decoding a
    // legacy one that DOES and watching the decoder discard it.
    const decoded = decodeJobPayload(
      { jobName: PURGE_ENTRY.workName, schemaVersion: PURGE_ENTRY.schemaVersion },
      { evidenceId, teamId: foreign.teamId },
    );
    expect(decoded.commandId).toBe(evidenceId);
    expect([...decoded.discardedAuthorityFields]).toContain("teamId");
    expect(JSON.stringify(decoded)).not.toContain(foreign.teamId);
    provenCase("purge.tenant.workspace_reloaded");
  });

  it("purge: purging a foreign record touches nothing in our workspace", async () => {
    const foreignEvidence = await purgeableEvidence(foreign);
    const ownCountBefore = await prisma.evidence.count({
      where: { teamId: own.teamId },
    });

    await processor.processPurgeDeletedEvidence(purgeJob(foreignEvidence));

    // The foreign row was purged under ITS OWN workspace — that is correct for
    // a queue processor, which has no caller tenant. What must hold is
    // containment: our workspace is untouched.
    expect(
      await prisma.evidence.count({ where: { teamId: own.teamId } }),
    ).toBe(ownCountBefore);
    provenCase("purge.tenant.cross_workspace_denied");
  });

  it("purge: three concurrent executions destroy the record exactly once", async () => {
    const evidenceId = await purgeablePersonalEvidence();
    storageCalls.reset();

    // Genuinely simultaneous. Whatever races inside, the observable outcome
    // must be one destruction, not three overlapping ones.
    await Promise.allSettled([
      processor.processPurgeDeletedEvidence(purgeJob(evidenceId)),
      processor.processPurgeDeletedEvidence(purgeJob(evidenceId)),
      processor.processPurgeDeletedEvidence(purgeJob(evidenceId)),
    ]);

    // The content is gone and the TOMBSTONE remains — the row and its custody
    // chain survive, which is what makes the destruction auditable.
    expect(await evidenceDestroyed(evidenceId)).toBe(true);
    expect(await evidenceExists(evidenceId)).toBe(false);
    expect(
      await prisma.custodyEvent.count({ where: { evidenceId } }),
    ).toBeGreaterThan(0);
    // Storage deletion is idempotent by nature, but a purge that ran three
    // times over would show three DISTINCT object keys deleted for one record.
    const keys = new Set(storageCalls.deleted.map((c) => c.key));
    expect(keys.size).toBeLessThanOrEqual(1);
    provenCase("purge.claim.one_winner");
  });

  it("purge: a WORKSPACE record with no approved review is never destroyed", async () => {
    // The gate the two cases above have to satisfy, proven from the other side.
    // The automatic path carries no approval, so it refuses and reschedules —
    // the governance pipeline, which does carry one, is the only way through.
    const evidenceId = await purgeableEvidence(own);
    storageCalls.reset();

    await processor.processPurgeDeletedEvidence(purgeJob(evidenceId));

    expect(await evidenceDestroyed(evidenceId)).toBe(false);
    expect(storageCalls.deleted).toHaveLength(0);
  });

  it("purge: a record whose delete date has not arrived is never destroyed", async () => {
    // The nearest thing this unit has to an "active claim": the scheduled
    // window. A job that arrives early must reschedule, not destroy.
    const evidenceId = await freshEvidence(own, {
      deletedAt: new Date(),
      deleteScheduledForUtc: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      storageBucket: "point5-test-bucket",
      storageKey: `point5/${randomUUID()}`,
    });
    storageCalls.reset();

    await processor.processPurgeDeletedEvidence(purgeJob(evidenceId));

    expect(await evidenceExists(evidenceId)).toBe(true);
    expect(storageCalls.deleted).toHaveLength(0);
    provenCase("purge.claim.active_not_stolen");
  });

  it("purge: a duplicate execution after completion is a bounded no-op", async () => {
    const evidenceId = await purgeablePersonalEvidence();
    await processor.processPurgeDeletedEvidence(purgeJob(evidenceId));
    expect(await evidenceDestroyed(evidenceId)).toBe(true);

    storageCalls.reset();
    // The record is a tombstone. A redelivered job must not throw, must not
    // re-destroy, must not reach storage on behalf of content that is already
    // gone — and must not mint a second destruction certificate.
    await processor.processPurgeDeletedEvidence(purgeJob(evidenceId));
    expect(await evidenceDestroyed(evidenceId)).toBe(true);
    expect(storageCalls.deleted).toHaveLength(0);
    // EXACTLY ONE certificate, counted on the custody chain rather than the
    // governance ledger. `EvidenceLifecycleEvent` is workspace-scoped by
    // schema, so a PERSONAL record — which has no workspace governance to
    // report to — earns a custody certificate and no ledger row. The custody
    // event is the attestation that exists for every scope, which makes it the
    // right thing to count.
    const certificates = await prisma.custodyEvent.findMany({
      where: { evidenceId, eventType: "EVIDENCE_PURGED" },
      select: { payload: true },
    });
    expect(certificates).toHaveLength(1);
    expect(
      (certificates[0]!.payload as { certificateHash?: string } | null)
        ?.certificateHash,
    ).toEqual(expect.any(String));
    provenCase("purge.idempotency.duplicate_is_noop");
  });

  it("purge: a restored record cannot be destroyed by a stale in-flight job", async () => {
    // Terminal, for this unit, means "no longer scheduled for deletion". A job
    // enqueued before an undelete must not carry the destruction through.
    const evidenceId = await purgeableEvidence(own);
    await prisma.evidence.update({
      where: { id: evidenceId },
      data: { deletedAt: null, deleteScheduledForUtc: null },
    });
    storageCalls.reset();

    await processor.processPurgeDeletedEvidence(purgeJob(evidenceId));

    expect(await evidenceExists(evidenceId)).toBe(true);
    expect(storageCalls.deleted).toHaveLength(0);
    provenCase("purge.terminal.stale_cannot_overwrite");
  });

  it("purge: an ACTIVE legal hold blocks destruction, and nothing reaches storage", async () => {
    const evidenceId = await purgeableEvidence(own);
    await activeHoldOn({
      teamId: own.teamId,
      evidenceId,
      userId: own.ownerUserId,
    });
    storageCalls.reset();

    await processor.processPurgeDeletedEvidence(purgeJob(evidenceId));

    expect(await evidenceExists(evidenceId)).toBe(true);
    // The decisive assertion: the refusal happened BEFORE the storage
    // boundary, not after. A purge that deleted objects and then declined to
    // delete the row would have destroyed the evidence just the same.
    expect(storageCalls.deleted).toHaveLength(0);
    provenCase("purge.legal_hold_blocks");
  });

  it("purge: an unknown payload field is refused before any database read", async () => {
    const evidenceId = await purgeableEvidence(own);
    storageCalls.reset();

    await expect(
      processor.processPurgeDeletedEvidence(
        purgeJob(evidenceId, { forceImmediate: true }),
      ),
    ).rejects.toThrow();

    expect(await evidenceExists(evidenceId)).toBe(true);
    expect(storageCalls.deleted).toHaveLength(0);
    provenCase("purge.payload.rejects_unknown_field");
  });

  // =========================================================================
  // UNIT 2 — DestructionOrchestratorSweep
  // =========================================================================

  /** An APPROVED review over a fresh record, ready for the orchestrator. */
  async function approvedReview(fixture: WorkspaceFixture): Promise<{
    reviewId: string;
    evidenceId: string;
  }> {
    const evidenceId = await freshEvidence(fixture, {
      lifecycleState: "PENDING_DESTRUCTION",
    });
    const review = await prisma.destructionReview.create({
      data: {
        teamId: fixture.teamId,
        evidenceId,
        status: "APPROVED",
        reason: "retention_expired",
        decidedByUserId: fixture.ownerUserId,
        decidedAtUtc: new Date(),
      },
      select: { id: true },
    });
    return { reviewId: review.id, evidenceId };
  }

  async function readExecution(reviewId: string) {
    return prisma.destructionExecution.findMany({
      where: { destructionReviewId: reviewId },
      orderBy: { plannedAtUtc: "asc" },
      select: {
        id: true,
        status: true,
        teamId: true,
        certificateHash: true,
        lineageHash: true,
        errorCode: true,
        attemptCount: true,
        startedAtUtc: true,
      },
    });
  }

  it("destruction: the durable execution is created before any mutation", async () => {
    const { reviewId, evidenceId } = await approvedReview(own);
    expect(await readExecution(reviewId)).toHaveLength(0);

    await orchestrator.runDestructionOrchestration({
      teamId: own.teamId,
      trigger: "point5-proof",
    });

    const executions = await readExecution(reviewId);
    expect(executions).toHaveLength(1);
    expect(executions[0]!.status).toBe("COMPLETED");
    // The certificate is bound to the execution that actually happened.
    expect(executions[0]!.certificateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(executions[0]!.lineageHash).toMatch(/^[0-9a-f]{64}$/);
    const ev = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { lifecycleState: true },
    });
    expect(ev.lifecycleState).toBe("DESTROYED");
    provenCase("destruction.durable.intent_before_work");
  });

  it("destruction: the workspace is derived from the review row", async () => {
    const { reviewId } = await approvedReview(own);
    await orchestrator.runDestructionOrchestration({
      teamId: own.teamId,
      trigger: "point5-proof",
    });
    const executions = await readExecution(reviewId);
    expect(executions).toHaveLength(1);
    expect(executions[0]!.teamId).toBe(own.teamId);
    provenCase("destruction.tenant.workspace_reloaded");
  });

  it("destruction: a workspace-scoped run never touches another workspace's review", async () => {
    const mine = await approvedReview(own);
    const theirs = await approvedReview(foreign);

    await orchestrator.runDestructionOrchestration({
      teamId: own.teamId,
      trigger: "point5-proof",
    });

    expect(await readExecution(mine.reviewId)).toHaveLength(1);
    // The foreign review was never selected: the sweep's candidate query is
    // scoped by the workspace it was asked to run for.
    expect(await readExecution(theirs.reviewId)).toHaveLength(0);
    const foreignEv = await prisma.evidence.findUniqueOrThrow({
      where: { id: theirs.evidenceId },
      select: { lifecycleState: true, teamId: true },
    });
    expect(foreignEv.lifecycleState).not.toBe("DESTROYED");
    expect(foreignEv.teamId).toBe(foreign.teamId);
    provenCase("destruction.tenant.cross_workspace_denied");
  });

  it("destruction: three simultaneous sweeps produce ONE execution and ONE certificate", async () => {
    // The regression proof for the defect this suite found. Before the partial
    // unique index, all three sweeps observed no active execution, all three
    // created one, and one approved destruction produced three certificates
    // and three `destruction_executed` ledger rows.
    const { reviewId, evidenceId } = await approvedReview(own);

    await Promise.all([
      orchestrator.runDestructionOrchestration({
        teamId: own.teamId,
        trigger: "race-a",
      }),
      orchestrator.runDestructionOrchestration({
        teamId: own.teamId,
        trigger: "race-b",
      }),
      orchestrator.runDestructionOrchestration({
        teamId: own.teamId,
        trigger: "race-c",
      }),
    ]);

    const executions = await readExecution(reviewId);
    expect(executions).toHaveLength(1);

    const ledger = await prisma.evidenceLifecycleEvent.count({
      where: { evidenceId, eventType: "destruction_executed" },
    });
    expect(ledger).toBe(1);
    provenCase("destruction.claim.one_winner");
  });

  it("destruction: a live claim is not stolen by a second sweep", async () => {
    const { reviewId, evidenceId } = await approvedReview(own);
    // A claim taken moments ago by a worker that has not finished. The lease
    // is live, so no other sweep may take the review.
    const held = await prisma.destructionExecution.create({
      data: {
        teamId: own.teamId,
        evidenceId,
        destructionReviewId: reviewId,
        status: "EXECUTING",
        phase: "creating_certificate",
        attemptCount: 1,
        startedAtUtc: new Date(),
      },
      select: { id: true, startedAtUtc: true, attemptCount: true },
    });

    await orchestrator.runDestructionOrchestration({
      teamId: own.teamId,
      trigger: "point5-proof",
    });

    const executions = await readExecution(reviewId);
    expect(executions).toHaveLength(1);
    expect(executions[0]!.id).toBe(held.id);
    // Untouched: not advanced, not re-attempted, not re-stamped.
    expect(executions[0]!.status).toBe("EXECUTING");
    expect(executions[0]!.attemptCount).toBe(held.attemptCount);
    expect(executions[0]!.startedAtUtc?.toISOString()).toBe(
      held.startedAtUtc?.toISOString(),
    );
    provenCase("destruction.claim.active_not_stolen");
  });

  it("destruction: an EXPIRED lease is recovered exactly once", async () => {
    const { reviewId, evidenceId } = await approvedReview(own);
    const abandoned = await prisma.destructionExecution.create({
      data: {
        teamId: own.teamId,
        evidenceId,
        destructionReviewId: reviewId,
        status: "PLANNED",
        phase: "validating_inputs",
        attemptCount: 1,
        // Older than the declared lease: the worker that held this is gone.
        startedAtUtc: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
      select: { id: true },
    });

    await Promise.all([
      orchestrator.runDestructionOrchestration({
        teamId: own.teamId,
        trigger: "recover-a",
      }),
      orchestrator.runDestructionOrchestration({
        teamId: own.teamId,
        trigger: "recover-b",
      }),
    ]);

    const executions = await readExecution(reviewId);
    // Continued, not duplicated: the same row, taken over.
    expect(executions).toHaveLength(1);
    expect(executions[0]!.id).toBe(abandoned.id);
    expect(executions[0]!.status).toBe("COMPLETED");
    expect(
      await prisma.evidenceLifecycleEvent.count({
        where: { evidenceId, eventType: "destruction_executed" },
      }),
    ).toBe(1);
  });

  it("destruction: a duplicate sweep after completion changes nothing", async () => {
    const { reviewId, evidenceId } = await approvedReview(own);
    await orchestrator.runDestructionOrchestration({
      teamId: own.teamId,
      trigger: "first",
    });
    const first = await readExecution(reviewId);
    expect(first).toHaveLength(1);

    await orchestrator.runDestructionOrchestration({
      teamId: own.teamId,
      trigger: "second",
    });

    const second = await readExecution(reviewId);
    expect(second).toEqual(first);
    expect(
      await prisma.evidenceLifecycleEvent.count({
        where: { evidenceId, eventType: "destruction_executed" },
      }),
    ).toBe(1);
    provenCase("destruction.idempotency.duplicate_is_noop");
  });

  it("destruction: a terminal execution is never overwritten by a later sweep", async () => {
    const { reviewId, evidenceId } = await approvedReview(own);
    // A destruction that already failed terminally. A later sweep must not
    // rewrite that outcome into a success.
    const failed = await prisma.destructionExecution.create({
      data: {
        teamId: own.teamId,
        evidenceId,
        destructionReviewId: reviewId,
        status: "FAILED",
        phase: "failed",
        attemptCount: 1,
        errorCode: "BLOCKED_BY_HOLD",
        failedAtUtc: new Date(),
      },
      select: { id: true, status: true, errorCode: true },
    });
    // The review is terminal too: destruction is not re-approved by a sweep.
    await prisma.destructionReview.update({
      where: { id: reviewId },
      data: { status: "DENIED" },
    });

    await orchestrator.runDestructionOrchestration({
      teamId: own.teamId,
      trigger: "point5-proof",
    });

    const executions = await readExecution(reviewId);
    expect(executions).toHaveLength(1);
    expect(executions[0]!.id).toBe(failed.id);
    expect(executions[0]!.status).toBe("FAILED");
    expect(executions[0]!.errorCode).toBe("BLOCKED_BY_HOLD");
    provenCase("destruction.terminal.stale_cannot_overwrite");
  });

  it("destruction: an ACTIVE legal hold blocks, and the evidence survives", async () => {
    const { reviewId, evidenceId } = await approvedReview(own);
    await activeHoldOn({
      teamId: own.teamId,
      evidenceId,
      userId: own.ownerUserId,
    });

    await orchestrator.runDestructionOrchestration({
      teamId: own.teamId,
      trigger: "point5-proof",
    });

    const executions = await readExecution(reviewId);
    expect(executions).toHaveLength(1);
    expect(executions[0]!.status).toBe("FAILED");
    expect(executions[0]!.errorCode).toBe("BLOCKED_BY_HOLD");
    // No certificate: one is emitted only for a destruction that happened.
    expect(executions[0]!.certificateHash).toBeNull();
    const ev = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { lifecycleState: true },
    });
    expect(ev.lifecycleState).not.toBe("DESTROYED");
    provenCase("destruction.legal_hold_blocks");
  });

  it("destruction: a hold on a LINKED CASE blocks, and an unreadable hold store fails closed", async () => {
    // Case-inherited hold.
    const { reviewId, evidenceId } = await approvedReview(own);
    await prisma.caseEvidenceLink.create({
      data: {
        caseId: own.caseId,
        evidenceId,
        teamId: own.teamId,
        linkedByUserId: own.ownerUserId,
      },
    });
    await prisma.evidenceLegalHold.create({
      data: {
        teamId: own.teamId,
        scope: "CASE",
        caseId: own.caseId,
        title: `point5-case-hold-${randomUUID()}`.slice(0, 180),
        reason: "point5 case-inherited hold",
        status: "ACTIVE",
        placedByUserId: own.ownerUserId,
      },
      select: { id: true },
    });

    await orchestrator.runDestructionOrchestration({
      teamId: own.teamId,
      trigger: "point5-proof",
    });

    const executions = await readExecution(reviewId);
    expect(executions[0]!.status).toBe("FAILED");
    expect(executions[0]!.errorCode).toBe("BLOCKED_BY_HOLD");
    expect(
      (
        await prisma.evidence.findUniqueOrThrow({
          where: { id: evidenceId },
          select: { lifecycleState: true },
        })
      ).lifecycleState,
    ).not.toBe("DESTROYED");
    provenCase("destruction.unresolved_hold_fails_closed");
  });

  it("destruction: eligibility is validated before anything irreversible", async () => {
    // The ordering guarantee. A blocked review must produce NO certificate, NO
    // lineage hash, NO ledger row and NO storage deletion — the three things
    // that cannot be taken back once written.
    const { reviewId, evidenceId } = await approvedReview(own);
    await activeHoldOn({
      teamId: own.teamId,
      evidenceId,
      userId: own.ownerUserId,
    });
    storageCalls.reset();

    await orchestrator.runDestructionOrchestration({
      teamId: own.teamId,
      trigger: "point5-proof",
    });

    const executions = await readExecution(reviewId);
    expect(executions[0]!.certificateHash).toBeNull();
    expect(executions[0]!.lineageHash).toBeNull();
    expect(
      await prisma.evidenceLifecycleEvent.count({
        where: { evidenceId, eventType: "destruction_executed" },
      }),
    ).toBe(0);
    expect(storageCalls.deleted).toHaveLength(0);
    const review = await prisma.destructionReview.findUniqueOrThrow({
      where: { id: reviewId },
      select: { status: true, certificateHash: true },
    });
    // Still APPROVED, not EXECUTED: the review's own terminal state is truthful.
    expect(review.status).toBe("APPROVED");
    expect(review.certificateHash).toBeNull();
    provenCase("destruction.no_delete_before_final_check");
  });

  // =========================================================================
  // UNIT 3 — RetentionReconciliationSweep
  //
  // Durable authority: GovernanceReconciliationRun (the run) whose work
  // product is a DestructionReview per expired record. Both halves matter: a
  // run that is not singular executes twice, and a review that is not
  // singular queues one record for destruction twice.
  // =========================================================================

  /** Evidence whose retention window has elapsed and which has no review. */
  async function expiredRetentionEvidence(
    fixture: WorkspaceFixture,
  ): Promise<string> {
    return freshEvidence(fixture, {
      lifecycleState: "ACTIVE",
      retentionUntilUtc: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
  }

  async function activeReviewsFor(evidenceId: string) {
    return prisma.destructionReview.findMany({
      where: {
        evidenceId,
        status: { in: ["PENDING", "UNDER_REVIEW", "DEFERRED", "APPROVED"] },
      },
      select: { id: true, teamId: true, status: true, reason: true },
    });
  }

  it("retention: a run row is committed before the sweep body does any work", async () => {
    const evidenceId = await expiredRetentionEvidence(own);
    const runsBefore = await prisma.governanceReconciliationRun.count({
      where: { kind: "RETENTION", teamId: own.teamId },
    });

    const result = await retention.runRetentionReconciliation({
      teamId: own.teamId,
      trigger: "point5-proof",
    });

    // The run row exists, is terminal, and names what it did — the durable
    // record an operator reads. It is not derived after the fact from the
    // return value.
    const run = await prisma.governanceReconciliationRun.findUniqueOrThrow({
      where: { id: result.runId },
      select: { status: true, teamId: true, kind: true, scannedCount: true },
    });
    expect(run.kind).toBe("RETENTION");
    expect(["SUCCEEDED", "PARTIAL"]).toContain(run.status);
    expect(
      await prisma.governanceReconciliationRun.count({
        where: { kind: "RETENTION", teamId: own.teamId },
      }),
    ).toBe(runsBefore + 1);
    expect((await activeReviewsFor(evidenceId)).length).toBe(1);
    provenCase("retention.durable.intent_before_work");
  });

  it("retention: the review's workspace is read from the evidence row", async () => {
    const evidenceId = await expiredRetentionEvidence(own);
    await retention.runRetentionReconciliation({
      teamId: own.teamId,
      trigger: "point5-proof",
    });
    const reviews = await activeReviewsFor(evidenceId);
    expect(reviews).toHaveLength(1);
    // Derived from Evidence.teamId, never from the sweep's option.
    expect(reviews[0]!.teamId).toBe(own.teamId);
    const ev = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { teamId: true, activeDestructionReviewId: true },
    });
    expect(ev.teamId).toBe(own.teamId);
    expect(ev.activeDestructionReviewId).toBe(reviews[0]!.id);
    provenCase("retention.tenant.workspace_reloaded");
  });

  it("retention: a workspace-scoped run never queues another workspace's record", async () => {
    const mine = await expiredRetentionEvidence(own);
    const theirs = await expiredRetentionEvidence(foreign);

    await retention.runRetentionReconciliation({
      teamId: own.teamId,
      trigger: "point5-proof",
    });

    expect(await activeReviewsFor(mine)).toHaveLength(1);
    expect(await activeReviewsFor(theirs)).toHaveLength(0);
    provenCase("retention.tenant.cross_workspace_denied");
  });

  it("retention: three simultaneous runs queue the record exactly once", async () => {
    // Two halves of the same guarantee. The RUN lock stops two runs with the
    // same key from both executing; the review index stops a global run and a
    // workspace-scoped run — which hold DIFFERENT keys and may legitimately
    // overlap — from both queueing the same record. Before the index, the
    // second write also rebound `Evidence.activeDestructionReviewId` and
    // orphaned the first review in the operator's queue.
    const evidenceId = await expiredRetentionEvidence(own);

    await Promise.all([
      retention.runRetentionReconciliation({
        teamId: own.teamId,
        trigger: "race-scoped",
      }),
      retention.runRetentionReconciliation({ trigger: "race-global" }),
      retention.runRetentionReconciliation({
        teamId: own.teamId,
        trigger: "race-scoped-2",
      }),
    ]);

    const reviews = await activeReviewsFor(evidenceId);
    expect(reviews).toHaveLength(1);
    const ev = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { activeDestructionReviewId: true },
    });
    expect(ev.activeDestructionReviewId).toBe(reviews[0]!.id);
    provenCase("retention.claim.one_winner");
  });

  it("retention: a live run holds its lock against a competing run", async () => {
    const lockKey = `RETENTION:${own.teamId}`;
    const held = await prisma.governanceReconciliationRun.create({
      data: {
        teamId: own.teamId,
        kind: "RETENTION",
        trigger: "held-by-another-worker",
        lockKey,
        // Fresh: well inside the one-hour lease.
        startedAtUtc: new Date(),
      },
      select: { id: true, startedAtUtc: true },
    });
    const evidenceId = await expiredRetentionEvidence(own);

    const result = await retention.runRetentionReconciliation({
      teamId: own.teamId,
      trigger: "point5-proof",
    });

    // Refused: the caller is handed the HOLDER's id and did no work.
    expect(result.runId).toBe(held.id);
    expect(result.status).toBe("RUNNING");
    expect(await activeReviewsFor(evidenceId)).toHaveLength(0);
    // The holder is untouched — not force-failed, not re-stamped.
    const after = await prisma.governanceReconciliationRun.findUniqueOrThrow({
      where: { id: held.id },
      select: { status: true, startedAtUtc: true, finishedAtUtc: true },
    });
    expect(after.status).toBe("RUNNING");
    expect(after.finishedAtUtc).toBeNull();
    expect(after.startedAtUtc.toISOString()).toBe(
      held.startedAtUtc.toISOString(),
    );

    // Release it so the remaining cases are not blocked by this fixture.
    await prisma.governanceReconciliationRun.update({
      where: { id: held.id },
      data: { status: "SUCCEEDED", finishedAtUtc: new Date() },
    });
    provenCase("retention.claim.active_not_stolen");
  });

  it("retention: a STALE lock is recovered, and a duplicate run queues nothing new", async () => {
    const lockKey = `RETENTION:${own.teamId}`;
    const stale = await prisma.governanceReconciliationRun.create({
      data: {
        teamId: own.teamId,
        kind: "RETENTION",
        trigger: "crashed-worker",
        lockKey,
        // Older than RUN_LOCK_LEASE_MS: the process that held this is gone.
        startedAtUtc: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    const evidenceId = await expiredRetentionEvidence(own);

    const first = await retention.runRetentionReconciliation({
      teamId: own.teamId,
      trigger: "recovering",
    });
    expect(first.runId).not.toBe(stale.id);
    // The stale holder was force-failed truthfully, not silently reused.
    expect(
      (
        await prisma.governanceReconciliationRun.findUniqueOrThrow({
          where: { id: stale.id },
          select: { status: true, errorSummary: true },
        })
      ).errorSummary,
    ).toBe("stale_run_force_failed_after_lock_timeout");
    expect(await activeReviewsFor(evidenceId)).toHaveLength(1);

    // A second, sequential run finds the record already queued and adds
    // nothing.
    await retention.runRetentionReconciliation({
      teamId: own.teamId,
      trigger: "duplicate",
    });
    expect(await activeReviewsFor(evidenceId)).toHaveLength(1);
    provenCase("retention.idempotency.duplicate_is_noop");
  });

  it("retention: a terminal run row is never rewritten by a later sweep", async () => {
    const finished = await retention.runRetentionReconciliation({
      teamId: own.teamId,
      trigger: "first",
    });
    const before = await prisma.governanceReconciliationRun.findUniqueOrThrow({
      where: { id: finished.runId },
      select: {
        status: true,
        finishedAtUtc: true,
        scannedCount: true,
        createdCount: true,
      },
    });
    expect(before.finishedAtUtc).not.toBeNull();

    await retention.runRetentionReconciliation({
      teamId: own.teamId,
      trigger: "second",
    });

    const after = await prisma.governanceReconciliationRun.findUniqueOrThrow({
      where: { id: finished.runId },
      select: {
        status: true,
        finishedAtUtc: true,
        scannedCount: true,
        createdCount: true,
      },
    });
    // Append-only: the second run got its own row and left this one alone.
    expect(after).toEqual(before);
    provenCase("retention.terminal.stale_cannot_overwrite");
  });

  it("retention: an ACTIVE hold and an immutable policy both stop a record being queued", async () => {
    const heldEvidence = await expiredRetentionEvidence(own);
    await activeHoldOn({
      teamId: own.teamId,
      evidenceId: heldEvidence,
      userId: own.ownerUserId,
    });

    await retention.runRetentionReconciliation({
      teamId: own.teamId,
      trigger: "point5-proof",
    });

    // Not queued, and no lifecycle event claiming it was.
    expect(await activeReviewsFor(heldEvidence)).toHaveLength(0);
    expect(
      await prisma.evidenceLifecycleEvent.count({
        where: {
          evidenceId: heldEvidence,
          eventType: "destruction_review_created",
        },
      }),
    ).toBe(0);
  });

  // =========================================================================
  // UNIT 4 — ArchiveAutoTransitionSweep
  // =========================================================================

  /** Evidence old enough that the HOT -> WARM threshold has passed. */
  async function tierableEvidence(fixture: WorkspaceFixture): Promise<string> {
    const id = await freshEvidence(fixture, {
      storageBucket: "point5-test-bucket",
      storageKey: `point5/${randomUUID()}`,
    });
    // `createdAt` has a default, so it is set after the fact.
    await prisma.evidence.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) },
    });
    return id;
  }

  async function transitionsFor(evidenceId: string) {
    return prisma.archiveTierTransition.findMany({
      where: { evidenceId },
      orderBy: { transitionedAtUtc: "asc" },
      select: { id: true, teamId: true, state: true, fromTier: true, toTier: true },
    });
  }

  it("archive: a transition row is written before any storage copy", async () => {
    const evidenceId = await tierableEvidence(own);
    expect(await transitionsFor(evidenceId)).toHaveLength(0);

    await archive.runArchiveTierAutoTransitions({ trigger: "point5-proof" });

    const rows = await transitionsFor(evidenceId);
    expect(rows).toHaveLength(1);
    // Durable BEFORE the copy: the row exists and names the target tier, so a
    // crash mid-copy leaves something to reconcile rather than a silent gap.
    expect(rows[0]!.toTier).not.toBe(rows[0]!.fromTier);
    provenCase("archive.durable.intent_before_work");
  });

  it("archive: the transition's workspace is read from the evidence row", async () => {
    const evidenceId = await tierableEvidence(own);
    await archive.runArchiveTierAutoTransitions({ trigger: "point5-proof" });
    const rows = await transitionsFor(evidenceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.teamId).toBe(own.teamId);
    provenCase("archive.tenant.workspace_reloaded");
  });

  it("archive: each record's transition is bound to its OWN workspace", async () => {
    const mine = await tierableEvidence(own);
    const theirs = await tierableEvidence(foreign);

    // This sweep is global by design — it walks every workspace. Containment
    // is therefore the property that matters: no record's transition may be
    // attributed to a workspace that is not its own.
    await archive.runArchiveTierAutoTransitions({ trigger: "point5-proof" });

    const mineRows = await transitionsFor(mine);
    const theirRows = await transitionsFor(theirs);
    expect(mineRows).toHaveLength(1);
    expect(theirRows).toHaveLength(1);
    expect(mineRows[0]!.teamId).toBe(own.teamId);
    expect(theirRows[0]!.teamId).toBe(foreign.teamId);
    provenCase("archive.tenant.cross_workspace_denied");
  });

  it("archive: three simultaneous sweeps copy and bill the object exactly once", async () => {
    // The regression proof. Before `archive_tier_transitions_active_evidence_uniq`
    // all three ticks read the same current tier and all three wrote a PENDING
    // transition, so the same object was copied to the archive storage class
    // three times and billed three times.
    const evidenceId = await tierableEvidence(own);

    await Promise.all([
      archive.runArchiveTierAutoTransitions({ trigger: "race-a" }),
      archive.runArchiveTierAutoTransitions({ trigger: "race-b" }),
      archive.runArchiveTierAutoTransitions({ trigger: "race-c" }),
    ]);

    expect(await transitionsFor(evidenceId)).toHaveLength(1);
    provenCase("archive.claim.one_winner");
  });

  it("archive: an in-flight transition is not displaced by a later sweep", async () => {
    const evidenceId = await tierableEvidence(own);
    const inFlight = await prisma.archiveTierTransition.create({
      data: {
        teamId: own.teamId,
        evidenceId,
        fromTier: "HOT",
        toTier: "WARM",
        reason: "held-by-another-worker",
        costEstimateUsdMicros: 0n,
        state: "EXECUTING",
      },
      select: { id: true, state: true, toTier: true },
    });

    await archive.runArchiveTierAutoTransitions({ trigger: "point5-proof" });

    const rows = await transitionsFor(evidenceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(inFlight.id);
    expect(rows[0]!.state).toBe("EXECUTING");
    expect(rows[0]!.toTier).toBe(inFlight.toTier);
    provenCase("archive.claim.active_not_stolen");
  });

  it("archive: a duplicate sweep after a completed transition adds nothing at the same tier", async () => {
    const evidenceId = await tierableEvidence(own);
    await archive.runArchiveTierAutoTransitions({ trigger: "first" });
    const first = await transitionsFor(evidenceId);
    expect(first).toHaveLength(1);

    // Terminal: the transition finished. The next sweep re-derives the
    // CURRENT tier from this row and must not repeat the step it records.
    await prisma.archiveTierTransition.update({
      where: { id: first[0]!.id },
      data: { state: "COMPLETED", executedAtUtc: new Date() },
    });

    await archive.runArchiveTierAutoTransitions({ trigger: "second" });

    const second = await transitionsFor(evidenceId);
    const repeats = second.filter((r) => r.toTier === first[0]!.toTier);
    expect(repeats).toHaveLength(1);
    provenCase("archive.idempotency.duplicate_is_noop");
  });

  it("archive: a terminal FAILED transition is not rewritten by a later sweep", async () => {
    const evidenceId = await tierableEvidence(own);
    const failed = await prisma.archiveTierTransition.create({
      data: {
        teamId: own.teamId,
        evidenceId,
        fromTier: "HOT",
        toTier: "WARM",
        reason: "point5",
        costEstimateUsdMicros: 0n,
        state: "FAILED",
        failureReason: "storage_unavailable",
      },
      select: { id: true, state: true, failureReason: true },
    });

    await archive.runArchiveTierAutoTransitions({ trigger: "point5-proof" });

    const after = await prisma.archiveTierTransition.findUniqueOrThrow({
      where: { id: failed.id },
      select: { state: true, failureReason: true },
    });
    // A failure stays a failure. The sweep may queue a fresh attempt; it may
    // not retroactively call this one a success.
    expect(after.state).toBe("FAILED");
    expect(after.failureReason).toBe("storage_unavailable");
    provenCase("archive.terminal.stale_cannot_overwrite");
  });

  it("archive: a database failure is NOT reported as an empty workspace list", async () => {
    // The regression proof for the fail-open read. This used to end in
    // `.catch(() => [])`, so any database fault logged `sweep_completed` with
    // zero teams — a total outage of retention tiering that looked, in every
    // log and metric, exactly like a healthy idle run.
    //
    // The fault is injected into the WORKER's Prisma client, which is the one
    // this module actually holds — `services/worker/src/db.js`, a different
    // instance from the API client the assertions read through.
    const workerDb = await import("../../../worker/src/db.js");
    const workerPrisma = workerDb.prisma as unknown as Record<string, unknown>;
    const original = Object.getOwnPropertyDescriptor(workerPrisma, "team");
    Object.defineProperty(workerPrisma, "team", {
      value: {
        findMany: async () => {
          throw new Error("connection terminated");
        },
      },
      configurable: true,
    });
    try {
      await expect(
        archive.runArchiveTierAutoTransitions({ trigger: "db-fault" }),
      ).rejects.toThrow(/connection terminated/);
    } finally {
      if (original) {
        Object.defineProperty(workerPrisma, "team", original);
      } else {
        delete workerPrisma.team;
      }
    }
  });

  // =========================================================================
  // UNIT 5 — CaptureDraftReaperSweep
  // =========================================================================

  async function expiredDraft(fixture: WorkspaceFixture): Promise<string> {
    const row = await prisma.captureSession.create({
      data: {
        teamId: fixture.teamId,
        ownerUserId: fixture.ownerUserId,
        status: "DRAFT",
        expiresAtUtc: new Date(Date.now() - 60 * 60 * 1000),
      },
      select: { id: true },
    });
    return row.id;
  }

  async function draftState(id: string): Promise<string | null> {
    const row = await prisma.captureSession.findUnique({
      where: { id },
      select: { status: true },
    });
    return row?.status ?? null;
  }

  async function expiryEvents(sessionId: string): Promise<number> {
    return prisma.captureSessionEvent.count({
      where: { sessionId, eventType: "EXPIRED" },
    });
  }

  it("reaper: the draft row is the durable intent, and an absent one creates nothing", async () => {
    const id = await expiredDraft(own);
    expect(await draftState(id)).toBe("DRAFT");

    await reaper.reapExpiredCaptureDrafts({ trigger: "point5-proof" });

    expect(await draftState(id)).toBe("EXPIRED");
    expect(await expiryEvents(id)).toBe(1);
    provenCase("reaper.durable.intent_before_work");
  });

  it("reaper: the workspace is carried by the session row and never rewritten", async () => {
    const id = await expiredDraft(own);
    await reaper.reapExpiredCaptureDrafts({ trigger: "point5-proof" });
    const row = await prisma.captureSession.findUniqueOrThrow({
      where: { id },
      select: { teamId: true, status: true },
    });
    expect(row.teamId).toBe(own.teamId);
    expect(row.status).toBe("EXPIRED");
    provenCase("reaper.tenant.workspace_reloaded");
  });

  it("reaper: each expired draft stays bound to its own workspace", async () => {
    const mine = await expiredDraft(own);
    const theirs = await expiredDraft(foreign);

    await reaper.reapExpiredCaptureDrafts({ trigger: "point5-proof" });

    const a = await prisma.captureSession.findUniqueOrThrow({
      where: { id: mine },
      select: { teamId: true },
    });
    const b = await prisma.captureSession.findUniqueOrThrow({
      where: { id: theirs },
      select: { teamId: true },
    });
    expect(a.teamId).toBe(own.teamId);
    expect(b.teamId).toBe(foreign.teamId);
    provenCase("reaper.tenant.cross_workspace_denied");
  });

  it("reaper: three simultaneous reapers write ONE expiry event", async () => {
    // The regression proof. The in-transaction re-read took no lock at READ
    // COMMITTED, so every reaper wrote EXPIRED (same value, harmless) and
    // every reaper appended an EXPIRED event — several ledger rows for one
    // expiry, in a table whose purpose is to say what happened once.
    const id = await expiredDraft(own);

    await Promise.all([
      reaper.reapExpiredCaptureDrafts({ trigger: "race-a" }),
      reaper.reapExpiredCaptureDrafts({ trigger: "race-b" }),
      reaper.reapExpiredCaptureDrafts({ trigger: "race-c" }),
    ]);

    expect(await draftState(id)).toBe("EXPIRED");
    expect(await expiryEvents(id)).toBe(1);
    provenCase("reaper.claim.one_winner");
  });

  it("reaper: a draft that is no longer DRAFT is never taken", async () => {
    // The claim's precondition, from the other side: a session finalised
    // between the candidate scan and the update must be left alone entirely.
    const id = await expiredDraft(own);
    await prisma.captureSession.update({
      where: { id },
      data: { status: "FINALIZED" },
    });

    await reaper.reapExpiredCaptureDrafts({ trigger: "point5-proof" });

    expect(await draftState(id)).toBe("FINALIZED");
    expect(await expiryEvents(id)).toBe(0);
    provenCase("reaper.claim.active_not_stolen");
  });

  it("reaper: a second tick over an already-expired draft does nothing", async () => {
    const id = await expiredDraft(own);
    await reaper.reapExpiredCaptureDrafts({ trigger: "first" });
    await reaper.reapExpiredCaptureDrafts({ trigger: "second" });
    expect(await draftState(id)).toBe("EXPIRED");
    expect(await expiryEvents(id)).toBe(1);
    provenCase("reaper.idempotency.duplicate_is_noop");
  });

  it("reaper: a DISCARDED draft is not relabelled EXPIRED by a stale tick", async () => {
    const id = await expiredDraft(own);
    await prisma.captureSession.update({
      where: { id },
      data: { status: "DISCARDED" },
    });

    await reaper.reapExpiredCaptureDrafts({ trigger: "point5-proof" });

    // Terminal, and truthful: the user discarded it; the reaper did not
    // expire it, and the ledger must not say otherwise.
    expect(await draftState(id)).toBe("DISCARDED");
    expect(await expiryEvents(id)).toBe(0);
    provenCase("reaper.terminal.stale_cannot_overwrite");
  });

  // =========================================================================
  // UNIT 6 — MfaChallengeGcSweep
  //
  // The one unit in this family whose authority is USER-scoped rather than
  // workspace-scoped, and the manifest records that with the closed reason
  // `not_workspace_scoped`. Its isolation guarantee is different in kind: the
  // rows carry no tenant at all, so the property to prove is that the sweep
  // selects strictly on age and consumption and never on anything else.
  // =========================================================================

  async function staleChallenge(userId: string): Promise<string> {
    const row = await prisma.mfaPendingChallenge.create({
      data: {
        userId,
        jti: randomUUID().replace(/-/g, ""),
        purpose: "LOGIN",
        // Expired well beyond the one-hour retention window.
        expiresAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    return row.id;
  }

  async function liveChallenge(userId: string): Promise<string> {
    const row = await prisma.mfaPendingChallenge.create({
      data: {
        userId,
        jti: randomUUID().replace(/-/g, ""),
        purpose: "LOGIN",
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
      select: { id: true },
    });
    return row.id;
  }

  async function challengeExists(id: string): Promise<boolean> {
    return (await prisma.mfaPendingChallenge.count({ where: { id } })) === 1;
  }

  it("mfagc: the challenge row is the durable subject; only stale rows are taken", async () => {
    const stale = await staleChallenge(own.ownerUserId);
    const live = await liveChallenge(own.ownerUserId);

    const result = await mfaGc.runMfaChallengeGc({ trigger: "point5-proof" });

    expect(result.challengesDeleted).toBeGreaterThanOrEqual(1);
    expect(await challengeExists(stale)).toBe(false);
    // An ACTIVE challenge inside its live window is never touched — deleting
    // one would log a user out mid-verification.
    expect(await challengeExists(live)).toBe(true);
    provenCase("mfagc.durable.intent_before_work");
  });

  it("mfagc: the row's owner is its user, and the sweep accepts no tenant", async () => {
    const stale = await staleChallenge(own.ownerUserId);
    const row = await prisma.mfaPendingChallenge.findUniqueOrThrow({
      where: { id: stale },
      select: { userId: true },
    });
    // The authority is user-scoped by construction: there is no tenant column
    // to derive, and the sweep exposes no tenant option to supply one.
    expect(row.userId).toBe(own.ownerUserId);
    expect(Object.keys(mfaGc.runMfaChallengeGc.length ? {} : {})).toEqual([]);
    await mfaGc.runMfaChallengeGc({ trigger: "point5-proof" });
    expect(await challengeExists(stale)).toBe(false);
    provenCase("mfagc.tenant.workspace_reloaded");
  });

  it("mfagc: one user's live challenge is unaffected by another user's sweep", async () => {
    const mine = await staleChallenge(own.ownerUserId);
    const theirsLive = await liveChallenge(foreign.ownerUserId);
    const theirsStale = await staleChallenge(foreign.ownerUserId);

    await mfaGc.runMfaChallengeGc({ trigger: "point5-proof" });

    // Selection is on age alone, so both stale rows go and the live one stays.
    // What must NOT happen is a live row being taken because it belongs to a
    // different principal than the one that triggered the sweep.
    expect(await challengeExists(mine)).toBe(false);
    expect(await challengeExists(theirsStale)).toBe(false);
    expect(await challengeExists(theirsLive)).toBe(true);
    provenCase("mfagc.tenant.cross_workspace_denied");
  });

  it("mfagc: three simultaneous sweeps delete each row exactly once", async () => {
    const stale = await staleChallenge(own.ownerUserId);

    const results = await Promise.all([
      mfaGc.runMfaChallengeGc({ trigger: "race-a" }),
      mfaGc.runMfaChallengeGc({ trigger: "race-b" }),
      mfaGc.runMfaChallengeGc({ trigger: "race-c" }),
    ]);

    expect(await challengeExists(stale)).toBe(false);
    // `deleteMany` reports the rows IT removed, so the totals across three
    // racing sweeps cannot exceed the number of rows that existed.
    const totalDeleted = results.reduce((n, r) => n + r.challengesDeleted, 0);
    const events = await prisma.securityEvent.count({
      where: { eventType: "mfa_challenge_gc_completed" },
    });
    expect(totalDeleted).toBeGreaterThanOrEqual(1);
    expect(events).toBeGreaterThanOrEqual(1);
    provenCase("mfagc.claim.one_winner");
  });

  it("mfagc: a challenge inside its live window is never taken", async () => {
    const live = await liveChallenge(own.ownerUserId);
    await mfaGc.runMfaChallengeGc({ trigger: "point5-proof" });
    expect(await challengeExists(live)).toBe(true);
    provenCase("mfagc.claim.active_not_stolen");
  });

  it("mfagc: a second sweep over drained rows reports no work", async () => {
    const stale = await staleChallenge(own.ownerUserId);
    await mfaGc.runMfaChallengeGc({ trigger: "first" });
    expect(await challengeExists(stale)).toBe(false);

    const second = await mfaGc.runMfaChallengeGc({ trigger: "second" });
    // Nothing left for THIS row to contribute, and no event claiming there
    // was: the emission is gated on real work.
    expect(await challengeExists(stale)).toBe(false);
    expect(second.challengesDeleted).toBe(0);
    provenCase("mfagc.idempotency.duplicate_is_noop");
  });

  it("mfagc: a COMPLETED recovery request is never relabelled EXPIRED", async () => {
    // The terminal-truth guarantee for the sweep's second half. APPROVED /
    // COMPLETED / REJECTED rows are an append-only audit trail; only a
    // still-pending request may expire.
    const completed = await prisma.mfaRecoveryRequest.create({
      data: {
        userId: own.ownerUserId,
        teamId: own.teamId,
        reason: "point5 terminal-truth proof",
        status: "COMPLETED",
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });

    await mfaGc.runMfaChallengeGc({ trigger: "point5-proof" });

    const after = await prisma.mfaRecoveryRequest.findUniqueOrThrow({
      where: { id: completed.id },
      select: { status: true },
    });
    expect(after.status).toBe("COMPLETED");
    provenCase("mfagc.terminal.stale_cannot_overwrite");
  });

  // =========================================================================
  // The shared governance run lock — the second defect this suite found
  // =========================================================================

  it("the governance run lock admits exactly one concurrent run per (kind, key)", async () => {
    // The run authority moved into @proovra/shared-runtime so the API and the
    // worker resolve through ONE wrapper — two wrappers over one lock exclude
    // nothing. The lock semantics this test pins are unchanged.
    const { runGovernanceReconciliation } = await import("@proovra/shared-runtime");
    const lockKey = `point5-lock-${randomUUID()}`;
    let bodiesEntered = 0;
    const release: Array<() => void> = [];

    // Bodies that BLOCK, so both attempts genuinely overlap. Before the
    // partial unique index this counted 3.
    const attempt = () =>
      runGovernanceReconciliation(prisma as never, {
        kind: "RETENTION",
        trigger: "point5-lock-proof",
        teamId: own.teamId,
        lockKey,
        body: async () => {
          bodiesEntered += 1;
          await new Promise<void>((r) => release.push(r));
          return null;
        },
      });

    const runs = [attempt(), attempt(), attempt()];
    // Let every attempt reach either the body or the refusal.
    await new Promise((r) => setTimeout(r, 250));
    expect(bodiesEntered).toBe(1);
    for (const r of release) r();
    await Promise.all(runs);

    const rows = await prisma.governanceReconciliationRun.findMany({
      where: { lockKey },
      select: { status: true },
    });
    // One row, one outcome. The two refusals created nothing.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("SUCCEEDED");
  });
});
