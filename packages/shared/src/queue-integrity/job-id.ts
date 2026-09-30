/**
 * PHASE 12 — POINT 5: deterministic job identity.
 *
 * One live job per (job kind, durable authority row). The id is derived, never
 * generated, so a duplicate producer call collapses at the queue instead of
 * scheduling a second execution of the same command.
 */

import { QueuePayloadRejected } from "./payload.js";

/**
 * The one character BullMQ will not accept in a custom job id.
 *
 * It is the Redis key separator, so BullMQ rejects the `add` outright:
 * `Custom Id cannot contain :`. That is a THROW at the producer, not a
 * warning, and `enqueueCanonicalJob` turns it into
 * `{ enqueued: false, reason: "queue_unavailable:..." }` — a soft failure that
 * every caller is designed to tolerate.
 *
 * Three families built composite command ids of the shape `<kind>:<id>`:
 * `buildSearchIndexCommandId`, `buildMediaIntelligenceCommandId` and
 * `buildGraphDomainCommandId` (the last removed with its producerless queue,
 * ET-Q-07, 2026-09-30). Every job those families ever tried to
 * schedule was therefore refused by the queue, silently, from the moment the
 * composite ids were introduced. Search was the visible one: no rebuild could
 * ever be enqueued, so the index was only ever written by the API's INLINE
 * reconcile endpoint — which is exactly why `Rebuild index` worked instantly
 * and nothing else ever did.
 *
 * The command id keeps the colon: it is the SEMANTIC identity, it is what the
 * processor parses, and `parseSearchIndexCommandId` splits on it. Only the
 * TRANSPORT identity is rewritten, and only here, so the two cannot drift.
 */
const QUEUE_ID_FORBIDDEN = /:/g;

/**
 * The replacement.
 *
 * A dot rather than a dash. Dash would collide: the kind vocabularies contain
 * underscores and the ids are UUIDs, both of which already carry dashes, so
 * `<kind>-<uuid>` could in principle be produced by two different (kind, id)
 * pairs. A dot appears in neither vocabulary, so the mapping stays injective
 * and the id remains reversible by eye.
 */
const QUEUE_ID_SEPARATOR = ".";

/**
 * Deterministic job id: `<prefix>-<commandId>`, made legal for the transport.
 *
 * NOTHING IS STRANDED by the rewrite. A job id that BullMQ refused is a job
 * that was never created, so there are no live jobs under the previous form to
 * orphan — unlike a queue NAME, which is a production identity precisely
 * because jobs accumulate under it.
 */
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
  return `${entry.jobIdPrefix}-${id}`.replace(
    QUEUE_ID_FORBIDDEN,
    QUEUE_ID_SEPARATOR,
  );
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
  // UC-4 — DERIVED screen intelligence. ONE run per evidence that extracts
  // bounded DERIVED keyframes from ORIGINAL screen frames/segments, runs LOCAL
  // OCR, and persists a source-linked reconstruction. It rides the existing
  // `media-intelligence` queue as a run kind (like the OCR/transcript kinds) so
  // it reuses the durable MediaIntelligenceRun claim/lease/fence lifecycle — no
  // second queue. The processor reads teamId/evidenceId/kind from the run row,
  // never the wire; the DB `media_intelligence_runs_kind_bounded` CHECK admits it.
  "reconstruct_screen",
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

// ET-Q-07 (2026-09-30) — `GRAPH_SYNC_DOMAINS`, `isGraphSyncDomain`,
// `buildGraphDomainCommandId` and `parseGraphDomainCommandId` were removed with
// the `graph-domain-sync` queue. They existed only to address its command
// (`<domain>:<workspaceId>`); the queue never had a producer, so no such
// command id was ever built outside a test.
