/**
 * OPERATIONS — source failures must survive as CAUSES, live PostgreSQL 16.
 *
 * ---------------------------------------------------------------------------
 * THE PRODUCTION FAILURE THIS SUITE PINS
 * ---------------------------------------------------------------------------
 * A Personal Pro workspace reported readiness PARTIAL, open 0 and recorded 0
 * while Home and Notifications both showed 34 TSA timestamp failures. The
 * run's accounting named six failed sources:
 *
 *   evidence_integrity.tsa_failed / .ots_failed / .ots_pending_aged
 *   pipeline.report_backlog
 *   pipeline.package_backlog
 *   platform.telemetry_stale
 *
 * and a null safeFailureCategory — the reason had been discarded by a bare
 * catch that recorded WHICH source gave way and nothing about why.
 *
 * The cause was NOT the workspace-scope convergence, NOT the TSA disposition
 * and NOT the incident writer. Every failing source's query referenced a
 * COLUMN the deployed database did not have; every succeeding source's query
 * did not. The API had booted healthy against that schema, because the runtime
 * validator does not cover these columns.
 *
 * These cases drive the REAL generator against a database with those columns
 * removed, and assert that the system now says WHICH source failed, at WHICH
 * stage, and from WHAT bounded cause — without ever carrying a SQL fragment, a
 * provider message or record contents into the payload.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

/** Exactly what production reported. */
const PRODUCTION_FAILED = [
  "evidence_integrity.tsa_failed",
  "evidence_integrity.ots_failed",
  "evidence_integrity.ots_pending_aged",
  "pipeline.report_backlog",
  "pipeline.package_backlog",
  "platform.telemetry_stale",
];
const PRODUCTION_SUCCEEDED = [
  "review.stale_workflows",
  "queue.retry_storm",
  "platform.worker_heartbeat_stale",
  "pipeline.signed_without_report_aged",
  "coordination.backlog_stale",
];

/** The columns whose absence produced that split, and how to restore them. */
const GAP: Array<[table: string, column: string, type: string]> = [
  ["evidence", "integrity_correlation_id", "VARCHAR(80)"],
  ["evidence", "latest_report_version", "INTEGER"],
  ["evidence", "verification_package_version", "INTEGER"],
  [
    "queue_telemetry_snapshots",
    "sampled_at_utc",
    "TIMESTAMPTZ(6) NOT NULL DEFAULT now()",
  ],
];

