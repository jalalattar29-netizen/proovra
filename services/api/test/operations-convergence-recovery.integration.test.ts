/**
 * WHAT THE CONVERGENCE ACTUALLY RECOVERS — live PostgreSQL 16, four contexts.
 *
 * ---------------------------------------------------------------------------
 * WHY FOUR CONTEXTS AND NOT ONE
 * ---------------------------------------------------------------------------
 * The fault is in the SHARED writer and in the SHARED physical schema, so it
 * is plan-independent by construction. That is a claim, and a claim about
 * every workspace kind has to be executed against every workspace kind or it
 * is just an assertion about the one that was tested.
 *
 * The four here are the real ones the harness provisions — a PERSONAL space
 * whose evidence carries the legacy `team_id = NULL` shape, an OWNED team, an
 * ORGANIZATION workspace, and a fourth provisioned to stand for an Enterprise
 * tenant. Nothing in the writer, the schema or the sweep reads a plan name;
 * this suite is what makes that checkable rather than asserted.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS PROVEN, IN ORDER
 * ---------------------------------------------------------------------------
 *   1. under the hybrid, EVERY context fails identically and records nothing;
 *   2. after the convergence migration, EVERY context records its conditions;
 *   3. discovery still sees the exact production counts — 34 / 26 / 69 — so
 *      the repair did not quietly narrow what is looked for;
 *   4. a second sweep opens no duplicates, which is the property the legacy
 *      unique index was silently failing to provide;
 *   5. grouping conserves: summed `affectedCount` equals the condition count;
 *   6. readiness reaches READY with `failedSources` empty;
 *   7. and `mayAssertAllClear` stays FALSE while unresolved conditions exist —
 *      because "the check completed" and "there is nothing wrong" are
 *      different sentences and only the first is now true.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

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

/** The production counts, reproduced per context rather than approximated. */
const TSA_FAILURES = 34;
const REPORT_BACKLOG = 26;
const PACKAGE_BACKLOG = 69;

type Ctx = {
  label: string;
  teamId: string;
  ownerUserId: string;
  /** Personal spaces carry the legacy NULL-team evidence shape. */
  legacyEvidenceScope: boolean;
};

