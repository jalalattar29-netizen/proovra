/**
 * Phase C #9 — Orphan upload / artifact maintenance scan (read-only).
 *
 * First pass intentionally does NOT delete anything. It logs counts of:
 *
 *   - Capture sessions older than the configured threshold whose draft was
 *     never finalized (reaper alone marks expired by expiresAtUtc; this
 *     surfaces "dormant" drafts whose expiry hasn't tripped yet).
 *   - Evidence records stuck in CREATED / UPLOADING for longer than the
 *     stuck-evidence threshold.
 *   - EvidencePart rows older than the part-orphan threshold whose
 *     uploadedAtUtc is null (presigned but bytes never confirmed at S3).
 *   - Report and package objects published to locked storage whose row never
 *     committed (REPORT-006): an intent past the threshold that no report or
 *     package row references. Such an object cannot be deleted before its
 *     horizon, so it is counted for Operations, never touched.
 *
 * The scan publishes a structured operational log line with the counts so
 * an operator can act. We deliberately do not delete completed evidence,
 * forensic artifacts, custody events, or report rows from this job.
 */
import * as prismaPkg from "@prisma/client";
import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import { prisma } from "./db.js";

/**
 * THE WORK THIS MODULE RECOVERS.
 *
 * Declared here so the canonical work registry's `reconciler` field can be
 * checked against the module it names rather than merely against the
 * filesystem. The topology gate proves the two agree in both directions: a
 * registry entry pointing at a module that does not claim its work fails, and
 * a module claiming work no entry assigns it fails.
 *
 * That check exists because the weaker one — "the declared file exists" —
 * passed three false declarations in a row: UPGRADE_OTS and
 * PURGE_DELETED_EVIDENCE both named a module containing no such code, and
 * EMBED_SEMANTIC_CHUNKS named one whose every scan keyed on a table the embed
 * chain never writes. All three resolved to a real file. None of them was true.
 *
 * Keys, not values: the registry addresses work through `JOB_NAMES` /
 * `SWEEP_NAMES`, and a literal string here would be a second spelling of a
 * name the shared authority already owns.
 */
export const RECOVERED_WORK_TYPES = [
  "ORPHAN_SCAN",
] as const;


export interface RunOrphanArtifactScanOptions {
  trigger?: string;
  /** ms — drafts older than this with no activity are flagged. Default 14d. */
  dormantDraftAgeMs?: number;
  /** ms — Evidence in CREATED/UPLOADING longer than this is flagged. Default 24h. */
  stuckEvidenceAgeMs?: number;
  /** ms — Parts whose uploadedAtUtc is null and were created longer ago. Default 24h. */
  presignedNeverConfirmedAgeMs?: number;
  /** ms — an intent younger than this may still be committing. Default 24h. */
  unreferencedPublicationAgeMs?: number;
}

export interface OrphanArtifactScanResult {
  dormantDraftCount: number;
  stuckEvidenceCount: number;
  unconfirmedPartCount: number;
  unreferencedPublishedArtifactCount: number;
}

const DEFAULT_UNREFERENCED_PUBLICATION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DORMANT_DRAFT_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_STUCK_EVIDENCE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UNCONFIRMED_PART_MS = 24 * 60 * 60 * 1000;

export async function runOrphanArtifactScan(
  options: RunOrphanArtifactScanOptions = {}
): Promise<OrphanArtifactScanResult> {
  const requestId = randomUUID();
  const trigger = options.trigger ?? "manual";
  const now = Date.now();

  const dormantThreshold = new Date(
    now - (options.dormantDraftAgeMs ?? DEFAULT_DORMANT_DRAFT_MS)
  );
  const stuckEvidenceThreshold = new Date(
    now - (options.stuckEvidenceAgeMs ?? DEFAULT_STUCK_EVIDENCE_MS)
  );
  const unconfirmedPartThreshold = new Date(
    now - (options.presignedNeverConfirmedAgeMs ?? DEFAULT_UNCONFIRMED_PART_MS)
  );

  const unreferencedThreshold = new Date(
    now - (options.unreferencedPublicationAgeMs ?? DEFAULT_UNREFERENCED_PUBLICATION_MS)
  );

  const [dormantDraftCount, stuckEvidenceCount, unconfirmedPartCount, unreferenced] =
    await Promise.all([
      prisma.captureSession.count({
        where: {
          status: prismaPkg.CaptureSessionStatus.DRAFT,
          updatedAt: { lt: dormantThreshold },
        },
      }),
      prisma.evidence.count({
        where: {
          status: { in: [prismaPkg.EvidenceStatus.CREATED, prismaPkg.EvidenceStatus.UPLOADING] },
          createdAt: { lt: stuckEvidenceThreshold },
          deletedAt: null,
        },
      }),
      prisma.evidencePart.count({
        where: {
          uploadedAtUtc: null,
          createdAt: { lt: unconfirmedPartThreshold },
        },
      }),
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS "count"
          FROM "artifact_publication_intents" i
         WHERE i."created_at_utc" < ${unreferencedThreshold}
           AND NOT EXISTS (
             SELECT 1 FROM "reports" r
              WHERE r."storage_bucket" = i."storage_bucket" AND r."storage_key" = i."storage_key")
           AND NOT EXISTS (
             SELECT 1 FROM "verification_packages" p
              WHERE p."storage_bucket" = i."storage_bucket" AND p."storage_key" = i."storage_key")
      `,
    ]);
  const unreferencedPublishedArtifactCount = Number(unreferenced[0]?.count ?? 0);

  // Read-only first pass. We log a single structured "orphan_scan" line
  // suitable for alerting / dashboards. NO destructive action is taken.
  logger.info(
    {
      requestId,
      trigger,
      thresholds: {
        dormantDraftAgeMs: options.dormantDraftAgeMs ?? DEFAULT_DORMANT_DRAFT_MS,
        stuckEvidenceAgeMs: options.stuckEvidenceAgeMs ?? DEFAULT_STUCK_EVIDENCE_MS,
        presignedNeverConfirmedAgeMs:
          options.presignedNeverConfirmedAgeMs ??
          DEFAULT_UNCONFIRMED_PART_MS,
      },
      dormantDraftCount,
      stuckEvidenceCount,
      unconfirmedPartCount,
      unreferencedPublishedArtifactCount,
    },
    "orphan.scan.completed"
  );

  return {
    dormantDraftCount,
    stuckEvidenceCount,
    unconfirmedPartCount,
    unreferencedPublishedArtifactCount,
  };
}
