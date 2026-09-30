/**
 * GRAPH TOMBSTONE SWEEPS — against a real PostgreSQL 16 (PA-02).
 *
 * `reconcileTeamGraph` marks a node stale when the row it stands for is gone.
 * Every one of those sweeps compared `investigation_graph_nodes.external_id`,
 * a UUID column, with a TEXT expression (`src."id"::text = n."external_id"`),
 * which PostgreSQL rejects: `operator does not exist: text = uuid`. Each
 * statement sat in `try { … } catch { /* best-effort *\/ }`, so nothing was
 * ever tombstoned and nothing ever said so. REPORT and VERIFICATION_PACKAGE
 * nodes were worse off: their external id was `<evidence id>:v<version>`,
 * which is not a UUID, so the node INSERT itself failed (also swallowed) and
 * those two families never existed in the graph at all.
 *
 * Mocks cannot see any of this — the defect is a PostgreSQL type rule — so
 * this suite runs the real function against the real schema.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type NodeRow = { node_kind: string; external_id: string; team_id: string; stale_at_utc: Date | null; updated_at_utc: Date };

describe("graph tombstone sweeps (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let graph: typeof import("@proovra/shared-runtime");

  const ids = {
    evidence: randomUUID(),
    caseKept: randomUUID(),
    caseDeleted: randomUUID(),
    caseB: randomUUID(),
    signalKept: randomUUID(),
    signalDismissed: randomUUID(),
    ocrDeleted: randomUUID(),
    transcriptKept: randomUUID(),
    report: randomUUID(),
  };

  const nodes = async (teamId: string): Promise<NodeRow[]> =>
    (await prisma.$queryRawUnsafe(
      `SELECT "node_kind", "external_id"::text AS external_id, "team_id"::text AS team_id, "stale_at_utc", "updated_at_utc"
         FROM "investigation_graph_nodes" WHERE "team_id" = $1::uuid`,
      teamId,
    )) as NodeRow[];
  const node = (rows: NodeRow[], kind: string, externalId: string) =>
    rows.find((r) => r.node_kind === kind && r.external_id === externalId);

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    graph = await import("@proovra/shared-runtime");
    graph.registerPrisma(prisma as never);

    const A = h.fixtures.teamA;
    const B = h.fixtures.teamB;
    const teamRow = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    await prisma.evidence.create({
      data: {
        id: ids.evidence,
        title: "tombstone fixture",
        type: "PHOTO",
        status: "SIGNED",
        ownerUserId: A.ownerUserId,
        teamId: A.teamId,
        organizationId: teamRow.organizationId,
        fingerprintCanonicalJson: "{}",
      } as never,
    });
    await prisma.case.createMany({
      data: [
        { id: ids.caseKept, name: "kept", ownerUserId: A.ownerUserId, teamId: A.teamId },
        { id: ids.caseDeleted, name: "to delete", ownerUserId: A.ownerUserId, teamId: A.teamId },
        { id: ids.caseB, name: "other tenant", ownerUserId: B.ownerUserId, teamId: B.teamId },
      ] as never,
    });
    // The record is in the kept case — through the canonical link table.
    await prisma.caseEvidenceLink.create({
      data: { teamId: A.teamId, caseId: ids.caseKept, evidenceId: ids.evidence } as never,
    });
    const signal = (id: string, signalType: string) => ({
      id,
      teamId: A.teamId,
      evidenceId: ids.evidence,
      signalType,
      safeSummary: `fixture ${signalType}`,
    });
    await prisma.mediaIntelligenceSignal.createMany({
      data: [
        signal(ids.signalKept, "EXIF_MISSING"),
        signal(ids.signalDismissed, "EXIF_TIMESTAMP_MISMATCH"),
        signal(ids.ocrDeleted, "OCR_AVAILABLE"),
        signal(ids.transcriptKept, "TRANSCRIPT_AVAILABLE"),
      ],
    });
    await prisma.report.create({
      data: {
        id: ids.report,
        evidenceId: ids.evidence,
        version: 1,
        storageBucket: "fixture",
        storageKey: `reports/${ids.evidence}/v1.pdf`,
        generatedAtUtc: new Date(),
      } as never,
    });
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  it("an active source materialises its node — including REPORT, which never existed before", async () => {
    const A = h.fixtures.teamA;
    const result = await graph.reconcileTeamGraph(A.teamId, prisma as never);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);

    const rows = await nodes(A.teamId);
    for (const [kind, id] of [
      ["EVIDENCE", ids.evidence],
      ["CASE", ids.caseKept],
      ["CASE", ids.caseDeleted],
      ["MEDIA_INTELLIGENCE_SIGNAL", ids.signalKept],
      ["MEDIA_INTELLIGENCE_SIGNAL", ids.signalDismissed],
      ["OCR", ids.ocrDeleted],
      ["TRANSCRIPT", ids.transcriptKept],
      // UUID-backed now: the report row's own id. The old `<evidence>:v<n>`
      // text id could not be stored in a UUID column.
      ["REPORT", ids.report],
    ] as const) {
      const n = node(rows, kind, id);
      expect(n, `${kind} ${id} was not materialised`).toBeDefined();
      expect(n!.stale_at_utc, `${kind} is stale while its source exists`).toBeNull();
    }
    // The other tenant's case is not in this tenant's graph.
    expect(node(rows, "CASE", ids.caseB)).toBeUndefined();

    // Edges that a swallowed failure had been hiding: BELONGS_TO_CASE read a
    // dropped column (evidence.case_id), and GENERATED_REPORT needed a REPORT
    // node that could not be stored.
    const edges = (await prisma.$queryRawUnsafe(
      `SELECT e."edge_type", s."external_id"::text AS source, t."external_id"::text AS target
         FROM "investigation_graph_edges" e
         JOIN "investigation_graph_nodes" s ON s."id" = e."source_node_id"
         JOIN "investigation_graph_nodes" t ON t."id" = e."target_node_id"
        WHERE e."team_id" = $1::uuid AND e."stale_at_utc" IS NULL`,
      A.teamId,
    )) as Array<{ edge_type: string; source: string; target: string }>;
    expect(edges).toContainEqual({ edge_type: "BELONGS_TO_CASE", source: ids.evidence, target: ids.caseKept });
    expect(edges).toContainEqual({ edge_type: "GENERATED_REPORT", source: ids.evidence, target: ids.report });
  });

  it("a deleted or dismissed source tombstones its node; an active one keeps it; another tenant is untouched", async () => {
    const A = h.fixtures.teamA;
    const B = h.fixtures.teamB;

    // Team B's graph holds a node for B's own case, and a DANGLING node whose
    // external id is a case that exists — in team A.
    await graph.reconcileTeamGraph(B.teamId, prisma as never);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "investigation_graph_nodes" ("team_id", "node_kind", "external_id", "safe_label", "visibility_scope")
       VALUES ($1::uuid, 'CASE', $2::uuid, 'dangling in B', 'WORKSPACE_INTERNAL')`,
      B.teamId,
      ids.caseKept,
    );
    // And team A holds a node whose external id is a case that exists only in
    // team B: a source row in ANOTHER tenant must not keep it alive.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "investigation_graph_nodes" ("team_id", "node_kind", "external_id", "safe_label", "visibility_scope")
       VALUES ($1::uuid, 'CASE', $2::uuid, 'dangling in A', 'WORKSPACE_INTERNAL')`,
      A.teamId,
      ids.caseB,
    );
    const bBefore = await nodes(B.teamId);

    await prisma.case.delete({ where: { id: ids.caseDeleted } });
    await prisma.mediaIntelligenceSignal.update({ where: { id: ids.signalDismissed }, data: { status: "DISMISSED" } });
    await prisma.mediaIntelligenceSignal.delete({ where: { id: ids.ocrDeleted } });
    await prisma.report.delete({ where: { id: ids.report } });

    const result = await graph.reconcileTeamGraph(A.teamId, prisma as never);
    expect(result.failures).toEqual([]);
    expect(result.nodesTombstoned).toBe(5);

    const rows = await nodes(A.teamId);
    const stale = (kind: string, id: string) => node(rows, kind, id)!.stale_at_utc !== null;
    // Tombstoned.
    expect(stale("CASE", ids.caseDeleted)).toBe(true);
    expect(stale("MEDIA_INTELLIGENCE_SIGNAL", ids.signalDismissed)).toBe(true);
    expect(stale("OCR", ids.ocrDeleted)).toBe(true);
    expect(stale("REPORT", ids.report)).toBe(true);
    expect(stale("CASE", ids.caseB), "a case that exists only in another tenant kept this node alive").toBe(true);
    // Kept.
    expect(stale("CASE", ids.caseKept)).toBe(false);
    expect(stale("MEDIA_INTELLIGENCE_SIGNAL", ids.signalKept)).toBe(false);
    expect(stale("TRANSCRIPT", ids.transcriptKept)).toBe(false);
    expect(stale("EVIDENCE", ids.evidence)).toBe(false);

    // Team B: reconciling A changed nothing there, row for row.
    expect(await nodes(B.teamId)).toEqual(bBefore);
  });

  it("running again is a no-op: nothing new is tombstoned and no tombstone is re-stamped", async () => {
    const A = h.fixtures.teamA;
    const before = (await nodes(A.teamId)).filter((r) => r.stale_at_utc !== null);
    const result = await graph.reconcileTeamGraph(A.teamId, prisma as never);
    expect(result.failures).toEqual([]);
    expect(result.nodesTombstoned).toBe(0);
    const after = (await nodes(A.teamId)).filter((r) => r.stale_at_utc !== null);
    const key = (r: NodeRow) => `${r.node_kind}:${r.external_id}:${r.stale_at_utc!.toISOString()}:${r.updated_at_utc.toISOString()}`;
    expect(after.map(key).sort()).toEqual(before.map(key).sort());
  });

  it("the dangling node in team B is tombstoned by B's own reconcile, and only then", async () => {
    const B = h.fixtures.teamB;
    const before = node(await nodes(B.teamId), "CASE", ids.caseKept)!;
    expect(before.stale_at_utc).toBeNull();
    const result = await graph.reconcileTeamGraph(B.teamId, prisma as never);
    expect(result.failures).toEqual([]);
    const rows = await nodes(B.teamId);
    expect(node(rows, "CASE", ids.caseKept)!.stale_at_utc).not.toBeNull();
    expect(node(rows, "CASE", ids.caseB)!.stale_at_utc).toBeNull();
  });

  it("one family's sweep failing is reported with its code and does not stop the others", async () => {
    const A = h.fixtures.teamA;
    // A fresh stale candidate in a family that will NOT fail…
    const orphanCase = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "investigation_graph_nodes" ("team_id", "node_kind", "external_id", "safe_label", "visibility_scope")
       VALUES ($1::uuid, 'CASE', $2::uuid, 'orphan', 'WORKSPACE_INTERNAL')`,
      A.teamId,
      orphanCase,
    );
    // …and a client whose INCIDENT sweep is refused by the database.
    const failing = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === "$executeRawUnsafe") {
          return (sql: string, ...args: unknown[]) => {
            if (/UPDATE "investigation_graph_nodes"/.test(sql) && /'INCIDENT'/.test(sql)) {
              return Promise.reject(Object.assign(new Error("permission denied for table operational_incidents"), { code: "42501" }));
            }
            return (target.$executeRawUnsafe as (s: string, ...a: unknown[]) => Promise<number>)(sql, ...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const metrics = await import("../src/services/ops/metrics.service.js");
    const before = metrics.readCounter("graph_tombstone_sweep_failed_total");
    const result = await graph.reconcileTeamGraph(A.teamId, failing as never);

    expect(result.failures).toEqual([{ stage: "tombstone:INCIDENT", code: "42501" }]);
    // The reconcile says it is not whole…
    expect(result.ok).toBe(false);
    // …the failure is counted…
    expect(metrics.readCounter("graph_tombstone_sweep_failed_total")).toBe(before + 1);
    // …and the family after it still ran.
    expect(node(await nodes(A.teamId), "CASE", orphanCase)!.stale_at_utc).not.toBeNull();
  });

  it("every tombstone statement compares like with like (no ::text against the UUID external id)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(new URL("../../../packages/shared-runtime/src/graph/graph-builder.service.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/::text\s*=\s*n\."external_id"/);
    expect(src).not.toMatch(/n\."external_id"\s*=\s*[^\n]*::text/);
    expect(src).not.toMatch(/\$\{[^}]*evidence_id\}:v\$\{/);
    // No bare swallow is left in the file.
    expect(src).not.toMatch(/catch\s*\{\s*\/\*\s*best-effort[^*]*\*\/\s*\}/);
  });
});
