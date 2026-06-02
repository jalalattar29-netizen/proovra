/**
 * Phase 24 — Enterprise Evidence Discovery canonical types.
 *
 * Provider-agnostic, framework-agnostic primitives for:
 *   - Search document type enum (EVIDENCE / WORKFLOW / WORKFLOW_STEP /
 *     REVIEW_EVENT / AUDIT_EVENT / COMMUNICATION / CASE_TIMELINE /
 *     INCIDENT)
 *   - Search sort modes
 *   - Saved-view visibility (PRIVATE / TEAM)
 *   - Search filter input shape (server-validated; the route layer
 *     re-validates via zod)
 *   - Result-row projection shape (operator-safe; no privateReviewer-
 *     Note, no legal-hold reason, no raw GPS unless policy allows)
 *
 * Hard invariants encoded here:
 *   - Document type catalog is exhaustive — adding one is a code
 *     change so the indexer + search service can never accept an
 *     ad-hoc value.
 *   - Wording catalog excludes legal/forensic overclaim phrases.
 *     Result row labels MUST use the allowed wording from the
 *     Phase 24 brief: "matched metadata", "related evidence",
 *     "workflow-linked", "review-linked", "governance-restricted",
 *     "visibility-restricted", "integrity record".
 *   - Cursor pagination tokens are opaque base64 of
 *     `{ updatedAtUtc, id }` — the helper validates the shape but
 *     does NOT decode at the type level.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Document type (what kind of row a search hit refers to)
// -----------------------------------------------------------------------------

export const SEARCH_DOCUMENT_TYPES = [
  "EVIDENCE",
  "WORKFLOW",
  "WORKFLOW_STEP",
  "REVIEW_EVENT",
  "AUDIT_EVENT",
  "COMMUNICATION",
  "CASE_TIMELINE",
  "INCIDENT",
] as const;
export const SearchDocumentTypeSchema = z.enum(SEARCH_DOCUMENT_TYPES);
export type SearchDocumentType = z.infer<typeof SearchDocumentTypeSchema>;

// -----------------------------------------------------------------------------
// Sort modes — bounded set. Adding one is a code change.
// -----------------------------------------------------------------------------

export const SEARCH_SORT_MODES = [
  "UPDATED_DESC",
  "UPDATED_ASC",
  "CREATED_DESC",
  "CREATED_ASC",
  "RELEVANCE_DESC",
] as const;
export const SearchSortModeSchema = z.enum(SEARCH_SORT_MODES);
export type SearchSortMode = z.infer<typeof SearchSortModeSchema>;

// -----------------------------------------------------------------------------
// Phase 15 — Search mode + fallback reasons.
//
// `mode` is the operator's request. `modeUsed` (returned on every
// response) is what the backend actually executed — which can differ
// from `mode` when the semantic provider is unavailable. The backend
// then sets `fallbackReason` so the UI can render an honest chip.
// -----------------------------------------------------------------------------

export const SEARCH_MODES = ["KEYWORD", "SEMANTIC", "HYBRID"] as const;
export const SearchModeSchema = z.enum(SEARCH_MODES);
export type SearchMode = z.infer<typeof SearchModeSchema>;

export const SEARCH_FALLBACK_REASONS = [
  "PROVIDER_UNAVAILABLE",
  "SEMANTIC_FEATURE_DISABLED",
  "QUERY_TOO_SHORT",
  "NO_SEMANTIC_RESULTS",
] as const;
export type SearchFallbackReason = (typeof SEARCH_FALLBACK_REASONS)[number];

// -----------------------------------------------------------------------------
// Saved-view visibility
// -----------------------------------------------------------------------------

export const SAVED_VIEW_VISIBILITIES = ["PRIVATE", "TEAM"] as const;
export const SavedViewVisibilitySchema = z.enum(SAVED_VIEW_VISIBILITIES);
export type SavedViewVisibility = z.infer<typeof SavedViewVisibilitySchema>;

// -----------------------------------------------------------------------------
// Search filter input
//
// The route layer validates via this schema before passing to the
// search service. Filter fields are intentionally narrow + bounded —
// any unknown filter is REJECTED, not silently ignored.
// -----------------------------------------------------------------------------

export const SearchFilterSchema = z
  .object({
    teamId: z.string().uuid(),
    // Free-text query — bounded to 200 chars to keep query plans
    // sane and prevent regex DoS at the service layer.
    q: z.string().min(1).max(200).optional(),
    // Restrict to specific document types.
    documentTypes: z.array(SearchDocumentTypeSchema).max(8).optional(),
    // Evidence-only filters.
    evidenceTypes: z
      .array(z.enum(["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"]))
      .max(4)
      .optional(),
    // Workflow + review state filters.
    workflowStatuses: z
      .array(z.string().min(1).max(40))
      .max(20)
      .optional(),
    reviewStatuses: z.array(z.string().min(1).max(40)).max(10).optional(),
    // Operator filters that the search service joins through the
    // indexed denormalised columns.
    onLegalHold: z.boolean().optional(),
    exportRestricted: z.boolean().optional(),
    incidentLinked: z.boolean().optional(),
    workflowLinked: z.boolean().optional(),
    contributorScoped: z.boolean().optional(),
    // Date range. Both bounds optional; both ISO-8601.
    updatedSinceUtc: z.string().datetime().optional(),
    updatedUntilUtc: z.string().datetime().optional(),
    // Sort + pagination.
    sort: SearchSortModeSchema.optional(),
    cursor: z.string().min(8).max(512).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    // Phase 15 — semantic / hybrid request mode. Default is KEYWORD,
    // which preserves Phase 14 behavior exactly.
    mode: SearchModeSchema.optional(),
  })
  .strict();
export type SearchFilterInput = z.infer<typeof SearchFilterSchema>;

// -----------------------------------------------------------------------------
// Result row — operator-safe projection
//
// The router serialises one of these per hit. NEVER contains:
//   - privateReviewerNote
//   - legal-hold reason text
//   - raw GPS (only the documentary "has location" flag)
//   - signed URLs / tokens / OTPs / secrets
//   - hidden contributor identity
// -----------------------------------------------------------------------------

export type SearchResultRow = {
  documentId: string;
  documentType: SearchDocumentType;
  title: string;
  subtitle: string | null;
  summary: string | null;
  // Pointers — operator-readable for pivoting. NEVER the raw
  // signed-URL, NEVER a token.
  evidenceId: string | null;
  workflowInstanceId: string | null;
  workflowStepInstanceId: string | null;
  caseId: string | null;
  // Lifecycle indicators (operator-readable status strings).
  reviewState: string | null;
  workflowState: string | null;
  exportState: string | null;
  retentionState: string | null;
  legalHoldState: string | null;
  // Boolean flags surfaced as operator badges in the UI.
  contributorScoped: boolean;
  reviewerRestricted: boolean;
  // Operator-readable badges. Allowed wording catalog only — see the
  // shared/search.ts file header for the rules.
  badges: ReadonlyArray<string>;
  updatedAtUtc: string;
  // Phase 15 — hybrid ranker metadata. All optional + backward-
  // compatible: existing Phase 14 clients ignore these fields safely.
  // `matchReasons` uses operator-readable phrases ONLY — never raw
  // internal score names like "ts_rank" or "cosine_distance".
  matchReasons?: ReadonlyArray<string>;
  semanticScore?: number | null;
  keywordScore?: number | null;
};

// -----------------------------------------------------------------------------
// Cursor helper — opaque shape `{ updatedAtUtc, id }` base64-encoded
// -----------------------------------------------------------------------------

export type SearchCursor = {
  updatedAtUtc: string;
  id: string;
};

export function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeSearchCursor(value: string): SearchCursor | null {
  try {
    const json = Buffer.from(value, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof parsed["updatedAtUtc"] !== "string" ||
      typeof parsed["id"] !== "string"
    ) {
      return null;
    }
    return {
      updatedAtUtc: parsed["updatedAtUtc"] as string,
      id: parsed["id"] as string,
    };
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Allowed badge wording catalog — runtime-checked
// -----------------------------------------------------------------------------

export const SEARCH_RESULT_ALLOWED_BADGES: ReadonlyArray<string> = [
  "matched metadata",
  "related evidence",
  "workflow-linked",
  "review-linked",
  "governance-restricted",
  "visibility-restricted",
  "legal-hold",
  "export-restricted",
  "integrity record",
  "incident-linked",
  "communication-linked",
  "contributor-scoped",
];

export function isAllowedSearchBadge(badge: string): boolean {
  return SEARCH_RESULT_ALLOWED_BADGES.includes(badge);
}

// -----------------------------------------------------------------------------
// Forbidden wording — runtime-checked. Used by the indexer to scrub
// titles + summaries before persisting. If a candidate string contains
// any of these markers, the indexer either rejects it or strips the
// offending phrase (the service layer decides per-field).
// -----------------------------------------------------------------------------

export const SEARCH_FORBIDDEN_OVERCLAIM_PHRASES: ReadonlyArray<RegExp> = [
  /\btamper.?proof\b/i,
  /\bcourt.?approved\b/i,
  /\bguaranteed authentic\b/i,
  /\bimpossible to alter\b/i,
  /\bdetects fake\b/i,
  /\bforensic proof\b/i,
  /\blegally admissible\b/i,
];

export function stringContainsForbiddenOverclaim(value: string): boolean {
  for (const re of SEARCH_FORBIDDEN_OVERCLAIM_PHRASES) {
    if (re.test(value)) return true;
  }
  return false;
}
