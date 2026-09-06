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

/**
 * True for the control characters this scrubber removes: the C0 range EXCEPT
 * TAB (0x09) and LF (0x0A), plus DEL (0x7F). Expressed as explicit code-point
 * ranges so the control characters are named rather than embedded in a regex
 * literal — same set, no `no-control-regex` suppression.
 */
function isScrubbedControlCode(code: number): boolean {
  return (code >= 0x00 && code <= 0x08) || (code >= 0x0b && code <= 0x1f) || code === 0x7f;
}

/** Collapse each RUN of those control characters into a single space. */
function scrubControlRuns(value: string): string {
  let out = "";
  let inRun = false;
  for (const ch of value) {
    if (isScrubbedControlCode(ch.charCodeAt(0))) {
      if (!inRun) {
        out += " ";
        inRun = true;
      }
      continue;
    }
    inRun = false;
    out += ch;
  }
  return out;
}

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
  scrubbed = scrubControlRuns(scrubbed).trim();
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

/**
 * THE SHAPE THIS BUILDER PRODUCES, AS A NUMBER.
 *
 * WHY A DOCUMENT NEEDS TO KNOW WHICH BUILDER WROTE IT
 * ---------------------------------------------------------------------------
 * A search document is a CACHE of the projection. When the projection changes
 * — when a field starts being indexed that was not indexed before — every
 * document already written is silently wrong: it is not corrupt, not missing,
 * and not stale by any timestamp, because its source row has not been touched.
 * It simply cannot answer a question the current builder would let it answer.
 *
 * Nothing could see that. The reindex looks for evidence rows with NO document
 * (`esd.id IS NULL`) and repairs those; a row that already has a document is
 * never revisited by any path — not the cron sweep, not
 * `POST /v1/search/reconcile`, not the backfill CLI. So when External Intake
 * identity (Customer ID, recipient name, address and phone) was added to the
 * body, every record indexed before that change became permanently unfindable
 * by those identifiers, and running the backfill again reported success while
 * changing nothing.
 *
 * Proven against a live database rather than argued: a document with the
 * identity stripped out of its body failed all four identity probes, a full
 * workspace reconcile reported 14 documents indexed, and the stripped body
 * came back byte-for-byte identical. Deleting it and reconciling repaired it —
 * which is the same work, reachable only by hand, one record at a time.
 *
 * SO THE DOCUMENT RECORDS WHICH BUILDER WROTE IT.
 * ---------------------------------------------------------------------------
 * Bump this when a change to `buildEvidenceProjection` means an existing
 * document would now be built differently — a new field in the body, a
 * different normalisation, a corrected predicate. Do NOT bump it for a change
 * that only affects rows the builder would reject anyway.
 *
 * A document whose version is below this one is STALE, and stale documents are
 * refreshed by the same reindex that fills orphans, through the same indexer,
 * in the same bounded batches.
 *
 * 1 → the original body: title, filenames, extracted text.
 * 2 → adds External Intake identity and the record's own identifiers.
 * 3 → moves recipient contact OUT of the free-text body and into the gated
 *     contact haystack, so matching on an address or a number is a decision
 *     the query makes rather than something every reader gets for free.
 */
export const SEARCH_PROJECTION_VERSION = 3;

/**
 * WHERE RECIPIENT CONTACT LIVES IN A SEARCH DOCUMENT.
 *
 * `searchableText` is one column and one `ILIKE`. Anything written into it is
 * matchable by every caller the query lets through, and the query cannot tell
 * afterwards which part of the body produced the hit. That is the right shape
 * for a title, a filename or a Customer ID, and the wrong shape for the
 * address and number an intake request was delivered to.
 *
 * Version 2 put all four intake identifiers into that body. The effect was a
 * surface that disagreed with every other one: the Evidence list, the intake
 * link list and the Reports aggregator all withhold the contact ARMS from a
 * caller without `workflow.intake_recipient_contact.reveal` — because a search
 * box that answers "is this number in this workspace" is an oracle, and a
 * count is an answer — while global search matched the same two values for
 * anyone who could open the page.
 *
 * So the contact goes in its own key inside `searchableMetadataJson`, which is
 * INTERNAL: no route projects it, `toResultRow` does not read it, and the only
 * queries that touch it are the ones a caller's disclosure has authorised.
 * Same document, same write path, one more decision at read time.
 *
 * Lower-cased at write time so the query can lower-case its needle and get
 * case-insensitive matching out of a JSON `string_contains`, which — unlike
 * Prisma's text filters — has no `mode: "insensitive"`.
 */
