// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * OPERATIONS TRUTH CLOSURE — lifecycle truth (live PostgreSQL).
 *
 *   OPS-019  TSA / OTS failure conditions resolve only on POSITIVE recovery:
 *            a validated timestamp, an anchored proof. PENDING, NULL and an
 *            unvalidated token do not resolve them.
 *   OPS-017  a workspace whose search index was never built is "not built
 *            yet" (advisory), not "reconciliation failing".
 *   OPS-014  an expected 403 refusal is recorded in the security log and opens
 *            no customer-visible condition.
 *   OPS-008  the scheduler selects a never-run workspace however many older
 *            workspaces exist.
 *   OPS-032  the request that ran a workspace reconciliation says it ran.
 *   OPS-030  "Stop notifying" needs a reason, single and bulk; the reason is
 *            recorded in the condition's history.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootOps,
  makeUser,
  makeWorkspace,
  seedEvidence,
  seedIncident,
  sweep,
  type Ctx,
} from "./operations-truth-fixtures.js";

describe("Operations truth closure — lifecycle truth (live PostgreSQL 16)", () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await bootOps();
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  const status = async (id: string) => (await c.prisma.operationalIncident.findUnique({ where: { id } }))?.status;

  it("OPS-019 a TSA failure stays open on PENDING and on an unvalidated token; closes on a validated one", async () => {
    const a = c.h.fixtures.teamA;
    const ev = await seedEvidence(c, a.teamId, a.ownerUserId, { tsaStatus: "FAILED" });
    const cond = await seedIncident(c, a.teamId, {
      sourceId: "evidence_integrity.tsa_failed",
      category: "EVIDENCE_INTEGRITY",
      fingerprint: `tsa_failure:${ev.id}`,
      relatedEvidenceId: ev.id,
    });
    for (const data of [{ tsaStatus: "PENDING" }, { tsaStatus: null }, { tsaStatus: "STAMPED", tsaValidatedAtUtc: null }]) {
      await c.prisma.evidence.update({ where: { id: ev.id }, data });
      await sweep(a.teamId);
      expect(await status(cond.id), JSON.stringify(data)).toBe("OPEN");
    }
    await c.prisma.evidence.update({ where: { id: ev.id }, data: { tsaStatus: "STAMPED", tsaValidatedAtUtc: new Date() } });
    await sweep(a.teamId);
    expect(await status(cond.id)).toBe("RESOLVED");
  });

  it("OPS-019 an OTS failure stays open on PENDING / NULL; closes when the proof is anchored", async () => {
    const a = c.h.fixtures.teamA;
    const ev = await seedEvidence(c, a.teamId, a.ownerUserId, { otsStatus: "FAILED" });
    const cond = await seedIncident(c, a.teamId, {
      sourceId: "evidence_integrity.ots_failed",
      category: "EVIDENCE_INTEGRITY",
      fingerprint: `ots_failure:${ev.id}`,
      relatedEvidenceId: ev.id,
    });
    for (const otsStatus of ["PENDING", null]) {
      await c.prisma.evidence.update({ where: { id: ev.id }, data: { otsStatus } });
      await sweep(a.teamId);
      expect(await status(cond.id), String(otsStatus)).toBe("OPEN");
    }
    await c.prisma.evidence.update({
      where: { id: ev.id },
      data: { otsStatus: "ANCHORED", otsAnchoredAtUtc: new Date(), otsBitcoinTxid: "a".repeat(64) },
    });
    await sweep(a.teamId);
    expect(await status(cond.id)).toBe("RESOLVED");
  });

  it("OPS-017 a workspace whose search index was never built reads 'not built yet', not 'failing'", async () => {
    const owner = await makeUser(c, "search-never");
    const w = await makeWorkspace(c, owner.id, { name: "search-never", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    await seedEvidence(c, w.teamId, owner.id);
    await sweep(w.teamId);
    const row = await c.prisma.operationalIncident.findFirst({
      where: { teamId: w.teamId, sourceId: "search.indexing_failure" },
    });
    expect(row).not.toBeNull();
    expect(row!.title).toBe("Search index not built yet");
    expect(row!.severity).toBe("INFO");
    expect(row!.safeSummary).not.toMatch(/failing|nothing is currently working/i);
  });

  it("OPS-014 an expected 403 refusal opens no condition; the security log keeps it", async () => {
    const a = c.h.fixtures.teamA;
    const { safeEmitSecurityEvent } = await import("../src/services/security/security-event.service.js");
    const before = await c.prisma.securityEvent.count({ where: { teamId: a.teamId, eventType: "permission_denied" } });
    safeEmitSecurityEvent({ teamId: a.teamId, eventType: "permission_denied", severity: "WARNING", details: { route: "ops-truth" } });
    const until = Date.now() + 5_000;
    while (Date.now() < until && (await c.prisma.securityEvent.count({ where: { teamId: a.teamId, eventType: "permission_denied" } })) === before) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 500));
    expect(await c.prisma.securityEvent.count({ where: { teamId: a.teamId, eventType: "permission_denied" } })).toBe(before + 1);
    expect(
      await c.prisma.operationalIncident.count({
        where: { teamId: a.teamId, fingerprint: { contains: "security_event:permission_denied" } },
      }),
    ).toBe(0);
  });

  it("OPS-008 the scheduler selects a never-run workspace however many older workspaces exist", async () => {
    const owner = await makeUser(c, "sched-new");
    const w = await makeWorkspace(c, owner.id, { name: "sched-newest" });
    // Every OTHER workspace is current, so the newest one is the only due one.
    await c.prisma.$executeRawUnsafe(
      `INSERT INTO governance_reconciliation_runs (team_id, kind, "trigger", status, started_at_utc, finished_at_utc, lock_key)
       SELECT t.id, 'WORKSPACE_OPERATIONS', 'ops-truth', 'SUCCEEDED', now(), now(), 'ops-truth:' || t.id
         FROM teams t WHERE t.id <> $1::uuid`,
      w.teamId,
    );
    const { runWorkspaceOperationsSweep } = await import("../src/jobs/workspace-operations-reconciliation.job.js");
    const result = await runWorkspaceOperationsSweep({ trigger: "cli", batchSize: 1 });
    expect(result.reconciled).toBe(1);
    expect(
      await c.prisma.governanceReconciliationRun.count({ where: { teamId: w.teamId, kind: "WORKSPACE_OPERATIONS" } }),
    ).toBe(1);
  });

  it("OPS-032 the request that ran the reconciliation reports that it ran", async () => {
    const owner = await makeUser(c, "reconcile-ran");
    const w = await makeWorkspace(c, owner.id, { name: "reconcile-ran", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    const first = await c.inj("POST", "/v1/ops/workspace-reconcile", owner.token, { teamId: w.teamId });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ started: true, ran: true, alreadyRunning: false });
    const run = await c.prisma.governanceReconciliationRun.findFirst({
      where: { teamId: w.teamId, kind: "WORKSPACE_OPERATIONS" },
      orderBy: { startedAtUtc: "desc" },
    });
    expect(run?.triggeredByUserId).toBe(owner.id);
    // The picture is now current: nothing runs, and it says so.
    const second = await c.inj("POST", "/v1/ops/workspace-reconcile", owner.token, { teamId: w.teamId });
    expect(second.json()).toMatchObject({ started: false, ran: false, alreadyRunning: false });
  });

  it("OPS-030 'Stop notifying' needs a reason (single and bulk), and the reason is in the history", async () => {
    const a = c.h.fixtures.teamA;
    const row = await seedIncident(c, a.teamId, { sourceId: "governance.policy_condition" });
    const bare = await c.inj("POST", `/v1/ops/incidents/${row.id}/suppress`, a.ownerToken, { teamId: a.teamId });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.code).toBe("SUPPRESSION_REASON_REQUIRED");
    expect(await status(row.id)).toBe("OPEN");

    const ok = await c.inj("POST", `/v1/ops/incidents/${row.id}/suppress`, a.ownerToken, {
      teamId: a.teamId,
      reason: "Known policy migration; tracked in change 42",
    });
    expect(ok.statusCode).toBe(200);
    const detail = (await c.inj("GET", `/v1/ops/incidents/${row.id}?teamId=${a.teamId}`, a.ownerToken)).json();
    const messages = (detail.incident.timeline ?? []).map((e: { safeMessage: string }) => e.safeMessage);
    expect(messages.join(" | ")).toContain("Known policy migration; tracked in change 42");

    const row2 = await seedIncident(c, a.teamId, { sourceId: "governance.policy_condition" });
    const bulk = await c.inj("POST", "/v1/ops/bulk-actions", a.ownerToken, {
      teamId: a.teamId,
      actionType: "BULK_SUPPRESS_INCIDENTS",
      targetIds: [row2.id],
    });
    expect(bulk.statusCode).toBe(400);
    expect(await status(row2.id)).toBe("OPEN");
  });
});
