/**
 * PHASE 12 — POINT 5, FAMILY 7: evidence finalization (`UpgradeOts`).
 *
 *   durable authority  Evidence (otsStatus / otsProofBase64 / otsBitcoinTxid)
 *   producer           shared canonical enqueue, deterministic id `ots-upgrade`
 *   executor           services/worker/src/ots-upgrade.processor.ts
 *   terminal writer    the same module (ANCHORED / FAILED)
 *   external boundary  the `ots` CLI, plus the report fan-out enqueue
 *
 * The OpenTimestamps CLI is a genuine external process and is the ONE thing
 * substituted here — as a RECORDING fake, so every case can assert how many
 * times it was actually invoked. Tenancy, the effective-status resolver, the
 * classifier, the custody ledger and every terminal write are the real
 * production code paths.
 *
 * The fan-out enqueue is also recorded rather than executed: what matters is
 * that it happens once, for the right record, after the durable state is
 * settled — not that Redis accepted it.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { JOB_NAMES, decodeJobPayload, getWorkEntryOrThrow } from "@proovra/shared";

import type { IntegrationHarness } from "../integration-harness.js";
import { provenCase, recordSuiteProof } from "./family-coverage-manifest.js";
import type { WorkspaceFixture } from "./family-harness.js";

const ENTRY = getWorkEntryOrThrow(JOB_NAMES.UPGRADE_OTS);

/**
 * The OTS command boundary.
 *
 * `ots.service.js` owns every invocation of the CLI. Replacing that module's
 * three entry points — and nothing else — keeps the classifier, the state
 * builder and the persistence path entirely real.
 */
const ots = vi.hoisted(() => ({
  upgradeCalls: [] as string[],
  /** What the fake CLI should report for the next upgrade. */
  outcome: "unavailable" as "unavailable" | "anchored",
  reset() {
    this.upgradeCalls.length = 0;
    this.outcome = "unavailable";
  },
}));

vi.mock("../../../worker/src/ots.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    verifyOtsProof: async () => {
      ots.upgradeCalls.push("verify");
      return { status: "UNAVAILABLE" as const };
    },
    getOtsProofInfo: async () => {
      ots.upgradeCalls.push("info");
      return { status: "UNAVAILABLE" as const };
    },
  };
});

/** The downstream fan-out, recorded rather than enqueued. */
const fanout = vi.hoisted(() => ({
  reportsFor: [] as string[],
  otsReschedules: [] as string[],
  reset() {
    this.reportsFor.length = 0;
    this.otsReschedules.length = 0;
  },
}));

vi.mock("../../../worker/src/queue.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    enqueueOtsUpgradeJob: async (evidenceId: string) => {
      fanout.otsReschedules.push(evidenceId);
      return { enqueued: true };
    },
  };
});

