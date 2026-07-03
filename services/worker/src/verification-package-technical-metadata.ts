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
  buildEvidenceAcquisitionContext,
  type AcquisitionRawInput,
  type CaptureEnvironment,
} from "@proovra/shared-runtime/technical-metadata";
import { maskEmail } from "@proovra/shared";
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

type AcquisitionRow = {
  capture_method: string | null;
  capture_environment: unknown;
  identity_level: string | null;
  opened_at_utc: Date | string | null;
  submitted_at_utc: Date | string | null;
  consent_accepted_at_utc: Date | string | null;
  consent_snapshot_json: unknown;
  submitter_email: string | null;
  intake_mode: string | null;
  consent_policy_version: string | null;
  recipient_email: string | null;
  recipient_preview: string | null;
  recipient_hash: string | null;
  channel: string | null;
  delivery_status: string | null;
  sent_at_utc: Date | string | null;
  delivered_at_utc: Date | string | null;
};

/** Build the pure-mapper input from a raw acquisition row. Masks the email
 *  recipient at read-time via the approved helper (raw email is never
 *  exposed); provider IDs are never selected. */
function rawAcquisitionInput(r: AcquisitionRow): AcquisitionRawInput {
  const uploadSource =
    (r.capture_environment as { uploadSource?: string } | null)?.uploadSource ??
    null;
  const channel = (r.channel ?? "").toUpperCase();
  const isEmail = channel === "EMAIL";
  const recipientType = isEmail ? "email" : channel ? "phone" : null;
  const consentVersion =
    (r.consent_snapshot_json as { policyVersion?: string } | null)
      ?.policyVersion ??
    r.consent_policy_version ??
    null;
  // Masked recipient: phone preview is already masked; email preview is not
  // stored, so mask the email at read-time (never exposing the raw value).
  let recipientMasked = r.recipient_preview ?? null;
  if (isEmail && !recipientMasked) {
    recipientMasked = maskEmail(r.recipient_email ?? r.submitter_email);
  }
  return {
    uploadSource,
    captureMethod: r.capture_method,
    intakeMode: r.intake_mode,
    identityLevel: r.identity_level,
    deliveryChannelRaw: r.channel,
    deliveryStatusRaw: r.delivery_status,
    sentAtUtc: toIsoOrNull(r.sent_at_utc),
    deliveredAtUtc: toIsoOrNull(r.delivered_at_utc),
    openedAtUtc: toIsoOrNull(r.opened_at_utc),
    submittedAtUtc: toIsoOrNull(r.submitted_at_utc),
    consentAcceptedAtUtc: toIsoOrNull(r.consent_accepted_at_utc),
    consentVersion,
    recipientMasked,
    recipientHash: r.recipient_hash,
    recipientType,
  };
}

/** Drop null/undefined/empty-string keys so serialized JSON NEVER carries
 *  hollow fields. Booleans (incl. false) and 0 are kept — they are
 *  meaningful forensic values. */
