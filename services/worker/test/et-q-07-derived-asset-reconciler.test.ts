/**
 * ET-Q-07 (2026-09-30) — the derived-asset PENDING reconciler.
 *
 * `GenerateDerivedAsset` named `intelligence-run-reconciler.ts` as its
 * reconciler while no scan in that module read `evidence_part_derived_assets`:
 * a row whose enqueue was lost stayed PENDING forever. The scan was written
 * (`reconcileStrandedDerivedAssets`, step 4 of the tick). These cases drive the
 * REAL function against a Postgres-shaped double and a recording enqueue.
 *
 * WHAT IS AND IS NOT PROVEN HERE
 * ---------------------------------------------------------------------------
 * Proven: the orchestration — what is selected, claimed, enqueued, counted and
 * abandoned, and that every guard that must hold does. The double evaluates
 * the predicates of the SQL the module actually emits (the ineligible-state
 * list is parsed out of the emitted text, not restated), and the emitted text
 * is asserted for each clause the policy depends on.
 *
 * Not proven: that PostgreSQL executes that SQL. There is no database in the
 * unit project; that is the integration project's job.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  JOB_NAMES,
  buildCanonicalJobId,
  getWorkEntryOrThrow,
} from "@proovra/shared";

// ---------------------------------------------------------------------------
// The two boundaries: the database and the queue.
// ---------------------------------------------------------------------------

type AssetRow = {
  id: string;
  evidenceId: string;
  status: string;
  updatedAtUtc: Date;
  lastError: string | null;
};
type EvidenceRow = { id: string; deletedAt: Date | null; lifecycleState: string };

const db = vi.hoisted(() => ({
  assets: [] as Array<{
    id: string;
    evidenceId: string;
    status: string;
    updatedAtUtc: Date;
    lastError: string | null;
  }>,
  evidence: [] as Array<{ id: string; deletedAt: Date | null; lifecycleState: string }>,
  sql: [] as string[],
  /** When set, the scan query throws — a database that cannot answer. */
  scanFails: false,
}));

const queue = vi.hoisted(() => ({
  calls: [] as Array<{ id: string; options: unknown }>,
  /** Job ids that are "live" in the queue: an enqueue for one COLLAPSES. */
  live: new Set<string>(),
  mode: "ok" as "ok" | "unavailable",
}));

vi.mock("../src/db.js", () => {
  const matches = (
    row: { id: string; status: string; updatedAtUtc: Date },
    where: { id: string; status?: string; updatedAtUtc?: { lt: Date } },
  ) =>
    row.id === where.id &&
    (where.status === undefined || row.status === where.status) &&
    (where.updatedAtUtc === undefined || row.updatedAtUtc < where.updatedAtUtc.lt);

  return {
    prisma: {
      // The run / chunk steps of the tick are not under test; they find nothing.
      mediaIntelligenceRun: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      $queryRaw: vi.fn(async () => []),
      $queryRawUnsafe: vi.fn(async (sql: string, cutoff: Date, limit: number) => {
        db.sql.push(sql);
        if (db.scanFails) throw new Error("connection terminated");
        // Evaluate the clause the module EMITTED: the ineligible lifecycle
        // states come out of the SQL text, so changing the policy changes what
        // this double returns.
        const notIn = sql.match(/NOT IN \(([^)]*)\)/);
        const ineligible = notIn
          ? [...notIn[1]!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!)
          : [];
        const requiresLiveEvidence = /"deleted_at" IS NULL/.test(sql);
        return db.assets
          .filter((a) => a.status === "PENDING" && a.updatedAtUtc < cutoff)
          .filter((a) => {
            const e = db.evidence.find((x) => x.id === a.evidenceId);
            if (!e) return false; // JOIN: no evidence row, no match
            if (requiresLiveEvidence && e.deletedAt !== null) return false;
            return !ineligible.includes(e.lifecycleState);
          })
          .sort((a, b) => a.updatedAtUtc.getTime() - b.updatedAtUtc.getTime())
          .slice(0, limit)
          .map((a) => ({ id: a.id, evidence_id: a.evidenceId, last_error: a.lastError }));
      }),
      evidence: {
        findFirst: vi.fn(
          async ({
            where,
          }: {
            where: { id: string; deletedAt: null; lifecycleState: { notIn: string[] } };
          }) => {
            const e = db.evidence.find((x) => x.id === where.id);
            if (!e || e.deletedAt !== null) return null;
            if (where.lifecycleState.notIn.includes(e.lifecycleState)) return null;
            return { id: e.id };
          },
        ),
      },
      evidencePartDerivedAsset: {
        updateMany: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { id: string; status?: string; updatedAtUtc?: { lt: Date } };
            data: Partial<{ status: string; updatedAtUtc: Date; lastError: string | null }>;
          }) => {
            const row = db.assets.find((a) => matches(a, where));
            if (!row) return { count: 0 };
            Object.assign(row, data);
            return { count: 1 };
          },
        ),
      },
    },
  };
});

