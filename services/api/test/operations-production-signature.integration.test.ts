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
 *   1. BROKEN    apply the production-hybrid schema -> the exact signature
 *                returns, with the exact code and stage;
 *   2. FIXED     run the convergence migration -> every eligible source
 *                succeeds and the conditions are recorded;
 *   3. RE-BROKEN re-apply the hybrid -> the failure comes back;
 *   4. RE-FIXED  converge again -> success comes back.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE BROKEN STATE IS, AND WHY IT IS NOT A DROPPED COLUMN
 * ---------------------------------------------------------------------------
 * An earlier version of this suite produced the broken state by DROPPING a
 * column the model declares. That reproduced a signature but not THE
 * signature, and it pointed at the wrong mechanism.
 *
 * Production is missing nothing. Every column the deployed model declares is
 * present. What production additionally has is a LEGACY family of columns
 * named after the Prisma FIELD names — `"safeSummary"` beside `safe_summary`,
 * `"teamId"` beside `team_id` — left behind by a generation of the model whose
 * fields carried no `@map`. `20260620200000_reviewer_ops_naming_drift_repair`
 * documents that exact mechanism on other tables and explicitly defers the
 * cleanup ("a separate cleanup migration will drop them"), which for these
 * tables was never written.
 *
 * `safe_summary` is `VARCHAR(400) NOT NULL` with no default, so its legacy
 * twin carries the same. An INSERT naming only the canonical columns cannot
 * satisfy it, and the real writer fails:
 *
 *     Prisma      P2011   Null constraint violation
 *     PostgreSQL  23502   null value in column "safeSummary"
 *
 * at `create()` — with the LOOKUP HAVING SUCCEEDED, because the read is
 * perfectly satisfiable. That is why nothing upstream noticed, and it is why
 * the fixture reproduces the hybrid rather than an absence.
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

/**
 * The two SQL files that ARE the broken and fixed states.
 *
 * Read from disk rather than inlined, deliberately: the fixture is the shape
 * the convergence migration is tested against, and the migration is the one
 * that will actually run in production. A test that carried its own copy of
 * either would pass while the real artifact drifted.
 */
const HYBRID_FIXTURE = "test/fixtures/production-hybrid-incident-schema.sql";
/**
 * The convergence ships as TWO migrations, and the split is load-bearing.
 *
 * EXPAND removes nothing and is safe before the code deploys — it is what
 * unblocks the writer. CONTRACT drops the legacy columns and belongs after the
 * code, because `verify-migration-artifact.mjs` refuses a removal that claims
 * to be safe beforehand. Tests that ran only one of them would prove only half
 * the deployment.
 */
const CONVERGENCE_EXPAND =
  "prisma/migrations/20271224000000_operational_incident_naming_convergence/migration.sql";
const CONVERGENCE_CONTRACT =
  "prisma/migrations/20271225000000_operational_incident_legacy_column_drop/migration.sql";

