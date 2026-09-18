/**
 * UC-4 — the CANONICAL persisted descriptor for derived screen intelligence, and
 * the ONE resource authority that bounds the pipeline.
 *
 * The reconstruction PRODUCT is persisted as a single versioned JSON descriptor
 * (one `screen_reconstruction` EvidencePartDerivedAsset whose object bytes ARE
 * this descriptor). It carries the full DERIVED lineage so every review surface —
 * Inspector, View Source, Search, Report, Verification Package, Validator — reads
 * ONE authority and can trace any reconstructed block back to the ORIGINAL
 * EvidencePart it was observed in:
 *
 *   block → observationIds → observation (keyframeId + evidencePartId + offsetMs)
 *         → keyframe (evidencePartId, derived-asset variantKey) → ORIGINAL part.
 *
 * ABSOLUTE LAW (see screen-reconstruction.ts): everything here is DERIVED. A
 * keyframe is DERIVED, OCR text is DERIVED_MACHINE_EXTRACTED, a reconstructed
 * block is DERIVED_RECONSTRUCTED. A VISIBLE_LABEL is not a verified identity and a
 * VISIBLE_TIMESTAMP is not a provider-verified time. Nothing here is ORIGINAL and
 * nothing here mutates or replaces ORIGINAL bytes.
 */

import {
  DERIVED_RECONSTRUCTED_PROVENANCE,
  DERIVED_TEXT_PROVENANCE,
} from "./evidence-acquisition.js";
import type {
  ReconstructionBlockKind,
  ReconstructionCoverage,
  ReconstructionLimitationCode,
  OverlapConfidence,
} from "./screen-reconstruction.js";

/** The persisted descriptor schema version. Bumping it is a transformation-version event. */
export const SCREEN_INTELLIGENCE_DESCRIPTOR_VERSION = "PROOVRA_SCREEN_INTELLIGENCE_V1" as const;

/**
 * THE ONE UC-4 resource authority. Every bound the pipeline enforces lives here,
 * so there are no scattered magic numbers. Reaching a bound degrades the DERIVED
 * result to PARTIAL — it NEVER invalidates ORIGINAL evidence and never OOMs.
 */
export const UC4_RESOURCE_BOUNDS = {
  /** Max ORIGINAL parts a single run will process (UC-2 frames or UC-3 segments). */
  maxSourceParts: 500,
  /** Bounded source byte read per part (defence against runaway temp writes). */
  maxSourceReadBytesPerPart: 64 * 1024 * 1024,
  /** ffmpeg keyframe sampling interval (ms) — feeds produceVideoKeyframes. */
  keyframeIntervalMs: 1500,
  /** Hard ceiling on keyframes extracted PER video part. */
  maxKeyframesPerPart: 240,
  /** Hard ceiling on keyframes OCR'd across the whole run (bounds OCR cost). */
  maxOcrKeyframes: 2000,
  /** Max OCR text bytes persisted to the extracted-text authority (search body). */
  maxOcrTextBytes: 256 * 1024,
  /** Max reconstructed-text bytes persisted to the extracted-text authority. */
  maxReconstructedTextBytes: 256 * 1024,
  /** Max observations retained (mirrors SCREEN_RECONSTRUCTION_BOUNDS). */
  maxObservations: 20000,
  /** Max reconstructed blocks retained. */
  maxBlocks: 20000,
  /** Max derived bytes (keyframes + descriptor) a single run may persist. */
  maxDerivedBytesPerRun: 128 * 1024 * 1024,
  /** OCR keyframe decode concurrency (one temp file at a time keeps disk bounded). */
  ocrConcurrency: 1,
  /** Inspector / API page size for keyframes + blocks. */
  inspectorPageSize: 100,
  /** Max descriptor object bytes (a bound on the persisted JSON itself). */
  maxDescriptorBytes: 24 * 1024 * 1024,
} as const;

export type Uc4ResourceBounds = typeof UC4_RESOURCE_BOUNDS;

