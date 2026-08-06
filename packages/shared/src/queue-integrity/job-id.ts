/**
 * PHASE 12 — POINT 5: deterministic job identity.
 *
 * One live job per (job kind, durable authority row). The id is derived, never
 * generated, so a duplicate producer call collapses at the queue instead of
 * scheduling a second execution of the same command.
 */

import { QueuePayloadRejected } from "./payload.js";

/** Deterministic job id: `<prefix>-<commandId>`. */
export function buildCanonicalJobId(
  entry: { jobIdPrefix: string },
  commandId: string,
): string {
  const id = commandId.trim();
  if (!id) {
    throw new QueuePayloadRejected(
      "missing_command_id",
      "buildCanonicalJobId: commandId is required",
    );
  }
  return `${entry.jobIdPrefix}-${id}`;
}

// ===========================================================================
// Composite command ids
// ===========================================================================

/**
 * A few families address a target that needs a bounded kind alongside its id —
 * the search projection rebuilds six document types, and which type to rebuild
 * is a SCHEMA fact, not an authority fact.
 *
 * Rather than widen the payload (and hand every future producer a free-form
 * field to smuggle things into), those families encode the kind into
 * `commandId` as `<kind>:<sourceId>`. The kind is validated against a CLOSED
 * catalog before any database access, so an unknown or injected kind fails the
 * job before it can touch a row.
 *
 * The catalog is exactly what the processor implements — no more. Before
 * Point 5 there were THREE definitions of this list: the api producer and the
 * worker producer each declared six kinds (`evidence`, `workflow_instance`,
 * `workflow_step`, `review_event`, `operational_incident`, `case`) while the
 * processor implemented a different six (`evidence`, `workflow_instance`,
 * `workflow_step`, `ocr_text`, `transcript`, `relationship`). A producer that
 * enqueued `review_event`, `operational_incident` or `case` therefore produced
 * a job the processor silently discarded as `unsupported_kind` — a schema
 * mismatch no type check could see, because the two definitions never met.
 *
 * The three unimplemented kinds are removed rather than stubbed: a kind that
 * cannot be indexed should fail at the producer, not be accepted and dropped.
 */
export const SEARCH_INDEX_DOCUMENT_KINDS = [
  "evidence",
  "workflow_instance",
  "workflow_step",
  "ocr_text",
  "transcript",
  "relationship",
] as const;

export type SearchIndexDocumentKind =
  (typeof SEARCH_INDEX_DOCUMENT_KINDS)[number];

export function isSearchIndexDocumentKind(
  v: unknown,
): v is SearchIndexDocumentKind {
  return (
    typeof v === "string" &&
    (SEARCH_INDEX_DOCUMENT_KINDS as ReadonlyArray<string>).includes(v)
  );
}

export function buildSearchIndexCommandId(
  kind: SearchIndexDocumentKind,
  sourceId: string,
): string {
  const id = sourceId.trim();
  if (!isSearchIndexDocumentKind(kind)) {
    throw new QueuePayloadRejected(
      "unknown_document_kind",
      `buildSearchIndexCommandId: "${String(kind)}" is not a known document kind`,
    );
  }
  if (!id) {
    throw new QueuePayloadRejected(
      "missing_command_id",
      "buildSearchIndexCommandId: sourceId is required",
    );
  }
  return `${kind}:${id}`;
}

export function parseSearchIndexCommandId(commandId: string): {
  kind: SearchIndexDocumentKind;
  sourceId: string;
} {
  const idx = commandId.indexOf(":");
  const kind = idx === -1 ? "" : commandId.slice(0, idx);
  const sourceId = idx === -1 ? "" : commandId.slice(idx + 1).trim();
  if (!isSearchIndexDocumentKind(kind)) {
    throw new QueuePayloadRejected(
      "unknown_document_kind",
      "parseSearchIndexCommandId: unknown document kind",
    );
  }
  if (!sourceId) {
    throw new QueuePayloadRejected(
      "missing_command_id",
      "parseSearchIndexCommandId: sourceId is required",
    );
  }
  return { kind, sourceId };
}

/**
 * The media-intelligence family addresses (kind, evidenceId) the same way.
 *
 * The kind selects which extraction runs. It is bounded here so a payload
 * cannot name an extraction the processor does not implement — and, more
 * importantly, cannot name a MODEL or PROVIDER, which are policy decisions the
 * worker reloads rather than accepts.
 */
export const MEDIA_INTELLIGENCE_JOB_KINDS = [
  "analyze_metadata",
  "extract_exif",
  "extract_assets",
  "compute_perceptual_hashes",
  "extract_ocr_azure",
  "extract_transcript_deepgram",
  "wire_ocr_transcript",
  "reindex",
  "extract_technical_metadata",
  "reconcile",
  // PHASE 12 POINT 5. The text-similarity promotion path used to be selected
  // by an optional `textKind: "OCR" | "TRANSCRIPT"` field on the queue payload
  // alongside `kind: "reconcile"`. No producer anywhere in the tree ever set
  // it, so the branch was unreachable — a real capability with no way in.
  //
  // Rather than delete the capability or keep an unreachable branch, the two
  // variants become run kinds of their own. The `MediaIntelligenceRun` row now
  // records which similarity pass was requested, which means the processor
  // reads it from the durable authority like everything else, and an operator
  // can see from the run row which pass ran.
  "reconcile_ocr_similarity",
  "reconcile_transcript_similarity",
] as const;

