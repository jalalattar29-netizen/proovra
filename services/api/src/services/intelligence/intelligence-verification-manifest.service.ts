/**
 * PROOVRA Phase 3B — Verification-package manifest writers.
 *
 * Bounded readers that emit the per-evidence manifest entries the
 * verification package ZIP carries:
 *
 *   * document-intelligence-manifest.json
 *   * transcript-intelligence-manifest.json
 *   * confidence-manifest.json
 *   * correction-history.json
 *   * provider-manifest.json
 *
 * Hard rules:
 *   * NEVER raw payloads — bounded counts + ids + bands only.
 *   * Workspace-anchored.
 *   * Offline-verifiable: every entry carries enough bounded info
 *     for an external auditor to re-state platform decisions.
 */

import type { PrismaClient } from "@prisma/client";
import {
  rangeWindowMs,
  type AuditEventsManifestEntry,
  type BudgetGovernanceManifestEntry,
  type ConfidenceManifestEntry,
  type CorrectionHistoryManifestEntry,
  type CorrectionVersionChainManifestEntry,
  type DocumentIntelligenceManifestEntry,
  type ExecutiveMetricsRange,
  type IntelligenceConfidenceBand,
  type IntelligenceLifecycleCategory,
  type IntelligenceLifecycleCode,
  type MediaIntelligenceProvider,
  type MediaIntelligenceRecordKind,
  type ProviderAdapterOperation,
  type ProviderCostUnit,
  type ProviderManifestEntry,
  type ProviderQualityManifestEntry,
  type ReviewerCorrectionKind,
  type ReviewerCorrectionState,
  type TranscriptIntelligenceManifestEntry,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { getCorrectionVersionChainsForEvidence } from "./reviewer-correction.service.js";
import { projectProviderQuality } from "./intelligence-quality.service.js";

const DOCUMENT_KINDS: ReadonlyArray<MediaIntelligenceRecordKind> = [
  "DOCUMENT_OCR_TEXT",
  "DOCUMENT_LAYOUT",
  "DOCUMENT_TABLE",
  "DOCUMENT_FORM_FIELD",
];

const TRANSCRIPT_KINDS: ReadonlyArray<MediaIntelligenceRecordKind> = [
  "TRANSCRIPT_SEGMENT",
  "TRANSCRIPT_WORD",
  "SPEAKER_SEGMENT",
];

export async function buildDocumentIntelligenceManifestEntry(input: {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
}): Promise<DocumentIntelligenceManifestEntry> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.mediaIntelligenceRecord.findMany({
    where: {
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      kind: { in: [...DOCUMENT_KINDS, "ENTITY"] },
    },
    select: {
      kind: true,
      provider: true,
      providerConfidenceBand: true,
      _count: { select: { corrections: true } },
    },
  });
  const perKind: Partial<Record<MediaIntelligenceRecordKind, number>> = {};
  const perProvider: Partial<Record<MediaIntelligenceProvider, number>> = {};
  const perConfidence: Partial<Record<IntelligenceConfidenceBand, number>> = {};
  let totalCorrections = 0;
  for (const r of rows) {
    perKind[r.kind as MediaIntelligenceRecordKind] =
      (perKind[r.kind as MediaIntelligenceRecordKind] ?? 0) + 1;
    perProvider[r.provider as MediaIntelligenceProvider] =
      (perProvider[r.provider as MediaIntelligenceProvider] ?? 0) + 1;
    perConfidence[r.providerConfidenceBand as IntelligenceConfidenceBand] =
      (perConfidence[r.providerConfidenceBand as IntelligenceConfidenceBand] ?? 0) + 1;
    totalCorrections += r._count.corrections;
  }
  return {
    evidenceId: input.evidenceId,
    totalRecords: rows.length,
    perKind,
    perProvider,
    perConfidence,
    correctionCount: totalCorrections,
  };
}

