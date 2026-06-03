/**
 * Phase 32.8E — Governance Control Plane aggregator service.
 *
 * Powers `/v1/governance/control-plane` — a single read-only
 * envelope that the new enterprise /governance hub renders.
 *
 * Hard rules:
 *   - READ ONLY. No Prisma writes.
 *   - NEVER emits an audit / analytics / security event.
 *   - NEVER weakens governance — the legal-admissibility /
 *     authenticity disclaimer is enforced by the FRONTEND copy
 *     tests; this service projects bounded operational signals
 *     only.
 *   - Bounded queries.
 *   - Per-section try/catch. Phase 14 `caseLegalHold` is now
 *     treated as a CORE feature (per the 32.8E brief); the
 *     subsystem-disabled banner is reserved for genuine schema
 *     drift (P2021/P2022).
 */
import * as prismaPkg from "@prisma/client";
import { prisma } from "../../db.js";
// ---------------------------------------------------------------------------
// Bounded limits
// ---------------------------------------------------------------------------
const HOLDS_LIMIT = 50;
const RETENTION_CANDIDATES_LIMIT = 50;
const DESTRUCTION_REVIEWS_LIMIT = 50;
const EXPORT_BLOCKS_LIMIT = 25;
const INCIDENTS_LIMIT = 10;
function isPrismaTableOrColumnMissing(err) {
    if (err == null || typeof err !== "object")
        return false;
    const code = err.code;
    return code === "P2021" || code === "P2022";
}
// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------
export async function buildGovernanceControlPlane(input) {
    const memberCount = await prisma.teamMember.count({
        where: { teamId: input.teamId, status: "ACTIVE" },
    });
    const scope = memberCount <= 1 ? "PERSONAL" : "TEAM";
    // ----------- Posture (high-level counts) -----------
    let posture = {
        status: "unavailable",
        data: null,
    };
    let caseLegalHoldsEnabled = true;
    try {
        const [policy, activeLegalHoldsCount, retentionCandidatesCount, pendingDestructionReviewsCount, activePoliciesCount,] = await Promise.all([
            prisma.workspaceGovernancePolicy.findUnique({
                where: { teamId: input.teamId },
                select: { id: true },
            }),
            prisma.evidenceLegalHold.count({
                where: { teamId: input.teamId, status: "ACTIVE" },
            }),
            prisma.destructionReview
                .count({ where: { teamId: input.teamId, status: "PROPOSED" } })
                .catch(() => 0),
            prisma.destructionReview
                .count({
                where: {
                    teamId: input.teamId,
                    status: { in: ["PROPOSED", "PENDING_APPROVAL"] },
                },
            })
                .catch(() => 0),
            prisma.evidenceRetentionPolicy
                .count({ where: { teamId: input.teamId, status: "ACTIVE" } })
                .catch(() => 0),
        ]);
        // Phase 14 / 32.8E — case_legal_holds is treated as a CORE feature.
        // We swallow only the bounded P2021/P2022 schema-drift errors
        // (subsystem genuinely not deployed) and surface a real count
        // otherwise.
        let activeCaseLegalHoldsCount = 0;
        try {
            activeCaseLegalHoldsCount = await prisma.caseLegalHold.count({
                where: { teamId: input.teamId, status: "ACTIVE" },
            });
        }
        catch (err) {
            if (isPrismaTableOrColumnMissing(err)) {
                caseLegalHoldsEnabled = false;
            }
            else {
                throw err;
            }
        }
        let policyConflictsCount = 0;
        try {
            const { countActivePolicyConflicts } = await import("../governance-lifecycle/retention-engine.service.js");
            policyConflictsCount = await countActivePolicyConflicts(input.teamId);
        }
        catch {
            // best-effort
        }
        posture = {
            status: "ok",
            data: {
                policySource: policy ? "workspace_row" : "default",
                activeLegalHoldsCount,
                activeCaseLegalHoldsCount,
                retentionCandidatesCount,
                pendingDestructionReviewsCount,
                activePoliciesCount,
                policyConflictsCount,
                caseLegalHoldsEnabled,
            },
        };
    }
    catch {
        posture = { status: "unavailable", data: null };
    }
    // ----------- Preservation (real holds) -----------
    let preservation = {
        status: "unavailable",
        data: null,
    };
    let preservationOk = false;
    let preservationFailed = false;
    let evidenceHolds = [];
    let caseHolds = [];
    try {
        const rows = await prisma.evidenceLegalHold.findMany({
            where: { teamId: input.teamId },
            orderBy: { placedAtUtc: "desc" },
            take: HOLDS_LIMIT,
            select: {
                id: true,
                evidenceId: true,
                reason: true,
                status: true,
                placedAtUtc: true,
                releasedAtUtc: true,
            },
        });
        evidenceHolds = rows.map((r) => ({
            id: r.id,
            evidenceId: r.evidenceId,
            reason: r.reason,
            status: String(r.status),
            placedAtUtc: r.placedAtUtc.toISOString(),
            releasedAtUtc: r.releasedAtUtc ? r.releasedAtUtc.toISOString() : null,
        }));
        preservationOk = true;
    }
    catch {
        preservationFailed = true;
    }
    try {
        const rows = await prisma.caseLegalHold.findMany({
            where: { teamId: input.teamId },
            orderBy: { placedAtUtc: "desc" },
            take: HOLDS_LIMIT,
            select: {
                id: true,
                caseId: true,
                title: true,
                status: true,
                placedAtUtc: true,
                releasedAtUtc: true,
            },
        });
        caseHolds = rows.map((r) => ({
            id: r.id,
            caseId: r.caseId,
            title: r.title,
            status: String(r.status),
            placedAtUtc: r.placedAtUtc.toISOString(),
            releasedAtUtc: r.releasedAtUtc ? r.releasedAtUtc.toISOString() : null,
        }));
        preservationOk = true;
    }
    catch (err) {
        if (!isPrismaTableOrColumnMissing(err)) {
            preservationFailed = true;
        }
        // Phase 14 schema not deployed — degrade silently rather than
        // crashing the whole preservation tab.
    }
    preservation = {
        status: !preservationOk
            ? "unavailable"
            : preservationFailed
                ? "degraded"
                : "ok",
        data: preservationOk ? { evidenceHolds, caseHolds } : null,
    };
    // ----------- Retention & destruction -----------
    let retention = {
        status: "unavailable",
        data: null,
    };
    let retentionOk = false;
    let retentionFailed = false;
    let candidates = [];
    let destructionReviews = [];
    try {
        const rows = await prisma.destructionReview.findMany({
            where: { teamId: input.teamId, status: "PROPOSED" },
            orderBy: { createdAt: "desc" },
            take: RETENTION_CANDIDATES_LIMIT,
            select: {
                id: true,
                evidenceId: true,
                status: true,
                createdAt: true,
            },
        });
        candidates = rows.map((r) => ({
            id: r.id,
            evidenceId: r.evidenceId,
            retentionUntilUtc: null,
            createdAt: r.createdAt.toISOString(),
            status: String(r.status),
        }));
        retentionOk = true;
    }
    catch {
        retentionFailed = true;
    }
    try {
        const rows = await prisma.destructionReview.findMany({
            where: {
                teamId: input.teamId,
                status: { in: ["PROPOSED", "PENDING_APPROVAL"] },
            },
            orderBy: { createdAt: "desc" },
            take: DESTRUCTION_REVIEWS_LIMIT,
            select: {
                id: true,
                evidenceId: true,
                status: true,
                createdAt: true,
            },
        });
        destructionReviews = rows.map((r) => ({
            id: r.id,
            evidenceId: r.evidenceId,
            status: String(r.status),
            createdAt: r.createdAt.toISOString(),
        }));
        retentionOk = true;
    }
    catch {
        retentionFailed = true;
    }
    retention = {
        status: !retentionOk
            ? "unavailable"
            : retentionFailed
                ? "degraded"
                : "ok",
        data: retentionOk
            ? { candidates, pendingDestructionReviews: destructionReviews }
            : null,
    };
    // ----------- Export governance (blocked metadata read) -----------
    let exportGovernance = {
        status: "unavailable",
        data: null,
    };
    try {
        const policy = await prisma.workspaceGovernancePolicy.findUnique({
            where: { teamId: input.teamId },
            select: {
                allowReportDownload: true,
                allowPackageDownload: true,
                allowPublicVerify: true,
                allowOriginalDownload: true,
            },
        });
        // Recent package-blocked metadata (bounded sample).
        const recent = await prisma.evidence.findMany({
            where: {
                teamId: input.teamId,
                status: { in: ["SIGNED", "REPORTED"] },
                verificationPackageMetadata: { not: prismaPkg.Prisma.JsonNull },
            },
            take: EXPORT_BLOCKS_LIMIT,
            orderBy: { updatedAt: "desc" },
            select: { id: true, verificationPackageMetadata: true },
        });
        const recentBlocks = [];
        for (const row of recent) {
            const meta = row.verificationPackageMetadata;
            if (meta && meta.blocked === true) {
                recentBlocks.push({
                    evidenceId: row.id,
                    reason: typeof meta.reason === "string"
                        ? meta.reason.slice(0, 160)
                        : "blocked",
                    outcome: typeof meta.outcome === "string"
                        ? meta.outcome.slice(0, 80)
                        : null,
                    blockedAtUtc: typeof meta.blockedAtUtc === "string"
                        ? meta.blockedAtUtc
                        : null,
                });
            }
        }
        exportGovernance = {
            status: "ok",
            data: {
                recentBlocks,
                gateFlags: {
                    allowReportDownload: policy?.allowReportDownload ?? true,
                    allowPackageDownload: policy?.allowPackageDownload ?? true,
                    allowPublicVerify: policy?.allowPublicVerify ?? true,
                    allowOriginalDownload: policy?.allowOriginalDownload ?? true,
                },
            },
        };
    }
    catch {
        exportGovernance = { status: "unavailable", data: null };
    }
    // ----------- Policy snapshot -----------
    let policySection = {
        status: "unavailable",
        data: null,
    };
    try {
        const policy = await prisma.workspaceGovernancePolicy.findUnique({
            where: { teamId: input.teamId },
            select: {
                defaultRetentionDays: true,
                evidenceDeletionMode: true,
                requireLegalHoldApprovalForDeletion: true,
                requireReviewBeforeReport: true,
                requireReviewBeforePackage: true,
                requireReviewBeforePublicVerify: true,
            },
        });
        policySection = {
            status: "ok",
            data: {
                source: policy ? "workspace_row" : "default",
                defaultRetentionDays: policy?.defaultRetentionDays ?? null,
                evidenceDeletionMode: String(policy?.evidenceDeletionMode ?? "ALLOWED"),
                requireLegalHoldApprovalForDeletion: policy?.requireLegalHoldApprovalForDeletion ?? false,
                requireReviewBeforeReport: policy?.requireReviewBeforeReport ?? false,
                requireReviewBeforePackage: policy?.requireReviewBeforePackage ?? false,
                requireReviewBeforePublicVerify: policy?.requireReviewBeforePublicVerify ?? false,
            },
        };
    }
    catch {
        policySection = { status: "unavailable", data: null };
    }
    // ----------- Governance-tagged operational incidents -----------
    let incidents = {
        status: "unavailable",
        items: [],
    };
    try {
        const rows = await prisma.operationalIncident.findMany({
            where: {
                OR: [{ teamId: input.teamId }, { teamId: null }],
                status: { in: ["OPEN", "ACKNOWLEDGED"] },
                category: { in: ["GOVERNANCE", "PACKAGE", "REPORT"] },
            },
            orderBy: [{ severity: "desc" }, { lastSeenAtUtc: "desc" }],
            take: INCIDENTS_LIMIT,
            select: {
                id: true,
                category: true,
                severity: true,
                status: true,
                title: true,
                safeSummary: true,
                runbookSlug: true,
                lastSeenAtUtc: true,
            },
        });
        incidents = {
            status: "ok",
            items: rows.map((r) => ({
                id: r.id,
                category: String(r.category),
                severity: String(r.severity),
                status: String(r.status),
                title: r.title,
                safeSummary: r.safeSummary,
                runbookSlug: r.runbookSlug ?? null,
                lastSeenAtUtc: r.lastSeenAtUtc.toISOString(),
            })),
        };
    }
    catch {
        incidents = { status: "unavailable", items: [] };
    }
    return {
        generatedAt: new Date().toISOString(),
        workspace: { id: input.teamId, role: input.role, scope },
        sections: {
            posture,
            preservation,
            retention,
            exportGovernance,
            policy: policySection,
            incidents,
        },
    };
}
