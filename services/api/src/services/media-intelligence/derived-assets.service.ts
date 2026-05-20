/**
 * Phase 31.13 — Derived assets persistence service.
 *
 * Bounded upsert + read for `evidence_part_derived_assets`. The
 * worker calls `recordDerivedAsset` after generating bytes, the
 * read APIs call `listDerivedAssetsForEvidence` / `getDerivedAsset`.
 *
 * Hard custody / privacy rules:
 *
 *   * NEVER throws to caller. Failures return null / empty / a
 *     bounded `{ ok: false, reason }` shape.
 *   * Read projections NEVER include the `storage_bucket` /
 *     `storage_key` columns. Those columns exist on the table so
 *     the bytes can be served back via a separate auth-gated
 *     endpoint, but they MUST NOT appear in any API response.
 *   * Originals are never touched — this service only operates on
 *     the derived row.
 *   * Per-team scoping is enforced by every read.
 *   * The bounded `derivedSha256` is the hash of the DERIVED bytes,
 *     not the source. The `sourceSha256AtGeneration` captures the
 *     source hash AT generation time so downstream consumers can
 *     cross-check against `evidence_parts.sha256`.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

// =============================================================================
// Types
// =============================================================================

export const DERIVED_ASSET_KINDS = [
  "image_thumbnail",
  "video_frame",
  "audio_waveform",
  "low_res_proxy",
  "compact_review_preview",
] as const;
export type DerivedAssetKind = (typeof DERIVED_ASSET_KINDS)[number];

export const DERIVED_ASSET_STATUSES = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "UNSUPPORTED",
] as const;
export type DerivedAssetStatus = (typeof DERIVED_ASSET_STATUSES)[number];

export type DerivedAssetRecordInput = {
  teamId: string;
  evidenceId: string;
  evidencePartId: string;
  assetKind: DerivedAssetKind;
  status: DerivedAssetStatus;
  derivedSha256?: string | null;
  sizeBytes?: number | null;
  contentType?: string | null;
  widthPx?: number | null;
  heightPx?: number | null;
  sourceSha256AtGeneration?: string | null;
  storageBucket?: string | null;
  storageKey?: string | null;
  lastError?: string | null;
  engineVersion?: string;
};

/**
 * Bounded read shape. Storage internals (bucket/key) are absent by
 * construction. The read API NEVER projects them.
 */
export type DerivedAssetRow = {
  id: string;
  evidenceId: string;
  evidencePartId: string;
  assetKind: DerivedAssetKind;
  status: DerivedAssetStatus;
  derivedSha256: string | null;
  sizeBytes: number | null;
  contentType: string | null;
  widthPx: number | null;
  heightPx: number | null;
  sourceSha256AtGeneration: string | null;
  lastError: string | null;
  engineVersion: string;
  generatedAtUtc: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
};

// =============================================================================
// Upsert (worker side)
// =============================================================================

/**
 * Idempotent upsert keyed by (team_id, evidence_part_id, asset_kind).
 * Re-running the worker on the same part + kind UPDATES the row.
 */
