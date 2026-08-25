/**
 * THE PRODUCTION SIGNATURE, REPRODUCED AND FALSIFIED — live PostgreSQL 16.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS BEING PINNED
 * ---------------------------------------------------------------------------
 * A Personal Pro workspace in production reported, from `/v1/ops/summary`:
 *
 *     readiness            PARTIAL
 *     recorded             0
 *     open                 0
 *     mayAssertAllClear    false
 *     clearRefusalReason   PARTIAL_SOURCES
 *
 *     FAILED    evidence_integrity.tsa_failed
 *               evidence_integrity.ots_failed
 *               evidence_integrity.ots_pending_aged
 *               pipeline.report_backlog
 *               pipeline.package_backlog
 *               platform.telemetry_stale
 *
 *     SUCCEEDED review.stale_workflows
 *               queue.retry_storm
 *               platform.worker_heartbeat_stale
 *               pipeline.signed_without_report_aged
 *               coordination.backlog_stale
 *
 * while a read-only production diagnostic proved discovery itself was healthy:
 * 34 TSA failures, 26 report backlog, 69 package backlog, 2 stale reviews, all
 * sixteen read checks succeeded, no timeout, no missing evidence column.
 *
 * The partition is exact and it is not about the domains. Every FAILED source
 * calls `recordIncident`. No SUCCEEDED source does. That is the entire
 * correlation, and it points at the shared writer rather than at discovery.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIXTURE IS SHAPED LIKE THIS
 * ---------------------------------------------------------------------------
 * The signature only appears when the right sources CROSS their thresholds and
 * the others do not, so the fixture reproduces the production-shaped
 * conditions rather than "some failing evidence":
 *
 *   * a PERSONAL workspace whose evidence carries the legacy `team_id = NULL`
 *     with an owner — the population a strict predicate cannot see;
 *   * 34 TSA failures, so the per-record integrity pass has work to WRITE;
 *   * a report backlog and a package backlog above their HIGH thresholds;
 *   * telemetry older than its staleness window;
 *   * stale reviews and coordination BELOW their thresholds, so those sources
 *     scan, find nothing, write nothing and succeed — which is what makes the
 *     six/five partition meaningful rather than accidental.
 *
 * ---------------------------------------------------------------------------
 * THE FALSIFICATION CYCLE
 * ---------------------------------------------------------------------------
 * A test that only shows the broken state reproduces a bug; it does not prove
 * a cause. Each case here runs the full cycle:
 *
 *   1. BROKEN    remove one column the deployed model declares -> the exact
 *                signature returns, with the exact code and stage;
 *   2. FIXED     restore it -> every eligible source succeeds and the
 *                conditions are recorded;
 *   3. RE-BROKEN remove it again -> the failure comes back;
 *   4. RE-FIXED  restore -> success comes back.
 *
 * `runbook_slug` is the column used, and the choice is not arbitrary: it is
 * declared ONLY inside `20260529100000_add_operational_incidents_phase21`'s
 * `CREATE TABLE IF NOT EXISTS`, which is the guard this repository has already
 * been burned by once (see the note in `20271219000000_incident_sla_history`).
 * No later migration re-adds it. It is also absent from the writer's new
 * explicit dedupe select, which is what lets these cases prove that the read's
 * WIDTH is the mechanism.
 */

import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

/** The six that write, and the five that do not. Exactly as production reported. */
const EXPECTED_FAILED = [
  "evidence_integrity.ots_failed",
  "evidence_integrity.ots_pending_aged",
  "evidence_integrity.tsa_failed",
  "pipeline.package_backlog",
  "pipeline.report_backlog",
  "platform.telemetry_stale",
];
const EXPECTED_SUCCEEDED = [
  "coordination.backlog_stale",
  "pipeline.signed_without_report_aged",
  "platform.worker_heartbeat_stale",
  "queue.retry_storm",
  "review.stale_workflows",
];

/** The production counts, reproduced rather than approximated. */
const TSA_FAILURES = 34;
const REPORT_BACKLOG = 26;
const PACKAGE_BACKLOG = 69;
const STALE_REVIEWS = 2;

const WRITER_COLUMN = "runbook_slug";
const WRITER_COLUMN_TYPE = "VARCHAR(64)";

