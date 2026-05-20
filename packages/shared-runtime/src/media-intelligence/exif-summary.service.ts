/**
 * Phase 31.8 — Bounded EXIF summary persistence.
 *
 * Stores the projection produced by the EXIF extractor library
 * (`exif-extractor.service.ts`) into `evidence_part_exif_summaries`.
 * Read API for the analyzer to consume cached EXIF data.
 *
 * Hard custody / privacy rules:
 *   * Idempotent upsert: re-running the extractor for the same
 *     (team_id, evidence_part_id) UPDATES the row in place.
 *   * Never persists raw GPS — the schema has no column for it.
 *     `hasGps` boolean is the only GPS field allowed past this
 *     persistence boundary.
 *   * Read returns the bounded shape — no storage internals.
 *   * Never throws to caller; failures return null.
 */

import type { PrismaClient } from "@prisma/client";

import { getRegisteredPrisma } from "../prisma-registry.js";
import type { ExifSafeSummary } from "./exif-extractor.service.js";

// =============================================================================
// Types
// =============================================================================

export type ExifSummaryPersistInput = {
  teamId: string;
  evidenceId: string;
  evidencePartId: string;
  summary: ExifSafeSummary;
  extractedBytes: number;
  status?: "OK" | "PARSE_FAILED" | "UNSUPPORTED_FORMAT" | "INPUT_TOO_LARGE" | "EMPTY_INPUT" | "FETCH_FAILED";
  lastError?: string | null;
  engineVersion?: string;
};

export type ExifSummaryFailureInput = {
  teamId: string;
  evidenceId: string;
  evidencePartId: string;
  status: "PARSE_FAILED" | "UNSUPPORTED_FORMAT" | "INPUT_TOO_LARGE" | "EMPTY_INPUT" | "FETCH_FAILED";
  lastError?: string | null;
  extractedBytes?: number;
  engineVersion?: string;
};

export type ExifSummaryRow = {
  id: string;
  teamId: string;
  evidenceId: string;
  evidencePartId: string;
  exifPresent: boolean;
  dateTimeOriginalUtc: string | null;
  createDateUtc: string | null;
  dimensions: { width: number; height: number } | null;
  cameraMake: string | null;
  cameraModel: string | null;
  software: string | null;
  hasGps: boolean;
  orientation: number | null;
  engineVersion: string;
  status: string;
  lastError: string | null;
  extractedAtUtc: string;
};

// =============================================================================
// Upsert (worker side)
// =============================================================================

/**
 * Idempotent upsert keyed by (team_id, evidence_part_id). Re-running
 * the extractor on the same part replaces the previous row. Never
 * throws — failures return ok:false with a bounded reason.
 */
export async function upsertExifSummary(
  input: ExifSummaryPersistInput,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const s = input.summary;
    await client.$executeRawUnsafe(
      `INSERT INTO "evidence_part_exif_summaries" (
         "team_id", "evidence_id", "evidence_part_id",
         "exif_present", "date_time_original_utc", "create_date_utc",
         "image_width_px", "image_height_px",
         "camera_make", "camera_model", "software",
         "has_gps", "orientation",
         "engine_version", "extracted_at_utc", "extracted_bytes",
         "status", "last_error", "updated_at_utc"
       )
       VALUES (
         $1, $2, $3,
         $4, $5, $6,
         $7, $8,
         $9, $10, $11,
         $12, $13,
         $14, NOW(), $15,
         $16, $17, NOW()
       )
       ON CONFLICT ("team_id", "evidence_part_id") DO UPDATE
         SET "exif_present" = EXCLUDED."exif_present",
             "date_time_original_utc" = EXCLUDED."date_time_original_utc",
             "create_date_utc" = EXCLUDED."create_date_utc",
             "image_width_px" = EXCLUDED."image_width_px",
             "image_height_px" = EXCLUDED."image_height_px",
             "camera_make" = EXCLUDED."camera_make",
             "camera_model" = EXCLUDED."camera_model",
             "software" = EXCLUDED."software",
             "has_gps" = EXCLUDED."has_gps",
             "orientation" = EXCLUDED."orientation",
             "engine_version" = EXCLUDED."engine_version",
             "extracted_at_utc" = EXCLUDED."extracted_at_utc",
             "extracted_bytes" = EXCLUDED."extracted_bytes",
             "status" = EXCLUDED."status",
             "last_error" = EXCLUDED."last_error",
             "updated_at_utc" = NOW()`,
      input.teamId,
      input.evidenceId,
      input.evidencePartId,
      s.exifPresent,
      s.dateTimeOriginalUtc ? new Date(s.dateTimeOriginalUtc) : null,
      s.createDateUtc ? new Date(s.createDateUtc) : null,
      s.dimensions?.width ?? null,
      s.dimensions?.height ?? null,
      s.cameraMake,
      s.cameraModel,
      s.software,
      s.hasGps,
      s.orientation,
      input.engineVersion ?? "exifr-v7-phase31-v1",
      input.extractedBytes,
      input.status ?? "OK",
      sanitizeError(input.lastError ?? null),
    );
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error
          ? `upsert_failed:${err.message.slice(0, 80)}`
          : "upsert_failed",
    };
  }
}