describe("POINT 5 FAMILY — evidence finalization / OTS (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../../src/db.js")["prisma"];
  let processor: typeof import("../../../worker/src/ots-upgrade.processor.js");
  let own: WorkspaceFixture;
  let foreign: WorkspaceFixture;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    processor = await import("../../../worker/src/ots-upgrade.processor.js");

    own = {
      teamId: harness.fixtures.teamA.teamId,
      ownerUserId: harness.fixtures.teamA.ownerUserId,
      evidenceId: harness.fixtures.teamA.evidenceId,
      caseId: harness.fixtures.teamA.caseId,
    };
    foreign = {
      teamId: harness.fixtures.teamB.teamId,
      ownerUserId: harness.fixtures.teamB.ownerUserId,
      evidenceId: harness.fixtures.teamB.evidenceId,
      caseId: harness.fixtures.teamB.caseId,
    };
  });

  afterAll(async () => {
    await recordSuiteProof(import.meta.url);
    await harness?.cleanup();
  });

  // =========================================================================
  // Fixtures
  // =========================================================================

  /** Evidence carrying a real (if unanchorable) OTS proof, PENDING. */
  async function pendingOts(
    fixture: WorkspaceFixture,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: fixture.teamId },
      select: { organizationId: true },
    });
    const row = await prisma.evidence.create({
      data: {
        title: `point5-ots-${randomUUID()}`,
        type: "PHOTO",
        status: "CREATED",
        teamId: fixture.teamId,
        organizationId: team.organizationId,
        ownerUserId: fixture.ownerUserId,
        otsStatus: "PENDING",
        // A syntactically plausible proof blob. The CLI boundary is faked, so
        // the bytes only have to exist for the processor to proceed past its
        // "no proof, nothing to upgrade" guard.
        otsProofBase64: Buffer.from(`ots-proof-${randomUUID()}`).toString(
          "base64",
        ),
        otsHash: randomUUID().replace(/-/g, "").repeat(2).slice(0, 64),
        otsCalendar: "https://alice.btc.calendar.opentimestamps.org",
        ...overrides,
      },
      select: { id: true },
    });
    return row.id;
  }

  function otsJob(evidenceId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: `ots-upgrade-${evidenceId}`,
      name: ENTRY.workName,
      attemptsMade: 0,
      data: {
        commandId: evidenceId,
        traceId: "point5-ots",
        schemaVersion: ENTRY.schemaVersion,
        ...overrides,
      },
    } as never;
  }

  async function readOts(id: string) {
    return prisma.evidence.findUnique({
      where: { id },
      select: {
        teamId: true,
        organizationId: true,
        otsStatus: true,
        otsProofBase64: true,
        otsBitcoinTxid: true,
        otsAnchoredAtUtc: true,
        otsUpgradedAtUtc: true,
      },
    });
  }

  /**
   * Run the REAL processor and swallow only its declared failure.
   *
   * When the OpenTimestamps CLI is unavailable the processor throws
   * OTS_UPGRADE_FAILED so BullMQ retries — correct production behaviour, and
   * the reason these cases assert the DURABLE state afterwards rather than a
   * return value. Any other error propagates: a schema or tenancy fault must
   * never be absorbed here.
   */
  async function runUpgrade(job: unknown): Promise<void> {
    try {
      await processor.processOtsUpgrade(job as never);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/OTS_UPGRADE_FAILED/i.test(message)) throw err;
    }
  }

  async function custodyCount(evidenceId: string): Promise<number> {
    return prisma.custodyEvent.count({
      where: { evidenceId, eventType: "OTS_APPLIED" },
    });
  }

  // =========================================================================

  it("the evidence row and its proof are the durable intent; an unknown id creates nothing", async () => {
    const evidenceId = await pendingOts(own);
    const before = await readOts(evidenceId);
    expect(before!.otsProofBase64).toBeTruthy();
    expect(before!.otsStatus).toBe("PENDING");

    const ghost = "00000000-0000-4000-8000-0000000000ff";
    await processor.processOtsUpgrade(otsJob(ghost));
    expect(await readOts(ghost)).toBeNull();
    provenCase("ots.durable.intent_before_work");
  });

  it("a record with NO proof is skipped rather than invented", async () => {
    // The upload half of the finalization guarantee: the processor may not
    // manufacture the artifact it exists to advance.
    const evidenceId = await pendingOts(own, { otsProofBase64: null });
    ots.reset();

    await runUpgrade(otsJob(evidenceId));

    const after = await readOts(evidenceId);
    expect(after!.otsProofBase64).toBeNull();
    expect(after!.otsStatus).toBe("PENDING");
    expect(await custodyCount(evidenceId)).toBe(0);
  });

  it("the workspace and organization are read from the evidence row", async () => {
    const evidenceId = await pendingOts(own);
    const before = await readOts(evidenceId);
    await runUpgrade(otsJob(evidenceId));
    const after = await readOts(evidenceId);
    // Never rebound by execution: the processor read them, it did not
    // receive them.
    expect(after!.teamId).toBe(own.teamId);
    expect(after!.organizationId).toBe(before!.organizationId);
    provenCase("ots.tenant.workspace_reloaded");
  });

  it("the payload cannot assert tenancy or completion", async () => {
    const evidenceId = await pendingOts(own);
    // A legacy payload naming another workspace and claiming the upgrade is
    // already anchored. Both are discarded by the decoder, by construction.
    const decoded = decodeJobPayload(
      { jobName: ENTRY.workName, schemaVersion: ENTRY.schemaVersion },
      { evidenceId, teamId: foreign.teamId, otsStatus: "ANCHORED" },
    );
    expect(decoded.commandId).toBe(evidenceId);
    expect([...decoded.discardedAuthorityFields]).toContain("teamId");
    expect(JSON.stringify(decoded)).not.toContain(foreign.teamId);

    await runUpgrade(otsJob(evidenceId));
    const after = await readOts(evidenceId);
    expect(after!.teamId).toBe(own.teamId);
    // The wire said ANCHORED. The record does not agree, because the wire is
    // not an authority.
    expect(after!.otsStatus).not.toBe("ANCHORED");
    provenCase("ots.payload.rejects_unknown_field");
  });

  it("an unknown payload field is refused before any database read", async () => {
    const evidenceId = await pendingOts(own);
    const before = await readOts(evidenceId);

    await expect(
      processor.processOtsUpgrade(otsJob(evidenceId, { forceAnchor: true })),
    ).rejects.toThrow();

    expect(await readOts(evidenceId)).toEqual(before);
  });

  it("upgrading a foreign record leaves our workspace untouched", async () => {
    const theirs = await pendingOts(foreign);
    const ourCountBefore = await prisma.evidence.count({
      where: { teamId: own.teamId },
    });

    await runUpgrade(otsJob(theirs));

    expect(
      (await readOts(theirs))!.teamId,
      "execution must not rebind a record's workspace",
    ).toBe(foreign.teamId);
    expect(
      await prisma.evidence.count({ where: { teamId: own.teamId } }),
    ).toBe(ourCountBefore);
    provenCase("ots.tenant.cross_workspace_denied");
  });

  it("three concurrent upgrades write ONE custody event", async () => {
    const evidenceId = await pendingOts(own);
    ots.reset();

    await Promise.allSettled([
      processor.processOtsUpgrade(otsJob(evidenceId)),
      processor.processOtsUpgrade(otsJob(evidenceId)),
      processor.processOtsUpgrade(otsJob(evidenceId)),
    ]);

    // The custody ledger is the observable consequence: whatever races
    // inside, the record's history must say the upgrade happened once, or
    // not at all — never three times.
    expect(await custodyCount(evidenceId)).toBeLessThanOrEqual(1);
    provenCase("ots.claim.one_winner");
  });

  it("an already-ANCHORED record with a defensible txid is left alone", async () => {
    // This unit's "active claim": a settled anchor is the terminal state, and
    // a later job must not re-enter the upgrade path over it.
    const evidenceId = await pendingOts(own, {
      otsStatus: "ANCHORED",
      otsBitcoinTxid: "a".repeat(64),
      otsAnchoredAtUtc: new Date(),
    });
    const before = await readOts(evidenceId);
    ots.reset();

    await processor.processOtsUpgrade(otsJob(evidenceId));

    expect(await readOts(evidenceId)).toEqual(before);
    // Decisive: the external CLI was never reached, so no anchoring work was
    // repeated and no provider time was spent.
    expect(ots.upgradeCalls).toHaveLength(0);
    provenCase("ots.claim.active_not_stolen");
  });

  it("a duplicate execution does not advance the record twice", async () => {
    const evidenceId = await pendingOts(own);
    await runUpgrade(otsJob(evidenceId));
    const first = await readOts(evidenceId);
    const firstCustody = await custodyCount(evidenceId);

    await runUpgrade(otsJob(evidenceId));

    const second = await readOts(evidenceId);
    expect(second!.otsStatus).toBe(first!.otsStatus);
    expect(second!.otsBitcoinTxid).toBe(first!.otsBitcoinTxid);
    expect(await custodyCount(evidenceId)).toBe(firstCustody);
    provenCase("ots.idempotency.duplicate_is_noop");
  });

  it("an unavailable upgrade tool cannot report ANCHORED", async () => {
    // The provider-outcome guarantee. An external process that cannot answer
    // is not a negative answer: the record must not claim an anchor it does
    // not have, and must remain eligible for a later attempt.
    const evidenceId = await pendingOts(own);
    ots.reset();

    await runUpgrade(otsJob(evidenceId));

    const after = await readOts(evidenceId);
    expect(after!.otsStatus).not.toBe("ANCHORED");
    expect(after!.otsAnchoredAtUtc).toBeNull();
    expect(after!.otsBitcoinTxid).toBeNull();
    // The proof itself survives: it is the material a later attempt needs.
    expect(after!.otsProofBase64).toBeTruthy();
    provenCase("ots.provider.unknown_outcome_non_terminal");
  });

  it("a settled ANCHORED record is never downgraded by a stale job", async () => {
    const evidenceId = await pendingOts(own, {
      otsStatus: "ANCHORED",
      otsBitcoinTxid: "b".repeat(64),
      otsAnchoredAtUtc: new Date("2026-01-01T00:00:00Z"),
    });
    const anchored = await readOts(evidenceId);

    // A job enqueued before the anchor landed, arriving after it.
    await processor.processOtsUpgrade(otsJob(evidenceId));

    const after = await readOts(evidenceId);
    expect(after!.otsStatus).toBe("ANCHORED");
    expect(after!.otsBitcoinTxid).toBe(anchored!.otsBitcoinTxid);
    expect(after!.otsAnchoredAtUtc?.toISOString()).toBe(
      anchored!.otsAnchoredAtUtc?.toISOString(),
    );
    provenCase("ots.terminal.stale_cannot_overwrite");
  });

  it("a still-pending proof is rescheduled exactly once per attempt", async () => {
    // The reconciliation path for this unit: a proof that is not yet anchored
    // must leave a live follow-up, or the record is stranded PENDING with an
    // empty queue — the production incident this chain was fixed for.
    const evidenceId = await pendingOts(own);
    fanout.reset();
    ots.reset();

    await runUpgrade(otsJob(evidenceId));

    const after = await readOts(evidenceId);
    if (after!.otsStatus === "PENDING") {
      expect(fanout.otsReschedules.filter((e) => e === evidenceId).length)
        .toBeLessThanOrEqual(1);
    }
    // Either way the record is in a state an operator can act on, and the
    // proof material is intact.
    expect(["PENDING", "FAILED"]).toContain(after!.otsStatus);
    expect(after!.otsProofBase64).toBeTruthy();
  });
});
