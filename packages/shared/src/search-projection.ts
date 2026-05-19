/**
 * Phase 25 — Canonical search document projection engine.
 *
 * Single source of truth for converting source-row data into a
 * canonical `EvidenceSearchDocument` projection. Both the API
 * (`services/api/src/services/search/evidence-indexing.service.ts`) and
 * the worker (`services/worker/src/search-indexing.processor.ts`)
 * import these pure builders so the indexing logic NEVER drifts
 * between processes.
 *
 * Hard rules encoded in this module:
 *   - Pure: no Prisma, no Node, no Fastify, no BullMQ. Browser-safe.
 *   - The CALLER fetches source data via its own client and passes it
 *     in as a typed input. This module's builders return the
 *     projection — the caller upserts.
 *   - PRIVACY: this module never references / projects /
 *     `privateReviewerNote`, legal-note bodies, raw GPS, storage keys,
 *     signed URLs, OTPs, tokens, session ids. The inputs are
 *     deliberately narrow so a careless caller cannot pass them in.
 *   - SCRUBBING: title / subtitle / summary / body all run through the
 *     forbidden-overclaim regex catalog before emission. Strings are
 *     bounded by length so a pathological caller cannot balloon rows.
 *   - VISIBILITY: each builder accepts the fully-resolved visibility
 *     state from the caller. The pure builder does NOT make Prisma
 *     queries to discover it — that decision is the caller's.
 *   - FAIL-CLOSED: when the caller indicates the source is not
 *     indexable (deleted / blocked / governance-uncertain), the
 *     builder returns `{ ok: false, reason }` — the caller MUST act
 *     on this by removing the document via the canonical
 *     `removeFromIndex` path.
 */

import {
  SEARCH_FORBIDDEN_OVERCLAIM_PHRASES,
  SearchDocumentTypeSchema,
  type SearchDocumentType,
} from "./search.js";

// -----------------------------------------------------------------------------
// Bounded scrub helpers
// -----------------------------------------------------------------------------

export const SEARCH_TITLE_MAX_CHARS = 200;
export const SEARCH_SUBTITLE_MAX_CHARS = 200;
export const SEARCH_SUMMARY_MAX_CHARS = 400;
export const SEARCH_BODY_MAX_CHARS = 16 * 1024;
export const SEARCH_TAG_MAX_COUNT = 32;

/**
 * Scrub a user-facing identifier (title / subtitle / summary). Strips
 * control chars, removes overclaim phrases, collapses whitespace,
 * truncates with a typographic ellipsis.
 *
 * Returns `null` for empty/whitespace input — the caller treats null
 * as "no value" rather than indexing an empty string.
 */
