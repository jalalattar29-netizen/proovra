/**
 * AGED-PENDING OTS DISCOVERY — live PostgreSQL 16.
 *
 * ---------------------------------------------------------------------------
 * THE GHOST SOURCE
 * ---------------------------------------------------------------------------
 * `evidence_integrity.ots_pending_aged` sat in the source registry for a
 * release with a probe key, a threshold and a complete lifecycle contract, and
 * it observed NOTHING. `syncEvidenceIntegrityConditions` iterated the two
 * FAILED integrity classes only, so a record that had been trying to anchor
 * for months was invisible until the Worker finally gave up and marked it
 * FAILED — at which point a DIFFERENT condition opened.
 *
 * The source looked covered. Every totality check passed. Nothing wrote it.
 *
 * ---------------------------------------------------------------------------
 * THE WINDOW IS NOT THE RETRY BUDGET — AND THAT IS THE CORRECTION
 * ---------------------------------------------------------------------------
 * When the ghost was given a producer, its threshold was the Worker's
 * thirty-day `OTS_GLOBAL_BUDGET_DAYS`, on the reasoning that one window keeps
 * the two hosts from disagreeing.
 *
 * That bound two different questions together. The budget answers HOW LONG THE
 * PLATFORM MAY KEEP TRYING; the condition answers WHEN AN OPERATOR SHOULD BE
 * TOLD. Sharing one number produced a surface with no useful middle: a proof
 * stuck for a week was invisible, and the moment it became visible was the
 * moment the Worker gave up on it — information arriving exactly too late to
 * be worth having.
 *
 * There are two windows now, each named for its own question. The retry budget
 * is untouched at thirty days and nothing here changes when the processor
 * stops, retries or gives up. The OPERATIONS aging policy is a separate,
 * server-owned ladder: nothing under a day, WARNING to three days, HIGH beyond
 * — and never CRITICAL, because the record's RFC3161 timestamp is unaffected
 * and a missing second proof must not rank beside a record that cannot be
 * timestamped at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS PROVEN NOT TO HAPPEN
 * ---------------------------------------------------------------------------
 * Observation is READ-ONLY. The cases below assert, against a real database,
 * that a full reconciliation over an aged record leaves every OTS and TSA
 * column, every proof, and every custody-relevant field byte-identical. No
 * calendar server is contacted, because nothing in the path can contact one.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

/** Inside the operations warning window: a proof that is simply working. */
const FRESH_HOURS = 6;
/** Past the warning boundary and short of the high one. */
const WARNING_HOURS = 36;
/** Past the high boundary. Also the default "aged" fixture. */
const AGED_HOURS = 96;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("Aged-pending OTS conditions (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let incidents: typeof import("../src/services/observability/incident.service.js");
  let ops: typeof import("../src/services/operations/operations-reconciliation.service.js");
  let integrity: typeof import("../src/services/operations/evidence-integrity-conditions.service.js");
  let authority: typeof import("@proovra/shared-runtime");

  let team: { teamId: string; ownerUserId: string; organizationId: string | null };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    incidents = await import("../src/services/observability/incident.service.js");
    ops = await import(
      "../src/services/operations/operations-reconciliation.service.js"
    );
    integrity = await import(
      "../src/services/operations/evidence-integrity-conditions.service.js"
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

  /**
   * A record whose OTS proof is still PENDING, `ageDays` old.
   *
   * The age is expressed the way the shared predicate reads it: no anchor has
   * ever been pinned, so `createdAt` is the first-attempt instant.
   */
  async function pendingRecord(ageHours: number): Promise<{ evidenceId: string }> {
    const row = await prisma.evidence.create({
      data: {
        teamId: team.teamId,
        organizationId: team.organizationId,
        ownerUserId: team.ownerUserId,
        title: `ots-pending-${ageHours}h-${Math.random().toString(36).slice(2, 10)}`,
        type: "PHOTO",
        status: "SIGNED",
        // The proof is trying. Not FAILED — that is a different condition with
        // a different source, and conflating them is what this class exists to
        // prevent.
        otsStatus: "PENDING",
        otsAnchoredAtUtc: null,
        createdAt: new Date(Date.now() - ageHours * HOUR_MS),
      } as never,
      select: { id: true },
    });
    created.evidenceIds.push(row.id);
    created.teamIds.add(team.teamId);
    return { evidenceId: row.id };
  }

  async function reconcile(): Promise<void> {
    created.teamIds.add(team.teamId);
    await prisma.governanceReconciliationRun.deleteMany({
      where: { kind: "WORKSPACE_OPERATIONS", teamId: team.teamId },
    });
    await ops.reconcileWorkspaceOperations({
      workspaceId: team.teamId,
      trigger: "cli",
    });
  }

  function fingerprint(evidenceId: string): string {
    return integrity.otsPendingAgedFingerprint(evidenceId);
  }

  async function conditionFor(evidenceId: string) {
    return prisma.operationalIncident.findFirst({
      where: { teamId: team.teamId, fingerprint: fingerprint(evidenceId) },
      select: {
        id: true,
        sourceId: true,
        status: true,
        severity: true,
        title: true,
        occurrenceCount: true,
        resolvedAtUtc: true,
        resolvedByUserId: true,
        relatedEvidenceId: true,
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

  /** Every field a proof or its custody depends on. */
  const PROOF_SELECT = {
    tsaStatus: true,
    tsaTokenBase64: true,
    tsaProvider: true,
    tsaFailureReason: true,
    otsStatus: true,
    otsProofBase64: true,
    otsHash: true,
    otsCalendar: true,
    otsBitcoinTxid: true,
    otsAnchoredAtUtc: true,
    otsUpgradedAtUtc: true,
    otsFailureReason: true,
    fileSha256: true,
  } as const;

  // =========================================================================
  // 1. THE WINDOW
  // =========================================================================

  it("a record pending INSIDE the window opens NO condition", async () => {
    const { evidenceId } = await pendingRecord(FRESH_HOURS);
    await reconcile();
    // Six hours in. Anchoring routinely takes hours, so a condition here
    // would put every recently-captured record in the queue and teach an
    // operator to ignore the source.
    expect(await conditionFor(evidenceId)).toBeNull();
  }, 300_000);

  it("a record pending BEYOND the window opens exactly one condition", async () => {
    const { evidenceId } = await pendingRecord(AGED_HOURS);
    await reconcile();

    const condition = await conditionFor(evidenceId);
    expect(condition).not.toBeNull();
    // DECLARED, not inferred. The row says which source owns it.
    expect(condition!.sourceId).toBe("evidence_integrity.ots_pending_aged");
    expect(condition!.status).toBe("OPEN");
    expect(condition!.relatedEvidenceId).toBe(evidenceId);
    // HIGH at this age — the fixture is four days old, past the high
    // boundary — and never CRITICAL: the record's own trusted timestamp is
    // unaffected, and ranking a missing second proof beside a record that
    // cannot be timestamped at all would make the queue's worst rows harder to
    // find.
    expect(condition!.severity).toBe("HIGH");

    // ONE condition, and no FAILED sibling — the record has not failed.
    expect(
      await prisma.operationalIncident.count({
        where: {
          teamId: team.teamId,
          fingerprint: { startsWith: "ots_failure:" },
          relatedEvidenceId: evidenceId,
        },
      }),
    ).toBe(0);
  }, 300_000);

  it("the shared predicate is the ONE the discovery, probe and sweep all read", async () => {
    // Not a re-implementation: the exact function, over the exact columns.
    const aged = {
      otsStatus: "PENDING",
      otsAnchoredAtUtc: null,
      createdAt: new Date(Date.now() - AGED_HOURS * HOUR_MS),
    };
    const fresh = {
      otsStatus: "PENDING",
      otsAnchoredAtUtc: null,
      createdAt: new Date(Date.now() - FRESH_HOURS * HOUR_MS),
    };
    expect(authority.isOtsPendingAged(aged, new Date())).toBe(true);
    expect(authority.isOtsPendingAged(fresh, new Date())).toBe(false);
    // A settled proof is never aged-pending, however old.
    expect(
      authority.isOtsPendingAged({ ...aged, otsStatus: "ANCHORED" }, new Date()),
    ).toBe(false);
    // Neither is a failed one — that is its sibling's condition.
    expect(
      authority.isOtsPendingAged({ ...aged, otsStatus: "FAILED" }, new Date()),
    ).toBe(false);
  }, 300_000);

  // =========================================================================
  // =========================================================================
  // 1b. THE SEVERITY LADDER, AND ITS INDEPENDENCE FROM THE RETRY BUDGET
  // =========================================================================

  it("24-72 HOURS READS WARNING", async () => {
    const { evidenceId } = await pendingRecord(WARNING_HOURS);
    await reconcile();
    const condition = await conditionFor(evidenceId);
    expect(condition).not.toBeNull();
    expect(condition!.severity).toBe("WARNING");
    expect(condition!.sourceId).toBe("evidence_integrity.ots_pending_aged");
  }, 300_000);

  it("BEYOND 72 HOURS READS HIGH, AND NEVER CRITICAL", async () => {
    const { evidenceId } = await pendingRecord(AGED_HOURS);
    await reconcile();
    const condition = await conditionFor(evidenceId);
    expect(condition!.severity).toBe("HIGH");
    expect(condition!.severity).not.toBe("CRITICAL");
  }, 300_000);

  it("the severity is RECOMPUTED as a record ages, not frozen at open", async () => {
    // Opened at 36 hours, so WARNING.
    const { evidenceId } = await pendingRecord(WARNING_HOURS);
    await reconcile();
    expect((await conditionFor(evidenceId))!.severity).toBe("WARNING");

    // The same record, now four days old. A severity computed once and kept
    // would leave this reading WARNING forever — which is the frozen-value
    // defect one field across from the one in the title.
    await prisma.evidence.update({
      where: { id: evidenceId },
      data: { createdAt: new Date(Date.now() - AGED_HOURS * HOUR_MS) },
    });
    await reconcile();
    expect((await conditionFor(evidenceId))!.severity).toBe("HIGH");
  }, 300_000);

  it("THE OPERATIONS WINDOW AND THE RETRY BUDGET ARE DIFFERENT NUMBERS", async () => {
    // The whole point of the separation, stated as arithmetic over the two
    // canonical authorities rather than as two constants a reader has to go
    // and compare.
    const policy = authority.readOtsOperationsAgingPolicy();
    expect(policy.warningHours).toBe(24);
    expect(policy.highHours).toBe(72);
    // The retry budget is UNTOUCHED, and it is far longer.
    expect(authority.readOtsGlobalBudgetDays()).toBe(30);
    expect(policy.highHours).toBeLessThan(
      authority.readOtsGlobalBudgetDays() * 24,
    );

    // A three-day-old pending proof is an operations condition and is NOWHERE
    // NEAR the retry budget: the platform is still trying, and the operator
    // has been told. Under the old shared window both of those were false.
    const threeDays = {
      otsStatus: "PENDING",
      otsAnchoredAtUtc: null,
      createdAt: new Date(Date.now() - 3 * DAY_MS),
    };
    expect(authority.isOtsPendingAged(threeDays, new Date())).toBe(true);
    expect(
      authority.isOtsGlobalBudgetExhausted({
        firstAttemptAtUtc: threeDays.createdAt,
        nowUtc: new Date(),
      }),
    ).toBe(false);
    expect(
      authority.otsPendingOperationalPosture(threeDays, new Date()),
    ).toBe("HIGH");
  }, 300_000);

  it("every workspace kind reads the SAME ladder — no plan branch exists", async () => {
    // The policy takes a workspace nowhere. A per-plan severity would have to
    // be passed one, and it cannot be.
    expect(authority.readOtsOperationsAgingPolicy.length).toBe(0);
    const at30h = {
      otsStatus: "PENDING",
      otsAnchoredAtUtc: null,
      createdAt: new Date(Date.now() - 30 * HOUR_MS),
    };
    expect(authority.otsPendingOperationalPosture(at30h, new Date())).toBe(
      "WARNING",
    );
  }, 300_000);


  // 2. RECOVERY AND RECURRENCE
  // =========================================================================

  it("anchoring resolves the SAME condition from source truth", async () => {
    const { evidenceId } = await pendingRecord(AGED_HOURS);
    await reconcile();
    const opened = await conditionFor(evidenceId);
    expect(opened!.status).toBe("OPEN");

    // The proof lands.
    await prisma.evidence.update({
      where: { id: evidenceId },
      data: { otsStatus: "ANCHORED", otsAnchoredAtUtc: new Date() },
    });
    await reconcile();

    const resolved = await conditionFor(evidenceId);
    expect(resolved!.id).toBe(opened!.id);
    expect(resolved!.status).toBe("RESOLVED");
    // Resolved by the SOURCE — no human resolver is fabricated.
    expect(resolved!.resolvedByUserId).toBeNull();
    expect(await eventTypes(opened!.id)).toContain("resolved_by_domain_truth");
  }, 300_000);

  it("becoming aged-pending again reopens the SAME incident", async () => {
    const { evidenceId } = await pendingRecord(AGED_HOURS);
    await reconcile();
    const opened = await conditionFor(evidenceId);

    await prisma.evidence.update({
      where: { id: evidenceId },
      data: { otsStatus: "ANCHORED", otsAnchoredAtUtc: new Date() },
    });
    await reconcile();
    expect((await conditionFor(evidenceId))!.status).toBe("RESOLVED");

    // The anchor is lost and the record goes back to trying, from an old
    // start instant.
    await prisma.evidence.update({
      where: { id: evidenceId },
      data: { otsStatus: "PENDING", otsAnchoredAtUtc: null },
    });
    await reconcile();

    const reopened = await conditionFor(evidenceId);
    // THE SAME ROW. Not a second condition beside the first.
    expect(reopened!.id).toBe(opened!.id);
    expect(reopened!.status).toBe("OPEN");
    expect(reopened!.resolvedAtUtc).toBeNull();

    const events = await eventTypes(opened!.id);
    expect(events).toContain("reopened");
    expect(events.lastIndexOf("reopened")).toBeGreaterThan(
      events.indexOf("resolved_by_domain_truth"),
    );
    const reopenEvent = await prisma.operationalIncidentEvent.findFirstOrThrow({
      where: { incidentId: opened!.id, eventType: "reopened" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { metadataJson: true },
    });
    // A GENUINE recurrence: the previous resolution was a recorded source
    // recovery, not an operator's premature close.
    expect(
      (reopenEvent.metadataJson as { reopenReason?: string } | null)?.reopenReason,
    ).toBe("SOURCE_RECURRENCE");

    // Still exactly one condition for this record and class.
    expect(
      await prisma.operationalIncident.count({
        where: { teamId: team.teamId, fingerprint: fingerprint(evidenceId) },
      }),
    ).toBe(1);
  }, 300_000);

  it("the Worker giving up hands over: this resolves, its FAILED sibling is free to open", async () => {
    const { evidenceId } = await pendingRecord(AGED_HOURS);
    await reconcile();
    const opened = await conditionFor(evidenceId);
    expect(opened!.status).toBe("OPEN");

    // What the OTS processor writes when the global budget is spent.
    await prisma.evidence.update({
      where: { id: evidenceId },
      data: {
        otsStatus: "FAILED",
        otsFailureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED",
      },
    });
    await reconcile();

    // The aged-pending condition is OVER — the record is no longer pending.
    const settled = await conditionFor(evidenceId);
    expect(settled!.status).toBe("RESOLVED");
    // …and the FAILED condition has opened, as its own row with its own
    // source. The handover is visible rather than one condition silently
    // changing meaning.
    const failed = await prisma.operationalIncident.findFirst({
      where: {
        teamId: team.teamId,
        fingerprint: `ots_failure:${evidenceId}`,
      },
      select: { sourceId: true, status: true },
    });
    expect(failed).not.toBeNull();
    expect(failed!.sourceId).toBe("evidence_integrity.ots_failed");
    expect(failed!.status).toBe("OPEN");
  }, 300_000);

  // =========================================================================
  // 3. THE MANUAL-RESOLUTION CONTRACT
  // =========================================================================

  it("manual Resolve while still aged is refused and writes NOTHING", async () => {
    const { evidenceId } = await pendingRecord(AGED_HOURS);
    await reconcile();
    const before = await conditionFor(evidenceId);
    const eventsBefore = await eventTypes(before!.id);
    const cyclesBefore = await prisma.operationalIncidentSlaCycle.count({
      where: { incidentId: before!.id },
    });

    await expect(
      incidents.resolveIncident({
        incidentId: before!.id,
        teamId: team.teamId,
        actorUserId: team.ownerUserId,
        resolutionNote: "it will anchor eventually",
      }),
    ).rejects.toMatchObject({ code: "CONDITION_STILL_ACTIVE" });

    const after = await conditionFor(evidenceId);
    expect(after!.status).toBe(before!.status);
    expect(after!.resolvedAtUtc).toBeNull();
    expect(after!.occurrenceCount).toBe(before!.occurrenceCount);
    expect(await eventTypes(before!.id)).toEqual(eventsBefore);
    expect(
      await prisma.operationalIncidentSlaCycle.count({
        where: { incidentId: before!.id },
      }),
    ).toBe(cyclesBefore);
  }, 300_000);

  // =========================================================================
  // 4. THE SAFETY PROPERTY
  // =========================================================================

  it("a full reconciliation over an aged record mutates NO proof field", async () => {
    const { evidenceId } = await pendingRecord(AGED_HOURS);
    const before = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: PROOF_SELECT,
    });

    // Three sweeps: open, re-observe, re-observe. If observation could touch a
    // proof, three passes is where it would show.
    await reconcile();
    await reconcile();
    await reconcile();

    const after = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: PROOF_SELECT,
    });

    // BYTE-IDENTICAL. No TSA restamp, no RFC3161 token replacement, no OTS
    // proof rewritten, no anchor invented, no hash touched.
    expect(after).toEqual(before);
    // …and the condition WAS opened, so this is not a vacuous pass over a
    // sweep that did nothing.
    expect((await conditionFor(evidenceId))!.status).toBe("OPEN");
  }, 300_000);

  it("the discovery path contains no provider call at all", async () => {
    // Not "no button": no reachable code. Asserted over the two modules the
    // aged-pending observation runs in, with comments stripped so the prose
    // explaining the refusal does not fail the check documenting it.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const strip = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

    for (const rel of [
      "../src/services/operations/evidence-integrity-conditions.service.ts",
      "../../../packages/shared-runtime/src/ops/ots-aging.ts",
    ]) {
      const src = strip(rel);
      for (const forbidden of [
        // CALL SHAPES, not vocabulary. `PROOF_LABEL` legitimately contains
        // the string "RFC3161 timestamp" — that is what an operator is told
        // is missing — and banning the WORD would push the operator-facing
        // label out of the module that owns it, which is a worse outcome than
        // the check is worth. What must not exist is a reachable way to
        // CONTACT a provider or to re-run an anchoring attempt.
        /requestTimestamp\s*\(/,
        /restamp\s*\(/i,
        /tsaClient/,
        /\bfetch\s*\(/,
        /\baxios\b/,
        /opentimestamps\.org/i,
        /enqueueOts/,
        /upgradeOts/i,
      ]) {
        expect(forbidden.test(src), `${rel} matches ${forbidden}`).toBe(false);
      }
      // …and it writes no Evidence row.
      expect(/evidence\.update\(/.test(src), `${rel} updates Evidence`).toBe(false);
    }
  }, 300_000);
});