export type MediaIntelligenceJobKind =
  (typeof MEDIA_INTELLIGENCE_JOB_KINDS)[number];

export function isMediaIntelligenceJobKind(
  v: unknown,
): v is MediaIntelligenceJobKind {
  return (
    typeof v === "string" &&
    (MEDIA_INTELLIGENCE_JOB_KINDS as ReadonlyArray<string>).includes(v)
  );
}

export function buildMediaIntelligenceCommandId(
  kind: MediaIntelligenceJobKind,
  evidenceId: string,
): string {
  const id = evidenceId.trim();
  if (!isMediaIntelligenceJobKind(kind)) {
    throw new QueuePayloadRejected(
      "unknown_media_intelligence_kind",
      `buildMediaIntelligenceCommandId: "${String(kind)}" is not a known kind`,
    );
  }
  if (!id) {
    throw new QueuePayloadRejected(
      "missing_command_id",
      "buildMediaIntelligenceCommandId: evidenceId is required",
    );
  }
  return `${kind}:${id}`;
}

export function parseMediaIntelligenceCommandId(commandId: string): {
  kind: MediaIntelligenceJobKind;
  evidenceId: string;
} {
  const idx = commandId.indexOf(":");
  const kind = idx === -1 ? "" : commandId.slice(0, idx);
  const evidenceId = idx === -1 ? "" : commandId.slice(idx + 1).trim();
  if (!isMediaIntelligenceJobKind(kind)) {
    throw new QueuePayloadRejected(
      "unknown_media_intelligence_kind",
      "parseMediaIntelligenceCommandId: unknown kind",
    );
  }
  if (!evidenceId) {
    throw new QueuePayloadRejected(
      "missing_command_id",
      "parseMediaIntelligenceCommandId: evidenceId is required",
    );
  }
  return { kind, evidenceId };
}

/**
 * The graph domain sync addresses (domain, workspaceId).
 *
 * The domain is a NARROWING filter — "re-sync only EXTERNAL_REVIEW for this
 * workspace" — so an operator can repair one misbehaving projection without
 * re-running the full reconcile. It used to ride on the payload as an optional
 * free-form field, which meant an unknown value produced a job the processor
 * silently completed as a no-op.
 *
 * Encoding it into the command id makes it validated BEFORE any database
 * access, against exactly the catalog the graph builder implements. `all` is a
 * real member of the catalog rather than a null: an absent filter and an
 * unknown filter must not be the same value.
 */
export const GRAPH_SYNC_DOMAINS = [
  "all",
  "CASE",
  "REPORT",
  "VERIFICATION_PACKAGE",
  "EXPORT",
  "REVIEW_TASK",
  "ESCALATION",
  "INCIDENT",
  "EXTERNAL_REVIEW",
] as const;

export type GraphSyncDomain = (typeof GRAPH_SYNC_DOMAINS)[number];

export function isGraphSyncDomain(v: unknown): v is GraphSyncDomain {
  return (
    typeof v === "string" &&
    (GRAPH_SYNC_DOMAINS as ReadonlyArray<string>).includes(v)
  );
}

export function buildGraphDomainCommandId(
  domain: GraphSyncDomain | null | undefined,
  workspaceId: string,
): string {
  const id = workspaceId.trim();
  const d = domain ?? "all";
  if (!isGraphSyncDomain(d)) {
    throw new QueuePayloadRejected(
      "unknown_graph_domain",
      `buildGraphDomainCommandId: "${String(domain)}" is not a known graph domain`,
    );
  }
  if (!id) {
    throw new QueuePayloadRejected(
      "missing_command_id",
      "buildGraphDomainCommandId: workspaceId is required",
    );
  }
  return `${d}:${id}`;
}

export function parseGraphDomainCommandId(commandId: string): {
  domain: GraphSyncDomain;
  workspaceId: string;
} {
  const idx = commandId.indexOf(":");
  const domain = idx === -1 ? "" : commandId.slice(0, idx);
  const workspaceId = idx === -1 ? "" : commandId.slice(idx + 1).trim();
  if (!isGraphSyncDomain(domain)) {
    throw new QueuePayloadRejected(
      "unknown_graph_domain",
      "parseGraphDomainCommandId: unknown graph domain",
    );
  }
  if (!workspaceId) {
    throw new QueuePayloadRejected(
      "missing_command_id",
      "parseGraphDomainCommandId: workspaceId is required",
    );
  }
  return { domain, workspaceId };
}
