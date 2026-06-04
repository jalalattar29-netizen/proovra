/**
 * Phase 32 — Investigation graph bounded catalogs.
 *
 * Single source of truth for node kinds + edge types + bounded
 * confidence + visibility scope. Mirrors the DB CHECK constraints
 * in 2026-05-20-investigation-graph.sql exactly.
 *
 * Pure module. No DB / no fetch / no side effects.
 *
 * ---------------------------------------------------------------------------
 * Wave 1 taxonomy renames (additive — deprecated aliases co-exist for one
 * release for backward-compatibility with any existing DB rows + producers):
 *
 *   REVIEW_TASK         → REVIEW_WORKFLOW            (kept as deprecated alias)
 *   ESCALATION          → REVIEW_ESCALATION          (kept as deprecated alias)
 *   EXTERNAL_REVIEW     → EXTERNAL_REVIEWER_GRANT    (kept as deprecated alias)
 *   MEDIA_SIGNAL        → MEDIA_INTELLIGENCE_SIGNAL  (kept as deprecated alias)
 *   ENTITY              → EXTRACTED_ENTITY           (kept as deprecated alias)
 *
 * Producers write the NEW name only. The old names remain in the catalog +
 * SQL CHECK so live rows continue to validate; remove in the next major
 * release after all live rows have been migrated forward by the graph
 * reconciler.
 *
 * Wave 1 additions (DEFERRED — no producer in this wave; added to keep
 * the catalog + SQL CHECK aligned with the brief so future waves can
 * land producers additively without another CHECK migration):
 *
 *   Node kinds:
 *     EVIDENCE_PART, CASE_EVIDENCE_LINK, REVIEW_DECISION,
 *     MEDIA_INTELLIGENCE_RECORD, CUSTODY_EVENT
 *
 *   Edge types:
 *     HAS_PART, HAS_REVIEW_DECISION, HAS_MEDIA_RECORD, HAS_CUSTODY_EVENT
 * ---------------------------------------------------------------------------
 */

export const GRAPH_NODE_KINDS = [
  "EVIDENCE",
  "CASE",
  "INCIDENT",
  // Wave 1 taxonomy: REVIEW_WORKFLOW is the canonical name. Producers
  // write REVIEW_WORKFLOW only.
  "REVIEW_WORKFLOW",
  // Phase Wave1 taxonomy: `REVIEW_TASK` kept as deprecated alias for backward compatibility — remove in next major release.
  "REVIEW_TASK",
  // Wave 1 taxonomy: REVIEW_ESCALATION is the canonical name.
  "REVIEW_ESCALATION",
  // Phase Wave1 taxonomy: `ESCALATION` kept as deprecated alias for backward compatibility — remove in next major release.
  "ESCALATION",
  "LEGAL_HOLD",
  "EXPORT",
  "REPORT",
  "VERIFICATION_PACKAGE",
  // Wave 1 taxonomy: MEDIA_INTELLIGENCE_SIGNAL is the canonical name.
  "MEDIA_INTELLIGENCE_SIGNAL",
  // Phase Wave1 taxonomy: `MEDIA_SIGNAL` kept as deprecated alias for backward compatibility — remove in next major release.
  "MEDIA_SIGNAL",
  "OCR",
  "TRANSCRIPT",
  // Wave 1 taxonomy: EXTERNAL_REVIEWER_GRANT is the canonical name.
  "EXTERNAL_REVIEWER_GRANT",
  // Phase Wave1 taxonomy: `EXTERNAL_REVIEW` kept as deprecated alias for backward compatibility — remove in next major release.
  "EXTERNAL_REVIEW",
  "USER_CREATED_ENTITY",
  // Wave 1 taxonomy: EXTRACTED_ENTITY is the canonical name.
  // Phase 13 — one node per persisted evidence_entities row;
  // external_id == evidence_entities.id.
  "EXTRACTED_ENTITY",
  // Phase Wave1 taxonomy: `ENTITY` kept as deprecated alias for backward compatibility — remove in next major release.
  "ENTITY",
  // DEFERRED — no producer in this wave (per-evidence-part provenance node).
  "EVIDENCE_PART",
  // DEFERRED — no producer in this wave (bounded-projection design needed).
  "CASE_EVIDENCE_LINK",
  // DEFERRED — no producer in this wave (reviewer_decision rows exist).
  "REVIEW_DECISION",
  // DEFERRED — no producer in this wave (media_intelligence_records exist).
  "MEDIA_INTELLIGENCE_RECORD",
  // DEFERRED — no producer in this wave (custody-events stream exists).
  "CUSTODY_EVENT",
] as const;

