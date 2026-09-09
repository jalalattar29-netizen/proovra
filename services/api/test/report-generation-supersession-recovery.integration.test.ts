/**
 * BLOCKED SUPERSESSION AND STRANDED-REQUEST RECOVERY, PROVEN AGAINST POSTGRES.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS SEPARATELY
 * ===========================================================================
 * The forensic audit's P1-2 and P1-4 are claims about ROWS: that a terminal
 * BLOCKED request whose blocker has ended can be superseded exactly once, that
 * one whose blocker still stands cannot be, that a non-recoverable block can
 * never be, that the supersession chain advances from its HEAD rather than from
 * its base, and that a durable request whose enqueue was lost is picked up
 * later by a sweep.
 *
 * Not one of those is observable from source text. `updateMany().count` against
 * a mock is a number somebody chose, and a regex proving the string
 * "blockerStillActive" appears in a file proves only that the string appears in
 * a file. So these run the real writer, the real classifier and the real
 * reconciler against a disposable PostgreSQL 16.
 *
 * ===========================================================================
 * WHY NOT INSIDE THE EXISTING POINT-5 REPORT SUITE
 * ===========================================================================
 * That suite is a GOVERNED PROOF ARTIFACT. Its records are keyed by file SHA,
 * and the family gate discards every record in the artifact unless the run that
 * produced them shares one id — so appending cases to it invalidates the
 * recorded proof for nine families and forces a full re-run of the integration
 * project to restore them.
 *
 * This suite therefore records nothing and claims no family credit. It is a
 * behavioural gate in its own right, which is what it was asked to be; the
 * proof artifact keeps meaning what it already meant.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  isRecoverableBlockedTerminalReason,
  listNonRecoverableBlockedTerminalReasons,
  listRecoverableBlockedTerminalReasons,
} from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";

describe("blocked supersession + stranded recovery (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let writer: typeof import("@proovra/shared-runtime/reports");
  let authority: typeof import("../../worker/src/report-generation-authority.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    writer = await import("@proovra/shared-runtime/reports");
    authority = await import("../../worker/src/report-generation-authority.js");
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  /**
   * Clear this record's request chain so each case starts from a known shape.
   *
   * Deliberately narrow: only the rows for the fixture evidence, so a case
   * cannot silently depend on another case's leftovers and cannot destroy a
   * neighbouring fixture's history.
   */
  async function resetChain(evidenceId: string) {
    await prisma.reportGenerationRequest.deleteMany({ where: { evidenceId } });
  }

  /** The base idempotency key for a first generation of this record. */
  function baseKey(evidenceId: string) {
    return `REPORT:${evidenceId}:v0`;
  }

  /** Seed a TERMINAL blocked row, as the worker would have written it. */
  async function seedBlocked(input: {
    evidenceId: string;
    teamId: string;
    key: string;
    terminalReasonCode: string;
    state?: string;
  }) {
    return prisma.reportGenerationRequest.create({
      data: {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        artifactType: "REPORT",
        purpose: "evidence_completed",
        forceRegenerate: false,
        requestedByMachineId: "supersession-integration",
        expectedPolicyVersion: 0,
        idempotencyKey: input.key,
        state: input.state ?? "BLOCKED_POLICY",
        terminalReasonCode: input.terminalReasonCode,
      },
      select: { id: true, idempotencyKey: true, state: true },
    });
  }

  function request(evidenceId: string) {
    return writer.createReportGenerationRequest(prisma as never, {
      evidenceId,
      purpose: "evidence_completed",
      requestedByMachineId: "supersession-integration",
    });
  }

  // =========================================================================
  // R8 — a stale policy version is a blocker that has already ended
  // =========================================================================

  it("R8: a POLICY_VERSION_CHANGED terminal is superseded, and the old row is untouched", async () => {
    const { evidenceId, teamId } = harness.fixtures.teamA;
    await resetChain(evidenceId);
    const old = await seedBlocked({
      evidenceId,
      teamId,
      key: baseKey(evidenceId),
      terminalReasonCode: "POLICY_VERSION_CHANGED",
      state: "BLOCKED_STALE",
    });

    const result = await request(evidenceId);
    expect(result.created).toBe(true);
    if (!result.created) return;
    expect(result.superseded).toBe(true);

    const minted = await prisma.reportGenerationRequest.findUnique({
      where: { id: result.requestId },
      select: { idempotencyKey: true, state: true },
    });
    // The chain advances by ordinal, from the base key.
    expect(minted?.idempotencyKey).toBe(`${baseKey(evidenceId)}:s1`);
    expect(minted?.state).toBe("QUEUED");

    // HISTORY IS IMMUTABLE. The refusal really happened and stays readable.
    const before = await prisma.reportGenerationRequest.findUnique({
      where: { id: old.id },
      select: { state: true, terminalReasonCode: true },
    });
    expect(before?.state).toBe("BLOCKED_STALE");
    expect(before?.terminalReasonCode).toBe("POLICY_VERSION_CHANGED");
  });

  // =========================================================================
  // R9 — a legal hold that is STILL ACTIVE is not a blocker that has ended
  // =========================================================================

  it("R9: an ACTIVE legal hold is NOT superseded, and the refusal says it could end", async () => {
    const { evidenceId, teamId, ownerUserId } = harness.fixtures.teamA;
    await resetChain(evidenceId);
    await seedBlocked({
      evidenceId,
      teamId,
      key: baseKey(evidenceId),
      terminalReasonCode: "LEGAL_HOLD_ACTIVE",
    });

    const hold = await prisma.evidenceLegalHold.create({
      data: {
        evidenceId,
        teamId,
        status: "ACTIVE",
        title: "supersession-integration",
        reason: "supersession-integration",
        placedByUserId: ownerUserId,
      },
      select: { id: true },
    });

    try {
      const blocked = await request(evidenceId);
      /*
       * The writer COLLAPSES onto the standing terminal row rather than
       * refusing outright — `created: true, deduplicated: true` carrying that
       * row's state — and the API service is what turns that into a customer
       * answer, by asking whether the terminal state is a blocked one whose
       * reason could end.
       *
       * So the contract this case pins is what the service needs in order to
       * answer correctly: the state AND the reason code. The reason code was
       * being read from the database and dropped on the way out, which made
       * every recoverable block classify as `TERMINAL` — "cannot be retried in
       * its current state" — for a hold that lifts the moment someone releases
       * it.
       */
      expect(blocked.created).toBe(true);
      if (!blocked.created) return;
      expect(blocked.deduplicated).toBe(true);
      expect(blocked.superseded).toBe(false);
      expect(blocked.state).toBe("BLOCKED_POLICY");
      // The caller can tell "blocked, and it could lift" from "over".
      expect(blocked.terminalReasonCode).toBe("LEGAL_HOLD_ACTIVE");
      expect(
        isRecoverableBlockedTerminalReason(blocked.terminalReasonCode ?? null),
      ).toBe(true);

      // Nothing new was minted while the hold stood.
      const rows = await prisma.reportGenerationRequest.count({
        where: { evidenceId },
      });
      expect(rows).toBe(1);
    } finally {
      await prisma.evidenceLegalHold.delete({ where: { id: hold.id } });
    }
  });

  it("R9b: once the hold is released the same click finally works", async () => {
    const { evidenceId } = harness.fixtures.teamA;
    // The chain from the previous case is intact and the hold is gone.
    const after = await request(evidenceId);
    expect(after.created).toBe(true);
    if (!after.created) return;
    expect(after.superseded).toBe(true);

    const minted = await prisma.reportGenerationRequest.findUnique({
      where: { id: after.requestId },
      select: { idempotencyKey: true },
    });
    expect(minted?.idempotencyKey).toBe(`${baseKey(evidenceId)}:s1`);
  });

  // =========================================================================
  // R11 — a block that describes the REQUEST can never be waited out
  // =========================================================================

  it("R11: a non-recoverable block is never superseded, however many times it is asked", async () => {
    const { evidenceId, teamId } = harness.fixtures.teamA;
    await resetChain(evidenceId);
    await seedBlocked({
      evidenceId,
      teamId,
      key: baseKey(evidenceId),
      terminalReasonCode: "WORKSPACE_MISMATCH",
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const refused = await request(evidenceId);
      // Collapses onto the standing row every time; NEVER supersedes it, so no
      // `:s1` is ever minted and no new work is ever scheduled.
      expect(refused.created).toBe(true);
      if (!refused.created) return;
      expect(refused.superseded).toBe(false);
      expect(refused.terminalReasonCode).toBe("WORKSPACE_MISMATCH");
      expect(
        isRecoverableBlockedTerminalReason(refused.terminalReasonCode ?? null),
      ).toBe(false);
    }
    expect(
      await prisma.reportGenerationRequest.count({ where: { evidenceId } }),
    ).toBe(1);
  });

  it("an UNKNOWN terminal reason fails closed — it is not supersedable", async () => {
    const { evidenceId, teamId } = harness.fixtures.teamA;
    await resetChain(evidenceId);
    await seedBlocked({
      evidenceId,
      teamId,
      key: baseKey(evidenceId),
      terminalReasonCode: "SOME_REASON_NOBODY_HAS_CLASSIFIED",
    });

    const refused = await request(evidenceId);
    expect(refused.created).toBe(true);
    if (!refused.created) return;
    // Not superseded: an unclassified reason must not become silently
    // supersedable, because supersession is what lets new generation run.
    expect(refused.superseded).toBe(false);
    expect(refused.terminalReasonCode).toBe(
      "SOME_REASON_NOBODY_HAS_CLASSIFIED",
    );
    // And the classifier agrees, so the projection and the writer cannot
    // disagree about the same code.
    expect(
      isRecoverableBlockedTerminalReason("SOME_REASON_NOBODY_HAS_CLASSIFIED"),
    ).toBe(false);
    expect(
      await prisma.reportGenerationRequest.count({ where: { evidenceId } }),
    ).toBe(1);
  });

  // =========================================================================
  // THE CHAIN ADVANCES FROM ITS HEAD, NOT FROM ITS BASE
  // =========================================================================

  it("a second supersession mints :s2, not a duplicate :s1", async () => {
    const { evidenceId, teamId } = harness.fixtures.teamA;
    await resetChain(evidenceId);
    await seedBlocked({
      evidenceId,
      teamId,
      key: baseKey(evidenceId),
      terminalReasonCode: "POLICY_VERSION_CHANGED",
      state: "BLOCKED_STALE",
    });
    await seedBlocked({
      evidenceId,
      teamId,
      key: `${baseKey(evidenceId)}:s1`,
      terminalReasonCode: "POLICY_VERSION_CHANGED",
      state: "BLOCKED_STALE",
    });

    const next = await request(evidenceId);
    expect(next.created).toBe(true);
    if (!next.created) return;
    const minted = await prisma.reportGenerationRequest.findUnique({
      where: { id: next.requestId },
      select: { idempotencyKey: true },
    });
    // Reading the BASE would have produced :s1 and collided with the row that
    // already holds that key — the unique index would have turned a legitimate
    // retry into a permanent refusal.
    expect(minted?.idempotencyKey).toBe(`${baseKey(evidenceId)}:s2`);
  });

  it("two concurrent supersessions of one chain produce exactly ONE new row", async () => {
    const { evidenceId, teamId } = harness.fixtures.teamA;
    await resetChain(evidenceId);
    await seedBlocked({
      evidenceId,
      teamId,
      key: baseKey(evidenceId),
      terminalReasonCode: "POLICY_VERSION_CHANGED",
      state: "BLOCKED_STALE",
    });

    const results = await Promise.all([
      request(evidenceId),
      request(evidenceId),
      request(evidenceId),
    ]);
    const created = results.filter((r) => r.created);
    expect(created.length).toBeGreaterThan(0);

    const live = await prisma.reportGenerationRequest.findMany({
      where: { evidenceId, state: "QUEUED" },
      select: { id: true, idempotencyKey: true },
    });
    // One unit of work, whatever each caller was told.
    expect(live.length).toBe(1);
    expect(live[0]?.idempotencyKey).toBe(`${baseKey(evidenceId)}:s1`);
    // And every caller that was told "created" was told about the SAME row.
    const ids = new Set(created.map((r) => (r.created ? r.requestId : "")));
    expect(ids.size).toBe(1);
  });

  // =========================================================================
  // R5 / R6 / R7 — the reconciler, on rows the audit said nothing recovered
  // =========================================================================

  it("R5: a REGENERATION whose enqueue was lost is re-enqueued by the sweep", async () => {
    const { evidenceId, teamId } = harness.fixtures.teamA;
    await resetChain(evidenceId);
    const stranded = await prisma.reportGenerationRequest.create({
      data: {
        teamId,
        evidenceId,
        artifactType: "REPORT",
        purpose: "operator_regenerate",
        // The distinguishing property: this is a REGENERATION, the case the
        // evidence-shaped sweep cannot see because the record HAS a report.
        forceRegenerate: true,
        regenerateReason: "operator_regenerate",
        requestedByMachineId: "supersession-integration",
        expectedPolicyVersion: 0,
        idempotencyKey: `REPORT:${evidenceId}:v1:force:${randomUUID()}`.slice(
          0,
          160,
        ),
        state: "QUEUED",
        createdAtUtc: new Date(Date.now() - 60 * 60 * 1000),
      },
      select: { id: true },
    });

    const enqueued: string[] = [];
    const summary = await authority.reconcileStrandedReportRequests({
      enqueue: async (id: string) => {
        enqueued.push(id);
        return { enqueued: true as const, jobId: `job-${id}` };
      },
    });

    expect(enqueued).toContain(stranded.id);
    expect(summary.reenqueued).toBeGreaterThanOrEqual(1);

    // Still QUEUED and still a regeneration — recovery restores SCHEDULING and
    // never re-decides authorization.
    const after = await prisma.reportGenerationRequest.findUnique({
      where: { id: stranded.id },
      select: { state: true, forceRegenerate: true },
    });
    expect(after?.state).toBe("QUEUED");
    expect(after?.forceRegenerate).toBe(true);
  });

  it("R7: a request past its attempt ceiling is retired, not re-enqueued again", async () => {
    const { evidenceId, teamId } = harness.fixtures.teamA;
    await resetChain(evidenceId);
    const exhausted = await prisma.reportGenerationRequest.create({
      data: {
        teamId,
        evidenceId,
        artifactType: "REPORT",
        purpose: "evidence_completed",
        forceRegenerate: false,
        requestedByMachineId: "supersession-integration",
        expectedPolicyVersion: 0,
        idempotencyKey:
          `REPORT:${evidenceId}:v0:exhausted:${randomUUID()}`.slice(0, 160),
        state: "FAILED_RETRYABLE",
        attemptCount: authority.REPORT_RECONCILE_MAX_ATTEMPTS + 1,
        createdAtUtc: new Date(Date.now() - 60 * 60 * 1000),
      },
      select: { id: true },
    });

    const enqueued: string[] = [];
    await authority.reconcileStrandedReportRequests({
      enqueue: async (id: string) => {
        enqueued.push(id);
        return { enqueued: true as const, jobId: `job-${id}` };
      },
    });

    // The customer stops being told "generating" for something that will never
    // run again...
    const after = await prisma.reportGenerationRequest.findUnique({
      where: { id: exhausted.id },
      select: { state: true },
    });
    expect(after?.state).toBe("FAILED_TERMINAL");
    // ...and the same pass that retired it does not also schedule it.
    expect(enqueued).not.toContain(exhausted.id);
  });

  it("R6: an expired PROCESSING lease is released; a live one is not", async () => {
    const { evidenceId, teamId } = harness.fixtures.teamA;
    await resetChain(evidenceId);
    const base = {
      teamId,
      evidenceId,
      artifactType: "REPORT",
      purpose: "evidence_completed",
      forceRegenerate: false,
      requestedByMachineId: "supersession-integration",
      expectedPolicyVersion: 0,
      state: "PROCESSING",
    };
    const dead = await prisma.reportGenerationRequest.create({
      data: {
        ...base,
        idempotencyKey: `REPORT:${evidenceId}:dead:${randomUUID()}`.slice(
          0,
          160,
        ),
        claimedAtUtc: new Date(
          Date.now() - authority.REPORT_CLAIM_LEASE_MS - 60_000,
        ),
      },
      select: { id: true },
    });
    const live = await prisma.reportGenerationRequest.create({
      data: {
        ...base,
        idempotencyKey: `REPORT:${evidenceId}:live:${randomUUID()}`.slice(
          0,
          160,
        ),
        claimedAtUtc: new Date(),
      },
      select: { id: true },
    });

    await authority.reconcileStrandedReportRequests({
      enqueue: async (id: string) => ({ enqueued: true as const, jobId: id }),
    });

    expect(
      (
        await prisma.reportGenerationRequest.findUnique({
          where: { id: dead.id },
          select: { state: true },
        })
      )?.state,
    ).toBe("FAILED_RETRYABLE");
    // A worker that is alive keeps its claim. Stealing it would double-run.
    expect(
      (
        await prisma.reportGenerationRequest.findUnique({
          where: { id: live.id },
          select: { state: true },
        })
      )?.state,
    ).toBe("PROCESSING");
  });

  it("the two classifications are disjoint and neither is empty", () => {
    const recoverable = listRecoverableBlockedTerminalReasons();
    const permanent: readonly string[] =
      listNonRecoverableBlockedTerminalReasons();
    expect(recoverable.length).toBeGreaterThan(0);
    expect(permanent.length).toBeGreaterThan(0);
    expect(recoverable.filter((r) => permanent.includes(r))).toEqual([]);
  });
});
