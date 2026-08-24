/**
 * INCIDENT SLA HISTORY — the immutability contract, proven against live
 * PostgreSQL 16.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE EXISTS TO PREVENT
 * ---------------------------------------------------------------------------
 * A deadline that moves when the policy moves is not a deadline. If a
 * workspace tightens its SLA from 24 hours to 4, every condition already
 * open — including ones that were comfortably on time — retroactively becomes
 * a breach that nobody could have prevented. Loosen it instead, and yesterday's
 * real breaches quietly disappear from the record.
 *
 * Both directions are the same defect: the promise a workspace made about a
 * specific condition is a HISTORICAL FACT, and a system that recomputes it
 * from today's configuration cannot report on its own past.
 *
 * Every case below drives the REAL authorities — the policy writer, the
 * incident lifecycle and the projection the routes serve — against a live
 * database. None of them reads the UI, because the UI showing the right thing
 * over a wrong projection is exactly how this defect survives.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT FABRICATED
 * ---------------------------------------------------------------------------
 * An incident that predates the SLA authority has no recorded promise, and
 * this suite proves the system says so rather than applying today's policy to
 * it. Inventing a deadline for a historical record — and then counting it as
 * a breach — would manufacture a failure that never happened.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Incident SLA history (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  let A: { teamId: string; ownerToken: string; ownerUserId: string };
  let B: { teamId: string; ownerToken: string; ownerUserId: string };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    A = {
      teamId: harness.fixtures.teamA.teamId,
      ownerToken: harness.fixtures.teamA.ownerToken,
      ownerUserId: harness.fixtures.teamA.ownerUserId,
    };
    B = {
      teamId: harness.fixtures.teamB.teamId,
      ownerToken: harness.fixtures.teamB.ownerToken,
      ownerUserId: harness.fixtures.teamB.ownerUserId,
    };
  }, 240_000);

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  beforeEach(async () => {
    await prisma.operationalIncident
      .deleteMany({ where: { teamId: { in: [A.teamId, B.teamId] } } })
      .catch(() => null);
  });

  // -------------------------------------------------------------------------
  // Helpers — all through the canonical authorities, never by hand-writing rows
  // -------------------------------------------------------------------------

  async function setPolicy(
    teamId: string,
    actorUserId: string,
    hours: { firstReviewHours: number; completionHours: number; dueSoonHours: number },
  ) {
    const { upsertWorkspaceSlaPolicy } = await import(
      "../src/services/reviewer-ops/sla-policy.service.js"
    );
    return upsertWorkspaceSlaPolicy({
      teamId,
      actorUserId,
      overrides: hours,
    });
  }

  /** Open a condition through the canonical lifecycle, aged as asked. */
  async function open(input: {
    teamId: string;
    hoursAgo?: number;
    severity?: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  }) {
    const at = new Date(Date.now() - (input.hoursAgo ?? 1) * 3_600_000);
    const { recordIncident } = await import(
      "../src/services/observability/incident.service.js"
    );
    const result = await recordIncident({
      teamId: input.teamId,
      category: "EVIDENCE_INTEGRITY",
      severity: (input.severity ?? "HIGH") as never,
      fingerprint: `ots_failure:${randomUUID()}`,
      title: "Anchoring failed",
      safeSummary: "The anchoring step did not complete.",
    });
    // Age the recorded observation.
    //
    // In production the incident and its SLA cycle are written in the same
    // instant, so a condition that opened ten hours ago has a cycle that
    // STARTED ten hours ago and deadlines measured from then. The fixture
    // reproduces that state rather than only back-dating one half of it —
    // back-dating the incident alone would leave a cycle stamped "now",
    // which is a shape production never produces.
    //
    // The targets themselves are untouched: they are the promise the policy
    // made, and rewriting them here would be the fixture deciding the answer.
    await prisma.operationalIncident.update({
      where: { id: result.incident.id },
      data: { firstSeenAtUtc: at, lastSeenAtUtc: at },
    });
    const written = await prisma.operationalIncidentSlaCycle.findFirst({
      where: { incidentId: result.incident.id },
    });
    if (written) {
      await prisma.operationalIncidentSlaCycle.update({
        where: { id: written.id },
        data: {
          startedAtUtc: at,
          acknowledgementDueAtUtc:
            written.acknowledgementTargetHours === null
              ? null
              : new Date(
                  at.getTime() + written.acknowledgementTargetHours * 3_600_000,
                ),
          resolutionDueAtUtc:
            written.resolutionTargetHours === null
              ? null
              : new Date(
                  at.getTime() + written.resolutionTargetHours * 3_600_000,
                ),
        },
      });
    }
    return result.incident.id;
  }

  async function slaOf(teamId: string, token: string, incidentId: string) {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/ops/incidents/${incidentId}?teamId=${teamId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).incident.sla as {
      posture: string;
      obligation: string;
      dueAtUtc: string | null;
      targetHours: number | null;
      policyVersionId?: string | null;
    } | null;
  }

  async function summaryOf(teamId: string, token: string) {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/ops/summary?teamId=${teamId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).summary as Record<string, number>;
  }

  // =========================================================================
  // 1. IMMUTABILITY — the whole point
  // =========================================================================

  describe("a policy change never moves an existing condition's deadline", () => {
    it("RISK 1 — tightening 24h → 4h does not retroactively breach an open condition", async () => {
      await setPolicy(A.teamId, A.ownerUserId, {
        firstReviewHours: 24,
        completionHours: 72,
        dueSoonHours: 2,
      });
      const id = await open({ teamId: A.teamId, hoursAgo: 6 });
      const before = await slaOf(A.teamId, A.ownerToken, id);
      expect(before?.targetHours).toBe(24);
      expect(before?.posture).toBe("ON_TRACK");

      // The workspace tightens its promise. That is a decision about FUTURE
      // work; it cannot make yesterday's six-hour-old condition late.
      await setPolicy(A.teamId, A.ownerUserId, {
        firstReviewHours: 4,
        completionHours: 24,
        dueSoonHours: 1,
      });

      const after = await slaOf(A.teamId, A.ownerToken, id);
      expect(after?.targetHours, "the governing target must not change").toBe(24);
      expect(after?.dueAtUtc, "the deadline must not move").toBe(before?.dueAtUtc);
      expect(after?.posture, "a compliant condition must not become a breach").toBe(
        "ON_TRACK",
      );
    });

    it("RISK 2 — loosening 4h → 72h does not erase a real breach", async () => {
      await setPolicy(A.teamId, A.ownerUserId, {
        firstReviewHours: 4,
        completionHours: 24,
        dueSoonHours: 1,
      });
      const id = await open({ teamId: A.teamId, hoursAgo: 10 });
      expect((await slaOf(A.teamId, A.ownerToken, id))?.posture).toBe("BREACHED");

      await setPolicy(A.teamId, A.ownerUserId, {
        firstReviewHours: 72,
        completionHours: 168,
        dueSoonHours: 4,
      });

      const after = await slaOf(A.teamId, A.ownerToken, id);
      // A breach that happened, happened. Loosening the policy afterwards is
      // not a way to un-miss a deadline.
      expect(after?.posture, "a real breach must survive a loosened policy").toBe(
        "BREACHED",
      );
      expect(after?.targetHours).toBe(4);
    });

    it("RISK 14 — the recorded deadline is byte-stable across repeated policy edits", async () => {
      await setPolicy(A.teamId, A.ownerUserId, {
        firstReviewHours: 8,
        completionHours: 48,
        dueSoonHours: 2,
      });
      const id = await open({ teamId: A.teamId, hoursAgo: 1 });
      const first = await slaOf(A.teamId, A.ownerToken, id);

      for (const h of [3, 40, 12, 96]) {
        await setPolicy(A.teamId, A.ownerUserId, {
          firstReviewHours: h,
          completionHours: h * 4,
          dueSoonHours: 1,
        });
        const now = await slaOf(A.teamId, A.ownerToken, id);
        expect(now?.dueAtUtc).toBe(first?.dueAtUtc);
        expect(now?.targetHours).toBe(first?.targetHours);
      }
    });

    it("a policy edit governs the NEXT condition, which is what a policy is for", async () => {
      await setPolicy(A.teamId, A.ownerUserId, {
        firstReviewHours: 24,
        completionHours: 72,
        dueSoonHours: 2,
      });
      const older = await open({ teamId: A.teamId, hoursAgo: 1 });

      await setPolicy(A.teamId, A.ownerUserId, {
        firstReviewHours: 4,
        completionHours: 24,
        dueSoonHours: 1,
      });
      const newer = await open({ teamId: A.teamId, hoursAgo: 1 });

      expect((await slaOf(A.teamId, A.ownerToken, older))?.targetHours).toBe(24);
      expect((await slaOf(A.teamId, A.ownerToken, newer))?.targetHours).toBe(4);
    });

    it("workspace B's policy edit cannot touch workspace A's deadlines", async () => {
      await setPolicy(A.teamId, A.ownerUserId, {
        firstReviewHours: 12,
        completionHours: 48,
        dueSoonHours: 2,
      });
      const id = await open({ teamId: A.teamId, hoursAgo: 1 });
      const before = await slaOf(A.teamId, A.ownerToken, id);

      await setPolicy(B.teamId, B.ownerUserId, {
        firstReviewHours: 1,
        completionHours: 2,
        dueSoonHours: 1,
      });

      const after = await slaOf(A.teamId, A.ownerToken, id);
      expect(after?.dueAtUtc).toBe(before?.dueAtUtc);
      expect(after?.targetHours).toBe(12);
    });
  });

  // =========================================================================
  // 2. LEGACY — no invented history
  // =========================================================================

  describe("conditions with no recorded promise", () => {
    it("RISK 3 — a legacy condition is UNTRACKED_LEGACY, not measured against today", async () => {
      await setPolicy(A.teamId, A.ownerUserId, {
        firstReviewHours: 4,
        completionHours: 24,
        dueSoonHours: 1,
      });
      const id = await open({ teamId: A.teamId, hoursAgo: 500 });
      // Simulate a condition that predates the SLA authority by removing the
      // cycle the lifecycle wrote. This is the ONLY hand-edit in the suite and
      // it exists to reproduce a row shape that really is in the database.
      await prisma.operationalIncidentSlaCycle.deleteMany({
        where: { incidentId: id },
      });

      const sla = await slaOf(A.teamId, A.ownerToken, id);
      expect(sla?.posture).toBe("UNTRACKED_LEGACY");
      // No invented deadline, and no invented promise.
      expect(sla?.dueAtUtc).toBeNull();
      expect(sla?.targetHours).toBeNull();
    });

    it("a legacy condition does not inflate the breach counter", async () => {
      await setPolicy(A.teamId, A.ownerUserId, {
        firstReviewHours: 4,
        completionHours: 24,
        dueSoonHours: 1,
      });
      const legacy = await open({ teamId: A.teamId, hoursAgo: 500 });
      await prisma.operationalIncidentSlaCycle.deleteMany({
        where: { incidentId: legacy },
      });

      const s = await summaryOf(A.teamId, A.ownerToken);
      // It is 500 hours old and would breach any policy — but nobody ever
      // promised anything about it, so counting it as a broken promise would
      // manufacture a failure that never happened.
      expect(s.slaBreached).toBe(0);
    });

    it("RISK 10 — a condition opened with no policy configured is NOT_APPLICABLE", async () => {
      // Workspace B has no governance policy row in this test.
      await prisma.workspaceGovernancePolicy
        .deleteMany({ where: { teamId: B.teamId } })
        .catch(() => null);
      const id = await open({ teamId: B.teamId, hoursAgo: 400 });
      const sla = await slaOf(B.teamId, B.ownerToken, id);
      // The shared defaults are a fallback for REVIEW work, not a promise this
      // workspace made. Absent a configured policy the honest answer is that
      // no commitment applies.
      expect(["NOT_APPLICABLE", "UNTRACKED_LEGACY"]).toContain(sla?.posture);
      expect(sla?.dueAtUtc).toBeNull();
    });

    it("a legacy condition is still operationally actionable", async () => {
      const id = await open({ teamId: A.teamId, hoursAgo: 500 });
      await prisma.operationalIncidentSlaCycle.deleteMany({
        where: { incidentId: id },
      });
      // Having no recorded promise is not a reason to withhold the work.
      const res = await harness.app.inject({
        method: "POST",
        url: `/v1/ops/incidents/${id}/ack`,
        headers: { authorization: `Bearer ${A.ownerToken}` },
        payload: { teamId: A.teamId } as never,
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // =========================================================================
  // 3. LIFECYCLE
  // =========================================================================

  describe("lifecycle", () => {
    beforeEach(async () => {
      await setPolicy(A.teamId, A.ownerUserId, {
        firstReviewHours: 4,
        completionHours: 24,
        dueSoonHours: 2,
      });
    });

    async function transition(id: string, verb: string, payload = {}) {
      return harness.app.inject({
        method: "POST",
        url: `/v1/ops/incidents/${id}/${verb}`,
        headers: { authorization: `Bearer ${A.ownerToken}` },
        payload: { teamId: A.teamId, ...payload } as never,
      });
    }

    it("RISK 6 — acknowledgement stops the acknowledgement clock only", async () => {
      const id = await open({ teamId: A.teamId, hoursAgo: 1 });
      await transition(id, "ack");
      const sla = await slaOf(A.teamId, A.ownerToken, id);
      expect(sla?.posture).toBe("ACKNOWLEDGED");
      // The resolution clock is still running, and still measured from the
      // original observation — acknowledging late does not buy a fresh window.
      expect(sla?.obligation).toBe("RESOLUTION");
      expect(sla?.targetHours).toBe(24);
    });

    it("acknowledging late does not erase the acknowledgement breach", async () => {
      const id = await open({ teamId: A.teamId, hoursAgo: 10 });
      expect((await slaOf(A.teamId, A.ownerToken, id))?.posture).toBe("BREACHED");
      await transition(id, "ack");
      const cycle = await prisma.operationalIncidentSlaCycle.findFirst({
        where: { incidentId: id },
      });
      // The posture moves on; the FACT that the promise was missed is kept.
      expect(cycle?.acknowledgementBreached).toBe(true);
    });

    it("RISK 7 — a resolved condition reports RESOLVED", async () => {
      const id = await open({ teamId: A.teamId, hoursAgo: 1 });
      await transition(id, "resolve", { resolutionNote: "The provider recovered." });
      expect((await slaOf(A.teamId, A.ownerToken, id))?.posture).toBe("RESOLVED");
    });

    it("resolution closes the cycle and records whether it was met", async () => {
      const id = await open({ teamId: A.teamId, hoursAgo: 1 });
      await transition(id, "resolve", { resolutionNote: "Recovered." });
      const cycle = await prisma.operationalIncidentSlaCycle.findFirst({
        where: { incidentId: id },
      });
      expect(cycle?.endedAtUtc).toBeTruthy();
      expect(cycle?.endReason).toBe("RESOLVED");
      expect(cycle?.resolutionBreached).toBe(false);
    });

    it("RISK 8 — reopening starts a NEW cycle and preserves the completed one", async () => {
      const id = await open({ teamId: A.teamId, hoursAgo: 1 });
      await transition(id, "resolve", { resolutionNote: "Recovered." });

      // The source condition recurs. The canonical opener is the reopen path.
      const { recordIncident } = await import(
        "../src/services/observability/incident.service.js"
      );
      const existing = await prisma.operationalIncident.findUniqueOrThrow({
        where: { id },
      });
      await recordIncident({
        teamId: A.teamId,
        category: existing.category as never,
        severity: existing.severity as never,
        fingerprint: existing.fingerprint,
        title: existing.title,
        safeSummary: existing.safeSummary,
      });

      const cycles = await prisma.operationalIncidentSlaCycle.findMany({
        where: { incidentId: id },
        orderBy: { cycleNumber: "asc" },
      });
      expect(cycles.length, "a reopen must not overwrite the prior cycle").toBe(2);
      expect(cycles[0].endedAtUtc).toBeTruthy();
      expect(cycles[1].endedAtUtc).toBeNull();
      expect(cycles[1].cycleNumber).toBe(2);
    });

    it("RISK 9 — suppression yields NOT_APPLICABLE and does not rewrite a breach", async () => {
      const id = await open({ teamId: A.teamId, hoursAgo: 10 });
      expect((await slaOf(A.teamId, A.ownerToken, id))?.posture).toBe("BREACHED");
      await transition(id, "suppress");

      expect((await slaOf(A.teamId, A.ownerToken, id))?.posture).toBe(
        "NOT_APPLICABLE",
      );
      const cycle = await prisma.operationalIncidentSlaCycle.findFirst({
        where: { incidentId: id },
      });
      // Silencing a condition is an instruction about NOTIFICATION. It is not
      // a way to delete the record of a missed promise.
      expect(cycle?.acknowledgementBreached).toBe(true);
    });

    it("RISK 4 — severity escalation never extends an existing deadline", async () => {
      const id = await open({ teamId: A.teamId, hoursAgo: 1, severity: "WARNING" });
      const before = await slaOf(A.teamId, A.ownerToken, id);

      const { escalateIncidentSeverity } = await import(
        "../src/services/operations/incident-sla-cycle.service.js"
      );
      await escalateIncidentSeverity({
        incidentId: id,
        teamId: A.teamId,
        severity: "CRITICAL",
      });

      const after = await slaOf(A.teamId, A.ownerToken, id);
      const beforeDue = Date.parse(before!.dueAtUtc!);
      const afterDue = Date.parse(after!.dueAtUtc!);
      expect(afterDue, "escalation may tighten, never extend").toBeLessThanOrEqual(
        beforeDue,
      );
    });

    it("RISK 5 — severity de-escalation does not erase a breach or extend the promise", async () => {
      const id = await open({ teamId: A.teamId, hoursAgo: 10, severity: "CRITICAL" });
      expect((await slaOf(A.teamId, A.ownerToken, id))?.posture).toBe("BREACHED");

      const { escalateIncidentSeverity } = await import(
        "../src/services/operations/incident-sla-cycle.service.js"
      );
      await escalateIncidentSeverity({
        incidentId: id,
        teamId: A.teamId,
        severity: "INFO",
      });

      const after = await slaOf(A.teamId, A.ownerToken, id);
      expect(after?.posture, "a breach survives a de-escalation").toBe("BREACHED");
    });
  });

  // =========================================================================
  // 4. CONSERVATION — row, detail and summary say the same thing
  // =========================================================================

  describe("one authority", () => {
    it("RISK 12/13 — the summary's SLA counters conserve against the listed rows", async () => {
      await setPolicy(A.teamId, A.ownerUserId, {
        firstReviewHours: 4,
        completionHours: 24,
        dueSoonHours: 2,
      });
      await open({ teamId: A.teamId, hoursAgo: 20 });
      await open({ teamId: A.teamId, hoursAgo: 12 });
      await open({ teamId: A.teamId, hoursAgo: 3 });
      await open({ teamId: A.teamId, hoursAgo: 0.1 });

      const list = JSON.parse(
        (
          await harness.app.inject({
            method: "GET",
            url: `/v1/ops/incidents?teamId=${A.teamId}&limit=500`,
            headers: { authorization: `Bearer ${A.ownerToken}` },
          })
        ).body,
      ).incidents as Array<{ sla: { posture: string } | null }>;

      const rowBreached = list.filter((i) => i.sla?.posture === "BREACHED").length;
      const rowAtRisk = list.filter((i) => i.sla?.posture === "AT_RISK").length;

      const s = await summaryOf(A.teamId, A.ownerToken);
      // A counter that disagrees with the list it summarises is worse than no
      // counter: the operator reads one and acts on the other.
      expect(s.slaBreached).toBe(rowBreached);
      expect(s.slaAtRisk).toBe(rowAtRisk);
    });

    it("the list and the detail report an identical posture for the same row", async () => {
      await setPolicy(A.teamId, A.ownerUserId, {
        firstReviewHours: 4,
        completionHours: 24,
        dueSoonHours: 2,
      });
      const id = await open({ teamId: A.teamId, hoursAgo: 3 });
      const listed = (
        JSON.parse(
          (
            await harness.app.inject({
              method: "GET",
              url: `/v1/ops/incidents?teamId=${A.teamId}`,
              headers: { authorization: `Bearer ${A.ownerToken}` },
            })
          ).body,
        ).incidents as Array<{ id: string; sla: unknown }>
      ).find((i) => i.id === id);
      expect((await slaOf(A.teamId, A.ownerToken, id)) as unknown).toEqual(
        listed?.sla,
      );
    });

    it("RISK 11 — a malformed persisted cycle fails closed rather than guessing", async () => {
      const id = await open({ teamId: A.teamId, hoursAgo: 3 });
      // A row whose targets cannot be trusted must not be measured.
      await prisma.operationalIncidentSlaCycle.updateMany({
        where: { incidentId: id },
        data: { acknowledgementTargetHours: -1, resolutionTargetHours: -1 },
      });
      const sla = await slaOf(A.teamId, A.ownerToken, id);
      expect(["UNTRACKED_LEGACY", "NOT_APPLICABLE"]).toContain(sla?.posture);
    });
  });
});
