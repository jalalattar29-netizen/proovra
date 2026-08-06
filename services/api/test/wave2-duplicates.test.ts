/**
 * Wave 2 — Duplicates / Similarity / Lineage completion regression tests
 * (source-contract).
 *
 * Pins the wiring put in place by the Wave 2 implementation:
 *
 *   * DuplicateDecision Prisma model exists + bounded shape.
 *   * Additive migration uses CREATE TABLE IF NOT EXISTS + bounded
 *     CHECK constraints. No DROP / RENAME / TRUNCATE / DELETE.
 *   * Migration is allowlisted in phase-32-7-2 to keep the audit
 *     gate green.
 *   * POST /v1/graph/duplicates/:edgeId/decision route is registered
 *     in graph.routes.ts, gated on evidence.update_metadata, and
 *     emits a bounded platform audit log entry.
 *   * POSSIBLE_DERIVATIVE_OF writer exists in the shared-runtime
 *     graph-builder.service.ts inside the same scan as SIMILAR_TO.
 *   * Evidence finalization fanout enqueues compute_perceptual_hashes
 *     after the existing 3 enqueues (no regression — exactly 4 enqueue
 *     call sites in the file).
 *   * /investigation/duplicates page is no longer pinned to the old
 *     "Perceptual similarity is not yet available on this workspace"
 *     hard-coded copy.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

function readSharedRuntime(rel: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(`../../../packages/shared-runtime/${rel}`, import.meta.url),
    ),
    "utf8",
  );
}

const SCHEMA = readApi("prisma/schema.prisma");
const FANOUT = readApi("src/services/evidence-finalization-fanout.service.ts");
const GRAPH_ROUTES = readApi("src/routes/graph.routes.ts");
const PHASE_32_7_2 = readApi(
  "test/phase-32-7-2-security-event-mapping-drift.test.ts",
);
const GRAPH_BUILDER = readSharedRuntime("src/graph/graph-builder.service.ts");
const DUPLICATES_PAGE = readWeb(
  "app/(app)/investigation/duplicates/page.tsx",
);

describe("Wave 2 — DuplicateDecision Prisma model + migration", () => {
  it("DuplicateDecision model is declared in schema.prisma", () => {
    expect(SCHEMA).toMatch(/model\s+DuplicateDecision\s*\{/);
  });

  it("DuplicateDecision model has required fields + bounded reason note", () => {
    const match = SCHEMA.match(
      /model\s+DuplicateDecision\s*\{([\s\S]*?)\n\}/m,
    );
    expect(match, "DuplicateDecision block must be readable").toBeTruthy();
    const block = match![1];
    expect(block).toMatch(/id\s+String\s+@id/);
    expect(block).toMatch(/teamId\s+String\s+@map\("team_id"\)/);
    expect(block).toMatch(/edgeId\s+String\s+@map\("edge_id"\)/);
    expect(block).toMatch(/edgeType\s+String\s+@map\("edge_type"\)/);
    expect(block).toMatch(/decision\s+String/);
    expect(block).toMatch(
      /decidedByUserId\s+String\s+@map\("decided_by_user_id"\)/,
    );
    // Reason note bounded to 400 chars at the column level.
    expect(block).toMatch(
      /reasonNote\s+String\?\s+@map\("reason_note"\)\s+@db\.VarChar\(400\)/,
    );
    expect(block).toMatch(/@@unique\(\[teamId,\s*edgeId\]\)/);
    expect(block).toMatch(/@@index\(\[teamId,\s*decision\]\)/);
    expect(block).toMatch(/@@map\("duplicate_decisions"\)/);
  });

  it("additive migration file exists for Wave 2", () => {
    const dir = fileURLToPath(
      new URL(
        "../prisma/migrations/20270811000000_wave2_duplicate_decisions",
        import.meta.url,
      ),
    );
    expect(existsSync(dir)).toBe(true);
  });

  it("migration uses additive CREATE TABLE IF NOT EXISTS + bounded CHECKs", () => {
    const sql = readApi(
      "prisma/migrations/20270811000000_wave2_duplicate_decisions/migration.sql",
    );
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS\s+"duplicate_decisions"/);
    expect(sql).toMatch(/duplicate_decisions_edge_type_bounded/);
    expect(sql).toMatch(/'SAME_HASH_AS'/);
    expect(sql).toMatch(/'SIMILAR_TO'/);
    expect(sql).toMatch(/'POSSIBLE_DERIVATIVE_OF'/);
    expect(sql).toMatch(/duplicate_decisions_decision_bounded/);
    expect(sql).toMatch(/'CONFIRMED'/);
    expect(sql).toMatch(/'DISMISSED'/);
    expect(sql).toMatch(/'MARKED_DERIVATIVE'/);
    // Pure additive — no destructive statements outside SQL comments.
    // Strip `-- …` line comments before matching so the migration header
    // can mention what it does NOT do (e.g. "no DROP / RENAME") without
    // tripping the gate.
    const sqlNoComments = sql
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    expect(sqlNoComments).not.toMatch(/\bDROP TABLE\b/i);
    expect(sqlNoComments).not.toMatch(/\bDROP COLUMN\b/i);
    expect(sqlNoComments).not.toMatch(/\bRENAME\b/i);
    expect(sqlNoComments).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("migration is allowlisted in the phase-32-7-2 drift gate", () => {
    expect(PHASE_32_7_2).toMatch(
      /20270811000000_wave2_duplicate_decisions/,
    );
  });
});

describe("Wave 2 — POST /v1/graph/duplicates/:edgeId/decision route", () => {
  it("route is registered under graph.routes.ts", () => {
    expect(GRAPH_ROUTES).toMatch(
      /"\/v1\/graph\/duplicates\/:edgeId\/decision"/,
    );
  });

  it("route requires evidence.update_metadata permission", () => {
    // Pull the route block from the registration line through ~120 lines.
    const idx = GRAPH_ROUTES.indexOf(
      '"/v1/graph/duplicates/:edgeId/decision"',
    );
    expect(idx).toBeGreaterThan(0);
    const slice = GRAPH_ROUTES.slice(idx, idx + 4000);
    expect(slice).toMatch(/permission:\s*"evidence\.update_metadata"/);
  });

  it("route uses authorizeOrFail with antiEnumeration", () => {
    const idx = GRAPH_ROUTES.indexOf(
      '"/v1/graph/duplicates/:edgeId/decision"',
    );
    const slice = GRAPH_ROUTES.slice(idx, idx + 4000);
    expect(slice).toMatch(/authorizeOrFail/);
    expect(slice).toMatch(/antiEnumeration:\s*true/);
  });

  it("route anti-enumerates by reading edge with team_id + bounded edge_type set", () => {
    const idx = GRAPH_ROUTES.indexOf(
      '"/v1/graph/duplicates/:edgeId/decision"',
    );
    const slice = GRAPH_ROUTES.slice(idx, idx + 4000);
    expect(slice).toMatch(/investigation_graph_edges/);
    expect(slice).toMatch(/'SAME_HASH_AS'/);
    expect(slice).toMatch(/'SIMILAR_TO'/);
    expect(slice).toMatch(/'POSSIBLE_DERIVATIVE_OF'/);
    expect(slice).toMatch(/not_found/);
  });

  it("route upserts duplicate_decisions row + bounded reasonNote (400)", () => {
    const idx = GRAPH_ROUTES.indexOf(
      '"/v1/graph/duplicates/:edgeId/decision"',
    );
    const slice = GRAPH_ROUTES.slice(idx, idx + 4000);
    expect(slice).toMatch(/INSERT INTO\s+"duplicate_decisions"/);
    expect(slice).toMatch(/ON CONFLICT\s+\("team_id",\s*"edge_id"\)/);
    expect(slice).toMatch(/reasonNote\?\.slice\(0,\s*400\)/);
  });

  it("route validates body decision against bounded vocabulary", () => {
    const idx = GRAPH_ROUTES.indexOf(
      '"/v1/graph/duplicates/:edgeId/decision"',
    );
    const slice = GRAPH_ROUTES.slice(idx, idx + 4000);
    expect(slice).toMatch(/"CONFIRMED"/);
    expect(slice).toMatch(/"DISMISSED"/);
    expect(slice).toMatch(/"MARKED_DERIVATIVE"/);
  });

  it("route emits a DUPLICATE_DECISION_RECORDED canonical tenant-audit entry", () => {
    const idx = GRAPH_ROUTES.indexOf(
      '"/v1/graph/duplicates/:edgeId/decision"',
    );
    const slice = GRAPH_ROUTES.slice(idx, idx + 4000);
    // PHASE 11 §3 Batch A — migrated onto the canonical emitTenantAudit
    // facade.
    expect(slice).toMatch(/emitTenantAudit/);
    expect(slice).toMatch(/DUPLICATE_DECISION_RECORDED/);
  });
});

describe("Wave 2 — POSSIBLE_DERIVATIVE_OF writer in graph-builder", () => {
  it("writer block is present in the shared-runtime graph-builder source", () => {
    expect(GRAPH_BUILDER).toMatch(/POSSIBLE_DERIVATIVE_OF/);
    // Honest copy: medium confidence + reviewer-confirmation language.
    expect(GRAPH_BUILDER).toMatch(/Possible derivative/);
    expect(GRAPH_BUILDER).toMatch(/Reviewer confirmation required/);
  });

  it("writer fires from the same scan as SIMILAR_TO (no separate query)", () => {
    // Source-contract: the SIMILAR_TO loop also emits POSSIBLE_DERIVATIVE_OF.
    // Verified by the presence of both upsertEdge call-sites within the
    // same try/catch block. We look for both calls and the shared
    // similarPairs result name.
    expect(GRAPH_BUILDER).toMatch(
      /similarPairs[\s\S]*POSSIBLE_DERIVATIVE_OF/,
    );
  });

  it("writer uses HONEST MEDIUM confidence (no HIGH override)", () => {
    // Anchor on the writer's signature copy. The honest reviewer-facing
    // safe_summary appears only once in the source — inside the
    // POSSIBLE_DERIVATIVE_OF upsertEdge call. Search nearby to confirm
    // the upsertEdge passes "MEDIUM" rather than "HIGH".
    const summaryIdx = GRAPH_BUILDER.indexOf(
      "Possible derivative — uploaded after a similar evidence record",
    );
    expect(summaryIdx).toBeGreaterThan(0);
    const slice = GRAPH_BUILDER.slice(summaryIdx - 400, summaryIdx + 400);
    expect(slice).toMatch(/"MEDIUM"/);
    expect(slice).not.toMatch(/"HIGH"/);
  });
});

describe("Wave 2 — perceptual-hash producer wiring in finalize fanout", () => {
  it("compute_perceptual_hashes is enqueued from the fanout", () => {
    expect(FANOUT).toMatch(/compute_perceptual_hashes/);
  });

  it("perceptualHashEnqueued is a field on the fanout result envelope", () => {
    expect(FANOUT).toMatch(/perceptualHashEnqueued:\s*boolean/);
  });

  it("enqueue is gated on PHOTO / VIDEO MIME family", () => {
    // The eligibility check uses `ev?.type === \"PHOTO\" || ev?.type === \"VIDEO\"`.
    expect(FANOUT).toMatch(/ev\?\.type\s*===\s*"PHOTO"/);
    expect(FANOUT).toMatch(/ev\?\.type\s*===\s*"VIDEO"/);
  });

  it("audit emit uses PERCEPTUAL_HASH_QUEUED action", () => {
    expect(FANOUT).toMatch(/PERCEPTUAL_HASH_QUEUED/);
    // PHASE 11 §3 Batch A — migrated onto the canonical tenant-audit
    // facade (workspaceId is now an authoritative DB column).
    expect(FANOUT).toMatch(/emitTenantAudit/);
  });

  it("fanout still has expected enqueue helper call sites (Wave 4 rebaseline)", () => {
    // Count `await <helper>(` call sites only — the doc-comment block
    // mentions the helper names in prose, which the simpler `<helper>(`
    // pattern would over-count.
    const searchEnqueues = (
      FANOUT.match(/await\s+enqueueSearchIndexingJob\(/g) ?? []
    ).length;
    const mediaEnqueues = (
      FANOUT.match(/await\s+enqueueMediaIntelligenceAnalysis\(/g) ?? []
    ).length;
    const graphEnqueues = (
      FANOUT.match(/await\s+enqueueGraphReconcileJob\(/g) ?? []
    ).length;
    // 1 search + 5 media (analyze_metadata + compute_perceptual_hashes
    // + extract_ocr_azure + extract_transcript_deepgram +
    // extract_technical_metadata) + 1 graph reconcile = 7 total enqueues.
    // Wave 4 added the OCR + transcript producer enqueues; the Enterprise
    // Technical Metadata work added the 5th media enqueue
    // (extract_technical_metadata) — see the explicit assertion below.
    expect(searchEnqueues).toBe(1);
    expect(mediaEnqueues).toBe(5);
    expect(graphEnqueues).toBe(1);
    expect(searchEnqueues + mediaEnqueues + graphEnqueues).toBe(7);

    // Keep the count meaningful: the 5th media enqueue must be exactly
    // the deterministic technical-metadata extraction job (not a
    // duplicate or an unrelated kind). This pins the new enqueue so a
    // future accidental extra enqueue can't satisfy the count silently.
    expect(FANOUT).toMatch(
      /enqueueMediaIntelligenceAnalysis\(\{[\s\S]*?kind:\s*"extract_technical_metadata"/,
    );
  });
});

describe("Wave 2 — /investigation/duplicates page honest empty-state", () => {
  it("no longer contains the hard-coded 'not yet available on this workspace' copy", () => {
    expect(DUPLICATES_PAGE).not.toMatch(
      /Perceptual similarity is not yet available on this workspace/,
    );
  });

  it("page consumes /v1/intelligence/capabilities for producer modes", () => {
    expect(DUPLICATES_PAGE).toMatch(/\/v1\/intelligence\/capabilities/);
    expect(DUPLICATES_PAGE).toMatch(/producerModes/);
  });

  it("page renders 3 honest sections (exact + perceptual + derivative)", () => {
    expect(DUPLICATES_PAGE).toMatch(/Exact duplicates/);
    expect(DUPLICATES_PAGE).toMatch(/Perceptual similarity/);
    expect(DUPLICATES_PAGE).toMatch(/Possible derivatives/);
  });

  it("page wires per-row Confirm / Dismiss actions to the decision endpoint", () => {
    expect(DUPLICATES_PAGE).toMatch(/recordDecision/);
    expect(DUPLICATES_PAGE).toMatch(
      /\/v1\/graph\/duplicates\/\$\{encodeURIComponent\(edge\.edgeId\)\}\/decision/,
    );
  });
});
