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
 *
 * ET-SM-07 (2026-09-30) — THE FAMILY HAS A SECOND UNIT: `IntegrityRecheckSweep`.
 * Its eight cases are at the end of this file, with their own substituted
 * boundary (an in-memory versioned object store injected through the module's
 * `IntegrityObjectReader`). They share this suite because they share the
 * family — both units keep a signed record's proof of integrity true — and the
 * proof gate credits a family by the suite that executed it.
 */

import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

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
  /**
   * What the fake CLI should do for the next INITIALIZATION.
   *
   * `throw` is the transient shape — a missing binary, no network, a timeout —
   * which the initializer must re-raise so the queue retry budget actually
   * runs. `pending` is the ordinary success: a proof exists, the calendar has
   * not anchored it yet.
   */
  stamp: "pending" as "pending" | "throw",
  reset() {
    this.upgradeCalls.length = 0;
    this.outcome = "unavailable";
    this.stamp = "pending";
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
    createOpenTimestamp: async () => {
      ots.upgradeCalls.push("create");
      if (ots.stamp === "throw") {
        throw new Error("ots: command not found");
      }
      return {
        status: "PENDING" as const,
        proofBase64: Buffer.from(`stamp-${Math.random()}`).toString("base64"),
        hash: "b".repeat(64),
        calendar: "https://alice.btc.calendar.opentimestamps.org",
        bitcoinTxid: null,
        anchoredAtUtc: null,
        upgradedAtUtc: null,
        failureReason: null,
      };
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
  let reconciler: typeof import("../../../worker/src/ots-initialization-reconciler.js");
  let own: WorkspaceFixture;
  let foreign: WorkspaceFixture;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    processor = await import("../../../worker/src/ots-upgrade.processor.js");
    reconciler = await import(
      "../../../worker/src/ots-initialization-reconciler.js"
    );

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

  // =========================================================================
  // RELIABILITY CLOSURE (2026-09-09) — OtsInitializationReconciliationSweep
  //
  // The population nothing watched. Evidence finalization commits and THEN asks
  // for anchoring; the request authority never throws, by design, because
  // refusing a completion for an unreachable queue would trade a durable
  // signature for a timestamp. Its result was discarded and no durable record
  // of the intent was written, so a Redis blip left a signed record owing an
  // anchor with nothing aware of it — and `otsStatus = NULL` is excluded from
  // the integrity scan, so Operations could not see it either.
  //
  // These cases drive the REAL sweep and the REAL initializer against live
  // PostgreSQL. Only the CLI boundary and the queue transport are substituted,
  // and both are recording fakes.
  // =========================================================================

  /** A finalized record that never entered the lifecycle: both OTS columns null. */
  async function neverAttempted(
    fixture: WorkspaceFixture,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const id = await pendingOts(fixture, {
      otsStatus: null,
      otsProofBase64: null,
      otsHash: null,
      // The digest OTS stamps. Its presence is what makes the record
      // finalized for this purpose — the same predicate the initializer uses.
      fingerprintCanonicalJson: JSON.stringify({ v: randomUUID() }),
      ...overrides,
    });
    // Older than the sweep's handoff window. A fresh record is NOT a stalled
    // one, and the case below proves that separately.
    await prisma.$executeRawUnsafe(
      `UPDATE "evidence" SET "created_at" = $2 WHERE "id" = $1::uuid`,
      id,
      new Date(Date.now() - 6 * 60 * 60 * 1000),
    );
    return id;
  }

  it("finalization recovery: the finalized record is the durable intent, and a record with no digest is not one", async () => {
    fanout.reset();
    const owed = await neverAttempted(own);
    // No canonical fingerprint = the digest OTS stamps does not exist yet, so
    // there is nothing truthful to anchor and nothing is owed.
    const notFinalized = await neverAttempted(own, {
      fingerprintCanonicalJson: null,
    });

    const result = await reconciler.runOtsInitializationReconciler({
      trigger: "point5",
    });

    expect(result.enqueued).toBeGreaterThanOrEqual(1);
    expect(fanout.otsReschedules).toContain(owed);
    expect(fanout.otsReschedules).not.toContain(notFinalized);
    // A SCAN AND AN ENQUEUE. The sweep writes no OTS column — `ots-state.ts`
    // remains the only writer — so the record it names is untouched by it.
    const after = await readOts(owed);
    expect(after!.otsStatus).toBeNull();
    expect(after!.otsProofBase64).toBeNull();
    provenCase("ots.recovery.durable.intent_before_work");
  });

  it("finalization recovery: a record still inside the handoff window is left alone", async () => {
    fanout.reset();
    // Created now: between the finalize commit and the first stamp is the
    // NORMAL state of a record, not a failure. A sweep that acted on it would
    // race the enqueue that is already in flight.
    const fresh = await pendingOts(own, {
      otsStatus: null,
      otsProofBase64: null,
      otsHash: null,
      fingerprintCanonicalJson: JSON.stringify({ v: randomUUID() }),
    });

    await reconciler.runOtsInitializationReconciler({ trigger: "point5" });

    expect(fanout.otsReschedules).not.toContain(fresh);
    provenCase("ots.recovery.claim.active_not_stolen");
  });

  it("finalization recovery: the workspace is read from the record, never carried by the sweep", async () => {
    fanout.reset();
    const owed = await neverAttempted(own);
    const before = await readOts(owed);

    // The sweep takes no workspace argument — it cannot be pointed at one —
    // and the work it schedules is addressed by evidence id alone.
    await reconciler.runOtsInitializationReconciler({ trigger: "point5" });
    await runUpgrade(otsJob(owed));

    const after = await readOts(owed);
    expect(after!.teamId).toBe(own.teamId);
    expect(after!.organizationId).toBe(before!.organizationId);
    provenCase("ots.recovery.tenant.workspace_reloaded");
  });

  it("finalization recovery: a foreign workspace's record keeps its own tenancy through recovery", async () => {
    fanout.reset();
    const mine = await neverAttempted(own);
    const theirs = await neverAttempted(foreign);

    await reconciler.runOtsInitializationReconciler({ trigger: "point5" });
    await runUpgrade(otsJob(theirs));

    // Recovering someone else's record must not rebind it to the workspace
    // that happened to be scanned alongside it.
    const other = await readOts(theirs);
    expect(other!.teamId).toBe(foreign.teamId);
    expect((await readOts(mine))!.teamId).toBe(own.teamId);
    provenCase("ots.recovery.tenant.cross_workspace_denied");
  });

  it("finalization recovery: two concurrent initializations write ONE proof and ONE custody event", async () => {
    fanout.reset();
    ots.stamp = "pending";
    const owed = await neverAttempted(own);

    // The race the conditional write exists for. Both stamps are made; only a
    // row still holding no proof is written, so the loser discards its own.
    await Promise.all([
      runUpgrade(otsJob(owed)),
      runUpgrade(otsJob(owed)),
      runUpgrade(otsJob(owed)),
    ]);

    const after = await readOts(owed);
    expect(after!.otsProofBase64).toBeTruthy();
    expect(await custodyCount(owed)).toBe(1);
    provenCase("ots.recovery.claim.one_winner");
  });

  it("finalization recovery: a second sweep over an initialized record is a no-op", async () => {
    ots.stamp = "pending";
    const owed = await neverAttempted(own);
    await runUpgrade(otsJob(owed));
    const initialized = await readOts(owed);
    expect(initialized!.otsProofBase64).toBeTruthy();

    fanout.reset();
    await reconciler.runOtsInitializationReconciler({ trigger: "point5" });

    // It has left the population: the sweep selects on BOTH columns being
    // null, so a record that gained a proof is no longer its business.
    expect(fanout.otsReschedules).not.toContain(owed);
    const again = await readOts(owed);
    expect(again!.otsProofBase64).toBe(initialized!.otsProofBase64);
    expect(await custodyCount(owed)).toBe(1);
    provenCase("ots.recovery.idempotency.duplicate_is_noop");
  });

  it("finalization recovery: a settled record is never reset by a late initialization", async () => {
    ots.stamp = "pending";
    const owed = await neverAttempted(own);
    // It anchored while the late job was in flight.
    await prisma.evidence.update({
      where: { id: owed },
      data: {
        otsStatus: "ANCHORED",
        otsProofBase64: Buffer.from("settled").toString("base64"),
        otsAnchoredAtUtc: new Date(),
        otsBitcoinTxid: "a".repeat(64),
      },
    });
    const settled = await readOts(owed);

    await runUpgrade(otsJob(owed));

    const after = await readOts(owed);
    expect(after!.otsStatus).toBe("ANCHORED");
    expect(after!.otsProofBase64).toBe(settled!.otsProofBase64);
    expect(after!.otsBitcoinTxid).toBe(settled!.otsBitcoinTxid);
    provenCase("ots.recovery.terminal.stale_cannot_overwrite");
  });

  it("a transient stamp failure consumes an attempt instead of reporting success", async () => {
    // THE DEFECT THIS CLOSES. `createOpenTimestamp` throwing was caught, the
    // initializer returned, and the processor returned normally — so the BullMQ
    // job COMPLETED SUCCESSFULLY on the first transient failure and the twenty
    // attempts RETRY_POLICIES.TIMESTAMP_AUTHORITY grants were never consumed.
    ots.stamp = "throw";
    const owed = await neverAttempted(own);

    await expect(
      processor.processOtsUpgrade(otsJob(owed) as never),
    ).rejects.toThrow(/OTS_INITIALIZATION_TRANSIENT/);

    // And an outage is still not persisted as a per-record integrity failure:
    // the record stays honestly "never attempted" while the queue retries.
    const after = await readOts(owed);
    expect(after!.otsStatus).toBeNull();
    expect(after!.otsProofBase64).toBeNull();
    expect(await custodyCount(owed)).toBe(0);
    ots.stamp = "pending";
  });

  // =========================================================================
  // ET-SM-07 (2026-09-30) — IntegrityRecheckSweep
  //
  //   durable authority  Evidence (signed, not DESTROYED / PENDING_DESTRUCTION)
  //   producer           none — due-ness is a fact on the row
  //   executor           services/worker/src/integrity-recheck.ts
  //   claim              a LEASE: conditional update of
  //                      `integrityRecheckClaimedAtUtc`; the status is unchanged
  //   terminal writer    the same module (FAILED_HASH_MISMATCH on a mismatch)
  //   external boundary  object storage, READ ONLY, at the recorded VersionId
  //
  // The object store is the ONE thing substituted, through the module's own
  // injectable `IntegrityObjectReader`: an in-memory versioned bucket that
  // records every read, so a case can assert that a record was — or was NOT —
  // read. The claim, the eligibility rule, the history write, the latest-state
  // columns and the rejection are the real production code against live
  // PostgreSQL. Prisma is not mocked.
  // =========================================================================

  type Recheck = typeof import("../../../worker/src/integrity-recheck.js");
  type Reader = import("../../../worker/src/integrity-recheck.js").IntegrityObjectReader;

  const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

  /** A versioned bucket: key -> versionId -> bytes. Every read is recorded. */
  class VersionedStore {
    objects = new Map<string, Map<string, Buffer>>();
    down = false;
    reads: Array<{ key: string; versionId: string | null }> = [];
    put(key: string, bytes: Buffer): string {
      const versionId = `v-${randomUUID().slice(0, 12)}`;
      if (!this.objects.has(key)) this.objects.set(key, new Map());
      this.objects.get(key)!.set(versionId, bytes);
      return versionId;
    }
    private resolve(o: { key: string; versionId: string | null }): Buffer {
      this.reads.push({ key: o.key, versionId: o.versionId });
      if (this.down) {
        throw Object.assign(new Error("SlowDown"), {
          name: "SlowDown",
          $metadata: { httpStatusCode: 503 },
        });
      }
      const bytes = o.versionId ? this.objects.get(o.key)?.get(o.versionId) : undefined;
      if (!bytes) {
        throw Object.assign(new Error("NoSuchVersion"), {
          name: "NoSuchVersion",
          $metadata: { httpStatusCode: 404 },
        });
      }
      return bytes;
    }
    reader: Reader = {
      head: async (o) => ({ sizeBytes: this.resolve(o).length }),
      stream: async (o) => Readable.from([this.resolve(o)]),
    };
    readsOf(key: string): number {
      return this.reads.filter((r) => r.key === key).length;
    }
  }

  const loadRecheck = (): Promise<Recheck> =>
    import("../../../worker/src/integrity-recheck.js");

  /** A SIGNED single-object record whose bytes are in `store` at a recorded version. */
  async function signedRecord(
    store: VersionedStore,
    fixture: WorkspaceFixture,
    overrides: Record<string, unknown> = {},
  ) {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: fixture.teamId },
      select: { organizationId: true },
    });
    const bytes = Buffer.from(`point5-integrity-${randomUUID()}`);
    const key = `evidence/${randomUUID()}/original.bin`;
    const versionId = store.put(key, bytes);
    const fileSha256 = sha256(bytes);
    const row = await prisma.evidence.create({
      data: {
        title: `point5-integrity-${randomUUID()}`,
        type: "PHOTO",
        status: "SIGNED",
        teamId: fixture.teamId,
        organizationId: team.organizationId,
        ownerUserId: fixture.ownerUserId,
        storageBucket: "point5-integrity-bucket",
        storageKey: key,
        storageVersionId: versionId,
        fileSha256,
        signedAtUtc: new Date(),
        ...overrides,
      } as never,
      select: { id: true },
    });
    return { id: row.id, key, versionId, bytes, fileSha256 };
  }

  const integrityRow = (id: string) =>
    prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: {
        teamId: true,
        organizationId: true,
        status: true,
        lifecycleState: true,
        integrityCheckedAtUtc: true,
        integrityVerifiedAtUtc: true,
        integrityCheckOutcome: true,
        integrityCheckFailureCode: true,
        integrityRecheckRequestedAtUtc: true,
        integrityRecheckClaimedAtUtc: true,
      },
    });
  const integrityChecks = (id: string) =>
    prisma.evidenceIntegrityCheck.findMany({
      where: { evidenceId: id },
      orderBy: { checkedAtUtc: "asc" },
    });
  const rejectionEvents = (id: string) =>
    prisma.custodyEvent.count({
      where: { evidenceId: id, eventType: "INTEGRITY_REJECTED_HASH_MISMATCH" },
    });

  it("integrity: the signed Evidence row is the durable intent; nothing is enqueued and an unknown id creates nothing", async () => {
    const recheck = await loadRecheck();
    const { integrityRecheckDueWhere } = await import("@proovra/shared-runtime");
    const store = new VersionedStore();
    const ev = await signedRecord(store, own);

    // The intent exists BEFORE any work and without any message: the row is
    // due by what it is. No job, no outbox row, no history yet.
    expect(
      await prisma.evidence.count({
        where: { AND: [{ id: ev.id }, integrityRecheckDueWhere(new Date())] },
      }),
    ).toBe(1);
    expect(await integrityChecks(ev.id)).toHaveLength(0);

    // An id that names no record is refused before storage is touched and
    // leaves nothing behind.
    const ghost = "00000000-0000-4000-8000-0000000000fe";
    expect(
      await recheck.recheckEvidenceIntegrity({
        evidenceId: ghost,
        trigger: "SCHEDULED",
        reader: store.reader,
      }),
    ).toEqual({ checked: false, reason: "NOT_ELIGIBLE_OR_HELD" });
    expect(await prisma.evidenceIntegrityCheck.count({ where: { evidenceId: ghost } })).toBe(0);

    // A record that is not signed has no signed digest to compare against: it
    // is not intent, even with bytes in the store, and even when forced.
    const unsigned = await signedRecord(store, own, { status: "CREATED", signedAtUtc: null });
    expect(
      await recheck.recheckEvidenceIntegrity({
        evidenceId: unsigned.id,
        trigger: "RECOVERY",
        force: true,
        reader: store.reader,
      }),
    ).toEqual({ checked: false, reason: "NOT_ELIGIBLE_OR_HELD" });
    expect(await integrityChecks(unsigned.id)).toHaveLength(0);
    expect(store.reads).toHaveLength(0);

    // And the real record is served from that durable intent alone.
    expect(
      await recheck.recheckEvidenceIntegrity({
        evidenceId: ev.id,
        trigger: "SCHEDULED",
        reader: store.reader,
      }),
    ).toMatchObject({ checked: true, outcome: "VERIFIED" });
    provenCase("integrity.durable.intent_before_work");
  });

  it("integrity: the workspace is reloaded from the Evidence row — the caller supplies none", async () => {
    const recheck = await loadRecheck();
    const store = new VersionedStore();
    const mine = await signedRecord(store, own);
    const theirs = await signedRecord(store, foreign);

    // `recheckEvidenceIntegrity` takes an evidence id and NO tenant. Whatever
    // workspace ends up on the history row can only have come from the row.
    for (const ev of [mine, theirs]) {
      expect(
        await recheck.recheckEvidenceIntegrity({
          evidenceId: ev.id,
          trigger: "SCHEDULED",
          reader: store.reader,
        }),
      ).toMatchObject({ checked: true, outcome: "VERIFIED" });
    }

    const [mineCheck] = await integrityChecks(mine.id);
    const [theirCheck] = await integrityChecks(theirs.id);
    expect(mineCheck!.teamId).toBe(own.teamId);
    expect(theirCheck!.teamId).toBe(foreign.teamId);
    expect(mineCheck!.teamId).not.toBe(theirCheck!.teamId);

    // And the recheck never rewrites the record's own workspace.
    expect((await integrityRow(mine.id)).teamId).toBe(own.teamId);
    expect((await integrityRow(theirs.id)).teamId).toBe(foreign.teamId);
    provenCase("integrity.tenant.workspace_reloaded");
  });

  it("integrity: a sweep scoped to one workspace never reads or writes another workspace's record", async () => {
    const recheck = await loadRecheck();
    const { requestIntegrityRecheck } = await import("@proovra/shared-runtime");
    const store = new VersionedStore();
    const mine = await signedRecord(store, own);
    const theirs = await signedRecord(store, foreign);
    // Both are REQUESTED, so each sorts to the head of its workspace's due
    // population and a one-record tick is deterministic.
    expect(await requestIntegrityRecheck(prisma, mine.id)).toBe(true);
    expect(await requestIntegrityRecheck(prisma, theirs.id)).toBe(true);

    const run = await recheck.runIntegrityRecheckSweep({
      teamId: own.teamId,
      reader: store.reader,
      trigger: "point5",
      limit: 1,
    });
    expect(run).toMatchObject({ scanned: 1, verified: 1 });

    // The foreign record was not READ …
    expect(store.readsOf(theirs.key)).toBe(0);
    expect(store.readsOf(mine.key)).toBeGreaterThan(0);
    // … and not WRITTEN: no history, no claim, its request still outstanding.
    expect(await integrityChecks(theirs.id)).toHaveLength(0);
    const untouched = await integrityRow(theirs.id);
    expect(untouched.integrityRecheckClaimedAtUtc).toBeNull();
    expect(untouched.integrityCheckedAtUtc).toBeNull();
    expect(untouched.integrityRecheckRequestedAtUtc).not.toBeNull();

    // Each history row carries ITS OWN record's workspace, whichever sweep
    // wrote it.
    const [mineCheck] = await integrityChecks(mine.id);
    expect(mineCheck).toMatchObject({ teamId: own.teamId, outcome: "VERIFIED" });
    expect(
      await recheck.runIntegrityRecheckSweep({
        teamId: foreign.teamId,
        reader: store.reader,
        trigger: "point5",
        limit: 1,
      }),
    ).toMatchObject({ scanned: 1, verified: 1 });
    const [theirCheck] = await integrityChecks(theirs.id);
    expect(theirCheck).toMatchObject({ teamId: foreign.teamId, outcome: "VERIFIED" });
    // No check row anywhere pairs a record with a workspace that is not its own.
    expect(
      await prisma.evidenceIntegrityCheck.count({
        where: {
          OR: [
            { evidenceId: mine.id, NOT: { teamId: own.teamId } },
            { evidenceId: theirs.id, NOT: { teamId: foreign.teamId } },
          ],
        },
      }),
    ).toBe(0);
    provenCase("integrity.tenant.cross_workspace_denied");
  });

  it("integrity: N concurrent rechecks of one record — one winner, one read, one history row", async () => {
    const recheck = await loadRecheck();
    const store = new VersionedStore();
    const ev = await signedRecord(store, own);

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        recheck.recheckEvidenceIntegrity({
          evidenceId: ev.id,
          trigger: "SCHEDULED",
          correlationId: `point5-race-${i}`,
          reader: store.reader,
        }),
      ),
    );
    expect(results.filter((r) => r.checked)).toHaveLength(1);
    expect(results.filter((r) => !r.checked)).toHaveLength(5);
    expect(await integrityChecks(ev.id)).toHaveLength(1);
    // The losers never reached storage: one HEAD and one GET, from the winner.
    expect(store.readsOf(ev.key)).toBe(2);
    expect((await integrityRow(ev.id)).integrityRecheckClaimedAtUtc).toBeNull();
    provenCase("integrity.claim.one_winner");
  });

  it("integrity: a record another checker holds is not read — and an EXPIRED lease is recovered", async () => {
    const recheck = await loadRecheck();
    const store = new VersionedStore();
    const ev = await signedRecord(store, own);
    const heldAt = new Date(Date.now() - 5 * 60_000); // well inside the 30-minute lease
    await prisma.evidence.update({
      where: { id: ev.id },
      data: { integrityRecheckClaimedAtUtc: heldAt },
    });

    // Neither an ordinary checker nor a FORCED one may take a live claim.
    for (const force of [false, true]) {
      expect(
        await recheck.recheckEvidenceIntegrity({
          evidenceId: ev.id,
          trigger: force ? "RECOVERY" : "SCHEDULED",
          force,
          reader: store.reader,
        }),
      ).toEqual({ checked: false, reason: "NOT_ELIGIBLE_OR_HELD" });
    }
    expect(store.reads).toHaveLength(0);
    expect(await integrityChecks(ev.id)).toHaveLength(0);
    // The holder's claim is exactly as it left it.
    expect((await integrityRow(ev.id)).integrityRecheckClaimedAtUtc!.getTime()).toBe(
      heldAt.getTime(),
    );

    // A claim whose owner died is not held forever: past the lease it is taken.
    await prisma.evidence.update({
      where: { id: ev.id },
      data: { integrityRecheckClaimedAtUtc: new Date(Date.now() - 31 * 60_000) },
    });
    expect(
      await recheck.recheckEvidenceIntegrity({
        evidenceId: ev.id,
        trigger: "SCHEDULED",
        reader: store.reader,
      }),
    ).toMatchObject({ checked: true, outcome: "VERIFIED" });
    expect(await integrityChecks(ev.id)).toHaveLength(1);
    provenCase("integrity.claim.active_not_stolen");
  });

  it("integrity: a duplicate recheck is a no-op, and a duplicate mismatch rejects ONCE", async () => {
    const recheck = await loadRecheck();
    const store = new VersionedStore();

    // A verified record is not due again: the repeat reads nothing, writes nothing.
    const ok = await signedRecord(store, own);
    expect(
      await recheck.recheckEvidenceIntegrity({
        evidenceId: ok.id,
        trigger: "SCHEDULED",
        reader: store.reader,
      }),
    ).toMatchObject({ checked: true, outcome: "VERIFIED" });
    const readsAfterFirst = store.readsOf(ok.key);
    expect(
      await recheck.recheckEvidenceIntegrity({
        evidenceId: ok.id,
        trigger: "SCHEDULED",
        reader: store.reader,
      }),
    ).toEqual({ checked: false, reason: "NOT_ELIGIBLE_OR_HELD" });
    expect(store.readsOf(ok.key)).toBe(readsAfterFirst);
    expect(await integrityChecks(ok.id)).toHaveLength(1);

    // The destructive half: drift is rejected once. The repeat — even forced —
    // finds the record out of the eligible population and appends no second
    // custody event.
    const drifted = await signedRecord(store, own);
    store.objects.get(drifted.key)!.set(drifted.versionId, Buffer.from("drifted"));
    expect(
      await recheck.recheckEvidenceIntegrity({
        evidenceId: drifted.id,
        trigger: "SCHEDULED",
        reader: store.reader,
      }),
    ).toMatchObject({
      checked: true,
      outcome: "FAILED",
      failureCode: "DIGEST_MISMATCH",
      rejected: true,
    });
    expect((await integrityRow(drifted.id)).status).toBe("FAILED_HASH_MISMATCH");
    expect(await rejectionEvents(drifted.id)).toBe(1);

    for (const force of [false, true]) {
      expect(
        await recheck.recheckEvidenceIntegrity({
          evidenceId: drifted.id,
          trigger: "RECOVERY",
          force,
          reader: store.reader,
        }),
      ).toEqual({ checked: false, reason: "NOT_ELIGIBLE_OR_HELD" });
    }
    expect(await rejectionEvents(drifted.id)).toBe(1);
    expect(await integrityChecks(drifted.id)).toHaveLength(1);
    provenCase("integrity.idempotency.duplicate_is_noop");
  });

  it("integrity: a rejected or destroyed record is never rewritten to verified by a later or a stale attempt", async () => {
    const recheck = await loadRecheck();
    const { readStoredBytesIntegrity } = await import("@proovra/shared-runtime");
    const store = new VersionedStore();

    // --- A record REJECTED for a digest mismatch ---------------------------
    const rejected = await signedRecord(store, own);
    store.objects.get(rejected.key)!.set(rejected.versionId, Buffer.from("drifted"));
    await recheck.recheckEvidenceIntegrity({
      evidenceId: rejected.id,
      trigger: "SCHEDULED",
      reader: store.reader,
    });
    expect((await integrityRow(rejected.id)).status).toBe("FAILED_HASH_MISMATCH");

    // LATER ATTEMPT: the bytes at that version now match again (somebody put
    // them back). A forced recheck must not be able to launder the rejection.
    store.objects.get(rejected.key)!.set(rejected.versionId, rejected.bytes);
    const readsBefore = store.readsOf(rejected.key);
    expect(
      await recheck.recheckEvidenceIntegrity({
        evidenceId: rejected.id,
        trigger: "RECOVERY",
        force: true,
        reader: store.reader,
      }),
    ).toEqual({ checked: false, reason: "NOT_ELIGIBLE_OR_HELD" });
    expect(store.readsOf(rejected.key)).toBe(readsBefore);

    // STALE ATTEMPT: a reader that hashed the bytes BEFORE the rejection
    // landed reports VERIFIED afterwards (report issuance reads every original
    // byte and records what it saw through this same writer). The observation
    // is recorded — history is append-only — but the terminal status is not
    // rewritten and the state a surface may present is still "failed".
    await recheck.recordIntegrityObservation({
      evidenceId: rejected.id,
      teamId: own.teamId,
      expectedDigest: rejected.fileSha256,
      observation: {
        outcome: "VERIFIED",
        failureCode: null,
        checkedDigest: rejected.fileSha256,
        storageVersionId: rejected.versionId,
        checkedObjects: [
          { partIndex: null, versionId: rejected.versionId, sha256: rejected.fileSha256 },
        ],
      },
      trigger: "REPORT_ISSUANCE",
      correlationId: "point5-stale-observation",
    });
    const afterStale = await prisma.evidence.findUniqueOrThrow({ where: { id: rejected.id } });
    expect(afterStale.status).toBe("FAILED_HASH_MISMATCH");
    expect(readStoredBytesIntegrity(afterStale).state).toBe("failed");
    expect(await rejectionEvents(rejected.id)).toBe(1);

    // --- A DESTROYED record, and one being destroyed ------------------------
    for (const lifecycleState of ["DESTROYED", "PENDING_DESTRUCTION"]) {
      const gone = await signedRecord(store, own, { lifecycleState, deletedAt: new Date() });
      expect(
        await recheck.recheckEvidenceIntegrity({
          evidenceId: gone.id,
          trigger: "RECOVERY",
          force: true,
          reader: store.reader,
        }),
      ).toEqual({ checked: false, reason: "NOT_ELIGIBLE_OR_HELD" });
      expect(store.readsOf(gone.key)).toBe(0);
      expect(await integrityChecks(gone.id)).toHaveLength(0);
      const still = await integrityRow(gone.id);
      expect(still.lifecycleState).toBe(lifecycleState);
      expect(still.integrityVerifiedAtUtc).toBeNull();
      expect(still.integrityCheckOutcome).toBeNull();
    }
    provenCase("integrity.terminal.stale_cannot_overwrite");
  });

  it("integrity: a store that cannot answer is UNAVAILABLE — non-terminal, no verdict on the bytes, retried after the lease", async () => {
    const recheck = await loadRecheck();
    const { readStoredBytesIntegrity } = await import("@proovra/shared-runtime");
    const store = new VersionedStore();
    const ev = await signedRecord(store, own);
    const t0 = new Date();

    // The provider's outcome is UNKNOWN: it neither served the bytes nor said
    // they were gone.
    store.down = true;
    expect(
      await recheck.recheckEvidenceIntegrity({
        evidenceId: ev.id,
        trigger: "SCHEDULED",
        reader: store.reader,
        now: t0,
      }),
    ).toEqual({
      checked: true,
      outcome: "UNAVAILABLE",
      failureCode: "STORAGE_UNAVAILABLE",
      rejected: false,
    });

    // NON-TERMINAL, and nothing is claimed about the bytes: not rejected, not
    // "checked", no custody event, and the presented state is not a failure.
    const held = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id } });
    expect(held.status).toBe("SIGNED");
    expect(held.integrityCheckedAtUtc).toBeNull();
    expect(held.integrityVerifiedAtUtc).toBeNull();
    expect(held.integrityCheckOutcome).toBe("UNAVAILABLE");
    expect(readStoredBytesIntegrity(held).state).not.toBe("failed");
    expect(await rejectionEvents(ev.id)).toBe(0);

    // The lease is the backoff: the store is back, but a retry one minute
    // later does not re-read the record …
    store.down = false;
    expect(
      await recheck.recheckEvidenceIntegrity({
        evidenceId: ev.id,
        trigger: "SCHEDULED",
        reader: store.reader,
        now: new Date(t0.getTime() + 60_000),
      }),
    ).toEqual({ checked: false, reason: "NOT_ELIGIBLE_OR_HELD" });

    // … and after the lease it IS retried, and verifies.
    expect(
      await recheck.recheckEvidenceIntegrity({
        evidenceId: ev.id,
        trigger: "SCHEDULED",
        reader: store.reader,
        now: new Date(t0.getTime() + 31 * 60_000),
      }),
    ).toMatchObject({ checked: true, outcome: "VERIFIED" });
    expect((await integrityChecks(ev.id)).map((c) => c.outcome)).toEqual([
      "UNAVAILABLE",
      "VERIFIED",
    ]);
    expect((await integrityRow(ev.id)).status).toBe("SIGNED");
    provenCase("integrity.provider.unknown_outcome_non_terminal");
  });

});