describe("Operations source-failure diagnostics (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let personal: { userId: string; teamId: string };
  let generate: (typeof import("../src/services/dashboard/incident-generator.service.js"))["generateIncidentsForWorkspace"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ generateIncidentsForWorkspace: generate } = await import(
      "../src/services/dashboard/incident-generator.service.js"
    ));
    personal = {
      userId: harness.fixtures.personal.userId,
      teamId: harness.fixtures.personal.teamId,
    };
  }, 900_000);

  afterAll(async () => {
    await restoreGap();
    await harness?.cleanup?.();
  });

  async function openGap(only?: string[]): Promise<void> {
    for (const [table, column] of GAP) {
      if (only && !only.includes(column)) continue;
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
  }

  async function restoreGap(): Promise<void> {
    for (const [table, column, type] of GAP) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" ${type}`,
      );
    }
  }

  /** 34 legacy NULL-team records owned by the personal user. */
  async function seedTsaFailures(n = 34): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const ev = await prisma.evidence.create({
        data: {
          title: `legacy-tsa-${randomUUID()}`,
          type: "PHOTO",
          status: "UPLOADED",
          teamId: null,
          organizationId: null,
          ownerUserId: personal.userId,
          tsaStatus: "FAILED",
        },
        select: { id: true },
      });
      ids.push(ev.id);
    }
    return ids;
  }

  beforeEach(async () => {
    await restoreGap();
    await prisma.operationalIncident.deleteMany({
      where: { fingerprint: { startsWith: "tsa_failure:" } },
    });
    await prisma.evidence.deleteMany({
      where: {
        ownerUserId: personal.userId,
        title: { startsWith: "legacy-tsa-" },
      },
    });
  });

  // -------------------------------------------------------------------------
  // 1. The exact production shape, reproduced.
  // -------------------------------------------------------------------------

  it("reproduces the exact six-source production result", async () => {
    await seedTsaFailures();
    await openGap();

    const r = await generate({ teamId: personal.teamId });

    expect([...r.sources.failed].sort()).toEqual([...PRODUCTION_FAILED].sort());
    expect([...r.sources.successful].sort()).toEqual(
      [...PRODUCTION_SUCCEEDED].sort(),
    );
    expect(r.sources.truncated).toEqual([]);
    // The number that made Operations render an empty page over 34 real
    // failures.
    expect(r.recorded).toBe(0);
  }, 900_000);

  it("names the stage and a bounded cause for every failed source", async () => {
    await seedTsaFailures();
    await openGap();

    const r = await generate({ teamId: personal.teamId });
    const byId = new Map(r.sources.outcomes.map((o) => [o.sourceId, o]));

    // Every ATTEMPTED source carries exactly one outcome.
    expect(r.sources.outcomes.length).toBe(r.sources.attempted.length);

    for (const id of PRODUCTION_FAILED) {
      const o = byId.get(id);
      expect(o, `missing outcome for ${id}`).toBeTruthy();
      expect(o?.outcome).toBe("FAILED");
      // A missing column is a READ failure: the population was never legible.
      expect(o?.stage).toBe("READ");
      // The whole point: this used to be null.
      expect(o?.category).toBe("schema_mismatch");
      // And it must not invite an operator to retry something that cannot
      // succeed until somebody changes the database.
      expect(o?.retryable).toBe(false);
    }
    for (const id of PRODUCTION_SUCCEEDED) {
      const o = byId.get(id);
      expect(o?.outcome).toBe("SUCCEEDED");
      expect(o?.stage).toBeNull();
      expect(o?.category).toBeNull();
    }
  }, 900_000);

  it("never carries SQL, identifiers or record contents in the outcome", async () => {
    await seedTsaFailures(2);
    await openGap();

    const r = await generate({ teamId: personal.teamId });
    const serialised = JSON.stringify(r.sources.outcomes);

    for (const leak of [
      "SELECT",
      "prisma",
      "Prisma",
      "column",
      "relation",
      "legacy-tsa-",
      personal.teamId,
      personal.userId,
      "integrity_correlation_id",
    ]) {
      expect(
        serialised.includes(leak),
        `outcome payload leaked ${JSON.stringify(leak)}`,
      ).toBe(false);
    }
  }, 900_000);

  // -------------------------------------------------------------------------
  // 2. Convergence, once the schema is whole.
  // -------------------------------------------------------------------------

  it("34 TSA failures become 34 conditions and one group of 34", async () => {
    await seedTsaFailures();

    const r = await generate({ teamId: personal.teamId });
    expect(r.sources.failed).toEqual([]);
    expect(r.recorded).toBe(34);

    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/ops/summary?teamId=${personal.teamId}`,
      headers: { authorization: `Bearer ${harness.fixtures.personal.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      summary: {
        open: number;
        readiness: string;
        reconciliationComplete: boolean;
        mayAssertAllClear: boolean;
        groups: Array<{ groupKey: string; affectedCount: number }>;
      };
    };
    expect(body.summary.open).toBe(34);
    expect(body.summary.readiness).toBe("READY");
    expect(body.summary.reconciliationComplete).toBe(true);
    // "Workspace operations are clear" must be impossible here.
    expect(body.summary.mayAssertAllClear).toBe(false);

    const tsa = body.summary.groups.find((g) =>
      g.groupKey.includes("tsa_failure"),
    );
    expect(tsa?.affectedCount).toBe(34);
  }, 900_000);

  it("keeps all 34 individually addressable, not merged into the group", async () => {
    await seedTsaFailures();
    await generate({ teamId: personal.teamId });

    const rows = await prisma.operationalIncident.findMany({
      where: {
        teamId: personal.teamId,
        fingerprint: { startsWith: "tsa_failure:" },
      },
      select: { fingerprint: true },
    });
    // One condition per record, and every fingerprint distinct.
    expect(rows.length).toBe(34);
    expect(new Set(rows.map((row) => row.fingerprint)).size).toBe(34);
  }, 900_000);

  // -------------------------------------------------------------------------
  // 3. Required vs optional.
  // -------------------------------------------------------------------------

  it("an OPTIONAL source failing alone does not make the workspace PARTIAL", async () => {
    await seedTsaFailures(1);
    // Only platform telemetry — a platform sampler the tenant neither owns nor
    // can act on, and deliberately not freshness-participating.
    await openGap(["sampled_at_utc"]);

    const { reconcileWorkspaceOperations } = await import(
      "../src/services/operations/operations-reconciliation.service.js"
    );
    await reconcileWorkspaceOperations({
      workspaceId: personal.teamId,
      trigger: "cli",
    });
    const { latestWorkspaceOperationsRun } = await import(
      "@proovra/shared-runtime"
    );
    const run = await latestWorkspaceOperationsRun(prisma, personal.teamId);

    expect(run?.sources.failedSources).toContain("platform.telemetry_stale");
    // Visible as a failure...
    const outcome = run?.sources.outcomes.find(
      (x) => x.sourceId === "platform.telemetry_stale",
    );
    expect(outcome?.outcome).toBe("FAILED");
    // ...but it does not speak for a picture it was never part of.
    expect(run?.readiness).toBe("READY");
    expect(run?.incompletenessReason).toBeNull();
  }, 900_000);

  it("a REQUIRED source failing stays PARTIAL with a non-null bounded cause", async () => {
    await seedTsaFailures(1);
    await openGap(["latest_report_version"]);

    const { reconcileWorkspaceOperations } = await import(
      "../src/services/operations/operations-reconciliation.service.js"
    );
    await reconcileWorkspaceOperations({
      workspaceId: personal.teamId,
      trigger: "cli",
    });
    const { latestWorkspaceOperationsRun } = await import(
      "@proovra/shared-runtime"
    );
    const run = await latestWorkspaceOperationsRun(prisma, personal.teamId);

    expect(run?.readiness).toBe("PARTIAL");
    // The two fields that were null in production.
    expect(run?.safeFailureCategory).toBe("schema_mismatch");
    expect(run?.incompletenessReason).toBe("REQUIRED_SOURCE_FAILED");
    expect(run?.incompleteSourceIds).toContain("pipeline.report_backlog");
  }, 900_000);

  // -------------------------------------------------------------------------
  // 4. One bad row must not take the healthy ones down with it.
  // -------------------------------------------------------------------------

  it("a pre-IncidentScope orphan does not suppress the correct condition", async () => {
    const ids = await seedTsaFailures();

    // A historical NULL-team row carrying the SAME fingerprint, recorded
    // before the scope discriminator existed and backfilled to
    // LEGACY_UNSCOPED by the scope migration.
    await prisma.operationalIncident.create({
      data: {
        teamId: null,
        scope: "LEGACY_UNSCOPED",
        category: "EVIDENCE_INTEGRITY",
        fingerprint: `tsa_failure:${ids[0]}`,
        title: "pre-IncidentScope orphan",
        safeSummary: "recorded before the scope discriminator existed",
        updatedAt: new Date(),
      },
    });

    const r = await generate({ teamId: personal.teamId });

    // The legacy orphan does not suppress the correct WORKSPACE condition,
    // and tenant binding is not relaxed to achieve that.
    const written = await prisma.operationalIncident.count({
      where: {
        teamId: personal.teamId,
        scope: "WORKSPACE",
        fingerprint: { startsWith: "tsa_failure:" },
      },
    });
    expect(written).toBe(34);
    expect(r.recorded).toBe(34);
    expect(r.sources.failed).toEqual([]);
  }, 900_000);

  // -------------------------------------------------------------------------
  // 5. Tenant isolation is not relaxed by any of this.
  // -------------------------------------------------------------------------

  it("another owner's null-team records are never in this workspace's set", async () => {
    await seedTsaFailures(3);
    const stranger = await prisma.user.create({
      data: {
        email: `stranger-${randomUUID()}@example.test`,
        displayName: "stranger",
        provider: "EMAIL",
        providerUserId: randomUUID(),
      },
      select: { id: true },
    });
    await prisma.evidence.create({
      data: {
        title: `legacy-tsa-${randomUUID()}`,
        type: "PHOTO",
        status: "UPLOADED",
        teamId: null,
        organizationId: null,
        ownerUserId: stranger.id,
        tsaStatus: "FAILED",
      },
    });

    const r = await generate({ teamId: personal.teamId });
    // Three, not four: the stranger's NULL-team record is not this personal
    // workspace's, and the owner-conjoined arm is what keeps it out.
    expect(r.recorded).toBe(3);
  }, 900_000);

  it("makes zero TSA provider calls and exposes no restamp path", async () => {
    await seedTsaFailures(2);
    await generate({ teamId: personal.teamId });

    // The conditions exist and are visible...
    const rows = await prisma.operationalIncident.count({
      where: {
        teamId: personal.teamId,
        fingerprint: { startsWith: "tsa_failure:" },
      },
    });
    expect(rows).toBe(2);

    // ...and nothing in the discovery path reaches a timestamp authority. The
    // outbound guard installed by the integration bootstrap would already have
    // failed the run on a real socket; this asserts the STRUCTURAL absence too,
    // so a future edit cannot quietly add one.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL(
        "../src/services/operations/evidence-integrity-conditions.service.ts",
        import.meta.url,
      ),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const forbidden of [
      "restamp",
      "requestTimestamp",
      "tsaClient",
      "fetch(",
    ]) {
      expect(
        src.includes(forbidden),
        `discovery must not reach a timestamp authority (${forbidden})`,
      ).toBe(false);
    }
  }, 900_000);
});