/** Canonical transformation-version stamp carried by every persisted descriptor. */
export const SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS = {
  keyframe: "video-keyframe/v1",
  ocr: "screen-ocr/v1",
  overlap: "screen-overlap-analysis/v1",
  dedup: "SCREEN_CONTENT_DEDUP_V1",
  reconstruction: "screen-conversation-reconstruction/v1",
} as const;

/** ONE source ORIGINAL part, mapping the pipeline's partIndex to real identity. */
export type ScreenSourcePart = {
  partIndex: number;
  evidencePartId: string;
  /** The ORIGINAL part digest AT generation — equals evidence integrity's digest. */
  sourceSha256: string | null;
  mimeType: string | null;
  /** How the ORIGINAL was acquired (screen_frame = UC-2, screen_segment = UC-3, …). */
  acquisitionRole: string | null;
};

/** ONE persisted keyframe (a DERIVED asset), source-linked to its ORIGINAL part. */
export type ScreenKeyframeRecord = {
  keyframeId: string;
  partIndex: number;
  evidencePartId: string;
  variantKey: string;
  offsetMs: number;
  derivedSha256: string | null;
  /** The derived-asset row id, so View Source resolves the private bytes proxy. */
  derivedAssetId: string | null;
  reason: "first" | "interval" | "change";
};

/** ONE machine-extracted observation with full ORIGINAL lineage. */
export type ScreenObservationRecord = {
  id: string;
  keyframeId: string;
  sourcePartIndex: number;
  evidencePartId: string;
  sourceOffsetMs: number;
  frameOrder: number;
  rowOrder: number;
  /** Machine-extracted text — DERIVED_MACHINE_EXTRACTED, never verified truth. */
  text: string;
  kind: ReconstructionBlockKind;
  fingerprint: string | null;
  /** Technical OCR confidence, ADVISORY only, present iff the engine returned it. */
  confidence: number | null;
};

/** ONE reconstructed block (DERIVED_RECONSTRUCTED), source-linked many-to-many. */
export type ScreenBlockRecord = {
  blockId: string;
  sequence: number;
  kind: ReconstructionBlockKind;
  text: string;
  confidence: OverlapConfidence;
  observationIds: string[];
  sourcePartIndexes: number[];
  /** Resolved ORIGINAL parts (so navigation is a direct id lookup, not an index guess). */
  sourceEvidencePartIds: string[];
  sourceOffsetMsRange: [number, number];
  observedInFrames: number;
};

/**
 * THE canonical persisted descriptor. Stored as the object bytes of the single
 * `screen_reconstruction` derived asset. Versioned + regenerable + deletable
 * (destruction sweeps the derived-asset row + object by evidenceId).
 */
export type ScreenIntelligenceDescriptor = {
  schemaVersion: typeof SCREEN_INTELLIGENCE_DESCRIPTOR_VERSION;
  descriptorVersion: number;
  transformation: "screen-conversation-reconstruction/v1";
  transformationVersions: typeof SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS;
  generatedAtUtc: string;
  ocrProvider: { name: string; version: string; local: boolean };
  /** False when workspace AI policy disabled OCR — a deterministic-only run. */
  ocrEnabled: boolean;
  /** ORIGINAL acquisition completeness, carried separately from derived coverage. */
  acquisitionComplete: boolean;
  /** DERIVED reconstruction coverage — NEVER upgrades acquisition completeness. */
  coverage: ReconstructionCoverage;
  limitations: ReconstructionLimitationCode[];
  stats: {
    sourcePartCount: number;
    keyframeCount: number;
    ocrRegionCount: number;
    ocrFailedKeyframes: number;
    observationCount: number;
    blockCount: number;
    derivedBytes: number;
  };
  sources: ScreenSourcePart[];
  keyframes: ScreenKeyframeRecord[];
  observations: ScreenObservationRecord[];
  blocks: ScreenBlockRecord[];
};

/**
 * A bounded, review-safe projection for the Inspector / API. It carries the
 * ordered blocks + coverage + limitations + per-block source links, but drops
 * internal noise (raw fingerprints, full observation dumps) and paginates.
 * Provenance markers are explicit so a surface can label DERIVED content.
 */
