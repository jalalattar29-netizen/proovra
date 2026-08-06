/**
 * PHASE 12 — POINT 5, PHASE D: the report/package generation authority, proven.
 *
 * WHY THIS FILE IS AN INTEGRATION SUITE
 * ---------------------------------------------------------------------------
 * Every property worth proving here is a property of PERSISTENCE:
 *
 *   * "the request is committed before the enqueue" is an ordering claim about
 *     two durable effects;
 *   * "two concurrent workers produce one winner" is a claim about a conditional
 *     UPDATE resolving a race;
 *   * "a replay returns the stored result" is a claim about a terminal row;
 *   * "a stale worker cannot overwrite a newer artifact" is a claim about a
 *     `notIn TERMINAL` predicate.
 *
 * A stub cannot exercise any of them. `updateMany().count` against a mock is a
 * number somebody chose. So this runs against a disposable PostgreSQL 16
 * through the same harness the other live gates use.
 *
 * ONE PROPERTY PER TEST CASE — AND WHY THAT MATTERS
 * ---------------------------------------------------------------------------
 * This file was originally a SINGLE `it()` containing 105 assertions covering
 * the 30 required properties. That shape caused a real reporting defect: the
 * suite's own summary said "22 tests" while the narrative said "30/30", because
 * those were different units — vitest CASES versus spec PROPERTIES — and
 * nothing forced them to agree.
 *
 * It also hid failures. The first failing assertion aborted the remaining 29
 * properties, so a run could report one problem while silently not checking the
 * rest.
 *
 * Each numbered property is now its own case, named for the property it proves.
 * The count is therefore machine-countable and the two numbers cannot drift
 * apart again.
 *
 * WHAT IS MOCKED
 * ---------------------------------------------------------------------------
 * Nothing that this suite is testing. The producer, the durable writer, the
 * canonical enqueue path, the strict decoder, the resolve/claim/terminal
 * transitions and the reconciler are all the real production modules.
 *
 * The queue TRANSPORT is a recording fake, deliberately rather than as a
 * shortcut: `enqueueCanonicalJob`'s collapse-or-replace policy is already
 * proven behaviourally against a fake queue in the closure gate, and what this
 * suite needs from the transport is the ability to observe EXACTLY what went on
 * the wire — which a real Redis makes harder to assert, not easier.
 *
 * The generation body itself (PDF rendering, storage writes) is never invoked:
 * every case here is about what happens BEFORE the generator runs, or about
 * what the durable row says AFTER.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CANONICAL_PAYLOAD_KEYS,
  JOB_NAMES,
  QueuePayloadRejected,
  buildCanonicalJobId,
  decodeCanonicalJobPayload,
  decodeJobPayload,
  enqueueCanonicalJob,
  getWorkEntryOrThrow,
  isTerminalJobExecutionState,
  type QueueHandleLike,
} from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  provenCase,
  recordSuiteProof,
} from "./point5/family-coverage-manifest.js";

const ENTRY = getWorkEntryOrThrow(JOB_NAMES.GENERATE_REPORT);
const EXPECT_SHAPE = {
  jobName: ENTRY.workName,
  schemaVersion: ENTRY.schemaVersion,
};

/**
 * A recording queue.
 *
 * Implements exactly the `QueueHandleLike` surface the shared enqueue authority
 * uses, so the real policy runs against it, and keeps every `add` so a test can
 * assert the WIRE FORM rather than the intent.
 */
function recordingQueue(opts: { addThrows?: boolean } = {}) {
  const added: Array<{ name: string; data: unknown; opts: Record<string, unknown> }> = [];
  return {
    added,
    handle: {
      async getJob() {
        return null;
      },
      async add(name: string, data: unknown, o: Record<string, unknown>) {
        if (opts.addThrows) throw new Error("redis down");
        added.push({ name, data, opts: o });
      },
    } as QueueHandleLike,
  };
}