describe("Operations production signature (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let ops: typeof import("../src/services/operations/operations-reconciliation.service.js");
  let runtime: typeof import("@proovra/shared-runtime");
  let scope: typeof import("../src/services/observability/incident-scope.js");

  let personal: { userId: string; teamId: string };

  /**
   * Remove / restore the writer column.
   *
   * Raw DDL, because the whole point is to produce a database that DISAGREES
   * with the Prisma model — which is a state no Prisma API can create. It is
   * confined to the disposable container the harness owns; the harness refuses
   * to read `DATABASE_URL` at all.
   */
  async function dropWriterColumn(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "operational_incidents" DROP COLUMN IF EXISTS "${WRITER_COLUMN}"`,
    );
  }
  async function restoreWriterColumn(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "operational_incidents" ADD COLUMN IF NOT EXISTS "${WRITER_COLUMN}" ${WRITER_COLUMN_TYPE}`,
    );
  }

  async function reconcile() {
    await prisma.governanceReconciliationRun.deleteMany({
      where: { kind: "WORKSPACE_OPERATIONS", teamId: personal.teamId },
    });
    const outcome = await ops.reconcileWorkspaceOperations({
      workspaceId: personal.teamId,
      trigger: "cli",
    });
    const run = await runtime.latestWorkspaceOperationsRun(prisma, personal.teamId);
    return { outcome, run: run! };
  }

  async function incidentCount(): Promise<number> {
    return prisma.operationalIncident.count({
      where: scope.workspaceIncidentWhere(personal.teamId),
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ops = await import(
      "../src/services/operations/operations-reconciliation.service.js"
    );
    runtime = await import("@proovra/shared-runtime");
    scope = await import("../src/services/observability/incident-scope.js");

    personal = {
      userId: harness.fixtures.personal.userId,
      teamId: harness.fixtures.personal.teamId,
    };

    // -----------------------------------------------------------------
    // The production-shaped population.
    //
    // `teamId: null` with an `ownerUserId` is the LEGACY personal shape —
    // exactly what `workspaceEvidenceWhere` widens to for a personal
    // workspace and what a strict `team_id` equality cannot see. Seeding the
    // strict shape instead would prove nothing about the workspace that
    // actually failed.
    // -----------------------------------------------------------------
    const rows: Array<Record<string, unknown>> = [];
    const base = {
      type: "PHOTO" as const,
      teamId: null,
      organizationId: null,
      ownerUserId: personal.userId,
    };
    for (let i = 0; i < TSA_FAILURES; i += 1) {
      rows.push({
        ...base,
        // REPORTED with a package already recorded, so these 34 rows are a
        // TSA population and NOTHING else: they must not also land in the
        // report backlog (status SIGNED with no report) or the package
        // backlog (REPORTED with no package), or the six/five partition would
        // be an artefact of the fixture rather than of the writer.
        title: `sig-tsa-${i}`,
        status: "REPORTED",
        tsaStatus: "FAILED",
        verificationPackageVersion: 1,
      });
    }
    for (let i = 0; i < REPORT_BACKLOG; i += 1) {
      rows.push({
        ...base,
        title: `sig-report-${i}`,
        status: "SIGNED",
        latestReportVersion: null,
      });
    }
    for (let i = 0; i < PACKAGE_BACKLOG; i += 1) {
      rows.push({
        ...base,
        title: `sig-package-${i}`,
        status: "REPORTED",
        verificationPackageVersion: null,
      });
    }
    await prisma.evidence.createMany({ data: rows as never });

    // Stale telemetry — one snapshot, well outside the staleness window.
    await prisma.queueTelemetrySnapshot.create({
      data: {
        teamId: personal.teamId,
        queueName: "evidence-processing",
        queueDomain: "REPORT",
        sampledAtUtc: new Date(Date.now() - 6 * 60 * 60 * 1000),
      } as never,
    });

    // Two stale reviews: production had exactly two, and the source's HIGH
    // threshold is five. It therefore SCANS, finds a real number, decides it
    // is below threshold, writes nothing and succeeds — which is precisely
    // the distinction the accounting exists to make.
    const reviewable = await prisma.evidence.findMany({
      where: { ownerUserId: personal.userId, teamId: null },
      select: { id: true },
      take: STALE_REVIEWS,
    });
    const old = new Date(Date.now() - 200 * 60 * 60 * 1000);
    for (const e of reviewable) {
      await prisma.evidenceReviewWorkflow.create({
        data: {
          evidenceId: e.id,
          workspaceType: "PERSONAL",
          status: "IN_REVIEW",
          updatedAt: old,
        } as never,
      });
    }
  }, 900_000);

  afterAll(async () => {
    // Never leave the shared container's schema broken for a later suite.
    await restoreWriterColumn().catch(() => {});
    await harness?.cleanup();
  });

  beforeEach(async () => {
    await restoreWriterColumn();
    await prisma.operationalIncident.deleteMany({
      where: scope.workspaceIncidentWhere(personal.teamId),
    });
  });

  afterEach(async () => {
    await restoreWriterColumn();
  });

  // =======================================================================
  // 1. The broken state reproduces the signature EXACTLY.
  // =======================================================================

  it("reproduces the exact six-failed / five-successful production signature", async () => {
    await dropWriterColumn();
    const { run } = await reconcile();

    expect(run.readiness).toBe("PARTIAL");
    expect([...run.sources.failedSources].sort()).toEqual(EXPECTED_FAILED);
    expect([...run.sources.successfulSources].sort()).toEqual(EXPECTED_SUCCEEDED);
    // Nothing truncated: the scan bound was never reached, so PARTIAL here
    // means "a source failed", not "a source read too much".
    expect(run.sources.truncatedSources).toEqual([]);
  });

  it("records ZERO conditions while discovery is finding them", async () => {
    await dropWriterColumn();
    const { run } = await reconcile();

    expect(run.recorded).toBe(0);
    expect(await incidentCount()).toBe(0);

    // The whole point: the workspace HAS conditions. Discovery can still see
    // every one of them — the failure is downstream of the looking.
    const tsa = await prisma.evidence.count({
      where: { ownerUserId: personal.userId, teamId: null, tsaStatus: "FAILED" },
    });
    expect(tsa).toBe(TSA_FAILURES);
    const reportBacklog = await prisma.evidence.count({
      where: {
        ownerUserId: personal.userId,
        teamId: null,
        status: "SIGNED",
        latestReportVersion: null,
      },
    });
    expect(reportBacklog).toBe(REPORT_BACKLOG);
    const packageBacklog = await prisma.evidence.count({
      where: {
        ownerUserId: personal.userId,
        teamId: null,
        status: "REPORTED",
        verificationPackageVersion: null,
      },
    });
    expect(packageBacklog).toBe(PACKAGE_BACKLOG);
  });

  it("refuses the all-clear and names the refusal", async () => {
    await dropWriterColumn();
    const { run } = await reconcile();

    const verdict = runtime.mayAssertOperationsClear
      ? runtime.mayAssertOperationsClear({ run, unresolvedCount: 0 })
      : null;
    if (verdict) {
      expect(verdict.clear).toBe(false);
      expect(verdict.reason).toBe("PARTIAL_SOURCES");
    }
    // Independent of the helper's exact name: a PARTIAL run may never be
    // described as clear, and that is the property that matters.
    expect(run.readiness).not.toBe("READY");
  });

  // =======================================================================
  // 2. The cause is PRESERVED — the defect that made this undiagnosable.
  // =======================================================================

  it("names WHY every failed source failed: stage WRITE, category schema_mismatch, non-retryable", async () => {
    await dropWriterColumn();
    const { run } = await reconcile();

    // Every failed id has a reason. A failed source with no recorded reason
    // is the exact state — six ids and no cause — that cost this incident a
    // hand-written production script to diagnose.
    expect(runtime.sourceFailuresWithoutReason(run.sources)).toEqual([]);

    expect([...run.sources.sourceFailures].map((f) => f.sourceId).sort()).toEqual(
      EXPECTED_FAILED,
    );
    for (const failure of run.sources.sourceFailures) {
      // WRITE, not SCAN: the conditions were SEEN. A workspace with observed,
      // unrecorded conditions is a strictly worse state than one that could
      // not look, and the two must not read the same.
      expect(failure.stage).toBe("WRITE");
      expect(failure.category).toBe("schema_mismatch");
      // Pressing "Check again" cannot fix a deployment disagreement, and the
      // server says so rather than letting the browser guess.
      expect(failure.retryable).toBe(false);
    }
  });

  it("leaks no SQL, no column name and no record content into the projected run", async () => {
    await dropWriterColumn();
    const { run } = await reconcile();

    const projected = JSON.stringify(run);
    for (const forbidden of [
      "SELECT",
      "INSERT",
      "operational_incidents",
      WRITER_COLUMN,
      "does not exist",
      "prisma.",
      personal.userId,
    ]) {
      expect(projected).not.toContain(forbidden);
    }
    // The bounded vocabulary IS present — the point is a safe reason, not no
    // reason at all.
    expect(projected).toContain("schema_mismatch");
  });

  // =======================================================================
  // 3. The falsification cycle: broken -> fixed -> broken -> fixed.
  // =======================================================================

  it("restoring the column makes every eligible source succeed and records the conditions", async () => {
    await dropWriterColumn();
    const broken = await reconcile();
    expect([...broken.run.sources.failedSources].sort()).toEqual(EXPECTED_FAILED);
    expect(await incidentCount()).toBe(0);

    await restoreWriterColumn();
    const fixed = await reconcile();

    expect(fixed.run.sources.failedSources).toEqual([]);
    expect(fixed.run.sources.sourceFailures).toEqual([]);
    expect([...fixed.run.sources.successfulSources].sort()).toEqual(
      [...EXPECTED_FAILED, ...EXPECTED_SUCCEEDED].sort(),
    );
    expect(fixed.run.readiness).toBe("READY");

    // 34 per-record integrity conditions + the two threshold conditions +
    // stale telemetry. Asserted as a floor rather than an exact number so an
    // added source does not fail this case for the wrong reason; the exact
    // per-record count is asserted immediately below.
    const total = await incidentCount();
    expect(total).toBeGreaterThanOrEqual(TSA_FAILURES + 3);

    const perRecord = await prisma.operationalIncident.count({
      where: {
        ...scope.workspaceIncidentWhere(personal.teamId),
        category: "EVIDENCE_INTEGRITY",
      },
    });
    expect(perRecord).toBe(TSA_FAILURES);
  });

  it("re-removing the column brings the same failure back, and restoring it brings success back", async () => {
    // FIXED
    await restoreWriterColumn();
    const first = await reconcile();
    expect(first.run.sources.failedSources).toEqual([]);
    const recordedWhenHealthy = await incidentCount();
    expect(recordedWhenHealthy).toBeGreaterThan(0);

    // RE-BROKEN — the same signature, from the same single cause.
    await dropWriterColumn();
    const second = await reconcile();
    expect([...second.run.sources.failedSources].sort()).toEqual(EXPECTED_FAILED);
    expect(second.run.readiness).toBe("PARTIAL");
    // Already-recorded conditions are NOT destroyed by the writer breaking.
    // History surviving a deployment fault is the property that makes the
    // record trustworthy at all.
    expect(await incidentCount()).toBe(recordedWhenHealthy);

    // RE-FIXED
    await restoreWriterColumn();
    const third = await reconcile();
    expect(third.run.sources.failedSources).toEqual([]);
    expect(third.run.readiness).toBe("READY");
  });

  it("is idempotent once healthy — a second sweep opens no duplicate conditions", async () => {
    await restoreWriterColumn();
    await reconcile();
    const firstPass = await prisma.operationalIncident.findMany({
      where: scope.workspaceIncidentWhere(personal.teamId),
      select: { id: true },
      orderBy: { id: "asc" },
    });
    await reconcile();
    const secondPass = await prisma.operationalIncident.findMany({
      where: scope.workspaceIncidentWhere(personal.teamId),
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(secondPass.map((r) => r.id)).toEqual(firstPass.map((r) => r.id));
  });

  // =======================================================================
  // 4. The mechanism, isolated.
  // =======================================================================

  it("the WIDTH of the read is the mechanism: the writer's narrow lookup survives what a full-width read does not", async () => {
    await dropWriterColumn();

    // The writer's dedupe lookup, as it is now written: explicit select of
    // only what the code reads. It does not name the absent column, so it
    // works.
    await expect(
      prisma.operationalIncident.findUnique({
        where: {
          teamId_fingerprint: {
            teamId: personal.teamId,
            fingerprint: `probe:${randomUUID()}`,
          },
        },
        select: { id: true, status: true, severity: true },
      }),
    ).resolves.toBeNull();

    // The same lookup with no `select` — the shape the writer used to issue —
    // asks for every column the model declares and fails on the absent one.
    await expect(
      prisma.operationalIncident.findUnique({
        where: {
          teamId_fingerprint: {
            teamId: personal.teamId,
            fingerprint: `probe:${randomUUID()}`,
          },
        },
      }),
    ).rejects.toMatchObject({ code: "P2022" });
  });

  it("the writer schema contract refuses to report the image ready", async () => {
    const contract = await import(
      "../scripts/operations-writer-schema-contract.mjs"
    );
    const { Prisma } = await import("@prisma/client");
    const query = async (sql: string) =>
      (await prisma.$queryRawUnsafe(sql)) as Array<{ missing_column: string }>;

    await restoreWriterColumn();
    const healthy = await contract.checkOperationsWriterContract(Prisma.dmmf, query);
    expect(healthy.ok).toBe(true);
    expect(healthy.missing).toEqual([]);

    await dropWriterColumn();
    const broken = await contract.checkOperationsWriterContract(Prisma.dmmf, query);
    expect(broken.ok).toBe(false);
    expect(broken.missing).toHaveLength(1);
    expect(broken.missing[0].table).toBe("operational_incidents");
    expect(broken.missing[0].columns).toEqual([WRITER_COLUMN]);
    expect(broken.missing[0].criticality).toBe("MANDATORY");

    // The operator-facing text names the table, the column and the stage —
    // and carries no driver message.
    const described = contract.describeWriterContractFailure(broken);
    expect(described).toContain("operational_incidents");
    expect(described).toContain(WRITER_COLUMN);
    expect(described).not.toContain("SELECT");
  });
});
