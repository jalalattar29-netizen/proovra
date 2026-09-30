/**
 * ET-Q-07 (2026-09-30) — graph and signal-projection recovery.
 *
 * `ReconcileTeamGraph` and `RefreshGraphSearchProjection` named
 * `search-index-reconciler.ts` as their reconciler while that module looked at
 * neither. Two scans were written there:
 *
 *   reconcileStrandedGraphProjections   evidence vs investigation_graph_nodes
 *   reconcileStaleSignalProjections     media_intelligence_signals vs
 *                                       evidence_search_documents
 *
 * These cases drive the REAL functions against a Postgres-shaped double and a
 * recording queue.
 *
 * WHAT IS AND IS NOT PROVEN HERE
 * ---------------------------------------------------------------------------
 * Proven: the orchestration and every bound — which candidates are handed to
 * which producer, once, under which id; what a live job, a failed enqueue and
 * a failed scan do; and that the emitted SQL carries each clause the policy
 * depends on. The double applies those same predicates to in-memory rows, with
 * the search-eligibility rule taken from the shared authority the SQL is built
 * from.
 *
 * Not proven: that PostgreSQL executes the SQL. There is no database in the
 * unit project; that is the integration project's job.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  JOB_NAMES,
  buildCanonicalJobId,
  buildSearchIndexCommandId,
  getWorkEntryOrThrow,
  isSearchIndexableLifecycle,
} from "@proovra/shared";

type Evidence = {
  id: string;
  team_id: string | null;
  deleted_at: Date | null;
  status: string;
  lifecycle_state: string;
  updated_at: Date;
};
type Node = { team_id: string; node_kind: string; external_id: string; stale_at_utc: Date | null };
type Signal = { evidence_id: string; updated_at_utc: Date };
type Doc = { source_id: string; document_type: string; indexed_at_utc: Date };

const db = vi.hoisted(() => ({
  evidence: [] as Array<{
    id: string;
    team_id: string | null;
    deleted_at: Date | null;
    status: string;
    lifecycle_state: string;
    updated_at: Date;
  }>,
  nodes: [] as Array<{
    team_id: string;
    node_kind: string;
    external_id: string;
    stale_at_utc: Date | null;
  }>,
  signals: [] as Array<{ evidence_id: string; updated_at_utc: Date }>,
  docs: [] as Array<{ source_id: string; document_type: string; indexed_at_utc: Date }>,
  /** team id -> organization status. A team absent from this map does not exist. */
  orgStatusByTeam: new Map<string, string>(),
  sql: [] as string[],
  fail: null as null | "graph" | "signals",
}));

const queue = vi.hoisted(() => ({
  graph: [] as Array<{ teamId: string; options: unknown }>,
  search: [] as Array<{ kind: string; sourceId: string; reason?: string }>,
  live: new Set<string>(),
  mode: "ok" as "ok" | "unavailable",
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      db.sql.push(sql);
      const [settledBefore, notBefore, limit] = params as [Date, Date, number];

      if (sql.includes('"investigation_graph_nodes"')) {
        if (db.fail === "graph") throw new Error("connection terminated");
        const owed = db.evidence.filter((e) => {
          if (e.team_id === null || e.deleted_at !== null) return false;
          if (!["SIGNED", "REPORTED"].includes(e.status)) return false;
          if (!(e.updated_at < settledBefore && e.updated_at > notBefore)) return false;
          // JOIN teams + organizations, ACTIVE only.
          if (db.orgStatusByTeam.get(e.team_id) !== "ACTIVE") return false;
          return !db.nodes.some(
            (n) =>
              n.team_id === e.team_id &&
              n.node_kind === "EVIDENCE" &&
              n.external_id === e.id &&
              n.stale_at_utc === null,
          );
        });
        const oldestByTeam = new Map<string, number>();
        for (const e of owed) {
          const t = e.updated_at.getTime();
          oldestByTeam.set(e.team_id!, Math.min(oldestByTeam.get(e.team_id!) ?? t, t));
        }
        return [...oldestByTeam.entries()]
          .sort((a, b) => a[1] - b[1])
          .slice(0, limit)
          .map(([team_id]) => ({ team_id }));
      }

      if (sql.includes('"media_intelligence_signals"')) {
        if (db.fail === "signals") throw new Error("connection terminated");
        const oldest = new Map<string, number>();
        for (const s of db.signals) {
          const e = db.evidence.find((x) => x.id === s.evidence_id);
          if (!e || e.team_id === null) continue;
          if (!isSearchIndexableLifecycle(e.lifecycle_state)) continue;
          if (!(s.updated_at_utc < settledBefore && s.updated_at_utc > notBefore)) continue;
          const d = db.docs.find(
            (x) => x.source_id === e.id && x.document_type === "EVIDENCE",
          );
          if (!d) continue; // inner JOIN: a missing document is the drift scan's
          if (!(d.indexed_at_utc < s.updated_at_utc)) continue;
          const t = s.updated_at_utc.getTime();
          oldest.set(e.id, Math.min(oldest.get(e.id) ?? t, t));
        }
        return [...oldest.entries()]
          .sort((a, b) => a[1] - b[1])
          .slice(0, limit)
          .map(([evidence_id]) => ({ evidence_id }));
      }

      // The search drift discovery + sweep — not under test; nothing outstanding.
      return [];
    }),
  },
}));

