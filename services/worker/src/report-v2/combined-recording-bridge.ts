/**
 * COMBINE (2026-10-29) — report bridge for the DERIVED combined review video
 * of a segmented screen recording.
 *
 * Reads the newest COMPLETED `screen_recording_combined` derived row for the
 * record and projects ONLY its lineage facts (digest, sources, completeness,
 * gaps, generation time). It is review material: never an original, never part
 * of the sealed fingerprint. A record without one (or a report generated
 * before it completed) gets null and the report says nothing about it.
 * Failure-safe: any read error is null, never a failed report.
 */
import {
  SCREEN_RECORDING_COMBINED_ASSET_KIND,
  readScreenRecordingCombineLineage,
} from "@proovra/shared";

import { prisma } from "../db.js";
import type { ReportCombinedRecording } from "./types.js";

export function projectReportCombinedRecording(row: {
  derivedSha256: string | null;
  generationParameters: unknown;
  generatedAtUtc: Date | string | null;
} | null): ReportCombinedRecording | null {
  if (!row) return null;
  const lineage = readScreenRecordingCombineLineage(row.generationParameters);
  if (!lineage) return null;
  const knownGapMs = lineage.gaps.reduce((acc, g) => acc + (typeof g.durationMs === "number" ? g.durationMs : 0), 0);
  const generatedAt =
    row.generatedAtUtc instanceof Date ? row.generatedAtUtc.toISOString() : row.generatedAtUtc ?? null;
  return {
    derivedSha256: row.derivedSha256 ?? null,
    sourceSegmentCount: lineage.sources.length,
    completeness: lineage.completeness,
    gapCount: lineage.gaps.length,
    gapTotalMs: knownGapMs,
    // A gap of unknown length (e.g. a lost tail) is counted, never sized.
    gapDurationUnknown: lineage.gaps.some((g) => typeof g.durationMs !== "number"),
    generatedAtUtc: generatedAt,
  };
}

export async function readReportCombinedRecording(evidenceId: string): Promise<ReportCombinedRecording | null> {
  try {
    const row = await prisma.evidencePartDerivedAsset.findFirst({
      where: { evidenceId, assetKind: SCREEN_RECORDING_COMBINED_ASSET_KIND, status: "COMPLETED" },
      orderBy: [{ generatedAtUtc: { sort: "desc", nulls: "last" } }, { createdAtUtc: "desc" }],
      select: { derivedSha256: true, generationParameters: true, generatedAtUtc: true },
    });
    return projectReportCombinedRecording(row);
  } catch {
    return null;
  }
}
