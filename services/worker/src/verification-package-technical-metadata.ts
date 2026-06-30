/**
 * Enterprise device/camera enrichment — verification package files.
 *
 * Emits expert-level, NON-DUPLICATIVE technical files under
 * technical-metadata/ in the verification package ZIP. These do NOT
 * repeat manifest/checksums/gallery facts (mime, size, sha256,
 * dimensions, structure) — those live in the canonical package artifacts.
 *
 *   1. technical-metadata/device-enrichment.json  — concise device/OS/
 *      camera roll-up with per-field source + confidence (when available).
 *   2. technical-metadata/exif-details.json        — deep per-part EXIF
 *      for technical reviewers (only when a part carried EXIF), with
 *      source + extractedAt + fieldsPresent + fieldsOmittedReason.
 *   3. technical-metadata/capture-environment.json — privacy-safe PROOVRA
 *      capture environment (only when recorded).
 *
 * Privacy invariants:
 *   * No raw GPS coordinates — `gpsPresent` boolean only.
 *   * No raw IP / raw User-Agent — masked IP + UA hash only; NEVER a full
 *     IP. (A future explicit internal/full package mode could add more.)
 *
 * ADDITIVE only. The offline verifier ignores these files; their absence
 * never breaks verification. Never throws — a failure returns [].
 */

import {
  TECHNICAL_METADATA_SCHEMA_VERSION,
  deriveExifSummary,
  formatCameraLabel,
  type CaptureEnvironment,
} from "@proovra/shared-runtime/technical-metadata";
import { logger } from "./logger.js";

export type TechnicalMetadataPackageEntry = {
  path: string;
  json: unknown;
};

type PrismaLike = {
  $queryRawUnsafe: (q: string, ...params: unknown[]) => Promise<unknown>;
};

type PartRow = {
  id: string;
  original_file_name: string | null;
  mime_type: string | null;
  sha256: string | null;
  technical_metadata: unknown;
};

type EvidenceRow = {
  capture_environment: unknown;
};

type IntakeDeliveryRow = {
  recipient_preview: string | null;
  recipient_hash: string | null;
  channel: string | null;
  status: string | null;
  sent_at_utc: Date | string | null;
  delivered_at_utc: Date | string | null;
};

/** Maps the internal communication status enum to the bounded, package-safe
 *  delivery status vocabulary. Never invents a status — unknown stays
 *  unknown. */
function mapDeliveryStatus(status: string | null): "delivered" | "sent" | "unknown" {
  switch ((status ?? "").toUpperCase()) {
    case "DELIVERED":
      return "delivered";
    case "SENT":
    case "QUEUED":
    case "RETRY_SCHEDULED":
      return "sent";
    default:
      return "unknown";
  }
}

function toIsoOrNull(v: Date | string | null): string | null {
  if (v == null) return null;
  try {
    return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  } catch {
    return null;
  }
}

