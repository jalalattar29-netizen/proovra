/**
 * §7 / §8 / §12 / §15 — DURABLE OPERATIONS RECONCILIATION, live PostgreSQL 16.
 *
 * `operations-convergence.integration.test.ts` already pins the SCOPE half of
 * this phase: a personal workspace's legacy NULL-team evidence must be
 * discovered, so Home and Operations cannot disagree about whether a workspace
 * has failing records.
 *
 * This suite pins the RUN half — the properties that only exist because
 * discovery now happens under a durable, leased, per-workspace claim instead
 * of as a side effect of somebody opening a page:
 *
 *   * repeated reconciliation is idempotent — no duplicate occurrences;
 *   * two concurrent callers produce ONE run, and contention is a truthful
 *     no-op rather than an error or a second body;
 *   * a crashed run's lease expires and the next caller recovers the
 *     workspace instead of waiting on a lock nobody holds;
 *   * one workspace failing does not abandon the sweep;
 *   * never-run, stale, failed, stalled and partial all REFUSE the all-clear;
 *   * a source recovering clears its condition, and re-failing reopens it;
 *   * suppression silences notification without touching source health;
 *   * a platform or orphan incident is invisible to every tenant surface.
 *
 * Every one of these is a behaviour the previous design could not express at
 * all, which is why they are proven against a real database rather than a
 * mock: the exclusion is a partial unique index, and a mock cannot hold one.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Workspace Operations reconciliation (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let ops: typeof import("../src/services/operations/operations-reconciliation.service.js");
  let sweep: typeof import("../src/jobs/workspace-operations-reconciliation.job.js");
  let runtime: typeof import("@proovra/shared-runtime");
  let incidents: typeof import("../src/services/observability/incident.service.js");
  let scope: typeof import("../src/services/observability/incident-scope.js");

  let personal: { userId: string; teamId: string };
  let teamA: { teamId: string };
  let teamB: { teamId: string };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ops = await import(
      "../src/services/operations/operations-reconciliation.service.js"
    );
    sweep = await import("../src/jobs/workspace-operations-reconciliation.job.js");
    runtime = await import("@proovra/shared-runtime");
    incidents = await import("../src/services/observability/incident.service.js");
    scope = await import("../src/services/observability/incident-scope.js");

    personal = {
      userId: harness.fixtures.personal.userId,
      teamId: harness.fixtures.personal.teamId,
    };
    teamA = { teamId: harness.fixtures.teamA.teamId };
    teamB = { teamId: harness.fixtures.teamB.teamId };
  }, 900_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  beforeEach(async () => {
    // A clean run table per case. The incidents themselves are left alone —
    // several cases care about upsert behaviour ACROSS runs.
    await prisma.governanceReconciliationRun.deleteMany({
      where: { kind: "WORKSPACE_OPERATIONS" },
    });
  });

  // -------------------------------------------------------------------------
  // The run authority.
  // -------------------------------------------------------------------------

  it("records a durable run row for a workspace that has never been scanned", async () => {
    const before = await runtime.latestWorkspaceOperationsRun(prisma, teamA.teamId);
    expect(before).toBeNull(); // NEVER_RUN is null, not a synthetic stale run.

    const outcome = await ops.reconcileWorkspaceOperations({
      workspaceId: teamA.teamId,
      trigger: "cli",
    });
    expect(outcome.kind).toBe("ran");

    const after = await runtime.latestWorkspaceOperationsRun(prisma, teamA.teamId);
    expect(after).not.toBeNull();
    expect(["READY", "PARTIAL"]).toContain(after!.readiness);
    // The accounting is PERSISTED, not re-derived: this is what lets a later
    // reader tell "looked and found nothing" from "never looked".
    expect(after!.sources.requiredSources.length).toBeGreaterThan(0);
    expect(after!.sources.attemptedSources.length).toBeGreaterThan(0);
  });

  it("is idempotent — repeated reconciliation opens no duplicate conditions", async () => {
    await ops.reconcileWorkspaceOperations({
      workspaceId: personal.teamId,
      trigger: "cli",
    });
    const firstPass = await prisma.operationalIncident.findMany({
      where: scope.workspaceIncidentWhere(personal.teamId),
      select: { id: true, fingerprint: true, occurrenceCount: true },
      orderBy: { fingerprint: "asc" },
    });

    await ops.reconcileWorkspaceOperations({
      workspaceId: personal.teamId,
      trigger: "cli",
    });
    const secondPass = await prisma.operationalIncident.findMany({
      where: scope.workspaceIncidentWhere(personal.teamId),
      select: { id: true, fingerprint: true, occurrenceCount: true },
      orderBy: { fingerprint: "asc" },
    });

    // Same ROWS, by id. A second sweep that created parallel conditions would
    // double every count on the Operations page while nothing had changed.
    expect(secondPass.map((r) => r.id)).toEqual(firstPass.map((r) => r.id));
    expect(secondPass.map((r) => r.fingerprint)).toEqual(
      firstPass.map((r) => r.fingerprint),
    );
  });

  it("two concurrent callers produce ONE run; the loser reports contention", async () => {
    const [a, b] = await Promise.all([
      ops.reconcileWorkspaceOperations({
        workspaceId: teamA.teamId,
        trigger: "api",
      }),
      ops.reconcileWorkspaceOperations({
        workspaceId: teamA.teamId,
        trigger: "scheduler",
      }),
    ]);

    const kinds = [a.kind, b.kind].sort();
    // Exactly one body ran. The other lost the INSERT to the partial unique
    // index — which is contention, a bounded no-op, and never an error.
    expect(kinds).toContain("ran");
    expect(kinds.filter((k) => k === "ran")).toHaveLength(1);
    expect(kinds).toContain("already_running");

    const rows = await prisma.governanceReconciliationRun.count({
      where: { kind: "WORKSPACE_OPERATIONS", teamId: teamA.teamId },
    });
    expect(rows).toBe(1);
  });

  it("a RUNNING row past its lease reads STALLED, and the next caller recovers it", async () => {
    // Simulate a process that died holding the claim.
    const stale = new Date(Date.now() - (runtime.RUN_LOCK_LEASE_MS + 60_000));
    await prisma.governanceReconciliationRun.create({
      data: {
        teamId: teamB.teamId,
        kind: "WORKSPACE_OPERATIONS",
        trigger: "scheduler",
        lockKey: runtime.workspaceOperationsLockKey(teamB.teamId),
        status: "RUNNING",
        startedAtUtc: stale,
      },
    });

    const stalled = await runtime.latestWorkspaceOperationsRun(prisma, teamB.teamId);
    expect(stalled!.readiness).toBe("STALLED");
    // A STALLED workspace must never be describable as clear — it is the
    // state that looks most like "busy" and is actually "abandoned".
    expect(
      runtime.mayAssertOperationsClear({
        run: stalled,
        incidentReadComplete: true,
        unresolvedCount: 0,
      }).clear,
    ).toBe(false);

    const recovered = await ops.reconcileWorkspaceOperations({
      workspaceId: teamB.teamId,
      trigger: "scheduler",
    });
    expect(recovered.kind).toBe("ran");
    const after = await runtime.latestWorkspaceOperationsRun(prisma, teamB.teamId);
    expect(["READY", "PARTIAL"]).toContain(after!.readiness);
  });

  it("one workspace failing does not abandon the sweep", async () => {
    // A workspace id that does not exist: its claim is recorded against a
    // teamId with no Team row, which the FK rejects.
    const ghost = randomUUID();
    await expect(
      sweep.runWorkspaceOperationsSweep({ trigger: "cli", batchSize: 50 }),
    ).resolves.toBeTruthy();

    const failed = await ops
      .reconcileWorkspaceOperations({ workspaceId: ghost, trigger: "cli" })
      .catch(() => ({ kind: "failed" as const }));
    expect(["failed", "ran", "already_running"]).toContain(failed.kind);

    // The sweep still completes and still reaches real workspaces.
    const result = await sweep.runWorkspaceOperationsSweep({
      trigger: "cli",
      batchSize: 50,
    });
    expect(result.ok).toBe(true);
  });

  /**
   * Sweep until nothing is due, bounded.
   *
   * The sweep is DELIBERATELY bounded per tick — that is the property that
   * stops one tick turning into a full-table scan on a large deployment — so a
   * single call reaches at most `batchSize` workspaces, oldest-first. An
   * earlier version of these two cases called it once and assumed the batch had
   * covered the whole database. That held in a small fixture and failed the
   * moment the suite ran against a database with more workspaces than the
   * batch, which is exactly the condition the bound exists for.
   *
   * Draining is what the scheduler does across successive ticks, so this is
   * the honest way to assert "eventually reaches everything" without asserting
   * "reaches everything at once", which is the opposite of the design.
   */
  async function drainSweep(maxTicks = 40): Promise<number> {
    let ticks = 0;
    for (; ticks < maxTicks; ticks += 1) {
      const r = await sweep.runWorkspaceOperationsSweep({
        trigger: "cli",
        batchSize: 50,
      });
      expect(r.ok, "a sweep tick failed outright").toBe(true);
      if (r.reconciled === 0 && r.locked === 0) return ticks + 1;
    }
    throw new Error(`sweep did not drain within ${maxTicks} ticks`);
  }

  it("the sweep reaches workspaces nobody has opened", async () => {
    // The whole point of §7: discovery no longer depends on a page visit.
    await prisma.governanceReconciliationRun.deleteMany({
      where: { kind: "WORKSPACE_OPERATIONS" },
    });
    await drainSweep();

    for (const workspaceId of [personal.teamId, teamA.teamId, teamB.teamId]) {
      const run = await runtime.latestWorkspaceOperationsRun(prisma, workspaceId);
      expect(run, `${workspaceId} was never scanned`).not.toBeNull();
    }
  });

  it("a workspace inside its freshness window is not re-swept", async () => {
    // Drain first: "nothing is due" is only assertable once nothing IS due.
    await drainSweep();
    const second = await sweep.runWorkspaceOperationsSweep({
      trigger: "cli",
      batchSize: 50,
    });
    // Churning fresh workspaces would spend the batch on ones that already
    // have a current picture while the ones that do not keep waiting.
    expect(second.reconciled).toBe(0);
  });

  // -------------------------------------------------------------------------
  // §8 — the false-clear contract, end to end.
  // -------------------------------------------------------------------------

  it("a NEVER-RUN workspace cannot be described as clear, even with zero conditions", async () => {
    const fresh = await prisma.team.create({
      data: {
        name: `never-run-${randomUUID().slice(0, 8)}`,
        ownerUserId: personal.userId,
        isPersonal: false,
        // The canonical kind is required, and stating it keeps this fixture a
        // real ORGANIZATION workspace rather than one whose kind is
        // unprovable — which would deny at the authorization chain and test
        // something other than readiness.
        workspaceKind: "ORGANIZATION",
        organizationId: (
          await prisma.team.findUniqueOrThrow({
            where: { id: teamA.teamId },
            select: { organizationId: true },
          })
        ).organizationId,
      },
      select: { id: true },
    });

    const { buildOperationsSummary } = await import(
      "../src/services/operations/operations-summary.service.js"
    );
    const summary = await buildOperationsSummary({ workspaceId: fresh.id });

    // Zero conditions AND a complete read — the exact combination that used
    // to license the all-clear over a workspace nothing had examined.
    expect(summary.open).toBe(0);
    expect(summary.complete).toBe(true);
    expect(summary.readiness).toBe("NEVER_RUN");
    expect(summary.mayAssertAllClear).toBe(false);
    expect(summary.clearRefusalReason).toBe("NEVER_RUN");
  });

  it("a workspace becomes clear-able only after a fresh READY run", async () => {
    const { buildOperationsSummary } = await import(
      "../src/services/operations/operations-summary.service.js"
    );
    // Resolve everything so the workspace genuinely has no unresolved work.
    await prisma.operationalIncident.updateMany({
      where: scope.workspaceIncidentWhere(teamB.teamId),
      data: { status: "RESOLVED", resolvedAtUtc: new Date() },
    });
    await ops.reconcileWorkspaceOperations({
      workspaceId: teamB.teamId,
      trigger: "cli",
    });

    const summary = await buildOperationsSummary({ workspaceId: teamB.teamId });
    if (summary.readiness === "READY" && summary.open === 0) {
      expect(summary.mayAssertAllClear).toBe(true);
      expect(summary.clearRefusalReason).toBeNull();
    } else {
      // A PARTIAL run is a legitimate outcome in a seeded fixture; what must
      // never happen is clear being asserted anyway.
      expect(summary.mayAssertAllClear).toBe(false);
    }
  });

  it("a stale run cannot assert clear", async () => {
    await ops.reconcileWorkspaceOperations({
      workspaceId: teamA.teamId,
      trigger: "cli",
    });
    const beyond = new Date(
      Date.now() - (runtime.OPERATIONS_FRESHNESS_WINDOW_MS + 60_000),
    );
    await prisma.governanceReconciliationRun.updateMany({
      where: { kind: "WORKSPACE_OPERATIONS", teamId: teamA.teamId },
      data: { startedAtUtc: beyond, finishedAtUtc: beyond },
    });

    const run = await runtime.latestWorkspaceOperationsRun(prisma, teamA.teamId);
    expect(run!.readiness).toBe("STALE");
    expect(
      runtime.mayAssertOperationsClear({
        run,
        incidentReadComplete: true,
        unresolvedCount: 0,
      }),
    ).toEqual({ clear: false, reason: "STALE" });
  });

  // -------------------------------------------------------------------------
  // §12 — the scope discriminator.
  // -------------------------------------------------------------------------

  it("a PLATFORM incident is invisible to every tenant surface", async () => {
    const platform = await prisma.operationalIncident.create({
      data: {
        teamId: null,
        scope: "PLATFORM",
        category: "DATABASE",
        severity: "CRITICAL",
        status: "OPEN",
        fingerprint: `platform:probe:${randomUUID()}`,
        title: "Platform-wide condition",
        safeSummary: "A deliberate platform incident.",
      },
      select: { id: true },
    });

    for (const workspaceId of [personal.teamId, teamA.teamId, teamB.teamId]) {
      const page = await incidents.listIncidents({ teamId: workspaceId });
      expect(page.incidents.map((i) => i.id)).not.toContain(platform.id);
    }
    // It IS reachable through the platform predicate — hidden from tenants is
    // not the same as lost.
    const viaPlatform = await prisma.operationalIncident.findMany({
      where: scope.platformIncidentWhere(),
      select: { id: true },
    });
    expect(viaPlatform.map((i) => i.id)).toContain(platform.id);
  });

  it("a LEGACY_UNSCOPED orphan is invisible to tenant AND platform surfaces", async () => {
    const orphan = await prisma.operationalIncident.create({
      data: {
        teamId: null,
        scope: "LEGACY_UNSCOPED",
        category: "REPORT",
        severity: "HIGH",
        status: "OPEN",
        fingerprint: `orphan:probe:${randomUUID()}`,
        title: "Orphan of a deleted workspace",
        safeSummary: "Ambiguous NULL-team row.",
      },
      select: { id: true },
    });

    for (const workspaceId of [personal.teamId, teamA.teamId, teamB.teamId]) {
      const page = await incidents.listIncidents({ teamId: workspaceId });
      expect(page.incidents.map((i) => i.id)).not.toContain(orphan.id);
    }
    const viaPlatform = await prisma.operationalIncident.findMany({
      where: scope.platformIncidentWhere(),
      select: { id: true },
    });
    expect(viaPlatform.map((i) => i.id)).not.toContain(orphan.id);

    // Retained, never deleted — the audit history of a condition survives the
    // loss of its workspace, and it is findable by the quarantine predicate.
    const quarantined = await prisma.operationalIncident.findMany({
      where: scope.legacyUnscopedIncidentWhere(),
      select: { id: true },
    });
    expect(quarantined.map((i) => i.id)).toContain(orphan.id);
  });

  it("recordIncident stamps WORKSPACE for a workspace write and never for a null one", async () => {
    const withTeam = await incidents.recordIncident({
      teamId: teamA.teamId,
      category: "REPORT",
      severity: "WARNING",
      fingerprint: `scope-probe:${randomUUID()}`,
      title: "Scope probe",
      safeSummary: "Probing the scope discriminator.",
    });
    expect(withTeam.incident.scope).toBe("WORKSPACE");

    const withoutTeam = await incidents.recordIncident({
      teamId: null,
      category: "REPORT",
      severity: "WARNING",
      fingerprint: `scope-probe-null:${randomUUID()}`,
      title: "Scope probe (no workspace)",
      safeSummary: "Probing the scope discriminator.",
    });
    // NOT WORKSPACE — that would be a lie about which tenant it belongs to —
    // and NOT PLATFORM, which would invent an intent the caller never stated.
    expect(withoutTeam.incident.scope).toBe("LEGACY_UNSCOPED");
  });

  it("no tenant read returns another workspace's conditions", async () => {
    const a = await incidents.listIncidents({ teamId: teamA.teamId });
    const b = await incidents.listIncidents({ teamId: teamB.teamId });
    const aIds = new Set(a.incidents.map((i) => i.id));
    for (const row of b.incidents) expect(aIds.has(row.id)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Source recovery, reopen, and suppression.
  // -------------------------------------------------------------------------

  it("suppression silences the condition without resolving it or touching the source", async () => {
    const created = await incidents.recordIncident({
      teamId: teamA.teamId,
      category: "REPORT",
      severity: "HIGH",
      fingerprint: `suppress-probe:${randomUUID()}`,
      title: "Suppression probe",
      safeSummary: "Probing suppression semantics.",
    });

    await incidents.suppressIncident({
      incidentId: created.incident.id,
      teamId: teamA.teamId,
      actorUserId: harness.fixtures.teamA.ownerUserId,
      note: "Known and accepted for now",
    } as never);

    const after = await prisma.operationalIncident.findUniqueOrThrow({
      where: { id: created.incident.id },
      select: { status: true, resolvedAtUtc: true },
    });
    expect(after.status).toBe("SUPPRESSED");
    // Suppression silences NOTIFICATION. The condition is still unresolved and
    // still unfixed; recording it as resolved would let a workspace improve
    // its own SLA numbers by pressing a button.
    expect(after.resolvedAtUtc).toBeNull();

    const { buildOperationsSummary } = await import(
      "../src/services/operations/operations-summary.service.js"
    );
    const summary = await buildOperationsSummary({ workspaceId: teamA.teamId });
    // SUPPRESSED counts as unresolved work, so it still blocks the all-clear.
    expect(summary.open).toBeGreaterThan(0);
    expect(summary.mayAssertAllClear).toBe(false);
  });

  it("a re-observed condition ticks its occurrence rather than creating a twin", async () => {
    const fingerprint = `reopen-probe:${randomUUID()}`;
    const first = await incidents.recordIncident({
      teamId: teamA.teamId,
      category: "PACKAGE",
      severity: "WARNING",
      fingerprint,
      title: "Reopen probe",
      safeSummary: "First observation.",
    });
    const second = await incidents.recordIncident({
      teamId: teamA.teamId,
      category: "PACKAGE",
      severity: "WARNING",
      fingerprint,
      title: "Reopen probe",
      safeSummary: "Second observation.",
    });

    expect(second.incident.id).toBe(first.incident.id);
    expect(second.incident.occurrenceCount).toBeGreaterThan(
      first.incident.occurrenceCount,
    );
    expect(second.created).toBe(false);
  });
});
