/**
 * Enterprise Technical Metadata — report projection bridge.
 *
 * Builds the compact, reviewer-facing technical summary the PDF report
 * renders (Media Technical Summary section). Never throws, never
 * blocks: a null result means the section emits nothing and the report
 * is byte-identical to the pre-feature output.
 *
 * Privacy: no raw GPS, no raw IP, no raw User-Agent — only the
 * privacy-safe projections from @proovra/shared-runtime.
 */

import {
  aggregateMetadataStatus,
  deriveExifSummary,
  formatCameraLabel,
  primaryMediaTypeLabel,
  toPerPartMediaSummary,
  type ExifSummary,
} from "@proovra/shared-runtime/technical-metadata";
import { prisma } from "./db.js";
import { logger } from "./logger.js";

export type ReportExifSummary = {
  camera: string | null;
  originalCaptureTime: string | null;
  gpsPresent: boolean;
  resolution: string | null;
  softwareTag: string | null;
  metadataStatus: ExifSummary["metadataStatus"];
};

export type ReportCaptureEnvironment = {
  uploadSource: string | null;
  captureMethod: string | null;
  browserOs: string | null;
  deviceClass: string | null;
  timezone: string | null;
};

export type TechnicalSummaryReportInput = {
  mediaFilesAnalyzed: number;
  mediaFilesTotal: number;
  metadataStatus: "Complete" | "Partial" | "Missing" | "Unavailable";
  primaryMediaType: string;
  resolutionSummary: string | null;
  exif: ReportExifSummary | null;
  captureEnvironment: ReportCaptureEnvironment | null;
};

export async function buildReportTechnicalSummary(input: {
  teamId: string | null;
  evidenceId: string;
}): Promise<TechnicalSummaryReportInput | null> {
  try {
    const parts = (await prisma.$queryRawUnsafe(
      `SELECT p."id", p."original_file_name", p."mime_type",
              p."size_bytes", p."sha256", p."technical_metadata"
         FROM "evidence_parts" p
         JOIN "evidence" e ON e."id" = p."evidence_id"
         WHERE e."id" = $1
           ${input.teamId ? `AND e."team_id" = $2` : ""}
         ORDER BY p."part_index" ASC`,
      ...(input.teamId ? [input.evidenceId, input.teamId] : [input.evidenceId]),
    )) as Array<{
      id: string;
      original_file_name: string | null;
      mime_type: string | null;
      size_bytes: bigint | number | null;
      sha256: string | null;
      technical_metadata: unknown;
    }>;

    const evidenceRows = (await prisma.$queryRawUnsafe(
      `SELECT "capture_environment" FROM "evidence" WHERE "id" = $1 LIMIT 1`,
      input.evidenceId,
    )) as Array<{ capture_environment: unknown }>;

    if (parts.length === 0 && evidenceRows.length === 0) return null;

    const perPart = parts.map((p) =>
      toPerPartMediaSummary({
        id: p.id,
        filename: p.original_file_name,
        sizeBytes:
          typeof p.size_bytes === "bigint"
            ? Number(p.size_bytes)
            : p.size_bytes ?? null,
        sha256: p.sha256,
        technicalMetadata: p.technical_metadata,
        mimeType: p.mime_type,
      }),
    );

    const analyzed = perPart.filter((p) => p.parseResult === "OK").length;

    // Resolution / duration / page summary for the primary part.
    const primary = perPart[0] ?? null;
    let resolutionSummary: string | null = null;
    if (primary) {
      if (primary.width != null && primary.height != null) {
        resolutionSummary = `${primary.width}×${primary.height}`;
      } else if (primary.durationMs != null) {
        resolutionSummary = `${Math.round(primary.durationMs / 1000)}s`;
      } else if (primary.pageCount != null) {
        resolutionSummary = `${primary.pageCount} page${primary.pageCount === 1 ? "" : "s"}`;
      }
    }

    // EXIF — first applicable part.
    let exif: ReportExifSummary | null = null;
    for (const p of parts) {
      const e = deriveExifSummary(p.technical_metadata);
      if (e.applicable) {
        exif = {
          camera: formatCameraLabel(e.cameraMake, e.cameraModel),
          originalCaptureTime: e.originalCaptureTime,
          gpsPresent: e.gpsPresent,
          resolution: e.resolution,
          softwareTag: e.softwareTag,
          metadataStatus: e.metadataStatus,
        };
        break;
      }
    }

    // Capture environment.
    const ce =
      (evidenceRows[0]?.capture_environment as Record<string, unknown> | null) ??
      null;
    let captureEnvironment: ReportCaptureEnvironment | null = null;
    if (ce) {
      const browser = (ce.browserName as string | null) ?? null;
      const os = (ce.osName as string | null) ?? null;
      const browserOs =
        browser && os ? `${browser} on ${os}` : browser ?? os ?? null;
      captureEnvironment = {
        uploadSource: (ce.uploadSource as string | null) ?? null,
        captureMethod: (ce.captureMethod as string | null) ?? null,
        browserOs,
        deviceClass: (ce.deviceClass as string | null) ?? null,
        timezone: (ce.timezone as string | null) ?? null,
      };
    }

    // Nothing meaningful → don't render the section.
    if (perPart.length === 0 && !captureEnvironment) return null;

    return {
      mediaFilesAnalyzed: analyzed,
      mediaFilesTotal: perPart.length,
      metadataStatus: aggregateMetadataStatus(perPart),
      primaryMediaType: primaryMediaTypeLabel(perPart),
      resolutionSummary,
      exif,
      captureEnvironment,
    };
  } catch (err) {
    logger.warn(
      {
        evidenceId: input.evidenceId,
        err: err instanceof Error ? err.message.slice(0, 160) : "unknown",
      },
      "report.technical_summary.build_failed",
    );
    return null;
  }
}
