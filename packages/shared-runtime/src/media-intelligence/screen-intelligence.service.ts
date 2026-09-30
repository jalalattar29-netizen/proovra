/**
 * UC-4 — DERIVED screen-intelligence PERSISTENCE orchestrator.
 *
 * The real I/O wiring for the media-free logical pipeline in
 * `@proovra/shared` (`runScreenIntelligence` / `reconstructScreenConversation`).
 * Given the ORIGINAL screen parts of one evidence, it:
 *
 *   ORIGINAL part → (video: bounded ffmpeg keyframes | image: the frame itself)
 *     → persist DERIVED keyframe assets → LOCAL OCR → source-linked observations
 *     → reconstructScreenConversation (THE reconstruction authority)
 *     → persist ONE screen_reconstruction descriptor (object bytes = the JSON)
 *     → persist DERIVED text through the canonical extracted-text authority.
 *
 * Every side-effecting step is INJECTED (`ScreenIntelligenceDeps`) so the whole
 * persistence path is testable with fakes + a real DB + real object storage,
 * while the worker wires ffmpeg + local Tesseract for runtime acceptance.
 *
 * HARD RULES:
 *   * NEVER mutates ORIGINAL bytes; keyframes/descriptor are DERIVED, own their
 *     digest + object key + row, and are covered by destruction / hold / storage
 *     accounting because they are ordinary `evidence_part_derived_assets` rows.
 *   * NEVER throws structural problems to the caller — returns a bounded result.
 *     Only genuinely transient failures (storage/DB) are thrown for retry.
 *   * OCR text is UNTRUSTED — never executed, never interpreted as instruction.
 *   * Bounded by the ONE resource authority (`UC4_RESOURCE_BOUNDS`); reaching a
 *     bound degrades the DERIVED result to PARTIAL, never invalidates ORIGINAL.
 */

import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import {
  canonicalParametersJson,
  keyframeVariantKeyForGeneration,
  reconstructScreenConversation,
  reconstructionCoverageLabel,
  screenReconstructionVariantKey,
  SCREEN_INTELLIGENCE_DESCRIPTOR_VERSION,
  SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS,
  UC4_RESOURCE_BOUNDS,
  type NormalisedBox,
  type OcrExtractResult,
  type ScreenObservation,
  type ScreenIntelligenceDescriptor,
  type ScreenIntelligenceGeneration,
  type ScreenOcrStatus,
  type ScreenSourcePart,
  type ScreenSourceRead,
  type ScreenKeyframeRecord,
  type ScreenObservationRecord,
  type ScreenBlockRecord,
  type ReconstructionLimitationCode,
} from "@proovra/shared";

import { getRegisteredPrisma } from "../prisma-registry.js";
import { recordDerivedAsset, supersedeDerivedAssets } from "./derived-assets.service.js";
import { evaluateDerivedProductionEligibility } from "./derived-production-eligibility.js";

// =============================================================================
// Injected dependencies
// =============================================================================

/** ONE ORIGINAL source part (already workspace-anchored by the caller). */
export type ScreenSourcePartInput = {
  partIndex: number;
  evidencePartId: string;
  storageBucket: string;
  storageKey: string;
  mimeType: string | null;
  sha256: string | null;
  acquisitionRole?: string | null;
  /** UC-DER-014 — the recorded object version; the read is pinned to it. */
  storageVersionId?: string | null;
  /** UC-DER-014 — the recorded ORIGINAL size, to tell a whole read from a capped one. */
  sizeBytes?: number | null;
};

export type KeyframeProducerResult =
  | {
      status: "ok";
      keyframes: Array<{
        index: number;
        offsetMs: number;
        /** The small REVIEW keyframe that is persisted as a derived asset. */
        bytes: Buffer;
        contentType: string;
        derivedSha256: string;
        sizeBytes: number;
        /**
         * UC-DER-003 — a separate, temp-only rendition at OCR resolution. When
         * present OCR reads THIS, never the review thumbnail.
         */
        ocrBytes?: Buffer | null;
        ocrWidthPx?: number | null;
        ocrHeightPx?: number | null;
      }>;
      boundsReached: boolean;
    }
  | { status: "unsupported"; reason: string }
  | { status: "failed"; reason: string };

/** LOCAL OCR over image bytes. */
export type ScreenOcrRunner = {
  name: string;
  version: string;
  local: boolean;
  /** True only when OCR actually runs (policy allows it AND the engine is present). */
  enabled: boolean;
  /**
   * UC-DER-008 — WHY OCR does or does not run. Optional for callers that only
   * know `enabled`: absent ⇒ ENABLED when enabled, otherwise DISABLED_BY_POLICY.
   */
  status?: ScreenOcrStatus;
  /** UC-DER-005 — the language model(s) OCR uses (e.g. "eng+ara"). */
  language?: string | null;
  /** UC-DER-005 — engine parameters that shape the output (e.g. page segmentation). */
  parameters?: Record<string, unknown>;
  extractFromBytes(bytes: Buffer): Promise<OcrExtractResult>;
};

