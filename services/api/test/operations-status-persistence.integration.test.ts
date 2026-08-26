/**
 * OPERATOR STATE SURVIVES RECONCILIATION — live PostgreSQL 16.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG
 * ---------------------------------------------------------------------------
 * An operational condition has two kinds of writer. Operators transition it
 * deliberately; the reconciler observes its source on a schedule. Both wrote
 * `status`, and the reconciler's write won unconditionally:
 *
 *   * a RESOLVED condition whose source was still failing went back to OPEN
 *     on the next sweep, recorded as an ordinary `increment`, with
 *     `resolvedAtUtc`, the resolver's identity and the operator's note erased;
 *   * SUPPRESSED did the same for every source except evidence-integrity,
 *     which had a private guard nobody else shared;
 *   * ACKNOWLEDGED survived a re-observation, but a recover-then-recur cycle
 *     laundered it: the recovery resolver closed it, and the recurrence
 *     reopened it as OPEN, so the acknowledgement was gone and nothing in the
 *     history said so;
 *   * an operator could mark an actively-failing condition resolved, and the
 *     sweep silently undid it minutes later.
 *
 * The API and the Worker each carried their own copy of the rule, which is
 * how a fix in one kept failing in the other.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE CASES HOLD
 * ---------------------------------------------------------------------------
 * The decision now comes from ONE pure authority in `@proovra/shared-runtime`,
 * consumed by both writers. Every case below runs the REAL services against a
 * real database — no mocked reimplementation — because the defect was never in
 * the shape of the rule, it was in which writer got to apply it.
 *
 * History is append-only throughout. A reopen clears the CURRENT cycle's
 * acknowledgement and leaves every `acknowledged` and `resolved` event from
 * the previous cycle exactly where it was: who owned this, and who closed it,
 * are answerable after the condition has been through several lives.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Operator state survives reconciliation (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let incidents: typeof import("../src/services/observability/incident.service.js");
  let ops: typeof import("../src/services/operations/operations-reconciliation.service.js");
  let authority: typeof import("@proovra/shared-runtime");

  /** The four workspace kinds, provisioned rather than simulated. */
  let contexts: Array<{
    label: string;
    teamId: string;
    ownerUserId: string;
    /** A personal space's evidence carries the legacy `team_id = NULL` shape. */
    legacyEvidenceScope: boolean;
  }>;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    incidents = await import("../src/services/observability/incident.service.js");
    ops = await import(
      "../src/services/operations/operations-reconciliation.service.js"
    );
    authority = await import("@proovra/shared-runtime");

    const orgB = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamB.teamId },
      select: { organizationId: true, ownerUserId: true },
    });
    // A fourth workspace standing for an Enterprise tenant. Nothing below
    // reads a plan name, which is exactly the claim this suite executes.
    const enterprise = await prisma.team.create({
      data: {
        name: "Enterprise status-persistence fixture",
        ownerUserId: orgB.ownerUserId!,
        organizationId: orgB.organizationId,
        workspaceKind: "ORGANIZATION",
      },
      select: { id: true, ownerUserId: true },
    });
    await prisma.teamMember.create({
      data: {
        teamId: enterprise.id,
        userId: enterprise.ownerUserId!,
        role: "OWNER",
        status: "ACTIVE",
      },
    });

    contexts = [
      {
        label: "personal-pro",
        teamId: harness.fixtures.personal.teamId,
        ownerUserId: harness.fixtures.personal.userId,
        legacyEvidenceScope: true,
      },
      {
        label: "team",
        teamId: harness.fixtures.teamA.teamId,
        ownerUserId: harness.fixtures.teamA.ownerUserId,
        legacyEvidenceScope: false,
      },
      {
        label: "organization",
        teamId: harness.fixtures.teamB.teamId,
        ownerUserId: harness.fixtures.teamB.ownerUserId,
        legacyEvidenceScope: false,
      },
      {
        label: "enterprise",
        teamId: enterprise.id,
        ownerUserId: enterprise.ownerUserId!,
        legacyEvidenceScope: false,
      },
    ];
  }, 900_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  // Each case owns its own records and conditions. Cleared afterwards so the
  // reconciler in the next case discovers only what that case created.
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

  /** One record whose RFC3161 timestamp is missing: a deterministic source. */
  async function failingRecord(ctx: {
    teamId: string;
    ownerUserId: string;
    legacyEvidenceScope: boolean;
  }): Promise<{ evidenceId: string }> {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: ctx.teamId },
      select: { organizationId: true },
    });
    const base = ctx.legacyEvidenceScope
      ? { teamId: null, organizationId: null, ownerUserId: ctx.ownerUserId }
      : {
          teamId: ctx.teamId,
          organizationId: team.organizationId,
          ownerUserId: ctx.ownerUserId,
        };
    const row = await prisma.evidence.create({
      data: {
        ...base,
        title: `status-persistence-${Math.random().toString(36).slice(2, 10)}`,
        type: "PHOTO",
        status: "REPORTED",
        tsaStatus: "FAILED",
        verificationPackageVersion: 1,
      } as never,
      select: { id: true },
    });
    created.evidenceIds.push(row.id);
    created.teamIds.add(ctx.teamId);
    return { evidenceId: row.id };
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

  async function conditionFor(evidenceId: string) {
    return prisma.operationalIncident.findFirstOrThrow({
      where: { fingerprint: `tsa_failure:${evidenceId}` },
      select: {
        id: true,
        status: true,
        fingerprint: true,
        occurrenceCount: true,
        acknowledgedAtUtc: true,
        acknowledgedByUserId: true,
        resolvedAtUtc: true,
        resolvedByUserId: true,
        resolutionNote: true,
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

  const primary = () => contexts[1]; // the OWNED team, for the single-context cases

  // =======================================================================
  // 1 + 2. An active observation records an occurrence and nothing else.
  // =======================================================================

  it("OPEN + repeated active observation stays OPEN and only counts", async () => {
    const ctx = primary();
    const { evidenceId } = await failingRecord(ctx);
    await reconcile(ctx.teamId);
    const first = await conditionFor(evidenceId);
    expect(first.status).toBe("OPEN");

    await reconcile(ctx.teamId);
    const second = await conditionFor(evidenceId);

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("OPEN");
    expect(second.occurrenceCount).toBeGreaterThan(first.occurrenceCount);
    expect(await eventTypes(first.id)).toEqual(["opened", "increment"]);
  });

  it("ACKNOWLEDGED + repeated active observations stays ACKNOWLEDGED, owner intact", async () => {
    const ctx = primary();
    const { evidenceId } = await failingRecord(ctx);
    await reconcile(ctx.teamId);
    const opened = await conditionFor(evidenceId);

    await incidents.acknowledgeIncident({
      incidentId: opened.id,
      teamId: ctx.teamId,
      actorUserId: ctx.ownerUserId,
    });
    const acked = await conditionFor(evidenceId);
    expect(acked.status).toBe("ACKNOWLEDGED");

    // THREE further sweeps. One was never the failure mode; the question is
    // whether ownership survives an unbounded number of observations.
    await reconcile(ctx.teamId);
    await reconcile(ctx.teamId);
    await reconcile(ctx.teamId);

    const after = await conditionFor(evidenceId);
    expect(after.id).toBe(acked.id);
    expect(after.status).toBe("ACKNOWLEDGED");
    expect(after.acknowledgedByUserId).toBe(ctx.ownerUserId);
    expect(after.acknowledgedAtUtc?.toISOString()).toBe(
      acked.acknowledgedAtUtc?.toISOString(),
    );
    expect(after.occurrenceCount).toBeGreaterThan(acked.occurrenceCount);
    // No reopen was invented on the way.
    expect(await eventTypes(after.id)).not.toContain("reopened");
  });

  // =======================================================================
  // 3 + 4 + 5 + 6. Recovery, recurrence, identity and cycle boundaries.
  // =======================================================================

  it("ACKNOWLEDGED + source recovery resolves it and KEEPS the acknowledgement history", async () => {
    const ctx = primary();
    const { evidenceId } = await failingRecord(ctx);
    await reconcile(ctx.teamId);
    const opened = await conditionFor(evidenceId);
    await incidents.acknowledgeIncident({
      incidentId: opened.id,
      teamId: ctx.teamId,
      actorUserId: ctx.ownerUserId,
    });

    await prisma.evidence.update({
      where: { id: evidenceId },
      data: { tsaStatus: "CONFIRMED" },
    });
    await reconcile(ctx.teamId);

    const resolved = await conditionFor(evidenceId);
    expect(resolved.id).toBe(opened.id);
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolvedAtUtc).not.toBeNull();
    // A domain-truth resolution fabricates no human resolver.
    expect(resolved.resolvedByUserId).toBeNull();
    // The acknowledgement is NOT erased by the resolution: who took this on is
    // part of what happened to it.
    expect(resolved.acknowledgedByUserId).toBe(ctx.ownerUserId);

    const events = await eventTypes(opened.id);
    expect(events).toContain("acknowledged");
    expect(events).toContain("resolved_by_domain_truth");
    // The promise is discharged, not left hanging.
    expect(await liveCycleCount(opened.id)).toBe(0);
  });

  it("recurrence after a proven recovery REOPENS explicitly, on the same id, with a new cycle", async () => {
    const ctx = primary();
    const { evidenceId } = await failingRecord(ctx);
    await reconcile(ctx.teamId);
    const opened = await conditionFor(evidenceId);
    await incidents.acknowledgeIncident({
      incidentId: opened.id,
      teamId: ctx.teamId,
      actorUserId: ctx.ownerUserId,
    });

    await prisma.evidence.update({
      where: { id: evidenceId },
      data: { tsaStatus: "CONFIRMED" },
    });
    await reconcile(ctx.teamId);
    expect((await conditionFor(evidenceId)).status).toBe("RESOLVED");

    await prisma.evidence.update({
      where: { id: evidenceId },
      data: { tsaStatus: "FAILED" },
    });
    await reconcile(ctx.teamId);

    const reopened = await conditionFor(evidenceId);
    // 5. IDENTITY. The condition is the same condition; the fingerprint is
    //    what makes its whole history one story.
    expect(reopened.id).toBe(opened.id);
    expect(reopened.fingerprint).toBe(`tsa_failure:${evidenceId}`);
    expect(reopened.status).toBe("OPEN");

    // 6. CURRENT-CYCLE acknowledgement is cleared — nobody owns this
    //    occurrence yet — while the previous cycle's events remain.
    expect(reopened.acknowledgedAtUtc).toBeNull();
    expect(reopened.acknowledgedByUserId).toBeNull();
    expect(reopened.resolvedAtUtc).toBeNull();

    const events = await eventTypes(opened.id);
    expect(events).toContain("reopened");
    expect(events).toContain("acknowledged");
    expect(events).toContain("resolved_by_domain_truth");
    // The reopen is NOT an increment. That distinction is the whole point:
    // an operator reading the timeline can see that a new cycle began.
    const reopenIndex = events.lastIndexOf("reopened");
    expect(reopenIndex).toBeGreaterThan(events.indexOf("resolved_by_domain_truth"));

    const reopenEvent = await prisma.operationalIncidentEvent.findFirstOrThrow({
      where: { incidentId: opened.id, eventType: "reopened" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { metadataJson: true },
    });
    expect(
      (reopenEvent.metadataJson as { reopenReason?: string } | null)
        ?.reopenReason,
    ).toBe("SOURCE_RECURRENCE");

    // A new promise, not a resurrected one.
    expect(await liveCycleCount(opened.id)).toBe(1);
  });

  // =======================================================================
  // 7. A manual resolution of an active deterministic condition is refused.
  // =======================================================================

  it("manual Resolve of an ACTIVE source is refused and writes NOTHING", async () => {
    const ctx = primary();
    const { evidenceId } = await failingRecord(ctx);
    await reconcile(ctx.teamId);
    const before = await conditionFor(evidenceId);
    const eventsBefore = await eventTypes(before.id);
    const cyclesBefore = await prisma.operationalIncidentSlaCycle.count({
      where: { incidentId: before.id },
    });

    await expect(
      incidents.resolveIncident({
        incidentId: before.id,
        teamId: ctx.teamId,
        actorUserId: ctx.ownerUserId,
        resolutionNote: "looks fine to me",
      }),
    ).rejects.toMatchObject({ code: "CONDITION_STILL_ACTIVE" });

    const after = await conditionFor(evidenceId);
    expect(after.status).toBe(before.status);
    expect(after.resolvedAtUtc).toBeNull();
    expect(after.resolvedByUserId).toBeNull();
    expect(after.resolutionNote).toBeNull();
    expect(after.occurrenceCount).toBe(before.occurrenceCount);
    expect(await eventTypes(before.id)).toEqual(eventsBefore);
    expect(
      await prisma.operationalIncidentSlaCycle.count({
        where: { incidentId: before.id },
      }),
    ).toBe(cyclesBefore);
  });

  it("the SAME operator may resolve it once its source has recovered", async () => {
    const ctx = primary();
    const { evidenceId } = await failingRecord(ctx);
    await reconcile(ctx.teamId);
    const opened = await conditionFor(evidenceId);

    await prisma.evidence.update({
      where: { id: evidenceId },
      data: { tsaStatus: "CONFIRMED" },
    });
    // Resolved by hand BEFORE any sweep observes the recovery, so this is the
    // operator's own transition and not the resolver's.
    await incidents.resolveIncident({
      incidentId: opened.id,
      teamId: ctx.teamId,
      actorUserId: ctx.ownerUserId,
      resolutionNote: "re-anchored by hand",
    });

    const after = await conditionFor(evidenceId);
    expect(after.status).toBe("RESOLVED");
    expect(after.resolvedByUserId).toBe(ctx.ownerUserId);
    expect(await eventTypes(opened.id)).toContain("resolved");
  });

  // =======================================================================
  // 8. SUPPRESSED survives, for every kind of source.
  // =======================================================================

  it("SUPPRESSED survives an active observation — evidence-integrity source", async () => {
    const ctx = primary();
    const { evidenceId } = await failingRecord(ctx);
    await reconcile(ctx.teamId);
    const opened = await conditionFor(evidenceId);
    await incidents.suppressIncident({
      incidentId: opened.id,
      teamId: ctx.teamId,
      actorUserId: ctx.ownerUserId,
    });

    await reconcile(ctx.teamId);
    await reconcile(ctx.teamId);

    const after = await conditionFor(evidenceId);
    expect(after.id).toBe(opened.id);
    expect(after.status).toBe("SUPPRESSED");
    expect(after.occurrenceCount).toBeGreaterThan(opened.occurrenceCount);
    const events = await eventTypes(opened.id);
    expect(events).toContain("occurrence_while_suppressed");
    expect(events).not.toContain("reopened");
  });

  it("SUPPRESSED survives an active observation — a NON-evidence API source", async () => {
    const ctx = primary();
    created.teamIds.add(ctx.teamId);
    const fingerprint = `identity:probe:${Math.random().toString(36).slice(2, 10)}`;
    const first = await incidents.recordIncident({
      teamId: ctx.teamId,
      category: "IDENTITY_SECURITY",
      severity: "HIGH",
      fingerprint,
      title: "probe",
      safeSummary: "probe",
    });
    await incidents.suppressIncident({
      incidentId: first.incident.id,
      teamId: ctx.teamId,
      actorUserId: ctx.ownerUserId,
    });

    // The very observation that used to erase it. This source never had the
    // private guard evidence-integrity carried, which is why it is here.
    await incidents.recordIncident({
      teamId: ctx.teamId,
      category: "IDENTITY_SECURITY",
      severity: "HIGH",
      fingerprint,
      title: "probe",
      safeSummary: "probe",
    });

    const after = await prisma.operationalIncident.findUniqueOrThrow({
      where: { id: first.incident.id },
      select: { status: true },
    });
    expect(after.status).toBe("SUPPRESSED");
    expect(await eventTypes(first.incident.id)).toContain(
      "occurrence_while_suppressed",
    );
  });

  it("SUPPRESSED survives an active observation — a Worker-emitted source", async () => {
    const ctx = primary();
    created.teamIds.add(ctx.teamId);
    // The Worker writer is a separate service that cannot be imported here, so
    // what is asserted is that it reaches the SAME decision from the same
    // facts. The database effect is proven through the API writer above; this
    // pins the rule the Worker consumes.
    expect(
      authority.decideObservationTransition({
        currentStatus: "SUPPRESSED",
        observation: "SOURCE_ACTIVE",
      }),
    ).toBe("PRESERVE_SUPPRESSED");
    expect(
      authority.decisionChangesStatus(
        authority.decideObservationTransition({
          currentStatus: "SUPPRESSED",
          observation: "SOURCE_ACTIVE",
        }),
      ),
    ).toBe(false);
  });

  // =======================================================================
  // 9. A legacy manual resolution over an active source reopens ONCE,
  //    explicitly, and says why.
  // =======================================================================

  it("a legacy manually-resolved ACTIVE condition reopens once with a compatibility reason", async () => {
    const ctx = primary();
    const { evidenceId } = await failingRecord(ctx);
    await reconcile(ctx.teamId);
    const opened = await conditionFor(evidenceId);

    // The state a pre-correction database already contains: RESOLVED by a
    // person while the record still reads FAILED, with no source-recovery
    // event in its history. It is written directly because the product now
    // REFUSES to create it — which is the other half of this correction.
    await prisma.operationalIncident.update({
      where: { id: opened.id },
      data: {
        status: "RESOLVED",
        resolvedAtUtc: new Date(),
        resolvedByUserId: ctx.ownerUserId,
        resolutionNote: "closed before the rule existed",
      },
    });
    await prisma.operationalIncidentEvent.create({
      data: {
        incidentId: opened.id,
        eventType: "resolved",
        safeMessage: "closed before the rule existed",
      },
    });

    await reconcile(ctx.teamId);

    const after = await conditionFor(evidenceId);
    expect(after.id).toBe(opened.id);
    expect(after.status).toBe("OPEN");
    expect(after.acknowledgedAtUtc).toBeNull();

    const reopen = await prisma.operationalIncidentEvent.findFirstOrThrow({
      where: { incidentId: opened.id, eventType: "reopened" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { metadataJson: true },
    });
    expect(
      (reopen.metadataJson as { reopenReason?: string } | null)?.reopenReason,
    ).toBe("ACTIVE_SOURCE_AFTER_LEGACY_MANUAL_RESOLUTION");

    // HISTORY IS NOT REWRITTEN. The old resolution event and its note stay
    // exactly where they were; a compatibility reopen is an addition.
    const events = await eventTypes(opened.id);
    expect(events).toContain("resolved");
    expect(events.filter((e) => e === "reopened")).toHaveLength(1);
    expect(await liveCycleCount(opened.id)).toBe(1);
  });

  // =======================================================================
  // 10. The API and the Worker read the same rule from the same authority.
  // =======================================================================

  it("API and Worker derive their decision from ONE authority, over the whole table", async () => {
    const statuses = ["OPEN", "ACKNOWLEDGED", "RESOLVED", "SUPPRESSED"] as const;
    const origins = [
      "SOURCE_RECOVERY",
      "OPERATOR",
      "LEGACY_UNKNOWN",
      null,
    ] as const;

    // TOTALITY. Every reachable combination has an answer, every answer is in
    // the bounded vocabulary, and only a reopen or an auto-resolve is allowed
    // to touch status.
    for (const currentStatus of statuses) {
      for (const observation of ["SOURCE_ACTIVE", "SOURCE_RECOVERED"] as const) {
        for (const previousResolutionOrigin of origins) {
          const decision = authority.decideObservationTransition({
            currentStatus,
            observation,
            previousResolutionOrigin,
          });
          expect(
            authority.INCIDENT_TRANSITION_DECISIONS as readonly string[],
          ).toContain(decision);
          if (observation === "SOURCE_ACTIVE" && currentStatus !== "RESOLVED") {
            expect(authority.decisionChangesStatus(decision)).toBe(false);
          }
        }
      }
    }

    // The two reopen reasons are distinguishable and neither is an increment.
    expect(
      authority.reopenReasonFor(
        authority.decideObservationTransition({
          currentStatus: "RESOLVED",
          observation: "SOURCE_ACTIVE",
          previousResolutionOrigin: "SOURCE_RECOVERY",
        }),
      ),
    ).toBe("SOURCE_RECURRENCE");
    expect(
      authority.reopenReasonFor(
        authority.decideObservationTransition({
          currentStatus: "RESOLVED",
          observation: "SOURCE_ACTIVE",
          previousResolutionOrigin: "LEGACY_UNKNOWN",
        }),
      ),
    ).toBe("ACTIVE_SOURCE_AFTER_LEGACY_MANUAL_RESOLUTION");

    // Ambiguous provenance NEVER reads as a recurrence.
    expect(
      authority.decideObservationTransition({
        currentStatus: "RESOLVED",
        observation: "SOURCE_ACTIVE",
        previousResolutionOrigin: null,
      }),
    ).toBe("REOPEN_LEGACY_ACTIVE_SOURCE");
  });

  // =======================================================================
  // 11. The contract does not depend on the workspace kind.
  // =======================================================================

  it("Personal Pro, Team, Organization and Enterprise share ONE persistence contract", async () => {
    for (const ctx of contexts) {
      const { evidenceId } = await failingRecord(ctx);
      await reconcile(ctx.teamId);
      const opened = await conditionFor(evidenceId);
      expect(opened.status, ctx.label).toBe("OPEN");

      await incidents.acknowledgeIncident({
        incidentId: opened.id,
        teamId: ctx.teamId,
        actorUserId: ctx.ownerUserId,
      });
      await reconcile(ctx.teamId);
      const acked = await conditionFor(evidenceId);
      expect(acked.status, ctx.label).toBe("ACKNOWLEDGED");
      expect(acked.acknowledgedByUserId, ctx.label).toBe(ctx.ownerUserId);

      // And the refusal is the same refusal, with no plan-shaped exception.
      await expect(
        incidents.resolveIncident({
          incidentId: opened.id,
          teamId: ctx.teamId,
          actorUserId: ctx.ownerUserId,
        }),
        ctx.label,
      ).rejects.toMatchObject({ code: "CONDITION_STILL_ACTIVE" });
    }
  });

  // =======================================================================
  // 12. A restart cannot undo an operator decision.
  // =======================================================================

  it("a startup sweep cannot reset ACKNOWLEDGED or SUPPRESSED", async () => {
    const ctx = primary();
    const acknowledged = await failingRecord(ctx);
    const suppressed = await failingRecord(ctx);
    await reconcile(ctx.teamId);

    const a = await conditionFor(acknowledged.evidenceId);
    const s = await conditionFor(suppressed.evidenceId);
    await incidents.acknowledgeIncident({
      incidentId: a.id,
      teamId: ctx.teamId,
      actorUserId: ctx.ownerUserId,
    });
    await incidents.suppressIncident({
      incidentId: s.id,
      teamId: ctx.teamId,
      actorUserId: ctx.ownerUserId,
    });

    // The EXACT trigger the API schedules on boot. A restart used to be one of
    // the reliable ways to lose an operator's decision, because it is one of
    // the reliable ways to cause a sweep.
    await prisma.governanceReconciliationRun.deleteMany({
      where: { kind: "WORKSPACE_OPERATIONS", teamId: ctx.teamId },
    });
    await ops.reconcileWorkspaceOperations({
      workspaceId: ctx.teamId,
      trigger: "startup",
    });

    expect((await conditionFor(acknowledged.evidenceId)).status).toBe(
      "ACKNOWLEDGED",
    );
    expect((await conditionFor(acknowledged.evidenceId)).acknowledgedByUserId).toBe(
      ctx.ownerUserId,
    );
    expect((await conditionFor(suppressed.evidenceId)).status).toBe("SUPPRESSED");
  });
});
