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

import type { PrismaClient } from "@prisma/client";
import {
  reconstructScreenConversation,
  reconstructionCoverageLabel,
  SCREEN_INTELLIGENCE_DESCRIPTOR_VERSION,
  SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS,
  UC4_RESOURCE_BOUNDS,
  keyframeVariantKey,
  type OcrExtractResult,
  type ScreenObservation,
  type ScreenIntelligenceDescriptor,
  type ScreenSourcePart,
  type ScreenKeyframeRecord,
  type ScreenObservationRecord,
  type ScreenBlockRecord,
  type ReconstructionLimitationCode,
} from "@proovra/shared";

import { getRegisteredPrisma } from "../prisma-registry.js";
import { recordDerivedAsset } from "./derived-assets.service.js";

// =============================================================================
// Injected dependencies
// =============================================================================

/** ONE ORIGINAL source part (already team-anchored by the caller). */
export type ScreenSourcePartInput = {
  partIndex: number;
  evidencePartId: string;
  storageBucket: string;
  storageKey: string;
  mimeType: string | null;
  sha256: string | null;
  acquisitionRole?: string | null;
};

export type KeyframeProducerResult =
  | {
      status: "ok";
      keyframes: Array<{
        index: number;
        offsetMs: number;
        bytes: Buffer;
        contentType: string;
        derivedSha256: string;
        sizeBytes: number;
      }>;
      boundsReached: boolean;
    }
  | { status: "unsupported"; reason: string }
  | { status: "failed"; reason: string };

/** LOCAL OCR over image bytes. `enabled=false` ⇒ workspace policy disabled OCR. */
export type ScreenOcrRunner = {
  name: string;
  version: string;
  local: boolean;
  enabled: boolean;
  extractFromBytes(bytes: Buffer): Promise<OcrExtractResult>;
};