export type ScreenIntelligenceReviewProjection = {
  schemaVersion: typeof SCREEN_INTELLIGENCE_DESCRIPTOR_VERSION;
  descriptorVersion: number;
  provenance: {
    reconstructed: typeof DERIVED_RECONSTRUCTED_PROVENANCE;
    machineExtracted: typeof DERIVED_TEXT_PROVENANCE;
  };
  ocrEnabled: boolean;
  coverage: ReconstructionCoverage;
  acquisitionComplete: boolean;
  limitations: ReconstructionLimitationCode[];
  transformationVersions: typeof SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS;
  generatedAtUtc: string;
  stats: ScreenIntelligenceDescriptor["stats"];
  blockTotal: number;
  page: { offset: number; limit: number };
  blocks: Array<{
    blockId: string;
    sequence: number;
    kind: ReconstructionBlockKind;
    text: string;
    confidence: OverlapConfidence;
    observedInFrames: number;
    /** View Source targets: the ORIGINAL parts + keyframes this block came from. */
    sources: Array<{
      evidencePartId: string;
      keyframeIds: string[];
      offsetMsRange: [number, number];
    }>;
  }>;
};

/**
 * PURE: build the bounded review projection from a persisted descriptor. No I/O.
 * `keyframeIds` per block are derived by intersecting the block's observation
 * lineage — so the Inspector can request the exact private keyframe bytes.
 */
export function projectScreenIntelligenceForReview(
  descriptor: ScreenIntelligenceDescriptor,
  page: { offset?: number; limit?: number } = {},
): ScreenIntelligenceReviewProjection {
  const offset = Math.max(0, Math.trunc(page.offset ?? 0));
  const limit = Math.min(
    UC4_RESOURCE_BOUNDS.inspectorPageSize,
    Math.max(1, Math.trunc(page.limit ?? UC4_RESOURCE_BOUNDS.inspectorPageSize)),
  );
  const obsById = new Map(descriptor.observations.map((o) => [o.id, o]));
  const pageBlocks = descriptor.blocks
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .slice(offset, offset + limit)
    .map((b) => {
      // Group this block's observation lineage by ORIGINAL part.
      const byPart = new Map<string, Set<string>>();
      for (const obsId of b.observationIds) {
        const obs = obsById.get(obsId);
        if (!obs) continue;
        const set = byPart.get(obs.evidencePartId) ?? new Set<string>();
        set.add(obs.keyframeId);
        byPart.set(obs.evidencePartId, set);
      }
      const sources = [...byPart.entries()].map(([evidencePartId, kfIds]) => ({
        evidencePartId,
        keyframeIds: [...kfIds].sort(),
        offsetMsRange: b.sourceOffsetMsRange,
      }));
      // Fall back to the block's own part linkage if observations were pruned.
      if (sources.length === 0) {
        for (const pid of b.sourceEvidencePartIds) {
          sources.push({ evidencePartId: pid, keyframeIds: [], offsetMsRange: b.sourceOffsetMsRange });
        }
      }
      return {
        blockId: b.blockId,
        sequence: b.sequence,
        kind: b.kind,
        text: b.text,
        confidence: b.confidence,
        observedInFrames: b.observedInFrames,
        sources,
      };
    });
  return {
    schemaVersion: descriptor.schemaVersion,
    descriptorVersion: descriptor.descriptorVersion,
    provenance: {
      reconstructed: DERIVED_RECONSTRUCTED_PROVENANCE,
      machineExtracted: DERIVED_TEXT_PROVENANCE,
    },
    ocrEnabled: descriptor.ocrEnabled,
    coverage: descriptor.coverage,
    acquisitionComplete: descriptor.acquisitionComplete,
    limitations: descriptor.limitations,
    transformationVersions: descriptor.transformationVersions,
    generatedAtUtc: descriptor.generatedAtUtc,
    stats: descriptor.stats,
    blockTotal: descriptor.blocks.length,
    page: { offset, limit },
    blocks: pageBlocks,
  };
}
