/**
 * Wave 1 — Investigation graph taxonomy completion regression tests.
 *
 * Pins:
 *   * All 5 renamed canonical kinds exist in catalog.
 *   * All 5 new deferred node kinds exist (no producer this wave).
 *   * All 4 new deferred edge types exist (no producer this wave).
 *   * SQL drift CHECK constraint contains every catalog entry.
 *   * POST /v1/graph/reconcile route is registered.
 *   * GET /v1/graph/diagnostics route is registered.
 *
 * Source-contract only — no DB / no fetch / no spawn.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  GRAPH_EDGE_TYPES,
  GRAPH_NODE_KINDS,
  WAVE1_DEPRECATED_NODE_KIND_ALIASES,
} from "../src/services/graph/graph-catalog.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const SQL = readSource(
  "../sql/drift-patches/2026-05-20-investigation-graph.sql",
);
const ROUTES = readSource("../src/routes/graph.routes.ts");
const MIGRATION = readSource(
  "../prisma/migrations/20270810000000_wave1_graph_taxonomy_renames/migration.sql",
);

const RENAMED_CANONICAL_KINDS = [
  "REVIEW_WORKFLOW",
  "REVIEW_ESCALATION",
  "EXTERNAL_REVIEWER_GRANT",
  "MEDIA_INTELLIGENCE_SIGNAL",
  "EXTRACTED_ENTITY",
] as const;

const NEW_DEFERRED_NODE_KINDS = [
  "EVIDENCE_PART",
  "CASE_EVIDENCE_LINK",
  "REVIEW_DECISION",
  "MEDIA_INTELLIGENCE_RECORD",
  "CUSTODY_EVENT",
] as const;

const NEW_DEFERRED_EDGE_TYPES = [
  "HAS_PART",
  "HAS_REVIEW_DECISION",
  "HAS_MEDIA_RECORD",
  "HAS_CUSTODY_EVENT",
] as const;

describe("Wave 1 — investigation graph taxonomy renames", () => {
  it("all 5 renamed canonical node kinds exist in the catalog", () => {
    for (const kind of RENAMED_CANONICAL_KINDS) {
      expect(GRAPH_NODE_KINDS, `canonical kind ${kind} missing`).toContain(
        kind as never,
      );
    }
  });

  it("all 5 deprecated aliases remain in the catalog (backward compat)", () => {
    for (const oldName of Object.keys(WAVE1_DEPRECATED_NODE_KIND_ALIASES)) {
      expect(GRAPH_NODE_KINDS, `alias ${oldName} missing`).toContain(
        oldName as never,
      );
    }
  });

  it("alias map points each old name at its canonical replacement", () => {
    expect(WAVE1_DEPRECATED_NODE_KIND_ALIASES.REVIEW_TASK).toBe(
      "REVIEW_WORKFLOW",
    );
    expect(WAVE1_DEPRECATED_NODE_KIND_ALIASES.ESCALATION).toBe(
      "REVIEW_ESCALATION",
    );
    expect(WAVE1_DEPRECATED_NODE_KIND_ALIASES.EXTERNAL_REVIEW).toBe(
      "EXTERNAL_REVIEWER_GRANT",
    );
    expect(WAVE1_DEPRECATED_NODE_KIND_ALIASES.MEDIA_SIGNAL).toBe(
      "MEDIA_INTELLIGENCE_SIGNAL",
    );
    expect(WAVE1_DEPRECATED_NODE_KIND_ALIASES.ENTITY).toBe("EXTRACTED_ENTITY");
  });
});

describe("Wave 1 — new deferred node kinds", () => {
  it("all 5 new deferred node kinds exist in the catalog", () => {
    for (const kind of NEW_DEFERRED_NODE_KINDS) {
      expect(GRAPH_NODE_KINDS, `deferred kind ${kind} missing`).toContain(
        kind as never,
      );
    }
  });
});

describe("Wave 1 — new deferred edge types", () => {
  it("all 4 new deferred edge types exist in the catalog", () => {
    for (const edge of NEW_DEFERRED_EDGE_TYPES) {
      expect(GRAPH_EDGE_TYPES, `deferred edge ${edge} missing`).toContain(
        edge as never,
      );
    }
  });
});

describe("Wave 1 — SQL CHECK constraint mirrors the catalog", () => {
  it("node_kind CHECK contains every catalog entry", () => {
    for (const kind of GRAPH_NODE_KINDS) {
      expect(SQL, `SQL node_kind CHECK missing ${kind}`).toMatch(
        new RegExp(`'${kind}'`),
      );
    }
  });

  it("edge_type CHECK contains every catalog entry", () => {
    for (const edge of GRAPH_EDGE_TYPES) {
      expect(SQL, `SQL edge_type CHECK missing ${edge}`).toMatch(
        new RegExp(`'${edge}'`),
      );
    }
  });
});

describe("Wave 1 — Prisma migration is additive + idempotent", () => {
  it("uses DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT pattern for the CHECK widening", () => {
    expect(MIGRATION).toMatch(
      /DROP CONSTRAINT "investigation_graph_nodes_kind_bounded"/,
    );
    expect(MIGRATION).toMatch(
      /ADD CONSTRAINT "investigation_graph_nodes_kind_bounded"/,
    );
    expect(MIGRATION).toMatch(
      /DROP CONSTRAINT "investigation_graph_edges_type_bounded"/,
    );
    expect(MIGRATION).toMatch(
      /ADD CONSTRAINT "investigation_graph_edges_type_bounded"/,
    );
  });

  it("guards each ALTER inside a DO $$ pg_tables existence block", () => {
    expect(MIGRATION).toMatch(
      /DO \$\$[\s\S]*?pg_tables[\s\S]*?investigation_graph_nodes/,
    );
    expect(MIGRATION).toMatch(
      /DO \$\$[\s\S]*?pg_tables[\s\S]*?investigation_graph_edges/,
    );
  });

  it("widens both CHECKs with every renamed canonical kind + every deferred kind", () => {
    for (const kind of [
      ...RENAMED_CANONICAL_KINDS,
      ...NEW_DEFERRED_NODE_KINDS,
    ]) {
      expect(MIGRATION, `migration missing kind ${kind}`).toMatch(
        new RegExp(`'${kind}'`),
      );
    }
    for (const edge of NEW_DEFERRED_EDGE_TYPES) {
      expect(MIGRATION, `migration missing edge ${edge}`).toMatch(
        new RegExp(`'${edge}'`),
      );
    }
  });

  it("keeps deprecated aliases in the widened CHECK for backward compat", () => {
    for (const oldName of Object.keys(WAVE1_DEPRECATED_NODE_KIND_ALIASES)) {
      expect(MIGRATION, `migration missing alias ${oldName}`).toMatch(
        new RegExp(`'${oldName}'`),
      );
    }
  });
});

describe("Wave 1 — graph routes registers the new endpoints", () => {
  it("POST /v1/graph/reconcile is registered", () => {
    expect(ROUTES).toMatch(/app\.post\(\s*"\/v1\/graph\/reconcile"/);
  });

  it("POST /v1/graph/reconcile enqueues via enqueueGraphReconcileJob", () => {
    expect(ROUTES).toMatch(/enqueueGraphReconcileJob\(\s*\{/);
    expect(ROUTES).toMatch(/reason:\s*"manual_refresh"/);
  });

  it("POST /v1/graph/reconcile emits GRAPH_MANUAL_RECONCILE_REQUESTED audit", () => {
    expect(ROUTES).toMatch(
      /appendPlatformAuditLog\([\s\S]*?action:\s*"GRAPH_MANUAL_RECONCILE_REQUESTED"/,
    );
  });

  it("GET /v1/graph/diagnostics is registered", () => {
    expect(ROUTES).toMatch(/app\.get\(\s*"\/v1\/graph\/diagnostics"/);
  });

  it("diagnostics aggregator never throws — every sub-query wrapped in try/catch", () => {
    const fn = ROUTES.match(
      /async function buildGraphDiagnostics[\s\S]*?\n\}/,
    )?.[0];
    expect(fn, "buildGraphDiagnostics fn not found").toBeTruthy();
    // At least four try/catch wrappers: nodes, edges, queue depth,
    // last reconcile.
    const tryCount = (fn!.match(/try\s*\{/g) ?? []).length;
    expect(tryCount).toBeGreaterThanOrEqual(4);
  });

  it("diagnostics route projects nodeCountsByKind + edgeCountsByType", () => {
    expect(ROUTES).toMatch(/nodeCountsByKind/);
    expect(ROUTES).toMatch(/edgeCountsByType/);
    expect(ROUTES).toMatch(/queueDepth/);
    expect(ROUTES).toMatch(/lastReconcileCompletedAt/);
  });
});
