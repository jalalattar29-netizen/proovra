/**
 * Phase 31.9 — Verification package advisory intelligence manifests.
 *
 * Produces the OPTIONAL advisory JSON files that a verification
 * package may carry alongside the canonical integrity artifacts.
 * Every manifest in this module is:
 *
 *   * Additive only — downstream tooling MUST work
 *     without any of these files. If the input data is absent, no
 *     manifest is emitted.
 *   * Advisory only — disclaimers carried inline. Manifests NEVER
 *     claim authenticity, admissibility, or proof.
 *   * Bounded — every string is length-capped, every list is
 *     bounded, every enum is checked against a closed catalog.
 *   * Anti-leak — NO storage_key, storage_bucket, signed URLs,
 *     multipart_upload_id, raw GPS, private notes, legal notes,
 *     reviewer-private data, or internal IDs.
 *   * Stable schema — every manifest declares `schema` + `version`
 *     so downstream consumers can pin a known shape.
 *
 * The five manifests are:
 *
 *   1. media_intelligence.json — bounded list of media signals for
 *      this evidence with severity / confidence / safe summary.
 *   2. derived_assets_manifest.json — bounded list of derived
 *      assets (thumbnails / frames / waveforms) with their own
 *      SHA-256 hashes and source linkage.
 *   3. ocr_transcript_manifest.json — provenance pointers for OCR
 *      and transcript availability + indexing state. NEVER carries
 *      raw OCR text or transcript prose in this manifest — that
 *      stays in the indexed search store. Operators with reviewer
 *      permission see the prose via the search surface, not via
 *      this manifest.
 *   4. graph_relationships.json — bounded list of investigation
 *      graph edges incident to this evidence. Anti-enumeration:
 *      stale edges are excluded; the manifest never references
 *      nodes from other workspaces.
 *   5. timeline_manifest.json — bounded chronological list of
 *      lifecycle / run / signal events for this evidence. The
 *      same projection the /v1/graph/timeline route uses.
 *
 * NEVER include a forbidden vocabulary word in any string field.
 * The source-contract test enforces this on every literal in this
 * file.
 */

// =============================================================================
// Public input shape
// =============================================================================

export type IntelligencePackageInput = {
  /** Optional media intelligence signals. Each item is a bounded
   *  projection; the full server-side row is NOT carried. */
  mediaSignals?: ReadonlyArray<{
    id: string;
    signalType: string;
    materialId: string | null;
    severity: "INFO" | "REVIEW_RECOMMENDED" | "ATTENTION";
    confidence: "LOW" | "MEDIUM" | "HIGH";
    safeSummary: string;
    status: "PENDING" | "ACKNOWLEDGED" | "DISMISSED";
    createdAtUtc: string;
  }>;
  /** Optional derived assets — each carries its own SHA-256 and
   *  links back to source material/evidence. The bytes themselves
   *  are NOT carried in this manifest. */
  derivedAssets?: ReadonlyArray<{
    id: string;
    assetKind:
      | "image_thumbnail"
      | "video_frame"
      | "audio_waveform"
      | "low_res_proxy";
    sourceEvidenceId: string;
    sourceMaterialId: string | null;
    sha256: string;
    sizeBytes: number;
    contentType: string;
    createdAtUtc: string;
  }>;
  /** OCR + transcript availability + indexing state. Provenance
   *  only — raw extracted text/prose is NEVER included here. */
  ocrTranscript?: {
    ocr?: ReadonlyArray<{
      materialId: string;
      availability: "AVAILABLE" | "PENDING" | "UNSUPPORTED";
      indexed: boolean;
      extractedAtUtc: string | null;
      engineVersion: string | null;
    }>;
    transcript?: ReadonlyArray<{
      materialId: string;
      availability: "AVAILABLE" | "PENDING" | "UNSUPPORTED";
      indexed: boolean;
      extractedAtUtc: string | null;
      engineVersion: string | null;
    }>;
  };
  /** Investigation graph edges incident to this evidence. Stale
   *  edges (deleted via retention/destruction) MUST already be
   *  filtered out by the caller — this module trusts but bounds. */
  graphRelationships?: ReadonlyArray<{
    edgeId: string;
    edgeType: string;
    sourceNodeKind: string;
    targetNodeKind: string;
    sourceNodeExternalId: string | null;
    targetNodeExternalId: string | null;
    safeSummary: string;
    createdAtUtc: string;
  }>;
  /** Timeline events bounded to this evidence. Matches the shape
   *  emitted by /v1/graph/timeline. */
  timelineEvents?: ReadonlyArray<{
    id: string;
    kind: string;
    atUtc: string;
    summary: string;
    nodeId: string;
    otherNodeId: string | null;
    edgeType: string | null;
  }>;
};