export async function buildTranscriptIntelligenceManifestEntry(input: {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
}): Promise<TranscriptIntelligenceManifestEntry> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.mediaIntelligenceRecord.findMany({
    where: {
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      kind: { in: [...TRANSCRIPT_KINDS] },
    },
    select: {
      kind: true,
      provider: true,
      anchor: true,
      _count: { select: { corrections: true } },
    },
  });
  const perProvider: Partial<Record<MediaIntelligenceProvider, number>> = {};
  const speakers = new Set<number | null>();
  let totalDurationMs = 0;
  let segments = 0;
  let totalCorrections = 0;
  for (const r of rows) {
    perProvider[r.provider as MediaIntelligenceProvider] =
      (perProvider[r.provider as MediaIntelligenceProvider] ?? 0) + 1;
    totalCorrections += r._count.corrections;
    if (r.kind === "TRANSCRIPT_SEGMENT") {
      segments += 1;
      const anchor = r.anchor as
        | { startMs?: number; endMs?: number; speaker?: number | null }
        | null;
      if (anchor) {
        if (typeof anchor.endMs === "number") {
          totalDurationMs = Math.max(totalDurationMs, anchor.endMs);
        }
        if (anchor.speaker !== undefined) speakers.add(anchor.speaker ?? null);
      }
    }
  }
  return {
    evidenceId: input.evidenceId,
    totalSegments: segments,
    totalSpeakers: speakers.size,
    totalDurationMs,
    perProvider,
    correctionCount: totalCorrections,
  };
}

export async function buildProviderManifestEntries(input: {
  prisma?: PrismaClient;
  teamId: string;
  sinceUtc?: Date;
}): Promise<ReadonlyArray<ProviderManifestEntry>> {
  const prisma = input.prisma ?? defaultPrisma;
  const since = input.sinceUtc ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await prisma.providerUsageEvent.groupBy({
    by: ["provider", "operation", "unit"],
    where: { teamId: input.teamId, occurredAtUtc: { gte: since } },
    _count: { _all: true },
    _sum: { units: true, estimatedCostUsdMicros: true },
  });
  const byProvider = new Map<MediaIntelligenceProvider, ProviderManifestEntry>();
  for (const r of rows) {
    const provider = r.provider as MediaIntelligenceProvider;
    const existing = byProvider.get(provider) ?? {
      provider,
      callCount: 0,
      unitsByOperation: {},
      estimatedCostUsdMicros: 0,
    };
    existing.callCount += r._count._all;
    existing.estimatedCostUsdMicros += Number(r._sum.estimatedCostUsdMicros ?? 0n);
    (existing.unitsByOperation as Record<ProviderAdapterOperation, { unit: ProviderCostUnit; units: number }>)[
      r.operation as ProviderAdapterOperation
    ] = { unit: r.unit as ProviderCostUnit, units: r._sum.units ?? 0 };
    byProvider.set(provider, existing);
  }
  return Array.from(byProvider.values());
}

export async function buildConfidenceManifestEntry(input: {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
}): Promise<ConfidenceManifestEntry> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.mediaIntelligenceRecord.findMany({
    where: { teamId: input.teamId, evidenceId: input.evidenceId },
    select: {
      finalConfidenceBand: true,
      state: true,
    },
  });
  const perBand: Partial<Record<IntelligenceConfidenceBand, number>> = {};
  let reviewed = 0;
  let accepted = 0;
  let rejected = 0;
  let corrected = 0;
  for (const r of rows) {
    perBand[r.finalConfidenceBand as IntelligenceConfidenceBand] =
      (perBand[r.finalConfidenceBand as IntelligenceConfidenceBand] ?? 0) + 1;
    if (r.state !== "INGESTED") reviewed += 1;
    if (r.state === "ACCEPTED") accepted += 1;
    if (r.state === "REJECTED") rejected += 1;
    if (r.state === "CORRECTED") corrected += 1;
  }
  return {
    evidenceId: input.evidenceId,
    perBand,
    reviewedCount: reviewed,
    acceptedCount: accepted,
    rejectedCount: rejected,
    correctedCount: corrected,
  };
}

export async function buildCorrectionHistoryManifestEntry(input: {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
}): Promise<CorrectionHistoryManifestEntry> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.reviewerCorrection.findMany({
    where: {
      teamId: input.teamId,
      record: { evidenceId: input.evidenceId },
    },
    select: { kind: true, authoredByUserId: true },
  });
  const perKind: Partial<Record<ReviewerCorrectionKind, number>> = {};
  const perAuthor: Record<string, number> = {};
  for (const r of rows) {
    perKind[r.kind as ReviewerCorrectionKind] =
      (perKind[r.kind as ReviewerCorrectionKind] ?? 0) + 1;
    perAuthor[r.authoredByUserId] = (perAuthor[r.authoredByUserId] ?? 0) + 1;
  }
  return {
    evidenceId: input.evidenceId,
    totalCorrections: rows.length,
    perKind,
    perAuthor,
  };
}

// ===========================================================================
// Phase 3B Enterprise Closure — correction version chain manifest entry.
// ===========================================================================