export type ScreenIntelligenceDeps = {
  prisma?: PrismaClient;
  getSourceBytes(input: {
    bucket: string;
    key: string;
    maxBytes: number;
    /** UC-DER-014 — read exactly this recorded object version when there is one. */
    versionId?: string | null;
  }): Promise<Buffer>;
  produceKeyframes(input: {
    sourceBytes: Buffer;
    sourceMimeType: string;
    intervalMs: number;
    maxKeyframes: number;
  }): Promise<KeyframeProducerResult>;
  putKeyframeObject(input: {
    bucket: string;
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<void>;
  /**
   * Retained for the transient-failure path only: an object whose ROW could not
   * be written has no pointer and is removed (unless held). A superseded
   * generation is NEVER deleted (UC-DER-006).
   */
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
  ocr: ScreenOcrRunner;
  /** True while the evidence is under an effective legal hold — blocks any removal. */
  holdActive?: boolean;
  /** UC-DER-005 — the binaries that actually ran (probed, not constants). */
  toolVersions?: { ffmpeg: string | null; tesseract: string | null };
  /**
   * UC-DER-013 — lifecycle re-check before every persist. Defaults to the
   * canonical `evaluateDerivedProductionEligibility`.
   */
  checkEligibility?: () => Promise<{ eligible: boolean; reason?: string }>;
};

export type ScreenIntelligenceInput = {
  teamId: string;
  evidenceId: string;
  parts: ScreenSourcePartInput[];
  /** ORIGINAL acquisition completeness — carried separately, never upgraded. */
  acquisitionComplete: boolean;
  /** UC-DER-001/006 — the generation this run produces (1 = first). */
  generation?: number;
  /** The MediaIntelligenceRun that produced it (lineage). */
  runId?: string | null;
  /** @deprecated use `generation`; kept for callers that still pass it. */
  descriptorVersion?: number;
  bounds?: typeof UC4_RESOURCE_BOUNDS;
};

export type ScreenIntelligenceResult =
  | {
      ok: true;
      status: "COMPLETE" | "PARTIAL";
      coverage: "COMPLETE" | "PARTIAL";
      ocrEnabled: boolean;
      ocrStatus: ScreenOcrStatus;
      generation: number;
      keyframeCount: number;
      observationCount: number;
      blockCount: number;
      derivedBytes: number;
      descriptorAssetId: string | null;
      descriptorSha256: string;
      supersededAssetCount: number;
      limitations: ReconstructionLimitationCode[];
    }
  | { ok: false; reason: string };

// =============================================================================
// Storage-key generation (canonical, never user-controlled)
// =============================================================================

const DERIVED_PREFIX = "derived-assets";
const SCREEN_ENGINE_VERSION = "uc4-screen-intelligence-v1";
/** The producer identity recorded in every generation's lineage. */
export const SCREEN_INTELLIGENCE_PRODUCER = "proovra-worker/uc4-screen-intelligence";

function keyframeObjectKey(
  evidenceId: string,
  evidencePartId: string,
  sha256: string,
): string {
  return `${DERIVED_PREFIX}/${evidenceId}/${evidencePartId}/video_keyframe-${sha256.slice(0, 16)}.webp`;
}

function reconstructionObjectKey(
  evidenceId: string,
  generation: number,
  sha256: string,
): string {
  return `${DERIVED_PREFIX}/${evidenceId}/screen_reconstruction/${screenReconstructionVariantKey(generation)}-${sha256.slice(0, 16)}.json`;
}

/** engine_version is VARCHAR(48): the probed tool identity, bounded. */
function engineVersionFor(tool: string, version: string | null | undefined): string {
  return `${tool}-${version ?? "unknown"}`.slice(0, 48);
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Normalise a pixel box to its frame (0..1). Null when the frame size is unknown. */
function normaliseBox(
  bbox: { top: number; left: number; width: number; height: number } | null | undefined,
  widthPx: number | null | undefined,
  heightPx: number | null | undefined,
): NormalisedBox | null {
  if (!bbox || !widthPx || !heightPx || widthPx <= 0 || heightPx <= 0) return null;
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return {
    top: r(bbox.top / heightPx),
    left: r(bbox.left / widthPx),
    width: r(bbox.width / widthPx),
    height: r(bbox.height / heightPx),
  };
}

class ProductionIneligibleError extends Error {
  constructor(readonly reason: string) {
    super(`evidence_ineligible:${reason}`);
    this.name = "ProductionIneligibleError";
  }
}

// =============================================================================
// The orchestrator
// =============================================================================

export async function runAndPersistScreenIntelligence(
  input: ScreenIntelligenceInput,
  deps: ScreenIntelligenceDeps,
): Promise<ScreenIntelligenceResult> {
  const prisma = deps.prisma ?? getRegisteredPrisma();
  const bounds = input.bounds ?? UC4_RESOURCE_BOUNDS;
  const { teamId, evidenceId } = input;
  const generation = Math.max(1, Math.trunc(input.generation ?? input.descriptorVersion ?? 1));
  const ocrStatus: ScreenOcrStatus =
    deps.ocr.status ?? (deps.ocr.enabled ? "ENABLED" : "DISABLED_BY_POLICY");
  const ocrRuns = deps.ocr.enabled && ocrStatus === "ENABLED";

  // UC-DER-005 — the canonical generation parameters: everything that shapes
  // the derived output, hashed as canonical JSON (parameters_sha256).
  const keyframeParameters = {
    transformation: SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS.keyframe,
    intervalMs: bounds.keyframeIntervalMs,
    maxKeyframesPerPart: bounds.maxKeyframesPerPart,
    reviewKeyframeMaxWidthPx: bounds.reviewKeyframeMaxWidthPx,
    ocrFrameMaxWidthPx: bounds.ocrFrameMaxWidthPx,
    skipIdenticalKeyframes: true,
  };
  const keyframeParametersSha256 = sha256Hex(canonicalParametersJson(keyframeParameters));
  const generationParameters: Record<string, unknown> = {
    keyframe: keyframeParameters,
    ocr: ocrRuns
      ? {
          engine: deps.ocr.name,
          language: deps.ocr.language ?? null,
          ...(deps.ocr.parameters ?? {}),
          maxOcrKeyframes: bounds.maxOcrKeyframes,
        }
      : { status: ocrStatus },
    reconstruction: {
      transformation: SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS.reconstruction,
      overlap: SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS.overlap,
      dedup: SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS.dedup,
    },
    bounds: {
      maxSourceParts: bounds.maxSourceParts,
      maxSourceReadBytesPerPart: bounds.maxSourceReadBytesPerPart,
      maxObservations: bounds.maxObservations,
      maxDerivedBytesPerRun: bounds.maxDerivedBytesPerRun,
    },
  };
  const generationParametersSha256 = sha256Hex(canonicalParametersJson(generationParameters));

  // UC-DER-013 — the lifecycle is re-read before EVERY persist, so a record
  // trashed or destroyed mid-run stops receiving derived writes at the next step.
  const checkEligibility =
    deps.checkEligibility ??
    (async () => evaluateDerivedProductionEligibility(evidenceId, prisma));
  const assertEligible = async () => {
    const e = await checkEligibility();
    if (!e.eligible) throw new ProductionIneligibleError(e.reason ?? "ineligible");
  };

  const parts = [...input.parts]
    .filter((p) => !!p.storageBucket && !!p.storageKey)
    .sort((a, b) => a.partIndex - b.partIndex)
    .slice(0, bounds.maxSourceParts);

  if (parts.length === 0) {
    return { ok: false, reason: "no_source_parts" };
  }

  // Rows THIS generation wrote. If the generation does not complete they are
  // marked FAILED (pointer kept, never current) so an unfinished generation is
  // never mistaken for the current review.
  const writtenThisGeneration: Array<{
    evidencePartId: string;
    assetKind: "video_keyframe" | "screen_reconstruction";
    variantKey: string;
  }> = [];

  try {
    await assertEligible();
    return await produceGeneration();
  } catch (err) {
    await abandonGeneration(err instanceof ProductionIneligibleError ? err.message : "generation_incomplete");
    if (err instanceof ProductionIneligibleError) {
      return { ok: false, reason: err.message };
    }
    throw err;
  }

  async function abandonGeneration(reason: string): Promise<void> {
    for (const w of writtenThisGeneration) {
      await recordDerivedAsset(
        {
          teamId,
          evidenceId,
          evidencePartId: w.evidencePartId,
          assetKind: w.assetKind,
          status: "FAILED",
          lastError: reason,
          engineVersion: SCREEN_ENGINE_VERSION,
          variantKey: w.variantKey,
        },
        prisma,
      ).catch(() => undefined);
    }
  }

  async function produceGeneration(): Promise<ScreenIntelligenceResult> {
    const limitations = new Set<ReconstructionLimitationCode>();
    if (input.parts.length > bounds.maxSourceParts) {
      limitations.add("RECONSTRUCTION_BOUNDS_REACHED");
    }
    if (ocrStatus === "RUNTIME_UNAVAILABLE") {
      limitations.add("RECONSTRUCTION_OCR_RUNTIME_UNAVAILABLE");
    }

    const sources: ScreenSourcePart[] = [];
    const sourceReads: ScreenSourceRead[] = [];
    const keyframeRecords: ScreenKeyframeRecord[] = [];
    const observationRecords: ScreenObservationRecord[] = [];
    const reconstructionObservations: ScreenObservation[] = [];
    const currentAssetIds: string[] = [];

    let derivedBytes = 0;
    let ocrRegionCount = 0;
    let ocrFailedKeyframes = 0;
    let ocrKeyframesProcessed = 0;
    let identicalKeyframesSkipped = 0;
    let frameOrder = 0;
    let obsCounter = 0;
    let ocrLanguage: string | null = deps.ocr.language ?? null;

    for (const part of parts) {
      const mime = (part.mimeType ?? "").toLowerCase();
      const isVideo = mime.startsWith("video/");
      const isImage = mime.startsWith("image/");
      if (!isVideo && !isImage) continue; // UC-4 processes screen frames/segments only

      sources.push({
        partIndex: part.partIndex,
        evidencePartId: part.evidencePartId,
        sourceSha256: part.sha256,
        mimeType: part.mimeType,
        acquisitionRole: part.acquisitionRole ?? null,
      });

      type FrameUnit = {
        keyframeId: string;
        variantKey: string;
        offsetMs: number;
        ocrBytes: Buffer;
        ocrWidthPx: number | null;
        ocrHeightPx: number | null;
        derivedSha256: string;
        derivedAssetId: string | null;
        reason: "first" | "interval" | "change";
      };
      const frames: FrameUnit[] = [];

      let sourceBytes: Buffer;
      try {
        sourceBytes = await deps.getSourceBytes({
          bucket: part.storageBucket,
          key: part.storageKey,
          maxBytes: bounds.maxSourceReadBytesPerPart,
          versionId: part.storageVersionId ?? null,
        });
      } catch (err) {
        // Transient storage failure — surface for retry (never a false COMPLETE).
        throw wrapTransient("source_fetch_failed", err);
      }

      // UC-DER-014 — hash what was READ, and say whether it was the whole source.
      const readSha256 = sha256Hex(sourceBytes);
      const wholeSource =
        part.sizeBytes != null
          ? sourceBytes.byteLength >= part.sizeBytes
          : sourceBytes.byteLength < bounds.maxSourceReadBytesPerPart;
      const digestMatchesRecorded = wholeSource && part.sha256 ? readSha256 === part.sha256 : null;
      sourceReads.push({
        evidencePartId: part.evidencePartId,
        storageVersionId: part.storageVersionId ?? null,
        recordedSha256: part.sha256,
        recordedSizeBytes: part.sizeBytes ?? null,
        bytesRead: sourceBytes.byteLength,
        readSha256,
        wholeSource,
        digestMatchesRecorded,
      });
      if (!wholeSource) limitations.add("RECONSTRUCTION_SOURCE_TRUNCATED");
      const thisRead = sourceReads[sourceReads.length - 1]!;
      // The recorded ORIGINAL digest when the part has one (a whole read has
      // just been proven equal to it; a prefix read says so in its parameters),
      // otherwise the digest of the bytes actually read.
      const sourceDigestAtGeneration = part.sha256 ?? readSha256;
      if (digestMatchesRecorded === false) {
        // The bytes read are NOT the recorded ORIGINAL. Nothing derived from
        // them may be presented as derived from that part.
        await abandonGeneration("source_digest_mismatch");
        return { ok: false, reason: "source_digest_mismatch" };
      }

      if (isVideo) {
        const produced = await deps.produceKeyframes({
          sourceBytes,
          sourceMimeType: part.mimeType ?? "",
          intervalMs: bounds.keyframeIntervalMs,
          maxKeyframes: bounds.maxKeyframesPerPart,
        });
        if (produced.status !== "ok") {
          // ffmpeg unavailable / structural: this part yields no keyframes, the
          // DERIVED result degrades to PARTIAL, ORIGINAL is untouched.
          limitations.add("RECONSTRUCTION_POSSIBLE_GAP");
          continue;
        }
        if (produced.boundsReached) limitations.add("RECONSTRUCTION_BOUNDS_REACHED");
        let previousSha: string | null = null;
        for (const kf of produced.keyframes) {
          // UC-DER-004 — a keyframe byte-identical to the previous one is the
          // same rendered screen: nothing new to review or OCR.
          if (previousSha !== null && kf.derivedSha256 === previousSha) {
            identicalKeyframesSkipped += 1;
            continue;
          }
          previousSha = kf.derivedSha256;
          if (derivedBytes + kf.sizeBytes > bounds.maxDerivedBytesPerRun) {
            limitations.add("RECONSTRUCTION_BOUNDS_REACHED");
            break;
          }
          const variantKey = keyframeVariantKeyForGeneration(kf.index, generation);
          const key = keyframeObjectKey(evidenceId, part.evidencePartId, kf.derivedSha256);
          await assertEligible();
          try {
            await deps.putKeyframeObject({
              bucket: part.storageBucket,
              key,
              body: kf.bytes,
              contentType: kf.contentType,
            });
          } catch (err) {
            throw wrapTransient("keyframe_put_failed", err);
          }
          const persisted = await recordDerivedAsset(
            {
              teamId,
              evidenceId,
              evidencePartId: part.evidencePartId,
              assetKind: "video_keyframe",
              status: "COMPLETED",
              derivedSha256: kf.derivedSha256,
              sizeBytes: kf.sizeBytes,
              contentType: kf.contentType,
              sourceSha256AtGeneration: sourceDigestAtGeneration,
              storageBucket: part.storageBucket,
              storageKey: key,
              engineVersion: engineVersionFor("ffmpeg", deps.toolVersions?.ffmpeg),
              variantKey,
              transformation: SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS.keyframe,
              parametersSha256: keyframeParametersSha256,
              generationParameters: {
                ...keyframeParameters,
                generation,
                tool: { ffmpeg: deps.toolVersions?.ffmpeg ?? null },
                sourceRead: thisRead,
              },
              sourceOffsetMs: kf.offsetMs,
            },
            prisma,
          );
          if (!persisted.ok) {
            // The object landed but its row did not: it has no destroyable
            // pointer. Content-addressed keys can be shared with an earlier
            // generation's row, so only remove it when no row references it.
            if (!deps.holdActive && !(await objectReferenced(prisma, part.storageBucket, key))) {
              try {
                await deps.deleteObject({ bucket: part.storageBucket, key });
              } catch {
                /* best effort; reconciler will catch a rare residue */
              }
            }
            throw wrapTransient(`keyframe_persist_failed:${persisted.reason}`, null);
          }
          writtenThisGeneration.push({
            evidencePartId: part.evidencePartId,
            assetKind: "video_keyframe",
            variantKey,
          });
          currentAssetIds.push(persisted.id);
          derivedBytes += kf.sizeBytes;
          frames.push({
            keyframeId: `p${part.partIndex}-${variantKey}`,
            variantKey,
            offsetMs: kf.offsetMs,
            // UC-DER-003 — OCR reads the full-resolution rendition, never the thumbnail.
            ocrBytes: kf.ocrBytes ?? kf.bytes,
            ocrWidthPx: kf.ocrBytes ? kf.ocrWidthPx ?? null : null,
            ocrHeightPx: kf.ocrBytes ? kf.ocrHeightPx ?? null : null,
            derivedSha256: kf.derivedSha256,
            derivedAssetId: persisted.id,
            reason: kf.index === 0 ? "first" : "interval",
          });
        }
      } else {
        // UC-2 — the ORIGINAL screen_frame IS the image. We OCR it directly and
        // do NOT derive a worse duplicate keyframe (see UC-1 compatibility law).
        // The keyframe record references the ORIGINAL part (derivedAssetId = null).
        frames.push({
          keyframeId: `p${part.partIndex}-frame`,
          variantKey: "frame",
          offsetMs: 0,
          ocrBytes: sourceBytes,
          ocrWidthPx: null,
          ocrHeightPx: null,
          derivedSha256: part.sha256 ?? "",
          derivedAssetId: null,
          reason: "first",
        });
      }

      // OCR each frame (bounded), building source-linked observations.
      for (const frame of frames) {
        const record: ScreenKeyframeRecord = {
          keyframeId: frame.keyframeId,
          partIndex: part.partIndex,
          evidencePartId: part.evidencePartId,
          variantKey: frame.variantKey,
          offsetMs: frame.offsetMs,
          derivedSha256: frame.derivedSha256 || null,
          derivedAssetId: frame.derivedAssetId,
          reason: frame.reason,
          ocrInput: null,
        };
        keyframeRecords.push(record);
        const thisFrameOrder = frameOrder;
        frameOrder += 1;

        if (!ocrRuns) continue; // deterministic-only run (OCR off by policy or runtime)
        if (ocrKeyframesProcessed >= bounds.maxOcrKeyframes) {
          limitations.add("RECONSTRUCTION_BOUNDS_REACHED");
          continue;
        }
        ocrKeyframesProcessed += 1;

        let res: OcrExtractResult;
        try {
          res = await deps.ocr.extractFromBytes(frame.ocrBytes);
        } catch {
          // Degrade this frame only — ORIGINAL + other frames unaffected.
          ocrFailedKeyframes += 1;
          continue;
        }
        const widthPx = res.imageWidthPx ?? frame.ocrWidthPx;
        const heightPx = res.imageHeightPx ?? frame.ocrHeightPx;
        record.ocrInput = { widthPx: widthPx ?? null, heightPx: heightPx ?? null };
        if (res.language && !ocrLanguage) ocrLanguage = res.language;
        const regions = res.regions;
        ocrRegionCount += regions.length;
        for (const region of [...regions].sort((a, b) => a.rowOrder - b.rowOrder)) {
          if (observationRecords.length >= bounds.maxObservations) {
            limitations.add("RECONSTRUCTION_BOUNDS_REACHED");
            break;
          }
          const id = `obs-${obsCounter++}`;
          const fingerprint = region.fingerprint ?? null;
          const bbox = normaliseBox(region.bbox, widthPx, heightPx);
          reconstructionObservations.push({
            id,
            keyframeId: frame.keyframeId,
            sourcePartIndex: part.partIndex,
            sourceOffsetMs: frame.offsetMs,
            frameOrder: thisFrameOrder,
            rowOrder: region.rowOrder,
            text: region.text,
            kind: region.kind,
            fingerprint,
            bbox,
          });
          observationRecords.push({
            id,
            keyframeId: frame.keyframeId,
            sourcePartIndex: part.partIndex,
            evidencePartId: part.evidencePartId,
            sourceOffsetMs: frame.offsetMs,
            frameOrder: thisFrameOrder,
            rowOrder: region.rowOrder,
            text: region.text,
            kind: region.kind,
            fingerprint,
            confidence: region.confidence ?? null,
            bbox,
          });
        }
      }
    }

    // THE reconstruction authority — deterministic, conservative dedup.
    const reconstruction = reconstructScreenConversation(reconstructionObservations);
    for (const l of reconstruction.limitations) limitations.add(l);

    // Resolve each block's source parts to real ids for direct navigation.
    const partIdByIndex = new Map(sources.map((s) => [s.partIndex, s.evidencePartId]));
    const blocks: ScreenBlockRecord[] = reconstruction.blocks.map((b) => ({
      blockId: b.blockId,
      sequence: b.sequence,
      kind: b.kind,
      text: b.text,
      confidence: b.confidence,
      observationIds: b.observationIds,
      sourcePartIndexes: b.sourcePartIndexes,
      sourceEvidencePartIds: b.sourcePartIndexes
        .map((i) => partIdByIndex.get(i))
        .filter((v): v is string => !!v),
      sourceOffsetMsRange: b.sourceOffsetMsRange,
      observedInFrames: b.observedInFrames,
      possibleDuplicateOf: b.possibleDuplicateOf,
    }));

    const baseCoverage = reconstructionCoverageLabel(
      input.acquisitionComplete,
      reconstruction.coverage,
    );
    // DERIVED coverage is COMPLETE only when NOTHING degraded it: OCR ran, the
    // acquisition was complete, the reconstruction proved continuity, AND no
    // bound was hit, no source was truncated and no part failed extraction.
    // A labelled possible duplicate is a reading caveat, not missing coverage.
    const coverageLimitations = [...limitations].filter(
      (l) => l !== "RECONSTRUCTION_POSSIBLE_DUPLICATE",
    );
    const coverage: "COMPLETE" | "PARTIAL" =
      ocrRuns &&
      input.acquisitionComplete &&
      baseCoverage === "COMPLETE" &&
      coverageLimitations.length === 0
        ? "COMPLETE"
        : "PARTIAL";

    // DERIVED text is computed BEFORE the descriptor so the descriptor carries
    // the digest of exactly the text persisted to the extracted-text authority.
    const ocrText =
      ocrRuns && observationRecords.length > 0
        ? boundedJoin(observationRecords.map((o) => o.text), bounds.maxOcrTextBytes)
        : "";
    const reconstructedText =
      blocks.length > 0
        ? boundedJoin(
            blocks
              .slice()
              .sort((a, b) => a.sequence - b.sequence)
              .map((b) => b.text),
            bounds.maxReconstructedTextBytes,
          )
        : "";

    const prior = await readCurrentDescriptorRow(prisma, teamId, evidenceId);

    const generationLineage: ScreenIntelligenceGeneration = {
      generation,
      runId: input.runId ?? null,
      producer: SCREEN_INTELLIGENCE_PRODUCER,
      toolVersions: {
        ffmpeg: deps.toolVersions?.ffmpeg ?? null,
        tesseract: deps.toolVersions?.tesseract ?? (ocrRuns ? deps.ocr.version : null),
      },
      parameters: generationParameters,
      parametersSha256: generationParametersSha256,
      sourceReads,
      supersedes: prior
        ? {
            generation: parseReconVariantGeneration(prior.variant_key),
            descriptorAssetId: prior.id,
            descriptorSha256: prior.derived_sha256,
          }
        : null,
      extractedTextSha256: {
        ocr: ocrText ? sha256Hex(ocrText) : null,
        reconstruction: reconstructedText ? sha256Hex(reconstructedText) : null,
      },
    };

    const descriptor: ScreenIntelligenceDescriptor = {
      schemaVersion: SCREEN_INTELLIGENCE_DESCRIPTOR_VERSION,
      descriptorVersion: generation,
      transformation: "screen-conversation-reconstruction/v1",
      transformationVersions: SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS,
      generatedAtUtc: new Date().toISOString(),
      ocrProvider: {
        name: deps.ocr.name,
        version: deps.ocr.version,
        local: deps.ocr.local,
        language: ocrRuns ? ocrLanguage : null,
      },
      ocrEnabled: ocrRuns,
      ocrStatus,
      acquisitionComplete: input.acquisitionComplete,
      coverage,
      limitations: [...limitations],
      stats: {
        sourcePartCount: sources.length,
        keyframeCount: keyframeRecords.length,
        ocrRegionCount,
        ocrFailedKeyframes,
        observationCount: observationRecords.length,
        blockCount: blocks.length,
        derivedBytes,
        identicalKeyframesSkipped,
      },
      generation: generationLineage,
      sources,
      keyframes: keyframeRecords,
      observations: observationRecords,
      blocks,
    };

    // Persist the descriptor as the object bytes of this generation's
    // screen_reconstruction asset (variant recon-v<generation>).
    const descriptorJson = Buffer.from(JSON.stringify(descriptor), "utf8");
    if (descriptorJson.byteLength > bounds.maxDescriptorBytes) {
      await abandonGeneration("descriptor_too_large");
      return { ok: false, reason: "descriptor_too_large" };
    }
    const descriptorSha = sha256Hex(descriptorJson);
    const descriptorBucket = parts[0]!.storageBucket;
    const descriptorKey = reconstructionObjectKey(evidenceId, generation, descriptorSha);
    const descriptorVariant = screenReconstructionVariantKey(generation);
    // Attribute the descriptor to the first source part (a real EvidencePart id)
    // so it satisfies the derived-asset FK; its lineage is the whole `sources` list.
    const descriptorPartId = parts[0]!.evidencePartId;
    await assertEligible();
    try {
      await deps.putKeyframeObject({
        bucket: descriptorBucket,
        key: descriptorKey,
        body: descriptorJson,
        contentType: "application/json",
      });
    } catch (err) {
      throw wrapTransient("descriptor_put_failed", err);
    }
    const descriptorPersisted = await recordDerivedAsset(
      {
        teamId,
        evidenceId,
        evidencePartId: descriptorPartId,
        assetKind: "screen_reconstruction",
        status: "COMPLETED",
        derivedSha256: descriptorSha,
        sizeBytes: descriptorJson.byteLength,
        contentType: "application/json",
        sourceSha256AtGeneration: parts[0]!.sha256 ?? sourceReads[0]?.readSha256 ?? null,
        storageBucket: descriptorBucket,
        storageKey: descriptorKey,
        engineVersion: SCREEN_ENGINE_VERSION,
        variantKey: descriptorVariant,
        transformation: SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS.reconstruction,
        parametersSha256: generationParametersSha256,
        generationParameters: {
          ...generationParameters,
          generation,
          toolVersions: generationLineage.toolVersions,
          sourceReads,
        },
        sourceOffsetMs: null,
      },
      prisma,
    );
    if (!descriptorPersisted.ok) {
      if (!deps.holdActive) {
        try {
          await deps.deleteObject({ bucket: descriptorBucket, key: descriptorKey });
        } catch {
          /* best effort */
        }
      }
      throw wrapTransient(`descriptor_persist_failed:${descriptorPersisted.reason}`, null);
    }
    writtenThisGeneration.push({
      evidencePartId: descriptorPartId,
      assetKind: "screen_reconstruction",
      variantKey: descriptorVariant,
    });
    currentAssetIds.push(descriptorPersisted.id);
    derivedBytes += descriptorJson.byteLength;

    // THE CURRENT POINTER MOVES ONLY NOW, after the new generation is complete:
    // every other COMPLETED UC-4 row of this evidence (earlier generations,
    // and variants an earlier generation produced that this one did not) is
    // SUPERSEDED — kept with its object, never deleted.
    await assertEligible();
    const supersededAssetCount = await supersedePriorGenerations(prisma, {
      teamId,
      evidenceId,
      keepIds: currentAssetIds,
    });

    // Persist DERIVED text through the CANONICAL extracted-text authority (feeds
    // search + swept by destruction), replacing the previous generation's text
    // atomically. The previous text's digest stays in its descriptor.
    await persistDerivedText(prisma, {
      teamId,
      evidenceId,
      ocrProvider: deps.ocr.name,
      ocrProviderVersion: deps.ocr.version,
      language: ocrRuns ? ocrLanguage : null,
      ocrText,
      reconstructedText,
      ocrConfidence: meanConfidence(observationRecords),
    });

    return {
      ok: true,
      status: coverage,
      coverage,
      ocrEnabled: ocrRuns,
      ocrStatus,
      generation,
      keyframeCount: keyframeRecords.length,
      observationCount: observationRecords.length,
      blockCount: blocks.length,
      derivedBytes,
      descriptorAssetId: descriptorPersisted.id,
      descriptorSha256: descriptorSha,
      supersededAssetCount,
      limitations: [...limitations],
    };
  }

}

// =============================================================================
// Generation bookkeeping
// =============================================================================

/** recon-v<N> → N (legacy `recon-v1` → 1); null for anything else. */
function parseReconVariantGeneration(variantKey: string | null): number | null {
  const m = /^recon-v(\d{1,6})$/.exec(variantKey ?? "");
  return m ? Number(m[1]) : null;
}

type CurrentDescriptorRow = {
  id: string;
  variant_key: string;
  derived_sha256: string | null;
  storage_bucket: string | null;
  storage_key: string | null;
};

/**
 * THE CURRENT descriptor of an evidence: the COMPLETED `recon-v<N>` row with
 * the newest generation. Superseded generations are SUPERSEDED and never
 * current; an abandoned generation is FAILED and never current.
 */
async function readCurrentDescriptorRow(
  prisma: PrismaClient,
  teamId: string,
  evidenceId: string,
): Promise<CurrentDescriptorRow | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "id", "variant_key", "derived_sha256", "storage_bucket", "storage_key"
       FROM "evidence_part_derived_assets"
      WHERE "team_id" = $1::uuid AND "evidence_id" = $2::uuid
        AND "asset_kind" = 'screen_reconstruction'
        AND "variant_key" ~ '^recon-v[0-9]+$'
        AND "status" = 'COMPLETED'
      ORDER BY (substring("variant_key" from 8))::int DESC, "generated_at_utc" DESC NULLS LAST
      LIMIT 1`,
    teamId,
    evidenceId,
  )) as CurrentDescriptorRow[];
  return rows[0] ?? null;
}

/** Is any derived row still pointing at this object? */
async function objectReferenced(
  prisma: PrismaClient,
  bucket: string,
  key: string,
): Promise<boolean> {
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT 1 FROM "evidence_part_derived_assets"
        WHERE "storage_bucket" = $1 AND "storage_key" = $2 LIMIT 1`,
      bucket,
      key,
    )) as unknown[];
    return rows.length > 0;
  } catch {
    return true; // unknown ⇒ never delete
  }
}

