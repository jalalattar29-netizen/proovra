/**
 * 2026-10-29 — the combined screen recording, API side: applicability,
 * readiness and the stored object behind the current generation.
 *
 * The combined MP4 is a DERIVED review copy of a legacy SEGMENTED continuous
 * screen recording (see @proovra/shared screen-recording-combine.ts). This
 * service never exposes storage internals to a caller: the routes turn the
 * storage reference into a short-lived presigned URL only after the
 * byte-release gate allowed it.
 */

import {
  readScreenRecordingCombineLineage,
  SCREEN_RECORDING_COMBINE_ACQUISITION_MODES,
  SCREEN_RECORDING_COMBINE_RUN_KIND,
  SCREEN_RECORDING_COMBINED_ASSET_KIND,
  parseScreenRecordingCombineGeneration,
  type ScreenRecordingCombineLineage,
  type ScreenRecordingCombineState,
} from "@proovra/shared";

import { prisma } from "../../db.js";

export type CombinedRecordingAsset = {
  id: string;
  generation: number;
  derivedSha256: string | null;
  sizeBytes: number | null;
  widthPx: number | null;
  heightPx: number | null;
  generatedAtUtc: string | null;
  lineage: ScreenRecordingCombineLineage | null;
};

export type CombinedRecordingStatus = {
  applicable: boolean;
  state: ScreenRecordingCombineState;
  /** The newest run (any status), for "preparing" / failure detail. */
  run: { id: string; status: string; generation: number; lastError: string | null; updatedAtUtc: string } | null;
  asset: CombinedRecordingAsset | null;
  /** How many ORIGINAL segments the record holds (what the technical files list shows). */
  segmentCount: number;
};

/**
 * A record is a candidate when it is a continuous screen recording holding
 * two or more ORIGINAL video parts beside a capture manifest. A SINGLE_FILE
 * recording (one video part) is already one file.
 */
export async function combinedRecordingApplicability(
  evidenceId: string,
): Promise<{ applicable: boolean; segmentCount: number }> {
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: { acquisitionMode: true },
  });
  if (!(SCREEN_RECORDING_COMBINE_ACQUISITION_MODES as ReadonlyArray<string>).includes(evidence?.acquisitionMode ?? "")) {
    return { applicable: false, segmentCount: 0 };
  }
  const parts = await prisma.evidencePart.findMany({
    where: { evidenceId },
    select: { mimeType: true, artifactClass: true },
  });
  const segments = parts.filter((p) => (p.mimeType ?? "").toLowerCase().startsWith("video/")).length;
  const hasManifest = parts.some((p) => (p.artifactClass ?? "").toUpperCase() === "CAPTURE_MANIFEST");
  return { applicable: segments >= 2 && hasManifest, segmentCount: segments };
}

export async function getCombinedRecordingStatus(teamId: string, evidenceId: string): Promise<CombinedRecordingStatus> {
  const { applicable, segmentCount } = await combinedRecordingApplicability(evidenceId);
  const [runs, assets] = await Promise.all([
    prisma.mediaIntelligenceRun.findMany({
      where: { teamId, evidenceId, kind: SCREEN_RECORDING_COMBINE_RUN_KIND },
      orderBy: { createdAtUtc: "desc" },
      take: 20,
      select: { id: true, status: true, idempotencyKey: true, lastError: true, updatedAtUtc: true },
    }),
    prisma.evidencePartDerivedAsset.findMany({
      where: { teamId, evidenceId, assetKind: SCREEN_RECORDING_COMBINED_ASSET_KIND, status: "COMPLETED" },
      orderBy: { generatedAtUtc: "desc" },
      take: 1,
      select: {
        id: true,
        variantKey: true,
        derivedSha256: true,
        sizeBytes: true,
        widthPx: true,
        heightPx: true,
        generatedAtUtc: true,
        generationParameters: true,
      },
    }),
  ]);
  const latestRun =
    runs
      .map((r) => ({ r, generation: parseScreenRecordingCombineGeneration(r.idempotencyKey) ?? 1 }))
      .sort((a, b) => b.generation - a.generation)[0] ?? null;
  const a = assets[0] ?? null;
  const lineage = a ? readScreenRecordingCombineLineage(a.generationParameters) : null;
  const asset: CombinedRecordingAsset | null = a
    ? {
        id: a.id,
        generation: lineage?.generation ?? Number(/combined-v(\d+)/.exec(a.variantKey)?.[1] ?? 1),
        derivedSha256: a.derivedSha256,
        sizeBytes: a.sizeBytes,
        widthPx: a.widthPx,
        heightPx: a.heightPx,
        generatedAtUtc: a.generatedAtUtc?.toISOString() ?? null,
        lineage,
      }
    : null;

  let state: ScreenRecordingCombineState;
  if (asset) state = "COMPLETED";
  else if (!applicable) state = "NOT_APPLICABLE";
  else if (!latestRun) state = "NOT_STARTED";
  else if (latestRun.r.status === "PENDING") state = "PENDING";
  else if (latestRun.r.status === "PROCESSING") state = "PROCESSING";
  else if ((latestRun.r.lastError ?? "").startsWith("unsupported:")) state = "UNSUPPORTED";
  else if (latestRun.r.status === "COMPLETED") state = "FAILED"; // completed without an asset is not a recording
  else state = "FAILED";

  return {
    applicable,
    state,
    run: latestRun
      ? {
          id: latestRun.r.id,
          status: latestRun.r.status,
          generation: latestRun.generation,
          lastError: latestRun.r.lastError?.slice(0, 120) ?? null,
          updatedAtUtc: latestRun.r.updatedAtUtc.toISOString(),
        }
      : null,
    asset,
    segmentCount,
  };
}

/** The stored object of the CURRENT combined asset. Never projected to a caller. */
export async function combinedRecordingStorage(
  teamId: string,
  evidenceId: string,
  assetId: string,
): Promise<{ bucket: string; key: string; versionId: string | null } | null> {
  const row = await prisma.evidencePartDerivedAsset.findFirst({
    where: { id: assetId, teamId, evidenceId, assetKind: SCREEN_RECORDING_COMBINED_ASSET_KIND, status: "COMPLETED" },
    select: { storageBucket: true, storageKey: true, storageVersionId: true },
  });
  if (!row?.storageBucket || !row.storageKey) return null;
  return { bucket: row.storageBucket, key: row.storageKey, versionId: row.storageVersionId };
}
