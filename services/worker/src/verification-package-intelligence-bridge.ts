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
]);
type PackageAssetKind =
  | "image_thumbnail"
  | "video_frame"
  | "audio_waveform"
  | "low_res_proxy";

export async function buildVerificationPackageIntelligence(input: {
  teamId: string | null | undefined;
  evidenceId: string;
}): Promise<IntelligencePackageInput | null> {
  if (!input.teamId) return null;
  try {
    // 1. Media signals (re-uses the report projection's signal pull;
    //    the package shape needs fewer fields than the report).
    const { projectMediaIntelligenceForReport } = await import(
      "../../api/src/services/media-intelligence/report-projection.service.js"
    );
    const reportProjection = await projectMediaIntelligenceForReport(
      { teamId: input.teamId, evidenceId: input.evidenceId },
      prisma,
    );

    // 2. Derived assets (this phase's wiring). Pulls bounded rows
    //    + their SHA-256s. NEVER includes storage internals — the
    //    listDerivedAssetsForEvidence projection strips them.
    const { listDerivedAssetsForEvidence } = await import(
      "../../api/src/services/media-intelligence/derived-assets.service.js"
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
          a.sizeBytes <= MAX_PACKAGE_THUMBNAIL_BYTES &&
          a.contentType != null &&
          PACKAGE_ASSET_KINDS.has(a.assetKind),
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

    if (mediaSignals.length === 0 && derivedAssets.length === 0) {
      return null;
    }

    return {
      mediaSignals,
      derivedAssets,
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