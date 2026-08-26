/**
 * IMMUTABLE-STORAGE DRIFT AND SEARCH-INDEX HEALTH — live PostgreSQL 16.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT AT THE CENTRE OF THIS FILE
 * ---------------------------------------------------------------------------
 * `storage.immutable_drift` was `OPERATOR_DECISION`. On an evidence platform,
 * that meant an IMMUTABLE-STORAGE INTEGRITY DRIFT — the storage layer no
 * longer agreeing with the database about a record's lock, retention or legal
 * hold — could be declared over by typing a sentence into a box.
 *
 * The stated reasoning was that re-checking requires re-reading object
 * storage, which the reconciler owns and a resolve path may not trigger. The
 * first half is true. The second does not follow, and the premise was wrong
 * about the product: the reconciler PERSISTS every verdict as an append-only
 * `immutable_storage_checks` row, keyed by team and evidence. Reading the
 * newest one is a probe — read-only, no storage call, no provider contact.
 *
 * So the drift closes when the RECONCILER says the record is OK, and not
 * before. These cases prove that against a real database, including the two
 * failure modes a fail-closed rule can produce if it is written carelessly: a
 * condition nobody can ever clear, and a condition that closes on an absence.
 *
 * ---------------------------------------------------------------------------
 * AND THE SIX NON-PRODUCING SOURCES
 * ---------------------------------------------------------------------------
 * `search.indexing_failure` was one of six sources registered with no producer
 * at all. It has one now, reading the same per-workspace SEARCH_INDEX
 * reconciliation runs the Search authority already writes. The other five are
 * proven here to reach no tenant surface — which is the honest disposition for
 * a source nothing emits, and for four of them, the correct one permanently:
 * they describe ONE global component and would otherwise appear once per
 * workspace.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const DRIFT_SOURCE = "storage.immutable_drift";
const SEARCH_SOURCE = "search.indexing_failure";

describe("Source semantics: immutable drift and search index (live PG16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let incidents: typeof import("../src/services/observability/incident.service.js");
  let sweep: typeof import("../src/services/operations/source-truth-recovery.service.js");
  let searchConditions: typeof import("../src/services/operations/search-index-conditions.service.js");
  let summary: typeof import("../src/services/operations/operations-summary.service.js");
  let authority: typeof import("@proovra/shared-runtime");

  let team: { teamId: string; ownerUserId: string; organizationId: string | null };

  const created = { evidenceIds: [] as string[] };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    incidents = await import("../src/services/observability/incident.service.js");
    sweep = await import(
      "../src/services/operations/source-truth-recovery.service.js"
    );
    searchConditions = await import(
      "../src/services/operations/search-index-conditions.service.js"
    );
    summary = await import(
      "../src/services/operations/operations-summary.service.js"
    );
    authority = await import("@proovra/shared-runtime");

    const owned = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { id: true, ownerUserId: true, organizationId: true },
    });
    team = {
      teamId: owned.id,
      ownerUserId: owned.ownerUserId!,
      organizationId: owned.organizationId ?? null,
    };
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
    if (created.evidenceIds.length) {
      await prisma.immutableStorageCheck.deleteMany({
        where: { evidenceId: { in: created.evidenceIds } },
      });
      await prisma.evidence.deleteMany({
        where: { id: { in: created.evidenceIds } },
      });
      created.evidenceIds.length = 0;
    }
    await prisma.governanceReconciliationRun.deleteMany({
      where: { teamId: team.teamId },
    });
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function evidenceRecord(): Promise<string> {
    const row = await prisma.evidence.create({
      data: {
        teamId: team.teamId,
        organizationId: team.organizationId,
        ownerUserId: team.ownerUserId,
        title: `drift-${Math.random().toString(36).slice(2, 10)}`,
        type: "PHOTO",
        status: "SIGNED",
      } as never,
      select: { id: true },
    });
    created.evidenceIds.push(row.id);
    return row.id;
  }

  /** The fingerprint the reconciler writes: `<class>:<OUTCOME>:<evidenceId>`. */
  function driftFingerprint(evidenceId: string, outcome = "MISSING_LOCK") {
    return `immutable_storage_drift:${outcome}:${evidenceId}`;
  }

  async function openDrift(
    evidenceId: string,
    outcome = "MISSING_LOCK",
  ): Promise<string> {
    const { incident } = await incidents.recordIncident({
      sourceId: DRIFT_SOURCE,
      teamId: team.teamId,
      category: "GOVERNANCE",
      severity: "HIGH",
      fingerprint: driftFingerprint(evidenceId, outcome),
      title: `Immutable storage drift: ${outcome}`,
      safeSummary: "The storage layer disagrees with the database.",
      relatedEvidenceId: evidenceId,
    });
    return incident.id;
  }

  /** Record what the reconciler saw. Append-only, exactly as it writes it. */
  async function recordCheck(evidenceId: string, outcome: string) {
    await prisma.immutableStorageCheck.create({
      data: {
        teamId: team.teamId,
        evidenceId,
        outcome: outcome as never,
        checkedAtUtc: new Date(),
      } as never,
    });
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

  const eventCount = (id: string) =>
    prisma.operationalIncidentEvent.count({ where: { incidentId: id } });
  const cycleCount = (id: string) =>
    prisma.operationalIncidentSlaCycle.count({ where: { incidentId: id } });

  // =========================================================================
  // 1. THE CONTRACT
  // =========================================================================

  it("storage.immutable_drift is SOURCE_TRUTH and offers no Resolve control", () => {
    const lifecycle = authority.lifecycleForSourceId(DRIFT_SOURCE)!;
    expect(lifecycle.resolutionAuthority).toBe("SOURCE_TRUTH");
    expect(lifecycle.recoveryPolicy).toBe("PROBE_AUTO_RESOLVE");
    expect(lifecycle.activityProbeKey).toBe(
      "storage.immutable_reconciliation_state",
    );
    // Never OPERATOR_DECISION again, and never with a note requirement — a
    // note requirement only exists to make a human CONCLUSION auditable, and
    // there is no conclusion to record when the source decides.
    expect(authority.offersManualResolution(lifecycle)).toBe(false);
    expect(lifecycle.requiresResolutionNote).toBe(false);
  });

  // =========================================================================
  // 2. A USER CANNOT DECLARE AN ACTIVE OR UNVERIFIABLE DRIFT RESOLVED
  // =========================================================================

  it("AN ACTIVE DRIFT REFUSES A MANUAL RESOLVE AND WRITES NOTHING", async () => {
    const evidenceId = await evidenceRecord();
    const id = await openDrift(evidenceId);
    // The reconciler's newest verdict IS the drift this condition names.
    await recordCheck(evidenceId, "MISSING_LOCK");

    const before = await snapshot(id);
    const eventsBefore = await eventCount(id);
    const cyclesBefore = await cycleCount(id);

    await expect(
      incidents.resolveIncident({
        incidentId: id,
        teamId: team.teamId,
        actorUserId: team.ownerUserId,
        resolutionNote: "we looked at it and it seems fine",
      }),
    ).rejects.toMatchObject({ code: "CONDITION_STILL_ACTIVE" });

    // ZERO WRITES: status, timestamps, note, occurrence count, events, cycles.
    expect(await snapshot(id)).toEqual(before);
    expect(await eventCount(id)).toBe(eventsBefore);
    expect(await cycleCount(id)).toBe(cyclesBefore);
  }, 300_000);

  it("AN UNVERIFIABLE DRIFT REFUSES TOO — a note is not evidence", async () => {
    const evidenceId = await evidenceRecord();
    const id = await openDrift(evidenceId);
    // The reconciler reached the record and the STORAGE LAYER did not answer.
    // The comparison did not complete, so it proved nothing in either
    // direction — and "we could not check" must not become "it is fine".
    await recordCheck(evidenceId, "STORAGE_UNAVAILABLE");

    const before = await snapshot(id);
    await expect(
      incidents.resolveIncident({
        incidentId: id,
        teamId: team.teamId,
        actorUserId: team.ownerUserId,
        resolutionNote: "storage team says it is fine",
      }),
    ).rejects.toMatchObject({ code: "CONDITION_ACTIVITY_UNKNOWN" });
    expect(await snapshot(id)).toEqual(before);
  }, 300_000);

  it("…and so does a drift the reconciler has NEVER examined", async () => {
    const evidenceId = await evidenceRecord();
    const id = await openDrift(evidenceId);
    // No check rows at all. An absence is not a recovery.
    const before = await snapshot(id);
    await expect(
      incidents.resolveIncident({
        incidentId: id,
        teamId: team.teamId,
        actorUserId: team.ownerUserId,
      }),
    ).rejects.toMatchObject({ code: "CONDITION_ACTIVITY_UNKNOWN" });
    expect(await snapshot(id)).toEqual(before);
  }, 300_000);

  it("acknowledge and suppress remain available while resolve does not", async () => {
    const evidenceId = await evidenceRecord();
    const id = await openDrift(evidenceId);
    await recordCheck(evidenceId, "MISSING_LOCK");

    // The refusal is about DECLARING IT OVER, not about working on it. An
    // operator can still take ownership and silence the noise.
    const acked = await incidents.acknowledgeIncident({
      incidentId: id,
      teamId: team.teamId,
      actorUserId: team.ownerUserId,
    });
    expect(acked.status).toBe("ACKNOWLEDGED");
    const suppressed = await incidents.suppressIncident({
      incidentId: id,
      teamId: team.teamId,
      actorUserId: team.ownerUserId,
    });
    expect(suppressed.status).toBe("SUPPRESSED");
  }, 300_000);

  // =========================================================================
  // 3. THE SOURCE CLOSES IT — AND ONLY THE SOURCE
  // =========================================================================

  it("A RECONCILER VERDICT OF OK RESOLVES THE CONDITION AUTOMATICALLY", async () => {
    const evidenceId = await evidenceRecord();
    const id = await openDrift(evidenceId);
    await recordCheck(evidenceId, "MISSING_LOCK");

    // Still active: the sweep must not close it.
    expect(
      (await sweep.sweepSourceTruthRecoveries({
        teamId: team.teamId,
        sourceId: DRIFT_SOURCE,
      })).resolved,
    ).toBe(0);
    expect((await snapshot(id)).status).toBe("OPEN");

    // The reconciler runs again and finds the record correct.
    await recordCheck(evidenceId, "OK");
    const result = await sweep.sweepSourceTruthRecoveries({
      teamId: team.teamId,
      sourceId: DRIFT_SOURCE,
    });
    expect(result.resolved).toBe(1);

    const after = await snapshot(id);
    expect(after.status).toBe("RESOLVED");
    // NO HUMAN RESOLVER IS INVENTED for a domain-truth resolution.
    expect(after.resolvedByUserId).toBeNull();
    expect(after.resolvedAtUtc).not.toBeNull();

    // The event says WHY, in the shared vocabulary every source-truth
    // recovery uses.
    const events = await prisma.operationalIncidentEvent.findMany({
      where: { incidentId: id },
      select: { eventType: true },
    });
    expect(events.map((e) => e.eventType)).toContain("resolved_by_domain_truth");
  }, 300_000);

  it("a SUPPRESSED drift still resolves when the source recovers", async () => {
    const evidenceId = await evidenceRecord();
    const id = await openDrift(evidenceId);
    await incidents.suppressIncident({
      incidentId: id,
      teamId: team.teamId,
      actorUserId: team.ownerUserId,
    });
    await recordCheck(evidenceId, "OK");

    await sweep.sweepSourceTruthRecoveries({
      teamId: team.teamId,
      sourceId: DRIFT_SOURCE,
    });
    // Domain truth outranks a suppression: a silenced condition whose record
    // is genuinely correct IS over, and leaving it silenced-but-live would
    // make the next real drift read as a continuation of something that ended.
    expect((await snapshot(id)).status).toBe("RESOLVED");
  }, 300_000);

  it("A LATER RECURRENCE REOPENS THE SAME INCIDENT", async () => {
    const evidenceId = await evidenceRecord();
    const id = await openDrift(evidenceId);
    await recordCheck(evidenceId, "OK");
    await sweep.sweepSourceTruthRecoveries({
      teamId: team.teamId,
      sourceId: DRIFT_SOURCE,
    });
    expect((await snapshot(id)).status).toBe("RESOLVED");

    // The reconciler finds the same drift again. Same fingerprint, so the
    // SAME row reopens — with a named reason and a new SLA cycle, rather than
    // a second row that would make one problem look like two.
    await recordCheck(evidenceId, "MISSING_LOCK");
    const reopenedId = await openDrift(evidenceId);
    expect(reopenedId).toBe(id);
    const after = await snapshot(id);
    expect(after.status).toBe("OPEN");
    expect(after.resolvedAtUtc).toBeNull();

    const events = await prisma.operationalIncidentEvent.findMany({
      where: { incidentId: id },
      select: { eventType: true },
    });
    expect(events.map((e) => e.eventType)).toContain("reopened");
    // The SLA history of the closed cycle is kept and a new one begins.
    expect(await cycleCount(id)).toBeGreaterThanOrEqual(1);
  }, 300_000);

  it("a DIFFERENT drift class does not keep this condition open forever", async () => {
    const evidenceId = await evidenceRecord();
    const id = await openDrift(evidenceId, "MISSING_LOCK");
    // The reconciler now reports a different disagreement about the same
    // record. The drift THIS condition names is no longer what it sees, and
    // the new class carries its own condition — so this one closes rather than
    // silently changing meaning.
    await recordCheck(evidenceId, "RETENTION_MISMATCH");
    await sweep.sweepSourceTruthRecoveries({
      teamId: team.teamId,
      sourceId: DRIFT_SOURCE,
    });
    expect((await snapshot(id)).status).toBe("RESOLVED");
  }, 300_000);

  it("THE PROBE MAKES NO STORAGE CALL — the module contains none", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(
        new URL("../src/services/operations/operations-source-probes.ts", import.meta.url),
      ),
      "utf8",
    );
    for (const forbidden of [
      "PutObjectLegalHold",
      "PutObjectRetention",
      "HeadObjectCommand",
      "S3Client",
      "getSignedUrl",
      "fetch(",
      "axios",
    ]) {
      expect(src.includes(forbidden), `probe module references ${forbidden}`).toBe(
        false,
      );
    }
  });

  it("the sweep writes NOTHING to the evidence row", async () => {
    const evidenceId = await evidenceRecord();
    await openDrift(evidenceId);
    const columns = {
      tsaStatus: true,
      tsaTokenBase64: true,
      tsaSerialNumber: true,
      tsaGenTimeUtc: true,
      otsStatus: true,
      otsProofBase64: true,
      otsHash: true,
      otsAnchoredAtUtc: true,
      otsUpgradedAtUtc: true,
      fileSha256: true,
      retentionUntilUtc: true,
      status: true,
    } as const;
    const before = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: columns,
    });
    await recordCheck(evidenceId, "OK");
    await sweep.sweepSourceTruthRecoveries({
      teamId: team.teamId,
      sourceId: DRIFT_SOURCE,
    });
    expect(
      await prisma.evidence.findUniqueOrThrow({
        where: { id: evidenceId },
        select: columns,
      }),
    ).toEqual(before);
  }, 300_000);

  // =========================================================================
  // 4. SEARCH INDEX — A REGISTERED SOURCE THAT NOW HAS A REAL PRODUCER
  // =========================================================================

  async function searchRun(status: "SUCCEEDED" | "FAILED" | "PARTIAL" | "RUNNING") {
    await prisma.governanceReconciliationRun.create({
      data: {
        teamId: team.teamId,
        kind: "SEARCH_INDEX" as never,
        trigger: "scheduler",
        status: status as never,
        lockKey: `search:${team.teamId}:${Math.random().toString(36).slice(2)}`,
        startedAtUtc: new Date(),
        finishedAtUtc: status === "RUNNING" ? null : new Date(),
      } as never,
    });
  }

  const searchCondition = () =>
    prisma.operationalIncident.findFirst({
      where: { teamId: team.teamId, sourceId: SEARCH_SOURCE },
      select: { id: true, status: true, severity: true, title: true },
    });

  it("NO TERMINAL RUN OPENS NOTHING — an absence is not a finding", async () => {
    const outcome = await searchConditions.syncSearchIndexConditions({
      teamId: team.teamId,
    });
    expect(outcome.unknown).toBe(true);
    expect(outcome.active).toBe(false);
    expect(await searchCondition()).toBeNull();
  }, 300_000);

  it("a RUNNING run is not an answer either", async () => {
    await searchRun("RUNNING");
    const outcome = await searchConditions.syncSearchIndexConditions({
      teamId: team.teamId,
    });
    expect(outcome.unknown).toBe(true);
    expect(await searchCondition()).toBeNull();
  }, 300_000);

  it("a FAILED run opens one workspace-level condition", async () => {
    await searchRun("FAILED");
    await searchConditions.syncSearchIndexConditions({ teamId: team.teamId });
    const condition = await searchCondition();
    expect(condition).not.toBeNull();
    expect(condition!.status).toBe("OPEN");
    // WARNING: nothing evidential depends on the search index.
    expect(condition!.severity).toBe("WARNING");
    // COUNT-FREE, and identical to the source contract's label.
    expect(condition!.title).toBe(
      authority.lifecycleForSourceId(SEARCH_SOURCE)!.displayLabel,
    );
    expect(condition!.title).not.toMatch(/[0-9]/);
  }, 300_000);

  it("a PARTIAL run counts as failing — half an index is out of step", async () => {
    await searchRun("PARTIAL");
    await searchConditions.syncSearchIndexConditions({ teamId: team.teamId });
    expect((await searchCondition())!.status).toBe("OPEN");
  }, 300_000);

  it("ONE CONDITION FOR MANY FAILING RUNS, and a later success closes it", async () => {
    await searchRun("FAILED");
    await searchConditions.syncSearchIndexConditions({ teamId: team.teamId });
    await searchRun("FAILED");
    await searchConditions.syncSearchIndexConditions({ teamId: team.teamId });
    expect(
      await prisma.operationalIncident.count({
        where: { teamId: team.teamId, sourceId: SEARCH_SOURCE },
      }),
    ).toBe(1);

    await searchRun("SUCCEEDED");
    const outcome = await searchConditions.syncSearchIndexConditions({
      teamId: team.teamId,
    });
    expect(outcome.resolved).toBe(1);
    expect((await searchCondition())!.status).toBe("RESOLVED");
  }, 300_000);

  it("a search condition cannot be closed by hand while the run says FAILED", async () => {
    await searchRun("FAILED");
    await searchConditions.syncSearchIndexConditions({ teamId: team.teamId });
    const condition = (await searchCondition())!;
    const before = await snapshot(condition.id);
    await expect(
      incidents.resolveIncident({
        incidentId: condition.id,
        teamId: team.teamId,
        actorUserId: team.ownerUserId,
        resolutionNote: "reindexed manually",
      }),
    ).rejects.toMatchObject({ code: "CONDITION_STILL_ACTIVE" });
    expect(await snapshot(condition.id)).toEqual(before);
  }, 300_000);

  // =========================================================================
  // 5. THE FIVE REMAINING NON-PRODUCING SOURCES
  // =========================================================================

  it("the non-producing sources are not advertised as active coverage", () => {
    const notDiscovered = authority.OPERATIONS_SOURCE_LIFECYCLES.filter(
      (s) => s.discoveryState === "NOT_YET_DISCOVERED",
    );
    // Five, not six: `search.indexing_failure` has a producer now.
    expect(notDiscovered.map((s) => s.sourceId).sort()).toEqual(
      [
        "ai.condition",
        "database.condition",
        "integration.configuration_failure",
        "job.background_failure",
        "storage.condition",
      ].sort(),
    );
    for (const s of notDiscovered) {
      // No producer, no probe, and no way to declare one over. A source with
      // nothing behind it must not be closable by anybody.
      expect(s.producers, s.sourceId).toEqual([]);
      expect(s.resolutionAuthority, s.sourceId).toBe("NO_DIRECT_RESOLUTION");
      expect(s.activityProbeKey, s.sourceId).toBe("NONE");
      expect(authority.offersManualResolution(s), s.sourceId).toBe(false);
    }
    // …and none of them is in the ACTIVE set the emitter gate requires
    // producers for.
    const active = new Set(authority.activeOperationsSourceIds());
    for (const s of notDiscovered) expect(active.has(s.sourceId)).toBe(false);
    expect(active.has(SEARCH_SOURCE)).toBe(true);
  });

  it("THE FOUR PLATFORM DOMAINS NEVER REACH A TENANT SURFACE", async () => {
    const platformIds = authority.platformInternalSourceIds();
    for (const id of [
      "database.condition",
      "storage.condition",
      "ai.condition",
      "job.background_failure",
    ]) {
      expect(platformIds, `${id} must be platform-internal`).toContain(id);
    }

    // Written anyway — the point is that a row EXISTING does not put it in a
    // tenant's queue, counters or readiness. One PostgreSQL instance serves
    // every workspace; a database fault is one problem, not a hundred.
    await prisma.operationalIncident.create({
      data: {
        teamId: team.teamId,
        scope: "WORKSPACE",
        sourceId: "database.condition",
        category: "DATABASE" as never,
        severity: "CRITICAL",
        status: "OPEN",
        fingerprint: `database:condition:${team.teamId}`,
        title: "Database condition",
        safeSummary: "A platform-wide database fault.",
        updatedAt: new Date(),
      } as never,
    });
    // A genuine TENANT condition, so this is not a vacuous pass over an empty
    // workspace.
    const evidenceId = await evidenceRecord();
    await openDrift(evidenceId);

    const page = await incidents.listIncidents({
      teamId: team.teamId,
      now: new Date(),
      sla: null,
      limit: 100,
      cursor: null,
    } as never);
    const sources = page.incidents.map((i) => i.sourceId);
    expect(sources).not.toContain("database.condition");
    expect(sources).toContain(DRIFT_SOURCE);

    const counts = await summary.buildOperationsSummary({
      teamId: team.teamId,
    } as never);
    // The platform row is excluded from every counter, so a tenant's CRITICAL
    // count is about the tenant.
    expect(JSON.stringify(counts)).not.toContain("database.condition");
  }, 300_000);
});
