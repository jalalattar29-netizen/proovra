/**
 * Phase 31.14 — Worker bridge to project verification-package
 * intelligence input from the canonical DB.
 *
 * Mirrors the pattern from `media-intelligence-report-bridge.ts`:
 * lazy-imports the api-side services, runs them with the worker's
 * canonical `prisma` instance, returns `null` on failure so the
 * package generator builds without the advisory `intelligence/`
 * subdirectory.
 *
 * Hard rules:
 *   * NEVER throws. Any failure resolves to `null`.
 *   * Bounded log line on failure (no stack traces, no storage
 *     internals).
 *   * Returns ONLY the bounded `IntelligencePackageInput` shape —
 *     the verification-package-intelligence module enforces the
 *     final-output bounds (manifest size caps, redactions, etc).
 */

import { prisma } from "./db.js";
import { logger } from "./logger.js";
import type { IntelligencePackageInput } from "./verification-package-intelligence.js";

const MAX_PACKAGE_THUMBNAIL_BYTES = 512 * 1024;

// The package's bounded enum allows only these 4 kinds. The DB
// also stores `compact_review_preview` (reserved for a future
// phase) — we drop it from the package manifest until the package
// schema is widened in lockstep.
const PACKAGE_ASSET_KINDS = new Set([
  "image_thumbnail",
  "video_frame",
  "audio_waveform",
  "low_res_proxy",
  // UC-4 — DERIVED screen intelligence artifacts.
  "video_keyframe",
  "screen_reconstruction",
]);
type PackageAssetKind =
  | "image_thumbnail"
  | "video_frame"
  | "audio_waveform"
  | "low_res_proxy"
  | "video_keyframe"
  | "screen_reconstruction";
// The manifest carries METADATA (identity/digest/size/source), never bytes, so
// UC-4 keyframes and the reconstruction descriptor are listed regardless of
// size — the thumbnail byte cap only guards the older embedding-oriented kinds.
const SIZE_CAPPED_KINDS = new Set([
  "image_thumbnail",
  "video_frame",
  "audio_waveform",
  "low_res_proxy",
]);

export async function buildVerificationPackageIntelligence(input: {
  teamId: string | null | undefined;
  evidenceId: string;
}): Promise<IntelligencePackageInput | null> {
  if (!input.teamId) return null;
  try {
    // 1. Media signals (re-uses the report projection's signal pull;
    //    the package shape needs fewer fields than the report).
    const { projectMediaIntelligenceForReport } = await import(
      "@proovra/shared-runtime/media-intelligence"
    );
    const reportProjection = await projectMediaIntelligenceForReport(
      { teamId: input.teamId, evidenceId: input.evidenceId },
      prisma,
    );

    // 2. Derived assets (this phase's wiring). Pulls bounded rows
    //    + their SHA-256s. NEVER includes storage internals — the
    //    listDerivedAssetsForEvidence projection strips them.
    const { listDerivedAssetsForEvidence } = await import(
      "@proovra/shared-runtime/media-intelligence"
    );
    const derivedRows = await listDerivedAssetsForEvidence(
      input.teamId,
      input.evidenceId,
    );

    const derivedAssets = derivedRows
      .filter(
        (a) =>
          a.status === "COMPLETED" &&
          a.derivedSha256 != null &&
          a.sizeBytes != null &&
          a.contentType != null &&
          PACKAGE_ASSET_KINDS.has(a.assetKind) &&
          (!SIZE_CAPPED_KINDS.has(a.assetKind) ||
            a.sizeBytes <= MAX_PACKAGE_THUMBNAIL_BYTES),
      )
      .map((a) => ({
        id: a.id,
        assetKind: a.assetKind as PackageAssetKind,
        sourceEvidenceId: a.evidenceId,
        sourceMaterialId: a.evidencePartId,
        sha256: a.derivedSha256!,
        sizeBytes: a.sizeBytes!,
        contentType: a.contentType!,
        createdAtUtc: a.createdAtUtc,
      }));

    const mediaSignals = (reportProjection?.signals ?? []).map((s) => ({
      id: s.id,
      signalType: s.signalType,
      materialId: s.materialId,
      severity: s.severity,
      confidence: s.confidence,
      safeSummary: s.safeSummary,
      status: s.status,
      createdAtUtc: s.createdAtUtc,
    }));

    // 3. UC-4 — reconstruction lineage manifest, read from the ONE descriptor.
    let reconstruction: IntelligencePackageInput["reconstruction"] = null;
    try {
      const { readScreenReconstructionDescriptor } = await import(
        "@proovra/shared-runtime/media-intelligence"
      );
      const { UC4_RESOURCE_BOUNDS } = await import("@proovra/shared");
      const read = await readScreenReconstructionDescriptor(
        input.teamId,
        input.evidenceId,
        {
          prisma,
          getObjectBytes: async ({ bucket, key }) => {
            const { getObjectStream } = await import("./storage.js");
            const stream = (await getObjectStream({ bucket, key })) as unknown as AsyncIterable<
              Buffer | string
            >;
            const chunks: Buffer[] = [];
            let total = 0;
            for await (const chunk of stream) {
              const buf =
                typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
              total += buf.byteLength;
              if (total > UC4_RESOURCE_BOUNDS.maxDescriptorBytes) {
                throw new Error("descriptor_too_large");
              }
              chunks.push(buf);
            }
            return Buffer.concat(chunks);
          },
        },
      );
      if (read) {
        const d = read.descriptor;
        // Find the descriptor derivative row for its digest + size.
        const descRow = derivedRows.find(
          (a) => a.assetKind === "screen_reconstruction" && a.status === "COMPLETED",
        );
        reconstruction = {
          descriptorSha256: descRow?.derivedSha256 ?? "",
          descriptorSizeBytes: descRow?.sizeBytes ?? 0,
          coverage: d.coverage,
          ocrEnabled: d.ocrEnabled,
          acquisitionComplete: d.acquisitionComplete,
          transformationVersions: {
            keyframe: d.transformationVersions.keyframe,
            ocr: d.transformationVersions.ocr,
            reconstruction: d.transformationVersions.reconstruction,
          },
          sources: d.sources.map((s) => ({
            evidencePartId: s.evidencePartId,
            sourceSha256: s.sourceSha256,
          })),
          keyframeCount: d.stats.keyframeCount,
          blockCount: d.stats.blockCount,
          blocks: d.blocks.map((b) => ({
            blockId: b.blockId,
            sequence: b.sequence,
            kind: b.kind,
            sourceEvidencePartIds: b.sourceEvidencePartIds,
            sourceOffsetMsRange: b.sourceOffsetMsRange,
            observedInFrames: b.observedInFrames,
          })),
        };
      }
    } catch {
      reconstruction = null;
    }

    if (mediaSignals.length === 0 && derivedAssets.length === 0 && !reconstruction) {
      return null;
    }

    return {
      mediaSignals,
      derivedAssets,
      reconstruction,
    };
  } catch (err) {
    logger.warn(
      {
        evidenceId: input.evidenceId,
        reason:
          err instanceof Error
            ? `bridge_failed:${err.message.slice(0, 80)}`
            : "bridge_failed",
      },
      "verification_package_intelligence_bridge.failed",
    );
    return null;
  }
}