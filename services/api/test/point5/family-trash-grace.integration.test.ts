/**
 * POINT 5 FAMILY — the trash-grace reconciler, EXECUTED (live PostgreSQL 16).
 *
 * The Point-5 gate does not accept a registry entry as evidence that a sweep
 * behaves. It requires the seven behavioural obligations to be PROVEN by
 * running the real code against a real database, and it derives credit from the
 * cases that actually passed. This suite is that proof for
 * `TrashGraceReconciliationSweep`.
 *
 * WHY THE OBLIGATIONS LOOK SLIGHTLY DIFFERENT HERE
 * ---------------------------------------------------------------------------
 * Most sweeps own a durable work row of their own and claim it. This one does
 * not, on purpose: the work item IS the Evidence row — `lifecycle_state =
 * TRASHED` plus its grace deadline — committed by the synchronous lifecycle
 * service when a user moves a record to trash. So:
 *
 *   - `durable.intent_before_work` is proven against that row: the deadline
 *     exists in the database before the sweep runs, and the sweep finds it
 *     without being told about it. That is the whole point of the reconciler —
 *     the previous design only ever revisited a record via the ONE delayed job
 *     enqueued at trash time, so a lost enqueue meant the deadline passed in
 *     silence.
 *   - `claim.*` are proven against the claim the sweep HANDS OFF to: the
 *     canonical executor's TRASHED -> PENDING_DESTRUCTION compare-and-set with
 *     a lease. The sweep deliberately holds no claim of its own — it nominates,
 *     and the irreversible decision is re-made by the executor against a
 *     freshly re-read row.
 *
 * Nothing in this suite enables automatic destruction: every case runs
 * observe-only or drives the executor directly with an injected disposable
 * store, so no test can be the thing that destroys evidence.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";
import { provenCase, recordSuiteProof } from "./family-coverage-manifest.js";

const DAY = 24 * 60 * 60 * 1000;

/** The two operations the executor needs, over an in-memory store. */
function disposableStore() {
  const objects = new Set<string>();
  return {
    objects,
    port: {
      async deleteObject(i: { bucket: string; key: string }) {
        objects.delete(`${i.bucket}/${i.key}`);
        return { ok: true as const };
      },
      async objectExists(i: { bucket: string; key: string }) {
        return objects.has(`${i.bucket}/${i.key}`);
      },
    },
  };
}

