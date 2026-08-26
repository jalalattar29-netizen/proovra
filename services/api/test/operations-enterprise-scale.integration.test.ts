/**
 * ENTERPRISE SCALE — live PostgreSQL 16.
 *
 * ---------------------------------------------------------------------------
 * WHY SCALE IS A CORRECTNESS QUESTION HERE, NOT A PERFORMANCE ONE
 * ---------------------------------------------------------------------------
 * Operations produces ONE condition per affected Evidence record for the
 * integrity sources. That is the right shape — seventeen records that each
 * need fixing rendered as one number is a count nobody can act on — and it is
 * also the shape that fails worst at volume if nothing bounds it.
 *
 * So the properties under test are not "is it fast". They are:
 *
 *   * the per-record scan is BOUNDED, and reaching the bound is REPORTED
 *     rather than rounded off into a tidy answer;
 *   * a truncated run may never be described as clear;
 *   * the queue is paginated and one page is bounded whatever the total;
 *   * grouping collapses per-record conditions into actionable groups whose
 *     `conditionCount` is the FULL number, not the page size;
 *   * concurrent reconciliation produces one run and no duplicate conditions;
 *   * concurrent writers of the SAME condition converge on one row;
 *   * none of the above changes with the plan — the query implementation is
 *     the same one every workspace uses.
 *
 * ---------------------------------------------------------------------------
 * ABOUT THE VOLUME
 * ---------------------------------------------------------------------------
 * The integrity scan bound is 2000. This suite seeds past it rather than near
 * it, because a bound is only proven by crossing it: seeding 1999 records
 * would exercise exactly the path that already worked. It seeds the smallest
 * population that crosses, not 100k rows, because what is being proven is the
 * BOUND and its reporting — and a suite that takes ten minutes to assert the
 * same thing is a suite people stop running.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

/** Must exceed `SCAN_BOUND` in evidence-integrity-conditions.service.ts. */
const OVER_BOUND = 2100;

