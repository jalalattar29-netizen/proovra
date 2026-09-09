/**
 * OTS INTEGRITY DECOUPLING — the journeys, against live PostgreSQL 16.
 *
 * ===========================================================================
 * WHAT IS REAL HERE
 * ===========================================================================
 * The real `ots-upgrade` processor, the real initialization authority, the
 * real state machine (`buildOtsEvidenceUpdateData`), the real custody ledger,
 * the real commercial resolvers, and a real database.
 *
 * ONE boundary is substituted: the OpenTimestamps CLI. It is a genuine
 * external process that contacts a public calendar, and a suite that really
 * called it would be testing the internet. It is replaced as a RECORDING fake
 * so every case can assert how many times a stamp was actually attempted —
 * which is exactly the question idempotency turns on.
 *
 * ===========================================================================
 * THE PROPERTY UNDER TEST
 * ===========================================================================
 * Integrity and commerce are separate lifecycles. A record's anchor must not
 * depend on its plan, and its plan must not depend on its anchor. Both halves
 * are asserted, because a decoupling that only proved one direction would
 * leave the other free to drift back.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { JOB_NAMES, getWorkEntryOrThrow } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";

const ENTRY = getWorkEntryOrThrow(JOB_NAMES.UPGRADE_OTS);

/** The OTS command boundary — recorded, so attempts can be counted. */
const ots = vi.hoisted(() => ({
  stampCalls: [] as string[],
  /** What the fake CLI reports for the next stamp. */
  nextStatus: "PENDING" as "PENDING" | "ANCHORED" | "FAILED" | "DISABLED",
  /** Set to throw instead of returning — the outage case. */
  throwOnStamp: false,
  reset() {
    this.stampCalls.length = 0;
    this.nextStatus = "PENDING";
    this.throwOnStamp = false;
  },
}));

vi.mock("../../worker/src/ots.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createOpenTimestamp: async (params: { content: Buffer }) => {
      ots.stampCalls.push(params.content.toString("utf8").slice(0, 40));
      if (ots.throwOnStamp) throw new Error("ots: binary not found");
      const base = {
        proofBase64: Buffer.from(`proof-${randomUUID()}`).toString("base64"),
        hash: randomUUID().replace(/-/g, "").repeat(2).slice(0, 64),
        calendar: "https://alice.btc.calendar.opentimestamps.org",
        bitcoinTxid: null as string | null,
        anchoredAtUtc: null as string | null,
        upgradedAtUtc: null as string | null,
        failureReason: null as string | null,
      };
      if (ots.nextStatus === "FAILED") {
        return { ...base, status: "FAILED", proofBase64: null, failureReason: "calendar refused" };
      }
      if (ots.nextStatus === "DISABLED") {
        return {
          status: "DISABLED",
          proofBase64: null,
          hash: null,
          calendar: null,
          bitcoinTxid: null,
          anchoredAtUtc: null,
          upgradedAtUtc: null,
          failureReason: null,
        };
      }
      if (ots.nextStatus === "ANCHORED") {
        return {
          ...base,
          status: "ANCHORED",
          bitcoinTxid: "a".repeat(64),
          anchoredAtUtc: new Date().toISOString(),
        };
      }
      return { ...base, status: "PENDING" };
    },
    verifyOtsProof: async () => ({ status: "UNAVAILABLE" as const }),
    getOtsProofInfo: async () => ({ status: "UNAVAILABLE" as const }),
  };
});

/** The follow-up enqueue, recorded rather than sent to Redis. */
const queued = vi.hoisted(() => ({
  otsJobs: [] as string[],
  reportJobs: [] as string[],
  reset() {
    this.otsJobs.length = 0;
    this.reportJobs.length = 0;
  },
}));

vi.mock("../../worker/src/queue.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    enqueueOtsUpgradeJob: async (evidenceId: string) => {
      queued.otsJobs.push(evidenceId);
      return { enqueued: true };
    },
  };
});

vi.mock("../../worker/src/processor.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    enqueueReportJob: async (evidenceId: string) => {
      queued.reportJobs.push(evidenceId);
      return { enqueued: true };
    },
  };
});