// =============================================================================
// Bounds + catalogs
// =============================================================================

const MAX_MEDIA_SIGNALS = 200;
const MAX_DERIVED_ASSETS = 200;
const MAX_OCR_ENTRIES = 200;
const MAX_TRANSCRIPT_ENTRIES = 200;
const MAX_GRAPH_EDGES = 400;
const MAX_TIMELINE_EVENTS = 400;
const SUMMARY_CHAR_MAX = 240;
const IDENT_CHAR_MAX = 120;

// Package signal-scope filter. Workspace/corpus CORRELATION signals
// reference OTHER evidence / files / similarity-search results in the
// owning workspace. They must NOT appear in a verification package by
// default — a package can be shared outside the workspace, and these
// signals would leak internal corpus context. Only file-LOCAL technical
// observations (EXIF/MIME/codec/availability/capture-time) are package-
// safe. The deterministic technical metadata lives separately under
// technical-metadata/.
//
// TODO(internal-package-mode): when a restricted/internal package mode
// is introduced, that mode MAY include these signals, clearly labelled
// as restricted workspace-correlation observations. Until then the
// default (and only) behaviour is to exclude them.

const ALLOWED_SEVERITIES = new Set(["INFO", "REVIEW_RECOMMENDED", "ATTENTION"]);
const ALLOWED_CONFIDENCES = new Set(["LOW", "MEDIUM", "HIGH"]);
const ALLOWED_STATUSES = new Set(["PENDING", "ACKNOWLEDGED", "DISMISSED"]);
const ALLOWED_DERIVED_KINDS = new Set([
  "image_thumbnail",
  "video_frame",
  "audio_waveform",
  "low_res_proxy",
]);
const ALLOWED_AVAILABILITY = new Set([
  "AVAILABLE",
  "PENDING",
  "UNSUPPORTED",
]);

const ADVISORY_DISCLAIMER =
  "These observations are advisory only. They are deterministic, machine-derived metadata observations of the recorded material. They do not classify the content and they do not establish legal weight; reviewer judgment and the canonical custody record remain authoritative.";

// =============================================================================
// Output type (one entry per emitted manifest)
// =============================================================================

export type IntelligencePackageManifestEntry = {
  path: string;
  json: unknown;
};

// =============================================================================
// Entry point
// =============================================================================

/**
 * Build the bounded set of advisory manifests. Returns ONLY the
 * manifests for which input data was supplied — when no
 * intelligence is provided, returns an empty array (the package
 * shape is unchanged in that case).
 */