vi.mock("../src/queue.js", () => ({
  enqueueMediaIntelligenceRunById: vi.fn(async () => ({ enqueued: true, jobId: "x" })),
  enqueueMiEmbedJob: vi.fn(async () => ({ enqueued: true, jobId: "x" })),
  enqueueDerivedAssetJob: vi.fn(async (id: string, options: unknown) => {
    queue.calls.push({ id, options });
    if (queue.mode === "unavailable") {
      return { enqueued: false, reason: "queue_unavailable:ECONNREFUSED" };
    }
    const jobId = `mi-derived-${id}`;
    if (queue.live.has(jobId)) return { enqueued: true, jobId, collapsed: true };
    queue.live.add(jobId);
    return { enqueued: true, jobId, collapsed: false };
  }),
}));

const {
  DERIVED_ASSET_INELIGIBLE_LIFECYCLE_STATES,
  DERIVED_ASSET_RECOVERY_MARKER,
  RECOVERED_WORK_TYPES,
  derivedAssetRecoveryAttempts,
  reconcileStrandedDerivedAssets,
  runIntelligenceRunReconciler,
} = await import("../src/intelligence-run-reconciler.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function evidence(lifecycleState = "ACTIVE", deletedAt: Date | null = null): EvidenceRow {
  const row = { id: uuid(), deletedAt, lifecycleState };
  db.evidence.push(row);
  return row;
}
function asset(
  over: Partial<AssetRow> & { evidenceId: string },
): AssetRow {
  const row: AssetRow = {
    id: uuid(),
    status: "PENDING",
    updatedAtUtc: ago(60),
    lastError: null,
    ...over,
  };
  db.assets.push(row);
  return row;
}

beforeEach(() => {
  db.assets.length = 0;
  db.evidence.length = 0;
  db.sql.length = 0;
  db.scanFails = false;
  queue.calls.length = 0;
  queue.live.clear();
  queue.mode = "ok";
});

// ---------------------------------------------------------------------------