export type ScreenIntelligenceDeps = {
  prisma?: PrismaClient;
  getSourceBytes(input: {
    bucket: string;
    key: string;
    maxBytes: number;
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
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
  ocr: ScreenOcrRunner;
  /** True while the evidence is under an effective legal hold — blocks cleanup. */
  holdActive?: boolean;
};

export type ScreenIntelligenceInput = {
  teamId: string;
  evidenceId: string;
  parts: ScreenSourcePartInput[];
  /** ORIGINAL acquisition completeness — carried separately, never upgraded. */
  acquisitionComplete: boolean;
  descriptorVersion?: number;
  bounds?: typeof UC4_RESOURCE_BOUNDS;
};

export type ScreenIntelligenceResult =
  | {
      ok: true;
      status: "COMPLETE" | "PARTIAL";
      coverage: "COMPLETE" | "PARTIAL";
      ocrEnabled: boolean;
      keyframeCount: number;
      observationCount: number;
      blockCount: number;
      derivedBytes: number;
      descriptorAssetId: string | null;
      limitations: ReconstructionLimitationCode[];
    }
  | { ok: false; reason: string };

// =============================================================================
// Storage-key generation (canonical, never user-controlled)
// =============================================================================

const DERIVED_PREFIX = "derived-assets";
const SCREEN_ENGINE_VERSION = "uc4-screen-intelligence-v1";

function keyframeObjectKey(
  evidenceId: string,
  evidencePartId: string,
  sha256: string,
): string {
  return `${DERIVED_PREFIX}/${evidenceId}/${evidencePartId}/video_keyframe-${sha256.slice(0, 16)}.webp`;
}

function reconstructionObjectKey(
  evidenceId: string,
  sha256: string,
): string {
  return `${DERIVED_PREFIX}/${evidenceId}/screen_reconstruction/recon-v1-${sha256.slice(0, 16)}.json`;
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

  const parts = [...input.parts]
    .filter((p) => !!p.storageBucket && !!p.storageKey)
    .sort((a, b) => a.partIndex - b.partIndex)
    .slice(0, bounds.maxSourceParts);

  if (parts.length === 0) {
    return { ok: false, reason: "no_source_parts" };
  }

  const limitations = new Set<ReconstructionLimitationCode>();
  if (input.parts.length > bounds.maxSourceParts) {
    limitations.add("RECONSTRUCTION_BOUNDS_REACHED");
  }

  const sources: ScreenSourcePart[] = [];
  const keyframeRecords: ScreenKeyframeRecord[] = [];
  const observationRecords: ScreenObservationRecord[] = [];
  const reconstructionObservations: ScreenObservation[] = [];

  let derivedBytes = 0;
  let ocrRegionCount = 0;
  let ocrFailedKeyframes = 0;
  let ocrKeyframesProcessed = 0;
  let frameOrder = 0;
  let obsCounter = 0;
  const supersededObjects: Array<{ bucket: string; key: string }> = [];

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

    // Each entry: the image bytes to OCR + its keyframe identity/lineage.
    type FrameUnit = {
      keyframeId: string;
      variantKey: string;
      offsetMs: number;
      bytes: Buffer;
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
      });
    } catch (err) {
      // Transient storage failure — surface for retry (never a false COMPLETE).
      throw wrapTransient("source_fetch_failed", err);
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
      for (const kf of produced.keyframes) {
        if (derivedBytes + kf.sizeBytes > bounds.maxDerivedBytesPerRun) {
          limitations.add("RECONSTRUCTION_BOUNDS_REACHED");
          break;
        }
        const variantKey = keyframeVariantKey(kf.index);
        const key = keyframeObjectKey(evidenceId, part.evidencePartId, kf.derivedSha256);
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
            sourceSha256AtGeneration: part.sha256,
            storageBucket: part.storageBucket,
            storageKey: key,
            engineVersion: SCREEN_ENGINE_VERSION,
            variantKey,
            transformation: SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS.keyframe,
            sourceOffsetMs: kf.offsetMs,
          },
          prisma,
        );
        if (!persisted.ok) {
          // DB write failed AFTER the object landed — remove the orphan object
          // (unless held) so we never leave bytes with no destroyable pointer.
          if (!deps.holdActive) {
            try {
              await deps.deleteObject({ bucket: part.storageBucket, key });
            } catch {
              /* best effort; reconciler will catch a rare residue */
            }
          }
          throw wrapTransient(`keyframe_persist_failed:${persisted.reason}`, null);
        }
        if (persisted.previousStorage && !deps.holdActive) {
          supersededObjects.push(persisted.previousStorage);
        }
        derivedBytes += kf.sizeBytes;
        frames.push({
          keyframeId: `p${part.partIndex}-${variantKey}`,
          variantKey,
          offsetMs: kf.offsetMs,
          bytes: kf.bytes,
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
        bytes: sourceBytes,
        derivedSha256: part.sha256 ?? "",
        derivedAssetId: null,
        reason: "first",
      });
    }

    // OCR each frame (bounded), building source-linked observations.
    for (const frame of frames) {
      keyframeRecords.push({
        keyframeId: frame.keyframeId,
        partIndex: part.partIndex,
        evidencePartId: part.evidencePartId,
        variantKey: frame.variantKey,
        offsetMs: frame.offsetMs,
        derivedSha256: frame.derivedSha256 || null,
        derivedAssetId: frame.derivedAssetId,
        reason: frame.reason,
      });
      const thisFrameOrder = frameOrder;
      frameOrder += 1;

      if (!deps.ocr.enabled) continue; // deterministic-only run (OCR policy off)
      if (ocrKeyframesProcessed >= bounds.maxOcrKeyframes) {
        limitations.add("RECONSTRUCTION_BOUNDS_REACHED");
        continue;
      }
      ocrKeyframesProcessed += 1;

      let regions: OcrExtractResult["regions"] = [];
      try {
        const res = await deps.ocr.extractFromBytes(frame.bytes);
        regions = res.regions;
      } catch {
        // Degrade this frame only — ORIGINAL + other frames unaffected.
        ocrFailedKeyframes += 1;
        continue;
      }
      ocrRegionCount += regions.length;
      for (const region of [...regions].sort((a, b) => a.rowOrder - b.rowOrder)) {
        if (observationRecords.length >= bounds.maxObservations) {
          limitations.add("RECONSTRUCTION_BOUNDS_REACHED");
          break;
        }
        const id = `obs-${obsCounter++}`;
        const fingerprint = region.fingerprint ?? null;
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
  }));

  const baseCoverage = reconstructionCoverageLabel(
    input.acquisitionComplete,
    reconstruction.coverage,
  );
  // OCR disabled ⇒ no reconstruction was possible ⇒ never COMPLETE.
  const coverage: "COMPLETE" | "PARTIAL" = !deps.ocr.enabled
    ? "PARTIAL"
    : baseCoverage;

  const descriptor: ScreenIntelligenceDescriptor = {
    schemaVersion: SCREEN_INTELLIGENCE_DESCRIPTOR_VERSION,
    descriptorVersion: input.descriptorVersion ?? 1,
    transformation: "screen-conversation-reconstruction/v1",
    transformationVersions: SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS,
    generatedAtUtc: new Date().toISOString(),
    ocrProvider: { name: deps.ocr.name, version: deps.ocr.version, local: deps.ocr.local },
    ocrEnabled: deps.ocr.enabled,
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
    },
    sources,
    keyframes: keyframeRecords,
    observations: observationRecords,
    blocks,
  };

  // Persist the descriptor as the object bytes of ONE screen_reconstruction asset.
  const descriptorJson = Buffer.from(JSON.stringify(descriptor), "utf8");
  if (descriptorJson.byteLength > bounds.maxDescriptorBytes) {
    return { ok: false, reason: "descriptor_too_large" };
  }
  const { createHash } = await import("node:crypto");
  const descriptorSha = createHash("sha256").update(descriptorJson).digest("hex");
  const descriptorBucket = parts[0]!.storageBucket;
  const descriptorKey = reconstructionObjectKey(evidenceId, descriptorSha);
  // Attribute the descriptor to the first source part (a real EvidencePart id) so
  // it satisfies the derived-asset FK; its lineage is the whole `sources` list.
  const descriptorPartId = parts[0]!.evidencePartId;
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
      sourceSha256AtGeneration: parts[0]!.sha256,
      storageBucket: descriptorBucket,
      storageKey: descriptorKey,
      engineVersion: SCREEN_ENGINE_VERSION,
      variantKey: "recon-v1",
      transformation: SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS.reconstruction,
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
  derivedBytes += descriptorJson.byteLength;
  if (descriptorPersisted.previousStorage && !deps.holdActive) {
    supersededObjects.push(descriptorPersisted.previousStorage);
  }

  // Persist DERIVED text through the CANONICAL extracted-text authority (feeds
  // search + swept by destruction). Idempotent: replace this run's prior UC-4
  // rows so a regeneration never leaves stale searchable text.
  await persistDerivedText(prisma, {
    teamId,
    evidenceId,
    ocrEnabled: deps.ocr.enabled,
    ocrProvider: deps.ocr.name,
    ocrProviderVersion: deps.ocr.version,
    observations: observationRecords,
    blocks,
    bounds,
  });

  // Remove superseded objects (best effort, hold-respecting handled above).
  for (const obj of supersededObjects) {
    if (obj.bucket === descriptorBucket && obj.key === descriptorKey) continue;
    try {
      await deps.deleteObject(obj);
    } catch {
      /* reconciler will catch residue */
    }
  }

  const status: "COMPLETE" | "PARTIAL" = coverage;
  return {
    ok: true,
    status,
    coverage,
    ocrEnabled: deps.ocr.enabled,
    keyframeCount: keyframeRecords.length,
    observationCount: observationRecords.length,
    blockCount: blocks.length,
    derivedBytes,
    descriptorAssetId: descriptorPersisted.id,
    limitations: [...limitations],
  };
}

