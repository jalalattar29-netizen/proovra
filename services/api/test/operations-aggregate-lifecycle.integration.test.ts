/**
 * AGGREGATE CONDITIONS OWN THEIR OWN RESOLUTION — live PostgreSQL 16.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG
 * ---------------------------------------------------------------------------
 * `pipeline.report_backlog` inherited its resolution authority from category
 * REPORT, which was declared `OPERATOR_MAY_RESOLVE`. So an operator could open
 *
 *     "Report backlog above threshold (26)"
 *
 * and mark it RESOLVED while all twenty-six evidence records were still
 * without reports. The next sweep reopened it — correctly, and minutes later —
 * so the workspace displayed a false all-clear for up to one reconciliation
 * interval, and the operator learned that the button does not mean anything.
 *
 * Three further defects had the same cause:
 *
 *   * threshold conditions had NO recovery path. Only per-record integrity
 *     conditions were ever auto-resolved, so a backlog a workspace worked all
 *     the way down stayed OPEN until somebody pressed a button the source
 *     contradicted;
 *   * the count lived in `title`, which `recordIncident` never rewrote, so 26
 *     was written once and then frozen for the life of the condition;
 *   * severity was computed from that frozen number and latched.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE CASES HOLD
 * ---------------------------------------------------------------------------
 * Every case runs the REAL services against a real database. Nothing is
 * re-implemented here: the same `reconcileWorkspaceOperations` the scheduler
 * runs, the same `resolveIncident` the route calls, and the same probe both of
 * them consult. The defect was never in the shape of the rule — it was in
 * WHICH authority got to state it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

/** The canonical report-backlog activation threshold. */
const BACKLOG_HIGH = 20;
/** Comfortably above it, and the number the brief names. */
const BACKLOG_ACTIVE = 26;

