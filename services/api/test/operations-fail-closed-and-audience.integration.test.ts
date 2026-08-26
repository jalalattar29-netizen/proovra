/**
 * FAIL-CLOSED IDENTITY AND AUDIENCE PROJECTION — live PostgreSQL 16.
 *
 * ---------------------------------------------------------------------------
 * THE TWO DEFECTS THESE CASES CLOSE
 * ---------------------------------------------------------------------------
 * 1. AN UNIDENTIFIABLE CONDITION WAS THE MOST CLOSABLE KIND THERE IS.
 *    A row whose source nothing could resolve fell through to a contract that
 *    was `OPERATOR_DECISION`. Not knowing what something was made it MORE
 *    resolvable, which inverts the rule the whole correction establishes.
 *
 * 2. ONE DEAD WORKER WAS A HUNDRED PROBLEMS.
 *    `platform.worker_heartbeat_stale` reads `WorkerTelemetrySnapshot WHERE
 *    workerKind = 'WORKER'` — one process-wide heartbeat, no tenant predicate
 *    — and then writes a per-workspace fingerprint. One outage opened one
 *    identical CRITICAL condition in every workspace on the platform, each
 *    counted, each blocking that tenant's all-clear.
 *
 * Every case below runs the REAL services against a real database. Nothing is
 * re-implemented: the rows are written by `recordIncident`, the refusals come
 * from `resolveIncident`, and the exclusion is the one every tenant read
 * already composes.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Fail-closed identity and audience (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let incidents: typeof import("../src/services/observability/incident.service.js");
  let summary: typeof import("../src/services/operations/operations-summary.service.js");
  let authority: typeof import("@proovra/shared-runtime");

  let team: { teamId: string; ownerUserId: string };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    incidents = await import("../src/services/observability/incident.service.js");
    summary = await import(
      "../src/services/operations/operations-summary.service.js"
    );
    authority = await import("@proovra/shared-runtime");

    const owned = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { id: true, ownerUserId: true },
    });
    team = { teamId: owned.id, ownerUserId: owned.ownerUserId! };
  }, 900_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  afterEach(async () => {
    const rows = await prisma.operationalIncident.findMany({
      where: { teamId: team.teamId },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await prisma.operationalIncidentSlaCycle.deleteMany({
        where: { incidentId: { in: ids } },
      });
      await prisma.operationalIncidentEvent.deleteMany({
        where: { incidentId: { in: ids } },
      });
      await prisma.operationalIncident.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.governanceReconciliationRun.deleteMany({
      where: { kind: "WORKSPACE_OPERATIONS", teamId: team.teamId },
    });
  });

  /**
   * Write a row DIRECTLY, bypassing the typed writer.
   *
   * The typed writer will not let a caller omit `sourceId`, which is the
   * point — but rows already in production DO have none, and a future writer
   * could ship an unregistered id. Both states are reproduced here rather than
   * assumed, because a fail-closed rule that has never met the state it guards
   * is a claim, not a property.
   */
  async function rawCondition(input: {
    sourceId: string | null;
    fingerprint: string;
    category?: string;
  }): Promise<string> {
    const row = await prisma.operationalIncident.create({
      data: {
        teamId: team.teamId,
        scope: "WORKSPACE",
        sourceId: input.sourceId,
        category: (input.category ?? "GOVERNANCE") as never,
        severity: "HIGH",
        status: "OPEN",
        fingerprint: input.fingerprint,
        title: "A condition nobody registered",
        safeSummary: "Written directly, bypassing the typed writer.",
        updatedAt: new Date(),
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  async function snapshot(id: string) {
    return prisma.operationalIncident.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        resolvedAtUtc: true,
        resolvedByUserId: true,
        resolutionNote: true,
        occurrenceCount: true,
        acknowledgedAtUtc: true,
      },
    });
  }

  async function eventCount(id: string): Promise<number> {
    return prisma.operationalIncidentEvent.count({ where: { incidentId: id } });
  }

  async function cycleCount(id: string): Promise<number> {
    return prisma.operationalIncidentSlaCycle.count({
      where: { incidentId: id },
    });
  }

  // =========================================================================
  // 1. UNREGISTERED AND LEGACY-NULL ROWS FAIL CLOSED
  // =========================================================================

  it("a historical NULL-source row offers no Resolve and refuses one", async () => {
    const id = await rawCondition({
      sourceId: null,
      // A shape no registered pattern claims, so the legacy path cannot save
      // it either.
      fingerprint: "some_forgotten_writer:subject-42",
    });

    const row = await prisma.operationalIncident.findUniqueOrThrow({
      where: { id },
    });
    const projected = incidents.projectIncident(row);
    expect(projected.lifecycle.sourceId).toBe("unregistered.condition");
    expect(projected.lifecycle.resolutionAuthority).toBe("NO_DIRECT_RESOLUTION");
    // NO Resolve control is offered…
    expect(projected.lifecycle.manualResolution).toBe(false);

    const before = await snapshot(id);
    const eventsBefore = await eventCount(id);
    const cyclesBefore = await cycleCount(id);

    // …and one that arrives anyway is refused.
    await expect(
      incidents.resolveIncident({
        incidentId: id,
        teamId: team.teamId,
        actorUserId: team.ownerUserId,
        resolutionNote: "closing this out",
      }),
    ).rejects.toMatchObject({ code: "CONDITION_NOT_DIRECTLY_RESOLVABLE" });

    // ZERO WRITES. Status, timestamps, note, occurrence count, events and SLA
    // cycles are all exactly as they were.
    expect(await snapshot(id)).toEqual(before);
    expect(await eventCount(id)).toBe(eventsBefore);
    expect(await cycleCount(id)).toBe(cyclesBefore);
  }, 300_000);

  it("an UNKNOWN sourceId fails closed the same way", async () => {
    const id = await rawCondition({
      sourceId: "some.future.source.nobody.registered",
      fingerprint: "future:writer:shape",
    });
    const row = await prisma.operationalIncident.findUniqueOrThrow({
      where: { id },
    });
    const projected = incidents.projectIncident(row);
    expect(projected.lifecycle.resolutionAuthority).toBe("NO_DIRECT_RESOLUTION");
    expect(projected.lifecycle.manualResolution).toBe(false);

    const before = await snapshot(id);
    await expect(
      incidents.resolveIncident({
        incidentId: id,
        teamId: team.teamId,
        actorUserId: team.ownerUserId,
      }),
    ).rejects.toMatchObject({ code: "CONDITION_NOT_DIRECTLY_RESOLVABLE" });
    expect(await snapshot(id)).toEqual(before);
  }, 300_000);

  it("acknowledge and suppress REMAIN available on an unregistered condition", async () => {
    // Fail-closed is not fail-useless. The operator can still take ownership
    // and still silence it; what they cannot do is declare it over.
    const id = await rawCondition({
      sourceId: null,
      fingerprint: "another_forgotten_writer:subject-7",
    });
    const acked = await incidents.acknowledgeIncident({
      incidentId: id,
      teamId: team.teamId,
      actorUserId: team.ownerUserId,
    });
    expect(acked.status).toBe("ACKNOWLEDGED");
    expect(acked.acknowledgedByUserId).toBe(team.ownerUserId);

    const suppressed = await incidents.suppressIncident({
      incidentId: id,
      teamId: team.teamId,
      actorUserId: team.ownerUserId,
      resolutionNote: "silenced pending investigation",
    });
    expect(suppressed.status).toBe("SUPPRESSED");
  }, 300_000);

  it("a SOURCE_TRUTH condition whose probe has no handler fails closed", async () => {
    // The probe map is exhaustive over the declared key union, so this state
    // is unreachable by construction — which is exactly why the DECISION is
    // asserted directly: the day somebody widens the union, the rule that
    // catches it must already be the fail-closed one.
    const verdict = authority.decideManualResolution({
      currentStatus: "OPEN",
      authority: "SOURCE_TRUTH",
      // No handler ran, so nothing was observed.
      activity: "UNKNOWN",
      notApplicableDisposition: "REFUSE",
    });
    expect(authority.manualResolutionErrorCode(verdict)).toBe(
      "CONDITION_ACTIVITY_UNKNOWN",
    );
  }, 300_000);

  it("NOTHING in the registry resolves to OPERATOR_DECISION by fallback", async () => {
    // Every OPERATOR_DECISION source is an explicit, per-source declaration
    // with a required written conclusion. The unregistered contract is not one
    // of them, and neither is any lookup miss.
    expect(
      authority.UNREGISTERED_CONDITION_LIFECYCLE.resolutionAuthority,
    ).toBe("NO_DIRECT_RESOLUTION");
    for (const fingerprint of [
      "",
      ":",
      "nonsense",
      "nonsense:",
      "dashboard:pipeline:report_backlog_v2:t1",
    ]) {
      const r = authority.resolveConditionSource({
        category: "REPORT",
        fingerprint,
      });
      expect(r.lifecycle.resolutionAuthority, fingerprint).toBe(
        "NO_DIRECT_RESOLUTION",
      );
    }
  }, 300_000);

  // =========================================================================
  // 2. OPERATOR_DECISION REQUIRES A WRITTEN CONCLUSION
  // =========================================================================

  it("an OPERATOR_DECISION condition refuses a Resolve with no note", async () => {
    const id = await rawCondition({
      sourceId: "identity.security_condition",
      fingerprint: "identity_security:security_event:suspicious_login_burst",
      category: "IDENTITY_SECURITY",
    });
    const before = await snapshot(id);

    await expect(
      incidents.resolveIncident({
        incidentId: id,
        teamId: team.teamId,
        actorUserId: team.ownerUserId,
        // Whitespace is not a conclusion.
        resolutionNote: "   ",
      }),
    ).rejects.toMatchObject({ code: "RESOLUTION_NOTE_REQUIRED" });
    expect(await snapshot(id)).toEqual(before);

    // …and accepts one WITH a note. The authority is real; the requirement is
    // what makes it mean something.
    const resolved = await incidents.resolveIncident({
      incidentId: id,
      teamId: team.teamId,
      actorUserId: team.ownerUserId,
      resolutionNote: "Investigated: the burst was a known load test.",
    });
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolvedByUserId).toBe(team.ownerUserId);
    expect(resolved.resolutionNote).toContain("known load test");
  }, 300_000);

  // =========================================================================
  // 3. PLATFORM_INTERNAL NEVER REACHES A TENANT SURFACE
  // =========================================================================

  it("a global platform condition is absent from the tenant queue, counts and readiness", async () => {
    // The exact shape one dead worker produced in EVERY workspace.
    const platformId = await rawCondition({
      sourceId: "platform.worker_heartbeat_stale",
      fingerprint: `dashboard:worker:heartbeat_stale:${team.teamId}`,
      category: "WORKER",
    });
    // …beside one condition that genuinely is this tenant's.
    const tenantId = await rawCondition({
      sourceId: "pipeline.report_backlog",
      fingerprint: `dashboard:pipeline:report_backlog:${team.teamId}`,
      category: "REPORT",
    });

    const page = await incidents.listIncidents({
      teamId: team.teamId,
      now: new Date(),
      limit: 100,
      cursor: null,
    } as never);
    const ids = page.incidents.map((i) => i.id);
    expect(ids).toContain(tenantId);
    expect(ids).not.toContain(platformId);

    // The COUNTS agree with the list. A surface that hid the row and still
    // counted it would be the same lie with an extra step.
    const s = await summary.buildOperationsSummary({
      workspaceId: team.teamId,
    });
    expect(s.open).toBe(1);
    expect(s.critical + s.high).toBeLessThanOrEqual(1);
    // …and the groups.
    expect(s.groups.map((g: { sourceId: string }) => g.sourceId)).toEqual(["pipeline.report_backlog"]);
  }, 300_000);

  it("the platform condition is still there, for the platform surface", async () => {
    const platformId = await rawCondition({
      sourceId: "platform.worker_heartbeat_stale",
      fingerprint: `dashboard:worker:heartbeat_stale:${team.teamId}`,
      category: "WORKER",
    });
    // Hidden from the tenant, not deleted. A platform operator asking the
    // platform question finds it.
    const rows = await prisma.operationalIncident.findMany({
      where: { id: platformId },
      select: { id: true, sourceId: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceId).toBe("platform.worker_heartbeat_stale");
  }, 300_000);

  it("a legacy NULL-source row is NOT hidden by the platform exclusion", async () => {
    // The exclusion withholds explicitly-declared platform sources and nothing
    // else. A legacy row with no source id is still this workspace's own
    // condition, and hiding it would be a second silent disappearance.
    const legacyId = await rawCondition({
      sourceId: null,
      fingerprint: "legacy:unknown:shape",
    });
    const page = await incidents.listIncidents({
      teamId: team.teamId,
      now: new Date(),
      limit: 100,
      cursor: null,
    } as never);
    expect(page.incidents.map((i) => i.id)).toContain(legacyId);
  }, 300_000);

  it("a TENANT_ADVISORY condition IS visible, and offers no Resolve", async () => {
    // The distinction the audience field exists to make: the tenant cannot
    // repair their queue telemetry sampler, and they are still entitled to
    // know their own telemetry is dark.
    const id = await rawCondition({
      sourceId: "platform.telemetry_stale",
      fingerprint: `dashboard:telemetry:queue_stale:${team.teamId}`,
      category: "WORKER",
    });
    const page = await incidents.listIncidents({
      teamId: team.teamId,
      now: new Date(),
      limit: 100,
      cursor: null,
    } as never);
    expect(page.incidents.map((i) => i.id)).toContain(id);

    const row = await prisma.operationalIncident.findUniqueOrThrow({
      where: { id },
    });
    const projected = incidents.projectIncident(row);
    expect(projected.lifecycle.audience).toBe("TENANT_ADVISORY");
    expect(projected.lifecycle.manualResolution).toBe(false);
  }, 300_000);
});