describe("ET-Q-07 — derived-asset PENDING reconciler", () => {
  it("re-enqueues a stranded PENDING row ONCE, under the producer's own job id", async () => {
    const ev = evidence();
    const stuck = asset({ evidenceId: ev.id });

    const first = await reconcileStrandedDerivedAssets({ batchSize: 50 });
    expect(first).toMatchObject({ stranded: 1, reEnqueued: 1, collapsed: 0, failed: 0 });
    expect(queue.calls).toEqual([{ id: stuck.id, options: { traceId: "reconciler" } }]);

    // The command id is the ROW id — the same command the API producer sends —
    // so the two paths build one job id and the queue can collapse them.
    const entry = getWorkEntryOrThrow(JOB_NAMES.GENERATE_DERIVED_ASSET);
    expect(buildCanonicalJobId({ jobIdPrefix: entry.jobIdPrefix! }, stuck.id)).toBe(
      `mi-derived-${stuck.id}`,
    );

    // A second tick immediately afterwards finds nothing: the claim moved the
    // row out of the stranded window, so it is not re-enqueued every tick.
    const second = await reconcileStrandedDerivedAssets({ batchSize: 50 });
    expect(second).toMatchObject({ stranded: 0, reEnqueued: 0 });
    expect(queue.calls).toHaveLength(1);

    // It never settles the row — success belongs to the processor.
    expect(stuck.status).toBe("PENDING");
    expect(stuck.lastError).toBe(`${DERIVED_ASSET_RECOVERY_MARKER}1`);
  });

  it("leaves a FRESH PENDING row alone — its original job may still be in flight", async () => {
    const ev = evidence();
    asset({ evidenceId: ev.id, updatedAtUtc: ago(2) });

    const result = await reconcileStrandedDerivedAssets({ batchSize: 50 });
    expect(result).toMatchObject({ stranded: 0, reEnqueued: 0 });
    expect(queue.calls).toEqual([]);
  });

  it("leaves every settled row alone: COMPLETED, FAILED and UNSUPPORTED are not stranded", async () => {
    const ev = evidence();
    for (const status of ["COMPLETED", "FAILED", "UNSUPPORTED"]) {
      asset({ evidenceId: ev.id, status });
    }
    const result = await reconcileStrandedDerivedAssets({ batchSize: 50 });
    expect(result.stranded).toBe(0);
    expect(queue.calls).toEqual([]);
  });

  it("does not duplicate a job that is ALREADY LIVE — it joins it, and spends no attempt", async () => {
    const ev = evidence();
    const stuck = asset({ evidenceId: ev.id });
    queue.live.add(`mi-derived-${stuck.id}`); // the original job is still queued

    const result = await reconcileStrandedDerivedAssets({ batchSize: 50 });
    expect(result).toMatchObject({ stranded: 1, reEnqueued: 0, collapsed: 1, failed: 0 });
    // One enqueue call, for the same id — the queue collapsed it; nothing new.
    expect(queue.calls.map((c) => c.id)).toEqual([stuck.id]);
    expect(queue.live.size).toBe(1);
    // Joining live work is not a recovery attempt.
    expect(stuck.lastError).toBeNull();
  });

  it("two overlapping ticks claim a row ONCE", async () => {
    const ev = evidence();
    const stuck = asset({ evidenceId: ev.id });

    const [a, b] = await Promise.all([
      reconcileStrandedDerivedAssets({ batchSize: 50 }),
      reconcileStrandedDerivedAssets({ batchSize: 50 }),
    ]);
    // Both scans may see the row; only one conditional claim can match it.
    expect(a.reEnqueued + b.reEnqueued).toBe(1);
    expect(queue.calls.map((c) => c.id)).toEqual([stuck.id]);
  });

  it("skips TRASHED, PENDING_DESTRUCTION, DESTROYED and soft-deleted evidence — in the query", async () => {
    const live = evidence("ACTIVE");
    const served = asset({ evidenceId: live.id });
    for (const state of DERIVED_ASSET_INELIGIBLE_LIFECYCLE_STATES) {
      asset({ evidenceId: evidence(state).id });
    }
    asset({ evidenceId: evidence("ACTIVE", ago(10)).id }); // soft-deleted
    asset({ evidenceId: uuid() }); // its evidence row no longer exists

    const result = await reconcileStrandedDerivedAssets({ batchSize: 50 });
    expect(result).toMatchObject({ stranded: 1, reEnqueued: 1, skippedIneligible: 0 });
    expect(queue.calls.map((c) => c.id)).toEqual([served.id]);

    // The exclusion is in the emitted SQL — not applied to the page afterwards,
    // where ineligible rows (which never leave PENDING) would pile up at the
    // head of an oldest-first page and starve everything behind them.
    const sql = db.sql[0]!;
    expect(sql).toMatch(/FROM "evidence_part_derived_assets" d/);
    expect(sql).toMatch(/JOIN "evidence" e ON e\."id" = d\."evidence_id"/);
    expect(sql).toMatch(/d\."status" = 'PENDING'/);
    expect(sql).toMatch(/e\."deleted_at" IS NULL/);
    expect(sql).toMatch(/NOT IN \('TRASHED','PENDING_DESTRUCTION','DESTROYED'\)/);
    expect(sql).toMatch(/ORDER BY d\."updated_at_utc" ASC/);
    expect(sql).toMatch(/LIMIT \$2/);
    // Every other lifecycle state IS served.
    expect(DERIVED_ASSET_INELIGIBLE_LIFECYCLE_STATES).toEqual([
      "TRASHED",
      "PENDING_DESTRUCTION",
      "DESTROYED",
    ]);
  });

  it("re-checks the record at claim time: evidence trashed after the scan is not regenerated", async () => {
    const ev = evidence("ACTIVE");
    const stuck = asset({ evidenceId: ev.id });
    // The scan has already returned the row when the record is trashed.
    const { prisma } = await import("../src/db.js");
    // The double is a plain async function; Prisma's own signature returns a
    // branded `PrismaPromise`, so it is addressed through its mock type.
    const scan = prisma.$queryRawUnsafe as unknown as ReturnType<
      typeof vi.fn<(...args: unknown[]) => Promise<unknown>>
    >;
    const original = scan.getMockImplementation()!;
    scan.mockImplementationOnce(async (...args: unknown[]) => {
      const rows = await original(...args);
      ev.lifecycleState = "TRASHED";
      return rows;
    });

    const result = await reconcileStrandedDerivedAssets({ batchSize: 50 });
    expect(result).toMatchObject({ stranded: 1, reEnqueued: 0, skippedIneligible: 1 });
    expect(queue.calls).toEqual([]);
    // Untouched: if the record is restored the row is still PENDING and owed.
    expect(stuck.status).toBe("PENDING");
    expect(stuck.lastError).toBeNull();
  });

  it("respects the batch bound, oldest first, and drains the rest on later ticks", async () => {
    const ev = evidence();
    const rows = [50, 40, 90, 70, 60].map((m) =>
      asset({ evidenceId: ev.id, updatedAtUtc: ago(m) }),
    );
    const byAge = [...rows].sort(
      (a, b) => a.updatedAtUtc.getTime() - b.updatedAtUtc.getTime(),
    );
    const oldestTwo = byAge.slice(0, 2).map((r) => r.id);

    const first = await reconcileStrandedDerivedAssets({ batchSize: 2 });
    expect(first).toMatchObject({ stranded: 2, reEnqueued: 2 });
    expect(queue.calls.map((c) => c.id)).toEqual(oldestTwo);

    // Self-draining: the served rows left the window, so the next pages are
    // the next-oldest — no cursor, and nothing served twice.
    await reconcileStrandedDerivedAssets({ batchSize: 2 });
    await reconcileStrandedDerivedAssets({ batchSize: 2 });
    expect(queue.calls).toHaveLength(5);
    expect(new Set(queue.calls.map((c) => c.id)).size).toBe(5);
    expect((await reconcileStrandedDerivedAssets({ batchSize: 2 })).stranded).toBe(0);
  });

  it("clamps an absurd batch size rather than honouring it", async () => {
    const ev = evidence();
    asset({ evidenceId: ev.id });
    await reconcileStrandedDerivedAssets({ batchSize: 1_000_000 });
    const { prisma } = await import("../src/db.js");
    const limit = vi.mocked(prisma.$queryRawUnsafe).mock.calls.at(-1)![2];
    expect(limit).toBe(500);
  });

  it("an enqueue that FAILS spends no attempt — a Redis outage cannot walk a backlog to FAILED", async () => {
    const ev = evidence();
    const stuck = asset({ evidenceId: ev.id });
    queue.mode = "unavailable";

    const result = await reconcileStrandedDerivedAssets({ batchSize: 50 });
    expect(result).toMatchObject({ stranded: 1, reEnqueued: 0, failed: 1, abandoned: 0 });
    expect(stuck.status).toBe("PENDING");
    expect(derivedAssetRecoveryAttempts(stuck.lastError)).toBe(0);
  });

  it("settles a row FAILED after the recovery ceiling instead of retrying it forever", async () => {
    const ev = evidence();
    const poisoned = asset({
      evidenceId: ev.id,
      lastError: `${DERIVED_ASSET_RECOVERY_MARKER}5`,
    });

    const result = await reconcileStrandedDerivedAssets({ batchSize: 50 });
    expect(result).toMatchObject({ stranded: 1, reEnqueued: 0, abandoned: 1 });
    expect(queue.calls).toEqual([]);
    expect(poisoned.status).toBe("FAILED");
    expect(poisoned.lastError).toBe("recovery_attempts_exhausted");
    // Terminal: the next tick does not see it.
    expect((await reconcileStrandedDerivedAssets({ batchSize: 50 })).stranded).toBe(0);
  });

  it("counts attempts only from its own marker", () => {
    expect(derivedAssetRecoveryAttempts(null)).toBe(0);
    expect(derivedAssetRecoveryAttempts("source_fetch_failed")).toBe(0);
    expect(derivedAssetRecoveryAttempts(`${DERIVED_ASSET_RECOVERY_MARKER}3`)).toBe(3);
    expect(derivedAssetRecoveryAttempts(`${DERIVED_ASSET_RECOVERY_MARKER}x`)).toBe(0);
  });

  it("a scan that cannot run is reported, not thrown, and enqueues nothing", async () => {
    const ev = evidence();
    asset({ evidenceId: ev.id });
    db.scanFails = true;

    const result = await reconcileStrandedDerivedAssets({ batchSize: 50 });
    expect(result).toMatchObject({ stranded: 0, reEnqueued: 0, failed: 1 });
    expect(queue.calls).toEqual([]);
  });

  it("runs inside the scheduled tick and reports on its result", async () => {
    // The HOOK. `runIntelligenceRunReconciler` is what the worker's existing
    // `startIntelligenceRunReconcilerScheduler` interval calls, so the scan is
    // scheduled without any change to the bootstrap.
    const ev = evidence();
    const stuck = asset({ evidenceId: ev.id });

    const result = await runIntelligenceRunReconciler({ trigger: "test" });
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      derivedAssetsStranded: 1,
      derivedAssetsReEnqueued: 1,
      derivedAssetsCollapsed: 0,
      derivedAssetsAbandoned: 0,
    });
    expect(queue.calls.map((c) => c.id)).toEqual([stuck.id]);
  });

  it("the module declares the work, so the registry can name it", () => {
    expect(RECOVERED_WORK_TYPES).toContain("GENERATE_DERIVED_ASSET");
    expect(getWorkEntryOrThrow(JOB_NAMES.GENERATE_DERIVED_ASSET).reconciler).toBe(
      "services/worker/src/intelligence-run-reconciler.ts",
    );
  });
});
