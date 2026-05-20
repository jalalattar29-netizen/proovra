/**
 * Phase 31.11 — Worker bridge to the report-side intelligence projection.
 *
 * Lazy-loads the canonical projection service from services/api and
 * runs it with the worker's Prisma instance. Every error path
 * returns `null` — the report processor MUST be unaffected by
 * intelligence-projection failures.
 *
 * Hard rules:
 *   * NEVER throws. The promise resolves with `null` on any error.
 *   * Bounded log output. We log a single-line warning with the
 *     bounded teamId / evidenceId / reason. No stack traces, no
 *     storage internals.
 *   * Uses the canonical shared `prisma` instance from `./db.js`.
 *   * Cross-import path matches the existing media-intelligence
 *     processor bridge (`../../api/src/services/...`).
 */

import { prisma } from "./db.js";
import { logger } from "./logger.js";

export type MediaIntelligenceReportProjection = {
  signals: ReadonlyArray<{
    id: string;
    signalType: string;
    materialId: string | null;
    materialLabel: string | null;
    severity: "INFO" | "REVIEW_RECOMMENDED" | "ATTENTION";
    confidence: "LOW" | "MEDIUM" | "HIGH";
    safeSummary: string;
    status: "PENDING" | "ACKNOWLEDGED" | "DISMISSED";
    createdAtUtc: string;
  }>;
  derivedThumbnails: ReadonlyArray<{
    materialId: string;
    dataUrl: string;
    assetKind: string;
  }>;
  ocrTranscript: ReadonlyArray<{
    materialId: string;
    ocrAvailable: boolean;
    transcriptAvailable: boolean;
    ocrIndexed: boolean;
    transcriptIndexed: boolean;
  }>;
};

/**
 * Project the bounded report-side media intelligence shape for one
 * evidence id. Returns `null` when there's no data OR on any error
 * — the caller treats both as "no section" identically.
 */
export async function buildReportMediaIntelligence(input: {
  teamId: string | null | undefined;
  evidenceId: string;
}): Promise<MediaIntelligenceReportProjection | null> {
  // The projection NEEDS a team id to be safe (anti-enumeration).
  // Missing team id is normal during legacy single-tenant flows.
  if (!input.teamId) {
    return null;
  }
  try {
    const { projectMediaIntelligenceForReport } = await import(
      "@proovra/shared-runtime/media-intelligence"
    );
    const result = await projectMediaIntelligenceForReport(
      { teamId: input.teamId, evidenceId: input.evidenceId },
      prisma,
    );
    return result;
  } catch (err) {
    // Defence in depth: even though the api-side projection is
    // itself never-throws, an import-time error (e.g. service moved)
    // would land here. Log a bounded line + return null so the
    // report still generates.
    logger.warn(
      {
        evidenceId: input.evidenceId,
        reason:
          err instanceof Error
            ? `bridge_failed:${err.message.slice(0, 80)}`
            : "bridge_failed",
      },
      "media_intelligence_report_bridge.failed",
    );
    return null;
  }
}