export const SEARCH_CONTACT_HAYSTACK_KEY = "intakeRecipientContactSearch";

/**
 * The Customer ID, carried on the document so a result row can say WHY it
 * matched without the caller having to re-query the source.
 *
 * It is business metadata rather than contact — the organisation's own
 * reference for its own customer — so it stays in the free-text body as well,
 * matchable by anyone who can read the record. This copy exists for
 * presentation, not for matching.
 */
export const SEARCH_CUSTOMER_ID_KEY = "intakeCustomerId";

/** The four intake identifiers, as the index needs them. */
export type IntakeIdentityFields = {
  /** The organization's own identifier for its customer. */
  customerId: string | null;
  /** The name the operator wrote on the request. */
  recipientLabel: string | null;
  /** The address it was delivered to. */
  recipientEmail: string | null;
  /** The number as typed. */
  recipientPhone: string | null;
  /** The canonical form, so one number written three ways matches. */
  recipientPhoneE164: string | null;
};

/**
 * The gated half of intake identity: the address, the number as typed, and
 * the number canonicalised. Null when the request carried no contact at all,
 * so a document for a copy-link request has no such key rather than an empty
 * one that still confirms the shape.
 */
export function buildIntakeContactHaystack(
  identity: Pick<
    IntakeIdentityFields,
    "recipientEmail" | "recipientPhone" | "recipientPhoneE164"
  > | null | undefined,
): string | null {
  if (!identity) return null;
  const parts = [
    identity.recipientEmail ?? "",
    identity.recipientPhone ?? "",
    identity.recipientPhoneE164 ?? "",
  ].filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const body = sanitiseSearchBody(parts.join("\n").trim());
  return body ? body.toLowerCase() : null;
}

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
  /**
   * The builder that produced this body. Written to the row so a later
   * reindex can tell a current document from one that predates a projection
   * change without re-deriving every document to find out.
   */
  projectionVersion: number;
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
    /** Search-inclusion-audit — `evidence.lockedAt`. Drives the
     *  user-facing "locked" badge on result rows; the lock does
     *  NOT gate visibility (locked evidence remains searchable
     *  for users with access). OPTIONAL — older callers (and
     *  fixtures pre-dating the audit) may omit this field; the
     *  projection treats undefined the same as null (no badge). */
    lockedAt?: Date | null;
    publicVerifyState: string | null;
    storageObjectLockLegalHoldStatus: string | null;
    retentionPolicySource: string | null;
    retentionUntilUtc: Date | null;
    reviewReadyAtUtc: Date | null;
    updatedAt: Date;
  };
  /**
   * EXTERNAL INTAKE IDENTITY — the four values that let an operator find this
   * record by what their own systems call it.
   *
   * Optional: every record NOT created through an intake link simply has none,
   * and an older caller that does not supply them indexes exactly what it
   * indexed before.
   *
   * They are split by WHO MAY MATCH ON THEM. The Customer ID and the
   * recipient label go into `searchableText`, which is a MATCH-ONLY body:
   * the search response projects title, subtitle, summary and states, and
   * never the indexed text. The address and the number go into the gated
   * contact haystack instead — see `SEARCH_CONTACT_HAYSTACK_KEY` — because
   * an unrestricted `ILIKE` over them turns the search box into an
   * "is this number in this workspace" oracle for callers the rest of the
   * product does not let ask.
   */
  intakeIdentity?: {
    /** The organization's own identifier for its customer. */
    customerId: string | null;
    /** The name the operator wrote on the request. */
    recipientLabel: string | null;
    /** The address it was delivered to. */
    recipientEmail: string | null;
    /** The number as typed. */
    recipientPhone: string | null;
    /** The canonical form, so one number written three ways matches. */
    recipientPhoneE164: string | null;
  } | null;
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