export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

export const GRAPH_EDGE_TYPES = [
  "BELONGS_TO_CASE",
  "CAPTURED_IN_SESSION",
  "SAME_HASH_AS",
  "SIMILAR_TO",
  "POSSIBLE_DERIVATIVE_OF",
  "REFERENCES_SAME_INCIDENT",
  "REVIEWED_BY",
  "ESCALATED_FROM",
  "BLOCKED_BY_LEGAL_HOLD",
  "EXPORTED_AS",
  "GENERATED_REPORT",
  "GENERATED_PACKAGE",
  "HAS_MEDIA_SIGNAL",
  "HAS_TRANSCRIPT",
  "HAS_OCR",
  "MANUALLY_LINKED_TO",
  // Phase 13 — ENTITY → EVIDENCE (also serves EXTRACTED_ENTITY → EVIDENCE).
  "EXTRACTED_FROM",
  // DEFERRED — no producer in this wave (EVIDENCE → EVIDENCE_PART).
  "HAS_PART",
  // DEFERRED — no producer in this wave (REVIEW_WORKFLOW → REVIEW_DECISION).
  "HAS_REVIEW_DECISION",
  // DEFERRED — no producer in this wave (EVIDENCE → MEDIA_INTELLIGENCE_RECORD).
  "HAS_MEDIA_RECORD",
  // DEFERRED — no producer in this wave (EVIDENCE → CUSTODY_EVENT).
  "HAS_CUSTODY_EVENT",
] as const;

export type GraphEdgeType = (typeof GRAPH_EDGE_TYPES)[number];

/** Edge types that operators may create directly via the manual-
 *  relationship API. Bounded — only these are accepted by the
 *  POST /v1/graph/relationships/manual route. */
export const MANUAL_EDGE_TYPES = [
  "REFERENCES_SAME_INCIDENT",
  "MANUALLY_LINKED_TO",
] as const;

export type ManualEdgeType = (typeof MANUAL_EDGE_TYPES)[number];

export const GRAPH_SOURCE_KINDS = ["SYSTEM", "MANUAL"] as const;
export type GraphSourceKind = (typeof GRAPH_SOURCE_KINDS)[number];

export const GRAPH_CONFIDENCES = ["LOW", "MEDIUM", "HIGH"] as const;
export type GraphConfidence = (typeof GRAPH_CONFIDENCES)[number];

export const GRAPH_VISIBILITY_SCOPES = [
  "WORKSPACE_INTERNAL",
  "REVIEWER_RESTRICTED",
  "EXTERNAL_REVIEWER_SCOPED",
  "PUBLIC_VERIFY_SAFE",
] as const;

export type GraphVisibilityScope = (typeof GRAPH_VISIBILITY_SCOPES)[number];

/**
 * Bounded traversal depth. The graph API never returns more than
 * this many hops from the seed node. Prevents accidental DoS-
 * shaped queries and bounds the response payload.
 */
export const MAX_GRAPH_TRAVERSAL_DEPTH = 3;

/**
 * Per-request bounded result size. The route hard-caps both nodes
 * and edges in the response.
 */
export const MAX_GRAPH_NODES_PER_RESPONSE = 500;
export const MAX_GRAPH_EDGES_PER_RESPONSE = 1000;

// ---------------------------------------------------------------------------
// Wave 1 taxonomy — deprecated alias map.
//
// Producers + consumers should write/read the canonical (new) names.
// The aliases are kept in the catalog + SQL CHECK so existing rows
// continue to validate. The reconciler may opportunistically rewrite
// old → new during a future wave.
// ---------------------------------------------------------------------------
export const WAVE1_DEPRECATED_NODE_KIND_ALIASES: Readonly<
  Record<string, GraphNodeKind>
> = Object.freeze({
  REVIEW_TASK: "REVIEW_WORKFLOW",
  ESCALATION: "REVIEW_ESCALATION",
  EXTERNAL_REVIEW: "EXTERNAL_REVIEWER_GRANT",
  MEDIA_SIGNAL: "MEDIA_INTELLIGENCE_SIGNAL",
  ENTITY: "EXTRACTED_ENTITY",
});
