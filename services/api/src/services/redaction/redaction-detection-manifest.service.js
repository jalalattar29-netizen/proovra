/**
 * PROOVRA Phase 3A Closure — Detection manifest writer.
 *
 * Bounded shape consumed by the verification package + report
 * builder. For each PUBLISHED redaction version, the manifest
 * carries:
 *
 *   * Per-provider counts of suggested detections.
 *   * Per-detection-kind counts (FACE, EMAIL, ...).
 *   * Bounded breakdown of accepted / rejected / modified /
 *     deferred decisions.
 *   * Provider probe states at manifest-build time (so an offline
 *     reader can see WHY a provider produced nothing).
 *
 * Hard rules:
 *   * NEVER includes raw detection text, geometry, or rationale.
 *   * Counts + bounded enum values only.
 *   * Workspace-anchored — every read filters on teamId.
 */
import { prisma as defaultPrisma } from "../../db.js";
import { buildRedactionProviderHealth } from "./redaction-provider-health.service.js";
export async function buildRedactionDetectionManifest(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const project = await prisma.redactionProject.findFirst({
        where: { teamId: input.teamId, evidenceId: input.evidenceId },
        select: {
            id: true,
            versions: {
                where: { state: "PUBLISHED" },
                orderBy: { publishedAtUtc: "desc" },
                select: {
                    id: true,
                    versionOrdinal: true,
                    publishedAtUtc: true,
                    detections: {
                        select: {
                            kind: true,
                            provider: true,
                            confidenceBand: true,
                            decisionState: true,
                        },
                    },
                },
            },
        },
    });
    const probes = (await buildRedactionProviderHealth({
        teamId: input.teamId,
    })).map((p) => ({
        provider: p.provider,
        state: p.state,
        reason: p.reason,
    }));
    const entries = [];
    for (const v of project?.versions ?? []) {
        const perProvider = {};
        const perKind = {};
        const perDecision = {};
        const perConfidence = {};
        for (const d of v.detections) {
            perProvider[d.provider] =
                (perProvider[d.provider] ?? 0) + 1;
            perKind[d.kind] =
                (perKind[d.kind] ?? 0) + 1;
            perDecision[d.decisionState] =
                (perDecision[d.decisionState] ?? 0) + 1;
            perConfidence[d.confidenceBand] =
                (perConfidence[d.confidenceBand] ?? 0) + 1;
        }
        entries.push({
            projectId: project.id,
            evidenceId: input.evidenceId,
            versionId: v.id,
            versionOrdinal: v.versionOrdinal,
            publishedAtUtc: v.publishedAtUtc?.toISOString() ?? null,
            totalDetections: v.detections.length,
            perProvider,
            perKind,
            perDecision,
            perConfidence,
            providerProbes: probes,
        });
    }
    return {
        schemaVersion: "PROOVRA_REDACTION_DETECTION_MANIFEST_V1",
        generatedAtUtc: new Date().toISOString(),
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        entries,
    };
}
