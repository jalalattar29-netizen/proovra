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
  buildEvidenceAcquisitionContext,
  toPublicAcquisition,
  toInternalAcquisition,
  type EvidenceAcquisitionContext,
} from "@proovra/shared-runtime/technical-metadata";
import { maskEmail } from "@proovra/shared";

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
  /** Internal-only. Richer photographic EXIF for authenticated reviewers —
   *  never present on the public projection. */
  exifExtended?: {
    flash: string | null;
    meteringMode: string | null;
    exposureMode: string | null;
    colorSpace: string | null;
    focalLength: string | null;
    focalLength35mm: string | null;
    imageUniqueId: string | null;
  } | null;
  /** Evidence Acquisition context — how the evidence entered PROOVRA.
   *  Present on BOTH public and internal projections, but the recipient
   *  fields (recipientType/recipientMasked/consentAcceptedAtUtc) are
   *  INTERNAL-ONLY. Never a full phone/email, never provider IDs. */
  acquisition?: {
    method: string;
    deliveryChannel: string | null;
    submissionType: string;
    submissionStatus: string[];
    identityVerification: string;
    consentAccepted: boolean | null;
    consentVersion: string | null;
    submittedAtUtc: string | null;
    /** Internal-only. */
    recipientType?: "phone" | "email" | null;
    /** Internal-only masked recipient (never raw). */
    recipientMasked?: string | null;
    /** Internal-only. */
    consentAcceptedAtUtc?: string | null;
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
    let exifExtended: VerifyTechnicalMetadata["exifExtended"] = null;
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
        // Richer photographic EXIF — INTERNAL ONLY (package-grade detail
        // that never appears on the public verify page).
        if (input.internal) {
          exifExtended = {
            flash: e.flash,
            meteringMode: e.meteringMode,
            exposureMode: e.exposureMode,
            colorSpace: e.colorSpace,
            focalLength: e.focalLength,
            focalLength35mm: e.focalLength35mm,
            imageUniqueId: e.imageUniqueId,
          };
        }
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

    // Evidence Acquisition context. Public gets method/channel/type/status/
    // consent (no recipient); internal additionally gets the MASKED
    // recipient. Never a full phone/email, never provider IDs. Isolated so
    // a failure cannot blank the rest of the projection.
    let acquisition: VerifyTechnicalMetadata["acquisition"] = null;
    try {
      const ctx = await queryAcquisitionContext(prisma, {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
      });
      if (ctx && ctx.isIntake) {
        acquisition = input.internal
          ? toInternalAcquisition(ctx)
          : toPublicAcquisition(ctx);
      }
    } catch {
      acquisition = null;
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
      ...(exifExtended ? { exifExtended } : {}),
      ...(acquisition ? { acquisition } : {}),
    };
  } catch {
    return null;
  }
}

/** Query + normalize the Evidence Acquisition context. Reads only the masked
 *  recipient preview / hash (or a read-time maskEmail); never the raw
 *  phone/email, never provider IDs. */
async function queryAcquisitionContext(
  prisma: typeof defaultPrisma,
  input: { teamId: string | null; evidenceId: string },
): Promise<EvidenceAcquisitionContext | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT
        e."capture_method"              AS capture_method,
        e."capture_environment"         AS capture_environment,
        e."identity_level_snapshot"     AS identity_level,
        wis."opened_at_utc"             AS opened_at_utc,
        wis."submitted_at_utc"          AS submitted_at_utc,
        wis."consent_accepted_at_utc"   AS consent_accepted_at_utc,
        wis."consent_snapshot_json"     AS consent_snapshot_json,
        wis."submitter_email"           AS submitter_email,
        wil."intake_mode"               AS intake_mode,
        wil."consent_policy_version"    AS consent_policy_version,
        wil."recipient_email"           AS recipient_email,
        cm."recipient_preview"          AS recipient_preview,
        cm."recipient_hash"             AS recipient_hash,
        cm."channel"                    AS channel,
        cm."status"                     AS delivery_status,
        cm."sent_at_utc"                AS sent_at_utc,
        cm."delivered_at_utc"           AS delivered_at_utc
       FROM "evidence" e
       LEFT JOIN "workflow_intake_sessions" wis ON wis."evidence_id" = e."id"
       LEFT JOIN "workflow_intake_links" wil ON wil."id" = wis."intake_link_id"
       LEFT JOIN LATERAL (
         SELECT c."recipient_preview", c."recipient_hash", c."channel",
                c."status", c."sent_at_utc", c."delivered_at_utc"
           FROM "communication_messages" c
          WHERE c."related_intake_session_id" = wis."id"
            AND c."purpose" = 'INTAKE_LINK'
            AND c."channel" IN ('SMS', 'WHATSAPP', 'EMAIL')
          ORDER BY c."created_at" DESC
          LIMIT 1
       ) cm ON true
      WHERE e."id" = $1
        ${input.teamId ? `AND e."team_id" = $2` : ""}
      LIMIT 1`,
    ...(input.teamId ? [input.evidenceId, input.teamId] : [input.evidenceId]),
  )) as Array<Record<string, unknown>>;

  const r = rows[0];
  if (!r) return null;
  const iso = (v: unknown): string | null => {
    if (v == null) return null;
    try {
      return v instanceof Date
        ? v.toISOString()
        : new Date(String(v)).toISOString();
    } catch {
      return null;
    }
  };
  const channel = String(r.channel ?? "").toUpperCase();
  const isEmail = channel === "EMAIL";
  let recipientMasked = (r.recipient_preview as string | null) ?? null;
  if (isEmail && !recipientMasked) {
    recipientMasked = maskEmail(
      (r.recipient_email as string | null) ??
        (r.submitter_email as string | null),
    );
  }
  const consentVersion =
    (r.consent_snapshot_json as { policyVersion?: string } | null)
      ?.policyVersion ??
    (r.consent_policy_version as string | null) ??
    null;
  return buildEvidenceAcquisitionContext({
    uploadSource:
      (r.capture_environment as { uploadSource?: string } | null)
        ?.uploadSource ?? null,
    captureMethod: (r.capture_method as string | null) ?? null,
    intakeMode: (r.intake_mode as string | null) ?? null,
    identityLevel: (r.identity_level as string | null) ?? null,
    deliveryChannelRaw: (r.channel as string | null) ?? null,
    deliveryStatusRaw: (r.delivery_status as string | null) ?? null,
    sentAtUtc: iso(r.sent_at_utc),
    deliveredAtUtc: iso(r.delivered_at_utc),
    openedAtUtc: iso(r.opened_at_utc),
    submittedAtUtc: iso(r.submitted_at_utc),
    consentAcceptedAtUtc: iso(r.consent_accepted_at_utc),
    consentVersion,
    recipientMasked,
    recipientHash: (r.recipient_hash as string | null) ?? null,
    recipientType: recipientMasked ? (isEmail ? "email" : "phone") : null,
  });
}
