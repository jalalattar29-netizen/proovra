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
  NormalisedBox,
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
  /**
   * UC-DER-003 — the widest frame handed to OCR. Keyframes shown to a reviewer
   * stay small (`reviewKeyframeMaxWidthPx`); OCR reads a separate, temp-only
   * rendition at native resolution up to this width, so on-screen text is not
   * shrunk below what the OCR engine can read.
   */
  ocrFrameMaxWidthPx: 1600,
  /** The persisted review keyframe (thumbnail) width ceiling. */
  reviewKeyframeMaxWidthPx: 256,
} as const;

/**
 * UC-DER-001 / UC-DER-006 — GENERATIONS.
 *
 * Every Generate / Retry / Regenerate is a NEW generation with its own run row
 * (idempotency key carries the generation), its own keyframe variants and its
 * own `recon-v<N>` descriptor. A prior generation is never overwritten or
 * deleted: once the new one succeeds its rows are marked SUPERSEDED and keep
 * their objects. Generation 1 keeps the historical key/variant names so rows
 * written before generations existed stay generation 1.
 */
export const SCREEN_RECONSTRUCTION_RUN_KIND = "reconstruct_screen" as const;

export function screenReconstructionIdempotencyKey(evidenceId: string, generation: number): string {
  const g = Math.max(1, Math.trunc(generation));
  return g === 1
    ? `${SCREEN_RECONSTRUCTION_RUN_KIND}:${evidenceId}`
    : `${SCREEN_RECONSTRUCTION_RUN_KIND}:${evidenceId}:g${g}`;
}

/** The generation a run's idempotency key names (legacy key ⇒ 1). Null if not a UC-4 key. */
export function parseScreenReconstructionGeneration(idempotencyKey: string | null | undefined): number | null {
  if (!idempotencyKey) return null;
  const m = /^reconstruct_screen:[0-9a-f-]{36}(?::g(\d{1,6}))?$/i.exec(idempotencyKey);
  if (!m) return null;
  return m[1] ? Number(m[1]) : 1;
}

/** The descriptor's derived-asset variant for a generation: recon-v1, recon-v2, … */
export function screenReconstructionVariantKey(generation: number): string {
  return `recon-v${Math.max(1, Math.trunc(generation))}`;
}

/** How OCR stood for a run — policy and runtime are different facts (UC-DER-008). */
export type ScreenOcrStatus = "ENABLED" | "DISABLED_BY_POLICY" | "RUNTIME_UNAVAILABLE";

/**
 * AUD-003 — what OCR actually PRODUCED for a run, as one explicit value. The
 * status above says whether OCR was allowed to run; this says what came of it,
 * so "the source has no text" is never confused with "OCR never read it":
 *
 *   TEXT_FOUND            every attempted keyframe was read and text was recognised
 *   NO_TEXT_PRESENT       every attempted keyframe was read; none had recognisable text
 *   PARTIAL_FAILURE       some keyframes were read, the engine failed on others
 *   ATTEMPTED_ALL_FAILED  OCR was attempted and failed on EVERY keyframe
 *   NO_FRAMES_PROCESSED   OCR could run but no keyframe reached it
 *   OCR_DISABLED          the workspace policy keeps OCR off
 *   ENGINE_UNAVAILABLE    the local OCR engine is missing on the worker
 *   LANGUAGE_UNAVAILABLE  no requested language model is installed on the worker
 */
export const SCREEN_OCR_OUTCOMES = [
  "TEXT_FOUND",
  "NO_TEXT_PRESENT",
  "PARTIAL_FAILURE",
  "ATTEMPTED_ALL_FAILED",
  "NO_FRAMES_PROCESSED",
  "OCR_DISABLED",
  "ENGINE_UNAVAILABLE",
  "LANGUAGE_UNAVAILABLE",
] as const;
export type ScreenOcrOutcome = (typeof SCREEN_OCR_OUTCOMES)[number];

/** AUD-003 — per-keyframe OCR accounting. attempted = succeeded + failed. */
export type ScreenOcrCounts = {
  keyframesAttempted: number;
  keyframesSucceeded: number;
  keyframesFailed: number;
};

/**
 * AUD-019 — the OCR language models: what was asked for, what actually ran
 * (requested ∩ installed, "+"-joined in request order; null when nothing ran)
 * and which requested models were missing. A language that did not run is
 * never recorded as the effective one.
 */
export type ScreenOcrLanguages = {
  requested: string | null;
  effective: string | null;
  missing: string[];
};

