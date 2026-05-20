/**
 * Phase 32 — Investigation graph bounded catalogs.
 *
 * Single source of truth for node kinds + edge types + bounded
 * confidence + visibility scope. Mirrors the DB CHECK constraints
 * in 2026-05-20-investigation-graph.sql exactly.
 *
 * Pure module. No DB / no fetch / no side effects.
 */
export const GRAPH_NODE_KINDS = [
    "EVIDENCE",
    "CASE",
    "INCIDENT",
    "REVIEW_TASK",
    "ESCALATION",
    "LEGAL_HOLD",
    "EXPORT",
    "REPORT",
    "VERIFICATION_PACKAGE",
    "MEDIA_SIGNAL",
    "OCR",
    "TRANSCRIPT",
    "EXTERNAL_REVIEW",
    "USER_CREATED_ENTITY",
];
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
];
/** Edge types that operators may create directly via the manual-
 *  relationship API. Bounded — only these are accepted by the
 *  POST /v1/graph/relationships/manual route. */
export const MANUAL_EDGE_TYPES = [
    "REFERENCES_SAME_INCIDENT",
    "MANUALLY_LINKED_TO",
];
export const GRAPH_SOURCE_KINDS = ["SYSTEM", "MANUAL"];
export const GRAPH_CONFIDENCES = ["LOW", "MEDIUM", "HIGH"];
export const GRAPH_VISIBILITY_SCOPES = [
    "WORKSPACE_INTERNAL",
    "REVIEWER_RESTRICTED",
    "EXTERNAL_REVIEWER_SCOPED",
    "PUBLIC_VERIFY_SAFE",
];
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
