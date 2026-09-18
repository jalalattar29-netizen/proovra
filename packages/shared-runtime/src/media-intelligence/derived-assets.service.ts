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
import {
  DEFAULT_DERIVED_ASSET_VARIANT_KEY,
  derivedAssetTransformationForKind,
} from "@proovra/shared";

import { getRegisteredPrisma } from "../prisma-registry.js";

// =============================================================================
// Types
// =============================================================================

export const DERIVED_ASSET_KINDS = [
  "image_thumbnail",
  "video_frame",
  "audio_waveform",
  "low_res_proxy",
  "compact_review_preview",
  // UC-4 — DERIVED evidence intelligence. Keyframes are one derived asset per
  // extracted frame (variantKey kf-NNNN + sourceOffsetMs); the reconstruction is a
  // single bounded versioned JSON descriptor (variantKey recon-vN). Destruction and
  // storage accounting already cover both — `asset_kind` is a free VARCHAR (no CHECK),
  // so this is a code-only extension, no migration.
  "video_keyframe",
  "screen_reconstruction",
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
  /**
   * UC-0 — lineage descriptor. `transformation` defaults to the kind's
   * canonical identifier; `variantKey` to "default" (one derivative per kind,
   * which is what every current producer writes).
   */
  transformation?: string | null;
  parametersSha256?: string | null;
  sourceOffsetMs?: number | null;
  variantKey?: string;
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
 * Idempotent upsert keyed by (team_id, evidence_part_id, asset_kind,
 * variant_key). Re-running the worker on the same part + kind + variant
 * UPDATES the row.
 *
 * UC-0 — the row is the ONLY pointer destruction and storage accounting have
 * to a derived object, so a write must never lose one:
 *   * a COMPLETED write replaces the artifact columns, and returns the storage
 *     pointer it replaced (`previousStorage`) so the caller can remove a
 *     superseded object instead of orphaning it;
 *   * a FAILED / UNSUPPORTED write records the outcome but KEEPS any artifact
 *     already stored (bytes, digest, size, pointer) — those bytes still exist
 *     and must still be counted and destroyed.
 */
export async function recordDerivedAsset(
  input: DerivedAssetRecordInput,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<
  | {
      ok: true;
      id: string;
      previousStorage: { bucket: string; key: string } | null;
    }
  | { ok: false; reason: string }
> {
  const keepOnFailure = (col: string) =>
    `CASE WHEN EXCLUDED."status" = 'COMPLETED' THEN EXCLUDED."${col}"
          ELSE COALESCE(EXCLUDED."${col}", "evidence_part_derived_assets"."${col}") END`;
  try {
    const rows = (await client.$queryRawUnsafe(
      `WITH prev AS (
         SELECT "storage_bucket", "storage_key"
           FROM "evidence_part_derived_assets"
          WHERE "team_id" = $1::uuid AND "evidence_part_id" = $3::uuid
            AND "asset_kind" = $4::varchar AND "variant_key" = $16::varchar
       )
       INSERT INTO "evidence_part_derived_assets" (
         "team_id", "evidence_id", "evidence_part_id", "asset_kind",
         "status", "derived_sha256", "size_bytes", "content_type",
         "width_px", "height_px",
         "source_sha256_at_generation",
         "storage_bucket", "storage_key",
         "last_error", "engine_version",
         "variant_key", "transformation", "parameters_sha256", "source_offset_ms",
         "generated_at_utc", "updated_at_utc"
       )
       VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8,
         $9, $10,
         $11,
         $12, $13,
         $14, $15,
         $16, $17, $18, $19,
         CASE WHEN $5::varchar = 'COMPLETED' THEN NOW() ELSE NULL END,
         NOW()
       )
       ON CONFLICT ("team_id", "evidence_part_id", "asset_kind", "variant_key") DO UPDATE
         SET "status" = EXCLUDED."status",
             "derived_sha256" = ${keepOnFailure("derived_sha256")},
             "size_bytes" = ${keepOnFailure("size_bytes")},
             "content_type" = ${keepOnFailure("content_type")},
             "width_px" = ${keepOnFailure("width_px")},
             "height_px" = ${keepOnFailure("height_px")},
             "source_sha256_at_generation" = ${keepOnFailure("source_sha256_at_generation")},
             "storage_bucket" = ${keepOnFailure("storage_bucket")},
             "storage_key" = ${keepOnFailure("storage_key")},
             "last_error" = EXCLUDED."last_error",
             "engine_version" = EXCLUDED."engine_version",
             "transformation" = EXCLUDED."transformation",
             "parameters_sha256" = ${keepOnFailure("parameters_sha256")},
             "source_offset_ms" = EXCLUDED."source_offset_ms",
             "generated_at_utc" =
               CASE WHEN EXCLUDED."status" = 'COMPLETED'
                    THEN NOW()
                    ELSE "evidence_part_derived_assets"."generated_at_utc"
               END,
             "updated_at_utc" = NOW()
         RETURNING "id",
           (SELECT "storage_bucket" FROM prev) AS "prev_bucket",
           (SELECT "storage_key" FROM prev) AS "prev_key"`,
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
      input.variantKey ?? DEFAULT_DERIVED_ASSET_VARIANT_KEY,
      input.transformation ?? derivedAssetTransformationForKind(input.assetKind),
      input.parametersSha256 ?? null,
      input.sourceOffsetMs ?? null,
    )) as Array<{ id: string; prev_bucket: string | null; prev_key: string | null }>;
    const row = rows[0];
    if (!row) return { ok: false, reason: "upsert_returned_no_row" };
    return {
      ok: true,
      id: row.id,
      previousStorage:
        row.prev_bucket && row.prev_key
          ? { bucket: row.prev_bucket, key: row.prev_key }
          : null,
    };
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
  client: PrismaClient = getRegisteredPrisma(),
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
  client: PrismaClient = getRegisteredPrisma(),
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