function compact(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = v;
  }
  return out;
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
            // Grouped, forensic-grade layout. Only fields the file actually
            // carried are emitted — absent fields are OMITTED, never null.
            const camera = compact({
              make: exif.cameraMake,
              model: exif.cameraModel,
              label: formatCameraLabel(exif.cameraMake, exif.cameraModel),
              lensModel: exif.lensModel,
            });
            const capture = compact({
              exifOriginalCaptureTime: exif.originalCaptureTime,
              orientation: exif.orientation,
              // gpsPresent is a definitive boolean, always meaningful.
              gpsPresent: exif.gpsPresent,
            });
            const exposure = compact({
              iso: exif.iso,
              aperture: exif.aperture,
              shutterSpeed: exif.shutterSpeed,
              exposureTime: exif.exposureTime,
              whiteBalance: exif.whiteBalance,
              flash: exif.flash,
              meteringMode: exif.meteringMode,
              exposureMode: exif.exposureMode,
            });
            const image = compact({
              resolution: exif.resolution,
              colorSpace: exif.colorSpace,
              focalLength: exif.focalLength,
              focalLength35mm: exif.focalLength35mm,
              compression: exif.compression,
              imageUniqueId: exif.imageUniqueId,
            });
            const software = compact({
              // Raw device firmware/software build tag — package-only.
              softwareTag: exif.softwareTag,
            });

            const groups: Record<string, Record<string, unknown>> = {};
            if (Object.keys(camera).length) groups.camera = camera;
            // capture always has gpsPresent, so it is always present.
            groups.capture = capture;
            if (Object.keys(exposure).length) groups.exposure = exposure;
            if (Object.keys(image).length) groups.image = image;
            if (Object.keys(software).length) groups.software = software;

            const fieldsPresent = Object.values(groups).flatMap((g) =>
              Object.keys(g),
            );

            return {
              partId: part.id,
              filename: part.original_file_name,
              source: "exif",
              extractedAt: generatedAtUtc,
              metadataStatus: exif.metadataStatus,
              fieldsPresent,
              fieldsOmittedReason:
                "Fields not listed in fieldsPresent were absent from the file's embedded metadata (common for downloaded/exported/screenshotted/stripped files). Absent fields are omitted (never null). Raw GPS coordinates are intentionally never included.",
              ...groups,
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
      "timezone",
      field(captureEnv?.timezone ?? null, "capture_environment", "medium"),
    );
    add(
      "originalCaptureTime",
      field(cameraExif?.originalCaptureTime ?? null, "exif", "high"),
    );

    if (Object.keys(fields).length > 0) {
      // Keep the file's description HONEST about what it actually contains:
      // EXIF-only (no capture environment recorded) must NOT claim OS/device/
      // browser enrichment. Sources reflect the fields actually present.
      const hasExifFields = Boolean(
        cameraLabel ||
          cameraExif?.cameraMake ||
          cameraExif?.cameraModel ||
          cameraExif?.originalCaptureTime,
      );
      const hasEnvFields = Boolean(
        osLabel || captureEnv?.deviceClass || browserLabel || captureEnv?.timezone,
      );
      const sources = [
        hasExifFields ? "exif" : null,
        hasEnvFields ? "capture_environment" : null,
      ].filter(Boolean) as string[];
      const advisory =
        hasExifFields && hasEnvFields
          ? "Concise device/OS/camera enrichment for reviewers. Camera make/model/capture-time come from the file's embedded EXIF; OS/device/browser come from the parsed capture environment. Each field carries its own value, source, and confidence."
          : hasEnvFields
            ? "Concise device/OS/browser enrichment for reviewers, derived from the parsed capture environment. Each field carries its own value, source, and confidence."
            : "Concise CAMERA enrichment for reviewers, derived solely from the file's embedded EXIF (camera make/model and original capture time). No capture environment (OS/device/browser) was recorded for this evidence, so no such fields are present. Each field carries its own value, source, and confidence.";
      out.push({
        path: "technical-metadata/device-enrichment.json",
        json: {
          schemaVersion: TECHNICAL_METADATA_SCHEMA_VERSION,
          schema: "PROOVRA_TECHNICAL_DEVICE_ENRICHMENT",
          evidenceId: input.evidenceId,
          generatedAtUtc,
          advisory,
          sources,
          fields,
        },
      });
    }

    // ---- intake-delivery.json (only for intake/delivery acquisitions) ----
    // Privacy-safe Evidence Acquisition context: how the contributor was
    // reached and how the evidence entered PROOVRA. Uses ONLY the masked
    // recipient preview + HMAC hash (or a read-time maskEmail of an email);
    // the raw phone/email is NEVER read, and provider IDs are NEVER queried.
    // Isolated try/catch so a missing relation cannot drop other files.
    try {
      const rows = (await input.prisma.$queryRawUnsafe(
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
              WHERE c."purpose" = 'INTAKE_LINK'
                AND c."channel" IN ('SMS', 'WHATSAPP', 'EMAIL')
                AND (
                  c."related_intake_session_id" = wis."id"
                  -- The delivery message is created at link SEND time, before
                  -- the session exists, so it is linked by intake_link_id.
                  OR c."related_intake_link_id" = wis."intake_link_id"
                )
              ORDER BY c."created_at" DESC
              LIMIT 1
           ) cm ON true
          WHERE e."id" = $1
            ${input.teamId ? `AND e."team_id" = $2` : ""}
          LIMIT 1`,
        ...(input.teamId
          ? [input.evidenceId, input.teamId]
          : [input.evidenceId]),
      )) as AcquisitionRow[];

      const r = rows[0];
      if (r) {
        const ctx = buildEvidenceAcquisitionContext(
          rawAcquisitionInput(r),
        );
        // Only emit for genuine intake/delivery acquisitions.
        if (ctx && ctx.isIntake) {
          const recipient =
            ctx.recipientMasked != null
              ? compact({
                  type: ctx.recipientType,
                  masked: ctx.recipientMasked,
                  hash: ctx.recipientHash
                    ? `sha256:${ctx.recipientHash}`
                    : null,
                  fullValueIncluded: false,
                })
              : null;
          // A targeted channel (SMS/WhatsApp/Email) with no masked record →
          // explain the absence rather than silently omitting.
          const targetedChannel =
            ctx.deliveryChannel === "SMS" ||
            ctx.deliveryChannel === "WhatsApp" ||
            ctx.deliveryChannel === "Email";
          const recipientUnavailableReason =
            !recipient && targetedChannel
              ? "No masked recipient record available"
              : null;
          const consent = ctx.consentAccepted
            ? compact({
                accepted: true,
                acceptedAtUtc: ctx.consentAcceptedAtUtc,
                version: ctx.consentVersion,
              })
            : null;
          out.push({
            path: "technical-metadata/intake-delivery.json",
            json: {
              schemaVersion: TECHNICAL_METADATA_SCHEMA_VERSION,
              schema: "PROOVRA_TECHNICAL_INTAKE_DELIVERY",
              evidenceId: input.evidenceId,
              generatedAtUtc,
              source: "intake_link_delivery",
              advisory:
                "Privacy-safe Evidence Acquisition context: how the contributor was reached and how the evidence entered PROOVRA. The recipient is masked (full phone/email is NEVER included); provider/message IDs are never included. Delivery/consent are reported only as recorded — never invented.",
              acquisition: {
                method: ctx.method,
                // The ONLY valid intake delivery channels are SMS / WhatsApp /
                // Email / Public Secure Link / PROOVRA Mobile. ctx.deliveryChannel
                // is already one of these for intake; the fallback is a secure
                // link (never null, never "Unknown").
                deliveryChannel: ctx.deliveryChannel ?? "Public Secure Link",
                submissionType: ctx.submissionType,
                submissionStatus: ctx.submissionStatus,
              },
              // Descriptive role model ONLY — never any email / phone / raw
              // recipient / provider identifier. The authenticated workspace
              // account is the link creator; the person who captured/submitted
              // the evidence is a remote contributor. These are distinct actors.
              role: {
                linkCreator: "Workspace Owner",
                contributor: "Remote Contributor",
              },
              // Invitation / source context — how the secure intake link
              // reached the contributor. Descriptive only; carries NO email,
              // phone, provider/message ID, or raw payload.
              invitation: {
                method: "Secure Intake Link",
                sentFrom: "PROOVRA Intake",
                senderRole: "Workspace Owner / Link Creator",
              },
              ...(recipient ? { recipient } : {}),
              ...(recipientUnavailableReason
                ? { recipientUnavailableReason }
                : {}),
              delivery: compact({
                sentAtUtc: ctx.sentAtUtc,
                deliveredAtUtc: ctx.deliveredAtUtc,
                openedAtUtc: ctx.openedAtUtc,
                submittedAtUtc: ctx.submittedAtUtc,
              }),
              ...(consent ? { consent } : {}),
              privacy: {
                publicReport: "recipient_not_included",
                publicVerify: "recipient_not_included",
                package: "masked_and_hashed_only",
                internal: "masked_or_permissioned",
                fullValueIncluded: false,
              },
            },
          });
        }
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
        "verification_package.intake_delivery.build_failed",
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