vi.mock("../src/queue.js", () => ({
  enqueueGraphReconcileJob: vi.fn(async (teamId: string, options: unknown) => {
    queue.graph.push({ teamId, options });
    if (queue.mode === "unavailable") {
      return { enqueued: false, reason: "queue_unavailable:ECONNREFUSED" };
    }
    const jobId = `graph-reconcile-${teamId}`;
    if (queue.live.has(jobId)) return { enqueued: true, jobId, collapsed: true };
    queue.live.add(jobId);
    return { enqueued: true, jobId, collapsed: false };
  }),
  enqueueSearchIndexingJob: vi.fn(
    async (payload: { kind: string; sourceId: string; reason?: string }) => {
      queue.search.push(payload);
      if (queue.mode === "unavailable") {
        return { enqueued: false, reason: "queue_unavailable:ECONNREFUSED" };
      }
      const jobId = `search-index-${payload.kind}.${payload.sourceId}`;
      if (queue.live.has(jobId)) return { enqueued: true, jobId, collapsed: true };
      queue.live.add(jobId);
      return { enqueued: true, jobId, collapsed: false };
    },
  ),
}));

const {
  RECOVERED_WORK_TYPES,
  reconcileStaleSignalProjections,
  reconcileStrandedGraphProjections,
  runSearchIndexReconciler,
} = await import("../src/search-index-reconciler.js");

// ---------------------------------------------------------------------------

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const settledBefore = () => ago(15);
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function team(orgStatus = "ACTIVE"): string {
  const id = uuid();
  db.orgStatusByTeam.set(id, orgStatus);
  return id;
}
function evidence(over: Partial<Evidence> & { team_id: string | null }): Evidence {
  const row: Evidence = {
    id: uuid(),
    deleted_at: null,
    status: "SIGNED",
    lifecycle_state: "ACTIVE",
    updated_at: ago(60),
    ...over,
  };
  db.evidence.push(row);
  return row;
}
function node(e: Evidence, stale: Date | null = null): Node {
  const row = {
    team_id: e.team_id!,
    node_kind: "EVIDENCE",
    external_id: e.id,
    stale_at_utc: stale,
  };
  db.nodes.push(row);
  return row;
}
function signal(e: Evidence, updated: Date): Signal {
  const row = { evidence_id: e.id, updated_at_utc: updated };
  db.signals.push(row);
  return row;
}
function doc(e: Evidence, indexed: Date): Doc {
  const row = { source_id: e.id, document_type: "EVIDENCE", indexed_at_utc: indexed };
  db.docs.push(row);
  return row;
}

beforeEach(() => {
  db.evidence.length = 0;
  db.nodes.length = 0;
  db.signals.length = 0;
  db.docs.length = 0;
  db.orgStatusByTeam.clear();
  db.sql.length = 0;
  db.fail = null;
  queue.graph.length = 0;
  queue.search.length = 0;
  queue.live.clear();
  queue.mode = "ok";
});

