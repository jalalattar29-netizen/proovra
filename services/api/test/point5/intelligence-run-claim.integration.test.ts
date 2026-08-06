/**
 * PHASE 12 — POINT 5: the intelligence-run claim and its recovery.
 *
 * WHAT THIS SUITE EXISTS TO PIN
 * ---------------------------------------------------------------------------
 * Three production defects, found by reading the intelligence family's claim
 * against its reconciler and fixed together because they are one bug wearing
 * three faces: the durable authority for `MediaIntelligenceRun` did not
 * actually enforce exclusive possession.
 *
 *   A. THE RECONCILER SELECTED A STATUS NOTHING WRITES.
 *      `intelligence-run-reconciler.ts` looked for `status = 'RUNNING'`. Every
 *      claim in the system goes through `markRunProcessing`, which writes
 *      `PROCESSING`. So the expired-lease branch could never match a row: a
 *      worker that died mid-run left its run claimed forever, and no
 *      reconciler tick would ever release it. The file's own comment calls
 *      that the worse of the two stranding modes. The health snapshot read the
 *      same non-existent status and therefore always reported zero in-flight
 *      runs while runs were in flight.
 *
 *   B. THE CLAIM WAS NOT EXCLUSIVE.
 *      `markRunProcessing` accepted `status IN ('PENDING','PROCESSING','FAILED')`
 *      with no lease condition. A second worker handed the same job could take
 *      a run another worker was actively processing; both would then call the
 *      AI provider and both would charge the workspace. `attempt_count <
 *      MAX_RETRIES` bounded how often that could happen — it did not stop it.
 *
 *   C. TERMINAL WRITES HAD NO CLAIM-HOLDER PREDICATE.
 *      `markRunCompleted` and `markRunFailed` updated on `(id, team_id)`
 *      alone, so a superseded worker's late outcome could overwrite the truth,
 *      and a replayed delivery could re-complete a completed run.
 *
 * Every case below drives the REAL tracker and the REAL reconciler against a
 * live PostgreSQL 16. Nothing about the claim, the lease or the tenancy is
 * stubbed — those are the things under test.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";
import { provenCase, recordSuiteProof } from "./family-coverage-manifest.js";

describe("POINT 5 — intelligence run claim (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let tracker: typeof import("@proovra/shared-runtime/media-intelligence");
  let reconciler: typeof import("../../../worker/src/intelligence-run-reconciler.js");
  let teamA: string;
  let teamB: string;
  let evidenceA: string;
  let evidenceB: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    tracker = await import("@proovra/shared-runtime/media-intelligence");
    reconciler = await import(
      "../../../worker/src/intelligence-run-reconciler.js"
    );

    teamA = harness.fixtures.teamA.teamId;
    teamB = harness.fixtures.teamB.teamId;
    evidenceA = harness.fixtures.teamA.evidenceId;
    evidenceB = harness.fixtures.teamB.evidenceId;
  });

  afterAll(async () => {
    // PHASE 12 POINT 5 — this suite is the executed proof for
    // `IntelligenceRunStrandedReconciler`. It already drove the real tracker
    // and the real reconciler against live PostgreSQL; what it did not do was
    // RECORD that, so the proof gate could not see twenty executed cases and
    // the unit read as unproven. It records now.
    await recordSuiteProof(import.meta.url);
    await harness?.cleanup();
  });

  // =========================================================================
  // Fixtures
  // =========================================================================

  async function clearRuns(): Promise<void> {
    await prisma.mediaIntelligenceRun.deleteMany({
      where: { teamId: { in: [teamA, teamB] } },
    });
  }

  /** One durable run row, in whatever state a case needs. */
  async function seedRun(input: {
    teamId?: string;
    evidenceId?: string;
    status?: string;
    startedAtUtc?: Date | null;
    attemptCount?: number;
    updatedAtUtc?: Date;
  }): Promise<string> {
    const row = await prisma.mediaIntelligenceRun.create({
      data: {
        teamId: input.teamId ?? teamA,
        evidenceId: input.evidenceId ?? evidenceA,
        kind: "extract_exif",
        status: input.status ?? "PENDING",
        startedAtUtc: input.startedAtUtc ?? null,
        attemptCount: input.attemptCount ?? 0,
        ...(input.updatedAtUtc ? { updatedAtUtc: input.updatedAtUtc } : {}),
      },
      select: { id: true },
    });
    return row.id;
  }

  async function readRun(id: string) {
    return prisma.mediaIntelligenceRun.findUnique({ where: { id } });
  }

  // =========================================================================
  // B — the claim is exclusive
  // =========================================================================

  it("B1: four workers racing one PENDING run produce exactly one claim", async () => {
    await clearRuns();
    const runId = await seedRun({});

    const results = await Promise.all([
      tracker.markRunProcessing(runId, teamA, prisma as never),
      tracker.markRunProcessing(runId, teamA, prisma as never),
      tracker.markRunProcessing(runId, teamA, prisma as never),
      tracker.markRunProcessing(runId, teamA, prisma as never),
    ]);

    const winners = results.filter((r) => r.ok);
    expect(
      winners,
      "a claim that lets two workers in charges the workspace twice for one extraction",
    ).toHaveLength(1);

    const row = await readRun(runId);
    expect(row!.status).toBe("PROCESSING");
    // One claim, one attempt. The counter is the evidence: under the old
    // predicate all four updates matched and it read 4.
    expect(row!.attemptCount).toBe(1);
  });

  it("B2: a live claim is not stolen by a later worker", async () => {
    await clearRuns();
    const runId = await seedRun({});
    const first = await tracker.markRunProcessing(runId, teamA, prisma as never);
    expect(first.ok).toBe(true);
    const claimed = await readRun(runId);

    const second = await tracker.markRunProcessing(runId, teamA, prisma as never);

    expect(second.ok).toBe(false);
    const after = await readRun(runId);
    expect(after!.attemptCount).toBe(claimed!.attemptCount);
    expect(after!.startedAtUtc?.toISOString()).toBe(
      claimed!.startedAtUtc?.toISOString(),
    );
    provenCase("mirecon.claim.active_not_stolen");
  });

  it("B3: an expired claim IS recoverable — by exactly one worker", async () => {
    await clearRuns();
    const runId = await seedRun({
      status: "PROCESSING",
      startedAtUtc: new Date(
        Date.now() - tracker.MEDIA_INTELLIGENCE_RUN_LEASE_MS - 60_000,
      ),
      attemptCount: 1,
    });

    const results = await Promise.all([
      tracker.markRunProcessing(runId, teamA, prisma as never),
      tracker.markRunProcessing(runId, teamA, prisma as never),
      tracker.markRunProcessing(runId, teamA, prisma as never),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const row = await readRun(runId);
    expect(row!.attemptCount).toBe(2);
  });

  it("B4: a claim with no start stamp cannot be held forever", async () => {
    // A degenerate row nobody can be holding — treating it as live would be
    // the same wedge in a different disguise.
    await clearRuns();
    const runId = await seedRun({ status: "PROCESSING", startedAtUtc: null });
    const claimed = await tracker.markRunProcessing(runId, teamA, prisma as never);
    expect(claimed.ok).toBe(true);
    expect((await readRun(runId))!.startedAtUtc).not.toBeNull();
  });

  it("B5: the workspace comes from the row, and a foreign claim matches nothing", async () => {
    await clearRuns();
    const runId = await seedRun({ teamId: teamA });

    const wrongTenant = await tracker.markRunProcessing(
      runId,
      teamB,
      prisma as never,
    );

    expect(wrongTenant.ok).toBe(false);
    const row = await readRun(runId);
    expect(row!.status).toBe("PENDING");
    expect(row!.teamId).toBe(teamA);
    expect(row!.attemptCount).toBe(0);
  });

  it("B6: the attempt ceiling still holds", async () => {
    await clearRuns();
    const runId = await seedRun({ attemptCount: 5 });
    const result = await tracker.markRunProcessing(runId, teamA, prisma as never);
    expect(result).toEqual({ ok: false, reason: "max_retries_exceeded" });
  });

  // =========================================================================
  // C — only the claim holder writes a terminal state
  // =========================================================================

  it("C1: a completed run is not re-completed by a replayed delivery", async () => {
    await clearRuns();
    const runId = await seedRun({});
    await tracker.markRunProcessing(runId, teamA, prisma as never);
    const first = await tracker.markRunCompleted(runId, teamA, prisma as never);
    expect(first.ok).toBe(true);
    const settled = await readRun(runId);

    const replay = await tracker.markRunCompleted(runId, teamA, prisma as never);

    expect(replay.ok).toBe(false);
    const after = await readRun(runId);
    expect(after!.completedAtUtc?.toISOString()).toBe(
      settled!.completedAtUtc?.toISOString(),
    );
  });

  it("C2: a superseded worker cannot fail a run its replacement completed", async () => {
    await clearRuns();
    const runId = await seedRun({});
    await tracker.markRunProcessing(runId, teamA, prisma as never);
    await tracker.markRunCompleted(runId, teamA, prisma as never);

    // The worker whose lease expired finally returns, with a failure.
    const late = await tracker.markRunFailed(
      runId,
      teamA,
      "late_worker_error",
      prisma as never,
    );

    expect(late.ok).toBe(false);
    const after = await readRun(runId);
    expect(after!.status).toBe("COMPLETED");
    expect(after!.lastError).toBeNull();
  });

  it("C3: a superseded worker cannot complete a run its replacement failed", async () => {
    await clearRuns();
    const runId = await seedRun({});
    await tracker.markRunProcessing(runId, teamA, prisma as never);
    await tracker.markRunFailed(runId, teamA, "real_failure", prisma as never);

    const late = await tracker.markRunCompleted(runId, teamA, prisma as never);

    expect(late.ok).toBe(false);
    const after = await readRun(runId);
    expect(after!.status).toBe("FAILED");
  });

  it("C4: a terminal write from another workspace matches nothing", async () => {
    await clearRuns();
    const runId = await seedRun({ teamId: teamA });
    await tracker.markRunProcessing(runId, teamA, prisma as never);

    const foreign = await tracker.markRunCompleted(runId, teamB, prisma as never);

    expect(foreign.ok).toBe(false);
    expect((await readRun(runId))!.status).toBe("PROCESSING");
  });

  it("C5: the error summary is bounded and carries no URL or stack", async () => {
    await clearRuns();
    const runId = await seedRun({});
    await tracker.markRunProcessing(runId, teamA, prisma as never);
    await tracker.markRunFailed(
      runId,
      teamA,
      `boom https://evidence-bucket.s3.amazonaws.com/secret-key?sig=abc\n  at frame (/srv/app/x.js:1:1)\n${"x".repeat(400)}`,
      prisma as never,
    );
    const row = await readRun(runId);
    expect(row!.lastError).not.toContain("https://");
    expect(row!.lastError).not.toContain("amazonaws");
    expect(row!.lastError!.length).toBeLessThanOrEqual(240);
  });

  // =========================================================================
  // A — the reconciler recovers the state the claim actually writes
  // =========================================================================

  it("A1: a run abandoned mid-flight is released back to PENDING", async () => {
    await clearRuns();
    const runId = await seedRun({});
    await tracker.markRunProcessing(runId, teamA, prisma as never);
    // The worker dies. Age its claim past the lease.
    await prisma.mediaIntelligenceRun.update({
      where: { id: runId },
      data: {
        startedAtUtc: new Date(
          Date.now() - tracker.MEDIA_INTELLIGENCE_RUN_LEASE_MS - 60_000,
        ),
      },
    });

    const result = await reconciler.runIntelligenceRunReconciler({
      trigger: "point5",
    });

    expect(
      result.expiredLeasesReleased,
      "the reconciler used to select a status nothing writes, so this was always 0",
    ).toBeGreaterThanOrEqual(1);
    const row = await readRun(runId);
    expect(row!.status).toBe("PENDING");
    expect(row!.startedAtUtc).toBeNull();
    expect(row!.lastError).toBe("lease_expired_recovered");
    provenCase("mirecon.recovers_stranded_once");
  });

  it("A0: the reconciler never invents a run row it did not find", async () => {
    // The reconciler's subject must PRE-EXIST. One that can create its own
    // work has nothing to reconcile against and nothing to be bounded by.
    await clearRuns();
    const before = await prisma.mediaIntelligenceRun.count({
      where: { teamId: { in: [teamA, teamB] } },
    });
    expect(before).toBe(0);

    const result = await reconciler.runIntelligenceRunReconciler({
      trigger: "point5",
    });

    expect(result.expiredLeasesReleased).toBe(0);
    expect(
      await prisma.mediaIntelligenceRun.count({
        where: { teamId: { in: [teamA, teamB] } },
      }),
    ).toBe(0);
    provenCase("mirecon.durable.intent_before_work");
  });

  it("A2: a LIVE claim is left alone by the reconciler", async () => {
    await clearRuns();
    const runId = await seedRun({});
    await tracker.markRunProcessing(runId, teamA, prisma as never);
    const claimed = await readRun(runId);

    await reconciler.runIntelligenceRunReconciler({ trigger: "point5" });

    const after = await readRun(runId);
    expect(after!.status).toBe("PROCESSING");
    expect(after!.startedAtUtc?.toISOString()).toBe(
      claimed!.startedAtUtc?.toISOString(),
    );
  });

  it("A3: two overlapping reconciler ticks release one stale claim once", async () => {
    await clearRuns();
    const runId = await seedRun({});
    await tracker.markRunProcessing(runId, teamA, prisma as never);
    await prisma.mediaIntelligenceRun.update({
      where: { id: runId },
      data: {
        startedAtUtc: new Date(
          Date.now() - tracker.MEDIA_INTELLIGENCE_RUN_LEASE_MS - 60_000,
        ),
      },
    });

    const [a, b, c] = await Promise.all([
      reconciler.runIntelligenceRunReconciler({ trigger: "a" }),
      reconciler.runIntelligenceRunReconciler({ trigger: "b" }),
      reconciler.runIntelligenceRunReconciler({ trigger: "c" }),
    ]);

    const released =
      a.expiredLeasesReleased + b.expiredLeasesReleased + c.expiredLeasesReleased;
    expect(released).toBe(1);
    expect((await readRun(runId))!.status).toBe("PENDING");
    provenCase(
      "mirecon.claim.one_winner",
      "mirecon.idempotency.duplicate_is_noop",
    );
  });

  it("A4: a terminal run is never reopened, however old its stamps", async () => {
    for (const terminal of ["COMPLETED", "FAILED", "DISMISSED"]) {
      await clearRuns();
      const runId = await seedRun({
        status: terminal,
        startedAtUtc: new Date(Date.now() - 24 * 60 * 60 * 1000),
        updatedAtUtc: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });

      await reconciler.runIntelligenceRunReconciler({ trigger: "point5" });

      expect((await readRun(runId))!.status, `${terminal} was reopened`).toBe(
        terminal,
      );
    }
    provenCase("mirecon.terminal.stale_cannot_overwrite");
  });

  it("A5: a run recovered too many times is abandoned to an operator, not re-run forever", async () => {
    await clearRuns();
    const runId = await seedRun({
      status: "PROCESSING",
      attemptCount: 5,
      startedAtUtc: new Date(
        Date.now() - tracker.MEDIA_INTELLIGENCE_RUN_LEASE_MS - 60_000,
      ),
    });

    const result = await reconciler.runIntelligenceRunReconciler({
      trigger: "point5",
    });

    expect(result.abandonedForOperator).toBeGreaterThanOrEqual(1);
    const row = await readRun(runId);
    expect(row!.status).toBe("FAILED");
    expect(row!.lastError).toBe("recovery_attempts_exhausted");
    provenCase("mirecon.abandons_after_ceiling");
  });

  it("A6: the reconciler never writes a success", async () => {
    // The guarantee that separates a reconciler from a second terminal writer.
    // A reconciler that can mark a run COMPLETED can fabricate an extraction
    // that never ran.
    await clearRuns();
    const stale = await seedRun({
      status: "PROCESSING",
      startedAtUtc: new Date(
        Date.now() - tracker.MEDIA_INTELLIGENCE_RUN_LEASE_MS - 60_000,
      ),
    });
    const stranded = await seedRun({
      status: "PENDING",
      updatedAtUtc: new Date(Date.now() - 60 * 60 * 1000),
    });

    await reconciler.runIntelligenceRunReconciler({ trigger: "point5" });

    const completed = await prisma.mediaIntelligenceRun.count({
      where: { id: { in: [stale, stranded] }, status: "COMPLETED" },
    });
    expect(completed).toBe(0);
    provenCase("mirecon.never_writes_success");
  });

  it("A7: the health snapshot reports in-flight runs that actually exist", async () => {
    await clearRuns();
    const runId = await seedRun({});
    await tracker.markRunProcessing(runId, teamA, prisma as never);

    const snapshot = await reconciler.getIntelligenceRunHealthSnapshot();

    // Read the same status the claim writes. This counter was permanently 0.
    expect(snapshot.runningCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.expiredLeaseCount).toBe(0);

    await prisma.mediaIntelligenceRun.update({
      where: { id: runId },
      data: {
        startedAtUtc: new Date(
          Date.now() - tracker.MEDIA_INTELLIGENCE_RUN_LEASE_MS - 60_000,
        ),
      },
    });
    const stale = await reconciler.getIntelligenceRunHealthSnapshot();
    expect(stale.expiredLeaseCount).toBeGreaterThanOrEqual(1);
  });

  it("A8: recovery is scoped by the row's own workspace, never widened", async () => {
    await clearRuns();
    const mine = await seedRun({ teamId: teamA, evidenceId: evidenceA });
    const theirs = await seedRun({ teamId: teamB, evidenceId: evidenceB });
    for (const id of [mine, theirs]) {
      await prisma.mediaIntelligenceRun.update({
        where: { id },
        data: {
          status: "PROCESSING",
          startedAtUtc: new Date(
            Date.now() - tracker.MEDIA_INTELLIGENCE_RUN_LEASE_MS - 60_000,
          ),
        },
      });
    }

    await reconciler.runIntelligenceRunReconciler({ trigger: "point5" });

    // Both recover — the reconciler is workspace-agnostic BY DESIGN and each
    // row carries its own tenant. What must hold is that neither row's tenant
    // was rewritten and neither was attributed to the other.
    const rowMine = await readRun(mine);
    const rowTheirs = await readRun(theirs);
    expect(rowMine!.teamId).toBe(teamA);
    expect(rowTheirs!.teamId).toBe(teamB);
    expect(rowMine!.evidenceId).toBe(evidenceA);
    expect(rowTheirs!.evidenceId).toBe(evidenceB);
    provenCase(
      "mirecon.tenant.workspace_reloaded",
      "mirecon.tenant.cross_workspace_denied",
    );
  });

  it("A9: reconciler diagnostics carry counts, never evidence or tenant identifiers", async () => {
    await clearRuns();
    const runId = await seedRun({});
    await tracker.markRunProcessing(runId, teamA, prisma as never);

    const result = await reconciler.runIntelligenceRunReconciler({
      trigger: "point5",
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(teamA);
    expect(serialized).not.toContain(evidenceA);
    expect(serialized).not.toContain(runId);
  });
});