export async function buildCorrectionVersionChainManifestEntry(input: {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
}): Promise<CorrectionVersionChainManifestEntry> {
  const prisma = input.prisma ?? defaultPrisma;
  const chains = await getCorrectionVersionChainsForEvidence({
    prisma,
    teamId: input.teamId,
    evidenceId: input.evidenceId,
  });
  let totalVersions = 0;
  const out: CorrectionVersionChainManifestEntry["chains"] = chains.map((c) => {
    totalVersions += c.versions.length;
    return {
      recordId: c.recordId,
      versions: c.versions.map((v) => ({
        id: v.id,
        versionNumber: v.versionNumber,
        kind: v.kind as ReviewerCorrectionKind,
        state: v.state as ReviewerCorrectionState,
        authoredByUserId: v.authoredByUserId,
        acceptedByUserId: v.acceptedByUserId,
        createdAtUtc: v.createdAtUtc,
        acceptedAtUtc: v.acceptedAtUtc,
        revertedAtUtc: v.revertedAtUtc,
        supersededAtUtc: v.supersededAtUtc,
        parentCorrectionId: v.parentCorrectionId,
        supersedesCorrectionId: v.supersedesCorrectionId,
      })),
    };
  });
  return {
    evidenceId: input.evidenceId,
    chains: out,
    totalVersions,
  };
}

// ===========================================================================
// Phase 3B Enterprise Closure — provider quality manifest entry.
// ===========================================================================

export async function buildProviderQualityManifestEntry(input: {
  prisma?: PrismaClient;
  teamId: string;
  range?: ExecutiveMetricsRange;
}): Promise<ProviderQualityManifestEntry> {
  const projection = await projectProviderQuality({
    prisma: input.prisma,
    teamId: input.teamId,
    range: input.range ?? "30d",
  });
  return {
    generatedAtUtc: projection.generatedAtUtc,
    rangeWindowMs: rangeWindowMs(projection.range),
    rows: projection.rows.map((r) => ({
      provider: r.provider,
      callCount: r.callCount,
      failureRatePct: r.failureRatePct,
      correctionRatePct: r.correctionRatePct,
      confidenceAccuracy: r.confidenceAccuracy,
      rankingScore: r.rankingScore,
      rank: r.rank,
    })),
  };
}

// ===========================================================================
// Phase 3B Enterprise Closure — budget governance manifest entry.
// ===========================================================================

export async function buildBudgetGovernanceManifestEntry(input: {
  prisma?: PrismaClient;
  teamId: string;
  range?: ExecutiveMetricsRange;
}): Promise<BudgetGovernanceManifestEntry> {
  const prisma = input.prisma ?? defaultPrisma;
  const range: ExecutiveMetricsRange = input.range ?? "30d";
  const since = new Date(Date.now() - rangeWindowMs(range));
  const [alerts, blockedCalls] = await Promise.all([
    prisma.providerBudgetAlert
      .findMany({
        where: { teamId: input.teamId, occurredAtUtc: { gte: since } },
        select: { threshold: true },
      })
      .catch(() => [] as Array<{ threshold: string }>),
    prisma.providerUsageEvent
      .count({
        where: {
          teamId: input.teamId,
          occurredAtUtc: { gte: since },
          decision: "BLOCK",
        },
      })
      .catch(() => 0),
  ]);
  const softBreaches = alerts.filter((a: (typeof alerts)[number]) => a.threshold === "SOFT").length;
  const hardBreaches = alerts.filter((a: (typeof alerts)[number]) => a.threshold === "HARD").length;
  return {
    generatedAtUtc: new Date().toISOString(),
    rangeWindowMs: rangeWindowMs(range),
    totalBreaches: alerts.length,
    softBreaches,
    hardBreaches,
    blockedCalls,
  };
}

// ===========================================================================
// Phase 3B Enterprise Closure — audit events manifest entry.
// ===========================================================================

export async function buildAuditEventsManifestEntry(input: {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
}): Promise<AuditEventsManifestEntry> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.intelligenceActivityEvent
    .findMany({
      where: { teamId: input.teamId, evidenceId: input.evidenceId },
      select: { category: true, code: true },
    })
    .catch(() => [] as Array<{ category: string; code: string }>);
  const perCategory: Partial<Record<IntelligenceLifecycleCategory, number>> = {};
  const perCode: Partial<Record<IntelligenceLifecycleCode, number>> = {};
  for (const r of rows) {
    const cat = r.category as IntelligenceLifecycleCategory;
    const code = r.code as IntelligenceLifecycleCode;
    perCategory[cat] = (perCategory[cat] ?? 0) + 1;
    perCode[code] = (perCode[code] ?? 0) + 1;
  }
  return {
    evidenceId: input.evidenceId,
    totalEvents: rows.length,
    perCategory,
    perCode,
  };
}
