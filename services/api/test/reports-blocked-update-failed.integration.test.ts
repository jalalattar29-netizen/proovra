/**
 * REPORTS: blocked requests, failed updated reports and unreadable action
 * facts each have a truthful row, card and filter — live PostgreSQL 16, the
 * real aggregator.
 *
 * On a40ca76f:
 *   ET-RPT-02 — a record whose latest request was BLOCKED_STALE/BLOCKED_POLICY
 *     with no report was in no report bucket and its row read "not requested";
 *     its package was counted in "Packages blocked" while the row read
 *     "Package not requested".
 *   ET-RPT-01 — a record with report v1 whose updated-report request failed
 *     was counted only as "Reports ready"; no card or filter found the failure
 *     the row's Retry / escalation signalled.
 *   ET-RPT-04 — when the batched facts read failed, every row read
 *     NONE / PERMISSION_DENIED ("Needs permission"), the section said ok and
 *     polling stopped.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const facts = vi.hoisted(() => ({ fail: false }));
vi.mock("../src/services/reports/output-recovery.service.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/services/reports/output-recovery.service.js")>();
  return {
    ...orig,
    loadEvidenceOutputFacts: (...args: Parameters<typeof orig.loadEvidenceOutputFacts>) =>
      facts.fail ? Promise.reject(new Error("facts read failed")) : orig.loadEvidenceOutputFacts(...args),
  };
});

type Aggregator = typeof import("../src/services/reports/reports-aggregator.service.js");
type Filter = import("../src/services/reports/reports-aggregator.service.js").ReportLifecycleFilter;

describe("Reports: blocked, updated-report failure, unreadable facts (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let agg: Aggregator;
  const ids: Record<string, string> = {};

  async function evidence(teamId: string, ownerUserId: string, label: string, status: "SIGNED" | "REPORTED") {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    const row = await prisma.evidence.create({
      data: { title: `rpt ${label}`, type: "PHOTO", status, teamId, organizationId: team.organizationId, ownerUserId },
      select: { id: true },
    });
    ids[label] = row.id;
    return row.id;
  }
  async function pair(evidenceId: string, version: number) {
    await prisma.report.create({
      data: { evidenceId, version, storageBucket: "rpt", storageKey: `reports/${evidenceId}/v${version}.pdf`, generatedAtUtc: new Date() },
    });
    await prisma.verificationPackage.create({
      data: { evidenceId, version, storageBucket: "rpt", storageKey: `verification/${evidenceId}/v${version}.zip`, generatedAtUtc: new Date() },
    });
  }
  async function request(teamId: string, evidenceId: string, state: string, reportVersion?: number, terminalReasonCode?: string) {
    await prisma.reportGenerationRequest.create({
      data: {
        teamId,
        evidenceId,
        requestedByMachineId: "reports-blocked-integration",
        idempotencyKey: `RPT:${randomUUID()}`,
        state,
        artifactType: "REPORT",
        reportVersion: reportVersion ?? null,
        terminalReasonCode: terminalReasonCode ?? null,
      },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    agg = await import("../src/services/reports/reports-aggregator.service.js");

    // An entitled workspace (see the parity suite: FREE ranks NOT_INCLUDED first).
    const A = h.fixtures.teamA;
    const t = await prisma.team.update({
      where: { id: A.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" },
      select: { organizationId: true },
    });
    if (t.organizationId) {
      await prisma.enterpriseContract.upsert({
        where: { organizationId: t.organizationId },
        create: { organizationId: t.organizationId, status: "ACTIVE" },
        update: { status: "ACTIVE" },
      });
    }
    await request(A.teamId, await evidence(A.teamId, A.ownerUserId, "blockedStale", "SIGNED"), "BLOCKED_STALE");
    await request(A.teamId, await evidence(A.teamId, A.ownerUserId, "blockedPolicy", "SIGNED"), "BLOCKED_POLICY");
    const updated = await evidence(A.teamId, A.ownerUserId, "updateFailed", "REPORTED");
    await pair(updated, 1);
    await request(A.teamId, updated, "FAILED_TERMINAL", 2, "retry_budget_exhausted");
    const healthy = await evidence(A.teamId, A.ownerUserId, "healthy", "REPORTED");
    await pair(healthy, 1);
  }, 180_000);

  afterAll(async () => {
    await prisma?.reportGenerationRequest.deleteMany({ where: { evidenceId: { in: Object.values(ids) } } }).catch(() => undefined);
    await h?.cleanup();
  });

  const list = (filter: Filter, limit = 100) =>
    agg.listWorkspaceArtifacts({ teamId: h.fixtures.teamA.teamId, role: "OWNER", limit, lifecycleFilter: filter, includeSummary: false });
  const summary = async () => (await agg.listWorkspaceArtifacts({ teamId: h.fixtures.teamA.teamId, role: "OWNER", limit: 1 })).sections.summary.data!;
  const row = async (label: string) =>
    (await list("all")).sections.artifacts.items.find((r) => r.evidenceId === ids[label])!;

  it("ET-RPT-02: a blocked request is 'blocked' in the report row, the package row, a card and a filter", async () => {
    for (const label of ["blockedStale", "blockedPolicy"]) {
      const r = await row(label);
      expect(r.outputs.report.state).toBe("BLOCKED");
      expect(r.report.state).toBe("blocked");
      expect(r.package.state).toBe("blocked");
    }
    const s = await summary();
    expect(s.reportsBlocked).toBe(2);
    const reportBlocked = (await list("report_blocked")).sections.artifacts;
    expect(reportBlocked.items.map((r) => r.evidenceId).sort()).toEqual([ids.blockedStale, ids.blockedPolicy].sort());
    expect(reportBlocked.total).toBe(s.reportsBlocked);
    // Every row the "Packages blocked" card opens says blocked.
    const pkgBlocked = (await list("package_blocked")).sections.artifacts.items;
    expect(pkgBlocked.length).toBe(s.packagesBlocked);
    expect(pkgBlocked.every((r) => r.package.state === "blocked")).toBe(true);
    expect(s.reportsAwaitingFirstIssuance).toBe(0);
  });

  it("ET-RPT-01: a failed updated-report request has its own card and filter, and the report stays ready", async () => {
    const r = await row("updateFailed");
    expect(r.report.state).toBe("ready");
    expect(r.report.updateFailed).toBe(true);
    expect((await row("healthy")).report.updateFailed).toBe(false);
    const s = await summary();
    expect(s.reportsUpdateFailed).toBe(1);
    expect(s.reportsReady).toBe(2);
    const f = (await list("report_update_failed")).sections.artifacts;
    expect(f.items.map((x) => x.evidenceId)).toEqual([ids.updateFailed]);
    expect(f.total).toBe(1);
  });

  it("ET-RPT-04: an unreadable facts read is 'actions unavailable' in a degraded section that keeps polling — never a permission claim", async () => {
    facts.fail = true;
    try {
      const env = await list("all");
      expect(env.sections.artifacts.status).toBe("degraded");
      for (const r of env.sections.artifacts.items) {
        expect(r.outputs.report.action).toBe("NONE");
        expect(r.outputs.report.actionUnavailableReason).toBe("ACTIONS_UNAVAILABLE");
        expect(r.outputs.verificationPackage.actionUnavailableReason).toBe("ACTIONS_UNAVAILABLE");
        expect(r.outputs.pollIntervalMs).toBeGreaterThan(0);
      }
    } finally {
      facts.fail = false;
    }
    const ok = await list("all");
    expect(ok.sections.artifacts.status).toBe("ok");
    expect(ok.sections.artifacts.items.some((r) => r.outputs.report.actionUnavailableReason === "PERMISSION_DENIED")).toBe(false);
  });
});