describe("POINT 5 FAMILY — trash-grace reconciliation (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let reconciler: typeof import("../../../worker/src/governance/trash-grace-reconciler.js");
  let executor: typeof import("@proovra/shared-runtime");
  let ownTeamId: string;
  let ownOwnerId: string;
  let ownOrgId: string;
  let foreignTeamId: string;
  let foreignOwnerId: string;
  let foreignOrgId: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    reconciler = await import(
      "../../../worker/src/governance/trash-grace-reconciler.js"
    );
    executor = await import("@proovra/shared-runtime");

    ownTeamId = harness.fixtures.teamA.teamId;
    ownOwnerId = harness.fixtures.teamA.ownerUserId;
    foreignTeamId = harness.fixtures.teamB.teamId;
    foreignOwnerId = harness.fixtures.teamB.ownerUserId;
    const [a, b] = await Promise.all([
      prisma.team.findUniqueOrThrow({
        where: { id: ownTeamId },
        select: { organizationId: true },
      }),
      prisma.team.findUniqueOrThrow({
        where: { id: foreignTeamId },
        select: { organizationId: true },
      }),
    ]);
    ownOrgId = a.organizationId as string;
    foreignOrgId = b.organizationId as string;
  }, 600_000);

  afterAll(async () => {
    await recordSuiteProof(import.meta.url);
    await harness?.cleanup();
  });

  /**
   * A trashed record whose grace has ELAPSED, in the given workspace.
   *
   * Seeded through the database rather than the route so the case can place the
   * deadline in the past without waiting ninety days.
   */
  async function expiredTrash(
    which: "own" | "foreign" = "own",
    over: Record<string, unknown> = {},
  ): Promise<{ id: string; bucket: string; key: string }> {
    const teamId = which === "own" ? ownTeamId : foreignTeamId;
    const ownerUserId = which === "own" ? ownOwnerId : foreignOwnerId;
    const organizationId = which === "own" ? ownOrgId : foreignOrgId;
    const bucket = "disposable-test-bucket";
    const key = `fictional/trash-grace-${Math.floor(performance.now() * 1000)}.bin`;
    const row = await prisma.evidence.create({
      data: {
        title: "Fictional trash-grace record",
        type: "PHOTO",
        status: "CREATED",
        teamId,
        organizationId,
        ownerUserId,
        storageBucket: bucket,
        storageKey: key,
        lifecycleState: "TRASHED",
        deletedAt: new Date(Date.now() - 200 * DAY),
        deletedAtUtc: new Date(Date.now() - 200 * DAY),
        deleteScheduledForUtc: new Date(Date.now() - 110 * DAY),
        ...over,
      } as never,
      select: { id: true },
    });
    return { id: row.id, bucket, key };
  }

  function candidateFor(
    report: Awaited<ReturnType<typeof reconciler.runTrashGraceReconciliation>>,
    id: string,
  ) {
    return report.candidates.find((c) => c.evidenceId === id);
  }

  // =========================================================================
  // durable.intent_before_work
  // =========================================================================

  it("trashgrace: the deadline is durable BEFORE the sweep, and the sweep finds it unaided", async () => {
    const rec = await expiredTrash();

    // The fact exists in the database, committed by the lifecycle write. No
    // queue message, no in-memory schedule.
    const persisted = await prisma.evidence.findUniqueOrThrow({
      where: { id: rec.id },
      select: { lifecycleState: true, deleteScheduledForUtc: true },
    });
    expect(persisted.lifecycleState).toBe("TRASHED");
    expect(persisted.deleteScheduledForUtc!.getTime()).toBeLessThan(Date.now());

    const report = await reconciler.runTrashGraceReconciliation({
      teamId: ownTeamId,
      dryRun: true,
      trigger: "point5-proof",
    });
    const candidate = candidateFor(report, rec.id);
    expect(candidate, "the sweep must discover the record from the row alone").toBeTruthy();
    expect(candidate!.trashGraceUntilUtc).not.toBeNull();
    provenCase("trashgrace.durable.intent_before_work");
  });

  // =========================================================================
  // tenant.workspace_reloaded
  // =========================================================================

  it("trashgrace: the candidate's workspace is read from the evidence row", async () => {
    const rec = await expiredTrash();
    const report = await reconciler.runTrashGraceReconciliation({
      teamId: ownTeamId,
      dryRun: true,
      trigger: "point5-proof",
    });
    const candidate = candidateFor(report, rec.id)!;
    // Derived from Evidence.teamId — never from the caller's option, which is
    // only a filter.
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id: rec.id },
      select: { teamId: true },
    });
    expect(candidate.teamId).toBe(row.teamId);
    expect(candidate.teamId).toBe(ownTeamId);
    provenCase("trashgrace.tenant.workspace_reloaded");
  });

  // =========================================================================
  // tenant.cross_workspace_denied
  // =========================================================================

  it("trashgrace: a workspace-scoped run never reports another workspace's record", async () => {
    const mine = await expiredTrash("own");
    const theirs = await expiredTrash("foreign");

    const report = await reconciler.runTrashGraceReconciliation({
      teamId: ownTeamId,
      dryRun: true,
      trigger: "point5-proof",
    });

    expect(candidateFor(report, mine.id)).toBeTruthy();
    expect(candidateFor(report, theirs.id)).toBeUndefined();
    provenCase("trashgrace.tenant.cross_workspace_denied");
  });

  // =========================================================================
  // claim.one_winner
  // =========================================================================

  it("trashgrace: two executors racing the same candidate produce ONE destruction", async () => {
    // The claim the sweep hands off to. Both callers see an eligible record;
    // the compare-and-set on lifecycle_state decides, and the loser stands down
    // rather than deleting the same keys a second time.
    const rec = await expiredTrash();
    const store = disposableStore();
    store.objects.add(`${rec.bucket}/${rec.key}`);

    const [a, b] = await Promise.all([
      executor.executeEvidenceDestruction(
        prisma,
        { evidenceId: rec.id, trigger: "trash_grace_reconciler", legalHold: false },
        store.port,
      ),
      executor.executeEvidenceDestruction(
        prisma,
        { evidenceId: rec.id, trigger: "purge_job", legalHold: false },
        store.port,
      ),
    ]);

    const destroyed = [a, b].filter((r) => r.ok && r.outcome === "DESTROYED");
    expect(destroyed).toHaveLength(1);
    expect(
      await prisma.evidenceLifecycleEvent.count({
        where: { evidenceId: rec.id, eventType: "destruction_executed" },
      }),
    ).toBe(1);
    provenCase("trashgrace.claim.one_winner");
  });

  // =========================================================================
  // claim.active_not_stolen
  // =========================================================================

  it("trashgrace: a LIVE claim is not stolen by a second executor", async () => {
    const rec = await expiredTrash();
    // Another executor holds the claim, and its lease is fresh.
    await prisma.evidence.update({
      where: { id: rec.id },
      data: {
        lifecycleState: "PENDING_DESTRUCTION",
        destructionClaimedAtUtc: new Date(),
      },
    });
    const store = disposableStore();
    store.objects.add(`${rec.bucket}/${rec.key}`);

    const result = await executor.executeEvidenceDestruction(
      prisma,
      { evidenceId: rec.id, trigger: "manual", legalHold: false },
      store.port,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.outcome).toBe("CLAIM_HELD");
    // The holder's claim is untouched and nothing was deleted.
    const after = await prisma.evidence.findUniqueOrThrow({
      where: { id: rec.id },
      select: { lifecycleState: true, destructionClaimedAtUtc: true },
    });
    expect(after.lifecycleState).toBe("PENDING_DESTRUCTION");
    expect(after.destructionClaimedAtUtc).not.toBeNull();
    expect(store.objects.has(`${rec.bucket}/${rec.key}`)).toBe(true);

    // …and an EXPIRED claim IS reclaimable, so a crashed executor does not
    // strand the record forever.
    await prisma.evidence.update({
      where: { id: rec.id },
      data: { destructionClaimedAtUtc: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });
    const takeover = await executor.executeEvidenceDestruction(
      prisma,
      { evidenceId: rec.id, trigger: "manual", legalHold: false },
      store.port,
    );
    expect(takeover.ok).toBe(true);
    provenCase("trashgrace.claim.active_not_stolen");
  });

  // =========================================================================
  // idempotency.duplicate_is_noop
  // =========================================================================

  it("trashgrace: re-running the sweep opens ONE destruction review, not one per tick", async () => {
    // The sweep's only creating mutation. Guarded by
    // `Evidence.activeDestructionReviewId`, so a schedule that fires hourly for
    // a week does not leave an operator with 168 identical reviews.
    const rec = await expiredTrash();

    for (let i = 0; i < 3; i += 1) {
      await reconciler.runTrashGraceReconciliation({
        teamId: ownTeamId,
        trigger: `point5-proof-${i}`,
      });
    }

    const reviews = await prisma.destructionReview.count({
      where: { evidenceId: rec.id },
    });
    expect(reviews).toBe(1);
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id: rec.id },
      select: { activeDestructionReviewId: true, lifecycleState: true },
    });
    expect(row.activeDestructionReviewId).not.toBeNull();
    // And the sweep changed no lifecycle state doing it.
    expect(row.lifecycleState).toBe("TRASHED");
    provenCase("trashgrace.idempotency.duplicate_is_noop");
  });

  // =========================================================================
  // terminal.stale_cannot_overwrite
  // =========================================================================

  it("trashgrace: a DESTROYED record is never re-nominated or re-certified", async () => {
    const rec = await expiredTrash();
    const store = disposableStore();
    store.objects.add(`${rec.bucket}/${rec.key}`);

    const first = await executor.executeEvidenceDestruction(
      prisma,
      { evidenceId: rec.id, trigger: "manual", legalHold: false },
      store.port,
    );
    expect(first.ok).toBe(true);
    const destroyedAt = (
      await prisma.evidence.findUniqueOrThrow({
        where: { id: rec.id },
        select: { destroyedAtUtc: true },
      })
    ).destroyedAtUtc;

    // The sweep scans by lifecycle_state, so a tombstone — which still carries
    // `deleted_at` from its time in the trash — cannot reappear as a candidate.
    const report = await reconciler.runTrashGraceReconciliation({
      teamId: ownTeamId,
      dryRun: true,
      trigger: "point5-proof",
    });
    expect(candidateFor(report, rec.id)).toBeUndefined();

    // A redelivered execution is a no-op: no second certificate, and the
    // original destruction timestamp is not re-stamped.
    const again = await executor.executeEvidenceDestruction(
      prisma,
      { evidenceId: rec.id, trigger: "purge_job", legalHold: false },
      store.port,
    );
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.outcome).toBe("ALREADY_DESTROYED");
    expect(
      await prisma.evidenceLifecycleEvent.count({
        where: { evidenceId: rec.id, eventType: "destruction_executed" },
      }),
    ).toBe(1);
    expect(
      (
        await prisma.evidence.findUniqueOrThrow({
          where: { id: rec.id },
          select: { destroyedAtUtc: true },
        })
      ).destroyedAtUtc?.toISOString(),
    ).toBe(destroyedAt?.toISOString());
    provenCase("trashgrace.terminal.stale_cannot_overwrite");
  });

  // =========================================================================
  // The production safety gate
  // =========================================================================

  it("trashgrace: automatic destruction is OFF by default — eligible candidates are observed, not enqueued", async () => {
    const previous = process.env.AUTOMATIC_EVIDENCE_DESTRUCTION_ENABLED;
    delete process.env.AUTOMATIC_EVIDENCE_DESTRUCTION_ENABLED;
    try {
      // Personal-scope so no approval is required and the record is genuinely
      // eligible — the case is about the FLAG, not about a block.
      const bucket = "disposable-test-bucket";
      const key = `fictional/observe-${Math.floor(performance.now() * 1000)}.bin`;
      const row = await prisma.evidence.create({
        data: {
          title: "Fictional observe-only record",
          type: "PHOTO",
          status: "CREATED",
          teamId: null,
          ownerUserId: ownOwnerId,
          storageBucket: bucket,
          storageKey: key,
          lifecycleState: "TRASHED",
          deletedAt: new Date(Date.now() - 200 * DAY),
          deletedAtUtc: new Date(Date.now() - 200 * DAY),
          deleteScheduledForUtc: new Date(Date.now() - 110 * DAY),
        } as never,
        select: { id: true },
      });

      const report = await reconciler.runTrashGraceReconciliation({
        trigger: "point5-proof-flag",
      });
      expect(report.observeOnly).toBe(true);
      expect(report.enqueued).toBe(0);
      const candidate = candidateFor(report, row.id);
      expect(candidate?.disposition).toBe("ELIGIBLE_OBSERVE_ONLY");

      // And the record is untouched: still trashed, still stored.
      const after = await prisma.evidence.findUniqueOrThrow({
        where: { id: row.id },
        select: { lifecycleState: true, destroyedAtUtc: true, storageKey: true },
      });
      expect(after.lifecycleState).toBe("TRASHED");
      expect(after.destroyedAtUtc).toBeNull();
      expect(after.storageKey).toBe(key);
      provenCase("trashgrace.observe_only_by_default");
    } finally {
      if (previous === undefined) {
        delete process.env.AUTOMATIC_EVIDENCE_DESTRUCTION_ENABLED;
      } else {
        process.env.AUTOMATIC_EVIDENCE_DESTRUCTION_ENABLED = previous;
      }
    }
  });
});
