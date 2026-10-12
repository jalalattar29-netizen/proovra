// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * OPERATIONS REMEDIATION CLOSURE (live PostgreSQL 16 + Redis).
 *
 *   OPS-01  a Personal record stored with team_id NULL is remediable from its
 *           owner's Personal workspace; a second click collapses onto the
 *           live work instead of queueing twice.
 *   OPS-03  the summary's groups carry the declared source: two different
 *           sources never merge into "unregistered.condition".
 *   OPS-04  acknowledging or suppressing the only CRITICAL condition leaves
 *           Workspace Health CRITICAL; a never-scanned clear workspace is
 *           UNKNOWN, never HEALTHY.
 *   OPS-05  an unreadable summary reports null counts, never zeros.
 *   OPS-06  the default queue is the unresolved set; resolved history is
 *           listed only when asked; grouping is not cut at the first page.
 *   OPS-07  the grouped read honours the SLA filter exactly.
 *   OPS-08  the recovery sweep closes every recovered condition past 200.
 *   OPS-09  a Worker-written condition opens an SLA cycle.
 *   P3      compare-and-set transitions, NEW_CONDITION recurrence, current
 *           severity on reopen, a fresh SLA promise on unsuppress, eligible
 *           assignees only, trashed-record integrity closure, a stable 400
 *           for a garbage Enterprise cursor, and active-member telemetry.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addMember,
  bootOps,
  makeUser,
  makeWorkspace,
  personalSpace,
  seedEvidence,
  seedIncident,
  type Ctx,
} from "./operations-truth-fixtures.js";