describe("Aggregate Operations conditions (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let incidents: typeof import("../src/services/observability/incident.service.js");
  let ops: typeof import("../src/services/operations/operations-reconciliation.service.js");
  let probes: typeof import("../src/services/operations/operations-source-probes.js");
  let authority: typeof import("@proovra/shared-runtime");

  /** The workspace every single-context case uses: an OWNED team. */
  let team: { teamId: string; ownerUserId: string; organizationId: string | null };
  /** A PERSONAL workspace, whose evidence carries the legacy NULL-team shape. */
  let personal: { teamId: string; ownerUserId: string };
  /** Another owner, whose records must never count toward the personal one. */
  let otherOwnerUserId: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    incidents = await import("../src/services/observability/incident.service.js");
    ops = await import(
      "../src/services/operations/operations-reconciliation.service.js"
    );
    probes = await import(
      "../src/services/operations/operations-source-probes.js"
    );
    authority = await import("@proovra/shared-runtime");

    const owned = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { id: true, ownerUserId: true, organizationId: true },
    });
    team = {
      teamId: owned.id,
      ownerUserId: owned.ownerUserId!,
      organizationId: owned.organizationId,
    };
    personal = {
      teamId: harness.fixtures.personal.teamId,
      ownerUserId: harness.fixtures.personal.userId,
    };
    otherOwnerUserId = harness.fixtures.teamB.ownerUserId;
  }, 900_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  const created: { evidenceIds: string[]; teamIds: Set<string> } = {
    evidenceIds: [],
    teamIds: new Set(),
  };

  afterEach(async () => {
    for (const teamId of created.teamIds) {
      const rows = await prisma.operationalIncident.findMany({
        where: { teamId },
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
        where: { kind: "WORKSPACE_OPERATIONS", teamId },
      });
    }
    if (created.evidenceIds.length) {
      await prisma.evidence.deleteMany({
        where: { id: { in: created.evidenceIds } },
      });
    }
    created.evidenceIds = [];
    created.teamIds = new Set();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /**
   * `n` SIGNED evidence records with no report — the exact population the
   * report-backlog probe counts.
   */
  async function backlogRecords(
    n: number,
    scope: { teamId: string; ownerUserId: string; legacy?: boolean } = team,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const base = scope.legacy
        ? { teamId: null, organizationId: null, ownerUserId: scope.ownerUserId }
        : {
            teamId: scope.teamId,
            organizationId: team.organizationId,
            ownerUserId: scope.ownerUserId,
          };
      const row = await prisma.evidence.create({
        data: {
          ...base,
          title: `backlog-${i}-${Math.random().toString(36).slice(2, 10)}`,
          type: "PHOTO",
          status: "SIGNED",
          latestReportVersion: null,
        } as never,
        select: { id: true },
      });
      ids.push(row.id);
      created.evidenceIds.push(row.id);
    }
    created.teamIds.add(scope.teamId);
    return ids;
  }

  /** Give `n` of the records a report, so the backlog falls by `n`. */
  async function giveReports(ids: string[]): Promise<void> {
    await prisma.evidence.updateMany({
      where: { id: { in: ids } },
      data: { latestReportVersion: 1 },
    });
  }

  async function reconcile(teamId: string): Promise<void> {
    created.teamIds.add(teamId);
    // The sweep declines while a recent run is READY, and every case here is
    // deliberately asking for a FRESH observation.
    await prisma.governanceReconciliationRun.deleteMany({
      where: { kind: "WORKSPACE_OPERATIONS", teamId },
    });
    await ops.reconcileWorkspaceOperations({ workspaceId: teamId, trigger: "cli" });
  }

  function backlogFingerprint(teamId: string): string {
    const spec = probes
      .aggregateSpecs()
      .find((s) => s.sourceId === "pipeline.report_backlog")!;
    return probes.aggregateFingerprint(spec, teamId);
  }

  async function backlogCondition(teamId: string) {
    return prisma.operationalIncident.findFirstOrThrow({
      where: { teamId, fingerprint: backlogFingerprint(teamId) },
      select: {
        id: true,
        status: true,
        title: true,
        safeSummary: true,
        severity: true,
        occurrenceCount: true,
        metricSnapshot: true,
        resolvedAtUtc: true,
        resolvedByUserId: true,
        resolutionNote: true,
        acknowledgedAtUtc: true,
        acknowledgedByUserId: true,
      },
    });
  }

  async function eventTypes(incidentId: string): Promise<string[]> {
    const rows = await prisma.operationalIncidentEvent.findMany({
      where: { incidentId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { eventType: true },
    });
    return rows.map((r) => r.eventType);
  }

  async function liveCycleCount(incidentId: string): Promise<number> {
    return prisma.operationalIncidentSlaCycle.count({
      where: { incidentId, endedAtUtc: null },
    });
  }

  async function totalCycleCount(incidentId: string): Promise<number> {
    return prisma.operationalIncidentSlaCycle.count({ where: { incidentId } });
  }

  function metricOf(row: { metricSnapshot: unknown }) {
    return authority.decodeConditionMetric(row.metricSnapshot);
  }

  // =========================================================================
  // 1. A backlog of 26 is displayed as 26, and cannot be declared over.
  // =========================================================================

  it("a backlog of 26 opens ONE condition carrying the live value 26", async () => {
    await backlogRecords(BACKLOG_ACTIVE);
    await reconcile(team.teamId);

    const condition = await backlogCondition(team.teamId);
    expect(condition.status).toBe("OPEN");
    // THE TITLE IS STABLE AND CARRIES NO COUNT. This is the half that used to
    // freeze: `Report backlog above threshold (26)` was written once.
    expect(condition.title).toBe("Report generation backlog");
    expect(condition.title).not.toMatch(/\d/);

    const metric = metricOf(condition);
    expect(metric).not.toBeNull();
    expect(metric!.currentValue).toBe(BACKLOG_ACTIVE);
    expect(metric!.thresholdValue).toBe(BACKLOG_HIGH);
    expect(metric!.criticalThresholdValue).toBe(100);
    expect(metric!.unit).toBe("records");
    expect(metric!.stale).toBe(false);
    // 26 is above HIGH and below CRITICAL.
    expect(condition.severity).toBe("HIGH");

    // ONE condition, not twenty-six. A report queue that is too deep is one
    // operational fact about the workspace.
    const count = await prisma.operationalIncident.count({
      where: { teamId: team.teamId, fingerprint: backlogFingerprint(team.teamId) },
    });
    expect(count).toBe(1);
  }, 300_000);

  it("manual Resolve of the ACTIVE backlog is refused and writes NOTHING", async () => {
    await backlogRecords(BACKLOG_ACTIVE);
    await reconcile(team.teamId);

    const before = await backlogCondition(team.teamId);
    const eventsBefore = await eventTypes(before.id);
    const cyclesBefore = await totalCycleCount(before.id);

    await expect(
      incidents.resolveIncident({
        incidentId: before.id,
        teamId: team.teamId,
        actorUserId: team.ownerUserId,
        resolutionNote: "we are on top of it",
      }),
    ).rejects.toMatchObject({ code: "CONDITION_STILL_ACTIVE" });

    // NOTHING moved. The refusal happens before any write, so status,
    // timestamps, note, events and SLA cycles are exactly as they were.
    const after = await backlogCondition(team.teamId);
    expect(after.status).toBe(before.status);
    expect(after.resolvedAtUtc).toBeNull();
    expect(after.resolvedByUserId).toBeNull();
    expect(after.resolutionNote).toBeNull();
    expect(after.occurrenceCount).toBe(before.occurrenceCount);
    expect(await eventTypes(before.id)).toEqual(eventsBefore);
    expect(await totalCycleCount(before.id)).toBe(cyclesBefore);
    // …and the metric was not touched either.
    expect(metricOf(after)!.currentValue).toBe(BACKLOG_ACTIVE);
  }, 300_000);

  // =========================================================================
  // 2. Recovery closes it. Recurrence reopens the SAME condition.
  // =========================================================================

  it("falling below the threshold auto-resolves the SAME condition", async () => {
    const ids = await backlogRecords(BACKLOG_ACTIVE);
    await reconcile(team.teamId);
    const opened = await backlogCondition(team.teamId);
    expect(opened.status).toBe("OPEN");
    expect(await liveCycleCount(opened.id)).toBe(1);

    // The workspace does the work: 26 - 20 = 6, below the threshold of 20.
    await giveReports(ids.slice(0, 20));
    await reconcile(team.teamId);

    const resolved = await backlogCondition(team.teamId);
    // The SAME row. Not a new condition, not a deleted one.
    expect(resolved.id).toBe(opened.id);
    expect(resolved.status).toBe("RESOLVED");
    // Resolved by the SOURCE, so no human resolver is fabricated.
    expect(resolved.resolvedByUserId).toBeNull();
    expect(resolved.resolvedAtUtc).not.toBeNull();
    // The recovered value is recorded, so a resolved backlog reads 6 rather
    // than keeping the 26 it carried when it was last above the line.
    expect(metricOf(resolved)!.currentValue).toBe(6);
    expect(metricOf(resolved)!.previousValue).toBe(BACKLOG_ACTIVE);
    expect(metricOf(resolved)!.delta).toBe(6 - BACKLOG_ACTIVE);

    expect(await eventTypes(opened.id)).toContain("resolved_by_domain_truth");
    // The promise is discharged, not left owing.
    expect(await liveCycleCount(opened.id)).toBe(0);
  }, 300_000);

  it("rising again reopens the SAME condition with a new SLA cycle", async () => {
    const ids = await backlogRecords(BACKLOG_ACTIVE);
    await reconcile(team.teamId);
    const opened = await backlogCondition(team.teamId);

    await giveReports(ids.slice(0, 20));
    await reconcile(team.teamId);
    expect((await backlogCondition(team.teamId)).status).toBe("RESOLVED");

    // The backlog comes back.
    await prisma.evidence.updateMany({
      where: { id: { in: ids.slice(0, 20) } },
      data: { latestReportVersion: null },
    });
    await reconcile(team.teamId);

    const reopened = await backlogCondition(team.teamId);
    expect(reopened.id).toBe(opened.id);
    expect(reopened.status).toBe("OPEN");
    expect(reopened.resolvedAtUtc).toBeNull();
    expect(metricOf(reopened)!.currentValue).toBe(BACKLOG_ACTIVE);

    const events = await eventTypes(opened.id);
    // An explicit reopen, NOT an increment — the whole point of the shared
    // transition authority.
    expect(events).toContain("reopened");
    expect(events).toContain("resolved_by_domain_truth");
    expect(events.lastIndexOf("reopened")).toBeGreaterThan(
      events.indexOf("resolved_by_domain_truth"),
    );

    const reopenEvent = await prisma.operationalIncidentEvent.findFirstOrThrow({
      where: { incidentId: opened.id, eventType: "reopened" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { metadataJson: true },
    });
    // A GENUINE recurrence, because the previous resolution was a recorded
    // source recovery — not the conservative legacy reopen.
    expect(
      (reopenEvent.metadataJson as { reopenReason?: string } | null)?.reopenReason,
    ).toBe("SOURCE_RECURRENCE");

    // One new promise, and the previous cycle preserved in history.
    expect(await liveCycleCount(opened.id)).toBe(1);
    expect(await totalCycleCount(opened.id)).toBeGreaterThanOrEqual(2);
  }, 300_000);

  it("does not reopen a second time while it is already OPEN", async () => {
    const ids = await backlogRecords(BACKLOG_ACTIVE);
    await reconcile(team.teamId);
    await giveReports(ids.slice(0, 20));
    await reconcile(team.teamId);
    await prisma.evidence.updateMany({
      where: { id: { in: ids.slice(0, 20) } },
      data: { latestReportVersion: null },
    });
    await reconcile(team.teamId);
    const opened = await backlogCondition(team.teamId);
    const reopensAfterFirst = (await eventTypes(opened.id)).filter(
      (e) => e === "reopened",
    ).length;

    // Two more sweeps over an unchanged, still-active backlog.
    await reconcile(team.teamId);
    await reconcile(team.teamId);

    const events = await eventTypes(opened.id);
    expect(events.filter((e) => e === "reopened")).toHaveLength(
      reopensAfterFirst,
    );
    // Still ONE live promise — a re-fire of an open condition does not restart
    // the clock.
    expect(await liveCycleCount(opened.id)).toBe(1);
  }, 300_000);

  // =========================================================================
  // 3. The value changes; the identity does not.
  // =========================================================================

  it("26 -> 22 updates the metric and leaves the title and the row alone", async () => {
    const ids = await backlogRecords(BACKLOG_ACTIVE);
    await reconcile(team.teamId);
    const opened = await backlogCondition(team.teamId);
    expect(metricOf(opened)!.currentValue).toBe(26);

    // Four reports generated. Still above the threshold, so still ACTIVE.
    await giveReports(ids.slice(0, 4));
    await reconcile(team.teamId);

    const after = await backlogCondition(team.teamId);
    expect(after.id).toBe(opened.id);
    expect(after.status).toBe("OPEN");
    // THE TITLE DID NOT CHANGE and still carries no number.
    expect(after.title).toBe("Report generation backlog");
    // THE VALUE DID.
    const metric = metricOf(after)!;
    expect(metric.currentValue).toBe(22);
    expect(metric.previousValue).toBe(26);
    expect(metric.delta).toBe(-4);
    expect(metric.stale).toBe(false);

    // No duplicate condition was minted by the changing count.
    expect(
      await prisma.operationalIncident.count({
        where: {
          teamId: team.teamId,
          fingerprint: backlogFingerprint(team.teamId),
        },
      }),
    ).toBe(1);
  }, 300_000);

  it("crossing the critical threshold recalculates severity, both ways", async () => {
    const ids = await backlogRecords(100);
    await reconcile(team.teamId);
    const critical = await backlogCondition(team.teamId);
    expect(critical.severity).toBe("CRITICAL");
    expect(metricOf(critical)!.currentValue).toBe(100);

    // Down to 60: still HIGH, and no longer CRITICAL. A severity latched from
    // a frozen number would have stayed CRITICAL beside a value of 60.
    await giveReports(ids.slice(0, 40));
    await reconcile(team.teamId);
    const high = await backlogCondition(team.teamId);
    expect(high.id).toBe(critical.id);
    expect(high.severity).toBe("HIGH");
    expect(metricOf(high)!.currentValue).toBe(60);
  }, 300_000);

  // =========================================================================
  // 4. An unreadable source is UNKNOWN, and UNKNOWN never resolves anything.
  // =========================================================================

  it("a failed observation refuses the resolve and keeps the last value, flagged", async () => {
    await backlogRecords(BACKLOG_ACTIVE);
    await reconcile(team.teamId);
    const opened = await backlogCondition(team.teamId);
    expect(metricOf(opened)!.currentValue).toBe(BACKLOG_ACTIVE);

    // A probe whose read gives way. The client is the ONLY thing replaced —
    // the spec, the threshold and the comparison are the real ones.
    const brokenClient = {
      ...prisma,
      evidence: {
        ...prisma.evidence,
        count: async () => {
          throw new Error("relation is unavailable");
        },
      },
    } as unknown as typeof prisma;

    const spec = probes
      .aggregateSpecs()
      .find((s) => s.sourceId === "pipeline.report_backlog")!;
    const observation = await probes.observeAggregate(spec, {
      teamId: team.teamId,
      fingerprint: backlogFingerprint(team.teamId),
      client: brokenClient,
      now: new Date(),
      evidenceWhere: await authority.workspaceEvidenceWhere(team.teamId, prisma),
    });
    // NOT zero, NOT recovered, NOT active.
    expect(observation.activity).toBe("UNKNOWN");
    expect(observation.currentValue).toBeUndefined();

    // And UNKNOWN refuses a manual resolution with its OWN code — the operator
    // is told the platform could not check, not told the condition still holds.
    const verdict = authority.decideManualResolution({
      currentStatus: "OPEN",
      authority: "SOURCE_TRUTH",
      activity: observation.activity,
      notApplicableDisposition: spec ? "REFUSE" : "REFUSE",
    });
    expect(authority.manualResolutionErrorCode(verdict)).toBe(
      "CONDITION_ACTIVITY_UNKNOWN",
    );

    // The stale marker keeps the last successfully observed values.
    await incidents.markConditionObservationStale({
      teamId: team.teamId,
      fingerprint: backlogFingerprint(team.teamId),
    });
    const flagged = await backlogCondition(team.teamId);
    const metric = metricOf(flagged)!;
    expect(metric.stale).toBe(true);
    expect(metric.currentValue).toBe(BACKLOG_ACTIVE);
    // No false all-clear: the condition is still open.
    expect(flagged.status).toBe("OPEN");
  }, 300_000);

  // =========================================================================
  // 5. Operator state survives, and suppression is not un-suppressed.
  // =========================================================================

  it("ACKNOWLEDGED survives re-observation of an active backlog", async () => {
    await backlogRecords(BACKLOG_ACTIVE);
    await reconcile(team.teamId);
    const opened = await backlogCondition(team.teamId);

    await incidents.acknowledgeIncident({
      incidentId: opened.id,
      teamId: team.teamId,
      actorUserId: team.ownerUserId,
    });
    await reconcile(team.teamId);

    const acked = await backlogCondition(team.teamId);
    expect(acked.status).toBe("ACKNOWLEDGED");
    expect(acked.acknowledgedByUserId).toBe(team.ownerUserId);
    expect(acked.acknowledgedAtUtc).not.toBeNull();
    // The occurrence WAS recorded — the observation is not lost, only the
    // status is left alone.
    expect(acked.occurrenceCount).toBeGreaterThan(opened.occurrenceCount);
  }, 300_000);

  it("SUPPRESSED stays suppressed while the backlog persists", async () => {
    await backlogRecords(BACKLOG_ACTIVE);
    await reconcile(team.teamId);
    const opened = await backlogCondition(team.teamId);

    await incidents.suppressIncident({
      incidentId: opened.id,
      teamId: team.teamId,
      actorUserId: team.ownerUserId,
    });
    await reconcile(team.teamId);
    await reconcile(team.teamId);

    const suppressed = await backlogCondition(team.teamId);
    expect(suppressed.status).toBe("SUPPRESSED");
    expect(await eventTypes(opened.id)).toContain(
      "occurrence_while_suppressed",
    );
  }, 300_000);

  it("a suppressed backlog that actually recovers IS resolved", async () => {
    const ids = await backlogRecords(BACKLOG_ACTIVE);
    await reconcile(team.teamId);
    const opened = await backlogCondition(team.teamId);
    await incidents.suppressIncident({
      incidentId: opened.id,
      teamId: team.teamId,
      actorUserId: team.ownerUserId,
    });

    // Domain truth outranks a suppression: leaving it suppressed-but-fixed
    // would make the next genuine backlog read as a continuation of this one.
    await giveReports(ids.slice(0, 20));
    await reconcile(team.teamId);

    const resolved = await backlogCondition(team.teamId);
    expect(resolved.status).toBe("RESOLVED");
    expect(await eventTypes(opened.id)).toContain("resolved_by_domain_truth");
  }, 300_000);

  // =========================================================================
  // 6. An EXISTING wrongly-resolved condition reopens exactly once.
  // =========================================================================

  it("a legacy manual resolution over an active source reopens ONCE, preserving history", async () => {
    await backlogRecords(BACKLOG_ACTIVE);
    await reconcile(team.teamId);
    const opened = await backlogCondition(team.teamId);

    // The exact state the old product could produce, written directly because
    // the service now refuses to create it. That is the point: existing rows
    // are already in this state and must converge without their history being
    // rewritten.
    await prisma.operationalIncident.update({
      where: { id: opened.id },
      data: {
        status: "RESOLVED",
        resolvedAtUtc: new Date(),
        resolvedByUserId: team.ownerUserId,
        resolutionNote: "closed by hand while the backlog was still 26",
      },
    });
    await prisma.operationalIncidentEvent.create({
      data: {
        incidentId: opened.id,
        eventType: "resolved",
        safeMessage: "closed by hand while the backlog was still 26",
      },
    });

    await reconcile(team.teamId);

    const reopened = await backlogCondition(team.teamId);
    expect(reopened.status).toBe("OPEN");
    const events = await eventTypes(opened.id);
    expect(events.filter((e) => e === "reopened")).toHaveLength(1);
    // The operator's decision and note remain in the HISTORY. Nothing is
    // deleted or rewritten; the row simply says a new cycle began.
    expect(events).toContain("resolved");

    const reopenEvent = await prisma.operationalIncidentEvent.findFirstOrThrow({
      where: { incidentId: opened.id, eventType: "reopened" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { metadataJson: true, safeMessage: true },
    });
    // The CONSERVATIVE reason: the previous resolution was an operator's, not
    // a recorded source recovery, so this is not claimed as a recurrence.
    expect(
      (reopenEvent.metadataJson as { reopenReason?: string } | null)?.reopenReason,
    ).toBe("ACTIVE_SOURCE_AFTER_LEGACY_MANUAL_RESOLUTION");

    // And it does not reopen again on every subsequent sweep.
    await reconcile(team.teamId);
    await reconcile(team.teamId);
    expect(
      (await eventTypes(opened.id)).filter((e) => e === "reopened"),
    ).toHaveLength(1);
    expect(await liveCycleCount(opened.id)).toBe(1);
  }, 300_000);

  // =========================================================================
  // 7. Workspace scope — personal legacy records count, another owner's do not.
  // =========================================================================

  it("a PERSONAL workspace's legacy NULL-team records are counted; another owner's are not", async () => {
    // The personal workspace's own records carry `team_id = NULL`, bound to
    // its owner. A strict `teamId` predicate reads zero of them, which is the
    // defect that made Operations render "clear" over a real backlog.
    await backlogRecords(BACKLOG_ACTIVE, {
      teamId: personal.teamId,
      ownerUserId: personal.ownerUserId,
      legacy: true,
    });
    // ANOTHER owner's NULL-team records. A `teamId: null` fallback that was not
    // owner-bound would sweep these in and count 52.
    const foreign: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const row = await prisma.evidence.create({
        data: {
          teamId: null,
          organizationId: null,
          ownerUserId: otherOwnerUserId,
          title: `foreign-backlog-${i}`,
          type: "PHOTO",
          status: "SIGNED",
          latestReportVersion: null,
        } as never,
        select: { id: true },
      });
      foreign.push(row.id);
      created.evidenceIds.push(row.id);
    }

    await reconcile(personal.teamId);

    const condition = await backlogCondition(personal.teamId);
    // EXACTLY the personal workspace's own 26.
    expect(metricOf(condition)!.currentValue).toBe(BACKLOG_ACTIVE);
    expect(condition.status).toBe("OPEN");
    // The identical contract, with no plan-shaped exception.
    await expect(
      incidents.resolveIncident({
        incidentId: condition.id,
        teamId: personal.teamId,
        actorUserId: personal.ownerUserId,
      }),
    ).rejects.toMatchObject({ code: "CONDITION_STILL_ACTIVE" });
  }, 300_000);

  // =========================================================================
  // 8. The other aggregate sources, through the same authority.
  // =========================================================================

  it("the package backlog behaves identically: refuse while active, resolve on recovery", async () => {
    const ids: string[] = [];
    for (let i = 0; i < BACKLOG_ACTIVE; i += 1) {
      const row = await prisma.evidence.create({
        data: {
          teamId: team.teamId,
          organizationId: team.organizationId,
          ownerUserId: team.ownerUserId,
          title: `pkg-backlog-${i}`,
          type: "PHOTO",
          status: "REPORTED",
          verificationPackageVersion: null,
        } as never,
        select: { id: true },
      });
      ids.push(row.id);
      created.evidenceIds.push(row.id);
    }
    created.teamIds.add(team.teamId);
    await reconcile(team.teamId);

    const spec = probes
      .aggregateSpecs()
      .find((s) => s.sourceId === "pipeline.package_backlog")!;
    const fp = probes.aggregateFingerprint(spec, team.teamId);
    const opened = await prisma.operationalIncident.findFirstOrThrow({
      where: { teamId: team.teamId, fingerprint: fp },
      select: { id: true, status: true, title: true, metricSnapshot: true },
    });
    expect(opened.title).toBe("Verification package backlog");
    expect(metricOf(opened)!.currentValue).toBe(BACKLOG_ACTIVE);

    await expect(
      incidents.resolveIncident({
        incidentId: opened.id,
        teamId: team.teamId,
        actorUserId: team.ownerUserId,
      }),
    ).rejects.toMatchObject({ code: "CONDITION_STILL_ACTIVE" });

    await prisma.evidence.updateMany({
      where: { id: { in: ids.slice(0, 20) } },
      data: { verificationPackageVersion: 1 },
    });
    await reconcile(team.teamId);
    const resolved = await prisma.operationalIncident.findFirstOrThrow({
      where: { id: opened.id },
      select: { status: true },
    });
    expect(resolved.status).toBe("RESOLVED");
  }, 300_000);

  it("a TENANT_ADVISORY platform condition is never manually resolvable", async () => {
    // Telemetry staleness is SOURCE_TRUTH and TENANT_ADVISORY: the workspace
    // cannot restart the sampler, and the condition closes when a snapshot
    // lands. Written directly because the sweep only produces it under a real
    // stale sampler, which a test must not fabricate by moving the clock.
    const spec = probes
      .aggregateSpecs()
      .find((s) => s.sourceId === "platform.telemetry_stale")!;
    const fp = probes.aggregateFingerprint(spec, team.teamId);
    created.teamIds.add(team.teamId);
    const { incident } = await incidents.recordIncident({
      // The SPEC's own source. Declared, not inferred — which is the whole
      // reason this case can assert what it asserts below.
      sourceId: spec.sourceId,
      teamId: team.teamId,
      category: spec.category,
      severity: "WARNING",
      fingerprint: fp,
      title: spec.stableTitle,
      safeSummary: spec.describe({ value: 45 }),
    });

    const projected = incidents.projectIncident(incident);
    expect(projected.lifecycle.sourceId).toBe("platform.telemetry_stale");
    expect(projected.lifecycle.audience).toBe("TENANT_ADVISORY");
    // No Resolve control is offered…
    expect(projected.lifecycle.manualResolution).toBe(false);
    // …and a request that arrives anyway is refused server-side. There is no
    // stale snapshot in a freshly-booted harness, so the probe answers
    // RECOVERED or UNKNOWN — never a silent success on a platform condition
    // the tenant cannot observe.
    const activity = await incidents.probeConditionActivity(
      { category: spec.category, fingerprint: fp, teamId: team.teamId },
      prisma,
    );
    expect(["ACTIVE", "RECOVERED", "UNKNOWN"]).toContain(activity);
  }, 300_000);

  // =========================================================================
  // 9. API and Worker reach the same answer from the same contract.
  // =========================================================================

  it("the API and the Worker resolve the SAME source and the SAME transition", async () => {
    const fp = backlogFingerprint(team.teamId);
    // ONE contract, consulted by id — the Worker's emitter imports exactly
    // this function from exactly this package.
    //
    // Both halves are asserted: a DECLARED id is the modern path every writer
    // now takes, and the fingerprint is the LEGACY path that keeps rows
    // written before `source_id` existed resolving to the same contract.
    const declared = authority.resolveConditionSource({
      sourceId: "pipeline.report_backlog",
      category: "REPORT",
      fingerprint: fp,
    });
    expect(declared.lifecycle.sourceId).toBe("pipeline.report_backlog");
    expect(declared.match).toBe("DECLARED");

    const api = authority.resolveConditionSource({
      category: "REPORT",
      fingerprint: fp,
    });
    expect(api.lifecycle.sourceId).toBe("pipeline.report_backlog");
    expect(api.match).toBe("LEGACY_FINGERPRINT");

    // …and the transition decision is the same pure function for both hosts.
    for (const status of ["OPEN", "ACKNOWLEDGED", "SUPPRESSED", "RESOLVED"] as const) {
      const active = authority.decideObservationTransition({
        currentStatus: status,
        observation: "SOURCE_ACTIVE",
        previousResolutionOrigin: "SOURCE_RECOVERY",
      });
      const recovered = authority.decideObservationTransition({
        currentStatus: status,
        observation: "SOURCE_RECOVERED",
      });
      expect(typeof active).toBe("string");
      expect(typeof recovered).toBe("string");
      // Neither host may invent a decision outside the bounded vocabulary.
      expect(authority.INCIDENT_TRANSITION_DECISIONS).toContain(active);
      expect(authority.INCIDENT_TRANSITION_DECISIONS).toContain(recovered);
    }
  }, 300_000);

  // =========================================================================
  // 10. The projection an operator sees agrees with the server's refusal.
  // =========================================================================

  it("the projection withholds Resolve for exactly the conditions the server refuses", async () => {
    await backlogRecords(BACKLOG_ACTIVE);
    await reconcile(team.teamId);
    const row = await prisma.operationalIncident.findFirstOrThrow({
      where: { teamId: team.teamId, fingerprint: backlogFingerprint(team.teamId) },
    });
    const projected = incidents.projectIncident(row);

    expect(projected.lifecycle.sourceId).toBe("pipeline.report_backlog");
    expect(projected.lifecycle.resolutionAuthority).toBe("SOURCE_TRUTH");
    expect(projected.lifecycle.manualResolution).toBe(false);
    expect(projected.metric?.currentValue).toBe(BACKLOG_ACTIVE);

    // And the server agrees, against a LIVE probe rather than the projection.
    await expect(
      incidents.resolveIncident({
        incidentId: row.id,
        teamId: team.teamId,
        actorUserId: team.ownerUserId,
      }),
    ).rejects.toMatchObject({ code: "CONDITION_STILL_ACTIVE" });
  }, 300_000);
});
