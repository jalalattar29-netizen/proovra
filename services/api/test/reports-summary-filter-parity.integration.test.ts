/**
 * REPORTS: EVERY SUMMARY TILE EQUALS ITS FILTER'S TOTAL — PROVEN AGAINST POSTGRES.
 *
 * The Reports page showed tiles computed by their own arithmetic
 * (`SIGNED − REPORTED` for pending reports, "no package row" for pending
 * packages, package VERSION rows for ready packages, a 500-row sample for
 * blocked) beside filters computed from a platform-wide scan of the newest
 * 5,000 generation requests. A tile routinely disagreed with the rows its own
 * filter returned, a Free record that was never entitled to a package read as
 * "package pending", and another workspace's requests could leak in.
 *
 * These run the real aggregator against real rows: no mock decides a count.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Aggregator = typeof import("../src/services/reports/reports-aggregator.service.js");
type Filter = import("../src/services/reports/reports-aggregator.service.js").ReportLifecycleFilter;

describe("Reports summary ⇔ lifecycle filter parity (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let agg: Aggregator;
  const ids: Record<string, string> = {};

  async function evidence(teamId: string, ownerUserId: string, label: string, status: "SIGNED" | "REPORTED") {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { organizationId: true },
    });
    const row = await prisma.evidence.create({
      data: {
        title: `parity ${label}`,
        type: "PHOTO",
        status,
        teamId,
        organizationId: team.organizationId,
        ownerUserId,
      },
      select: { id: true },
    });
    ids[label] = row.id;
    return row.id;
  }

  async function artifacts(evidenceId: string, versions: number[], kinds: Array<"report" | "package">) {
    for (const version of versions) {
      if (kinds.includes("report")) {
        await prisma.report.create({
          data: {
            evidenceId,
            version,
            storageBucket: "parity",
            storageKey: `reports/${evidenceId}/v${version}.pdf`,
            generatedAtUtc: new Date(),
          },
        });
      }
      if (kinds.includes("package")) {
        await prisma.verificationPackage.create({
          data: {
            evidenceId,
            version,
            storageBucket: "parity",
            storageKey: `verification/${evidenceId}/v${version}.zip`,
            generatedAtUtc: new Date(),
          },
        });
      }
    }
  }

  async function request(teamId: string, evidenceId: string, state: string, ageMs = 0, terminalReasonCode?: string) {
    await prisma.reportGenerationRequest.create({
      data: {
        teamId,
        evidenceId,
        requestedByMachineId: "reports-parity-integration",
        idempotencyKey: `PARITY:${randomUUID()}`,
        state,
        terminalReasonCode: terminalReasonCode ?? null,
        createdAtUtc: new Date(Date.now() - ageMs),
      },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    agg = await import("../src/services/reports/reports-aggregator.service.js");

    const A = harness.fixtures.teamA;
    const B = harness.fixtures.teamB;

    // Ready report AND package, two versions each (v2, v7): ONE record.
    await artifacts(await evidence(A.teamId, A.ownerUserId, "readyBoth", "REPORTED"), [2, 7], ["report", "package"]);
    // Report only.
    await artifacts(await evidence(A.teamId, A.ownerUserId, "reportOnly", "REPORTED"), [1], ["report"]);
    // Queued and running: pending for both outputs.
    await request(A.teamId, await evidence(A.teamId, A.ownerUserId, "queued", "SIGNED"), "QUEUED");
    await request(A.teamId, await evidence(A.teamId, A.ownerUserId, "running", "SIGNED"), "PROCESSING");
    // Failed: never pending.
    await request(A.teamId, await evidence(A.teamId, A.ownerUserId, "failedRetryable", "SIGNED"), "FAILED_RETRYABLE");
    await request(
      A.teamId,
      await evidence(A.teamId, A.ownerUserId, "failedTerminal", "SIGNED"),
      "FAILED_TERMINAL",
      0,
      "retry_budget_exhausted",
    );
    // An OLD queued request superseded by a newer failure: the latest wins.
    const superseded = await evidence(A.teamId, A.ownerUserId, "olderQueuedNowFailed", "SIGNED");
    await request(A.teamId, superseded, "QUEUED", 60_000);
    await request(A.teamId, superseded, "FAILED_RETRYABLE");
    // Never requested (e.g. a Free record whose plan never included outputs):
    // neither pending nor failed.
    await evidence(A.teamId, A.ownerUserId, "neverRequested", "SIGNED");
    // Package gate-blocked, no package.
    const blocked = await evidence(A.teamId, A.ownerUserId, "packageBlocked", "SIGNED");
    await prisma.evidence.update({
      where: { id: blocked },
      data: { verificationPackageMetadata: { blocked: true, reason: "PACKAGE_GATE_DENIED" } },
    });
    await request(A.teamId, blocked, "QUEUED");

    // Workspace B: pending work that must never show up in A.
    await request(B.teamId, await evidence(B.teamId, B.ownerUserId, "otherQueued", "SIGNED"), "QUEUED");
    await request(B.teamId, await evidence(B.teamId, B.ownerUserId, "otherFailed", "SIGNED"), "FAILED_RETRYABLE");
  }, 180_000);

  afterAll(async () => {
    const all = Object.values(ids);
    await prisma?.reportGenerationRequest.deleteMany({ where: { evidenceId: { in: all } } }).catch(() => undefined);
    await harness?.cleanup();
  });

  async function summaryOf(teamId: string) {
    const env = await agg.listWorkspaceArtifacts({ teamId, role: "OWNER", limit: 1 });
    expect(env.sections.summary.status).toBe("ok");
    return env.sections.summary.data!;
  }

  /** Every row the filter returns, walking every page. */
  async function walk(teamId: string, filter: Filter, limit = 2) {
    const rows: Awaited<ReturnType<Aggregator["listWorkspaceArtifacts"]>>["sections"]["artifacts"]["items"] = [];
    let cursor: string | null = null;
    let total: number | null = null;
    for (let i = 0; i < 100; i++) {
      const env = await agg.listWorkspaceArtifacts({
        teamId,
        role: "OWNER",
        limit,
        cursor,
        lifecycleFilter: filter,
        includeSummary: false,
      });
      expect(env.sections.artifacts.status).toBe("ok");
      total = env.sections.artifacts.total;
      rows.push(...env.sections.artifacts.items);
      cursor = env.sections.artifacts.nextCursor;
      if (!cursor) break;
    }
    return { rows, total: total ?? -1 };
  }

  const TILE_FILTER: Array<[keyof Awaited<ReturnType<typeof summaryOf>>, Filter]> = [
    ["reportsReady", "report_ready"],
    ["reportsPending", "report_pending"],
    ["reportsFailed", "report_failed"],
    ["packagesReady", "package_ready"],
    ["packagesPending", "package_pending"],
    ["packagesBlocked", "package_blocked"],
  ];

  it("every tile with a filter equals that filter's total, and every page walk reaches it", async () => {
    for (const { teamId } of [harness.fixtures.teamA, harness.fixtures.teamB]) {
      const s = await summaryOf(teamId);
      for (const [tile, filter] of TILE_FILTER) {
        const { rows, total } = await walk(teamId, filter);
        expect({ tile, n: s[tile] }).toEqual({ tile, n: total });
        expect({ tile, n: rows.length }).toEqual({ tile, n: total });
        expect(new Set(rows.map((r) => r.evidenceId)).size).toBe(rows.length);
      }
    }
  });

  it("each filter returns exactly the rows whose projected lifecycle carries that value", async () => {
    const { teamId } = harness.fixtures.teamA;
    const { rows: all } = await walk(teamId, "all", 100);
    const expectFor: Record<Exclude<Filter, "all">, (r: (typeof all)[number]) => boolean> = {
      report_ready: (r) => r.report.state === "ready",
      report_pending: (r) => r.report.state === "pending",
      report_failed: (r) => r.report.state === "failed",
      package_ready: (r) => r.package.state === "ready",
      package_pending: (r) => r.package.state === "pending",
      package_blocked: (r) => r.package.state === "blocked",
    };
    for (const [filter, predicate] of Object.entries(expectFor) as Array<[Exclude<Filter, "all">, (r: (typeof all)[number]) => boolean]>) {
      const { rows } = await walk(teamId, filter, 100);
      expect({ filter, ids: rows.map((r) => r.evidenceId).sort() }).toEqual({
        filter,
        ids: all.filter(predicate).map((r) => r.evidenceId).sort(),
      });
    }
  });

  it("counts records, not versions, and only records with a real artifact", async () => {
    const s = await summaryOf(harness.fixtures.teamA.teamId);
    // readyBoth (v2 + v7 of each) and reportOnly.
    expect(s.reportsReady).toBe(2);
    expect(s.packagesReady).toBe(1);
    expect(s.totalEvidenceWithArtifacts).toBe(2);
  });

  it("queued and running are pending; failed, never-requested and other workspaces are not", async () => {
    const A = harness.fixtures.teamA;
    const s = await summaryOf(A.teamId);
    const pending = (await walk(A.teamId, "report_pending", 100)).rows.map((r) => r.evidenceId).sort();
    expect(pending).toEqual([ids.queued, ids.running, ids.packageBlocked].sort());
    expect(s.reportsPending).toBe(3);

    const pkgPending = (await walk(A.teamId, "package_pending", 100)).rows.map((r) => r.evidenceId).sort();
    // The blocked record's package is BLOCKED, not pending.
    expect(pkgPending).toEqual([ids.queued, ids.running].sort());
    expect(s.packagesPending).toBe(2);
    expect(s.packagesBlocked).toBe(1);

    for (const id of [ids.neverRequested, ids.failedRetryable, ids.failedTerminal, ids.olderQueuedNowFailed, ids.otherQueued]) {
      expect(pending).not.toContain(id);
      expect(pkgPending).not.toContain(id);
    }
  });

  it("failed is the latest request's state and stays inside the workspace", async () => {
    const A = harness.fixtures.teamA;
    const { rows: all } = await walk(A.teamId, "all", 100);
    const failed = (await walk(A.teamId, "report_failed", 100)).rows.map((r) => r.evidenceId);
    // Whether a failure reads "failed" or "unavailable" is the workspace's
    // entitlement — but the tile, the filter and the row always agree, and a
    // failure is never pending.
    const failedRows = all.filter((r) =>
      [ids.failedRetryable, ids.failedTerminal, ids.olderQueuedNowFailed].includes(r.evidenceId),
    );
    expect(failedRows).toHaveLength(3);
    for (const r of failedRows) {
      expect(["failed", "unavailable"]).toContain(r.report.state);
      expect(failed.includes(r.evidenceId)).toBe(r.report.state === "failed");
    }
    expect(failed).not.toContain(ids.otherFailed);

    const B = harness.fixtures.teamB;
    const sb = await summaryOf(B.teamId);
    expect(sb.reportsPending).toBe(1);
    expect((await walk(B.teamId, "report_pending", 100)).rows.map((r) => r.evidenceId)).toEqual([ids.otherQueued]);
  });

  it("is not truncated by a large workspace: pending beyond one classification batch are all counted", async () => {
    const B = harness.fixtures.teamB;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: B.teamId }, select: { organizationId: true } });
    const N = 1203;
    const created = await prisma.evidence.createManyAndReturn({
      data: Array.from({ length: N }, (_, i) => ({
        title: `parity bulk ${i}`,
        type: "PHOTO" as const,
        status: "SIGNED" as const,
        teamId: B.teamId,
        organizationId: team.organizationId,
        ownerUserId: B.ownerUserId,
      })),
      select: { id: true },
    });
    created.forEach((r, i) => (ids[`bulk${i}`] = r.id));
    await prisma.reportGenerationRequest.createMany({
      data: created.map((r) => ({
        teamId: B.teamId,
        evidenceId: r.id,
        requestedByMachineId: "reports-parity-integration",
        idempotencyKey: `PARITY:${randomUUID()}`,
        state: "QUEUED",
      })),
    });

    const s = await summaryOf(B.teamId);
    expect(s.reportsPending).toBe(N + 1);
    const env = await agg.listWorkspaceArtifacts({
      teamId: B.teamId,
      role: "OWNER",
      limit: 25,
      lifecycleFilter: "report_pending",
      includeSummary: false,
    });
    expect(env.sections.artifacts.total).toBe(N + 1);
    expect(env.sections.artifacts.items).toHaveLength(25);
    // Workspace A is unaffected by B's volume.
    expect((await summaryOf(harness.fixtures.teamA.teamId)).reportsPending).toBe(3);
  }, 120_000);
});