/** PURE — the one rule that turns OCR status + counts into an outcome. */
export function assessScreenOcrOutcome(input: {
  ocrStatus: ScreenOcrStatus;
  counts: ScreenOcrCounts;
  observationCount: number;
  languages?: ScreenOcrLanguages | null;
}): ScreenOcrOutcome {
  const { ocrStatus, counts, observationCount, languages } = input;
  if (ocrStatus === "DISABLED_BY_POLICY") return "OCR_DISABLED";
  if (ocrStatus === "RUNTIME_UNAVAILABLE") {
    return languages && !languages.effective && languages.missing.length > 0
      ? "LANGUAGE_UNAVAILABLE"
      : "ENGINE_UNAVAILABLE";
  }
  if (counts.keyframesAttempted <= 0) return "NO_FRAMES_PROCESSED";
  if (counts.keyframesSucceeded <= 0) return "ATTEMPTED_ALL_FAILED";
  if (counts.keyframesFailed > 0) return "PARTIAL_FAILURE";
  return observationCount > 0 ? "TEXT_FOUND" : "NO_TEXT_PRESENT";
}

/** PURE — the limitations an OCR outcome imposes on the derived result by itself. */
export function screenOcrLimitations(input: {
  outcome: ScreenOcrOutcome;
  counts: ScreenOcrCounts;
  observationCount: number;
  languages?: ScreenOcrLanguages | null;
}): ReconstructionLimitationCode[] {
  const out: ReconstructionLimitationCode[] = [];
  if (input.outcome === "ENGINE_UNAVAILABLE") out.push("RECONSTRUCTION_OCR_RUNTIME_UNAVAILABLE");
  if (input.outcome === "LANGUAGE_UNAVAILABLE" || (input.languages?.missing.length ?? 0) > 0) {
    out.push("RECONSTRUCTION_OCR_LANGUAGE_UNAVAILABLE");
  }
  if (input.counts.keyframesFailed > 0) out.push("RECONSTRUCTION_OCR_EXTRACTION_FAILED");
  if (input.observationCount === 0) out.push("RECONSTRUCTION_NO_OBSERVATIONS");
  return out;
}

/**
 * PURE — THE derived-coverage rule (AUD-003). COMPLETE only when OCR read every
 * attempted keyframe AND recognised text, the acquisition was complete, the
 * reconstruction proved continuity, and nothing else degraded the run. A
 * labelled possible duplicate is a reading caveat, not missing coverage. Zero
 * successful OCR, any failed keyframe, or an empty reconstruction is PARTIAL.
 */
export function screenDerivedCoverage(input: {
  outcome: ScreenOcrOutcome;
  acquisitionComplete: boolean;
  reconstructionCoverage: ReconstructionCoverage;
  limitations: ReadonlyArray<ReconstructionLimitationCode>;
}): ReconstructionCoverage {
  const degrading = input.limitations.filter((l) => l !== "RECONSTRUCTION_POSSIBLE_DUPLICATE");
  return input.outcome === "TEXT_FOUND" &&
    input.acquisitionComplete &&
    input.reconstructionCoverage === "COMPLETE" &&
    degrading.length === 0
    ? "COMPLETE"
    : "PARTIAL";
}

/**
 * The OCR truth of a persisted descriptor, for EVERY read model. Descriptors
 * written before AUD-003 carry no outcome or counts and may have recorded
 * COMPLETE over failed or empty OCR; they are re-read here (stored bytes are
 * never rewritten) so no surface repeats that overclaim.
 */
export function resolveScreenOcrTruth(
  d: Pick<
    ScreenIntelligenceDescriptor,
    "ocrEnabled" | "ocrProvider" | "coverage" | "limitations" | "acquisitionComplete" | "stats"
  > & {
    ocrStatus?: ScreenOcrStatus;
    ocrOutcome?: ScreenOcrOutcome;
    ocrCounts?: ScreenOcrCounts;
    ocrLanguages?: ScreenOcrLanguages;
  },
): {
  ocrStatus: ScreenOcrStatus;
  ocrOutcome: ScreenOcrOutcome;
  ocrCounts: ScreenOcrCounts;
  ocrLanguages: ScreenOcrLanguages;
  coverage: ReconstructionCoverage;
  limitations: ReconstructionLimitationCode[];
} {
  const ocrStatus = resolveScreenOcrStatus(d);
  const failed = Math.max(0, d.stats?.ocrFailedKeyframes ?? 0);
  const ocrCounts: ScreenOcrCounts = d.ocrCounts ?? (() => {
    // Legacy: every keyframe up to the OCR bound was attempted when OCR ran.
    const attempted =
      ocrStatus === "ENABLED"
        ? Math.min(Math.max(0, d.stats?.keyframeCount ?? 0), UC4_RESOURCE_BOUNDS.maxOcrKeyframes)
        : 0;
    const f = Math.min(failed, attempted);
    return { keyframesAttempted: attempted, keyframesSucceeded: attempted - f, keyframesFailed: f };
  })();
  const ocrLanguages: ScreenOcrLanguages = d.ocrLanguages ?? {
    requested: d.ocrProvider?.language ?? null,
    effective: ocrStatus === "ENABLED" ? d.ocrProvider?.language ?? null : null,
    missing: [],
  };
  const observationCount = Math.max(0, d.stats?.observationCount ?? 0);
  const ocrOutcome =
    d.ocrOutcome ??
    assessScreenOcrOutcome({ ocrStatus, counts: ocrCounts, observationCount, languages: ocrLanguages });
  const limitations = [...(d.limitations ?? [])];
  for (const l of screenOcrLimitations({ outcome: ocrOutcome, counts: ocrCounts, observationCount, languages: ocrLanguages })) {
    if (!limitations.includes(l)) limitations.push(l);
  }
  const coverage =
    d.coverage === "COMPLETE"
      ? screenDerivedCoverage({
          outcome: ocrOutcome,
          acquisitionComplete: d.acquisitionComplete,
          reconstructionCoverage: "COMPLETE",
          limitations,
        })
      : "PARTIAL";
  return { ocrStatus, ocrOutcome, ocrCounts, ocrLanguages, coverage, limitations };
}

