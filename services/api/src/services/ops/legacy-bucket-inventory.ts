/**
 * FINAL-VERIFY-7 / LEGACY-A..D — READ-ONLY inventory of the database rows that
 * still point at the LEGACY bucket `proovra-prod-assets` (Cloudflare R2,
 * Feb–Mar 2026), and the exact objects they expect.
 *
 * Background (2026-11-21): the bucket exists on Cloudflare R2 (account
 * e88f77cf…, 185 objects). Production reads and deletes through ONE global
 * S3 client (services/api/src/storage.ts and services/worker/src/storage.ts
 * build it from S3_ENDPOINT / S3_REGION only). No row carries a provider or
 * endpoint: `storage_bucket` is the only per-row location field. So a legacy
 * row's bucket NAME is right, but it is resolved against the AWS endpoint,
 * where that bucket does not exist (NoSuchBucket).
 *
 * Every statement runs inside `SET TRANSACTION READ ONLY`. Nothing here talks
 * to any object store.
 */
import type { PrismaClient } from "@prisma/client";

export const LEGACY_BUCKET = "proovra-prod-assets";

/** Statuses the capture reaper treats as never sealed (capture-reaper.ts UNSEALED). */
export const UNSEALED_STATUSES = ["CREATED", "UPLOADING"] as const;

export type LegacyRecordClass =
  /** Soft-deleted (deleted_at set). */
  | "A_SOFT_DELETED"
  /** Live, workspace-bound. */
  | "B_LIVE_TEAM"
  /** Live, no workspace (legacy personal record; M626 destruction rules apply). */
  | "C_LIVE_TEAMLESS";

export type LegacyRecord = {
  evidenceId: string;
  class: LegacyRecordClass;
  teamId: string | null;
  status: string;
  sealed: boolean;
  lifecycleState: string;
  softDeleted: boolean;
  createdAtUtc: string;
  hashSemantics: string | null;
  hasFileSha256: boolean;
  sizeBytes: number | null;
  ownObjectInLegacyBucket: boolean;
  partsInLegacyBucket: number;
  partsElsewhere: number;
  reportsInLegacyBucket: number;
  reportsElsewhere: number;
  verificationPackages: number;
  verificationPackagesInLegacyBucket: number;
  derivedAssetsInLegacyBucket: number;
  derivedAssetsElsewhere: number;
  activeLegalHolds: number;
  retentionUntilUtc: string | null;
  objectLockMode: string | null;
  releasedObjectsRemovedAtUtc: string | null;
  /** Selected by removeReleasedReservationObjects (unsealed, soft-deleted, lifecycle ACTIVE, not stamped). */
  captureReaperRetries: boolean;
};

export type ExpectedObject = {
  table: "evidence" | "evidence_parts" | "reports" | "verification_packages" | "evidence_part_derived_assets";
  rowId: string;
  evidenceId: string;
  bucket: string;
  key: string;
  versionId: string | null;
  sizeBytes: number | null;
  /** The SHA-256 the database recorded for exactly these bytes, or null when none applies. */
  sha256: string | null;
  sha256Basis: string;
};

type Tx = Pick<PrismaClient, "$queryRaw" | "$executeRawUnsafe">;

