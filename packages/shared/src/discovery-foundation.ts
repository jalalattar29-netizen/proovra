/**
 * Phase 28-E — Enterprise discovery foundation.
 *
 * ARCHITECTURE PRIMITIVES ONLY. This module deliberately does NOT
 * ship a search engine, a ranker, or an analytics surface. It ships:
 *
 *   1. The catalog of searchable entity kinds.
 *   2. The canonical safe-document shapes the indexer would emit
 *      (sanitized, no PII / no private notes / no raw evidence
 *      bytes / no secrets).
 *   3. Discovery filter contracts (visibility, governance, retention,
 *      legal-hold).
 *   4. The typed indexing-event shape any future indexer can consume.
 *
 * No engine, no API endpoints, no DB schema. The point is that when
 * Phase 29 picks up search, the safe-shape contracts already exist
 * and the indexer doesn't have to re-derive privacy boundaries.
 *
 * Hard rules:
 *   - Browser-safe. No Prisma, no Node.
 *   - Every projection function NEVER returns properties outside the
 *     declared safe shape — the returned type's properties are
 *     enumerated explicitly so a regression triggers a type error.
 *   - The forbidden-field catalogs are exported so the test suite
 *     can assert no projection accidentally lets one through.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Catalog of searchable entity kinds
// -----------------------------------------------------------------------------

export const SEARCHABLE_ENTITY_KINDS = [
  "evidence",
  "case",
  "review_task",
  "escalation",
  "incident",
  "external_review_share",
  "verification_package",
  "operational_event",
] as const;

export const SearchableEntityKindSchema = z.enum(SEARCHABLE_ENTITY_KINDS);
export type SearchableEntityKind = z.infer<typeof SearchableEntityKindSchema>;

// -----------------------------------------------------------------------------
// Common safe-document envelope
// -----------------------------------------------------------------------------

/**
 * The envelope every safe-document shares. A future indexer keys on
 * `entityKind + entityId`; visibility filters fan-out from this
 * shape.
 */
export type SafeDocumentEnvelope = {
  entityKind: SearchableEntityKind;
  entityId: string;
  teamId: string | null;
  indexedAtUtc: string;
  /** Stable visibility classification — drives the discovery filter
   *  contract. */
  visibility: "public_verify_eligible" | "workspace_internal" | "operator_only";
  /** Governance tags carried alongside the document. */
  governance: {
    /** Snapshot of lifecycle state at index time. */
    lifecycleState: string | null;
    /** True if the document is governance-blocked from external surfacing. */
    governanceBlocked: boolean;
    /** True if the document carries a legal hold. */
    underLegalHold: boolean;
  };
};

// -----------------------------------------------------------------------------
// Per-kind safe-document shapes (strict projections — see test suite)
// -----------------------------------------------------------------------------

export type SafeEvidenceDocument = SafeDocumentEnvelope & {
  entityKind: "evidence";
  type: string | null;
  mimeType: string | null;
  title: string | null;
  displayFileName: string | null;
  capturedAtUtc: string | null;
  verificationStatus: string | null;
  fileSha256: string | null;
};

export type SafeCaseDocument = SafeDocumentEnvelope & {
  entityKind: "case";
  caseRef: string | null;
  title: string | null;
  status: string | null;
};

export type SafeReviewTaskDocument = SafeDocumentEnvelope & {
  entityKind: "review_task";
  workflowId: string;
  status: string | null;
  slaStatus: string | null;
};

export type SafeEscalationDocument = SafeDocumentEnvelope & {
  entityKind: "escalation";
  reason: string;
  severity: string;
  status: string;
};

export type SafeIncidentDocument = SafeDocumentEnvelope & {
  entityKind: "incident";
  category: string;
  severity: string;
  status: string;
  title: string;
};

export type SafeExternalReviewShareDocument = SafeDocumentEnvelope & {
  entityKind: "external_review_share";
  shareState: string;
  expiresAtUtc: string | null;
};

export type SafeVerificationPackageDocument = SafeDocumentEnvelope & {
  entityKind: "verification_package";
  version: number;
  generatedAtUtc: string | null;
};

export type SafeOperationalEventDocument = SafeDocumentEnvelope & {
  entityKind: "operational_event";
  eventType: string;
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
};

export type SafeSearchableDocument =
  | SafeEvidenceDocument
  | SafeCaseDocument
  | SafeReviewTaskDocument
  | SafeEscalationDocument
  | SafeIncidentDocument
  | SafeExternalReviewShareDocument
  | SafeVerificationPackageDocument
  | SafeOperationalEventDocument;

// -----------------------------------------------------------------------------
// Discovery filter contracts
// -----------------------------------------------------------------------------