async function supersedePriorGenerations(
  prisma: PrismaClient,
  input: { teamId: string; evidenceId: string; keepIds: string[] },
): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "id" FROM "evidence_part_derived_assets"
      WHERE "team_id" = $1::uuid AND "evidence_id" = $2::uuid
        AND "asset_kind" IN ('video_keyframe', 'screen_reconstruction')
        AND "status" = 'COMPLETED'
        AND NOT ("id" = ANY($3::uuid[]))`,
    input.teamId,
    input.evidenceId,
    input.keepIds,
  )) as Array<{ id: string }>;
  return supersedeDerivedAssets(
    { teamId: input.teamId, evidenceId: input.evidenceId, ids: rows.map((r) => r.id) },
    prisma,
  );
}

function meanConfidence(observations: ScreenObservationRecord[]): number | null {
  const values = observations
    .map((o) => o.confidence)
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  if (values.length === 0) return null;
  return Math.round((values.reduce((s, c) => s + c, 0) / values.length) * 1000) / 1000;
}

// =============================================================================
// Descriptor read (ONE authority, used by the API Inspector + worker report)
// =============================================================================

export type ScreenDescriptorReader = {
  prisma?: PrismaClient;
  /** Fetch the descriptor object bytes (bounded by the caller). */
  getObjectBytes(ref: { bucket: string; key: string }): Promise<Buffer>;
};

/**
 * Read + parse the CURRENT persisted `screen_reconstruction` descriptor for an
 * evidence (workspace-anchored), or null when none exists. The single reader
 * the API Inspector, the report bridge and the package bridge use, so the
 * current-generation rule, the storage-ref lookup and the schema check live in
 * exactly one place. `derivedSha256` is the digest of the descriptor bytes (the
 * cache identity of this generation).
 */
export async function readScreenReconstructionDescriptor(
  teamId: string,
  evidenceId: string,
  reader: ScreenDescriptorReader,
): Promise<{
  assetId: string;
  derivedSha256: string | null;
  descriptor: ScreenIntelligenceDescriptor;
} | null> {
  const prisma = reader.prisma ?? getRegisteredPrisma();
  let row: CurrentDescriptorRow | null;
  try {
    row = await readCurrentDescriptorRow(prisma, teamId, evidenceId);
  } catch {
    return null;
  }
  if (!row || !row.storage_bucket || !row.storage_key) return null;
  let bytes: Buffer;
  try {
    bytes = await reader.getObjectBytes({ bucket: row.storage_bucket, key: row.storage_key });
  } catch {
    return null;
  }
  try {
    const descriptor = JSON.parse(bytes.toString("utf8")) as ScreenIntelligenceDescriptor;
    if (descriptor.schemaVersion !== SCREEN_INTELLIGENCE_DESCRIPTOR_VERSION) return null;
    return { assetId: row.id, derivedSha256: row.derived_sha256, descriptor };
  } catch {
    return null;
  }
}

// =============================================================================
// DERIVED text persistence (canonical extracted-text authority)
// =============================================================================

async function persistDerivedText(
  prisma: PrismaClient,
  input: {
    teamId: string;
    evidenceId: string;
    ocrProvider: string;
    ocrProviderVersion: string;
    language: string | null;
    ocrText: string;
    reconstructedText: string;
    ocrConfidence: number | null;
  },
): Promise<void> {
  const now = new Date();
  try {
    // Replace the previous generation's UC-4 rows in ONE transaction, so search
    // never sees both generations and a failed write never leaves none.
    await prisma.$transaction([
      prisma.evidenceExtractedText.deleteMany({
        where: {
          evidenceId: input.evidenceId,
          kind: { in: ["OCR_SCREEN", "SCREEN_RECONSTRUCTION"] as never },
        },
      }),
      ...(input.ocrText
        ? [
            prisma.evidenceExtractedText.create({
              data: {
                evidenceId: input.evidenceId,
                teamId: input.teamId,
                kind: "OCR_SCREEN" as never,
                status: "COMPLETED" as never,
                provider: input.ocrProvider.slice(0, 64),
                providerVersion: input.ocrProviderVersion.slice(0, 64),
                language: input.language ? input.language.slice(0, 16) : null,
                text: input.ocrText,
                confidence: input.ocrConfidence,
                wordCount: countWords(input.ocrText),
                extractedAtUtc: now,
              },
            }),
          ]
        : []),
      ...(input.reconstructedText
        ? [
            prisma.evidenceExtractedText.create({
              data: {
                evidenceId: input.evidenceId,
                teamId: input.teamId,
                kind: "SCREEN_RECONSTRUCTION" as never,
                status: "COMPLETED" as never,
                provider: "proovra-screen-reconstruction",
                providerVersion: SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS.reconstruction,
                language: input.language ? input.language.slice(0, 16) : null,
                text: input.reconstructedText,
                wordCount: countWords(input.reconstructedText),
                extractedAtUtc: now,
              },
            }),
          ]
        : []),
    ]);
  } catch {
    // Text persistence is a search convenience; its failure must not fail the
    // run (the descriptor + derived assets are the durable authority, and the
    // descriptor records the digest of the text that was meant to be written).
  }
}

function boundedJoin(parts: string[], maxBytes: number): string {
  const out: string[] = [];
  let bytes = 0;
  for (const p of parts) {
    const clean = (p ?? "").replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const add = Buffer.byteLength(clean, "utf8") + 1;
    if (bytes + add > maxBytes) break;
    out.push(clean);
    bytes += add;
  }
  return out.join("\n");
}

function countWords(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

function wrapTransient(reason: string, err: unknown): Error {
  const e = new Error(
    err instanceof Error ? `${reason}:${err.message.slice(0, 80)}` : reason,
  );
  e.name = "ScreenIntelligenceTransientError";
  return e;
}