export function buildIntelligencePackageManifests(
  input: IntelligencePackageInput | null | undefined,
): ReadonlyArray<IntelligencePackageManifestEntry> {
  if (!input) return [];
  const out: IntelligencePackageManifestEntry[] = [];

  // advisory-signals.json + the deprecated media_intelligence.json alias
  // are NO LONGER EMITTED (product decision). They carried only low-value
  // advisory/workspace-correlation observations (duplicate/similar
  // material) without hashes or reviewer-actionable proof, which added no
  // forensic value to the verification package. Deterministic, file-local
  // technical metadata now lives exclusively under technical-metadata/
  // (media-summary.json + exif-summary.json + capture-environment.json),
  // which is emitted by verification-package-technical-metadata.ts. The
  // signal pipeline + DB rows are intentionally left intact — only the
  // package output is removed. `input.mediaSignals` is consequently
  // ignored here; the `buildMediaIntelligenceManifest` builder and the
  // PACKAGE_RESTRICTED_SIGNAL_TYPES set are retained (dead in the default
  // package path) so a future internal/full package mode can re-enable a
  // clearly-labelled, restricted-signal-free advisory file if needed.

  if (input.derivedAssets && input.derivedAssets.length > 0) {
    out.push({
      path: "intelligence/derived_assets_manifest.json",
      json: buildDerivedAssetsManifest(input.derivedAssets),
    });
  }
  if (
    input.ocrTranscript &&
    ((input.ocrTranscript.ocr && input.ocrTranscript.ocr.length > 0) ||
      (input.ocrTranscript.transcript &&
        input.ocrTranscript.transcript.length > 0))
  ) {
    out.push({
      path: "intelligence/ocr_transcript_manifest.json",
      json: buildOcrTranscriptManifest(input.ocrTranscript),
    });
  }
  if (input.graphRelationships && input.graphRelationships.length > 0) {
    out.push({
      path: "intelligence/graph_relationships.json",
      json: buildGraphRelationshipsManifest(input.graphRelationships),
    });
  }
  if (input.timelineEvents && input.timelineEvents.length > 0) {
    out.push({
      path: "intelligence/timeline_manifest.json",
      json: buildTimelineManifest(input.timelineEvents),
    });
  }

  return out;
}

// =============================================================================
// Manifest builders
// =============================================================================

// Exported for unit-test coverage of the bounded-output contract and for
// a future internal/full package mode. NOT emitted in the default
// verification package (see buildIntelligencePackageManifests).
export function buildMediaIntelligenceManifest(
  signals: NonNullable<IntelligencePackageInput["mediaSignals"]>,
) {
  return {
    schema: "PROOVRA_PACKAGE_MEDIA_INTELLIGENCE",
    version: 1,
    generatedAtUtc: new Date().toISOString(),
    advisory: ADVISORY_DISCLAIMER,
    count: Math.min(signals.length, MAX_MEDIA_SIGNALS),
    items: signals.slice(0, MAX_MEDIA_SIGNALS).map((s) => ({
      id: bound(s.id, IDENT_CHAR_MAX),
      signalType: bound(s.signalType, IDENT_CHAR_MAX),
      materialId: s.materialId ? bound(s.materialId, IDENT_CHAR_MAX) : null,
      severity: ALLOWED_SEVERITIES.has(s.severity) ? s.severity : "INFO",
      confidence: ALLOWED_CONFIDENCES.has(s.confidence)
        ? s.confidence
        : "LOW",
      status: ALLOWED_STATUSES.has(s.status) ? s.status : "PENDING",
      safeSummary: bound(s.safeSummary, SUMMARY_CHAR_MAX),
      createdAtUtc: bound(s.createdAtUtc, 40),
    })),
  };
}

function buildDerivedAssetsManifest(
  assets: NonNullable<IntelligencePackageInput["derivedAssets"]>,
) {
  return {
    schema: "PROOVRA_PACKAGE_DERIVED_ASSETS",
    version: 1,
    generatedAtUtc: new Date().toISOString(),
    advisory:
      "Derived assets are operator-facing thumbnails and previews provided as advisory aids only. They are not a substitute for the preserved original material.",
    algorithm: "SHA-256",
    count: Math.min(assets.length, MAX_DERIVED_ASSETS),
    items: assets.slice(0, MAX_DERIVED_ASSETS).map((a) => ({
      id: bound(a.id, IDENT_CHAR_MAX),
      assetKind: ALLOWED_DERIVED_KINDS.has(a.assetKind)
        ? a.assetKind
        : "low_res_proxy",
      sourceEvidenceId: bound(a.sourceEvidenceId, IDENT_CHAR_MAX),
      sourceMaterialId: a.sourceMaterialId
        ? bound(a.sourceMaterialId, IDENT_CHAR_MAX)
        : null,
      sha256: bound(a.sha256, 64),
      sizeBytes: clampInt(a.sizeBytes, 0, Number.MAX_SAFE_INTEGER),
      contentType: bound(a.contentType, 80),
      createdAtUtc: bound(a.createdAtUtc, 40),
    })),
  };
}