/** ONE ORIGINAL part as the generation actually READ it (UC-DER-014). */
export type ScreenSourceRead = {
  evidencePartId: string;
  /** The object version read, when the part records one (pinned read). */
  storageVersionId: string | null;
  /** Digest + size recorded for the ORIGINAL part at capture. */
  recordedSha256: string | null;
  recordedSizeBytes: number | null;
  /** What the generation actually read. */
  bytesRead: number;
  readSha256: string;
  /** True when the whole object was read (bytes ended before the bound). */
  wholeSource: boolean;
  /** Whole read: does the read digest equal the recorded one? Null when truncated. */
  digestMatchesRecorded: boolean | null;
};

/** Lineage of ONE generation, carried in its descriptor (UC-DER-005 / 006 / 014). */
export type ScreenIntelligenceGeneration = {
  generation: number;
  runId: string | null;
  producer: string;
  toolVersions: { ffmpeg: string | null; tesseract: string | null };
  /** The canonical generation parameters and their SHA-256 (canonical JSON). */
  parameters: Record<string, unknown>;
  parametersSha256: string;
  sourceReads: ScreenSourceRead[];
  /** The generation this one replaced once it succeeded; null for the first. */
  supersedes: {
    generation: number | null;
    descriptorAssetId: string;
    descriptorSha256: string | null;
  } | null;
  /** SHA-256 of the DERIVED text persisted to the extracted-text authority. */
  extractedTextSha256: { ocr: string | null; reconstruction: string | null };
};

/** Canonical JSON (sorted keys, no whitespace) — the input of parametersSha256. */
export function canonicalParametersJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/**
 * The OCR status a descriptor records, including descriptors written before the
 * field existed: those encoded the reason only in `ocrProvider.version`
 * ("unavailable" = runtime missing, "policy-disabled" = workspace policy).
 */
export function resolveScreenOcrStatus(
  d: Pick<ScreenIntelligenceDescriptor, "ocrEnabled" | "ocrProvider"> & { ocrStatus?: ScreenOcrStatus },
): ScreenOcrStatus {
  if (d.ocrStatus) return d.ocrStatus;
  if (d.ocrEnabled) return "ENABLED";
  return d.ocrProvider?.version === "unavailable" ? "RUNTIME_UNAVAILABLE" : "DISABLED_BY_POLICY";
}

export type Uc4ResourceBounds = typeof UC4_RESOURCE_BOUNDS;