export async function buildTechnicalMetadataPackageFiles(input: {
  prisma: PrismaLike;
  teamId: string | null;
  evidenceId: string;
  generatedAtUtc?: string;
}): Promise<ReadonlyArray<TechnicalMetadataPackageEntry>> {
  const generatedAtUtc = input.generatedAtUtc ?? new Date().toISOString();
  try {
    const parts = (await input.prisma.$queryRawUnsafe(
      `SELECT p."id", p."original_file_name", p."mime_type",
              p."sha256", p."technical_metadata"
         FROM "evidence_parts" p
         JOIN "evidence" e ON e."id" = p."evidence_id"
         WHERE e."id" = $1
           ${input.teamId ? `AND e."team_id" = $2` : ""}
         ORDER BY p."part_index" ASC`,
      ...(input.teamId ? [input.evidenceId, input.teamId] : [input.evidenceId]),
    )) as PartRow[];

    const evidenceRows = (await input.prisma.$queryRawUnsafe(
      `SELECT "capture_environment"
         FROM "evidence"
        WHERE "id" = $1
        LIMIT 1`,
      input.evidenceId,
    )) as EvidenceRow[];

    const captureEnv =
      (evidenceRows[0]?.capture_environment as CaptureEnvironment | null) ??
      null;

    const out: TechnicalMetadataPackageEntry[] = [];

    // ---- exif-details.json (only when at least one part carried EXIF) ----
    const exifParts = parts
      .map((p) => ({ part: p, exif: deriveExifSummary(p.technical_metadata) }))
      .filter((x) => x.exif.applicable);
    if (exifParts.length > 0) {
      out.push({
        path: "technical-metadata/exif-details.json",
        json: {
          schemaVersion: TECHNICAL_METADATA_SCHEMA_VERSION,
          schema: "PROOVRA_TECHNICAL_EXIF_DETAILS",
          evidenceId: input.evidenceId,
          generatedAtUtc,
          source: "exif",
          advisory:
            "Deep metadata embedded in the file by the capturing device/software, for technical reviewers. GPS is reduced to a presence flag; raw coordinates are never included. Does not duplicate the manifest's mime/size/hash facts.",
          parts: exifParts.map(({ part, exif }) => {
            const fields: Record<string, unknown> = {
              camera: formatCameraLabel(exif.cameraMake, exif.cameraModel),
              cameraMake: exif.cameraMake,
              cameraModel: exif.cameraModel,
              lensModel: exif.lensModel,
              originalCaptureTime: exif.originalCaptureTime,
              iso: exif.iso,
              aperture: exif.aperture,
              exposureTime: exif.exposureTime,
              shutterSpeed: exif.shutterSpeed,
              whiteBalance: exif.whiteBalance,
              orientation: exif.orientation,
              resolution: exif.resolution,
              software: exif.softwareTag,
              compression: exif.compression,
              gpsPresent: exif.gpsPresent,
            };
            const fieldsPresent = Object.entries(fields)
              .filter(([, v]) => v !== null && v !== undefined && v !== "")
              .map(([k]) => k);
            return {
              partId: part.id,
              filename: part.original_file_name,
              source: "exif",
              extractedAt: generatedAtUtc,
              metadataStatus: exif.metadataStatus,
              fieldsPresent,
              fieldsOmittedReason:
                "Fields not listed in fieldsPresent were absent from the file's embedded metadata (common for downloaded/exported/screenshotted/stripped files). Raw GPS coordinates are intentionally never included.",
              ...fields,
            };
          }),
        },
      });
    }

    // ---- capture-environment.json (only when recorded) ----
    if (captureEnv) {
      out.push({
        path: "technical-metadata/capture-environment.json",
        json: {
          schemaVersion: TECHNICAL_METADATA_SCHEMA_VERSION,
          schema: "PROOVRA_TECHNICAL_CAPTURE_ENVIRONMENT",
          evidenceId: input.evidenceId,
          generatedAtUtc,
          source: "browser+server-observed",
          advisory:
            "Privacy-safe record of the PROOVRA upload/capture environment. Browser/OS/device/timezone/locale are parsed from the client; masked IP + UA hash + country are server-observed. NEVER the full IP or raw User-Agent.",
          captureMethod: captureEnv.captureMethod ?? null,
          uploadSource: captureEnv.uploadSource ?? null,
          browserName: captureEnv.browserName ?? null,
          browserVersion: captureEnv.browserVersion ?? null,
          osName: captureEnv.osName ?? null,
          osVersion: captureEnv.osVersion ?? null,
          deviceClass: captureEnv.deviceClass ?? null,
          engine: captureEnv.engine ?? null,
          platform: captureEnv.platform ?? null,
          timezone: captureEnv.timezone ?? null,
          locale: captureEnv.locale ?? null,
          userAgentHash: captureEnv.userAgentHash ?? null,
          ipAddressMasked: captureEnv.ipAddressMasked ?? null,
          country: captureEnv.country ?? null,
          region: captureEnv.region ?? null,
          networkType:
            captureEnv.networkType && captureEnv.networkType !== "UNKNOWN"
              ? captureEnv.networkType
              : null,
          attestationAttempted: captureEnv.attestationAttempted ?? false,
          attestationResult: captureEnv.attestationResult ?? null,
        },
      });
    }

    // ---- device-enrichment.json (only when device/OS/camera available) ----
    // Concise roll-up of the genuinely-enriching device facts (EXIF
    // camera + capture-env OS/device), with per-field source. Does not
    // duplicate the manifest or the deep exif-details file.
    const cameraExif = exifParts[0]?.exif ?? null;
    const cameraLabel = cameraExif
      ? formatCameraLabel(cameraExif.cameraMake, cameraExif.cameraModel)
      : null;
    const osLabel =
      captureEnv?.osName
        ? [captureEnv.osName, captureEnv.osVersion].filter(Boolean).join(" ")
        : null;
    const browserLabel =
      captureEnv?.browserName
        ? [captureEnv.browserName, captureEnv.browserVersion]
            .filter(Boolean)
            .join(" ")
        : null;

    // Field-level enrichment: every field carries its own {value, source,
    // confidence}. Only meaningful fields are emitted (no null padding).
    const field = (
      value: string | null,
      source: string,
      confidence: "high" | "medium" | "low",
    ) => (value ? { value, source, confidence } : null);

    const fields: Record<
      string,
      { value: string; source: string; confidence: string }
    > = {};
    const add = (
      key: string,
      f: { value: string; source: string; confidence: string } | null,
    ) => {
      if (f) fields[key] = f;
    };
    add("captureDevice", field(cameraLabel, "exif", "high"));
    add("cameraMake", field(cameraExif?.cameraMake ?? null, "exif", "high"));
    add("cameraModel", field(cameraExif?.cameraModel ?? null, "exif", "high"));
    add("operatingSystem", field(osLabel, "capture_environment", "medium"));
    add(
      "deviceClass",
      field(captureEnv?.deviceClass ?? null, "capture_environment", "medium"),
    );
    add("browser", field(browserLabel, "capture_environment", "medium"));
    add(
      "originalCaptureTime",
      field(cameraExif?.originalCaptureTime ?? null, "exif", "high"),
    );

    if (Object.keys(fields).length > 0) {
      out.push({
        path: "technical-metadata/device-enrichment.json",
        json: {
          schemaVersion: TECHNICAL_METADATA_SCHEMA_VERSION,
          schema: "PROOVRA_TECHNICAL_DEVICE_ENRICHMENT",
          evidenceId: input.evidenceId,
          generatedAtUtc,
          advisory:
            "Concise device/OS/camera enrichment for reviewers. Camera/make/model/capture-time come from the file's embedded EXIF; OS/device/browser come from the parsed capture environment. Each field carries its own value, source, and confidence.",
          fields,
        },
      });
    }

    // ---- intake-recipient-context.json (only for intake-link deliveries) ----
    // Privacy-safe delivery context for evidence collected via an intake
    // link sent to a phone. Uses ONLY the already-masked recipient preview +
    // HMAC hash stored on communication_messages — the raw phone number is
    // NEVER read, never present in the package. Isolated try/catch so a
    // missing relation can never drop the other technical-metadata files.
    try {
      const deliveryRows = (await input.prisma.$queryRawUnsafe(
        `SELECT cm."recipient_preview", cm."recipient_hash", cm."channel",
                cm."status", cm."sent_at_utc", cm."delivered_at_utc"
           FROM "communication_messages" cm
           JOIN "workflow_intake_sessions" wis
             ON wis."id" = cm."related_intake_session_id"
          WHERE wis."evidence_id" = $1
            AND cm."purpose" = 'INTAKE_LINK'
            AND cm."channel" IN ('SMS', 'WHATSAPP')
            ${input.teamId ? `AND cm."team_id" = $2` : ""}
          ORDER BY cm."created_at" DESC
          LIMIT 1`,
        ...(input.teamId
          ? [input.evidenceId, input.teamId]
          : [input.evidenceId]),
      )) as IntakeDeliveryRow[];

      const delivery = deliveryRows[0];
      // Only emit when an intake phone delivery with a masked recipient exists.
      if (delivery && delivery.recipient_preview) {
        out.push({
          path: "technical-metadata/intake-recipient-context.json",
          json: {
            schemaVersion: TECHNICAL_METADATA_SCHEMA_VERSION,
            schema: "PROOVRA_TECHNICAL_INTAKE_RECIPIENT_CONTEXT",
            evidenceId: input.evidenceId,
            generatedAtUtc,
            source: "intake_link_delivery",
            advisory:
              "Privacy-safe delivery context for evidence collected via an intake link sent to a phone recipient. The recipient is masked; the full phone number is NEVER included in this package. Delivery status is reported as observed from the messaging provider, or 'unknown' when not reported.",
            recipient: {
              type: "phone",
              masked: delivery.recipient_preview,
              hash: delivery.recipient_hash
                ? `hmac-sha256:${delivery.recipient_hash}`
                : null,
              fullValueIncluded: false,
            },
            delivery: {
              channel: (delivery.channel ?? "").toLowerCase() || "unknown",
              sentAtUtc: toIsoOrNull(delivery.sent_at_utc),
              deliveryStatus: mapDeliveryStatus(delivery.status),
              linkOpenedAtUtc: null,
              deliveredAtUtc: toIsoOrNull(delivery.delivered_at_utc),
            },
            privacy: {
              publicReport: "not_included",
              publicVerify: "not_included",
              package: "masked_only",
              internal: "masked_or_permissioned",
            },
          },
        });
      }
    } catch (intakeErr) {
      logger.warn(
        {
          err:
            intakeErr instanceof Error
              ? intakeErr.message.slice(0, 160)
              : "unknown",
          evidenceId: input.evidenceId,
        },
        "verification_package.intake_recipient_context.build_failed",
      );
    }

    return out;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message.slice(0, 160) : "unknown", evidenceId: input.evidenceId },
      "verification_package.technical_metadata.build_failed",
    );
    return [];
  }
}