function buildOcrTranscriptManifest(
  ot: NonNullable<IntelligencePackageInput["ocrTranscript"]>,
) {
  return {
    schema: "PROOVRA_PACKAGE_OCR_TRANSCRIPT",
    version: 1,
    generatedAtUtc: new Date().toISOString(),
    advisory:
      "OCR and transcript availability is recorded here as advisory provenance. The raw extracted text lives in the indexed search store and is not duplicated in this manifest.",
    ocr: (ot.ocr ?? []).slice(0, MAX_OCR_ENTRIES).map((o) => ({
      materialId: bound(o.materialId, IDENT_CHAR_MAX),
      availability: ALLOWED_AVAILABILITY.has(o.availability)
        ? o.availability
        : "PENDING",
      indexed: Boolean(o.indexed),
      extractedAtUtc: o.extractedAtUtc ? bound(o.extractedAtUtc, 40) : null,
      engineVersion: o.engineVersion ? bound(o.engineVersion, 80) : null,
    })),
    transcript: (ot.transcript ?? [])
      .slice(0, MAX_TRANSCRIPT_ENTRIES)
      .map((t) => ({
        materialId: bound(t.materialId, IDENT_CHAR_MAX),
        availability: ALLOWED_AVAILABILITY.has(t.availability)
          ? t.availability
          : "PENDING",
        indexed: Boolean(t.indexed),
        extractedAtUtc: t.extractedAtUtc ? bound(t.extractedAtUtc, 40) : null,
        engineVersion: t.engineVersion ? bound(t.engineVersion, 80) : null,
      })),
  };
}

function buildGraphRelationshipsManifest(
  edges: NonNullable<IntelligencePackageInput["graphRelationships"]>,
) {
  return {
    schema: "PROOVRA_PACKAGE_GRAPH_RELATIONSHIPS",
    version: 1,
    generatedAtUtc: new Date().toISOString(),
    advisory:
      "Graph relationships are deterministic, advisory observations of links between records in this workspace. They do not establish factual links between people or events.",
    count: Math.min(edges.length, MAX_GRAPH_EDGES),
    items: edges.slice(0, MAX_GRAPH_EDGES).map((e) => ({
      edgeId: bound(e.edgeId, IDENT_CHAR_MAX),
      edgeType: bound(e.edgeType, IDENT_CHAR_MAX),
      sourceNodeKind: bound(e.sourceNodeKind, IDENT_CHAR_MAX),
      targetNodeKind: bound(e.targetNodeKind, IDENT_CHAR_MAX),
      sourceNodeExternalId: e.sourceNodeExternalId
        ? bound(e.sourceNodeExternalId, IDENT_CHAR_MAX)
        : null,
      targetNodeExternalId: e.targetNodeExternalId
        ? bound(e.targetNodeExternalId, IDENT_CHAR_MAX)
        : null,
      safeSummary: bound(e.safeSummary, SUMMARY_CHAR_MAX),
      createdAtUtc: bound(e.createdAtUtc, 40),
    })),
  };
}

function buildTimelineManifest(
  events: NonNullable<IntelligencePackageInput["timelineEvents"]>,
) {
  return {
    schema: "PROOVRA_PACKAGE_TIMELINE",
    version: 1,
    generatedAtUtc: new Date().toISOString(),
    advisory:
      "Timeline events are the deterministic record of operational state changes for this evidence. They are advisory; the canonical custody chain remains the authoritative integrity record.",
    count: Math.min(events.length, MAX_TIMELINE_EVENTS),
    events: events.slice(0, MAX_TIMELINE_EVENTS).map((ev) => ({
      id: bound(ev.id, IDENT_CHAR_MAX),
      kind: bound(ev.kind, IDENT_CHAR_MAX),
      atUtc: bound(ev.atUtc, 40),
      summary: bound(ev.summary, SUMMARY_CHAR_MAX),
      nodeId: bound(ev.nodeId, IDENT_CHAR_MAX),
      otherNodeId: ev.otherNodeId ? bound(ev.otherNodeId, IDENT_CHAR_MAX) : null,
      edgeType: ev.edgeType ? bound(ev.edgeType, IDENT_CHAR_MAX) : null,
    })),
  };
}

// =============================================================================
// Internals
// =============================================================================

function bound(s: string, max: number): string {
  if (typeof s !== "string") return "";
  return s.slice(0, max);
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