describe("OTS integrity lifecycle (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let processor: typeof import("../../worker/src/ots-upgrade.processor.js");
  let lifecycle: typeof import("../../worker/src/ots-lifecycle.js");
  let resolveEligibility: typeof import("../src/services/billing/evidence-output-eligibility.service.js")["resolveEvidenceOutputEligibility"];

  let personal: { userId: string; teamId: string; organizationId: string | null };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    processor = await import("../../worker/src/ots-upgrade.processor.js");
    lifecycle = await import("../../worker/src/ots-lifecycle.js");
    ({ resolveEvidenceOutputEligibility: resolveEligibility } = await import(
      "../src/services/billing/evidence-output-eligibility.service.js"
    ));

    const team = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.personal.teamId },
      select: { id: true, organizationId: true },
    });
    personal = {
      userId: harness.fixtures.personal.userId,
      teamId: team.id,
      organizationId: team.organizationId,
    };
  }, 900_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  const made: string[] = [];

  beforeEach(async () => {
    ots.reset();
    queued.reset();
    if (made.length) {
      await prisma.custodyEvent.deleteMany({ where: { evidenceId: { in: made } } });
      await prisma.evidence.deleteMany({ where: { id: { in: made } } });
      made.length = 0;
    }
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /**
   * A FINALIZED record with no OTS state at all — the shape every record has
   * the moment finalization commits, and the shape every historical Free
   * record was stranded in.
   */
  async function finalizedRecord(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = await prisma.evidence.create({
      data: {
        title: `ots-lifecycle-${randomUUID()}`,
        type: "PHOTO",
        status: "SIGNED",
        teamId: personal.teamId,
        organizationId: personal.organizationId,
        ownerUserId: personal.userId,
        // The stamped content. Its presence is what makes the record
        // stampable, and it is written by the finalize transaction.
        fingerprintCanonicalJson: JSON.stringify({ v: 1, id: randomUUID() }),
        ...overrides,
      },
      select: { id: true },
    });
    made.push(row.id);
    return row.id;
  }

  function otsJob(evidenceId: string) {
    return {
      id: `ots-upgrade-${evidenceId}`,
      name: ENTRY.workName,
      attemptsMade: 0,
      data: {
        commandId: evidenceId,
        traceId: "ots-lifecycle-suite",
        schemaVersion: ENTRY.schemaVersion,
      },
    } as never;
  }

  /** Run the real processor, swallowing only its declared retry signal. */
  async function runJob(evidenceId: string): Promise<void> {
    try {
      await processor.processOtsUpgrade(otsJob(evidenceId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/OTS_UPGRADE_FAILED/i.test(message)) throw err;
    }
  }

  async function readOts(id: string) {
    return prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: {
        otsStatus: true,
        otsProofBase64: true,
        otsHash: true,
        otsBitcoinTxid: true,
        otsAnchoredAtUtc: true,
        otsFailureReason: true,
        tsaStatus: true,
        tsaGenTimeUtc: true,
        signedAtUtc: true,
      },
    });
  }

  async function setPlan(plan: "FREE" | "PRO", credits = 0) {
    await prisma.entitlement.updateMany({
      where: { userId: personal.userId },
      data: { active: false },
    });
    await prisma.entitlement.create({
      data: { userId: personal.userId, plan, active: true, credits },
    });
  }

  // =========================================================================
  // OTS-1 / OTS-2 — a FREE record enters the lifecycle and gets no artifacts
  // =========================================================================

  it("OTS-1/2: a FREE finalized record is stamped, and stays without Report or Package", async () => {
    await setPlan("FREE");
    const id = await finalizedRecord();

    // Before: never attempted. NULL is the honest state, and it is a
    // different fact from FAILED.
    expect((await readOts(id)).otsStatus).toBeNull();

    await runJob(id);

    const after = await readOts(id);
    expect(ots.stampCalls.length, "the calendar was contacted once").toBe(1);
    expect(after.otsStatus).toBe("PENDING");
    expect(after.otsProofBase64).toBeTruthy();
    expect(after.otsFailureReason).toBeNull();

    // …and the commercial answer is untouched by any of it.
    const eligibility = await resolveEligibility({
      evidenceId: id,
      ownerUserId: personal.userId,
      teamId: personal.teamId,
    });
    expect(eligibility.reportsIncluded).toBe(false);
    expect(eligibility.verificationPackageIncluded).toBe(false);
    expect(queued.reportJobs, "no artifact may be enqueued by an anchor").toEqual([]);

    // The pending proof schedules its own follow-up. That ladder is what
    // eventually anchors it, and a Free record must be on it like any other.
    expect(queued.otsJobs).toContain(id);
  });

  it("OTS-1b: the stamped content is the record's canonical fingerprint", async () => {
    await setPlan("FREE");
    const id = await finalizedRecord();
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: { fingerprintCanonicalJson: true },
    });
    await runJob(id);
    // The proof binds the record's own digest — not a report, and not
    // anything derived from one.
    expect(row.fingerprintCanonicalJson!.startsWith(ots.stampCalls[0]!)).toBe(true);
  });

  it("OTS-2b: an unfinalized record is declined, not failed", async () => {
    await setPlan("FREE");
    const id = await finalizedRecord({
      status: "CREATED",
      fingerprintCanonicalJson: null,
    });

    await runJob(id);

    const after = await readOts(id);
    expect(ots.stampCalls.length, "nothing stampable exists yet").toBe(0);
    // Still never-attempted. Declining is not failing, and an operator must
    // not be shown an integrity condition for a record that is simply early.
    expect(after.otsStatus).toBeNull();
  });

  // =========================================================================
  // OTS-3 / OTS-8 — anchoring changes integrity, never entitlement
  // =========================================================================

  it("OTS-3/8: a FREE record that anchors gets integrity, and still no artifacts", async () => {
    await setPlan("FREE");
    ots.nextStatus = "ANCHORED";
    const id = await finalizedRecord();

    await runJob(id);

    const after = await readOts(id);
    expect(after.otsStatus).toBe("ANCHORED");
    expect(after.otsAnchoredAtUtc).toBeTruthy();
    expect(after.otsBitcoinTxid).toBeTruthy();

    const eligibility = await resolveEligibility({
      evidenceId: id,
      ownerUserId: personal.userId,
      teamId: personal.teamId,
    });
    expect(
      eligibility.reportsIncluded,
      "an anchor must never be readable as an entitlement",
    ).toBe(false);
    expect(eligibility.verificationPackageIncluded).toBe(false);
    expect(queued.reportJobs).toEqual([]);

    // A complete anchor needs no follow-up.
    expect(queued.otsJobs).not.toContain(id);
  });

  // =========================================================================
  // OTS-4 / OTS-5 — every plan takes the same path
  // =========================================================================

  it("OTS-4/5: PRO and credit-funded FREE take the identical integrity path", async () => {
    await setPlan("PRO");
    const proId = await finalizedRecord();
    await runJob(proId);
    const pro = await readOts(proId);

    ots.reset();
    await setPlan("FREE");
    const freeId = await finalizedRecord();
    // Fund this one the way a real credit purchase does: a consumption row
    // bound to the record.
    await prisma.evidenceCreditLedgerEntry.create({
      data: {
        userId: personal.userId,
        entryType: "CONSUMPTION",
        creditsDelta: -1,
        evidenceId: freeId,
        balanceAfter: 0,
      },
    });
    await runJob(freeId);
    const funded = await readOts(freeId);

    // Same integrity outcome, on both.
    expect(pro.otsStatus).toBe("PENDING");
    expect(funded.otsStatus).toBe("PENDING");
    expect(pro.otsProofBase64).toBeTruthy();
    expect(funded.otsProofBase64).toBeTruthy();

    // And the commercial answers differ, exactly as they should — funding
    // decides artifacts, and it decided nothing about the anchor above.
    const fundedEligibility = await resolveEligibility({
      evidenceId: freeId,
      ownerUserId: personal.userId,
      teamId: personal.teamId,
    });
    expect(fundedEligibility.reportsIncluded).toBe(true);
  });

  // =========================================================================
  // OTS-6 — duplicate initialization
  // =========================================================================

  it("OTS-6: a second run does not re-stamp an already-initialized record", async () => {
    await setPlan("FREE");
    const id = await finalizedRecord();

    await runJob(id);
    const first = await readOts(id);
    expect(ots.stampCalls.length).toBe(1);

    await runJob(id);
    const second = await readOts(id);

    // The proof is the idempotency boundary, and it is unchanged.
    expect(second.otsProofBase64).toBe(first.otsProofBase64);
    expect(
      ots.stampCalls.length,
      "a re-run must not mint a second proof for one record",
    ).toBe(1);

    // One custody event, not two.
    const events = await prisma.custodyEvent.count({
      where: { evidenceId: id, eventType: "OTS_APPLIED" },
    });
    expect(events).toBe(1);
  });

  it("OTS-6b: two concurrent initializations produce one stored proof", async () => {
    await setPlan("FREE");
    const id = await finalizedRecord();

    // Both read "no proof" before either writes. The conditional write is
    // what decides, and exactly one may win.
    const [a, b] = await Promise.all([
      lifecycle.ensureEvidenceOtsInitialized({ evidenceId: id, trigger: "race-a" }),
      lifecycle.ensureEvidenceOtsInitialized({ evidenceId: id, trigger: "race-b" }),
    ]);

    const winners = [a, b].filter((r) => r.initialized);
    expect(winners.length, "exactly one initialization may persist").toBe(1);

    const events = await prisma.custodyEvent.count({
      where: { evidenceId: id, eventType: "OTS_APPLIED" },
    });
    expect(events).toBe(1);
  });

  // =========================================================================
  // OTS-9 / OTS-10 — plan transitions do not touch integrity
  // =========================================================================

  it("OTS-9/10: integrity survives a downgrade and an upgrade unchanged", async () => {
    await setPlan("PRO");
    const id = await finalizedRecord();
    await runJob(id);
    const stamped = await readOts(id);
    expect(stamped.otsStatus).toBe("PENDING");

    // PRO -> FREE. The proof is not a commercial artifact and is not withdrawn.
    await setPlan("FREE");
    const afterDowngrade = await readOts(id);
    expect(afterDowngrade.otsProofBase64).toBe(stamped.otsProofBase64);
    expect(afterDowngrade.otsStatus).toBe("PENDING");
    // Entitlement did change, and separately.
    expect(
      (
        await resolveEligibility({
          evidenceId: id,
          ownerUserId: personal.userId,
          teamId: personal.teamId,
        })
      ).reportsIncluded,
    ).toBe(false);

    // FREE -> PRO. Still the same proof; the ladder is not restarted.
    await setPlan("PRO");
    const afterUpgrade = await readOts(id);
    expect(afterUpgrade.otsProofBase64).toBe(stamped.otsProofBase64);
    expect(ots.stampCalls.length).toBe(1);
  });

  // =========================================================================
  // OTS-13 / OTS-16 — the four historical populations are distinguishable
  // =========================================================================

  it("OTS-15/16: never-attempted and genuinely-failed are different rows", async () => {
    await setPlan("FREE");

    const neverAttempted = await finalizedRecord();
    const genuinelyFailed = await finalizedRecord({
      otsStatus: "FAILED",
      otsFailureReason: "calendar refused",
      otsProofBase64: Buffer.from("old-proof").toString("base64"),
    });

    // The reconciliation categories, expressed as the queries the script uses.
    const scope = { deletedAt: null, fingerprintCanonicalJson: { not: null } };
    const neverIds = (
      await prisma.evidence.findMany({
        where: { AND: [scope, { otsStatus: null, otsProofBase64: null }] },
        select: { id: true },
      })
    ).map((r) => r.id);
    const failedIds = (
      await prisma.evidence.findMany({
        where: { AND: [scope, { otsStatus: "FAILED" }] },
        select: { id: true },
      })
    ).map((r) => r.id);

    expect(neverIds).toContain(neverAttempted);
    expect(neverIds).not.toContain(genuinelyFailed);
    expect(failedIds).toContain(genuinelyFailed);
    expect(failedIds).not.toContain(neverAttempted);

    /*
     * AND THE FAILED ONE IS LEFT ALONE. Re-stamping a record whose proof the
     * calendar may already be tracking would replace it with a newer one and
     * reset its anchoring clock. Only the never-attempted population is acted
     * on, and the initializer's own guard enforces that independently of the
     * script's query.
     */
    const outcome = await lifecycle.ensureEvidenceOtsInitialized({
      evidenceId: genuinelyFailed,
      trigger: "reconcile",
    });
    expect(outcome).toEqual({ initialized: false, reason: "already_initialized" });
    expect(ots.stampCalls.length).toBe(0);
  });

  it("an outage leaves the record never-attempted AND consumes a retry attempt", async () => {
    await setPlan("FREE");
    ots.throwOnStamp = true;
    const id = await finalizedRecord();

    /*
     * RELIABILITY CLOSURE (2026-09-09) — THIS CASE NOW ASSERTS THE THROW.
     *
     * It used to call `runJob`, which swallows the processor's declared retry
     * signal, and then check the columns. Both halves of that were fine except
     * for what they left unsaid: the initializer used to CATCH the stamping
     * error and return `initialized: false`, so the job completed
     * SUCCESSFULLY on the first transient failure and the twenty-attempt
     * TIMESTAMP_AUTHORITY budget was never touched. A single blip stranded the
     * record at NULL for the rest of its life.
     *
     * The columns being null was therefore true for two opposite reasons — the
     * right one (do not invent a per-record failure from a deployment-wide
     * outage) and the wrong one (nothing is going to try again). This case
     * could not tell them apart, which is exactly why the defect survived it.
     *
     * Asserting the throw is what pins the difference. The throw is the only
     * thing that makes BullMQ consume an attempt and schedule the backoff.
     */
    await expect(processor.processOtsUpgrade(otsJob(id))).rejects.toThrow(
      /OTS_INITIALIZATION_TRANSIENT/,
    );

    const after = await readOts(id);
    // Writing FAILED here would mint a per-record integrity condition for
    // every record captured during an outage. NULL is what actually happened,
    // and it stays NULL: the retry is a QUEUE fact, never an evidence column.
    expect(after.otsStatus).toBeNull();
    expect(after.otsFailureReason).toBeNull();
    expect(after.otsProofBase64).toBeNull();
  });

  // =========================================================================
  // OTS-11 / TIMING — the three times stay three times
  // =========================================================================

  it("OTS-11: capture, TSA and OTS anchor remain three distinct fields", async () => {
    await setPlan("FREE");
    ots.nextStatus = "ANCHORED";
    const signedAt = new Date("2026-01-01T00:00:00.000Z");
    const tsaAt = new Date("2026-01-01T00:00:05.000Z");
    const id = await finalizedRecord({
      signedAtUtc: signedAt,
      tsaStatus: "SUCCEEDED",
      tsaGenTimeUtc: tsaAt,
    });

    await runJob(id);
    const after = await readOts(id);

    /*
     * A proof attests existence NO LATER THAN its anchor time. A record
     * anchored today says nothing about last year on its own — the signature
     * and the RFC 3161 timestamp carry the original moment. Collapsing the
     * three into one "timestamp" would overstate what the anchor proves, so
     * the row keeps them apart and every reader gets all three.
     */
    expect(after.signedAtUtc?.toISOString()).toBe(signedAt.toISOString());
    expect(after.tsaGenTimeUtc?.toISOString()).toBe(tsaAt.toISOString());
    expect(after.otsAnchoredAtUtc).toBeTruthy();
    expect(after.otsAnchoredAtUtc!.getTime()).toBeGreaterThan(tsaAt.getTime());
  });

  // =========================================================================
  // OTS-14 — TSA is untouched by all of it
  // =========================================================================

  it("OTS-14: the OTS lifecycle never writes a TSA column", async () => {
    await setPlan("FREE");
    const id = await finalizedRecord({
      tsaStatus: "FAILED",
      tsaFailureReason: "authority unreachable",
    });

    await runJob(id);

    const after = await readOts(id);
    // A failed timestamp cannot be recreated for the original moment, and
    // nothing in the anchoring path pretends otherwise.
    expect(after.tsaStatus).toBe("FAILED");
    // The record still gets its anchor: the two are independent proofs.
    expect(after.otsStatus).toBe("PENDING");
  });
});