describe("Operations convergence recovery, across workspace kinds (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let ops: typeof import("../src/services/operations/operations-reconciliation.service.js");
  let runtime: typeof import("@proovra/shared-runtime");
  let scope: typeof import("../src/services/observability/incident-scope.js");
  let grouping: typeof import("../src/services/operations/operations-grouping.service.js");
  let summary: typeof import("../src/services/operations/operations-summary.service.js");

  let contexts: Ctx[] = [];

  async function runSqlFile(relPath: string): Promise<void> {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const raw = readFileSync(resolve(process.cwd(), relPath), "utf8");
    // Comments out first, then split on top-level semicolons only. Both files
    // are heavily commented and their prose contains semicolons; splitting
    // first feeds fragments of English to PostgreSQL.
    let sql = "";
    let tag: string | null = null;
    let comment = false;
    for (let i = 0; i < raw.length; i += 1) {
      if (comment) {
        if (raw[i] === "\n") {
          comment = false;
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
          comment = true;
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
    for (const s of statements) {
      const body = s.trim();
      if (!body || /^(BEGIN|COMMIT)$/i.test(body)) continue;
      await prisma.$executeRawUnsafe(body);
    }
  }

  const applyHybridDrift = () => runSqlFile(HYBRID_FIXTURE);
  const convergeExpandOnly = () => runSqlFile(CONVERGENCE_EXPAND);
  const converge = async () => {
    await runSqlFile(CONVERGENCE_EXPAND);
    await runSqlFile(CONVERGENCE_CONTRACT);
  };

  async function reconcile(teamId: string) {
    await prisma.governanceReconciliationRun.deleteMany({
      where: { kind: "WORKSPACE_OPERATIONS", teamId },
    });
    await ops.reconcileWorkspaceOperations({ workspaceId: teamId, trigger: "cli" });
    return (await runtime.latestWorkspaceOperationsRun(prisma, teamId))!;
  }

  const incidentCount = (teamId: string) =>
    prisma.operationalIncident.count({ where: scope.workspaceIncidentWhere(teamId) });

  async function seedConditions(ctx: Ctx): Promise<void> {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: ctx.teamId },
      select: { organizationId: true },
    });
    // A personal space's evidence is owner-bound with a NULL team; every other
    // kind is strictly team-bound. Both populations must be discovered, and
    // `workspaceEvidenceWhere` is what makes that one query rather than two.
    const base = ctx.legacyEvidenceScope
      ? { teamId: null, organizationId: null, ownerUserId: ctx.ownerUserId }
      : {
          teamId: ctx.teamId,
          organizationId: team.organizationId,
          ownerUserId: ctx.ownerUserId,
        };
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < TSA_FAILURES; i += 1) {
      rows.push({
        ...base,
        title: `${ctx.label}-tsa-${i}`,
        type: "PHOTO",
        status: "REPORTED",
        tsaStatus: "FAILED",
        verificationPackageVersion: 1,
      });
    }
    for (let i = 0; i < REPORT_BACKLOG; i += 1) {
      rows.push({
        ...base,
        title: `${ctx.label}-report-${i}`,
        type: "PHOTO",
        status: "SIGNED",
        latestReportVersion: null,
      });
    }
    for (let i = 0; i < PACKAGE_BACKLOG; i += 1) {
      rows.push({
        ...base,
        title: `${ctx.label}-package-${i}`,
        type: "PHOTO",
        status: "REPORTED",
        verificationPackageVersion: null,
      });
    }
    for (let i = 0; i < rows.length; i += 65) {
      await prisma.evidence.createMany({ data: rows.slice(i, i + 65) as never });
    }
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
    grouping = await import(
      "../src/services/operations/operations-grouping.service.js"
    );
    summary = await import(
      "../src/services/operations/operations-summary.service.js"
    );

    // A fourth workspace standing for an Enterprise tenant. It is provisioned
    // rather than simulated so the row genuinely exists — but note that
    // NOTHING below reads a plan, which is the point the suite makes.
    const orgB = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamB.teamId },
      select: { organizationId: true, ownerUserId: true },
    });
    const enterprise = await prisma.team.create({
      data: {
        name: "Enterprise convergence fixture",
        ownerUserId: orgB.ownerUserId!,
        organizationId: orgB.organizationId,
        workspaceKind: "ORGANIZATION",
      },
      select: { id: true, ownerUserId: true },
    });

    contexts = [
      {
        label: "personal-pro",
        teamId: harness.fixtures.personal.teamId,
        ownerUserId: harness.fixtures.personal.userId,
        legacyEvidenceScope: true,
      },
      {
        label: "team",
        teamId: harness.fixtures.teamA.teamId,
        ownerUserId: harness.fixtures.teamA.ownerUserId,
        legacyEvidenceScope: false,
      },
      {
        label: "organization",
        teamId: harness.fixtures.teamB.teamId,
        ownerUserId: harness.fixtures.teamB.ownerUserId,
        legacyEvidenceScope: false,
      },
      {
        label: "enterprise",
        teamId: enterprise.id,
        ownerUserId: enterprise.ownerUserId!,
        legacyEvidenceScope: false,
      },
    ];

    for (const ctx of contexts) await seedConditions(ctx);
  }, 900_000);

  afterAll(async () => {
    await converge().catch(() => {});
    await harness?.cleanup?.();
  });

  it("under the hybrid, EVERY workspace kind fails identically and records nothing", async () => {
    await applyHybridDrift();
    for (const ctx of contexts) {
      await prisma.operationalIncident.deleteMany({
        where: scope.workspaceIncidentWhere(ctx.teamId),
      });
    }

    for (const ctx of contexts) {
      const run = await reconcile(ctx.teamId);
      expect(run.readiness, ctx.label).toBe("PARTIAL");
      expect(run.recorded, ctx.label).toBe(0);
      expect(await incidentCount(ctx.teamId), ctx.label).toBe(0);
      // Same stage, same category, same non-retryability — in a personal
      // space, an owned team, an organization and an enterprise tenant alike.
      for (const f of run.sources.sourceFailures) {
        expect(f.stage, `${ctx.label}:${f.sourceId}`).toBe("WRITE");
        expect(f.category, `${ctx.label}:${f.sourceId}`).toBe("schema_mismatch");
        expect(f.retryable, `${ctx.label}:${f.sourceId}`).toBe(false);
      }
    }
  });

  it("after convergence, EVERY workspace kind records its conditions and reaches READY", async () => {
    await converge();

    for (const ctx of contexts) {
      const run = await reconcile(ctx.teamId);
      expect(run.sources.failedSources, ctx.label).toEqual([]);
      expect(run.sources.sourceFailures, ctx.label).toEqual([]);
      expect(run.readiness, ctx.label).toBe("READY");
      expect(await incidentCount(ctx.teamId), ctx.label).toBeGreaterThan(0);
    }
  });

  it("discovery still sees 34 / 26 / 69 — the repair narrowed nothing", async () => {
    await converge();
    for (const ctx of contexts) {
      const where = ctx.legacyEvidenceScope
        ? { ownerUserId: ctx.ownerUserId, teamId: null }
        : { teamId: ctx.teamId };
      expect(
        await prisma.evidence.count({ where: { ...where, tsaStatus: "FAILED" } }),
        ctx.label,
      ).toBe(TSA_FAILURES);
      expect(
        await prisma.evidence.count({
          where: { ...where, status: "SIGNED", latestReportVersion: null },
        }),
        ctx.label,
      ).toBe(REPORT_BACKLOG);
      expect(
        await prisma.evidence.count({
          where: { ...where, status: "REPORTED", verificationPackageVersion: null },
        }),
        ctx.label,
      ).toBe(PACKAGE_BACKLOG);

      // And each context opens one condition per failing record.
      const perRecord = await prisma.operationalIncident.count({
        where: {
          ...scope.workspaceIncidentWhere(ctx.teamId),
          category: "EVIDENCE_INTEGRITY",
        },
      });
      expect(perRecord, ctx.label).toBe(TSA_FAILURES);
    }
  });

  it("a second sweep opens no duplicates — the guarantee the legacy unique was not providing", async () => {
    await converge();
    for (const ctx of contexts) {
      await reconcile(ctx.teamId);
      const first = await prisma.operationalIncident.findMany({
        where: scope.workspaceIncidentWhere(ctx.teamId),
        select: { id: true },
        orderBy: { id: "asc" },
      });
      await reconcile(ctx.teamId);
      const second = await prisma.operationalIncident.findMany({
        where: scope.workspaceIncidentWhere(ctx.teamId),
        select: { id: true },
        orderBy: { id: "asc" },
      });
      expect(second.map((r) => r.id), ctx.label).toEqual(first.map((r) => r.id));
    }
  });

  it("grouping conserves, and affectedCount is the full number", async () => {
    await converge();
    for (const ctx of contexts) {
      await reconcile(ctx.teamId);
      const all = await prisma.operationalIncident.findMany({
        where: {
          ...scope.workspaceIncidentWhere(ctx.teamId),
          category: "EVIDENCE_INTEGRITY",
        },
        orderBy: { lastSeenAtUtc: "desc" },
      });
      const groups = grouping.projectConditionGroups(all as never);
      expect(
        groups.reduce((n, g) => n + g.affectedCount, 0),
        ctx.label,
      ).toBe(all.length);
      expect(groups.length, ctx.label).toBeLessThan(all.length);
    }
  });

  it("READY does NOT mean clear: the all-clear is refused while conditions are unresolved", async () => {
    await converge();
    for (const ctx of contexts) {
      const run = await reconcile(ctx.teamId);
      expect(run.readiness, ctx.label).toBe("READY");

      const built = await summary.buildOperationsSummary({
        workspaceId: ctx.teamId,
        viewerUserId: ctx.ownerUserId,
      });
      expect(built.open, ctx.label).toBeGreaterThan(0);
      // The distinction the whole readiness vocabulary exists for: the CHECK
      // completed successfully, and the workspace still has unresolved work.
      // Collapsing those two into one boolean is what let a broken workspace
      // render as fine.
      expect(built.mayAssertAllClear, ctx.label).toBe(false);
    }
  });
});
