/**
 * UC-DER-013 — the stranded-run reconciler must not revive derived work for a
 * record that has left service.
 *
 * Stranded PENDING media-intelligence runs (a lost enqueue) are re-enqueued by
 * the reconciler tick. Before this fix the scan read `media_intelligence_runs`
 * with no lifecycle filter, so a run of a trashed / destruction-bound /
 * destroyed record was re-enqueued and wrote new derived bytes and text onto
 * it. The double below answers the SQL the module EMITS (the ineligible states
 * are parsed out of it, not restated) and, for the pre-fix typed query, returns
 * every stranded run exactly as the database would.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  runs: [] as Array<{ id: string; kind: string; evidenceId: string; attemptCount: number; status: string; updatedAtUtc: Date }>,
  evidence: [] as Array<{ id: string; deletedAt: Date | null; lifecycleState: string }>,
  runSql: [] as string[],
  enqueued: [] as string[],
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    mediaIntelligenceRun: {
      // Pre-fix path: every PENDING run older than the cutoff, no lifecycle.
      findMany: vi.fn(async ({ where }: { where: { status: string; updatedAtUtc?: { lt: Date }; startedAtUtc?: unknown } }) => {
        if (where.status !== "PENDING") return [];
        return db.runs
          .filter((r) => r.status === "PENDING" && (!where.updatedAtUtc || r.updatedAtUtc < where.updatedAtUtc.lt))
          .map(({ id, kind, evidenceId, attemptCount }) => ({ id, kind, evidenceId, attemptCount }));
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $queryRaw: vi.fn(async () => []),
    $queryRawUnsafe: vi.fn(async (sql: string, cutoff: Date, limit: number) => {
      if (!/FROM "media_intelligence_runs" r/.test(sql)) return [];
      db.runSql.push(sql);
      const notIn = sql.match(/NOT IN \(([^)]*)\)/);
      const ineligible = notIn ? [...notIn[1]!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!) : [];
      const requiresLive = /"deleted_at" IS NULL/.test(sql);
      return db.runs
        .filter((r) => r.status === "PENDING" && r.updatedAtUtc < cutoff)
        .filter((r) => {
          const e = db.evidence.find((x) => x.id === r.evidenceId);
          if (!e) return /e\."id" IS NULL/.test(sql); // LEFT JOIN: missing evidence kept
          if (requiresLive && e.deletedAt) return false;
          return !ineligible.includes(e.lifecycleState);
        })
        .slice(0, limit)
        .map((r) => ({ id: r.id, kind: r.kind, evidence_id: r.evidenceId, attempt_count: r.attemptCount }));
    }),
    evidence: { findFirst: vi.fn(async () => null) },
    evidencePartDerivedAsset: { updateMany: vi.fn(async () => ({ count: 0 })) },
  },
}));

vi.mock("../src/queue.js", () => ({
  enqueueMediaIntelligenceRunById: vi.fn(async (id: string) => {
    db.enqueued.push(id);
    return { enqueued: true, jobId: `mi-run-${id}` };
  }),
  enqueueMiEmbedJob: vi.fn(async () => ({ enqueued: true, jobId: "x" })),
  enqueueDerivedAssetById: vi.fn(async () => ({ enqueued: true, jobId: "x" })),
}));

import { runIntelligenceRunReconciler } from "../src/intelligence-run-reconciler.js";

const old = () => new Date(Date.now() - 24 * 60 * 60 * 1000);
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

beforeEach(() => {
  db.runs = [];
  db.evidence = [];
  db.runSql = [];
  db.enqueued = [];
});

function record(lifecycleState: string, deletedAt: Date | null = null) {
  const e = { id: id(), deletedAt, lifecycleState };
  db.evidence.push(e);
  return e.id;
}
function run(evidenceId: string) {
  const r = { id: id(), kind: "reconstruct_screen", evidenceId, attemptCount: 0, status: "PENDING", updatedAtUtc: old() };
  db.runs.push(r);
  return r.id;
}

describe("stranded media-intelligence runs × record lifecycle (UC-DER-013)", () => {
  it("re-enqueues a live record's run and never a trashed / destruction-bound / destroyed record's run", async () => {
    const live = run(record("ACTIVE"));
    const held = run(record("ON_HOLD"));
    const trashed = run(record("TRASHED", new Date()));
    const softDeleted = run(record("ACTIVE", new Date()));
    const pending = run(record("PENDING_DESTRUCTION"));
    const destroyed = run(record("DESTROYED"));

    await runIntelligenceRunReconciler({ trigger: "test" });

    expect(db.enqueued.sort()).toEqual([live, held].sort());
    for (const refused of [trashed, softDeleted, pending, destroyed]) {
      expect(db.enqueued).not.toContain(refused);
    }
    // The exclusion is in the emitted SQL (no starvation by ineligible rows).
    expect(db.runSql[0]).toMatch(/NOT IN \('TRASHED','PENDING_DESTRUCTION','DESTROYED'\)/);
    expect(db.runSql[0]).toMatch(/ORDER BY r\."updated_at_utc" ASC/);
  });
});
