/**
 * PROOVRA Phase 3B Enterprise Closure — quality analytics.
 *
 * Provider / reviewer / team quality aggregators. Computes:
 *
 *   * Per-provider correction rate, acceptance, rejection, revert
 *     rate, confidence accuracy, ranking.
 *   * Per-reviewer acceptance, revert frequency, median latency,
 *     agreement, composite quality score.
 *   * Per-team correction density, accepted / rejected counts,
 *     review quality score.
 *
 * Hard rules:
 *   * Workspace-anchored.
 *   * Bounded vocabulary; NEVER per-record / per-OCR-text exposure.
 *   * Best-effort — Prisma errors degrade to zero rather than fail
 *     the whole projection.
 */
import { rangeWindowMs, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
// ---------------------------------------------------------------------------
// Provider quality
// ---------------------------------------------------------------------------
export async function projectProviderQuality(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const since = new Date(Date.now() - rangeWindowMs(input.range));
    // Usage totals (calls + failures + cost) per provider.
    const usageRows = await prisma.providerUsageEvent
        .groupBy({
        by: ["provider"],
        where: { teamId: input.teamId, occurredAtUtc: { gte: since } },
        _count: { _all: true },
        _sum: { estimatedCostUsdMicros: true },
    })
        .catch(() => []);
    const failureRows = await prisma.providerUsageEvent
        .groupBy({
        by: ["provider"],
        where: {
            teamId: input.teamId,
            occurredAtUtc: { gte: since },
            failureReason: { not: null },
        },
        _count: { _all: true },
    })
        .catch(() => []);
    // Records ingested + correction counts per provider.
    const recordRows = await prisma.mediaIntelligenceRecord
        .groupBy({
        by: ["provider"],
        where: { teamId: input.teamId, createdAt: { gte: since } },
        _count: { _all: true },
        _avg: { providerConfidence: true },
    })
        .catch(() => []);
    // Per-provider correction count + state breakdown.
    const correctionRowsRaw = await prisma.reviewerCorrection
        .findMany({
        where: {
            teamId: input.teamId,
            createdAt: { gte: since },
        },
        select: {
            state: true,
            revertedAt: true,
            record: { select: { provider: true, state: true } },
        },
    })
        .catch(() => []);
    const perProvider = new Map();
    const bucket = (p) => {
        let b = perProvider.get(p);
        if (!b) {
            b = {
                correctionCount: 0,
                acceptanceCount: 0,
                rejectionCount: 0,
                revertCount: 0,
                acceptedRecords: 0,
                rejectedRecords: 0,
            };
            perProvider.set(p, b);
        }
        return b;
    };
    for (const c of correctionRowsRaw) {
        const b = bucket(c.record.provider);
        b.correctionCount += 1;
        if (c.state === "ACCEPTED")
            b.acceptanceCount += 1;
        if (c.state === "REVERTED" || c.revertedAt)
            b.revertCount += 1;
    }
    // Per-provider accepted / rejected RECORD counts.
    const acceptedRecordRows = await prisma.mediaIntelligenceRecord
        .groupBy({
        by: ["provider", "state"],
        where: {
            teamId: input.teamId,
            createdAt: { gte: since },
            state: { in: ["ACCEPTED", "REJECTED", "CORRECTED"] },
        },
        _count: { _all: true },
    })
        .catch(() => []);
    for (const r of acceptedRecordRows) {
        const b = bucket(r.provider);
        if (r.state === "ACCEPTED")
            b.acceptedRecords += r._count._all;
        if (r.state === "REJECTED") {
            b.rejectedRecords += r._count._all;
            b.rejectionCount += r._count._all;
        }
    }
    // Assemble per-provider rows.
    const allProviders = new Set();
    for (const r of usageRows)
        allProviders.add(r.provider);
    for (const r of recordRows)
        allProviders.add(r.provider);
    for (const r of failureRows)
        allProviders.add(r.provider);
    for (const p of perProvider.keys())
        allProviders.add(p);
    const usageByProvider = new Map(usageRows.map((r) => [r.provider, r]));
    const failureByProvider = new Map(failureRows.map((r) => [r.provider, r]));
    const recordByProvider = new Map(recordRows.map((r) => [r.provider, r]));
    const rows = [];
    for (const p of allProviders) {
        const usage = usageByProvider.get(p);
        const fail = failureByProvider.get(p);
        const rec = recordByProvider.get(p);
        const b = bucket(p);
        const callCount = usage?._count._all ?? 0;
        const failureCount = fail?._count._all ?? 0;
        const recordCount = rec?._count._all ?? 0;
        const failureRatePct = callCount === 0 ? 0 : round1((failureCount / callCount) * 100);
        const correctionRatePct = recordCount === 0 ? 0 : round1((b.correctionCount / recordCount) * 100);
        const acceptanceRatePct = b.correctionCount === 0
            ? 0
            : round1((b.acceptanceCount / b.correctionCount) * 100);
        const rejectionRatePct = recordCount === 0 ? 0 : round1((b.rejectedRecords / recordCount) * 100);
        const revertRatePct = b.correctionCount === 0
            ? 0
            : round1((b.revertCount / b.correctionCount) * 100);
        const confidenceAccuracy = recordCount === 0
            ? 0
            : Math.max(0, Math.min(1, 1 - b.correctionCount / recordCount));
        const failureFactor = 1 - failureRatePct / 100;
        const rankingScore = round2(0.7 * confidenceAccuracy + 0.3 * failureFactor);
        rows.push({
            provider: p,
            callCount,
            failureCount,
            failureRatePct,
            recordCount,
            correctionCount: b.correctionCount,
            correctionRatePct,
            acceptanceCount: b.acceptanceCount,
            acceptanceRatePct,
            rejectionCount: b.rejectionCount,
            rejectionRatePct,
            revertCount: b.revertCount,
            revertRatePct,
            averageProviderConfidence: rec?._avg.providerConfidence ?? 0,
            confidenceAccuracy: round2(confidenceAccuracy),
            rankingScore,
            rank: 0,
            estimatedCostUsdMicros: Number(usage?._sum.estimatedCostUsdMicros ?? 0n),
        });
    }
    rows.sort((a, b) => b.rankingScore - a.rankingScore);
    rows.forEach((r, i) => {
        r.rank = i + 1;
    });
    return {
        generatedAtUtc: new Date().toISOString(),
        teamId: input.teamId,
        range: input.range,
        rows,
    };
}
// ---------------------------------------------------------------------------
// Reviewer quality
// ---------------------------------------------------------------------------
export async function projectReviewerQuality(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const since = new Date(Date.now() - rangeWindowMs(input.range));
    const corrections = await prisma.reviewerCorrection
        .findMany({
        where: { teamId: input.teamId, createdAt: { gte: since } },
        select: {
            id: true,
            authoredByUserId: true,
            state: true,
            createdAt: true,
            acceptedAt: true,
            revertedAt: true,
            supersededByCorrectionId: true,
        },
    })
        .catch(() => []);
    const perReviewer = new Map();
    for (const c of corrections) {
        let b = perReviewer.get(c.authoredByUserId);
        if (!b) {
            b = { authored: 0, accepted: 0, reverted: 0, superseded: 0, acceptLatenciesMs: [] };
            perReviewer.set(c.authoredByUserId, b);
        }
        b.authored += 1;
        if (c.state === "ACCEPTED")
            b.accepted += 1;
        if (c.state === "REVERTED" || c.revertedAt)
            b.reverted += 1;
        if (c.supersededByCorrectionId)
            b.superseded += 1;
        if (c.acceptedAt) {
            b.acceptLatenciesMs.push(c.acceptedAt.getTime() - c.createdAt.getTime());
        }
    }
    const rows = [];
    for (const [reviewerId, b] of perReviewer) {
        const acceptanceRatePct = b.authored === 0 ? 0 : round1((b.accepted / b.authored) * 100);
        const revertRatePct = b.authored === 0 ? 0 : round1((b.reverted / b.authored) * 100);
        const supersededRatePct = b.authored === 0 ? 0 : (b.superseded / b.authored) * 100;
        const agreementRatePct = round1(Math.max(0, 100 - supersededRatePct));
        const median = b.acceptLatenciesMs.length === 0 ? 0 : medianMs(b.acceptLatenciesMs);
        const qualityScore = round1(0.5 * acceptanceRatePct +
            0.3 * agreementRatePct +
            0.2 * (100 - revertRatePct));
        rows.push({
            reviewerUserId: reviewerId,
            correctionsAuthored: b.authored,
            correctionsAccepted: b.accepted,
            correctionsReverted: b.reverted,
            acceptanceRatePct,
            revertRatePct,
            medianAcceptLatencyMs: median,
            agreementRatePct,
            qualityScore: Math.max(0, Math.min(100, qualityScore)),
        });
    }
    rows.sort((a, b) => b.qualityScore - a.qualityScore);
    return {
        generatedAtUtc: new Date().toISOString(),
        teamId: input.teamId,
        range: input.range,
        rows,
    };
}
// ---------------------------------------------------------------------------
// Team quality
// ---------------------------------------------------------------------------
export async function projectTeamQuality(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const since = new Date(Date.now() - rangeWindowMs(input.range));
    // Team-level row.
    const records = await prisma.mediaIntelligenceRecord
        .findMany({
        where: { teamId: input.teamId, createdAt: { gte: since } },
        select: {
            state: true,
            providerConfidence: true,
            _count: { select: { corrections: true } },
        },
    })
        .catch(() => []);
    const recordCount = records.length;
    let correctionCount = 0;
    let accepted = 0;
    let rejected = 0;
    let confSum = 0;
    // R7-intelligence: providerConfidence is nullable on MediaIntelligenceRecord —
    // a null means the provider did NOT supply a confidence score (e.g. legacy rows
    // or providers without a confidence channel). Treating null as 0 would skew the
    // average DOWN and falsely inflate the "low-confidence" signal. Instead, track
    // the count of confidence-bearing rows separately and average only over those.
    // This preserves analytics accuracy + provider failure transparency (a provider
    // that never returns confidence is visible as a smaller denominator, not as a
    // distorted score).
    let confCount = 0;
    for (const r of records) {
        correctionCount += r._count.corrections;
        if (r.state === "ACCEPTED" || r.state === "CORRECTED")
            accepted += 1;
        if (r.state === "REJECTED")
            rejected += 1;
        if (r.providerConfidence !== null) {
            confSum += r.providerConfidence;
            confCount += 1;
        }
    }
    const correctionDensity = recordCount === 0 ? 0 : round1((correctionCount / recordCount) * 100);
    const averageProviderConfidence = confCount === 0 ? 0 : round2(confSum / confCount);
    const reviewQualityScore = round1(Math.max(0, 100 - correctionDensity * 2 - (rejected * 100) / Math.max(recordCount, 1)));
    const teamRow = {
        scope: "TEAM",
        scopeTargetId: input.teamId,
        recordCount,
        correctionCount,
        correctionDensity,
        acceptedCount: accepted,
        rejectedCount: rejected,
        averageProviderConfidence,
        reviewQualityScore: Math.max(0, Math.min(100, reviewQualityScore)),
    };
    // Per-case rows.
    const caseAggregates = await prisma.providerUsageEvent
        .groupBy({
        by: ["caseId"],
        where: {
            teamId: input.teamId,
            occurredAtUtc: { gte: since },
            caseId: { not: null },
        },
        _count: { _all: true },
    })
        .catch(() => []);
    const caseRows = [];
    for (const c of caseAggregates) {
        if (!c.caseId)
            continue;
        const caseRecords = await prisma.mediaIntelligenceRecord
            .findMany({
            where: {
                teamId: input.teamId,
                createdAt: { gte: since },
                evidenceId: { in: await evidenceIdsForCase(prisma, input.teamId, c.caseId, since) },
            },
            select: {
                state: true,
                providerConfidence: true,
                _count: { select: { corrections: true } },
            },
        })
            .catch(() => []);
        let caseCorrections = 0;
        let caseAccepted = 0;
        let caseRejected = 0;
        let caseConf = 0;
        // R7-intelligence: per-case providerConfidence average — same skip-null pattern
        // as the team-level loop above; preserves analytics accuracy when a provider
        // doesn't supply confidence (vs. silently treating null as 0).
        let caseConfCount = 0;
        for (const r of caseRecords) {
            caseCorrections += r._count.corrections;
            if (r.state === "ACCEPTED" || r.state === "CORRECTED")
                caseAccepted += 1;
            if (r.state === "REJECTED")
                caseRejected += 1;
            if (r.providerConfidence !== null) {
                caseConf += r.providerConfidence;
                caseConfCount += 1;
            }
        }
        const rc = caseRecords.length;
        caseRows.push({
            scope: "CASE",
            scopeTargetId: c.caseId,
            recordCount: rc,
            correctionCount: caseCorrections,
            correctionDensity: rc === 0 ? 0 : round1((caseCorrections / rc) * 100),
            acceptedCount: caseAccepted,
            rejectedCount: caseRejected,
            averageProviderConfidence: caseConfCount === 0 ? 0 : round2(caseConf / caseConfCount),
            reviewQualityScore: rc === 0 ? 0 : round1(Math.max(0, 100 - (caseCorrections / rc) * 100)),
        });
    }
    return {
        generatedAtUtc: new Date().toISOString(),
        teamId: input.teamId,
        range: input.range,
        rows: [teamRow, ...caseRows],
    };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function evidenceIdsForCase(prisma, teamId, caseId, sinceUtc) {
    const rows = await prisma.providerUsageEvent
        .findMany({
        where: {
            teamId,
            caseId,
            occurredAtUtc: { gte: sinceUtc },
            evidenceId: { not: null },
        },
        select: { evidenceId: true },
        distinct: ["evidenceId"],
    })
        .catch(() => []);
    return rows.map((r) => r.evidenceId).filter((x) => x !== null);
}
function round1(n) {
    return Math.round(n * 10) / 10;
}
function round2(n) {
    return Math.round(n * 100) / 100;
}
function medianMs(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
        : sorted[mid];
}
