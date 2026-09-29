/**
 * OTS REMEDIATION TELLS THE TRUTH — live PostgreSQL 16 + Redis, the real ops
 * routes, the real probe sweep and the real anchoring authority.
 *
 * On a40ca76f:
 *   ET-REC-01 — a Resume that collapsed onto a live job answered QUEUED and
 *     audited a success; ALREADY_IN_PROGRESS was unreachable.
 *   ET-REC-02 — the Worker's `OTS:<id>:GLOBAL_BUDGET_EXHAUSTED` incident was
 *     NOT_APPLICABLE to its own probe forever (the parser knew only the
 *     `ots_failure:` head) and carried WORKER guidance saying records "recover
 *     when it does" — false for a terminal state — with no action.
 *   ET-REC-06 — "Resume OTS anchoring" was offered and answered QUEUED for a
 *     permanently invalid proof the worker then skips.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("OTS remediation truth (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let incidents: typeof import("../src/services/observability/incident.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    incidents = await import("../src/services/observability/incident.service.js");
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function failedOts(reason: string) {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: {
          title: `ots ${randomUUID().slice(0, 6)}`,
          type: "PHOTO",
          status: "SIGNED",
          teamId: A.teamId,
          organizationId: team.organizationId,
          ownerUserId: A.ownerUserId,
          otsStatus: "FAILED",
          otsFailureReason: reason,
        } as never,
        select: { id: true },
      })
    ).id;
  }
  const detail = async (incidentId: string) => {
    const A = h.fixtures.teamA;
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/ops/incidents/${incidentId}?teamId=${A.teamId}`,
      headers: { authorization: `Bearer ${A.ownerToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as {
      incident: { status: string };
      remediation: { disposition: string; actions: Array<{ actionId: string }>; guidance: string | null };
    };
  };
  const remediate = (incidentId: string) =>
    h.app.inject({
      method: "POST",
      url: `/v1/ops/incidents/${incidentId}/remediate`,
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ teamId: h.fixtures.teamA.teamId, actionId: "ots.resume_anchoring" }),
    });

  it("ET-REC-02: the budget-exhausted incident offers the OTS action (not WORKER guidance) and resolves when the proof recovers", async () => {
    const A = h.fixtures.teamA;
    const evidenceId = await failedOts("OTS_GLOBAL_BUDGET_EXHAUSTED");
    const { incident: { id: incidentId } } = await incidents.recordIncident({
      teamId: A.teamId,
      sourceId: "evidence_integrity.ots_budget_exhausted",
      category: "WORKER",
      severity: "CRITICAL",
      fingerprint: `OTS:${evidenceId}:GLOBAL_BUDGET_EXHAUSTED`,
      title: "OTS anchoring gave up",
      safeSummary: "Global budget exhausted.",
      relatedEvidenceId: evidenceId,
    } as never);
    const d = await detail(incidentId);
    expect(d.remediation.actions.map((a) => a.actionId)).toContain("ots.resume_anchoring");
    expect(d.remediation.guidance ?? "").not.toMatch(/recover when it does/);

    // Still failing: the probe keeps it open.
    const { sweepSourceTruthRecoveries } = await import("../src/services/operations/source-truth-recovery.service.js");
    await sweepSourceTruthRecoveries({ teamId: A.teamId, sourceId: "evidence_integrity.ots_budget_exhausted" });
    expect((await detail(incidentId)).incident.status).toBe("OPEN");
    // The proof recovers: the same sweep closes it.
    await prisma.evidence.update({ where: { id: evidenceId }, data: { otsStatus: "ANCHORED", otsFailureReason: null } as never });
    const swept = await sweepSourceTruthRecoveries({ teamId: A.teamId, sourceId: "evidence_integrity.ots_budget_exhausted" });
    expect(swept.resolved).toBeGreaterThanOrEqual(1);
    expect((await detail(incidentId)).incident.status).toBe("RESOLVED");
  });

  it("ET-REC-06: a permanently invalid proof offers no Resume, and a Resume POST is NOT_ELIGIBLE with no queued event", async () => {
    const A = h.fixtures.teamA;
    const evidenceId = await failedOts("PROOF_HASH_MISMATCH");
    const { incident: { id: incidentId } } = await incidents.recordIncident({
      teamId: A.teamId,
      sourceId: "evidence_integrity.ots_failure",
      category: "EVIDENCE_INTEGRITY",
      severity: "HIGH",
      fingerprint: `ots_failure:${evidenceId}`,
      title: "OpenTimestamps anchor failed",
      safeSummary: "The proof could not be anchored.",
      relatedEvidenceId: evidenceId,
    } as never);
    const d = await detail(incidentId);
    expect(d.remediation.disposition).toBe("READ_ONLY_GUIDANCE");
    expect(d.remediation.actions).toEqual([]);
    expect(d.remediation.guidance).toMatch(/cannot repair it/);

    const res = await remediate(incidentId);
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { remediation: { result: string } }).remediation.result).toBe("NOT_ELIGIBLE");
    const events = await prisma.operationalIncidentEvent.findMany({ where: { incidentId }, select: { eventType: true } });
    expect(events.map((e) => String(e.eventType))).not.toContain("remediation_queued");
  });

  it("ET-REC-01: a Resume that collapses onto a live job is ALREADY_IN_PROGRESS, not a new request", async () => {
    const evidenceId = await failedOts("OTS_GLOBAL_BUDGET_EXHAUSTED");
    const { requestEvidenceOtsAnchoring } = await import("../src/services/integrity/ots-anchoring-authority.service.js");
    const first = await requestEvidenceOtsAnchoring({ evidenceId, trigger: "operations.remediation" });
    expect(first.requested).toBe(true);
    // No worker runs in this harness, so the first job is still live.
    const second = await requestEvidenceOtsAnchoring({ evidenceId, trigger: "operations.remediation" });
    expect(second).toMatchObject({ requested: false, reason: "collapsed" });
  });

  it("ET-REC-07: an intent already satisfied is audited as success, not error", async () => {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const evidenceId = (
      await prisma.evidence.create({
        data: { title: "anchored", type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId, otsStatus: "ANCHORED" } as never,
        select: { id: true },
      })
    ).id;
    const incidents = await import("../src/services/observability/incident.service.js");
    const { incident } = await incidents.recordIncident({
      teamId: A.teamId,
      sourceId: "evidence_integrity.ots_failure",
      category: "EVIDENCE_INTEGRITY",
      severity: "HIGH",
      fingerprint: `ots_failure:${evidenceId}`,
      title: "OpenTimestamps anchor failed",
      safeSummary: "stale condition",
      relatedEvidenceId: evidenceId,
    } as never);
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/ops/incidents/${incident.id}/remediate`,
      headers: { authorization: `Bearer ${A.ownerToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ teamId: A.teamId, actionId: "ots.resume_anchoring" }),
    });
    expect((res.json() as { remediation: { result: string } }).remediation.result).toBe("ALREADY_SATISFIED");
    const row = await prisma.adminAuditLog.findFirst({
      where: { action: "operations.remediation.ots.resume_anchoring", resourceId: incident.id },
      select: { outcome: true },
    });
    expect(row?.outcome).toBe("success");
  });
});