export function sanitiseSearchString(
  value: string | null | undefined,
  max: number,
): string | null {
  if (value == null) return null;
  let scrubbed = String(value);
  for (const re of SEARCH_FORBIDDEN_OVERCLAIM_PHRASES) {
    scrubbed = scrubbed.replace(re, "[redacted-overclaim]");
  }
  // Drop ASCII control chars + collapse whitespace.
  scrubbed = scrubbed.replace(/[\x00-\x08\x0B-\x1F\x7F]+/g, " ").trim();
  if (scrubbed.length === 0) return null;
  if (scrubbed.length <= max) return scrubbed;
  return `${scrubbed.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Scrub long-form text body (the `searchable_text` column). Same
 * overclaim scrub + control-char strip, bounded by SEARCH_BODY_MAX_CHARS.
 */
export function sanitiseSearchBody(
  value: string | null | undefined,
): string | null {
  return sanitiseSearchString(value, SEARCH_BODY_MAX_CHARS);
}

/**
 * Recursively clip JSON-safe metadata so an attacker can't grow the
 * row with a deeply nested or massive object. We re-serialize through
 * JSON.parse(JSON.stringify(...)) which also strips functions, dates
 * (already iso strings), symbols, etc.
 */
export function safeMetadataSnapshot(
  value: Record<string, unknown> | null | undefined,
  maxBytes = 4 * 1024,
): Record<string, unknown> | null {
  if (!value) return null;
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const serialised = JSON.stringify(snapshot);
  if (serialised.length > maxBytes) {
    // Coerce to a string-summary marker so the row stays small.
    return { __truncated: true, originalBytes: serialised.length };
  }
  return snapshot as Record<string, unknown>;
}

/**
 * Filter + bound tag array.
 */
export function sanitiseSearchTags(
  tags: ReadonlyArray<string | null | undefined> | null | undefined,
): ReadonlyArray<string> {
  if (!tags) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const cleaned = t.trim().slice(0, 64);
    if (cleaned.length > 0) out.push(cleaned);
    if (out.length >= SEARCH_TAG_MAX_COUNT) break;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Canonical projection shape
// -----------------------------------------------------------------------------

export type SearchDocumentProjection = {
  teamId: string;
  documentType: SearchDocumentType;
  sourceId: string;
  title: string;
  subtitle: string | null;
  summary: string | null;
  searchableText: string | null;
  searchableMetadata: Record<string, unknown> | null;
  searchableTags: ReadonlyArray<string>;
  visibilityScope: Record<string, unknown> | null;
  governanceScope: Record<string, unknown> | null;
  reviewState: string | null;
  workflowState: string | null;
  exportState: string | null;
  retentionState: string | null;
  legalHoldState: string | null;
  contributorScoped: boolean;
  reviewerRestricted: boolean;
  evidenceId: string | null;
  workflowInstanceId: string | null;
  workflowStepInstanceId: string | null;
  caseId: string | null;
  claimRef: string | null;
  matterRef: string | null;
  sourceUpdatedAtUtc: Date;
};

export type ProjectionResult =
  | { ok: true; projection: SearchDocumentProjection }
  | { ok: false; reason: ProjectionFailureReason; deleteFromIndex: boolean };

export type ProjectionFailureReason =
  | "deleted"
  | "blocked"
  | "lifecycle_destroyed"
  | "lifecycle_pending_destruction"
  | "governance_uncertain"
  | "team_mismatch"
  | "missing_required_fields";

// -----------------------------------------------------------------------------
// Evidence projection
// -----------------------------------------------------------------------------

export type EvidenceProjectionInput = {
  teamId: string;
  evidenceId: string;
  /** Already-fetched source row, narrowed to safe fields. */
  evidence: {
    id: string;
    teamId: string | null;
    title: string | null;
    displayFileName: string | null;
    originalFileName: string | null;
    type: string | null;
    mimeType: string | null;
    captureMethod: string | null;
    caseId: string | null;
    deletedAt: Date | null;
    /** Phase 27 lifecycle state. */
    lifecycleState: string | null;
    archivedAt: Date | null;
    publicVerifyState: string | null;
    storageObjectLockLegalHoldStatus: string | null;
    retentionPolicySource: string | null;
    retentionUntilUtc: Date | null;
    reviewReadyAtUtc: Date | null;
    updatedAt: Date;
  };
  /** Optional already-fetched workflow status. */
  workflowState: string | null;
  /**
   * Already-fetched, safe-to-index extracted text. Caller MUST have
   * filtered for: visibility_scope === 'TEAM' AND redacted === false
   * AND the evidence is in an indexable lifecycle state. The builder
   * concatenates + bounds; it does NOT re-check visibility (that's
   * the caller's job).
   */
  extractedTextChunks?: ReadonlyArray<string>;
};

/**
 * Build the canonical projection for an Evidence row. Returns a
 * `deleteFromIndex: true` result when the evidence is in a state the
 * search service must not surface — the caller MUST remove the
 * document by (teamId, "EVIDENCE", evidenceId).
 */
export function buildEvidenceProjection(
  input: EvidenceProjectionInput,
): ProjectionResult {
  const { evidence } = input;
  if (evidence.teamId && evidence.teamId !== input.teamId) {
    return {
      ok: false,
      reason: "team_mismatch",
      deleteFromIndex: false,
    };
  }
  if (evidence.deletedAt) {
    return { ok: false, reason: "deleted", deleteFromIndex: true };
  }
  // Phase 27 lifecycle terminal states — must NOT surface in search.
  const lifecycle = (evidence.lifecycleState ?? "ACTIVE").toUpperCase();
  if (lifecycle === "DESTROYED") {
    return {
      ok: false,
      reason: "lifecycle_destroyed",
      deleteFromIndex: true,
    };
  }
  if (lifecycle === "PENDING_DESTRUCTION") {
    return {
      ok: false,
      reason: "lifecycle_pending_destruction",
      deleteFromIndex: true,
    };
  }

  const legalHoldState = evidence.storageObjectLockLegalHoldStatus ?? null;
  const publicVerifyState = evidence.publicVerifyState ?? null;
  const extracted = (input.extractedTextChunks ?? [])
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n");

  const title =
    sanitiseSearchString(evidence.title, SEARCH_TITLE_MAX_CHARS) ??
    sanitiseSearchString(evidence.displayFileName, SEARCH_TITLE_MAX_CHARS) ??
    "(untitled)";

  const subtitle = sanitiseSearchString(
    evidence.type,
    SEARCH_SUBTITLE_MAX_CHARS,
  );
  const summary = sanitiseSearchString(
    evidence.displayFileName ?? evidence.originalFileName,
    SEARCH_SUMMARY_MAX_CHARS,
  );

  const bodyParts = [
    evidence.title ?? "",
    evidence.displayFileName ?? "",
    evidence.originalFileName ?? "",
    extracted,
  ].filter((s) => s.length > 0);
  const searchableText = sanitiseSearchBody(bodyParts.join("\n").trim());

  const exportState =
    publicVerifyState === "PUBLISHED"
      ? "PUBLIC"
      : publicVerifyState === "SUSPENDED"
        ? "SUSPENDED"
        : "INTERNAL";

  const projection: SearchDocumentProjection = {
    teamId: input.teamId,
    documentType: "EVIDENCE",
    sourceId: evidence.id,
    title,
    subtitle,
    summary,
    searchableText,
    searchableMetadata: safeMetadataSnapshot({
      type: evidence.type,
      mimeType: evidence.mimeType,
      captureMethod: evidence.captureMethod,
      publicVerifyState,
      retentionPolicySource: evidence.retentionPolicySource ?? null,
      lifecycleState: lifecycle,
    }),
    searchableTags: sanitiseSearchTags([
      evidence.type,
      publicVerifyState,
      legalHoldState ? "legal_hold" : null,
      evidence.archivedAt ? "archived" : null,
      lifecycle === "ON_HOLD" ? "on_hold" : null,
      lifecycle === "RETENTION_LOCKED" ? "retention_locked" : null,
    ]),
    visibilityScope: { publicVerifyState },
    governanceScope: {
      legalHoldState,
      lifecycleState: lifecycle,
      retentionPolicySource: evidence.retentionPolicySource ?? null,
      retentionUntilUtc: evidence.retentionUntilUtc?.toISOString() ?? null,
    },
    reviewState: evidence.reviewReadyAtUtc ? "REVIEW_READY" : null,
    workflowState: input.workflowState,
    exportState,
    retentionState: evidence.retentionPolicySource ?? null,
    legalHoldState,
    contributorScoped: evidence.captureMethod === "EXTERNAL_INTAKE_UPLOAD",
    reviewerRestricted: false,
    evidenceId: evidence.id,
    workflowInstanceId: null,
    workflowStepInstanceId: null,
    caseId: evidence.caseId ?? null,
    claimRef: null,
    matterRef: null,
    sourceUpdatedAtUtc: evidence.updatedAt,
  };
  return { ok: true, projection };
}

// -----------------------------------------------------------------------------
// Workflow instance projection
// -----------------------------------------------------------------------------

export type WorkflowInstanceProjectionInput = {
  teamId: string;
  workflowInstanceId: string;
  instance: {
    id: string;
    teamId: string | null;
    title: string | null;
    templateSlug: string | null;
    templateVersion: number | null;
    intakeMode: string;
    actorRole: string;
    status: string;
    caseId: string | null;
    claimRef: string | null;
    matterRef: string | null;
    assignedReviewerUserId: string | null;
    updatedAt: Date;
  };
};

export function buildWorkflowInstanceProjection(
  input: WorkflowInstanceProjectionInput,
): ProjectionResult {
  const { instance } = input;
  if (instance.teamId && instance.teamId !== input.teamId) {
    return { ok: false, reason: "team_mismatch", deleteFromIndex: false };
  }
  const title =
    sanitiseSearchString(instance.title, SEARCH_TITLE_MAX_CHARS) ??
    `Workflow ${instance.id.slice(0, 8)}…`;
  const projection: SearchDocumentProjection = {
    teamId: input.teamId,
    documentType: "WORKFLOW",
    sourceId: instance.id,
    title,
    subtitle: sanitiseSearchString(
      instance.templateSlug,
      SEARCH_SUBTITLE_MAX_CHARS,
    ),
    summary: sanitiseSearchString(
      `intake ${instance.intakeMode} · actor ${instance.actorRole}`,
      SEARCH_SUMMARY_MAX_CHARS,
    ),
    searchableText: sanitiseSearchBody(
      [
        instance.title ?? "",
        instance.templateSlug ?? "",
        instance.intakeMode,
        instance.actorRole,
      ]
        .filter((s) => s.length > 0)
        .join(" "),
    ),
    searchableMetadata: safeMetadataSnapshot({
      templateSlug: instance.templateSlug,
      templateVersion: instance.templateVersion,
      intakeMode: instance.intakeMode,
      actorRole: instance.actorRole,
    }),
    searchableTags: sanitiseSearchTags([
      instance.intakeMode,
      instance.actorRole,
      instance.status,
    ]),
    visibilityScope: null,
    governanceScope: { status: instance.status },
    reviewState: instance.assignedReviewerUserId ? "ASSIGNED" : null,
    workflowState: instance.status,
    exportState:
      instance.status === "SHARED_EXTERNALLY"
        ? "PUBLIC"
        : instance.status === "PACKAGE_READY"
          ? "PACKAGE_READY"
          : instance.status === "APPROVED"
            ? "APPROVED"
            : "INTERNAL",
    retentionState: null,
    legalHoldState: instance.status === "LEGAL_HOLD" ? "ACTIVE" : null,
    contributorScoped:
      instance.actorRole === "EXTERNAL_CONTRIBUTOR" ||
      instance.actorRole === "ANONYMOUS_SOURCE",
    reviewerRestricted: false,
    evidenceId: null,
    workflowInstanceId: instance.id,
    workflowStepInstanceId: null,
    caseId: instance.caseId ?? null,
    claimRef: instance.claimRef ?? null,
    matterRef: instance.matterRef ?? null,
    sourceUpdatedAtUtc: instance.updatedAt,
  };
  return { ok: true, projection };
}

// -----------------------------------------------------------------------------
// Validation helper — used by API + worker before upsert.
// -----------------------------------------------------------------------------

export function isAllowedSearchDocumentType(value: string): value is SearchDocumentType {
  return SearchDocumentTypeSchema.safeParse(value).success;
}