import { isSearchIndexableLifecycle } from "./search-readiness.js";

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
  // Search-inclusion-audit (trash decision):
  // Soft-deleted evidence (deletedAt IS NOT NULL but still
  // restorable during the retention window) IS searchable. The
  // result row is marked with an "in_trash" tag so the UI can
  // render an "In trash" badge and route the user to the safe
  // (read-only / restore-only) detail surface. Only the two
  // lifecycle TERMINAL states (DESTROYED and PENDING_DESTRUCTION)
  // remain excluded — those records are either gone or about to
  // be gone and cannot be restored.
  //
  // Note: hard-deleted evidence (the actual DB row removed) is
  // physically absent from the source table and therefore cannot
  // reach this builder at all; the indexer's `findFirst` returns
  // null and the caller treats that as `evidence_not_found`.
  // Phase 27 lifecycle terminal states — must NOT surface in search.
  //
  // The DECISION comes from `isSearchIndexableLifecycle`, the one authority
  // the counting queries also resolve through. When this rule and the query
  // that counts "how many records should be indexed" disagree, the disagreement
  // surfaces as a permanent "N of M" that no amount of indexing can close.
  const lifecycle = (evidence.lifecycleState ?? "ACTIVE").toUpperCase();
  if (!isSearchIndexableLifecycle(lifecycle)) {
    return {
      ok: false,
      reason:
        lifecycle === "DESTROYED"
          ? "lifecycle_destroyed"
          : "lifecycle_pending_destruction",
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

  const intake = input.intakeIdentity ?? null;
  const bodyParts = [
    evidence.title ?? "",
    evidence.displayFileName ?? "",
    evidence.originalFileName ?? "",
    /*
     * The identifiers an operator types when they are looking for one record
     * among thousands: a customer number off their own file, and the name
     * they addressed the request to. Neither is a contact detail — a Customer
     * ID is the organisation's reference for its own customer, and the label
     * is what the workspace itself wrote on the request — so both are
     * matchable by anyone who can read the record.
     *
     * The address and the number are NOT here. They are the same two columns
     * the recipient-contact policy governs everywhere else, and they live in
     * the gated haystack below so that matching on them stays a decision.
     */
    intake?.customerId ?? "",
    intake?.recipientLabel ?? "",
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
      // Internal to the document — never projected onto a result row. The
      // first is matched only for a caller whose disclosure allows it; the
      // second is read back so a row can say which identifier it matched.
      [SEARCH_CONTACT_HAYSTACK_KEY]: buildIntakeContactHaystack(intake),
      [SEARCH_CUSTOMER_ID_KEY]: intake?.customerId ?? null,
    }),
    searchableTags: sanitiseSearchTags([
      evidence.type,
      publicVerifyState,
      legalHoldState ? "legal_hold" : null,
      evidence.archivedAt ? "archived" : null,
      // Search-inclusion-audit — surface lockedAt as a "locked"
      // tag so executeSearch's toResultRow can promote it onto
      // the result badges. The lock does not gate visibility
      // (locked evidence stays searchable for users with access)
      // but mutation surfaces respect it; the badge tells the
      // user actions on this row are gated.
      evidence.lockedAt ? "locked" : null,
      // Search-inclusion-audit (trash decision) — soft-deleted
      // records remain searchable; tagged so the UI renders the
      // "In trash" chip and the result row routes to the safe
      // (read-only / restore-only) detail surface.
      evidence.deletedAt ? "in_trash" : null,
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
    projectionVersion: SEARCH_PROJECTION_VERSION,
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
    projectionVersion: SEARCH_PROJECTION_VERSION,
  };
  return { ok: true, projection };
}

// -----------------------------------------------------------------------------
// Intake link projection
// -----------------------------------------------------------------------------

export type IntakeLinkProjectionInput = {
  teamId: string;
  /** Already-fetched source row, narrowed to safe fields. */
  link: {
    id: string;
    teamId: string | null;
    customerId: string | null;
    recipientLabel: string | null;
    recipientEmail: string | null;
    recipientPhone: string | null;
    recipientPhoneE164: string | null;
    workflowTemplateSlug: string | null;
    intakeMode: string | null;
    status: string;
    caseId: string | null;
    expiresAtUtc: Date | null;
    revokedAtUtc: Date | null;
    archivedAtUtc: Date | null;
    usedCount: number;
    updatedAt: Date;
  };
};

/**
 * THE REQUEST, AS A THING THAT CAN BE FOUND.
 *
 * An intake link is the only record of a request that has been sent and not
 * yet answered, and it holds the identity an operator searches by. Without a
 * document of its own that identity reached the index only once evidence came
 * back, so the moment a search was most likely to be run — "did we ask this
 * customer yet, and what happened?" — was the moment global search had
 * nothing.
 *
 * WHAT THIS DOCUMENT SAYS OUT LOUD. Title is the operator's own label, or the
 * Customer ID when there is no label, or a generic name: never an address and
 * never a number, because the title is projected onto the result row and read
 * by everyone the workspace lets search.
 *
 * WHAT IT DOES NOT SAY. The token, the token hash, the IP allowlist, the
 * consent text and the template snapshot are all absent. The recipient
 * address and number are present only in the gated haystack.
 *
 * There is no lifecycle exclusion here on purpose: a revoked, expired or
 * archived request is still a request that was made, and an operator asking
 * what happened to a customer needs the closed ones most. The state is
 * carried on the row instead, as `workflowState` and a tag, so the surface
 * can say so.
 */
export function buildIntakeLinkProjection(
  input: IntakeLinkProjectionInput,
): ProjectionResult {
  const { link } = input;
  if (link.teamId && link.teamId !== input.teamId) {
    return { ok: false, reason: "team_mismatch", deleteFromIndex: false };
  }

  const label = sanitiseSearchString(link.recipientLabel, SEARCH_TITLE_MAX_CHARS);
  const customerId = sanitiseSearchString(link.customerId, SEARCH_TITLE_MAX_CHARS);
  const title = label ?? customerId ?? `Intake request ${link.id.slice(0, 8)}…`;

  const now = Date.now();
  const expired =
    link.expiresAtUtc instanceof Date && link.expiresAtUtc.getTime() <= now;
  const state = link.revokedAtUtc
    ? "REVOKED"
    : expired
      ? "EXPIRED"
      : (link.status ?? "ACTIVE");

  const projection: SearchDocumentProjection = {
    teamId: input.teamId,
    documentType: "INTAKE_LINK",
    sourceId: link.id,
    title,
    subtitle: sanitiseSearchString(
      customerId && label ? `Customer ID ${customerId}` : link.workflowTemplateSlug,
      SEARCH_SUBTITLE_MAX_CHARS,
    ),
    summary: sanitiseSearchString(
      `External intake request · ${state.toLowerCase().replace(/_/g, " ")}`,
      SEARCH_SUMMARY_MAX_CHARS,
    ),
    // Business metadata and the workspace's own label. Not contact.
    searchableText: sanitiseSearchBody(
      [link.customerId ?? "", link.recipientLabel ?? ""]
        .filter((s) => s.length > 0)
        .join("\n")
        .trim(),
    ),
    searchableMetadata: safeMetadataSnapshot({
      intakeMode: link.intakeMode,
      templateSlug: link.workflowTemplateSlug,
      status: link.status,
      usedCount: link.usedCount,
      expiresAtUtc: link.expiresAtUtc?.toISOString() ?? null,
      [SEARCH_CONTACT_HAYSTACK_KEY]: buildIntakeContactHaystack(link),
      [SEARCH_CUSTOMER_ID_KEY]: link.customerId ?? null,
    }),
    searchableTags: sanitiseSearchTags([
      "intake_request",
      link.intakeMode,
      state,
      link.archivedAtUtc ? "archived" : null,
    ]),
    visibilityScope: null,
    governanceScope: { status: link.status },
    reviewState: null,
    workflowState: state,
    /*
     * A request has no export state, and saying "INTERNAL" is not a harmless
     * default: the result row turns that into an "Export-restricted" badge,
     * which reads as a restriction somebody imposed on this record. Nobody
     * did — an intake request is simply not a thing that gets exported. Null
     * leaves it out of both arms of the export filter, which is the truthful
     * answer for a record the question does not apply to.
     */
    exportState: null,
    retentionState: null,
    legalHoldState: null,
    /*
     * An intake request is addressed to somebody outside the workspace, which
     * is exactly what this flag records elsewhere — evidence that arrived
     * through one is contributor-scoped for the same reason. The row renders
     * a "contributor-scoped" badge, which is true and useful here.
     */
    contributorScoped: true,
    reviewerRestricted: false,
    evidenceId: null,
    workflowInstanceId: null,
    workflowStepInstanceId: null,
    caseId: link.caseId ?? null,
    claimRef: null,
    matterRef: null,
    sourceUpdatedAtUtc: link.updatedAt,
    projectionVersion: SEARCH_PROJECTION_VERSION,
  };
  return { ok: true, projection };
}

// -----------------------------------------------------------------------------
// Validation helper — used by API + worker before upsert.
// -----------------------------------------------------------------------------

export function isAllowedSearchDocumentType(value: string): value is SearchDocumentType {
  return SearchDocumentTypeSchema.safeParse(value).success;
}
