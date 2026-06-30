/**
 * Enterprise Technical Metadata — public verify-page projection.
 *
 * Builds the privacy-safe "Technical Metadata" payload surfaced on the
 * public verification page (Media / EXIF / Capture Environment cards).
 *
 * Privacy invariants (enforced here + by the shared projections):
 *   * No raw GPS coordinates — `gpsPresent` boolean only.
 *   * No raw IP / raw User-Agent — masked IP + UA hash only (and the
 *     hash is intentionally NOT surfaced to the public page).
 *   * Never throws — returns null on any error so the verify response
 *     is unchanged in the no-data case.
 */

import {
  aggregateMetadataStatus,
  deriveExifSummary,
  formatCameraLabel,
  primaryMediaTypeLabel,
  toPerPartMediaSummary,
} from "@proovra/shared-runtime/technical-metadata";

import { prisma as defaultPrisma } from "../../db.js";

export type VerifyTechnicalMetadata = {
  media: {
    filesAnalyzed: number;
    filesTotal: number;
    metadataStatus: "Complete" | "Partial" | "Missing" | "Unavailable";
    primaryMediaType: string;
    resolutionSummary: string | null;
  };
  exif: {
    applicable: boolean;
    camera: string | null;
    originalCaptureTime: string | null;
    gpsPresent: boolean;
    resolution: string | null;
    softwareTag: string | null;
    metadataStatus: string;
  } | null;
  captureEnvironment: {
    uploadSource: string | null;
    captureMethod: string | null;
    browserName: string | null;
    osName: string | null;
    deviceClass: string | null;
    timezone: string | null;
    /** Internal-only (authenticated workspace UI). Privacy-safe: a
     *  hash, never the raw User-Agent. Omitted on the public page. */
    userAgentHash?: string | null;
    /** Internal-only. Masked IP (e.g. "203.0.x.x"), never the raw IP. */
    ipAddressMasked?: string | null;
    locale?: string | null;
  } | null;
};

export async function projectVerifyTechnicalMetadata(input: {
  teamId: string | null;
  evidenceId: string;
  prisma?: typeof defaultPrisma;
  /** When true (authenticated internal UI), include the privacy-safe
   *  masked IP + User-Agent hash + locale. NEVER includes raw IP/UA.
   *  Defaults to false so the public verify page can never surface
   *  them. */
  internal?: boolean;
}): Promise<VerifyTechnicalMetadata | null> {
  const prisma = input.prisma ?? defaultPrisma;
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

    const ceRaw =
      (evidenceRows[0]?.capture_environment as Record<string, unknown> | null) ??
      null;

    // Nothing to surface at all.
    if (perPart.length === 0 && !ceRaw) return null;

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

    let exif: VerifyTechnicalMetadata["exif"] = null;
    for (const p of parts) {
      const e = deriveExifSummary(p.technical_metadata);
      if (e.applicable) {
        exif = {
          applicable: true,
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

    const captureEnvironment = ceRaw
      ? {
          uploadSource: (ceRaw.uploadSource as string | null) ?? null,
          captureMethod: (ceRaw.captureMethod as string | null) ?? null,
          browserName: (ceRaw.browserName as string | null) ?? null,
          osName: (ceRaw.osName as string | null) ?? null,
          deviceClass: (ceRaw.deviceClass as string | null) ?? null,
          timezone: (ceRaw.timezone as string | null) ?? null,
          // Internal-only privacy-safe extras. Both are derived (a hash
          // and a masked address) — never the raw UA or raw IP.
          ...(input.internal
            ? {
                userAgentHash: (ceRaw.userAgentHash as string | null) ?? null,
                ipAddressMasked: (ceRaw.ipAddressMasked as string | null) ?? null,
                locale: (ceRaw.locale as string | null) ?? null,
              }
            : {}),
        }
      : null;

    return {
      media: {
        filesAnalyzed: perPart.filter((p) => p.parseResult === "OK").length,
        filesTotal: perPart.length,
        metadataStatus: aggregateMetadataStatus(perPart),
        primaryMediaType: primaryMediaTypeLabel(perPart),
        resolutionSummary,
      },
      exif,
      captureEnvironment,
    };
  } catch {
    return null;
  }
}