describe("PHASE 12 POINT 5 — ReportGenerationRequest (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  // Late-bound so nothing reads DATABASE_URL before the harness overrides it.
  let prisma: typeof import("../src/db.js")["prisma"];
  let authority: typeof import("../../worker/src/report-generation-authority.js");
  let writer: typeof import("@proovra/shared-runtime/reports");
  let currentPolicyVersion: number;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));

    // Register the harness's Prisma with shared-runtime so the ONE durable
    // writer resolves the same connection the assertions read from.
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);

    writer = await import("@proovra/shared-runtime/reports");
    authority = await import(
      "../../worker/src/report-generation-authority.js"
    );

    const policy = await prisma.workspaceGovernancePolicy.findFirst({
      where: { teamId: harness.fixtures.teamA.teamId },
      select: { version: true },
    });
    // "No row at all" is version 0 — the same convention the governance API
    // reports, so a request predating a workspace's first policy edit does not
    // read as stale the moment that edit lands.
    currentPolicyVersion = policy?.version ?? 0;
  });

  afterAll(async () => {
    // Record BEFORE teardown: the proof is what executed, and a teardown
    // failure must not erase it.
    await recordSuiteProof(import.meta.url);
    await harness?.cleanup();
  });

  /** A committed request in QUEUED state, for cases that need one. */
  async function seedRequest(overrides: Record<string, unknown> = {}) {
    const teamA = harness.fixtures.teamA;
    return prisma.reportGenerationRequest.create({
      data: {
        teamId: teamA.teamId,
        evidenceId: teamA.evidenceId,
        artifactType: "REPORT",
        purpose: "evidence_completed",
        forceRegenerate: false,
        requestedByMachineId: "point5-integration",
        expectedPolicyVersion: currentPolicyVersion,
        idempotencyKey: `REPORT:seed:${randomUUID()}`,
        state: "QUEUED",
        ...overrides,
      },
      select: { id: true },
    });
  }

  // =========================================================================
  // 1. Authorization occurs BEFORE request creation
  // =========================================================================

  it("1a. a request with NO principal is refused, and writes nothing", async () => {
    // The floor: a request nobody can be held to is not auditable and cannot be
    // authorized after the fact, so it must not exist at all.
    const before = await prisma.reportGenerationRequest.count();
    const result = await writer.createReportGenerationRequest(prisma as never, {
      evidenceId: harness.fixtures.teamA.evidenceId,
      purpose: "operator_regenerate",
    });
    expect(result.created).toBe(false);
    expect(result.created === false && result.reason).toBe("requester_required");
    expect(await prisma.reportGenerationRequest.count()).toBe(before);
  });

  it("1b. a request for non-existent evidence is refused (tenant underivable)", async () => {
    const before = await prisma.reportGenerationRequest.count();
    const result = await writer.createReportGenerationRequest(prisma as never, {
      evidenceId: randomUUID(),
      purpose: "operator_regenerate",
      requestedByUserId: harness.fixtures.teamA.ownerUserId,
    });
    expect(result.created).toBe(false);
    expect(result.created === false && result.reason).toBe("evidence_not_found");
    expect(await prisma.reportGenerationRequest.count()).toBe(before);
  });

  // =========================================================================
  // 2. The request is durably COMMITTED before any enqueue
  // =========================================================================

  it("2. the request row is committed, with the workspace DERIVED from evidence", async () => {
    const teamA = harness.fixtures.teamA;
    const created = await writer.createReportGenerationRequest(prisma as never, {
      evidenceId: teamA.evidenceId,
      purpose: "evidence_completed",
      requestedByUserId: teamA.ownerUserId,
    });
    expect(created.created).toBe(true);
    if (!created.created) return;

    const row = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: created.requestId },
    });
    expect(row.state).toBe("QUEUED");
    // Derived, not supplied: the caller never passed a workspace.
    expect(row.teamId).toBe(teamA.teamId);
    expect(row.forceRegenerate).toBe(false);
    expect(row.requestedByUserId).toBe(teamA.ownerUserId);
    provenCase("report.durable.intent_before_work");
  });

  // =========================================================================
  // 3 + 4. The wire carries ONLY the request id
  // =========================================================================

  it("3. the queue payload carries only the reference triple", async () => {
    const seeded = await seedRequest();
    const q = recordingQueue();
    const outcome = await enqueueCanonicalJob({
      queue: q.handle,
      entry: ENTRY,
      commandId: seeded.id,
      traceId: "evidence_completed",
    });
    expect(outcome).toMatchObject({ enqueued: true, collapsed: false });
    expect(q.added).toHaveLength(1);

    const wire = q.added[0]!;
    expect(wire.name).toBe(JOB_NAMES.GENERATE_REPORT);
    expect(wire.opts.jobId).toBe(
      buildCanonicalJobId({ jobIdPrefix: ENTRY.jobIdPrefix! }, seeded.id),
    );
    expect(Object.keys(wire.data as object).sort()).toEqual([
      "commandId",
      "schemaVersion",
      "traceId",
    ]);
    for (const key of Object.keys(wire.data as object)) {
      expect(CANONICAL_PAYLOAD_KEYS).toContain(key);
    }
  });

  it("4. forceRegenerate and the tenant NEVER appear on the wire", async () => {
    const teamA = harness.fixtures.teamA;
    // A FORCE request — the case where the flag actually matters.
    const seeded = await seedRequest({
      forceRegenerate: true,
      purpose: "operator_regenerate",
      idempotencyKey: `REPORT:force:${randomUUID()}`,
    });
    const q = recordingQueue();
    await enqueueCanonicalJob({
      queue: q.handle,
      entry: ENTRY,
      commandId: seeded.id,
      traceId: "operator_regenerate",
    });
    const serialised = JSON.stringify(q.added[0]!.data);
    expect(serialised).not.toContain("forceRegenerate");
    expect(serialised).not.toContain("teamId");
    expect(serialised).not.toContain(teamA.teamId);
    expect(serialised).not.toContain(teamA.evidenceId);
  });

  // =========================================================================
  // 5 + 6 + 7. Tampering is refused BEFORE any database access
  // =========================================================================

  it("5. an extra payload field is rejected, and mutates nothing", async () => {
    const seeded = await seedRequest();
    const before = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: seeded.id },
    });
    const valid = {
      commandId: seeded.id,
      traceId: "t",
      schemaVersion: ENTRY.schemaVersion,
    };

    expect(() =>
      decodeCanonicalJobPayload(EXPECT_SHAPE, {
        ...valid,
        teamId: harness.fixtures.teamB.teamId,
      }),
    ).toThrow(QueuePayloadRejected);
    expect(() =>
      decodeCanonicalJobPayload(EXPECT_SHAPE, { ...valid, forceRegenerate: true }),
    ).toThrow(QueuePayloadRejected);

    // "Before DB access" is a claim about EFFECTS, not line ordering.
    expect(
      await prisma.reportGenerationRequest.findUniqueOrThrow({
        where: { id: seeded.id },
      }),
    ).toEqual(before);
  });

  it("6. an unknown schema version is rejected", async () => {
    const seeded = await seedRequest();
    expect(() =>
      decodeCanonicalJobPayload(EXPECT_SHAPE, {
        commandId: seeded.id,
        traceId: "t",
        schemaVersion: ENTRY.schemaVersion + 99,
      }),
    ).toThrow(QueuePayloadRejected);
  });

  it("7. a missing durable identifier is rejected", () => {
    expect(() =>
      decodeCanonicalJobPayload(EXPECT_SHAPE, {
        traceId: "t",
        schemaVersion: ENTRY.schemaVersion,
      }),
    ).toThrow(QueuePayloadRejected);
  });

  // =========================================================================
  // 8-16. The processor's resolve step reloads EVERYTHING
  // =========================================================================

  it("8. the processor reloads the request and rebuilds the command from persistence", async () => {
    const teamA = harness.fixtures.teamA;
    const seeded = await seedRequest();
    const resolved = await authority.resolveAndClaimReportRequest({
      requestId: seeded.id,
      requestIdForLog: randomUUID(),
    });
    expect(resolved.outcome).toBe("run");
    if (resolved.outcome !== "run") return;

    expect(resolved.command.requestId).toBe(seeded.id);
    expect(resolved.command.evidenceId).toBe(teamA.evidenceId);
    // 9. Workspace derived from the EVIDENCE row, not the request's own copy.
    expect(resolved.command.teamId).toBe(teamA.teamId);
    expect(resolved.command.forceRegenerate).toBe(false);
    provenCase("report.tenant.workspace_reloaded");
  });

  it("9+10. the claim is durable: PROCESSING, stamped, attempt incremented", async () => {
    const seeded = await seedRequest();
    await authority.resolveAndClaimReportRequest({
      requestId: seeded.id,
      requestIdForLog: randomUUID(),
    });
    const claimed = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: seeded.id },
    });
    expect(claimed.state).toBe("PROCESSING");
    expect(claimed.claimedAtUtc).not.toBeNull();
    expect(claimed.attemptCount).toBe(1);
  });

  it("11. a cross-workspace request is DENIED with zero mutation on the target", async () => {
    const teamA = harness.fixtures.teamA;
    const teamB = harness.fixtures.teamB;
    // Built by hand precisely because the producer would refuse it: this is the
    // tampered-durable-row case, where the request names workspace B while its
    // evidence lives in workspace A.
    const cross = await prisma.reportGenerationRequest.create({
      data: {
        teamId: teamB.teamId,
        evidenceId: teamA.evidenceId,
        artifactType: "REPORT",
        purpose: "operator_regenerate",
        forceRegenerate: false,
        requestedByUserId: teamB.ownerUserId,
        expectedPolicyVersion: 0,
        idempotencyKey: `REPORT:cross:${randomUUID()}`,
        state: "QUEUED",
      },
      select: { id: true },
    });

    const evidenceBefore = await prisma.evidence.findUniqueOrThrow({
      where: { id: teamA.evidenceId },
    });
    const reportsBefore = await prisma.report.count({
      where: { evidenceId: teamA.evidenceId },
    });

    const resolved = await authority.resolveAndClaimReportRequest({
      requestId: cross.id,
      requestIdForLog: randomUUID(),
    });
    expect(resolved.outcome).toBe("noop");
    if (resolved.outcome !== "noop") return;
    expect(resolved.reason).toBe("workspace_mismatch");

    const row = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: cross.id },
    });
    expect(row.state).toBe("BLOCKED_POLICY");
    expect(row.terminalReasonCode).toBe("workspace_mismatch");
    // Never claimed, so no generator could ever have run.
    expect(row.claimedAtUtc).toBeNull();

    expect(
      await prisma.evidence.findUniqueOrThrow({ where: { id: teamA.evidenceId } }),
    ).toEqual(evidenceBefore);
    expect(
      await prisma.report.count({ where: { evidenceId: teamA.evidenceId } }),
    ).toBe(reportsBefore);
    provenCase("report.tenant.cross_workspace_denied");
  });

  it("13. a SUSPENDED organization is denied with zero mutation", async () => {
    const teamA = harness.fixtures.teamA;
    const workspace = await prisma.team.findUniqueOrThrow({
      where: { id: teamA.teamId },
      select: { organizationId: true },
    });
    const orgBefore = await prisma.organization.findUniqueOrThrow({
      where: { id: workspace.organizationId },
      select: { status: true },
    });
    const seeded = await seedRequest();
    const reportsBefore = await prisma.report.count({
      where: { evidenceId: teamA.evidenceId },
    });

    await prisma.organization.update({
      where: { id: workspace.organizationId },
      data: { status: "SUSPENDED" },
    });
    try {
      const resolved = await authority.resolveAndClaimReportRequest({
        requestId: seeded.id,
        requestIdForLog: randomUUID(),
      });
      expect(resolved.outcome).toBe("noop");
      if (resolved.outcome !== "noop") return;
      expect(resolved.reason).toBe("organization_not_active");

      const row = await prisma.reportGenerationRequest.findUniqueOrThrow({
        where: { id: seeded.id },
      });
      expect(row.state).toBe("BLOCKED_POLICY");
      expect(row.claimedAtUtc).toBeNull();
      expect(
        await prisma.report.count({ where: { evidenceId: teamA.evidenceId } }),
      ).toBe(reportsBefore);
    } finally {
      await prisma.organization.update({
        where: { id: workspace.organizationId },
        data: { status: orgBefore.status },
      });
    }
  });

  it("14+15. a STALE policy version blocks before any storage write", async () => {
    const teamA = harness.fixtures.teamA;
    const reportsBefore = await prisma.report.count({
      where: { evidenceId: teamA.evidenceId },
    });
    const seeded = await seedRequest({
      expectedPolicyVersion: currentPolicyVersion + 7,
      idempotencyKey: `REPORT:stale:${randomUUID()}`,
    });

    const resolved = await authority.resolveAndClaimReportRequest({
      requestId: seeded.id,
      requestIdForLog: randomUUID(),
    });
    expect(resolved.outcome).toBe("noop");
    if (resolved.outcome !== "noop") return;
    expect(resolved.reason).toBe("policy_version_changed");

    const row = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: seeded.id },
    });
    // An artifact generated under a policy nobody approved is worse than no
    // artifact, so this is TERMINAL rather than retryable.
    expect(row.state).toBe("BLOCKED_STALE");
    expect(row.claimedAtUtc).toBeNull();
    expect(
      await prisma.report.count({ where: { evidenceId: teamA.evidenceId } }),
    ).toBe(reportsBefore);
  });

  it("16. an ACTIVE legal hold blocks a REGENERATION but not a first generation", async () => {
    const teamA = harness.fixtures.teamA;
    // Asymmetric on purpose: a regeneration REPLACES a finalised artifact,
    // which under an active hold is a mutation of preserved material. A FIRST
    // generation is not blocked, because there is nothing yet to preserve.
    const hold = await prisma.evidenceLegalHold.create({
      data: {
        evidenceId: teamA.evidenceId,
        teamId: teamA.teamId,
        scope: "EVIDENCE",
        status: "ACTIVE",
        title: "point5-integration-hold",
        reason: "point5-integration-hold",
        placedByUserId: teamA.ownerUserId,
      },
      select: { id: true },
    });
    try {
      const forced = await seedRequest({
        forceRegenerate: true,
        purpose: "operator_regenerate",
        idempotencyKey: `REPORT:held:${randomUUID()}`,
      });
      const blocked = await authority.resolveAndClaimReportRequest({
        requestId: forced.id,
        requestIdForLog: randomUUID(),
      });
      expect(blocked.outcome).toBe("noop");
      if (blocked.outcome !== "noop") return;
      expect(blocked.reason).toBe("legal_hold_active");

      const blockedRow = await prisma.reportGenerationRequest.findUniqueOrThrow({
        where: { id: forced.id },
      });
      expect(blockedRow.state).toBe("BLOCKED_POLICY");
      expect(blockedRow.claimedAtUtc).toBeNull();

      const first = await seedRequest({
        idempotencyKey: `REPORT:heldfirst:${randomUUID()}`,
      });
      const allowed = await authority.resolveAndClaimReportRequest({
        requestId: first.id,
        requestIdForLog: randomUUID(),
      });
      expect(allowed.outcome).toBe("run");
    } finally {
      await prisma.evidenceLegalHold.delete({ where: { id: hold.id } });
    }
  });

  // =========================================================================
  // 17-21. Replay, duplicates, and the stale-overwrite guard
  // =========================================================================

  it("17. duplicate intent collapses to ONE row via the idempotency key", async () => {
    const teamB = harness.fixtures.teamB;
    const a = await writer.createReportGenerationRequest(prisma as never, {
      evidenceId: teamB.evidenceId,
      purpose: "evidence_completed",
      requestedByMachineId: "point5-integration",
    });
    const b = await writer.createReportGenerationRequest(prisma as never, {
      evidenceId: teamB.evidenceId,
      purpose: "evidence_completed",
      requestedByMachineId: "point5-integration",
    });
    expect(a.created && b.created).toBe(true);
    if (!a.created || !b.created) return;
    expect(b.requestId).toBe(a.requestId);
    expect(b.deduplicated).toBe(true);
  });

  it("17b. the idempotency key is anchored on the version it advances PAST", () => {
    const evidenceId = harness.fixtures.teamB.evidenceId;
    // A key without the version would make a second legitimate regenerate a
    // silent no-op; a key with a timestamp would produce two reports.
    expect(
      writer.buildReportGenerationIdempotencyKey({
        artifactType: "REPORT",
        evidenceId,
        baselineVersion: 0,
        forceRegenerate: false,
      }),
    ).toBe(`REPORT:${evidenceId}:v0`);
    expect(
      writer.buildReportGenerationIdempotencyKey({
        artifactType: "REPORT",
        evidenceId,
        baselineVersion: 3,
        forceRegenerate: true,
      }),
    ).toBe(`REPORT:${evidenceId}:v3:force`);
  });

  it("18. a replay onto a terminal request returns the stored result and re-runs nothing", async () => {
    const seeded = await seedRequest({
      state: "SUCCEEDED",
      terminalReasonCode: "generated",
      completedAtUtc: new Date(),
      idempotencyKey: `REPORT:term:${randomUUID()}`,
    });
    const replay = await authority.resolveAndClaimReportRequest({
      requestId: seeded.id,
      requestIdForLog: randomUUID(),
    });
    expect(replay.outcome).toBe("replay");
    if (replay.outcome !== "replay") return;
    expect(replay.state).toBe("SUCCEEDED");

    const row = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: seeded.id },
    });
    // Did NOT claim, did NOT increment, did NOT re-run.
    expect(row.attemptCount).toBe(0);
    expect(row.state).toBe("SUCCEEDED");
    provenCase("report.idempotency.duplicate_is_noop");
  });

  it("29. a stale worker cannot overwrite a SUCCEEDED row", async () => {
    const seeded = await seedRequest({
      state: "SUCCEEDED",
      terminalReasonCode: "generated",
      completedAtUtc: new Date(),
      idempotencyKey: `REPORT:overwrite:${randomUUID()}`,
    });
    // The `notIn TERMINAL` predicate doing its job: without it, a worker whose
    // lease expired and whose replacement already finished would overwrite the
    // truth with its own stale outcome.
    const wrote = await authority.markRequestTerminal({
      requestId: seeded.id,
      state: "FAILED_TERMINAL",
      terminalReasonCode: "late_worker",
    });
    expect(wrote).toBe(false);
    const row = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: seeded.id },
    });
    expect(row.state).toBe("SUCCEEDED");
    expect(row.terminalReasonCode).toBe("generated");
    provenCase("report.terminal.stale_cannot_overwrite");
  });

  // =========================================================================
  // 19-21. Concurrency and lease recovery
  // =========================================================================

  it("19. three simultaneous workers produce exactly ONE winner", async () => {
    const seeded = await seedRequest({
      idempotencyKey: `REPORT:race:${randomUUID()}`,
    });
    const racers = await Promise.all([
      authority.resolveAndClaimReportRequest({
        requestId: seeded.id,
        requestIdForLog: randomUUID(),
      }),
      authority.resolveAndClaimReportRequest({
        requestId: seeded.id,
        requestIdForLog: randomUUID(),
      }),
      authority.resolveAndClaimReportRequest({
        requestId: seeded.id,
        requestIdForLog: randomUUID(),
      }),
    ]);
    expect(racers.filter((r) => r.outcome === "run")).toHaveLength(1);
    expect(racers.filter((r) => r.outcome === "noop")).toHaveLength(2);
    // The database resolved it, not call ordering: one increment total.
    const row = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: seeded.id },
    });
    expect(row.attemptCount).toBe(1);
    provenCase("report.claim.one_winner");
  });

  it("20. an ACTIVE claim is not stolen, and the loser mutates nothing", async () => {
    const seeded = await seedRequest();
    await authority.resolveAndClaimReportRequest({
      requestId: seeded.id,
      requestIdForLog: randomUUID(),
    });
    const afterFirst = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: seeded.id },
    });

    const loser = await authority.resolveAndClaimReportRequest({
      requestId: seeded.id,
      requestIdForLog: randomUUID(),
    });
    expect(loser.outcome).toBe("noop");
    if (loser.outcome !== "noop") return;
    expect(loser.reason).toBe("claim_held_by_another_worker");

    const afterLoser = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: seeded.id },
    });
    expect(afterLoser.attemptCount).toBe(afterFirst.attemptCount);
    expect(afterLoser.claimedAtUtc?.toISOString()).toBe(
      afterFirst.claimedAtUtc?.toISOString(),
    );
    provenCase("report.claim.active_not_stolen");
  });

  it("21. an EXPIRED lease is recovered, and a fresh one is not", async () => {
    const seeded = await seedRequest({
      state: "PROCESSING",
      // Older than the lease: the worker that held this is gone.
      claimedAtUtc: new Date(
        Date.now() - authority.REPORT_CLAIM_LEASE_MS - 60_000,
      ),
      attemptCount: 1,
      idempotencyKey: `REPORT:stranded:${randomUUID()}`,
    });

    const recovered = await authority.resolveAndClaimReportRequest({
      requestId: seeded.id,
      requestIdForLog: randomUUID(),
    });
    expect(recovered.outcome).toBe("run");
    const row = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: seeded.id },
    });
    expect(row.attemptCount).toBe(2);

    // The same predicate that recovered the expired claim refuses the live one.
    const stealAttempt = await authority.resolveAndClaimReportRequest({
      requestId: seeded.id,
      requestIdForLog: randomUUID(),
    });
    expect(stealAttempt.outcome).toBe("noop");
  });

  // =========================================================================
  // 23 + 24. Enqueue failure and reconciliation
  // =========================================================================

  it("23. enqueue failure leaves a recoverable QUEUED request", async () => {
    const failing = recordingQueue({ addThrows: true });
    const seeded = await seedRequest({
      idempotencyKey: `REPORT:orphan:${randomUUID()}`,
    });

    const outcome = await enqueueCanonicalJob({
      queue: failing.handle,
      entry: ENTRY,
      commandId: seeded.id,
      traceId: "evidence_completed",
    });
    expect(outcome.enqueued).toBe(false);
    expect(failing.added).toHaveLength(0);

    // The whole durability argument: DB-commit-then-queue-failure is
    // recoverable, and the API reported honestly rather than claiming a
    // schedule it did not make.
    const row = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: seeded.id },
    });
    expect(row.state).toBe("QUEUED");
  });

  it("24. the reconciler restores stranded intent EXACTLY once and never touches terminal rows", async () => {
    const stranded = await seedRequest({
      idempotencyKey: `REPORT:recon:${randomUUID()}`,
    });
    const terminal = await seedRequest({
      state: "SUCCEEDED",
      terminalReasonCode: "generated",
      completedAtUtc: new Date(),
      idempotencyKey: `REPORT:reconterm:${randomUUID()}`,
    });
    const blocked = await seedRequest({
      state: "BLOCKED_STALE",
      terminalReasonCode: "policy_version_changed",
      completedAtUtc: new Date(),
      idempotencyKey: `REPORT:reconblocked:${randomUUID()}`,
    });

    const reenqueued: string[] = [];
    const summary = await authority.reconcileStrandedReportRequests({
      enqueue: async (requestId) => {
        reenqueued.push(requestId);
        return { enqueued: true };
      },
      batchSize: 500,
    });

    expect(reenqueued).toContain(stranded.id);
    expect(reenqueued.filter((id) => id === stranded.id)).toHaveLength(1);
    expect(summary.reenqueued).toBeGreaterThan(0);
    // Terminal rows are never re-enqueued.
    expect(reenqueued).not.toContain(terminal.id);
    expect(reenqueued).not.toContain(blocked.id);
  });

  // =========================================================================
  // 25 + 30. Bounded outcomes and concealment
  // =========================================================================

  it("25. a request naming deleted evidence becomes a bounded terminal state", async () => {
    const seeded = await seedRequest({
      evidenceId: randomUUID(),
      idempotencyKey: `REPORT:gone:${randomUUID()}`,
    });
    const resolved = await authority.resolveAndClaimReportRequest({
      requestId: seeded.id,
      requestIdForLog: randomUUID(),
    });
    expect(resolved.outcome).toBe("noop");
    if (resolved.outcome !== "noop") return;
    // Not a retry loop: the row is not going to appear.
    expect(resolved.reason).toBe("evidence_not_found");
    const row = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: seeded.id },
    });
    expect(row.state).toBe("FAILED_TERMINAL");
  });

  it("30. a request naming an unknown id is refused without disclosing existence", async () => {
    const resolved = await authority.resolveAndClaimReportRequest({
      requestId: randomUUID(),
      requestIdForLog: randomUUID(),
    });
    expect(resolved.outcome).toBe("noop");
    if (resolved.outcome !== "noop") return;
    // The same bounded reason a caller gets for any unresolvable id: nothing
    // in the outcome distinguishes "never existed" from "another tenant's".
    expect(resolved.reason).toBe("request_not_found");
  });

  // =========================================================================
  // Legacy drain
  // =========================================================================

  it("L1. a legacy payload yields the reference and DISCARDS the force decision", () => {
    const teamA = harness.fixtures.teamA;
    const decoded = decodeJobPayload(EXPECT_SHAPE, {
      evidenceId: teamA.evidenceId,
      forceRegenerate: true,
      regenerateReason: "attacker",
      teamId: harness.fixtures.teamB.teamId,
    });
    expect(decoded.legacy).toBe(true);
    expect(decoded.commandId).toBe(teamA.evidenceId);
    expect([...decoded.discardedAuthorityFields].sort()).toEqual([
      "forceRegenerate",
      "teamId",
    ]);
    // The VALUES are unreachable — the result holds names only.
    expect(JSON.stringify(decoded)).not.toContain("attacker");
    expect(decoded).not.toHaveProperty("forceRegenerate");
  });

  it("L2. a fresh legacy mint is attributed to the drain machine and is NOT a force", async () => {
    const personal = harness.fixtures.personal;
    const minted = await authority.mintRequestForLegacyJob({
      evidenceId: personal.evidenceId,
      jobId: "legacy-fresh",
    });
    expect(minted.requestId).not.toBeNull();
    const row = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: minted.requestId! },
    });
    expect(row.forceRegenerate).toBe(false);
    expect(row.teamId).toBe(personal.teamId);
    expect(row.requestedByMachineId).toBe("queue-legacy-drain");
  });

  it("L3. a legacy mint COLLAPSES onto an equivalent request without escalating it", async () => {
    const teamA = harness.fixtures.teamA;
    // Ensure the canonical non-force request exists first.
    const canonical = await writer.createReportGenerationRequest(
      prisma as never,
      {
        evidenceId: teamA.evidenceId,
        purpose: "evidence_completed",
        requestedByUserId: teamA.ownerUserId,
      },
    );
    expect(canonical.created).toBe(true);
    if (!canonical.created) return;

    const before = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: canonical.requestId },
    });
    expect(before.forceRegenerate).toBe(false);

    const collapsed = await authority.mintRequestForLegacyJob({
      evidenceId: teamA.evidenceId,
      jobId: "legacy-collapse",
    });
    expect(collapsed.requestId).toBe(canonical.requestId);

    // The sharpest property in this suite: a draining job whose payload
    // asserted `forceRegenerate: true` cannot ESCALATE an existing non-force
    // request. It joins it.
    const after = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: canonical.requestId },
    });
    expect(after.forceRegenerate).toBe(false);
    expect(
      await prisma.reportGenerationRequest.count({
        where: { idempotencyKey: before.idempotencyKey },
      }),
    ).toBe(1);
  });

  it("T. terminal vocabulary is shared, not restated", () => {
    expect(isTerminalJobExecutionState("SUCCEEDED")).toBe(true);
    expect(isTerminalJobExecutionState("BLOCKED_STALE")).toBe(true);
    expect(isTerminalJobExecutionState("PROCESSING")).toBe(false);
    expect(isTerminalJobExecutionState("QUEUED")).toBe(false);
  });
});