// =============================================================================
// DERIVED text persistence (canonical extracted-text authority)
// =============================================================================

async function persistDerivedText(
  prisma: PrismaClient,
  input: {
    teamId: string;
    evidenceId: string;
    ocrEnabled: boolean;
    ocrProvider: string;
    ocrProviderVersion: string;
    observations: ScreenObservationRecord[];
    blocks: ScreenBlockRecord[];
    bounds: typeof UC4_RESOURCE_BOUNDS;
  },
): Promise<void> {
  try {
    // Replace prior UC-4 rows for this evidence so regeneration is idempotent
    // and search never accumulates stale versions.
    await prisma.evidenceExtractedText.deleteMany({
      where: {
        evidenceId: input.evidenceId,
        kind: { in: ["OCR_SCREEN", "SCREEN_RECONSTRUCTION"] as never },
      },
    });

    if (input.ocrEnabled && input.observations.length > 0) {
      const ocrText = boundedJoin(
        input.observations.map((o) => o.text),
        input.bounds.maxOcrTextBytes,
      );
      if (ocrText) {
        await prisma.evidenceExtractedText.create({
          data: {
            evidenceId: input.evidenceId,
            teamId: input.teamId,
            kind: "OCR_SCREEN" as never,
            status: "COMPLETED" as never,
            provider: input.ocrProvider,
            providerVersion: input.ocrProviderVersion,
            language: null,
            text: ocrText,
            wordCount: countWords(ocrText),
          },
        });
      }
    }

    if (input.blocks.length > 0) {
      const reconstructedText = boundedJoin(
        input.blocks
          .slice()
          .sort((a, b) => a.sequence - b.sequence)
          .map((b) => b.text),
        input.bounds.maxReconstructedTextBytes,
      );
      if (reconstructedText) {
        await prisma.evidenceExtractedText.create({
          data: {
            evidenceId: input.evidenceId,
            teamId: input.teamId,
            kind: "SCREEN_RECONSTRUCTION" as never,
            status: "COMPLETED" as never,
            provider: "proovra-screen-reconstruction",
            providerVersion:
              SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS.reconstruction,
            language: null,
            text: reconstructedText,
            wordCount: countWords(reconstructedText),
          },
        });
      }
    }
  } catch {
    // Text persistence is a search convenience; its failure must not fail the
    // run (the descriptor + derived assets are the durable authority).
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
