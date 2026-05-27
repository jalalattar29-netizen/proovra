/**
 * Phase 2.7X Stage 2 — Authoritative registry of runtime-protected
 * tables (the "drift catalog").
 *
 * These tables EXIST in the live database and are referenced by
 * runtime code paths (worker, API, frontend), but they are NOT
 * declared in `services/api/prisma/schema.prisma`. They came from
 * Phase 25-31 era `services/api/sql/drift-patches/*.sql` raw-SQL
 * patches applied outside the Prisma migration system.
 *
 * Because they are missing from schema.prisma, `prisma migrate diff`
 * proposes destructive `DROP TABLE` statements for each of them.
 * Stage 1 of Phase 2.7X uncovered this risk; this file is the
 * structural guard.
 *
 * Each entry is sourced from `services/api/src/runtime/schema-validation.ts`
 * (the existing Phase 28-A runtime-readiness catalog) and cross-
 * referenced against the live DB at `services/api/sql/drift-patches/`.
 *
 * Hard rules:
 *   - This list is the SINGLE SOURCE OF TRUTH consumed by:
 *       * `migration-risk-scan.mjs`  — any DROP TABLE / DROP COLUMN
 *         on these names is upgraded to BLOCKED (exit 9).
 *       * `db-diff-guard.mjs`        — refuses any ad-hoc SQL diff
 *         containing destructive ops on these names.
 *       * `db-preflight.mjs`         — surfaces the catalog so
 *         operators can see what's being protected.
 *
 *   - Each entry has a comment naming the runtime subsystem that
 *     would break if the table were dropped. This makes the
 *     decision auditable.
 *
 *   - The list MUST be a strict subset of (or equal to) the runtime
 *     schema-validation catalog. The `assert-catalog-sync` helper
 *     validates this invariant.
 *
 *   - Removing an entry from this list requires:
 *       1. Removing the table from `runtime/schema-validation.ts`
 *          catalog AND
 *       2. Removing all code paths that reference it AND
 *       3. A migration that drops the table (which itself will be
 *          BLOCKED unless step 1+2 have run first — see
 *          migration-risk-scan).
 *
 * This guardrail closes the structural risk class discovered in
 * Phase 2.7X Stage 1: `prisma migrate diff` silently produced
 * destructive SQL that, if applied, would have dropped 13
 * runtime-critical tables.
 */

/**
 * @typedef {Object} ProtectedTableEntry
 * @property {string} table          - PostgreSQL table name (snake_case).
 * @property {string} subsystem      - Runtime subsystem (per readiness catalog).
 * @property {string} severity       - "critical" | "important".
 * @property {string} driftPatchFile - Source `sql/drift-patches/*.sql` filename.
 * @property {string} consumers      - Short description of consumers.
 */

