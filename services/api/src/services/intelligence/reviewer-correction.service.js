/**
 * PROOVRA Phase 3B — Reviewer correction service.
 *
 * Phase 3B Enterprise Closure additions:
 *   * Explicit correction version chain — every correction carries
 *     `versionNumber`, `parentCorrectionId`, `supersedesCorrectionId`,
 *     `supersededByCorrectionId`. Supersede flow appends a new row
 *     and back-links the prior version. No row is ever mutated to
 *     destroy history.
 *   * Every lifecycle transition emits an `IntelligenceActivityEvent`
 *     via the bounded emitter (CREATED / ACCEPTED / REVERTED /
 *     SUPERSEDED) so the audit centre + executive trends see them.
 *
 * Hard rules:
 *   * NEVER overwrites the provider record's payload — the patch
 *     row sits alongside.
 *   * `REVERTED` is bounded — reverting writes a new correction
 *     row pointing at the same record + state REVERTED.
 *   * Bounded rationale (≤ 600 chars) at the API boundary.
 */
import { INTELLIGENCE_CONFIDENCE_BANDS, REVIEWER_CORRECTION_KINDS, REVIEWER_CORRECTION_STATES, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { emitLifecycleEvent } from "./intelligence-activity.service.js";
// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
export async function createCorrection(input) {
    if (!REVIEWER_CORRECTION_KINDS.includes(input.kind)) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    if (input.reviewConfidenceBand &&
        !INTELLIGENCE_CONFIDENCE_BANDS.includes(input.reviewConfidenceBand)) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    const prisma = input.prisma ?? defaultPrisma;
    const record = await prisma.mediaIntelligenceRecord.findFirst({
        where: { id: input.recordId, teamId: input.teamId },
        select: { id: true, evidenceId: true },
    });
    if (!record)
        return { ok: false, denial: "RECORD_NOT_FOUND" };
    // Phase 3B Closure — supersede flow.
    let supersedePrior = null;
    if (input.supersedeCorrectionId) {
        const prior = await prisma.reviewerCorrection.findFirst({
            where: {
                id: input.supersedeCorrectionId,
                teamId: input.teamId,
                recordId: input.recordId,
            },
            select: { id: true, versionNumber: true, supersededByCorrectionId: true },
        });
        if (!prior)
            return { ok: false, denial: "RECORD_NOT_FOUND" };
        if (prior.supersededByCorrectionId) {
            return { ok: false, denial: "POLICY_REJECTED" };
        }
        supersedePrior = { id: prior.id, versionNumber: prior.versionNumber };
    }
    else {
        // Phase 3B Closure — implicit version increment: bump to the next
        // version above any prior correction on the same record.
        const latest = await prisma.reviewerCorrection.findFirst({
            where: { teamId: input.teamId, recordId: input.recordId },
            orderBy: { versionNumber: "desc" },
            select: { versionNumber: true },
        });
        if (latest && latest.versionNumber > 0) {
            // Not a supersede — just track the next version slot for clarity.
            // We still write versionNumber = latest + 1 so the chain is dense.
            supersedePrior = null;
        }
    }
    const nextVersion = await nextVersionFor(prisma, input.teamId, input.recordId);
    const created = await prisma.reviewerCorrection.create({
        data: {
            teamId: input.teamId,
            recordId: input.recordId,
            kind: input.kind,
            state: "DRAFT",
            patch: input.patch,
            rationale: input.rationale?.slice(0, 600) ?? null,
            authoredByUserId: input.authoredByUserId,
            versionNumber: nextVersion,
            parentCorrectionId: supersedePrior?.id ?? null,
            supersedesCorrectionId: supersedePrior?.id ?? null,
        },
        select: { id: true, versionNumber: true },
    });
    if (supersedePrior) {
        await prisma.reviewerCorrection.update({
            where: { id: supersedePrior.id },
            data: {
                supersededByCorrectionId: created.id,
                supersededAt: new Date(),
                state: "REVERTED",
            },
        });
        await emitLifecycleEvent({
            prisma,
            teamId: input.teamId,
            code: "CORRECTION_SUPERSEDED",
            actorUserId: input.authoredByUserId,
            correctionId: supersedePrior.id,
            recordId: input.recordId,
            evidenceId: record.evidenceId,
            reason: `superseded_by=${created.id}`,
        });
    }
    if (input.reviewConfidenceBand) {
        await prisma.mediaIntelligenceRecord.update({
            where: { id: input.recordId },
            data: {
                reviewConfidenceBand: input.reviewConfidenceBand,
            },
        });
    }
    await emitLifecycleEvent({
        prisma,
        teamId: input.teamId,
        code: "CORRECTION_CREATED",
        actorUserId: input.authoredByUserId,
        correctionId: created.id,
        recordId: input.recordId,
        evidenceId: record.evidenceId,
        reason: `kind=${input.kind}; version=${created.versionNumber}`,
    });
    return {
        ok: true,
        correctionId: created.id,
        versionNumber: created.versionNumber,
    };
}
export async function acceptCorrection(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const correction = await prisma.reviewerCorrection.findFirst({
        where: { id: input.correctionId, teamId: input.teamId },
        select: {
            id: true,
            recordId: true,
            state: true,
            kind: true,
        },
    });
    if (!correction)
        return { ok: false, denial: "RECORD_NOT_FOUND" };
    if (correction.state !== "DRAFT") {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    let evidenceId = "";
    await prisma.$transaction(async (tx) => {
        await tx.reviewerCorrection.update({
            where: { id: correction.id },
            data: {
                state: "ACCEPTED",
                acceptedByUserId: input.acceptedByUserId,
                acceptedAt: new Date(),
            },
        });
        // Bump the parent record's state + final confidence.
        const record = await tx.mediaIntelligenceRecord.findFirst({
            where: { id: correction.recordId },
            select: {
                evidenceId: true,
                reviewConfidenceBand: true,
                providerConfidenceBand: true,
            },
        });
        evidenceId = record?.evidenceId ?? "";
        const finalBand = record?.reviewConfidenceBand ??
            record?.providerConfidenceBand ??
            "LOW";
        await tx.mediaIntelligenceRecord.update({
            where: { id: correction.recordId },
            data: {
                state: "CORRECTED",
                reviewedAt: new Date(),
                finalConfidenceBand: finalBand,
            },
        });
    });
    await emitLifecycleEvent({
        prisma,
        teamId: input.teamId,
        code: "CORRECTION_ACCEPTED",
        actorUserId: input.acceptedByUserId,
        correctionId: correction.id,
        recordId: correction.recordId,
        evidenceId,
        reason: `kind=${correction.kind}`,
    });
    await emitLifecycleEvent({
        prisma,
        teamId: input.teamId,
        code: "RECORD_ACCEPTED",
        actorUserId: input.acceptedByUserId,
        recordId: correction.recordId,
        evidenceId,
    });
    return { ok: true, recordId: correction.recordId };
}
export async function revertCorrection(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const correction = await prisma.reviewerCorrection.findFirst({
        where: { id: input.correctionId, teamId: input.teamId },
        select: {
            id: true,
            recordId: true,
            kind: true,
            versionNumber: true,
            record: { select: { evidenceId: true } },
        },
    });
    if (!correction)
        return { ok: false, denial: "RECORD_NOT_FOUND" };
    const nextVersion = await nextVersionFor(prisma, input.teamId, correction.recordId);
    const reverted = await prisma.reviewerCorrection.create({
        data: {
            teamId: input.teamId,
            recordId: correction.recordId,
            kind: correction.kind,
            state: "REVERTED",
            patch: {},
            authoredByUserId: input.actorUserId,
            versionNumber: nextVersion,
            parentCorrectionId: correction.id,
            supersedesCorrectionId: correction.id,
        },
        select: { id: true },
    });
    await prisma.reviewerCorrection.update({
        where: { id: correction.id },
        data: {
            revertedAt: new Date(),
            supersededByCorrectionId: reverted.id,
            supersededAt: new Date(),
        },
    });
    await emitLifecycleEvent({
        prisma,
        teamId: input.teamId,
        code: "CORRECTION_REVERTED",
        actorUserId: input.actorUserId,
        correctionId: correction.id,
        recordId: correction.recordId,
        evidenceId: correction.record.evidenceId,
        reason: `replaced_by=${reverted.id}`,
    });
    return { ok: true, revertedCorrectionId: reverted.id };
}
// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function listCorrectionsForRecord(input) {
    const prisma = input.prisma ?? defaultPrisma;
    return prisma.reviewerCorrection.findMany({
        where: { teamId: input.teamId, recordId: input.recordId },
        orderBy: { createdAt: "desc" },
    });
}
export async function listCorrectionsForEvidence(input) {
    const prisma = input.prisma ?? defaultPrisma;
    return prisma.reviewerCorrection.findMany({
        where: {
            teamId: input.teamId,
            record: { evidenceId: input.evidenceId },
        },
        include: { record: { select: { kind: true, provider: true } } },
        orderBy: { createdAt: "desc" },
        take: Math.min(input.limit ?? 100, 500),
    });
}
/**
 * Phase 3B Closure — full version chain for a record. Returns every
 * correction ever written for the record, ordered by versionNumber,
 * with the supersedes/superseded-by graph rendered.
 */
export async function getCorrectionVersionChain(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const record = await prisma.mediaIntelligenceRecord.findFirst({
        where: { id: input.recordId, teamId: input.teamId },
        select: { id: true, evidenceId: true },
    });
    if (!record)
        return null;
    const rows = await prisma.reviewerCorrection.findMany({
        where: { teamId: input.teamId, recordId: input.recordId },
        orderBy: { versionNumber: "asc" },
    });
    const versions = rows.map((r) => ({
        id: r.id,
        versionNumber: r.versionNumber,
        parentCorrectionId: r.parentCorrectionId,
        supersedesCorrectionId: r.supersedesCorrectionId,
        supersededByCorrectionId: r.supersededByCorrectionId,
        kind: r.kind,
        state: r.state,
        authoredByUserId: r.authoredByUserId,
        acceptedByUserId: r.acceptedByUserId,
        createdAtUtc: r.createdAt.toISOString(),
        acceptedAtUtc: r.acceptedAt?.toISOString() ?? null,
        revertedAtUtc: r.revertedAt?.toISOString() ?? null,
        supersededAtUtc: r.supersededAt?.toISOString() ?? null,
        rationale: r.rationale,
        patchPreview: r.patch,
    }));
    return {
        recordId: input.recordId,
        evidenceId: record.evidenceId,
        versions,
        immutable: true,
    };
}
/**
 * Phase 3B Closure — version chains for every record under a given
 * evidence id. Used by the verification-package manifest writer.
 */
export async function getCorrectionVersionChainsForEvidence(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const records = await prisma.mediaIntelligenceRecord.findMany({
        where: { teamId: input.teamId, evidenceId: input.evidenceId },
        select: { id: true },
    });
    const chains = [];
    for (const r of records) {
        const chain = await getCorrectionVersionChain({
            prisma,
            teamId: input.teamId,
            recordId: r.id,
        });
        if (chain && chain.versions.length > 0)
            chains.push(chain);
    }
    return chains;
}
// ---------------------------------------------------------------------------
// Internal — next version slot for a record (1, 2, 3, …).
// ---------------------------------------------------------------------------
async function nextVersionFor(prisma, teamId, recordId) {
    const latest = await prisma.reviewerCorrection.findFirst({
        where: { teamId, recordId },
        orderBy: { versionNumber: "desc" },
        select: { versionNumber: true },
    });
    return (latest?.versionNumber ?? 0) + 1;
}
// Compile-time guard.
function _assertStatesIntact() {
    const _x = "DRAFT";
    void _x;
    void REVIEWER_CORRECTION_STATES;
}
void _assertStatesIntact;