/**
 * Record a failed extraction. Idempotent — overwrites the previous
 * row's status. Useful when the worker couldn't even fetch bytes.
 */
export async function recordExifSummaryFailure(
  input: ExifSummaryFailureInput,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<{ ok: boolean }> {
  try {
    await client.$executeRawUnsafe(
      `INSERT INTO "evidence_part_exif_summaries" (
         "team_id", "evidence_id", "evidence_part_id",
         "exif_present", "has_gps",
         "engine_version", "extracted_bytes",
         "status", "last_error", "updated_at_utc"
       )
       VALUES ($1, $2, $3, FALSE, FALSE, $4, $5, $6, $7, NOW())
       ON CONFLICT ("team_id", "evidence_part_id") DO UPDATE
         SET "status" = EXCLUDED."status",
             "last_error" = EXCLUDED."last_error",
             "extracted_bytes" = EXCLUDED."extracted_bytes",
             "engine_version" = EXCLUDED."engine_version",
             "updated_at_utc" = NOW()`,
      input.teamId,
      input.evidenceId,
      input.evidencePartId,
      input.engineVersion ?? "exifr-v7-phase31-v1",
      input.extractedBytes ?? 0,
      input.status,
      sanitizeError(input.lastError ?? null),
    );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// =============================================================================
// Read (analyzer side)
// =============================================================================

/**
 * Load all EXIF summaries for a given evidence (team-anchored).
 * The analyzer uses this to emit signals based on real extracted
 * data instead of the older client-signal heuristic.
 */
export async function listExifSummariesForEvidence(
  teamId: string,
  evidenceId: string,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<ReadonlyArray<ExifSummaryRow>> {
  try {
    const rows = (await client.$queryRawUnsafe(
      `SELECT "id", "team_id", "evidence_id", "evidence_part_id",
              "exif_present",
              "date_time_original_utc", "create_date_utc",
              "image_width_px", "image_height_px",
              "camera_make", "camera_model", "software",
              "has_gps", "orientation",
              "engine_version", "extracted_at_utc",
              "status", "last_error"
         FROM "evidence_part_exif_summaries"
         WHERE "team_id" = $1 AND "evidence_id" = $2
         ORDER BY "extracted_at_utc" DESC`,
      teamId,
      evidenceId,
    )) as Array<RawExifSummaryRow>;
    return rows.map(projectRow);
  } catch {
    return [];
  }
}

/**
 * Look up the single EXIF summary for one part.
 */
export async function getExifSummaryForPart(
  teamId: string,
  evidencePartId: string,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<ExifSummaryRow | null> {
  try {
    const rows = (await client.$queryRawUnsafe(
      `SELECT "id", "team_id", "evidence_id", "evidence_part_id",
              "exif_present",
              "date_time_original_utc", "create_date_utc",
              "image_width_px", "image_height_px",
              "camera_make", "camera_model", "software",
              "has_gps", "orientation",
              "engine_version", "extracted_at_utc",
              "status", "last_error"
         FROM "evidence_part_exif_summaries"
         WHERE "team_id" = $1 AND "evidence_part_id" = $2
         LIMIT 1`,
      teamId,
      evidencePartId,
    )) as Array<RawExifSummaryRow>;
    if (rows.length === 0) return null;
    return projectRow(rows[0]!);
  } catch {
    return null;
  }
}

// =============================================================================
// Internals
// =============================================================================

type RawExifSummaryRow = {
  id: string;
  team_id: string;
  evidence_id: string;
  evidence_part_id: string;
  exif_present: boolean;
  date_time_original_utc: Date | null;
  create_date_utc: Date | null;
  image_width_px: number | null;
  image_height_px: number | null;
  camera_make: string | null;
  camera_model: string | null;
  software: string | null;
  has_gps: boolean;
  orientation: number | null;
  engine_version: string;
  extracted_at_utc: Date;
  status: string;
  last_error: string | null;
};

function projectRow(raw: RawExifSummaryRow): ExifSummaryRow {
  const dims =
    raw.image_width_px != null && raw.image_height_px != null
      ? { width: raw.image_width_px, height: raw.image_height_px }
      : null;
  return {
    id: raw.id,
    teamId: raw.team_id,
    evidenceId: raw.evidence_id,
    evidencePartId: raw.evidence_part_id,
    exifPresent: raw.exif_present,
    dateTimeOriginalUtc: raw.date_time_original_utc?.toISOString() ?? null,
    createDateUtc: raw.create_date_utc?.toISOString() ?? null,
    dimensions: dims,
    cameraMake: raw.camera_make,
    cameraModel: raw.camera_model,
    software: raw.software,
    hasGps: raw.has_gps,
    orientation: raw.orientation,
    engineVersion: raw.engine_version,
    status: raw.status,
    lastError: raw.last_error,
    extractedAtUtc: raw.extracted_at_utc.toISOString(),
  };
}

function sanitizeError(s: string | null): string | null {
  if (!s) return null;
  return s
    .replace(/[\n\r\t]/g, " ")
    .replace(/https?:\/\/[^\s]+/g, "")
    .slice(0, 240);
}
