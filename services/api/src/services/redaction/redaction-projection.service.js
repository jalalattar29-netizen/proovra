/**
 * PROOVRA Phase 3A — Redaction project projection.
 *
 * Single bounded read that assembles the redaction workspace view for
 * one project — versions, regions, detection summaries, approvals,
 * derivative, standing limitations. Consumed by:
 *
 *   * the API GET /v1/redaction/projects/:id route,
 *   * the reviewer UI workspace page,
 *   * the reviewer-workspace aggregator (for queue counts),
 *   * the verification-package builder (manifest).
 *
 * Hard rules:
 *   * Workspace-anchored — every join filters on teamId.
 *   * NEVER exposes raw provider error text; honest bounded counts only.
 *   * Output schema is pinned by REDACTION_PROJECTION_SCHEMA_VERSION
 *     so consumers can refuse a version drift.
 */
import { REDACTION_PROJECTION_SCHEMA_VERSION, REDACTION_PROVENANCE_LIMITATIONS, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
export async function projectRedactionProject(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const project = await prisma.redactionProject.findFirst({
        where: { id: input.projectId, teamId: input.teamId },
        include: {
            versions: {
                orderBy: { versionOrdinal: "desc" },
                include: {
                    regions: { orderBy: { createdAt: "asc" } },
                    approvals: { orderBy: { decidedAtUtc: "asc" } },
                    derivative: true,
                    detections: {
                        select: { decisionState: true },
                    },
                },
            },
        },
    });
    if (!project)
        return { ok: false, denial: "PROJECT_NOT_FOUND" };
    const versions = project.versions.map((v) => projectVersion(v));
    const publishedVersion = versions.find((v) => v.state === "PUBLISHED") ?? null;
    return {
        ok: true,
        projection: {
            schemaVersion: REDACTION_PROJECTION_SCHEMA_VERSION,
            generatedAtUtc: new Date().toISOString(),
            id: project.id,
            teamId: project.teamId,
            evidenceId: project.evidenceId,
            artifactKind: project.artifactKind,
            title: project.title,
            state: project.state,
            createdByUserId: project.createdByUserId,
            createdAtUtc: project.createdAt.toISOString(),
            publishedVersion,
            versions,
            limitations: REDACTION_PROVENANCE_LIMITATIONS,
        },
    };
}
function projectVersion(v) {
    return {
        id: v.id,
        versionOrdinal: v.versionOrdinal,
        state: v.state,
        // R7-redaction: schema relaxed authoredByUserId to nullable for legacy rows; projection contract is non-null
        authoredByUserId: v.authoredByUserId ?? "",
        createdAtUtc: v.createdAt.toISOString(),
        submittedAtUtc: v.submittedAtUtc?.toISOString() ?? null,
        approvedAtUtc: v.approvedAtUtc?.toISOString() ?? null,
        publishedAtUtc: v.publishedAtUtc?.toISOString() ?? null,
        rationale: v.rationale,
        regionCount: v.regions.length,
        acceptedDetectionCount: v.detections.filter((d) => d.decisionState === "ACCEPTED" || d.decisionState === "MODIFIED").length,
        rejectedDetectionCount: v.detections.filter((d) => d.decisionState === "REJECTED").length,
        approvals: v.approvals.map((a) => ({
            id: a.id,
            verdict: a.verdict,
            // R7-redaction: approverUserId is canonical actor; fall back to legacy approvedByUserId, then "" to honour non-null projection contract
            approverUserId: a.approverUserId ?? a.approvedByUserId ?? "",
            // R7-redaction: decidedAtUtc became nullable when approval workflow split into decide-then-finalize; fall back to approvedAtUtc which is always set
            decidedAtUtc: (a.decidedAtUtc ?? a.approvedAtUtc).toISOString(),
            rationale: a.rationale,
        })),
        derivative: v.derivative
            ? {
                id: v.derivative.id,
                kind: v.derivative.kind,
                state: v.derivative.state,
                storageKey: v.derivative.storageKey,
                storageBucket: v.derivative.storageBucket,
                byteSize: v.derivative.byteSize
                    ? Number(v.derivative.byteSize)
                    : null,
                fileSha256: v.derivative.fileSha256,
                renderedAtUtc: v.derivative.renderedAtUtc?.toISOString() ?? null,
                failureReason: v.derivative.failureReason,
            }
            : null,
    };
}
/**
 * Lightweight workspace-aggregator helper. Counts redaction queue
 * states for the reviewer landing page. The reviewer workspace
 * service composes this into its `RedactionReviewerSummary`.
 */
export async function summariseRedactionQueueForTeam(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const [pendingDecisions, inReview, approvedReady, published, rejected] = await Promise.all([
        prisma.redactionDetection.count({
            where: { teamId: input.teamId, decisionState: "SUGGESTED" },
        }),
        prisma.redactionVersion.count({
            where: { teamId: input.teamId, state: "IN_REVIEW" },
        }),
        prisma.redactionVersion.count({
            where: {
                teamId: input.teamId,
                state: "APPROVED",
                derivative: { is: { state: { not: "READY" } } },
            },
        }),
        prisma.redactionVersion.count({
            where: { teamId: input.teamId, state: "PUBLISHED" },
        }),
        prisma.redactionVersion.count({
            where: { teamId: input.teamId, state: "REJECTED" },
        }),
    ]);
    return {
        pendingDecisionCount: pendingDecisions,
        awaitingApprovalCount: inReview,
        approvedPendingDerivativeCount: approvedReady,
        publishedCount: published,
        rejectedCount: rejected,
    };
}
// Compile-time check the orchestrator stays in sync with bounded types.
function _assertUsedTypes() {
    const _kind = "BBOX_NORMALIZED";
    const _method = "BLACKOUT";
    const _provider = "MANUAL";
    const _region = {
        id: "00000000-0000-0000-0000-000000000000",
        kind: _kind,
        method: _method,
        geometry: {},
        createdAtUtc: "1970-01-01T00:00:00Z",
        rationale: null,
        sourceDetectionId: null,
        sourceProvider: _provider,
        authoredByUserId: "00000000-0000-0000-0000-000000000000",
    };
    void _region;
}
void _assertUsedTypes;