/** @type {ProtectedTableEntry[]} */
export const PROTECTED_RUNTIME_TABLES = [
  // -------------------------------------------------------------------------
  // Core evidence — upload pipeline
  // -------------------------------------------------------------------------
  {
    table: "evidence_upload_sessions",
    subsystem: "core_evidence",
    severity: "important",
    driftPatchFile: "2026-05-19-evidence-upload-sessions.sql",
    consumers:
      "services/api uploads/unified-material-manifest.ts; worker upload pipeline.",
  },
  {
    table: "evidence_upload_session_parts",
    subsystem: "core_evidence",
    severity: "important",
    driftPatchFile: "2026-05-19-evidence-upload-multipart.sql",
    consumers:
      "Multipart upload coordination; worker session-bridge.",
  },

  // -------------------------------------------------------------------------
  // Core evidence — media intelligence
  // -------------------------------------------------------------------------
  {
    table: "media_intelligence_runs",
    subsystem: "core_evidence",
    severity: "important",
    driftPatchFile: "2026-05-20-media-intelligence-runs.sql",
    consumers:
      "services/api media-intelligence routes; worker media-intelligence.processor.ts; reports; verify package.",
  },
  {
    table: "media_intelligence_signals",
    subsystem: "core_evidence",
    severity: "important",
    driftPatchFile: "2026-05-20-media-intelligence-signals.sql",
    consumers:
      "Same as runs; signals projected to verify-projection + report-v2 sections.",
  },
  {
    table: "evidence_part_exif_summaries",
    subsystem: "core_evidence",
    severity: "important",
    driftPatchFile: "2026-05-20-evidence-part-exif-summaries.sql",
    consumers: "worker ffmpeg-derived-assets / exif-summary.service.",
  },
  {
    table: "evidence_part_derived_assets",
    subsystem: "core_evidence",
    severity: "important",
    driftPatchFile: "2026-05-20-evidence-part-derived-assets.sql",
    consumers: "worker ffmpeg-derived-assets; report verify package.",
  },

  // -------------------------------------------------------------------------
  // Core evidence — investigation graph
  // -------------------------------------------------------------------------
  {
    table: "investigation_graph_nodes",
    subsystem: "core_evidence",
    severity: "important",
    driftPatchFile: "2026-05-20-investigation-graph.sql",
    consumers:
      "api graph.routes.ts; graph-builder.service.ts; frontend /investigation and /ops/media-graph.",
  },
  {
    table: "investigation_graph_edges",
    subsystem: "core_evidence",
    severity: "important",
    driftPatchFile: "2026-05-20-investigation-graph.sql",
    consumers: "Same as nodes.",
  },
  {
    table: "manual_relationships",
    subsystem: "core_evidence",
    severity: "important",
    driftPatchFile: "2026-05-20-investigation-graph.sql",
    consumers: "graph-builder.service.ts manual-relationship registration.",
  },

  // -------------------------------------------------------------------------
  // Search discovery
  // -------------------------------------------------------------------------
  {
    table: "evidence_ocr_text",
    subsystem: "search_discovery",
    severity: "important",
    driftPatchFile: "2026-05-19-evidence-ocr-text.sql",
    consumers:
      "media-intelligence ocr-transcript-indexer; worker search-indexing.processor.",
  },
  {
    table: "evidence_transcript_segments",
    subsystem: "search_discovery",
    severity: "important",
    driftPatchFile: "2026-05-19-evidence-transcripts.sql",
    consumers:
      "Worker transcripts pipeline; verify-package projection.",
  },
  {
    table: "search_audit_logs",
    subsystem: "search_discovery",
    severity: "important",
    driftPatchFile: "2026-05-19-search-audit-log.sql",
    consumers: "Search subsystem audit trail.",
  },

  // -------------------------------------------------------------------------
  // Governance lifecycle — external collaborator grants
  // -------------------------------------------------------------------------
  {
    table: "external_review_grants",
    subsystem: "governance_lifecycle",
    severity: "important",
    driftPatchFile: "2026-05-19-external-review-grants.sql",
    consumers:
      "api external-review.routes.ts + external-review-grant.service.ts; frontend Teams external-collaborators surfaces (Phase 2.6B/C/D).",
  },
];

/** Set of bare table names for O(1) membership checks. */
export const PROTECTED_TABLE_NAMES = new Set(
  PROTECTED_RUNTIME_TABLES.map((e) => e.table),
);

/**
 * Inspect a SQL string and return any destructive operations that
 * target a protected runtime table.
 *
 * Returns an array of `{ table, op, line }` hits. Empty array means
 * the SQL is safe with respect to this guard. The check is
 * conservative (false positives preferred over false negatives) and
 * line-based; it does not parse SQL.
 *
 * @param {string} sql Raw SQL text to inspect.
 * @returns {{ table: string, op: string, line: string }[]}
 */
export function findProtectedDestructiveOps(sql) {
  if (typeof sql !== "string" || sql.length === 0) return [];
  const hits = [];
  const lines = sql.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("--")) continue;
    const lower = line.toLowerCase();
    for (const entry of PROTECTED_RUNTIME_TABLES) {
      const t = entry.table.toLowerCase();
      // Match patterns:
      //   DROP TABLE [IF EXISTS] [public.]<t>
      //   DROP TABLE [IF EXISTS] "<t>"
      //   ALTER TABLE <t> DROP COLUMN ...
      //   ALTER TABLE "<t>" DROP COLUMN ...
      //   TRUNCATE [TABLE] <t> [CASCADE]
      //   TRUNCATE "<t>" CASCADE
      const dropRe = new RegExp(
        `^\\s*drop\\s+table\\s+(if\\s+exists\\s+)?(public\\.)?["\`]?${t}\\b`,
        "i",
      );
      const alterDropRe = new RegExp(
        `^\\s*alter\\s+table\\s+(public\\.)?["\`]?${t}\\b.*\\bdrop\\s+column\\b`,
        "i",
      );
      const truncRe = new RegExp(
        `^\\s*truncate\\s+(table\\s+)?(public\\.)?["\`]?${t}\\b`,
        "i",
      );
      if (dropRe.test(lower)) hits.push({ table: entry.table, op: "DROP TABLE", line });
      else if (alterDropRe.test(lower)) hits.push({ table: entry.table, op: "ALTER TABLE DROP COLUMN", line });
      else if (truncRe.test(lower)) hits.push({ table: entry.table, op: "TRUNCATE", line });
    }
  }
  return hits;
}
