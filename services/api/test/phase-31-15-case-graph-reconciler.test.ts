/**
 * Phase 31.15 / 32.14 — CASE graph domain reconciler + Investigation
 * Timeline UI source-contract tests.
 *
 * The CASE domain is the FIRST end-to-end reconciler integration
 * for the investigation graph. The same pattern lands for the
 * remaining 10 domains (INCIDENT / REVIEW_TASK / etc.) in
 * subsequent sessions.
 *
 * Layers covered:
 *
 *   1. Catalog: CASE node kind + BELONGS_TO_CASE edge type are
 *      registered + DB CHECK constraints accept them.
 *   2. Reconciler service: SELECTs cases for the team, upserts a
 *      CASE node per row, stale-sweeps removed cases, materializes
 *      BELONGS_TO_CASE edges for evidence with non-null caseId,
 *      never throws, bounded label length, team-anchored.
 *   3. Anti-enumeration: every SQL binds team_id = $1.
 *   4. Anti-leak: no storage internals, no private notes, no
 *      forbidden vocabulary.
 *   5. Stale tombstoning: deleted cases (not in `cases` table) get
 *      their CASE node tombstoned; dangling edges cascade-stale
 *      via the existing edge-stale sweep.
 *   6. Investigation Timeline UI: client component, only consumes
 *      the existing /v1/graph/timeline + /v1/users/me, no fake
 *      counters, no forbidden vocabulary, no storage internals,
 *      bounded polling, advisory disclaimer.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  GRAPH_EDGE_TYPES,
  GRAPH_NODE_KINDS,
} from "../src/services/graph/graph-catalog.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — Catalog
// =============================================================================

describe("Phase 31.15 — CASE catalog membership", () => {
  it("CASE is a registered graph node kind", () => {
    expect(GRAPH_NODE_KINDS).toContain("CASE");
  });

  it("BELONGS_TO_CASE is a registered edge type", () => {
    expect(GRAPH_EDGE_TYPES).toContain("BELONGS_TO_CASE");
  });

  it("schema-validation registers investigation_graph_nodes/edges", () => {
    const src = readSource("../src/runtime/schema-validation.ts");
    expect(src).toContain('name: "investigation_graph_nodes"');
    expect(src).toContain('name: "investigation_graph_edges"');
  });
});

// =============================================================================
// PART 2 — Reconciler source contract
// =============================================================================

describe("Phase 31.15 — CASE reconciler source contract", () => {
  const src = readSource(
    "../src/services/graph/graph-builder.service.ts",
  );

  it("inserts the CASE step between EVIDENCE upserts and MEDIA_SIGNAL step", () => {
    const idxEv = src.indexOf("// 1. Materialize EVIDENCE nodes");
    const idxCase = src.indexOf("// 1b. Phase 31.15 — CASE domain reconciliation");
    const idxMedia = src.indexOf("// 2. Materialize MEDIA_SIGNAL nodes");
    expect(idxEv).toBeGreaterThan(0);
    expect(idxCase).toBeGreaterThan(idxEv);
    expect(idxMedia).toBeGreaterThan(idxCase);
  });

  it("SELECT on cases is team-anchored", () => {
    expect(src).toMatch(
      /SELECT "id", "name"[\s\S]*?FROM "cases"[\s\S]*?WHERE "team_id" = \$1/,
    );
  });

  it("upserts a CASE node per row with bounded label (<=240 chars)", () => {
    const block = src.match(
      /Phase 31\.15 — CASE domain reconciliation[\s\S]*?the rest of the reconcile continues/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block!).toMatch(/upsertNode\(\s*client,\s*teamId,\s*"CASE"/);
    expect(block!).toMatch(/\.slice\(0,\s*240\)/);
  });

  it("CASE node visibility scope is WORKSPACE_INTERNAL", () => {
    const block = src.match(
      /Phase 31\.15 — CASE domain reconciliation[\s\S]*?the rest of the reconcile continues/,
    )?.[0];
    expect(block!).toMatch(
      /upsertNode\([\s\S]*?"CASE"[\s\S]*?"WORKSPACE_INTERNAL"/,
    );
  });

  it("stale-tombstones CASE nodes whose external_id is gone from `cases`", () => {
    const block = src.match(
      /Phase 31\.15 — CASE domain reconciliation[\s\S]*?the rest of the reconcile continues/,
    )?.[0];
    expect(block!).toMatch(
      /UPDATE "investigation_graph_nodes" n[\s\S]*?SET "stale_at_utc" = NOW\(\)[\s\S]*?n\."node_kind" = 'CASE'[\s\S]*?NOT EXISTS[\s\S]*?FROM "cases" c/,
    );
  });

  it("stale sweep is team-anchored on BOTH the nodes table and the cases sub-select", () => {
    const block = src.match(
      /UPDATE "investigation_graph_nodes" n[\s\S]*?NOT EXISTS[\s\S]*?\)/,
    )?.[0];
    expect(block).toBeTruthy();
    // Outer UPDATE team binding.
    expect(block!).toMatch(/n\."team_id" = \$1/);
    // Inner cases sub-select team binding.
    expect(block!).toMatch(/c\."team_id" = \$1/);
  });

  it("BELONGS_TO_CASE edges emitted only for evidence with non-null caseId", () => {
    // The evidence SELECT is unique to this step (it's the only
    // SELECT pulling `case_id` in the reconciler). Match on the
    // raw source rather than a captured block — the inner stale-
    // sweep try/catch makes block-capture brittle.
    expect(src).toMatch(
      /SELECT "id", "case_id"[\s\S]*?FROM "evidence"[\s\S]*?WHERE "team_id" = \$1[\s\S]*?AND "case_id" IS NOT NULL[\s\S]*?AND "deleted_at" IS NULL/,
    );
  });

  it("BELONGS_TO_CASE edges are SYSTEM source, HIGH confidence", () => {
    expect(src).toMatch(
      /upsertEdge\([\s\S]*?"BELONGS_TO_CASE"[\s\S]*?"SYSTEM"[\s\S]*?"HIGH"/,
    );
  });

  it("orphan-evidence guard: edge only emitted when CASE was in this reconcile pass", () => {
    expect(src).toMatch(/if \(!seenCaseIds\.has\(ev\.case_id\)\) continue/);
  });

  it("entire CASE step wrapped in try/catch — best-effort, never blocks the rest of reconcile", () => {
    const block = src.match(
      /Phase 31\.15 — CASE domain reconciliation[\s\S]*?\}\s*catch\s*\{[\s\S]*?the rest of the reconcile continues[\s\S]*?\}/,
    )?.[0];
    expect(block).toBeTruthy();
  });
});

// =============================================================================
// PART 3 — Anti-leak source invariants on the CASE reconciler step
// =============================================================================

describe("Phase 31.15 — CASE reconciler anti-leak", () => {
  const src = readSource(
    "../src/services/graph/graph-builder.service.ts",
  );

  it("CASE step does NOT touch storage internals / signed URLs / private notes", () => {
    const block = src.match(
      /Phase 31\.15 — CASE domain reconciliation[\s\S]*?\}\s*catch\s*\{/,
    )?.[0];
    expect(block).toBeTruthy();
    const noComments = block!
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storage_bucket",
      "storageBucket",
      "storage_key",
      "storageKey",
      "signedUrl",
      "signed_url",
      "presignedUrl",
      "private_note",
      "privateNote",
      "legalNote",
      "legalNoteBody",
      "raw_gps",
      "rawGps",
    ]) {
      expect(noComments, `CASE step leaks ${banned}`).not.toContain(banned);
    }
  });

  it("safe summary on the BELONGS_TO_CASE edge uses no forbidden vocabulary", () => {
    const block = src.match(
      /Phase 31\.15 — CASE domain reconciliation[\s\S]*?\}\s*catch\s*\{/,
    )?.[0];
    const literals = block!.match(/"[^"\n]+"/g) ?? [];
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    for (const lit of literals) {
      expect(lit, `forbidden wording: ${lit}`).not.toMatch(forbidden);
    }
  });

  it("CASE node label is bounded — no full Case object spread into the node", () => {
    const block = src.match(
      /Phase 31\.15 — CASE domain reconciliation[\s\S]*?the rest of the reconcile continues/,
    )?.[0];
    // Defence in depth: we must not select all columns from cases.
    // Only `id`, `name` go into the projection.
    const selectMatch = block!.match(/SELECT "id", "name"\s+FROM "cases"/);
    expect(selectMatch).toBeTruthy();
  });
});

// =============================================================================
// PART 4 — Investigation Timeline UI source contract
// =============================================================================

describe("Phase 32.14 — Investigation Timeline UI", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/investigation/timeline/page.tsx",
  );

  it("declared as a client component", () => {
    expect(src.trimStart()).toMatch(/^"use client"/);
  });

  it("only calls whitelisted endpoints", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const apiFetchCalls =
      noComments.match(/apiFetch\(\s*[`"][^`"]+[`"]/g) ?? [];
    expect(apiFetchCalls.length).toBeGreaterThan(0);
    const allowed = ["/v1/users/me", "/v1/graph/timeline"];
    for (const call of apiFetchCalls) {
      const path = call.match(/[`"]([^`"]+)[`"]/)?.[1] ?? "";
      const ok = allowed.some((p) => path.includes(p));
      expect(ok, `unexpected endpoint: ${path}`).toBe(true);
    }
  });

  it("no forbidden truth-claim vocabulary in user-facing literals", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const literals = noComments.match(/"[^"\n]+"/g) ?? [];
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    for (const lit of literals) {
      expect(lit, `timeline UI uses forbidden wording: ${lit}`).not.toMatch(
        forbidden,
      );
    }
  });

  it("no storage internals / signed URLs in any UI literal", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storageKey",
      "storage_key",
      "storageBucket",
      "storage_bucket",
      "signedUrl",
      "signed_url",
      "presignedUrl",
      "multipartUploadId",
    ]) {
      expect(noComments, `timeline UI leaks ${banned}`).not.toContain(banned);
    }
  });

  it("bounded polling — paused when tab hidden", () => {
    expect(src).toMatch(/document\.hidden/);
  });

  it("filter UI for event kind is present (operator can refine the stream)", () => {
    expect(src).toMatch(/NODE_CREATED/);
    expect(src).toMatch(/EDGE_CREATED/);
    expect(src).toMatch(/MEDIA_SIGNAL_CREATED|MEDIA_RUN_/);
  });

  it("safer canonical-custody disclaimer (no 'authenticity' even in negation)", () => {
    const flat = src.replace(/\s+/g, " ");
    expect(flat).toMatch(/canonical custody record/);
    expect(src).not.toMatch(/authenticity or admissibility/);
  });

  it("empty state has next-action guidance (not a dead-end UI)", () => {
    const flat = src.replace(/\s+/g, " ");
    expect(flat).toMatch(/No events recorded[\s\S]*?(graph reconcile|reconcile|analyzer)/i);
  });
});