/**
 * What an indexer / search engine must apply BEFORE returning results
 * to a caller. The names match the canonical decision helpers'
 * outcomes so a discovery surface can deny consistently.
 */
export type DiscoveryFilterDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "tenant_isolation"
        | "visibility_redacted"
        | "blocked_by_hold"
        | "blocked_by_lifecycle"
        | "blocked_by_retention"
        | "blocked_by_external_access_policy"
        | "blocked_by_governance";
    };

export type DiscoveryFilterFacts = {
  callerTeamId: string;
  callerIsExternalReviewer: boolean;
  document: SafeDocumentEnvelope;
};

/**
 * Pure visibility / governance filter. Any non-allowed return value
 * means the result MUST NOT be surfaced to the caller. The reason
 * codes map cleanly onto the canonical decision outcomes used
 * everywhere else in the platform.
 */
export function applyDiscoveryFilter(
  facts: DiscoveryFilterFacts,
): DiscoveryFilterDecision {
  const doc = facts.document;
  // Tenant isolation — always first.
  if (doc.teamId && doc.teamId !== facts.callerTeamId) {
    return { allowed: false, reason: "tenant_isolation" };
  }
  // External reviewers can only see public-verify-eligible documents.
  if (
    facts.callerIsExternalReviewer &&
    doc.visibility !== "public_verify_eligible"
  ) {
    return { allowed: false, reason: "visibility_redacted" };
  }
  // Operator-only documents are hidden from external reviewers.
  if (
    facts.callerIsExternalReviewer &&
    doc.visibility === "operator_only"
  ) {
    return { allowed: false, reason: "visibility_redacted" };
  }
  // Governance blockers — drift, hold, lifecycle.
  if (doc.governance.underLegalHold && facts.callerIsExternalReviewer) {
    return { allowed: false, reason: "blocked_by_hold" };
  }
  if (doc.governance.governanceBlocked) {
    return { allowed: false, reason: "blocked_by_governance" };
  }
  // Destroyed / retention-locked lifecycle states are hidden from
  // external reviewers; operators still see them.
  if (
    facts.callerIsExternalReviewer &&
    (doc.governance.lifecycleState === "DESTROYED" ||
      doc.governance.lifecycleState === "PENDING_DESTRUCTION" ||
      doc.governance.lifecycleState === "RETENTION_LOCKED")
  ) {
    return { allowed: false, reason: "blocked_by_lifecycle" };
  }
  return { allowed: true };
}

// -----------------------------------------------------------------------------
// Indexing events
// -----------------------------------------------------------------------------

export const INDEXING_EVENT_KINDS = [
  "evidence_created",
  "review_assigned",
  "escalation_opened",
  "incident_opened",
  "package_generated",
  "external_review_shared",
  "lifecycle_changed",
] as const;

export type IndexingEventKind = (typeof INDEXING_EVENT_KINDS)[number];

export type IndexingEvent = {
  kind: IndexingEventKind;
  entityKind: SearchableEntityKind;
  entityId: string;
  teamId: string | null;
  emittedAtUtc: string;
  /** Bounded operator-safe payload. NEVER carries notes / secrets. */
  safePayload: Record<string, string | number | boolean | null>;
};

/**
 * Sink contract — any future indexer registers a `recordIndexingEvent`
 * implementation. The default is a no-op so callers can emit events
 * before a real indexer exists.
 */
export type IndexingEventSink = (event: IndexingEvent) => void | Promise<void>;

let activeIndexingSink: IndexingEventSink = () => {
  /* no-op default */
};

export function registerIndexingEventSink(sink: IndexingEventSink): void {
  activeIndexingSink = sink;
}

export function emitIndexingEvent(event: IndexingEvent): void | Promise<void> {
  return activeIndexingSink(event);
}

// -----------------------------------------------------------------------------
// Forbidden-field catalogs (exported for test suite)
// -----------------------------------------------------------------------------

/**
 * Every safe-document shape MUST NOT contain any of these keys. The
 * test suite enumerates each per-kind projection and asserts none of
 * these keys appear.
 */
export const DISCOVERY_FORBIDDEN_FIELDS = [
  "internalNotes",
  "privateReviewerNote",
  "decisionNote",
  "pausedReason",
  "rejectionReason",
  "submittedByEmail",
  "ownerUserId",
  "createdByUserId",
  "uploadedByUserId",
  "lastAccessedByUserId",
  "signatureBase64",
  "publicKeyPem",
  "tsaTokenBase64",
  "otsProofBase64",
  "storageBucket",
  "storageKey",
  "secret",
  "token",
  "apiKey",
  "credential",
  "password",
] as const;

export type DiscoveryForbiddenField = (typeof DISCOVERY_FORBIDDEN_FIELDS)[number];
