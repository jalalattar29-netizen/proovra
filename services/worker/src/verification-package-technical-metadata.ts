/**
 * Enterprise Technical Metadata — verification package files.
 *
 * Emits up to three compact JSON files under technical-metadata/ in
 * the verification package ZIP:
 *
 *   1. technical-metadata/media-summary.json      — per-part Layer-1
 *      deterministic file facts (always emitted).
 *   2. technical-metadata/exif-summary.json       — reviewer-facing EXIF
 *      summary (only when at least one image/video part has EXIF).
 *   3. technical-metadata/capture-environment.json — privacy-safe PROOVRA
 *      upload environment (always emitted; nulls when not recorded).
 *
 * Privacy invariants (enforced by the shared projections):
 *   * No raw GPS coordinates — `gpsPresent` boolean only.
 *   * No raw IP / raw User-Agent — masked IP + UA hash only.
 *
 * ADDITIVE only. The offline verifier ignores these files; their
 * absence never breaks verification. Never throws to the caller —
 * a failure returns an empty array so package generation continues.
 */

import {
  TECHNICAL_METADATA_SCHEMA_VERSION,
  deriveExifSummary,
  formatCameraLabel,
  toPerPartMediaSummary,
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
  size_bytes: bigint | number | null;
  sha256: string | null;
  technical_metadata: unknown;
};

type EvidenceRow = {
  capture_environment: unknown;
};

function num(v: bigint | number | null): number | null {
  if (v == null) return null;
  return typeof v === "bigint" ? Number(v) : v;
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
              p."size_bytes", p."sha256", p."technical_metadata"
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

    const out: TechnicalMetadataPackageEntry[] = [];

    // ---- 1. media-summary.json (always) ----
    const perPart = parts.map((p) =>
      toPerPartMediaSummary({
        id: p.id,
        filename: p.original_file_name,
        sizeBytes: num(p.size_bytes),
        sha256: p.sha256,
        technicalMetadata: p.technical_metadata,
        mimeType: p.mime_type,
      }),
    );
    out.push({
      path: "technical-metadata/media-summary.json",
      json: {
        schemaVersion: TECHNICAL_METADATA_SCHEMA_VERSION,
        schema: "PROOVRA_TECHNICAL_MEDIA_SUMMARY",
        evidenceId: input.evidenceId,
        generatedAtUtc,
        advisory:
          "Deterministic technical facts about the recorded file(s) themselves. This is distinct from the file's embedded EXIF metadata and from the preservation (timestamping/anchoring) state.",
        parts: perPart,
      },
    });

    // ---- 2. exif-summary.json (only when applicable) ----
    const exifParts = parts
      .map((p) => ({ part: p, exif: deriveExifSummary(p.technical_metadata) }))
      .filter((x) => x.exif.applicable);
    if (exifParts.length > 0) {
      out.push({
        path: "technical-metadata/exif-summary.json",
        json: {
          schemaVersion: TECHNICAL_METADATA_SCHEMA_VERSION,
          schema: "PROOVRA_TECHNICAL_EXIF_SUMMARY",
          evidenceId: input.evidenceId,
          generatedAtUtc,
          advisory:
            "Reviewer-facing summary of metadata embedded in the file by the capturing device/software. GPS is reduced to a presence flag; raw coordinates are never included.",
          parts: exifParts.map(({ part, exif }) => ({
            filename: part.original_file_name,
            exifPresent: exif.exifPresent,
            cameraMake: exif.cameraMake,
            cameraModel: exif.cameraModel,
            camera: formatCameraLabel(exif.cameraMake, exif.cameraModel),
            originalCaptureTime: exif.originalCaptureTime,
            gpsPresent: exif.gpsPresent,
            resolution: exif.resolution,
            softwareTag: exif.softwareTag,
            metadataStatus: exif.metadataStatus,
          })),
        },
      });
    }

    // ---- 3. capture-environment.json (always) ----
    const captureEnv =
      (evidenceRows[0]?.capture_environment as CaptureEnvironment | null) ??
      null;
    out.push({
      path: "technical-metadata/capture-environment.json",
      json: {
        schemaVersion: TECHNICAL_METADATA_SCHEMA_VERSION,
        schema: "PROOVRA_TECHNICAL_CAPTURE_ENVIRONMENT",
        evidenceId: input.evidenceId,
        generatedAtUtc,
        advisory:
          "Privacy-safe record of the PROOVRA upload/capture environment. Contains a masked IP and a User-Agent hash only — never the raw IP or raw User-Agent. This is NOT the file's embedded capture metadata.",
        recorded: captureEnv != null,
        captureMethod: captureEnv?.captureMethod ?? null,
        uploadSource: captureEnv?.uploadSource ?? null,
        browserName: captureEnv?.browserName ?? null,
        browserVersion: captureEnv?.browserVersion ?? null,
        osName: captureEnv?.osName ?? null,
        osVersion: captureEnv?.osVersion ?? null,
        deviceClass: captureEnv?.deviceClass ?? null,
        timezone: captureEnv?.timezone ?? null,
        locale: captureEnv?.locale ?? null,
        userAgentHash: captureEnv?.userAgentHash ?? null,
        ipAddressMasked: captureEnv?.ipAddressMasked ?? null,
        attestationAttempted: captureEnv?.attestationAttempted ?? false,
        attestationResult: captureEnv?.attestationResult ?? null,
      },
    });

    return out;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message.slice(0, 160) : "unknown", evidenceId: input.evidenceId },
      "verification_package.technical_metadata.build_failed",
    );
    return [];
  }
}