describe("Operations production signature (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let ops: typeof import("../src/services/operations/operations-reconciliation.service.js");
  let runtime: typeof import("@proovra/shared-runtime");
  let scope: typeof import("../src/services/observability/incident-scope.js");

  let personal: { userId: string; teamId: string };

  /**
   * Run a whole SQL file the way `psql` would.
   *
   * Split on semicolons is not good enough here — both files contain `DO $$ …
   * $$` blocks whose bodies are full of semicolons — so dollar-quoted regions
   * are tracked and only top-level semicolons split. Confined to the
   * disposable container the harness owns; the harness refuses to read
   * `DATABASE_URL` at all.
   */
  async function runSqlFile(relPath: string): Promise<void> {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const raw = readFileSync(resolve(process.cwd(), relPath), "utf8");

    // COMMENTS COME OUT FIRST, and that ordering is the whole correction.
    // Both files are heavily commented and the prose contains apostrophes and
    // semicolons; splitting before stripping fed fragments of English to
    // PostgreSQL, which answered `42601 syntax error at or near "no"`. A `--`
    // is only a comment OUTSIDE a dollar-quoted body, so quoting is tracked
    // while stripping too.
    let sql = "";
    let tag: string | null = null;
    let inLineComment = false;
    for (let i = 0; i < raw.length; i += 1) {
      if (inLineComment) {
        if (raw[i] === "\n") {
          inLineComment = false;
          sql += "\n";
        }
        continue;
      }
      if (!tag) {
        const m = /^\$[A-Za-z_]*\$/.exec(raw.slice(i));
        if (m) {
          tag = m[0];
          sql += tag;
          i += tag.length - 1;
          continue;
        }
        if (raw.startsWith("--", i)) {
          inLineComment = true;
          i += 1;
          continue;
        }
      } else if (raw.startsWith(tag, i)) {
        sql += tag;
        i += tag.length - 1;
        tag = null;
        continue;
      }
      sql += raw[i];
    }

    // Now split on TOP-LEVEL semicolons only — a `DO $$ … $$` body is full of
    // them and must travel as one statement.
    const statements: string[] = [];
    let buf = "";
    tag = null;
    for (let i = 0; i < sql.length; i += 1) {
      if (!tag) {
        const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
        if (m) {
          tag = m[0];
          buf += tag;
          i += tag.length - 1;
          continue;
        }
        if (sql[i] === ";") {
          statements.push(buf);
          buf = "";
          continue;
        }
      } else if (sql.startsWith(tag, i)) {
        buf += tag;
        i += tag.length - 1;
        tag = null;
        continue;
      }
      buf += sql[i];
    }
    if (buf.trim()) statements.push(buf);

    for (const statement of statements) {
      const body = statement.trim();
      // The fixture wraps itself in BEGIN/COMMIT; each `$executeRawUnsafe` is
      // its own implicit transaction, so those are dropped rather than sent.
      if (!body || /^(BEGIN|COMMIT)$/i.test(body)) continue;
      await prisma.$executeRawUnsafe(body);
    }
  }

  /** Put the database into the exact production-hybrid shape. */
  async function applyHybridDrift(): Promise<void> {
    await runSqlFile(HYBRID_FIXTURE);
  }

  /** The EXPAND half alone: unblocks the writer, removes nothing. */
  async function convergeExpandOnly(): Promise<void> {
    await runSqlFile(CONVERGENCE_EXPAND);
  }

  /** Both halves, in deployment order. */
  async function converge(): Promise<void> {
    await runSqlFile(CONVERGENCE_EXPAND);
    await runSqlFile(CONVERGENCE_CONTRACT);
  }

  /** How many mixed-case (legacy) columns the two tables currently carry. */
  async function legacyColumnCount(): Promise<number> {
    const r = (await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name IN ('operational_incidents','operational_incident_events')
          AND column_name ~ '[A-Z]'`,
    )) as Array<{ n: number }>;
    return r[0].n;
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
    await converge().catch(() => {});
    await harness?.cleanup();
  });

  beforeEach(async () => {
    await converge();
    await prisma.operationalIncident.deleteMany({
      where: scope.workspaceIncidentWhere(personal.teamId),
    });
  });

  afterEach(async () => {
    await converge();
  });

  // =======================================================================
  // 1. The broken state reproduces the signature EXACTLY.
  // =======================================================================

  it("reproduces the exact six-failed / five-successful production signature", async () => {
    await applyHybridDrift();
    const { run } = await reconcile();

    expect(run.readiness).toBe("PARTIAL");
    expect([...run.sources.failedSources].sort()).toEqual(EXPECTED_FAILED);
    expect([...run.sources.successfulSources].sort()).toEqual(EXPECTED_SUCCEEDED);
    // Nothing truncated: the scan bound was never reached, so PARTIAL here
    // means "a source failed", not "a source read too much".
    expect(run.sources.truncatedSources).toEqual([]);
  });

  it("records ZERO conditions while discovery is finding them", async () => {
    await applyHybridDrift();
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
    await applyHybridDrift();
    const { run } = await reconcile();

    // The clear gate is asked the SAME question the summary asks it: even
    // with a perfectly complete incident read and zero unresolved rows — the
    // exact shape that reads as "nothing wrong here" — a run whose required
    // sources did not all succeed may not be described as clear.
    const verdict = runtime.mayAssertOperationsClear({
      run,
      incidentReadComplete: true,
      unresolvedCount: 0,
    });
    expect(verdict.clear).toBe(false);
    if (!verdict.clear) expect(verdict.reason).toBe("PARTIAL_SOURCES");
    expect(run.readiness).not.toBe("READY");
  });

  // =======================================================================
  // 2. The cause is PRESERVED — the defect that made this undiagnosable.
  // =======================================================================

  it("names WHY every failed source failed: stage WRITE, category schema_mismatch, non-retryable", async () => {
    await applyHybridDrift();
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
    await applyHybridDrift();
    const { run } = await reconcile();

    const projected = JSON.stringify(run);
    for (const forbidden of [
      "SELECT",
      "INSERT",
      "operational_incidents",
      // The legacy column that actually breaks the write. Its NAME must never
      // reach a client: it is a fact about the deployment's history, not
      // about this tenant.
      "safeSummary",
      "not-null",
      "violates",
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

  it("converging makes every eligible source succeed and records the conditions", async () => {
    await applyHybridDrift();
    const broken = await reconcile();
    expect([...broken.run.sources.failedSources].sort()).toEqual(EXPECTED_FAILED);
    expect(await incidentCount()).toBe(0);

    await converge();
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

  it("re-applying the hybrid brings the same failure back, and converging brings success back", async () => {
    // FIXED
    await converge();
    const first = await reconcile();
    expect(first.run.sources.failedSources).toEqual([]);
    const recordedWhenHealthy = await incidentCount();
    expect(recordedWhenHealthy).toBeGreaterThan(0);

    // RE-BROKEN, WITH THE CONDITIONS STILL ON RECORD.
    //
    // A refinement worth stating, because it is the difference between this
    // fault and a total outage: the hybrid blocks CREATE, not UPDATE. Once a
    // condition exists, `recordIncident` takes the update path, the legacy
    // NOT NULL column already holds a value, and the re-observation SUCCEEDS.
    //
    // So a workspace whose conditions were recorded BEFORE the drift keeps
    // ticking them over and looks perfectly healthy. Only a workspace with a
    // NEW condition — which is every workspace the moment anything goes wrong
    // — discovers that nothing can be recorded. That is exactly why this
    // survived unnoticed for as long as it did.
    await applyHybridDrift();
    const stillWorking = await reconcile();
    expect(stillWorking.run.sources.failedSources).toEqual([]);
    // Already-recorded conditions are NOT destroyed by the writer breaking.
    // History surviving a deployment fault is the property that makes the
    // record trustworthy at all.
    expect(await incidentCount()).toBe(recordedWhenHealthy);

    // Now clear them, which is the state the production workspace was in:
    // nothing had ever been recorded, so every source had to CREATE.
    await prisma.operationalIncident.deleteMany({
      where: scope.workspaceIncidentWhere(personal.teamId),
    });
    const second = await reconcile();
    expect([...second.run.sources.failedSources].sort()).toEqual(EXPECTED_FAILED);
    expect(second.run.readiness).toBe("PARTIAL");
    expect(await incidentCount()).toBe(0);

    // RE-FIXED
    await converge();
    const third = await reconcile();
    expect(third.run.sources.failedSources).toEqual([]);
    expect(third.run.readiness).toBe("READY");
  });

  it("is idempotent once healthy — a second sweep opens no duplicate conditions", async () => {
    await converge();
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

  it("the READ succeeds and the WRITE fails — which is why nothing upstream noticed", async () => {
    await applyHybridDrift();

    // THE MOST IMPORTANT ASSERTION IN THIS FILE.
    //
    // Nothing is missing, so the writer's lookup — narrow OR full-width — is
    // perfectly satisfiable. Every read-only surface in the product therefore
    // keeps working, `/readyz` answered ok, and the page rendered. The fault
    // is entirely on the INSERT.
    await expect(
      prisma.operationalIncident.findUnique({
        where: {
          teamId_fingerprint: {
            teamId: personal.teamId,
            fingerprint: `probe:${randomUUID()}`,
          },
        },
      }),
    ).resolves.toBeNull();

    await expect(
      prisma.operationalIncident.create({
        data: {
          teamId: personal.teamId,
          scope: "WORKSPACE",
          category: "REPORT",
          severity: "HIGH",
          status: "OPEN",
          fingerprint: `probe:${randomUUID()}`,
          title: "t",
          safeSummary: "s",
        },
      }),
      // P2011, not P2022. The model declares nothing the database lacks; the
      // database requires something the model does not declare.
    ).rejects.toMatchObject({ code: "P2011" });
  });

  it("the legacy UNIQUE deduplicates nothing, because it is not on the columns Prisma writes", async () => {
    await applyHybridDrift();

    // The unique index sits on ("teamId", fingerprint). Prisma writes team_id
    // and leaves "teamId" NULL, and PostgreSQL treats NULLs as DISTINCT — so
    // the constraint the writer's whole idempotency story rests on excludes
    // nothing at all. Asserted directly against the catalog, because a
    // behavioural test cannot reach it while every INSERT is failing 23502.
    const covered = (await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n
         FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
        WHERE t.relname = 'operational_incidents' AND i.indisunique
          AND (SELECT array_agg(a.attname ORDER BY a.attname)
                 FROM unnest(i.indkey) AS k(attnum)
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum)
              = ARRAY['fingerprint','team_id']::name[]`,
    )) as Array<{ n: number }>;
    expect(covered[0].n).toBe(0);

    await converge();
    const afterwards = (await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n
         FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
        WHERE t.relname = 'operational_incidents' AND i.indisunique
          AND (SELECT array_agg(a.attname ORDER BY a.attname)
                 FROM unnest(i.indkey) AS k(attnum)
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum)
              = ARRAY['fingerprint','team_id']::name[]`,
    )) as Array<{ n: number }>;
    expect(afterwards[0].n).toBe(1);
  });

  it("the writer schema contract refuses to report the image ready, on LEGACY columns rather than missing ones", async () => {
    const contract = await import(
      "../scripts/operations-writer-schema-contract.mjs"
    );
    const { Prisma } = await import("@prisma/client");
    const query = async (sql: string) =>
      (await prisma.$queryRawUnsafe(sql)) as Array<Record<string, unknown>>;

    await converge();
    const healthy = await contract.checkOperationsWriterContract(Prisma.dmmf, query);
    expect(healthy.ok).toBe(true);
    expect(healthy.missing).toEqual([]);
    expect(healthy.legacy).toEqual([]);
    expect(healthy.bindings).toEqual([]);

    await applyHybridDrift();
    const broken = await contract.checkOperationsWriterContract(Prisma.dmmf, query);
    expect(broken.ok).toBe(false);
    // NOTHING is missing. This is the whole correction: a contract that only
    // checked for absence would have passed here and let the image serve.
    expect(broken.missing).toEqual([]);
    const incidents = broken.legacy.find(
      (l: { table: string }) => l.table === "operational_incidents",
    )!;
    expect(incidents.columns).toContain("safeSummary");
    expect(incidents.columns).toContain("teamId");
    expect(incidents.criticality).toBe("MANDATORY");
    // And the dedupe binding is reported gone.
    expect(broken.bindings.map((b: { table: string }) => b.table)).toContain(
      "operational_incidents",
    );

    const described = contract.describeWriterContractFailure(broken);
    expect(described).toContain("operational_incidents");
    expect(described).toContain("LEGACY duplicate");
    expect(described).not.toContain("SELECT");
  });

  it("the EXPAND half ALONE unblocks the writer, with every legacy column still in place", async () => {
    await applyHybridDrift();
    const before = await legacyColumnCount();
    expect(before).toBeGreaterThan(0);

    await convergeExpandOnly();

    // NOTHING was removed. This is the property that makes the expand half
    // safe to apply before the code, and the reason the two halves are
    // separate migrations at all.
    expect(await legacyColumnCount()).toBe(before);

    // And the writer works, because what blocked it was the legacy NOT NULL,
    // not the legacy column. Production can be fixed without dropping
    // anything, in the same deploy that ships the code.
    await prisma.operationalIncident.deleteMany({
      where: scope.workspaceIncidentWhere(personal.teamId),
    });
    const { run } = await reconcile();
    expect(run.sources.failedSources).toEqual([]);
    expect(run.readiness).toBe("READY");
    expect(await incidentCount()).toBeGreaterThan(0);
  });

  it("the CONTRACT half refuses to drop while a legacy value has no canonical copy", async () => {
    await applyHybridDrift();
    // The expand half runs FIRST, exactly as it would in production — and the
    // orphan is created AFTER it. That is the case the two-wave split exists
    // to worry about: time passes between the waves, and a row written in
    // between is precisely what the contract half must not assume away.
    //
    // (It also has to be this order mechanically: while the hybrid's NOT NULL
    // is still in force, a row with a NULL canonical column cannot be
    // inserted at all.)
    await convergeExpandOnly();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "operational_incidents"
         (id, team_id, scope, category, severity, status, fingerprint, title,
          safe_summary, opened_by_system, updated_at, "runbookSlug")
       VALUES (gen_random_uuid(), $1::uuid, 'WORKSPACE', 'REPORT', 'HIGH', 'OPEN',
               'contract:orphan:probe', 't', 's', true, NOW(), 'legacy-only-value')`,
      personal.teamId,
    );

    await expect(runSqlFile(CONVERGENCE_CONTRACT)).rejects.toThrow(/REFUSING to drop/);

    // Nothing was dropped by the refusal.
    expect(await legacyColumnCount()).toBeGreaterThan(0);
  });

  it("converged, the legacy family is gone and stays gone across a re-run", async () => {
    await applyHybridDrift();
    expect(await legacyColumnCount()).toBeGreaterThan(0);

    await converge();
    expect(await legacyColumnCount()).toBe(0);

    // Idempotent: running the migration again on an already-converged database
    // is a no-op rather than an error, which is what makes it safe to include
    // in a deploy that may be retried.
    await converge();
    expect(await legacyColumnCount()).toBe(0);
  });
});
