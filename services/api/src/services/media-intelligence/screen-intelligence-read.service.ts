/**
 * UC-4 — API read side for DERIVED screen intelligence.
 *
 * Resolves the ONE persisted `screen_reconstruction` descriptor for an evidence
 * (team-anchored), fetches its object bytes server-side, and projects a bounded,
 * review-safe shape for the Inspector. Storage keys never leave this module; the
 * per-block source links carry only evidence-part ids + keyframe derived-asset
 * ids, which the Inspector turns into the existing auth-gated bytes proxy URLs.
 *
 * Read-only. Never mutates evidence, never exposes storage internals.
 */

import {
  projectScreenIntelligenceForReview,
  UC4_RESOURCE_BOUNDS,
  type ScreenIntelligenceDescriptor,
  type ScreenIntelligenceReviewProjection,
} from "@proovra/shared";

import { prisma } from "../../db.js";

export type ScreenIntelligenceStatus = {
  requested: boolean;
  status: "NOT_REQUESTED" | "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "DISMISSED";
  lastError: string | null;
  updatedAtUtc: string | null;
  hasDescriptor: boolean;
};

/** Read the current UC-4 run status for an evidence (team-anchored). */
export async function getScreenIntelligenceStatus(
  teamId: string,
  evidenceId: string,
): Promise<ScreenIntelligenceStatus> {
  const { listRecentRunsForEvidence } = await import(
    "@proovra/shared-runtime/media-intelligence"
  );
  const runs = await listRecentRunsForEvidence(teamId, evidenceId, prisma);
  const run = runs.find((r) => r.kind === "reconstruct_screen");
  const hasDescriptor = await hasReconstructionAsset(teamId, evidenceId);
  if (!run) {
    return {
      requested: hasDescriptor,
      status: hasDescriptor ? "COMPLETED" : "NOT_REQUESTED",
      lastError: null,
      updatedAtUtc: null,
      hasDescriptor,
    };
  }
  return {
    requested: true,
    status: run.status,
    lastError: run.lastError,
    updatedAtUtc: run.updatedAtUtc,
    hasDescriptor,
  };
}

async function hasReconstructionAsset(
  teamId: string,
  evidenceId: string,
): Promise<boolean> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT 1
       FROM "evidence_part_derived_assets"
      WHERE "team_id" = $1 AND "evidence_id" = $2
        AND "asset_kind" = 'screen_reconstruction'
        AND "status" = 'COMPLETED'
      LIMIT 1`,
    teamId,
    evidenceId,
  )) as Array<unknown>;
  return rows.length > 0;
}

/**
 * Read + parse the persisted descriptor for an evidence, or null when none
 * exists. Bounded by `maxDescriptorBytes`.
 */
export async function readScreenIntelligenceDescriptor(
  teamId: string,
  evidenceId: string,
): Promise<{ assetId: string; descriptor: ScreenIntelligenceDescriptor } | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "id"
       FROM "evidence_part_derived_assets"
      WHERE "team_id" = $1 AND "evidence_id" = $2
        AND "asset_kind" = 'screen_reconstruction'
        AND "variant_key" = 'recon-v1'
        AND "status" = 'COMPLETED'
      ORDER BY "updated_at_utc" DESC
      LIMIT 1`,
    teamId,
    evidenceId,
  )) as Array<{ id: string }>;
  const assetId = rows[0]?.id;
  if (!assetId) return null;

  const { _getDerivedAssetStorageReference } = await import(
    "./derived-assets.service.js"
  );
  const ref = await _getDerivedAssetStorageReference(teamId, assetId);
  if (!ref) return null;

  let bytes: Buffer;
  try {
    const { getObjectStream } = await import("../../storage.js");
    const stream = await getObjectStream({ bucket: ref.bucket, key: ref.key });
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
      total += buf.byteLength;
      if (total > UC4_RESOURCE_BOUNDS.maxDescriptorBytes) return null;
      chunks.push(buf);
    }
    bytes = Buffer.concat(chunks);
  } catch {
    return null;
  }

  try {
    const descriptor = JSON.parse(bytes.toString("utf8")) as ScreenIntelligenceDescriptor;
    if (descriptor.schemaVersion !== "PROOVRA_SCREEN_INTELLIGENCE_V1") return null;
    return { assetId, descriptor };
  } catch {
    return null;
  }
}

export type ScreenIntelligenceReview = {
  status: ScreenIntelligenceStatus;
  projection: ScreenIntelligenceReviewProjection | null;
  /** Per-keyframe auth-gated bytes proxy URLs, keyed by keyframeId. */
  keyframeBytesUrls: Record<string, string | null>;
};

/**
 * Build the full Inspector payload: run status + bounded review projection +
 * per-keyframe bytes-proxy URLs (auth-gated, no storage key). Read-only.
 */
export async function getScreenIntelligenceReview(
  teamId: string,
  evidenceId: string,
  page: { offset?: number; limit?: number } = {},
): Promise<ScreenIntelligenceReview> {
  const status = await getScreenIntelligenceStatus(teamId, evidenceId);
  const read = await readScreenIntelligenceDescriptor(teamId, evidenceId);
  if (!read) {
    return { status, projection: null, keyframeBytesUrls: {} };
  }
  const projection = projectScreenIntelligenceForReview(read.descriptor, page);

  // Map keyframeId → bytes proxy URL for keyframes backed by a derived asset.
  // UC-2 frames have derivedAssetId=null (the ORIGINAL frame is the image); the
  // Inspector links those to Open Original instead.
  const keyframeBytesUrls: Record<string, string | null> = {};
  for (const kf of read.descriptor.keyframes) {
    keyframeBytesUrls[kf.keyframeId] = kf.derivedAssetId
      ? `/v1/evidence/${encodeURIComponent(evidenceId)}/derived-assets/${encodeURIComponent(kf.derivedAssetId)}/bytes?teamId=${encodeURIComponent(teamId)}`
      : null;
  }

  return { status, projection, keyframeBytesUrls };
}