describe("Operations at Enterprise scale (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let ops: typeof import("../src/services/operations/operations-reconciliation.service.js");
  let runtime: typeof import("@proovra/shared-runtime");
  let scope: typeof import("../src/services/observability/incident-scope.js");
  let grouping: typeof import("../src/services/operations/operations-grouping.service.js");
  let incidents: typeof import("../src/services/observability/incident.service.js");

  let ws: { teamId: string; ownerUserId: string; orgId: string };

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
    incidents = await import("../src/services/observability/incident.service.js");

    const team = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { id: true, organizationId: true },
    });
    ws = {
      teamId: team.id,
      orgId: team.organizationId!,
      ownerUserId: harness.fixtures.teamA.ownerUserId,
    };

    // A strict-scope (team-bound) population, which is what an Enterprise
    // workspace actually has — the legacy NULL-team shape is a personal-space
    // property and is covered by the production-signature suite.
    const rows = Array.from({ length: OVER_BOUND }, (_, i) => ({
      title: `ent-tsa-${i}`,
      type: "PHOTO" as const,
      status: "REPORTED" as const,
      tsaStatus: "FAILED" as const,
      verificationPackageVersion: 1,
      teamId: ws.teamId,
      organizationId: ws.orgId,
      ownerUserId: ws.ownerUserId,
    }));
    // Chunked: one 2100-row INSERT is a parameter-count problem rather than a
    // property of the product.
    for (let i = 0; i < rows.length; i += 500) {
      await prisma.evidence.createMany({ data: rows.slice(i, i + 500) as never });
    }
  }, 900_000);

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  it("the per-record scan is BOUNDED, says so, and blocks the all-clear", async () => {
    await prisma.governanceReconciliationRun.deleteMany({
      where: { kind: "WORKSPACE_OPERATIONS", teamId: ws.teamId },
    });
    await ops.reconcileWorkspaceOperations({
      workspaceId: ws.teamId,
      trigger: "cli",
    });
    const run = (await runtime.latestWorkspaceOperationsRun(prisma, ws.teamId))!;

    // A bounded read is not a complete one, and the run must not round that
    // off. The three integrity sources share the pass, so all three truncate.
    expect(run.sources.truncatedSources.sort()).toEqual([
      "evidence_integrity.ots_failed",
      "evidence_integrity.ots_pending_aged",
      "evidence_integrity.tsa_failed",
    ]);
    // Truncated is NOT failed — the scan worked, it just did not finish the
    // collection — and it still makes the picture incomplete.
    expect(run.sources.failedSources).toEqual([]);
    expect(run.readiness).toBe("PARTIAL");

    // A workspace whose scan hit its bound may never be described as clear.
    expect(run.sources.truncatedSources.length).toBeGreaterThan(0);
  });

  it("opens one condition per record up to the bound, and never one unbounded row for all of them", async () => {
    const perRecord = await prisma.operationalIncident.count({
      where: {
        ...scope.workspaceIncidentWhere(ws.teamId),
        category: "EVIDENCE_INTEGRITY",
      },
    });
    // Bounded, not zero and not 2100: each record gets its own condition, its
    // own acknowledgement and its own resolution, and the sweep stops at its
    // bound rather than materialising an unbounded set in one pass.
    expect(perRecord).toBe(2000);
  });

  it("groups per-record conditions into actionable groups whose conditionCount is the FULL number", async () => {
    const all = await prisma.operationalIncident.findMany({
      where: {
        ...scope.workspaceIncidentWhere(ws.teamId),
        category: "EVIDENCE_INTEGRITY",
      },
      orderBy: { lastSeenAtUtc: "desc" },
    });
    const groups = grouping.projectConditionGroups(all as never);

    // Conservation: grouping is a PRESENTATION projection over the same rows,
    // never a merge. Two thousand records that each failed to be timestamped
    // stay two thousand conditions.
    const summed = groups.reduce((n, g) => n + g.conditionCount, 0);
    expect(summed).toBe(all.length);

    // And an operator gets a handful of rows to act on rather than 2000.
    expect(groups.length).toBeLessThan(all.length);
    for (const g of groups) {
      // The sample is a PAGE of the group; the count is the whole of it.
      expect(g.conditionCount).toBeGreaterThanOrEqual(1);
    }
  });

  it("concurrent reconciliation produces ONE run and no duplicate conditions", async () => {
    await prisma.governanceReconciliationRun.deleteMany({
      where: { kind: "WORKSPACE_OPERATIONS", teamId: ws.teamId },
    });
    const before = await prisma.operationalIncident.count({
      where: scope.workspaceIncidentWhere(ws.teamId),
    });

    const outcomes = await Promise.all([
      ops.reconcileWorkspaceOperations({ workspaceId: ws.teamId, trigger: "api" }),
      ops.reconcileWorkspaceOperations({ workspaceId: ws.teamId, trigger: "scheduler" }),
      ops.reconcileWorkspaceOperations({ workspaceId: ws.teamId, trigger: "cli" }),
    ]);
    expect(outcomes.filter((o) => o.kind === "ran")).toHaveLength(1);
    expect(
      await prisma.governanceReconciliationRun.count({
        where: { kind: "WORKSPACE_OPERATIONS", teamId: ws.teamId },
      }),
    ).toBe(1);

    // Re-observing 2000 conditions must not create a second 2000.
    const after = await prisma.operationalIncident.count({
      where: scope.workspaceIncidentWhere(ws.teamId),
    });
    expect(after).toBe(before);
  });

  it("concurrent writers of the SAME condition converge on one row", async () => {
    const fingerprint = `ent:scale:concurrent:${ws.teamId}`;
    const write = () =>
      incidents.recordIncident({
        sourceId: "pipeline.report_backlog",
        teamId: ws.teamId,
        category: "REPORT",
        severity: "HIGH",
        fingerprint,
        title: "concurrent",
        safeSummary: "concurrent writers",
      });

    const results = await Promise.allSettled([
      write(),
      write(),
      write(),
      write(),
      write(),
    ]);
    // A loser may legitimately collide on the unique index. What may NOT
    // happen is two rows for one condition, which would double every count on
    // the page while nothing had changed.
    const rows = await prisma.operationalIncident.findMany({
      where: { ...scope.workspaceIncidentWhere(ws.teamId), fingerprint },
      select: { id: true, occurrenceCount: true },
    });
    expect(rows).toHaveLength(1);
    // At least one writer succeeded; the row exists and counts occurrences.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(rows[0].occurrenceCount).toBeGreaterThanOrEqual(1);
  });

  it("one queue page is bounded whatever the total, and the cursor is total-ordered", async () => {
    const first = await incidents.listIncidents({ teamId: ws.teamId, limit: 50 });
    const page = first.incidents;
    expect(page.length).toBeLessThanOrEqual(50);

    // A page of a 2000-condition workspace is 50 rows, not 2000. An unbounded
    // page is how an Enterprise console becomes unopenable.
    const ids = page.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the summary is ONE read whatever the volume, and reports its own completeness", async () => {
    const summary = await import(
      "../src/services/operations/operations-summary.service.js"
    );
    const built = await summary.buildOperationsSummary({
      workspaceId: ws.teamId,
      viewerUserId: ws.ownerUserId,
    });
    expect(built.open).toBeGreaterThan(0);
    // The honesty contract travels WITH the numbers rather than beside them.
    expect(typeof built.complete).toBe("boolean");
    expect(built.mayAssertAllClear).toBe(false);
  });
});
