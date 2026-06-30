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
  humanizeCaptureMethod,
  humanizeUploadSource,
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
    exifPresent: boolean;
    camera: string | null;
    lensModel: string | null;
    originalCaptureTime: string | null;
    iso: number | null;
    aperture: string | null;
    exposureTime: string | null;
    shutterSpeed: string | null;
    whiteBalance: string | null;
    orientation: number | null;
    gpsPresent: boolean;
    resolution: string | null;
    softwareTag: string | null;
    metadataStatus: string;
  } | null;
  captureEnvironment: {
    /** Human-readable, e.g. "PROOVRA Web Application" — never the enum. */
    uploadSource: string | null;
    captureMethod: string | null;
    browserName: string | null;
    browserVersion: string | null;
    osName: string | null;
    osVersion: string | null;
    deviceClass: string | null;
    engine: string | null;
    platform: string | null;
    timezone: string | null;
    /** Internal-only. Browser locale. */
    locale?: string | null;
    /** Internal-only. UA hash, never the raw User-Agent. */
    userAgentHash?: string | null;
    /** Internal-only. Masked IP (e.g. "203.0.x.x"), never the raw IP. */
    ipAddressMasked?: string | null;
  } | null;
  /** Public: country only. Internal adds region + masked IP + type. */
  network: {
    country: string | null;
    region?: string | null;
    maskedIp?: string | null;
    networkType?: string | null;
  } | null;
  /** Internal-only. Masked intake-link delivery context (never the full
   *  phone). Absent on the public projection and when not an intake
   *  delivery. */
  intakeDelivery?: {
    channel: string;
    maskedRecipient: string;
    deliveryStatus: "delivered" | "sent" | "unknown";
    sentAtUtc: string | null;
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
          exifPresent: e.exifPresent,
          camera: formatCameraLabel(e.cameraMake, e.cameraModel),
          lensModel: e.lensModel,
          originalCaptureTime: e.originalCaptureTime,
          iso: e.iso,
          aperture: e.aperture,
          exposureTime: e.exposureTime,
          shutterSpeed: e.shutterSpeed,
          whiteBalance: e.whiteBalance,
          orientation: e.orientation,
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
          // Humanized labels — never the raw enum on any surface.
          uploadSource: humanizeUploadSource(
            (ceRaw.uploadSource as string | null) ?? null,
          ),
          captureMethod: humanizeCaptureMethod(
            (ceRaw.captureMethod as string | null) ?? null,
          ),
          browserName: (ceRaw.browserName as string | null) ?? null,
          browserVersion: (ceRaw.browserVersion as string | null) ?? null,
          osName: (ceRaw.osName as string | null) ?? null,
          osVersion: (ceRaw.osVersion as string | null) ?? null,
          deviceClass: (ceRaw.deviceClass as string | null) ?? null,
          timezone: (ceRaw.timezone as string | null) ?? null,
          // engine / platform / locale are technical/non-public — internal
          // only (they live in the verification package for the public).
          engine: input.internal ? ((ceRaw.engine as string | null) ?? null) : null,
          platform: input.internal ? ((ceRaw.platform as string | null) ?? null) : null,
          // Internal-only privacy-safe extras (UA hash + masked IP + locale).
          ...(input.internal
            ? {
                locale: (ceRaw.locale as string | null) ?? null,
                userAgentHash: (ceRaw.userAgentHash as string | null) ?? null,
                ipAddressMasked: (ceRaw.ipAddressMasked as string | null) ?? null,
              }
            : {}),
        }
      : null;

    // Network is NEVER public — country/region/masked-IP/type are
    // internal-only (the public verify card shows device/camera only).
    // Never full IP anywhere.
    const ntRaw = (ceRaw?.networkType as string | null) ?? null;
    const country = (ceRaw?.country as string | null) ?? null;
    const network =
      input.internal &&
      ceRaw &&
      (country ||
        (ceRaw.ipAddressMasked as string | null) ||
        (ceRaw.region as string | null))
        ? {
            country,
            region: (ceRaw.region as string | null) ?? null,
            maskedIp: (ceRaw.ipAddressMasked as string | null) ?? null,
            networkType: ntRaw && ntRaw !== "UNKNOWN" ? ntRaw : null,
          }
        : null;

    // Internal-only: masked intake-link delivery context (never the full
    // phone — uses the already-masked recipient_preview stored on
    // communication_messages). Isolated so a failure cannot blank the rest.
    let intakeDelivery: VerifyTechnicalMetadata["intakeDelivery"] = null;
    if (input.internal) {
      try {
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT cm."recipient_preview", cm."channel", cm."status",
                  cm."sent_at_utc"
             FROM "communication_messages" cm
             JOIN "workflow_intake_sessions" wis
               ON wis."id" = cm."related_intake_session_id"
            WHERE wis."evidence_id" = $1
              AND cm."purpose" = 'INTAKE_LINK'
              AND cm."channel" IN ('SMS', 'WHATSAPP')
            ORDER BY cm."created_at" DESC
            LIMIT 1`,
          input.evidenceId,
        )) as Array<{
          recipient_preview: string | null;
          channel: string | null;
          status: string | null;
          sent_at_utc: Date | string | null;
        }>;
        const d = rows[0];
        if (d && d.recipient_preview) {
          const status = (d.status ?? "").toUpperCase();
          const deliveryStatus =
            status === "DELIVERED"
              ? "delivered"
              : status === "SENT" || status === "QUEUED" || status === "RETRY_SCHEDULED"
                ? "sent"
                : "unknown";
          let sentAtUtc: string | null = null;
          try {
            sentAtUtc =
              d.sent_at_utc == null
                ? null
                : d.sent_at_utc instanceof Date
                  ? d.sent_at_utc.toISOString()
                  : new Date(d.sent_at_utc).toISOString();
          } catch {
            sentAtUtc = null;
          }
          intakeDelivery = {
            channel: (d.channel ?? "").toLowerCase() || "unknown",
            maskedRecipient: d.recipient_preview,
            deliveryStatus,
            sentAtUtc,
          };
        }
      } catch {
        intakeDelivery = null;
      }
    }

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
      network,
      ...(intakeDelivery ? { intakeDelivery } : {}),
    };
  } catch {
    return null;
  }
}