export async function recordDerivedAsset(
  input: DerivedAssetRecordInput,
  client: PrismaClient = defaultPrisma,
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  try {
    const rows = (await client.$queryRawUnsafe(
      `INSERT INTO "evidence_part_derived_assets" (
         "team_id", "evidence_id", "evidence_part_id", "asset_kind",
         "status", "derived_sha256", "size_bytes", "content_type",
         "width_px", "height_px",
         "source_sha256_at_generation",
         "storage_bucket", "storage_key",
         "last_error", "engine_version",
         "generated_at_utc", "updated_at_utc"
       )
       VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8,
         $9, $10,
         $11,
         $12, $13,
         $14, $15,
         CASE WHEN $5 = 'COMPLETED' THEN NOW() ELSE NULL END,
         NOW()
       )
       ON CONFLICT ("team_id", "evidence_part_id", "asset_kind") DO UPDATE
         SET "status" = EXCLUDED."status",
             "derived_sha256" = EXCLUDED."derived_sha256",
             "size_bytes" = EXCLUDED."size_bytes",
             "content_type" = EXCLUDED."content_type",
             "width_px" = EXCLUDED."width_px",
             "height_px" = EXCLUDED."height_px",
             "source_sha256_at_generation" = EXCLUDED."source_sha256_at_generation",
             "storage_bucket" = EXCLUDED."storage_bucket",
             "storage_key" = EXCLUDED."storage_key",
             "last_error" = EXCLUDED."last_error",
             "engine_version" = EXCLUDED."engine_version",
             "generated_at_utc" =
               CASE WHEN EXCLUDED."status" = 'COMPLETED'
                    THEN NOW()
                    ELSE "evidence_part_derived_assets"."generated_at_utc"
               END,
             "updated_at_utc" = NOW()
         RETURNING "id"`,
      input.teamId,
      input.evidenceId,
      input.evidencePartId,
      input.assetKind,
      input.status,
      input.derivedSha256 ?? null,
      input.sizeBytes ?? null,
      input.contentType ?? null,
      input.widthPx ?? null,
      input.heightPx ?? null,
      input.sourceSha256AtGeneration ?? null,
      input.storageBucket ?? null,
      input.storageKey ?? null,
      sanitizeError(input.lastError ?? null),
      input.engineVersion ?? "sharp-v0-phase31-v1",
    )) as Array<{ id: string }>;
    const row = rows[0];
    if (!row) return { ok: false, reason: "upsert_returned_no_row" };
    return { ok: true, id: row.id };
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

// =============================================================================
// Read (API side)
// =============================================================================

/**
 * List derived assets for one evidence, team-anchored. Storage
 * internals are NEVER projected.
 */
export async function listDerivedAssetsForEvidence(
  teamId: string,
  evidenceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<DerivedAssetRow>> {
  try {
    const rows = (await client.$queryRawUnsafe(
      `SELECT "id", "evidence_id", "evidence_part_id", "asset_kind",
              "status", "derived_sha256", "size_bytes", "content_type",
              "width_px", "height_px",
              "source_sha256_at_generation",
              "last_error", "engine_version",
              "generated_at_utc", "created_at_utc", "updated_at_utc"
         FROM "evidence_part_derived_assets"
        WHERE "team_id" = $1 AND "evidence_id" = $2
        ORDER BY "asset_kind" ASC, "updated_at_utc" DESC`,
      teamId,
      evidenceId,
    )) as Array<RawDerivedRow>;
    return rows.map(projectRow);
  } catch {
    return [];
  }
}

/**
 * Internal worker-side helper that DOES fetch the storage
 * reference. Never exported through any API route.
 */
export async function _getDerivedAssetStorageReference(
  teamId: string,
  id: string,
  client: PrismaClient = defaultPrisma,
): Promise<{ bucket: string; key: string; contentType: string | null } | null> {
  try {
    const rows = (await client.$queryRawUnsafe(
      `SELECT "storage_bucket", "storage_key", "content_type"
         FROM "evidence_part_derived_assets"
        WHERE "id" = $1 AND "team_id" = $2 AND "status" = 'COMPLETED'
        LIMIT 1`,
      id,
      teamId,
    )) as Array<{
      storage_bucket: string | null;
      storage_key: string | null;
      content_type: string | null;
    }>;
    const r = rows[0];
    if (!r || !r.storage_bucket || !r.storage_key) return null;
    return {
      bucket: r.storage_bucket,
      key: r.storage_key,
      contentType: r.content_type,
    };
  } catch {
    return null;
  }
}

// =============================================================================
// Internals
// =============================================================================

type RawDerivedRow = {
  id: string;
  evidence_id: string;
  evidence_part_id: string;
  asset_kind: string;
  status: string;
  derived_sha256: string | null;
  size_bytes: number | null;
  content_type: string | null;
  width_px: number | null;
  height_px: number | null;
  source_sha256_at_generation: string | null;
  last_error: string | null;
  engine_version: string;
  generated_at_utc: Date | null;
  created_at_utc: Date;
  updated_at_utc: Date;
};

function projectRow(raw: RawDerivedRow): DerivedAssetRow {
  return {
    id: raw.id,
    evidenceId: raw.evidence_id,
    evidencePartId: raw.evidence_part_id,
    assetKind: raw.asset_kind as DerivedAssetKind,
    status: raw.status as DerivedAssetStatus,
    derivedSha256: raw.derived_sha256,
    sizeBytes: raw.size_bytes,
    contentType: raw.content_type,
    widthPx: raw.width_px,
    heightPx: raw.height_px,
    sourceSha256AtGeneration: raw.source_sha256_at_generation,
    lastError: raw.last_error,
    engineVersion: raw.engine_version,
    generatedAtUtc: raw.generated_at_utc?.toISOString() ?? null,
    createdAtUtc: raw.created_at_utc.toISOString(),
    updatedAtUtc: raw.updated_at_utc.toISOString(),
  };
}

function sanitizeError(s: string | null): string | null {
  if (!s) return null;
  return s
    .replace(/[\n\r\t]/g, " ")
    .replace(/https?:\/\/[^\s]+/g, "")
    .slice(0, 240);
}
