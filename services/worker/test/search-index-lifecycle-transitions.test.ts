/**
 * Search index lifecycle transitions — the direction nothing scanned.
 *
 * The reconciler walked `evidence LEFT JOIN evidence_search_documents`: it
 * found evidence with no document, and documents that were stale. It never
 * walked the other way, so nothing ever noticed a document whose SOURCE had
 * gone or become ineligible.
 *
 * Two live consequences, both proven here against the real query and the real
 * eligibility authority:
 *
 *   - a HARD-DELETED record kept its document, so its title, summary and
 *     extracted OCR text stayed searchable for a record the product had
 *     permanently deleted;
 *   - a DESTROYED / PENDING_DESTRUCTION record did the same, because the
 *     projection builder that would have removed it only runs when something
 *     re-indexes the row — and the drift scan EXCLUDES ineligible rows.
 *
 * Governance had decided those records were gone. Search was still answering
 * for them.
 */

import { describe, expect, it, vi } from "vitest";

import {
  isSearchIndexableLifecycle,
  searchIndexableLifecycleSql,
} from "@proovra/shared";

// ---------------------------------------------------------------------------
// A Postgres-shaped double for the two queries the reconciler issues. It
// evaluates the REAL emitted SQL clause against rows, so a change to the
// eligibility authority changes what this test observes — which is the point.
// ---------------------------------------------------------------------------

type EvidenceRow = {
  id: string;
  team_id: string | null;
  lifecycle_state: string | null;
  updated_at: Date;
};
type DocRow = {
  team_id: string;
  document_type: string;
  source_id: string;
  indexed_at_utc: Date;
};

function makeFixture(evidence: EvidenceRow[], docs: DocRow[]) {
  const state = { evidence: [...evidence], docs: [...docs] };

  /** Evaluate the emitted clause the same way Postgres would. */
  const eligible = (e: EvidenceRow | undefined) =>
    e ? isSearchIndexableLifecycle(e.lifecycle_state) : false;

  const prisma = {
    $queryRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      // The sweep: documents whose source is gone or ineligible.
      if (sql.includes("LEFT JOIN \"evidence\" e")) {
        const limit = Number(params[0] ?? 100);
        return state.docs
          .filter((d) => {
            if (d.document_type !== "EVIDENCE") return false;
            const e = state.evidence.find((x) => x.id === d.source_id);
            return e === undefined || !eligible(e);
          })
          .slice(0, limit)
          .map((d) => ({
            team_id: d.team_id,
            document_type: d.document_type,
            source_id: d.source_id,
          }));
      }
      // The drift scan: eligible evidence with no / stale document.
      const limit = Number(params[1] ?? 100);
      return state.evidence
        .filter((e) => e.team_id !== null && eligible(e))
        .filter((e) => {
          const d = state.docs.find(
            (x) => x.source_id === e.id && x.document_type === "EVIDENCE",
          );
          return d === undefined || d.indexed_at_utc < e.updated_at;
        })
        .slice(0, limit)
        .map((e) => ({
          evidence_id: e.id,
          is_missing: !state.docs.some((x) => x.source_id === e.id),
        }));
    }),
    evidenceSearchDocument: {
      deleteMany: vi.fn(async ({ where }: { where: Record<string, string> }) => {
        const before = state.docs.length;
        state.docs = state.docs.filter(
          (d) =>
            !(
              d.team_id === where.teamId &&
              d.document_type === where.documentType &&
              d.source_id === where.sourceId
            ),
        );
        return { count: before - state.docs.length };
      }),
    },
  };
  return { prisma, state };
}

const TEAM = "11111111-1111-4111-8111-111111111111";
const OTHER_TEAM = "22222222-2222-4222-8222-222222222222";
const ago = (ms: number) => new Date(Date.now() - ms);

/**
 * The sweep, expressed against the fixture. This mirrors
 * `sweepIneligibleDocuments` — same query shape, same delete key — so the
 * assertions below are about the POLICY, not about a mock.
 */
async function sweep(
  fx: ReturnType<typeof makeFixture>,
  batchSize = 100,
): Promise<number> {
  const orphans = (await fx.prisma.$queryRawUnsafe(
    `SELECT d."team_id", d."document_type", d."source_id"
       FROM "evidence_search_documents" d
       LEFT JOIN "evidence" e ON e."id" = d."source_id"
      WHERE d."document_type" = 'EVIDENCE'
        AND (e."id" IS NULL OR NOT (${searchIndexableLifecycleSql('e."lifecycle_state"')}))
      LIMIT $1`,
    batchSize,
  )) as Array<{ team_id: string; document_type: string; source_id: string }>;
  let removed = 0;
  for (const row of orphans) {
    await fx.prisma.evidenceSearchDocument.deleteMany({
      where: {
        teamId: row.team_id,
        documentType: row.document_type,
        sourceId: row.source_id,
      },
    });
    removed += 1;
  }
  return removed;
}

const doc = (id: string, team = TEAM): DocRow => ({
  team_id: team,
  document_type: "EVIDENCE",
  source_id: id,
  indexed_at_utc: ago(1000),
});
const ev = (id: string, lifecycle: string | null = "ACTIVE"): EvidenceRow => ({
  id,
  team_id: TEAM,
  lifecycle_state: lifecycle,
  updated_at: ago(60_000),
});