export async function readOnly<T>(client: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return client.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return fn(tx as unknown as Tx);
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

type RecordRow = {
  id: string;
  team_id: string | null;
  status: string;
  lifecycle_state: string;
  deleted_at: Date | null;
  created_at: Date;
  hash_semantics: string | null;
  file_sha256: string | null;
  size_bytes: bigint | null;
  own_object: boolean;
  retention_until_utc: Date | null;
  storage_object_lock_mode: string | null;
  released_objects_removed_at_utc: Date | null;
  parts_legacy: bigint;
  parts_other: bigint;
  reports_legacy: bigint;
  reports_other: bigint;
  packages: bigint;
  packages_legacy: bigint;
  derived_legacy: bigint;
  derived_other: bigint;
  holds: bigint;
};

/** Records with ANY reference to the bucket: their own object, a part, a report, a package or a derived asset. */
export async function collectLegacyRecords(client: PrismaClient, bucket = LEGACY_BUCKET): Promise<LegacyRecord[]> {
  const rows = await readOnly(client, (tx) =>
    tx.$queryRaw<RecordRow[]>`
      WITH ids AS (
        SELECT id FROM evidence WHERE storage_bucket = ${bucket}
        UNION SELECT evidence_id FROM evidence_parts WHERE storage_bucket = ${bucket}
        UNION SELECT evidence_id FROM reports WHERE storage_bucket = ${bucket}
        UNION SELECT evidence_id FROM verification_packages WHERE storage_bucket = ${bucket}
        UNION SELECT evidence_id FROM evidence_part_derived_assets WHERE storage_bucket = ${bucket}
      )
      SELECT e.id::text AS id, e.team_id::text AS team_id, e.status::text AS status, e.lifecycle_state::text AS lifecycle_state,
             e.deleted_at, e.created_at, e.hash_semantics, e.file_sha256, e.size_bytes, (e.storage_bucket = ${bucket} AND e.storage_key IS NOT NULL) AS own_object,
             e.retention_until_utc, e.storage_object_lock_mode, e.released_objects_removed_at_utc,
             (SELECT count(*) FROM evidence_parts p WHERE p.evidence_id = e.id AND p.storage_bucket = ${bucket}) AS parts_legacy,
             (SELECT count(*) FROM evidence_parts p WHERE p.evidence_id = e.id AND p.storage_bucket <> ${bucket}) AS parts_other,
             (SELECT count(*) FROM reports r WHERE r.evidence_id = e.id AND r.storage_bucket = ${bucket}) AS reports_legacy,
             (SELECT count(*) FROM reports r WHERE r.evidence_id = e.id AND r.storage_bucket <> ${bucket}) AS reports_other,
             (SELECT count(*) FROM verification_packages v WHERE v.evidence_id = e.id) AS packages,
             (SELECT count(*) FROM verification_packages v WHERE v.evidence_id = e.id AND v.storage_bucket = ${bucket}) AS packages_legacy,
             (SELECT count(*) FROM evidence_part_derived_assets d WHERE d.evidence_id = e.id AND d.storage_bucket = ${bucket}) AS derived_legacy,
             (SELECT count(*) FROM evidence_part_derived_assets d WHERE d.evidence_id = e.id AND d.storage_bucket IS NOT NULL AND d.storage_bucket <> ${bucket}) AS derived_other,
             (SELECT count(*) FROM evidence_legal_holds h WHERE h.evidence_id = e.id AND h.status::text = 'ACTIVE') AS holds
        FROM evidence e JOIN ids ON ids.id = e.id
       ORDER BY e.created_at, e.id`,
  );
  return rows.map((r) => {
    const unsealed = (UNSEALED_STATUSES as readonly string[]).includes(r.status);
    const softDeleted = r.deleted_at !== null;
    return {
      evidenceId: r.id,
      class: softDeleted ? "A_SOFT_DELETED" : r.team_id ? "B_LIVE_TEAM" : "C_LIVE_TEAMLESS",
      teamId: r.team_id,
      status: r.status,
      sealed: !unsealed && r.status !== "FAILED_HASH_MISMATCH",
      lifecycleState: r.lifecycle_state,
      softDeleted,
      createdAtUtc: r.created_at.toISOString(),
      hashSemantics: r.hash_semantics,
      hasFileSha256: !!r.file_sha256,
      sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
      ownObjectInLegacyBucket: r.own_object,
      partsInLegacyBucket: Number(r.parts_legacy),
      partsElsewhere: Number(r.parts_other),
      reportsInLegacyBucket: Number(r.reports_legacy),
      reportsElsewhere: Number(r.reports_other),
      verificationPackages: Number(r.packages),
      verificationPackagesInLegacyBucket: Number(r.packages_legacy),
      derivedAssetsInLegacyBucket: Number(r.derived_legacy),
      derivedAssetsElsewhere: Number(r.derived_other),
      activeLegalHolds: Number(r.holds),
      retentionUntilUtc: r.retention_until_utc?.toISOString() ?? null,
      objectLockMode: r.storage_object_lock_mode,
      releasedObjectsRemovedAtUtc: r.released_objects_removed_at_utc?.toISOString() ?? null,
      captureReaperRetries: unsealed && softDeleted && r.lifecycle_state === "ACTIVE" && r.released_objects_removed_at_utc === null,
    };
  });
}

type ObjRow = {
  table: ExpectedObject["table"];
  row_id: string;
  evidence_id: string;
  bucket: string;
  key: string;
  version_id: string | null;
  size_bytes: bigint | number | null;
  sha256: string | null;
  basis: string;
};

/** Every object a row expects in the bucket, with the SHA-256 recorded for exactly those bytes. */
export async function collectExpectedObjects(client: PrismaClient, bucket = LEGACY_BUCKET): Promise<ExpectedObject[]> {
  const rows = await readOnly(client, (tx) =>
    tx.$queryRaw<ObjRow[]>`
      SELECT 'evidence' AS "table", e.id::text AS row_id, e.id::text AS evidence_id, e.storage_bucket AS bucket, e.storage_key AS key,
             e.storage_version_id AS version_id, e.size_bytes,
             CASE WHEN COALESCE(e.hash_semantics, 'single_file') = 'single_file' THEN e.file_sha256 ELSE NULL END AS sha256,
             CASE WHEN COALESCE(e.hash_semantics, 'single_file') = 'single_file' THEN 'evidence.file_sha256 (single_file)'
                  ELSE 'none: ' || e.hash_semantics || ' (file_sha256 is not the object hash)' END AS basis
        FROM evidence e WHERE e.storage_bucket = ${bucket} AND e.storage_key IS NOT NULL
      UNION ALL
      SELECT 'evidence_parts', p.id::text, p.evidence_id::text, p.storage_bucket, p.storage_key, p.storage_version_id, p.size_bytes,
             p.sha256, 'evidence_parts.sha256'
        FROM evidence_parts p WHERE p.storage_bucket = ${bucket}
      UNION ALL
      SELECT 'reports', r.id::text, r.evidence_id::text, r.storage_bucket, r.storage_key, NULL, r.size_bytes, r.pdf_sha256, 'reports.pdf_sha256'
        FROM reports r WHERE r.storage_bucket = ${bucket}
      UNION ALL
      SELECT 'verification_packages', v.id::text, v.evidence_id::text, v.storage_bucket, v.storage_key, v.s3_version_id, v.size_bytes,
             v.package_sha256, 'verification_packages.package_sha256'
        FROM verification_packages v WHERE v.storage_bucket = ${bucket}
      UNION ALL
      SELECT 'evidence_part_derived_assets', d.id::text, d.evidence_id::text, d.storage_bucket, d.storage_key, d.storage_version_id,
             d.size_bytes, d.derived_sha256, 'evidence_part_derived_assets.derived_sha256'
        FROM evidence_part_derived_assets d WHERE d.storage_bucket = ${bucket} AND d.storage_key IS NOT NULL
      ORDER BY 1, 3, 2`,
  );
  return rows.map((r) => ({
    table: r.table,
    rowId: r.row_id,
    evidenceId: r.evidence_id,
    bucket: r.bucket,
    key: r.key,
    versionId: r.version_id,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    sha256: r.sha256 ? r.sha256.toLowerCase() : null,
    sha256Basis: r.basis,
  }));
}

/** When each bucket was in use, by record creation time — dates the provider switch. */
export async function bucketTimeline(client: PrismaClient) {
  const rows = await readOnly(client, (tx) =>
    tx.$queryRaw<Array<{ bucket: string | null; n: bigint; first: Date; last: Date }>>`
      SELECT storage_bucket AS bucket, count(*) AS n, min(created_at) AS first, max(created_at) AS last
        FROM evidence GROUP BY storage_bucket ORDER BY min(created_at)`,
  );
  return rows.map((r) => ({ bucket: r.bucket, records: Number(r.n), firstCreatedUtc: r.first.toISOString(), lastCreatedUtc: r.last.toISOString() }));
}