// ===========================================================================
// ReconcileTeamGraph
// ===========================================================================

describe("ET-Q-07 — graph rebuild recovery (ReconcileTeamGraph)", () => {
  it("re-enqueues ONE rebuild for a workspace whose graph is missing finalized records", async () => {
    const t = team();
    evidence({ team_id: t });
    evidence({ team_id: t, status: "REPORTED" });
    evidence({ team_id: t });

    const result = await reconcileStrandedGraphProjections({
      settledBefore: settledBefore(),
      limit: 25,
    });
    // Three records owed, ONE workspace, one rebuild: the job is per-Team.
    expect(result).toEqual({ owed: 1, reEnqueued: 1, collapsed: 0, failed: 0 });
    expect(queue.graph).toEqual([{ teamId: t, options: { reason: "reconciler_drift" } }]);

    // Same command id as the API producer (the Team id) => same job id.
    const entry = getWorkEntryOrThrow(JOB_NAMES.RECONCILE_TEAM_GRAPH);
    expect(buildCanonicalJobId({ jobIdPrefix: entry.jobIdPrefix! }, t)).toBe(
      `graph-reconcile-${t}`,
    );
  });

  it("is self-draining: once the rebuild has materialised the node, the workspace is no longer owed", async () => {
    const t = team();
    const e = evidence({ team_id: t });
    await reconcileStrandedGraphProjections({ settledBefore: settledBefore(), limit: 25 });
    expect(queue.graph).toHaveLength(1);

    node(e); // what `reconcileTeamGraph` does
    queue.live.clear();
    const after = await reconcileStrandedGraphProjections({
      settledBefore: settledBefore(),
      limit: 25,
    });
    expect(after.owed).toBe(0);
    expect(queue.graph).toHaveLength(1);
  });

  it("leaves a FRESH record alone — its own reconcile may still be in flight", async () => {
    const t = team();
    evidence({ team_id: t, updated_at: ago(2) });
    const result = await reconcileStrandedGraphProjections({
      settledBefore: settledBefore(),
      limit: 25,
    });
    expect(result.owed).toBe(0);
    expect(queue.graph).toEqual([]);
  });

  it("does not duplicate a rebuild that is ALREADY LIVE — it joins it", async () => {
    const t = team();
    evidence({ team_id: t });
    queue.live.add(`graph-reconcile-${t}`);

    const result = await reconcileStrandedGraphProjections({
      settledBefore: settledBefore(),
      limit: 25,
    });
    expect(result).toEqual({ owed: 1, reEnqueued: 0, collapsed: 1, failed: 0 });
    expect(queue.live.size).toBe(1);
  });

  it("skips what no rebuild would ever serve", async () => {
    const live = team();
    const owed = evidence({ team_id: live });

    // Soft-deleted: the builder does not materialise it.
    evidence({ team_id: team(), deleted_at: ago(5) });
    // Never finalized: the live path never enqueued a reconcile for it.
    evidence({ team_id: team(), status: "UPLOADING" });
    evidence({ team_id: team(), status: "CREATED" });
    // No workspace: cannot be attributed to a graph at all.
    evidence({ team_id: null });
    // Suspended organization: the processor no-ops, so it would be re-enqueued
    // every tick forever for nothing.
    evidence({ team_id: team("SUSPENDED") });
    // A team row that no longer exists.
    evidence({ team_id: uuid() });
    // Already in the graph.
    node(evidence({ team_id: team() }));
    // Drift older than the recovery ceiling: a rebuild that keeps failing, not
    // a lost enqueue.
    evidence({ team_id: team(), updated_at: ago(60 * 24 * 45) });

    const result = await reconcileStrandedGraphProjections({
      settledBefore: settledBefore(),
      limit: 25,
    });
    expect(result.owed).toBe(1);
    expect(queue.graph.map((c) => c.teamId)).toEqual([owed.team_id]);
  });

  it("a node that went STALE for a live record counts as missing", async () => {
    const t = team();
    node(evidence({ team_id: t }), ago(30));
    const result = await reconcileStrandedGraphProjections({
      settledBefore: settledBefore(),
      limit: 25,
    });
    expect(result.owed).toBe(1);
  });

  it("respects the workspace bound, oldest drift first, and never exceeds 25 per tick", async () => {
    const teams = [40, 90, 60, 120, 30].map((m) => {
      const t = team();
      evidence({ team_id: t, updated_at: ago(m) });
      return { t, m };
    });
    const oldestFirst = [...teams].sort((a, b) => b.m - a.m).map((x) => x.t);

    const result = await reconcileStrandedGraphProjections({
      settledBefore: settledBefore(),
      limit: 2,
    });
    expect(result).toMatchObject({ owed: 2, reEnqueued: 2 });
    expect(queue.graph.map((c) => c.teamId)).toEqual(oldestFirst.slice(0, 2));

    // An absurd limit is clamped, not honoured: a graph rebuild is heavy.
    const { prisma } = await import("../src/db.js");
    await reconcileStrandedGraphProjections({
      settledBefore: settledBefore(),
      limit: 10_000,
    });
    expect(vi.mocked(prisma.$queryRawUnsafe).mock.calls.at(-1)![3]).toBe(25);
  });

  it("an enqueue that fails is counted as a failure, never as recovered", async () => {
    evidence({ team_id: team() });
    queue.mode = "unavailable";
    const result = await reconcileStrandedGraphProjections({
      settledBefore: settledBefore(),
      limit: 25,
    });
    expect(result).toEqual({ owed: 1, reEnqueued: 0, collapsed: 0, failed: 1 });
  });

  it("a scan that cannot run is reported, not thrown", async () => {
    evidence({ team_id: team() });
    db.fail = "graph";
    const result = await reconcileStrandedGraphProjections({
      settledBefore: settledBefore(),
      limit: 25,
    });
    expect(result).toEqual({ owed: 0, reEnqueued: 0, collapsed: 0, failed: 1 });
    expect(queue.graph).toEqual([]);
  });

  it("the emitted SQL carries every clause the policy depends on", async () => {
    evidence({ team_id: team() });
    await reconcileStrandedGraphProjections({ settledBefore: settledBefore(), limit: 25 });
    const sql = db.sql.find((s) => s.includes('"investigation_graph_nodes"'))!;
    expect(sql).toMatch(/FROM "evidence" e/);
    expect(sql).toMatch(/JOIN "teams" t ON t\."id" = e\."team_id"/);
    expect(sql).toMatch(/JOIN "organizations" o ON o\."id" = t\."organization_id"/);
    expect(sql).toMatch(/o\."status"::text = 'ACTIVE'/);
    expect(sql).toMatch(/e\."team_id" IS NOT NULL/);
    expect(sql).toMatch(/e\."deleted_at" IS NULL/);
    expect(sql).toMatch(/e\."status"::text IN \('SIGNED', 'REPORTED'\)/);
    expect(sql).toMatch(/NOT EXISTS \(/);
    expect(sql).toMatch(/n\."node_kind" = 'EVIDENCE'/);
    expect(sql).toMatch(/n\."stale_at_utc" IS NULL/);
    expect(sql).toMatch(/GROUP BY e\."team_id"/);
    expect(sql).toMatch(/LIMIT \$3/);
  });
});

// ===========================================================================
// RefreshGraphSearchProjection
// ===========================================================================

describe("ET-Q-07 — signal-projection recovery (RefreshGraphSearchProjection)", () => {
  it("re-enqueues the search rebuild ONCE for a record whose signals postdate its document", async () => {
    const e = evidence({ team_id: team() });
    doc(e, ago(120));
    signal(e, ago(60));
    signal(e, ago(45)); // two changed signals, still one rebuild

    const result = await reconcileStaleSignalProjections({
      settledBefore: settledBefore(),
      limit: 200,
    });
    expect(result).toEqual({ owed: 1, reEnqueued: 1, collapsed: 0, failed: 0 });
    expect(queue.search).toEqual([
      { kind: "evidence", sourceId: e.id, reason: "reconciler_signal_drift" },
    ]);
    // The same command the trigger itself enqueues.
    expect(buildSearchIndexCommandId("evidence", e.id)).toBe(`evidence:${e.id}`);
  });

  it("recovers drift OLDER than the trigger's sixty-minute window", async () => {
    // The reason the effect is recovered rather than the trigger re-enqueued:
    // `runSearchProjectionSync` only looks back an hour.
    const e = evidence({ team_id: team() });
    doc(e, ago(60 * 30));
    signal(e, ago(60 * 26));
    const result = await reconcileStaleSignalProjections({
      settledBefore: settledBefore(),
      limit: 200,
    });
    expect(result.reEnqueued).toBe(1);
  });

  it("is self-draining: once the document is rebuilt the record is no longer owed", async () => {
    const e = evidence({ team_id: team() });
    const d = doc(e, ago(120));
    signal(e, ago(60));
    await reconcileStaleSignalProjections({ settledBefore: settledBefore(), limit: 200 });
    d.indexed_at_utc = new Date(); // what the search-indexing processor does
    queue.live.clear();
    const after = await reconcileStaleSignalProjections({
      settledBefore: settledBefore(),
      limit: 200,
    });
    expect(after.owed).toBe(0);
    expect(queue.search).toHaveLength(1);
  });

  it("leaves a FRESH signal alone, and a record whose document is already newer", async () => {
    const fresh = evidence({ team_id: team() });
    doc(fresh, ago(120));
    signal(fresh, ago(2));

    const current = evidence({ team_id: team() });
    doc(current, ago(10));
    signal(current, ago(60));

    const result = await reconcileStaleSignalProjections({
      settledBefore: settledBefore(),
      limit: 200,
    });
    expect(result.owed).toBe(0);
    expect(queue.search).toEqual([]);
  });

  it("does not duplicate a rebuild that is ALREADY LIVE — it joins it", async () => {
    const e = evidence({ team_id: team() });
    doc(e, ago(120));
    signal(e, ago(60));
    queue.live.add(`search-index-evidence.${e.id}`);

    const result = await reconcileStaleSignalProjections({
      settledBefore: settledBefore(),
      limit: 200,
    });
    expect(result).toEqual({ owed: 1, reEnqueued: 0, collapsed: 1, failed: 0 });
  });

  it("skips destroyed evidence, records with no workspace, and records with no document", async () => {
    const owed = evidence({ team_id: team() });
    doc(owed, ago(120));
    signal(owed, ago(60));

    for (const state of ["DESTROYED", "PENDING_DESTRUCTION"]) {
      const gone = evidence({ team_id: team(), lifecycle_state: state });
      doc(gone, ago(120));
      signal(gone, ago(60));
    }
    const orphan = evidence({ team_id: null });
    doc(orphan, ago(120));
    signal(orphan, ago(60));
    // No document at all: "missing" belongs to the search drift scan.
    signal(evidence({ team_id: team() }), ago(60));
    // Beyond the recovery ceiling.
    const ancient = evidence({ team_id: team() });
    doc(ancient, ago(60 * 24 * 60));
    signal(ancient, ago(60 * 24 * 45));

    const result = await reconcileStaleSignalProjections({
      settledBefore: settledBefore(),
      limit: 200,
    });
    expect(result.owed).toBe(1);
    expect(queue.search.map((c) => c.sourceId)).toEqual([owed.id]);
  });

  it("a TRASHED record is still served — trash is indexed so it can be found and restored", async () => {
    const e = evidence({ team_id: team(), lifecycle_state: "TRASHED" });
    doc(e, ago(120));
    signal(e, ago(60));
    const result = await reconcileStaleSignalProjections({
      settledBefore: settledBefore(),
      limit: 200,
    });
    expect(result.reEnqueued).toBe(1);
  });

  it("respects the batch bound, oldest drift first", async () => {
    const rows = [40, 90, 60, 120, 30].map((m) => {
      const e = evidence({ team_id: team() });
      doc(e, ago(60 * 24));
      signal(e, ago(m));
      return { id: e.id, m };
    });
    const oldestFirst = [...rows].sort((a, b) => b.m - a.m).map((r) => r.id);

    const result = await reconcileStaleSignalProjections({
      settledBefore: settledBefore(),
      limit: 2,
    });
    expect(result).toMatchObject({ owed: 2, reEnqueued: 2 });
    expect(queue.search.map((c) => c.sourceId)).toEqual(oldestFirst.slice(0, 2));
  });

  it("a failed enqueue and a failed scan are reported, never thrown", async () => {
    const e = evidence({ team_id: team() });
    doc(e, ago(120));
    signal(e, ago(60));

    queue.mode = "unavailable";
    expect(
      await reconcileStaleSignalProjections({ settledBefore: settledBefore(), limit: 200 }),
    ).toEqual({ owed: 1, reEnqueued: 0, collapsed: 0, failed: 1 });

    db.fail = "signals";
    expect(
      await reconcileStaleSignalProjections({ settledBefore: settledBefore(), limit: 200 }),
    ).toEqual({ owed: 0, reEnqueued: 0, collapsed: 0, failed: 1 });
  });

  it("the emitted SQL carries every clause the policy depends on", async () => {
    await reconcileStaleSignalProjections({ settledBefore: settledBefore(), limit: 200 });
    const sql = db.sql.find((s) => s.includes('"media_intelligence_signals"'))!;
    expect(sql).toMatch(/FROM "media_intelligence_signals" s/);
    expect(sql).toMatch(/JOIN "evidence" e ON e\."id" = s\."evidence_id"/);
    expect(sql).toMatch(/JOIN "evidence_search_documents" d/);
    expect(sql).toMatch(/d\."document_type" = 'EVIDENCE'/);
    expect(sql).toMatch(/e\."team_id" IS NOT NULL/);
    expect(sql).toMatch(/NOT IN \('DESTROYED','PENDING_DESTRUCTION'\)/);
    expect(sql).toMatch(/d\."indexed_at_utc" < s\."updated_at_utc"/);
    expect(sql).toMatch(/GROUP BY s\."evidence_id"/);
    expect(sql).toMatch(/LIMIT \$3/);
  });
});

// ===========================================================================
// The scheduling hook
// ===========================================================================

describe("ET-Q-07 — both recoveries run inside the scheduled search-index tick", () => {
  it("runSearchIndexReconciler runs them and reports on its result", async () => {
    // `runSearchIndexReconciler` is what the worker's existing
    // `startSearchIndexReconcilerScheduler` interval (and its startup pass)
    // calls, so both recoveries are scheduled with no change to the bootstrap.
    const t = team();
    const e = evidence({ team_id: t });
    doc(e, ago(60 * 3));
    signal(e, ago(60));

    const result = await runSearchIndexReconciler({ trigger: "test" });
    expect(result.graph).toEqual({ owed: 1, reEnqueued: 1, collapsed: 0, failed: 0 });
    expect(result.signalProjection).toEqual({
      owed: 1,
      reEnqueued: 1,
      collapsed: 0,
      failed: 0,
    });
    expect(queue.graph.map((c) => c.teamId)).toEqual([t]);
    expect(queue.search.map((c) => c.sourceId)).toEqual([e.id]);
    // The search sweep itself is unaffected by them.
    expect(result.ok).toBe(true);
  });

  it("a recovery that cannot scan does not fail the search sweep", async () => {
    evidence({ team_id: team() });
    db.fail = "graph";
    const result = await runSearchIndexReconciler({ trigger: "test" });
    expect(result.graph.failed).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.workspacesFailed).toBe(0);
  });

  it("the module declares both jobs, so the registry can name it", () => {
    expect(RECOVERED_WORK_TYPES).toEqual([
      "REBUILD_SEARCH_DOCUMENT",
      "RECONCILE_TEAM_GRAPH",
      "REFRESH_GRAPH_SEARCH_PROJECTION",
      "SEARCH_INDEX_RECONCILER",
    ]);
    for (const job of [
      JOB_NAMES.RECONCILE_TEAM_GRAPH,
      JOB_NAMES.REFRESH_GRAPH_SEARCH_PROJECTION,
    ]) {
      expect(getWorkEntryOrThrow(job).reconciler).toBe(
        "services/worker/src/search-index-reconciler.ts",
      );
    }
  });
});