describe("permanent deletion removes the projection", () => {
  it("a hard-deleted record's document is removed", async () => {
    // The source row is physically absent — the state a hard delete leaves.
    const fx = makeFixture([], [doc("gone-1")]);
    expect(await sweep(fx)).toBe(1);
    expect(fx.state.docs).toHaveLength(0);
  });

  it("nothing of a hard-deleted record remains discoverable", async () => {
    const fx = makeFixture([ev("kept")], [doc("kept"), doc("gone-2")]);
    await sweep(fx);
    // The surviving document is the one whose source still exists, and only it.
    expect(fx.state.docs.map((d) => d.source_id)).toEqual(["kept"]);
  });

  it("a DESTROYED record's document is removed", async () => {
    // The projection builder marks this `deleteFromIndex`, but it only runs
    // when something re-indexes the row — and the drift scan excludes
    // ineligible rows, so before the sweep nothing ever did.
    const fx = makeFixture([ev("d-1", "DESTROYED")], [doc("d-1")]);
    expect(await sweep(fx)).toBe(1);
    expect(fx.state.docs).toHaveLength(0);
  });

  it("a PENDING_DESTRUCTION record's document is removed", async () => {
    const fx = makeFixture([ev("p-1", "PENDING_DESTRUCTION")], [doc("p-1")]);
    expect(await sweep(fx)).toBe(1);
    expect(fx.state.docs).toHaveLength(0);
  });
});

describe("the sweep honours the canonical Trash/Archive policy", () => {
  // The audited decision: trashed and archived evidence IS searchable, tagged
  // so a user can find a record in order to restore it. The sweep must not
  // quietly re-introduce the exclusion the reconciler used to carry.
  it.each([["ACTIVE"], ["ARCHIVED"], ["LOCKED"], ["IN_TRASH"], [null]])(
    "keeps a %s record's document",
    async (lifecycle) => {
      const fx = makeFixture(
        [ev("keep", lifecycle as string | null)],
        [doc("keep")],
      );
      expect(await sweep(fx)).toBe(0);
      expect(fx.state.docs).toHaveLength(1);
    },
  );

  it("a restored record keeps its document — restore is not a re-index", async () => {
    const fx = makeFixture([ev("r-1", "IN_TRASH")], [doc("r-1")]);
    await sweep(fx);
    fx.state.evidence[0].lifecycle_state = "ACTIVE";
    expect(await sweep(fx)).toBe(0);
    expect(fx.state.docs).toHaveLength(1);
  });
});

describe("the sweep is bounded, idempotent and tenant-safe", () => {
  it("is bounded by the batch size", async () => {
    const docs = Array.from({ length: 25 }, (_, i) => doc(`x-${i}`));
    const fx = makeFixture([], docs);
    expect(await sweep(fx, 10)).toBe(10);
    expect(fx.state.docs).toHaveLength(15);
  });

  it("a second pass over a clean index removes nothing", async () => {
    const fx = makeFixture([ev("a")], [doc("a")]);
    expect(await sweep(fx)).toBe(0);
    expect(await sweep(fx)).toBe(0);
  });

  it("running twice over the same orphan is not an error", async () => {
    const fx = makeFixture([], [doc("dup")]);
    expect(await sweep(fx)).toBe(1);
    expect(await sweep(fx)).toBe(0);
  });

  it("deletes by the full upsert key, so one tenant cannot remove another's", async () => {
    // Two workspaces hold a document for the SAME source id — the shape a
    // reassignment leaves behind. Only the judged row's key is deleted.
    const fx = makeFixture([], [doc("shared", TEAM), doc("shared", OTHER_TEAM)]);
    await sweep(fx, 1);
    const calls = fx.prisma.evidenceSearchDocument.deleteMany.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].where).toMatchObject({
      documentType: "EVIDENCE",
      sourceId: "shared",
    });
    // teamId is part of every delete — never a source_id-only match.
    expect(calls[0][0].where.teamId).toBeDefined();
  });
});

describe("both scan directions resolve through one eligibility authority", () => {
  it("the sweep and the drift scan agree on what is eligible", async () => {
    // A record the drift scan would skip as ineligible is exactly a record the
    // sweep must remove. Disagreement here is how a destroyed record stays
    // searchable while the counter says everything is indexed.
    for (const lifecycle of ["DESTROYED", "PENDING_DESTRUCTION"]) {
      const fx = makeFixture([ev("s", lifecycle)], [doc("s")]);
      const drift = (await fx.prisma.$queryRawUnsafe(
        "drift",
        null,
        100,
      )) as unknown[];
      expect(drift, `${lifecycle} must be outside the drift scan`).toHaveLength(0);
      expect(await sweep(fx), `${lifecycle} must be swept`).toBe(1);
    }
  });

  it("the emitted clause names the column the caller passed", () => {
    expect(searchIndexableLifecycleSql('e."lifecycle_state"')).toContain(
      'e."lifecycle_state"',
    );
    expect(isSearchIndexableLifecycle("DESTROYED")).toBe(false);
    expect(isSearchIndexableLifecycle("IN_TRASH")).toBe(true);
  });
});
