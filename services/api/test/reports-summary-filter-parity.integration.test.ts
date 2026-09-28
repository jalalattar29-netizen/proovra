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

  async function request(
    teamId: string,
    evidenceId: string,
    state: string,
    ageMs = 0,
    terminalReasonCode?: string,
    artifactType: "REPORT" | "VERIFICATION_PACKAGE" = "REPORT",
    reportVersion?: number,
  ) {
    await prisma.reportGenerationRequest.create({
      data: {
        teamId,
        evidenceId,
        requestedByMachineId: "reports-parity-integration",
        idempotencyKey: `PARITY:${randomUUID()}`,
        state,
        artifactType,
        reportVersion: reportVersion ?? null,
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

    /*
     * FUNDING. The package expectations below (one failed, one gate-blocked)
     * describe a workspace whose plan INCLUDES verification packages. The
     * harness organization is a customer organization with no contract, which
     * the canonical commercial resolver answers as FREE — and on FREE the
     * canonical output derivation ranks NOT_INCLUDED above a failure or a
     * gate block, so those records are (correctly) "unavailable", not failed
     * or blocked. Workspace A is therefore funded the way a real entitled
     * organization is: an ENTERPRISE workspace with an ACTIVE contract.
     * Workspace B stays FREE and carries its own blocked record, so the
     * NOT_INCLUDED ≠ BLOCKED distinction is asserted too.
     */
    const orgA = await prisma.team.update({
      where: { id: A.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" },
      select: { organizationId: true },
    });
    if (orgA.organizationId) {
      await prisma.enterpriseContract.upsert({
        where: { organizationId: orgA.organizationId },
        create: { organizationId: orgA.organizationId, status: "ACTIVE" },
        update: { status: "ACTIVE" },
      });
    }

    // Ready report AND package, two versions each (v2, v7): ONE record.
    await artifacts(await evidence(A.teamId, A.ownerUserId, "readyBoth", "REPORTED"), [2, 7], ["report", "package"]);
    // Report only.
    await artifacts(await evidence(A.teamId, A.ownerUserId, "reportOnly", "REPORTED"), [1], ["report"]);
    // Latest report v7 failed to get a package; historical package v2 remains.
    const latestPackageFailed = await evidence(
      A.teamId,
      A.ownerUserId,
      "latestPackageFailed",
      "REPORTED",
    );
    await artifacts(latestPackageFailed, [2], ["report", "package"]);
    await artifacts(latestPackageFailed, [7], ["report"]);
    await request(
      A.teamId,
      latestPackageFailed,
      "FAILED_RETRYABLE",
      0,
      undefined,
      "VERIFICATION_PACKAGE",
      7,
    );
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
    // Workspace B is FREE: a gate-blocked record there is NOT_INCLUDED, never "blocked".
    const freeBlocked = await evidence(B.teamId, B.ownerUserId, "freePackageBlocked", "SIGNED");
    await prisma.evidence.update({
      where: { id: freeBlocked },
      data: { verificationPackageMetadata: { blocked: true, reason: "PACKAGE_GATE_DENIED" } },
    });
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
    ["packagesFailed", "package_failed"],
    ["packagesBlocked", "package_blocked"],
    // 2026-09-29 — the buckets "not requested" used to hide, each a drill-down.
    ["reportsNotIssued", "report_not_issued"],
    ["reportsAwaitingFirstIssuance", "report_awaiting_issuance"],
    ["packagesMissingForLatestReport", "package_missing"],
    ["outputsEntitlementUnavailable", "entitlement_unavailable"],
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
      package_failed: (r) => r.package.state === "failed",
      package_blocked: (r) => r.package.state === "blocked",
      report_not_issued: (r) => r.outputs.report.state === "NOT_INCLUDED",
      report_awaiting_issuance: (r) => r.outputs.report.state === "ELIGIBLE_NOT_GENERATED",
      package_missing: (r) =>
        r.outputs.report.state === "READY" &&
        r.outputs.verificationPackage.state === "ELIGIBLE_NOT_GENERATED",
      entitlement_unavailable: (r) =>
        r.outputs.report.state === "ENTITLEMENT_UNAVAILABLE" ||
        r.outputs.verificationPackage.state === "ENTITLEMENT_UNAVAILABLE",
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
    // readyBoth (v2 + v7 of each), reportOnly and latestPackageFailed.
    expect(s.reportsReady).toBe(3);
    expect(s.packagesReady).toBe(1);
    /*
     * Package-failed is a SET, stated rather than counted. A REPORT request
     * is the worker's NEW_REPORT run, which builds the report AND its package
     * as one pair (services/worker/src/processor.ts); when it fails, neither
     * output was produced, so the package failed with it — the same rule this
     * file relies on for pending, where a queued REPORT request is package-
     * pending. `latestPackageFailed` is the package-only failure for v7. This
     * read `1` when the file first landed, but the file never compiled, so the
     * number had never been checked against the aggregator.
     */
    const pkgFailed = (await walk(harness.fixtures.teamA.teamId, "package_failed", 100)).rows;
    expect(pkgFailed.map((r) => r.evidenceId).sort()).toEqual(
      [ids.latestPackageFailed, ids.failedRetryable, ids.failedTerminal, ids.olderQueuedNowFailed].sort(),
    );
    expect(s.packagesFailed).toBe(4);
    expect(s.totalEvidenceWithArtifacts).toBe(3);
    expect(s.totalArtifactVersions).toBe(8);

    const failedRow = pkgFailed.find((r) => r.evidenceId === ids.latestPackageFailed);
    expect(failedRow?.evidenceId).toBe(ids.latestPackageFailed);
    expect(failedRow?.report.version).toBe(7);
    expect(failedRow?.package.version).toBeNull();
    expect(failedRow?.outputs.verificationPackage.latestAvailableVersion).toBe(2);
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

  it("NOT_INCLUDED is not BLOCKED: a gate-blocked record on a plan without packages reads unavailable in its row, filter and tile", async () => {
    const B = harness.fixtures.teamB;
    const { rows: all } = await walk(B.teamId, "all", 100);
    const row = all.find((r) => r.evidenceId === ids.freePackageBlocked);
    expect(row?.package.state).toBe("unavailable");
    expect((await walk(B.teamId, "package_blocked", 100)).rows.map((r) => r.evidenceId)).not.toContain(
      ids.freePackageBlocked,
    );
    expect((await summaryOf(B.teamId)).packagesBlocked).toBe(0);
    // ...while the same metadata on an entitled workspace IS blocked.
    const A = harness.fixtures.teamA;
    expect((await walk(A.teamId, "package_blocked", 100)).rows.map((r) => r.evidenceId)).toEqual([ids.packageBlocked]);
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