describe("Operations remediation closure (live PostgreSQL 16)", () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await bootOps();
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  async function teamWorkspace(tag: string) {
    const owner = await makeUser(c, tag, { plan: "TEAM" });
    const ws = await makeWorkspace(c, owner.id, {
      name: tag,
      kind: "OWNED",
      billingPlan: "TEAM",
      billingStatus: "ACTIVE",
    });
    return { owner, teamId: ws.teamId, orgId: ws.orgId };
  }

  it("OPS-01 a Personal null-team record is remediable from Operations, and a second click is deduplicated", async () => {
    const u = await makeUser(c, "closure-personal", { plan: "PRO" });
    const space = await personalSpace(c, u.id);
    const ev = await seedEvidence(c, null, u.id);
    const { recordReportFailureIncident } = await import("../../worker/src/processor.js");
    await recordReportFailureIncident({
      evidenceId: ev.id,
      jobId: "closure-job",
      error: new Error("render failed"),
      severity: "CRITICAL",
      retriable: false,
    });
    const row = await c.prisma.operationalIncident.findFirstOrThrow({ where: { relatedEvidenceId: ev.id } });
    expect(row.teamId).toBe(space);

    const detail = await c.inj("GET", `/v1/ops/incidents/${row.id}?teamId=${space}`, u.token);
    expect(detail.statusCode).toBe(200);
    const first = await c.inj("POST", `/v1/ops/incidents/${row.id}/remediate`, u.token, {
      teamId: space,
      actionId: "report.regenerate_artifacts",
    });
    expect(first.statusCode).toBe(202);
    expect(first.json().remediation.result).toBe("QUEUED");
    const second = await c.inj("POST", `/v1/ops/incidents/${row.id}/remediate`, u.token, {
      teamId: space,
      actionId: "report.regenerate_artifacts",
    });
    expect(second.json().remediation.result).toBe("ALREADY_IN_PROGRESS");
    // ONE canonical output request, whichever surface asked.
    const requests = await c.prisma.reportGenerationRequest.count({ where: { evidenceId: ev.id } });
    expect(requests).toBe(1);
  });

  it("OPS-09 a Worker-written condition opens its SLA cycle", async () => {
    const { owner, teamId } = await teamWorkspace("closure-worker-sla");
    const ev = await seedEvidence(c, teamId, owner.id);
    const { recordReportFailureIncident } = await import("../../worker/src/processor.js");
    await recordReportFailureIncident({
      evidenceId: ev.id,
      jobId: "closure-sla",
      error: new Error("render failed"),
      severity: "HIGH",
      retriable: false,
    });
    const row = await c.prisma.operationalIncident.findFirstOrThrow({ where: { relatedEvidenceId: ev.id } });
    const cycles = await c.prisma.operationalIncidentSlaCycle.findMany({ where: { incidentId: row.id } });
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.endedAtUtc).toBeNull();
  });

  it("OPS-03 two different sources are two summary groups, each with its own source", async () => {
    const { owner, teamId } = await teamWorkspace("closure-groups");
    const ev = await seedEvidence(c, teamId, owner.id);
    await seedIncident(c, teamId, {
      sourceId: "pipeline.package_generation_failed",
      category: "PACKAGE",
      fingerprint: `PACKAGE:${ev.id}:v1:UNCLASSIFIED`,
      relatedEvidenceId: ev.id,
    });
    await seedIncident(c, teamId, {
      sourceId: "billing.dependent_cancellation_failed",
      category: "STORAGE",
      fingerprint: `billing_dependent_cancellation:${randomUUID()}`,
    });
    const s = await c.inj("GET", `/v1/ops/summary?teamId=${teamId}`, owner.token);
    const keys = (s.json().summary.groups as Array<{ sourceId: string }>).map((g) => g.sourceId).sort();
    expect(keys).toEqual(["billing.dependent_cancellation_failed", "pipeline.package_generation_failed"]);
  });

  it("OPS-04 acknowledged or suppressed CRITICAL keeps Health CRITICAL; a never-scanned clear workspace is UNKNOWN", async () => {
    const { owner, teamId } = await teamWorkspace("closure-health");
    const empty = await c.inj("GET", `/v1/teams/${teamId}/operations/health`, owner.token);
    expect(empty.json().state).toBe("UNKNOWN");
    expect(empty.json().unknownReason).toBe("NEVER_RUN");

    const inc = await seedIncident(c, teamId, { severity: "CRITICAL", sourceId: "review.escalation_storm", category: "GOVERNANCE" });
    const ack = await c.inj("POST", `/v1/ops/incidents/${inc.id}/ack`, owner.token, { teamId });
    expect(ack.statusCode).toBe(200);
    const afterAck = await c.inj("GET", `/v1/teams/${teamId}/operations/health`, owner.token);
    expect(afterAck.json().state).toBe("CRITICAL");
    expect(afterAck.json().unresolvedIncidents).toBe(1);
    expect(afterAck.json().untriagedIncidents).toBe(0);

    const sup = await c.inj("POST", `/v1/ops/incidents/${inc.id}/suppress`, owner.token, { teamId, reason: "known noisy" });
    expect(sup.statusCode).toBe(200);
    const afterSuppress = await c.inj("GET", `/v1/teams/${teamId}/operations/health`, owner.token);
    expect(afterSuppress.json().state).toBe("CRITICAL");
    const s = await c.inj("GET", `/v1/ops/summary?teamId=${teamId}`, owner.token);
    expect(s.json().summary.open).toBe(1);
    expect(s.json().summary.critical).toBe(1);
  });

  it("OPS-05 an unreadable summary is null, never zero", async () => {
    const { owner, teamId } = await teamWorkspace("closure-unknown");
    await seedIncident(c, teamId, { severity: "CRITICAL" });
    const summary = await import("../src/services/operations/operations-summary.service.js");
    const broken = new Proxy(c.prisma, {
      get(target, prop) {
        if (prop === "operationalIncident") {
          return {
            ...target.operationalIncident,
            findMany: async () => {
              throw new Error("connection reset");
            },
          };
        }
        return Reflect.get(target, prop);
      },
    });
    const s = await summary.buildOperationsSummary({ workspaceId: teamId, viewerUserId: owner.id }, broken as never);
    expect(s.complete).toBe(false);
    expect(s.incompleteReason).toBe("SOURCE_FAILED");
    for (const k of ["open", "critical", "high", "warning", "info", "acknowledged", "assignedToMe", "unassigned", "slaBreached", "slaAtRisk", "resolved"] as const) {
      expect(s[k], k).toBeNull();
    }
    expect(s.mayAssertAllClear).toBe(false);
  });

  it("OPS-06 the default queue is unresolved; resolved history is listed only when asked; groups are not cut at one page", async () => {
    const { owner, teamId } = await teamWorkspace("closure-default");
    for (let i = 0; i < 5; i++) {
      await seedIncident(c, teamId, {
        status: "RESOLVED",
        sourceId: i < 3 ? "review.escalation_storm" : "identity.runtime_block",
        category: i < 3 ? "GOVERNANCE" : "IDENTITY_SECURITY",
      });
    }
    const open = await seedIncident(c, teamId, { severity: "HIGH", sourceId: "review.escalation_storm", category: "GOVERNANCE" });
    const suppressed = await seedIncident(c, teamId, { severity: "WARNING", status: "SUPPRESSED", sourceId: "identity.high_risk_session_surge", category: "IDENTITY_SECURITY" });

    const list = await c.inj("GET", `/v1/ops/incidents?teamId=${teamId}`, owner.token);
    const ids = (list.json().incidents as Array<{ id: string }>).map((r) => r.id).sort();
    expect(ids).toEqual([open.id, suppressed.id].sort());
    const all = await c.inj("GET", `/v1/ops/incidents?teamId=${teamId}&status=ALL`, owner.token);
    expect(all.json().incidents).toHaveLength(7);
    const s = await c.inj("GET", `/v1/ops/summary?teamId=${teamId}`, owner.token);
    expect(s.json().summary.open).toBe(2);
    expect(s.json().summary.resolved).toBe(5);

    // 520 more unresolved conditions: the grouped read reaches all of them and
    // still sees the suppressed group a single 500-row page used to drop.
    const ev = await seedEvidence(c, teamId, owner.id);
    await c.prisma.operationalIncident.createMany({
      data: Array.from({ length: 520 }, (_, i) => ({
        teamId,
        scope: "WORKSPACE" as const,
        sourceId: "evidence_integrity.ots_budget_exhausted",
        category: "WORKER" as const,
        severity: "HIGH" as const,
        status: "OPEN" as const,
        fingerprint: `OTS:${randomUUID()}:GLOBAL_BUDGET_EXHAUSTED:${i}`,
        title: "closure bulk",
        safeSummary: "closure bulk",
        relatedEvidenceId: ev.id,
        updatedAt: new Date(),
      })),
    });
    const g = await c.inj("GET", `/v1/ops/incident-groups?teamId=${teamId}`, owner.token);
    expect(g.statusCode).toBe(200);
    expect(g.json().completeness.complete).toBe(true);
    expect(g.json().totals.conditions).toBe(522);
    const sources = (g.json().groups as Array<{ sourceId: string }>).map((x) => x.sourceId).sort();
    expect(sources).toEqual(
      ["evidence_integrity.ots_budget_exhausted", "identity.high_risk_session_surge", "review.escalation_storm"].sort(),
    );
  });

  it("OPS-07 the grouped read applies the SLA filter exactly", async () => {
    const { owner, teamId } = await teamWorkspace("closure-sla-filter");
    await seedIncident(c, teamId, { severity: "HIGH" }); // seeded with no SLA cycle: UNTRACKED_LEGACY
    const untracked = await c.inj("GET", `/v1/ops/incident-groups?teamId=${teamId}&sla=UNTRACKED_LEGACY`, owner.token);
    expect(untracked.json().totals.conditions).toBe(1);
    const onTrack = await c.inj("GET", `/v1/ops/incident-groups?teamId=${teamId}&sla=ON_TRACK`, owner.token);
    expect(onTrack.json().totals.conditions).toBe(0);
  });

  it("OPS-08 the recovery sweep closes every recovered condition past the 200-row page", async () => {
    const { owner, teamId } = await teamWorkspace("closure-sweep");
    const N = 230;
    const evIds: string[] = [];
    for (let i = 0; i < N; i++) {
      const ev = await seedEvidence(c, teamId, owner.id, {
        otsStatus: "ANCHORED",
        otsAnchoredAtUtc: new Date(),
        otsBitcoinTxid: "c".repeat(64),
      });
      evIds.push(ev.id);
    }
    await c.prisma.operationalIncident.createMany({
      data: evIds.map((id) => ({
        teamId,
        scope: "WORKSPACE" as const,
        sourceId: "evidence_integrity.ots_budget_exhausted",
        category: "WORKER" as const,
        severity: "HIGH" as const,
        status: "OPEN" as const,
        fingerprint: `OTS:${id}:GLOBAL_BUDGET_EXHAUSTED`,
        title: "closure sweep",
        safeSummary: "closure sweep",
        relatedEvidenceId: id,
        updatedAt: new Date(),
      })),
    });
    const { sweepSourceTruthRecoveries } = await import("../src/services/operations/source-truth-recovery.service.js");
    const sweep = await sweepSourceTruthRecoveries({ teamId, sourceId: "evidence_integrity.ots_budget_exhausted" });
    expect(sweep.truncated).toBe(false);
    expect(sweep.resolved).toBe(N);
    const stillOpen = await c.prisma.operationalIncident.count({
      where: { teamId, sourceId: "evidence_integrity.ots_budget_exhausted", status: { not: "RESOLVED" } },
    });
    expect(stillOpen).toBe(0);
  }, 600_000);

  it("P3 an acknowledgement that lost a race to an auto-resolution is refused, never written", async () => {
    const { owner, teamId } = await teamWorkspace("closure-cas");
    const inc = await seedIncident(c, teamId, { severity: "HIGH" });
    const incidents = await import("../src/services/observability/incident.service.js");
    // The sweep resolves the row between the transition's read and its write.
    const racing = new Proxy(c.prisma, {
      get(target, prop) {
        if (prop === "operationalIncident") {
          return new Proxy(target.operationalIncident, {
            get(t, p) {
              if (p === "updateMany") {
                return async (args: never) => {
                  await target.operationalIncident.update({
                    where: { id: inc.id },
                    data: { status: "RESOLVED", resolvedAtUtc: new Date() },
                  });
                  return (t as unknown as { updateMany: (a: never) => unknown }).updateMany(args);
                };
              }
              return Reflect.get(t, p);
            },
          });
        }
        return Reflect.get(target, prop);
      },
    });
    await expect(
      incidents.acknowledgeIncident({ incidentId: inc.id, teamId, actorUserId: owner.id }, racing as never),
    ).rejects.toMatchObject({ code: "CONDITION_STATE_CHANGED" });
    const row = await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: inc.id } });
    expect(row.status).toBe("RESOLVED");
    expect(row.acknowledgedAtUtc).toBeNull();
  });

  it("P3 a stale source recovery never closes a condition that reopened in between", async () => {
    const { teamId } = await teamWorkspace("closure-cas-recovery");
    const inc = await seedIncident(c, teamId, { severity: "HIGH", status: "ACKNOWLEDGED" });
    const incidents = await import("../src/services/observability/incident.service.js");
    const racing = new Proxy(c.prisma, {
      get(target, prop) {
        if (prop === "operationalIncident") {
          return new Proxy(target.operationalIncident, {
            get(t, p) {
              if (p === "updateMany") {
                return async (args: never) => {
                  await target.operationalIncident.update({ where: { id: inc.id }, data: { status: "OPEN" } });
                  return (t as unknown as { updateMany: (a: never) => unknown }).updateMany(args);
                };
              }
              return Reflect.get(t, p);
            },
          });
        }
        return Reflect.get(target, prop);
      },
    });
    const out = await incidents.resolveConditionFromSourceRecovery(
      { teamId, fingerprint: inc.fingerprint, safeMessage: "recovered" },
      racing as never,
    );
    expect(out.resolved).toBe(false);
    expect((await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: inc.id } })).status).toBe("OPEN");
  });

  it("P3 a NEW_CONDITION source never reopens a resolved bucket; other sources reopen at the CURRENT severity", async () => {
    const { owner, teamId } = await teamWorkspace("closure-recurrence");
    const incidents = await import("../src/services/observability/incident.service.js");
    const storm = await seedIncident(c, teamId, {
      status: "RESOLVED",
      sourceId: "review.escalation_storm",
      category: "GOVERNANCE",
      fingerprint: `review-escalation-storm:${randomUUID()}`,
    });
    await incidents.recordIncident({
      teamId,
      sourceId: "review.escalation_storm",
      category: "GOVERNANCE",
      severity: "HIGH",
      fingerprint: storm.fingerprint,
      title: "storm",
      safeSummary: "storm",
    } as never);
    expect((await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: storm.id } })).status).toBe("RESOLVED");
    const evts = await c.prisma.operationalIncidentEvent.findMany({ where: { incidentId: storm.id } });
    expect(evts.map((e) => e.eventType)).toContain("occurrence_after_resolution");

    const ev = await seedEvidence(c, teamId, owner.id);
    const block = await seedIncident(c, teamId, {
      status: "RESOLVED",
      severity: "CRITICAL",
      sourceId: "pipeline.package_generation_failed",
      category: "PACKAGE",
      fingerprint: `PACKAGE:${ev.id}:v1:UNCLASSIFIED`,
      relatedEvidenceId: ev.id,
    });
    await incidents.recordIncident({
      teamId,
      sourceId: "pipeline.package_generation_failed",
      category: "PACKAGE",
      severity: "WARNING",
      fingerprint: block.fingerprint,
      title: "package failed",
      safeSummary: "package failed",
      relatedEvidenceId: ev.id,
    } as never);
    const reopened = await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: block.id } });
    expect(reopened.status).toBe("OPEN");
    expect(reopened.severity).toBe("WARNING");
  });

  it("P3 unsuppress starts a fresh SLA promise", async () => {
    const { owner, teamId } = await teamWorkspace("closure-unsuppress");
    const incidents = await import("../src/services/observability/incident.service.js");
    await incidents.recordIncident({
      teamId,
      sourceId: "review.escalation_storm",
      category: "GOVERNANCE",
      severity: "HIGH",
      fingerprint: `review-escalation-storm:${randomUUID()}`,
      title: "storm",
      safeSummary: "storm",
    } as never);
    const row = await c.prisma.operationalIncident.findFirstOrThrow({ where: { teamId } });
    await c.inj("POST", `/v1/ops/incidents/${row.id}/suppress`, owner.token, { teamId, reason: "pausing" });
    const resumed = await c.inj("POST", `/v1/ops/incidents/${row.id}/unsuppress`, owner.token, { teamId });
    expect(resumed.statusCode).toBe(200);
    const cycles = await c.prisma.operationalIncidentSlaCycle.findMany({
      where: { incidentId: row.id },
      orderBy: { cycleNumber: "asc" },
    });
    expect(cycles.length).toBe(2);
    expect(cycles[0]!.endedAtUtc).not.toBeNull();
    expect(cycles[1]!.endedAtUtc).toBeNull();
  });

  it("P3 a suspended member is not an eligible assignee", async () => {
    const { owner, teamId } = await teamWorkspace("closure-assign");
    const active = await makeUser(c, "closure-assign-active");
    const suspended = await makeUser(c, "closure-assign-suspended");
    await addMember(c, teamId, active.id, "ADMIN");
    await addMember(c, teamId, suspended.id, "ADMIN", "SUSPENDED");
    const inc = await seedIncident(c, teamId, { severity: "HIGH" });
    const refused = await c.inj("POST", `/v1/ops/incidents/${inc.id}/assign`, owner.token, { teamId, assigneeUserId: suspended.id });
    expect(refused.statusCode).toBe(400);
    const incidents = await import("../src/services/observability/incident.service.js");
    await expect(
      incidents.assignIncident({ scope: "PLATFORM_ADMIN", incidentId: inc.id, assigneeUserId: suspended.id, actorUserId: owner.id }),
    ).rejects.toMatchObject({ code: "invalid_assignee" });
  });

  it("P3 an integrity condition on a trashed record is closed as no longer applicable, never as recovered", async () => {
    const { owner, teamId } = await teamWorkspace("closure-trash");
    const ev = await seedEvidence(c, teamId, owner.id, { tsaStatus: "FAILED", deletedAt: new Date() });
    const inc = await seedIncident(c, teamId, {
      sourceId: "evidence_integrity.tsa_failed",
      category: "EVIDENCE_INTEGRITY",
      fingerprint: `tsa_failure:${ev.id}`,
      relatedEvidenceId: ev.id,
    });
    const { syncEvidenceIntegrityConditions } = await import("../src/services/operations/evidence-integrity-conditions.service.js");
    await syncEvidenceIntegrityConditions({ teamId } as never);
    const row = await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: inc.id } });
    expect(row.status).toBe("RESOLVED");
    const evts = await c.prisma.operationalIncidentEvent.findMany({ where: { incidentId: inc.id } });
    expect(evts.map((e) => e.eventType)).toContain("closed_record_trashed");
    expect(evts.map((e) => e.eventType)).not.toContain("resolved_by_domain_truth");
  });

  it("P3 a garbage Enterprise drill-down cursor is a stable 400", async () => {
    const { owner, orgId } = await teamWorkspace("closure-cursor");
    const r = await c.inj("GET", `/v1/orgs/${orgId}/operations/incidents?cursor=not-a-cursor`, owner.token);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("invalid_cursor");
  });

  it("P3 upload telemetry refuses a suspended member", async () => {
    const { teamId } = await teamWorkspace("closure-telemetry");
    const s = await makeUser(c, "closure-telemetry-suspended");
    await addMember(c, teamId, s.id, "MEMBER", "SUSPENDED");
    const r = await c.inj("POST", "/v1/ops/upload-telemetry", s.token, {
      teamId,
      events: [{ type: "upload_retry_total", count: 1000 }],
    });
    expect(r.statusCode).toBe(403);
  });
});