/** Canonical transformation-version stamp carried by every persisted descriptor. */
export const SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS = {
  // v2 — real presentation timestamps of selected frames (v1: index × interval).
  keyframe: "video-keyframe/v2",
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
  /** The frame's real presentation time in its ORIGINAL part (ms after the part's first frame). */
  offsetMs: number;
  /**
   * Its time on the capture SESSION timeline (segment start from the
   * continuity manifest + offsetMs); null when the record has no manifest.
   */
  sessionOffsetMs?: number | null;
  derivedSha256: string | null;
  /** The derived-asset row id, so View Source resolves the private bytes proxy. */
  derivedAssetId: string | null;
  /** UC-DER-006 — the stored object version of this keyframe (null: unversioned / ORIGINAL frame). */
  outputVersionId?: string | null;
  reason: "first" | "interval" | "change";
  /** UC-DER-003 — the pixel size of the frame OCR actually read (null: not OCR'd). */
  ocrInput?: { widthPx: number | null; heightPx: number | null } | null;
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
  /** UC-DER-005 — where on the OCR frame the line was read (normalised 0..1). */
  bbox?: NormalisedBox | null;
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
  /** UC-DER-004 — an unproven repeat of the named earlier block (labelled, not merged). */
  possibleDuplicateOf?: string | null;
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
  ocrProvider: { name: string; version: string; local: boolean; language?: string | null };
  /** False when OCR did not run — see `ocrStatus` for WHY. */
  ocrEnabled: boolean;
  /** UC-DER-008 — policy-off and engine-missing are different facts. */
  ocrStatus?: ScreenOcrStatus;
  /** AUD-003 — what OCR produced (absent on descriptors written before it). */
  ocrOutcome?: ScreenOcrOutcome;
  /** AUD-003 — per-keyframe OCR accounting (absent on earlier descriptors). */
  ocrCounts?: ScreenOcrCounts;
  /** AUD-019 — requested vs effective vs missing OCR language models. */
  ocrLanguages?: ScreenOcrLanguages;
  /**
   * Which timeline observation/block offsets are on: SESSION (every source
   * part's start is known from the continuity manifest) or PART (ms into each
   * part). Absent on earlier descriptors, which are PART.
   */
  offsetTimeline?: "SESSION" | "PART";
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
    /** UC-DER-004 — keyframes byte-identical to the previous one, not re-OCR'd. */
    identicalKeyframesSkipped?: number;
  };
  /** UC-DER-005/006/014 — generation lineage (absent on pre-generation descriptors). */
  generation?: ScreenIntelligenceGeneration;
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
  /** UC-DER-008 — why OCR did or did not run. */
  ocrStatus: ScreenOcrStatus;
  /** AUD-003 — what OCR produced, and the per-keyframe counts behind it. */
  ocrOutcome: ScreenOcrOutcome;
  ocrCounts: ScreenOcrCounts;
  /** AUD-019 — requested vs effective vs missing language models. */
  ocrLanguages: ScreenOcrLanguages;
  /** The language model(s) OCR ACTUALLY ran with (null when it did not run). */
  ocrLanguage: string | null;
  /** Which timeline block offsets are on (SESSION or ms into each PART). */
  offsetTimeline: "SESSION" | "PART";
  coverage: ReconstructionCoverage;
  acquisitionComplete: boolean;
  limitations: ReconstructionLimitationCode[];
  transformationVersions: typeof SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS;
  generatedAtUtc: string;
  stats: ScreenIntelligenceDescriptor["stats"];
  /** UC-DER-005/006 — which generation this is and what produced it (null: legacy). */
  generation: {
    generation: number;
    toolVersions: { ffmpeg: string | null; tesseract: string | null };
    parametersSha256: string;
    supersedesGeneration: number | null;
    sourceTruncated: boolean;
  } | null;
  blockTotal: number;
  page: { offset: number; limit: number };
  blocks: Array<{
    blockId: string;
    sequence: number;
    kind: ReconstructionBlockKind;
    text: string;
    confidence: OverlapConfidence;
    observedInFrames: number;
    /** UC-DER-004 — labelled possible repeat of this earlier block, or null. */
    possibleDuplicateOf: string | null;
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
        possibleDuplicateOf: b.possibleDuplicateOf ?? null,
        sources,
      };
    });
  const g = descriptor.generation;
  // AUD-003 — coverage, limitations and the OCR outcome come from the ONE
  // resolver, so a legacy descriptor's overclaim is corrected on read.
  const ocr = resolveScreenOcrTruth(descriptor);
  return {
    schemaVersion: descriptor.schemaVersion,
    descriptorVersion: descriptor.descriptorVersion,
    provenance: {
      reconstructed: DERIVED_RECONSTRUCTED_PROVENANCE,
      machineExtracted: DERIVED_TEXT_PROVENANCE,
    },
    ocrEnabled: descriptor.ocrEnabled,
    ocrStatus: ocr.ocrStatus,
    ocrOutcome: ocr.ocrOutcome,
    ocrCounts: ocr.ocrCounts,
    ocrLanguages: ocr.ocrLanguages,
    ocrLanguage: ocr.ocrLanguages.effective,
    offsetTimeline: descriptor.offsetTimeline ?? "PART",
    coverage: ocr.coverage,
    acquisitionComplete: descriptor.acquisitionComplete,
    limitations: ocr.limitations,
    transformationVersions: descriptor.transformationVersions,
    generatedAtUtc: descriptor.generatedAtUtc,
    stats: descriptor.stats,
    generation: g
      ? {
          generation: g.generation,
          toolVersions: g.toolVersions,
          parametersSha256: g.parametersSha256,
          supersedesGeneration: g.supersedes?.generation ?? null,
          sourceTruncated: g.sourceReads.some((r) => !r.wholeSource),
        }
      : null,
    blockTotal: descriptor.blocks.length,
    page: { offset, limit },
    blocks: pageBlocks,
  };
}
