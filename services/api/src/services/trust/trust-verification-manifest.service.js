/**
 * PROOVRA Phase 4A — Trust + governance verification-package
 * MANIFEST PREVIEW helpers (API-side).
 *
 * SCOPE
 *   These functions are API-side preview helpers consumed by
 *   GET /v1/trust/verification-package/preview to let operators
 *   inspect the EXACT manifest shapes that ship inside the offline
 *   verification ZIP, without having to generate a full package.
 *
 *   Production ZIP emission lives in:
 *     services/worker/src/verification-package-trust-and-governance.ts
 *
 *   The two sides MUST stay shape-compatible (schemaVersion +
 *   field set). If you change one, update the other and update
 *   the closure test (test/phase-4a-trust-and-governance.test.ts).
 *
 * Five bounded entries:
 *
 *   trust-manifest.json
 *   governance-manifest.json
 *   methodology-manifest.json
 *   ai-disclosure-manifest.json
 *   subprocessor-manifest.json
 *
 * Hard rules:
 *   * NEVER raw article bodies — manifests carry slugs + versions
 *     + publish timestamps only.
 *   * Workspace-anchored.
 *   * Offline-verifiable.
 */
import { GOVERNANCE_POLICY_KINDS, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
export async function buildTrustManifestEntry(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const rows = await prisma.trustCenterArticle
        .findMany({
        where: { teamId: input.teamId, kind: "TRUST_CENTER", state: "PUBLISHED" },
        select: {
            section: true,
            slug: true,
            title: true,
            version: true,
            publishedAtUtc: true,
        },
        orderBy: { section: "asc" },
    })
        .catch(() => []);
    const subprocessorCount = await prisma.subprocessor
        .count({ where: { teamId: input.teamId, state: "ACTIVE" } })
        .catch(() => 0);
    return {
        schemaVersion: "PROOVRA_TRUST_MANIFEST_V1",
        generatedAtUtc: new Date().toISOString(),
        trustArticles: rows.map((r) => ({
            section: r.section,
            slug: r.slug,
            title: r.title,
            version: r.version,
            publishedAtUtc: r.publishedAtUtc?.toISOString() ?? null,
        })),
        activeSubprocessorCount: subprocessorCount,
    };
}
export async function buildGovernanceManifestEntry(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const policyRows = await prisma.governancePolicy
        .findMany({
        where: { teamId: input.teamId },
        select: { kind: true, state: true },
    })
        .catch(() => []);
    const policiesPerKind = {};
    for (const k of GOVERNANCE_POLICY_KINDS)
        policiesPerKind[k] = 0;
    let policiesActive = 0;
    for (const p of policyRows) {
        policiesPerKind[p.kind] =
            (policiesPerKind[p.kind] ?? 0) + 1;
        if (p.state === "ACTIVE")
            policiesActive += 1;
    }
    const accessReviewCampaignCount = await prisma.accessReviewCampaign
        .count({ where: { teamId: input.teamId } })
        .catch(() => 0);
    const delegatedAdminActiveGrants = await prisma.delegatedAdminGrant
        .count({ where: { teamId: input.teamId, state: "ACTIVE" } })
        .catch(() => 0);
    const crossOrgActive = await prisma.crossOrgReviewGrant
        .count({ where: { teamId: input.teamId, state: "ACCEPTED" } })
        .catch(() => 0);
    return {
        schemaVersion: "PROOVRA_GOVERNANCE_MANIFEST_V1",
        generatedAtUtc: new Date().toISOString(),
        policyCount: policyRows.length,
        policiesActive,
        policiesPerKind,
        accessReviewCampaignCount,
        delegatedAdminActiveGrants,
        crossOrgActiveGrants: crossOrgActive,
    };
}
export async function buildMethodologyManifestEntry(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const rows = await prisma.trustCenterArticle
        .findMany({
        where: { teamId: input.teamId, kind: "METHODOLOGY", state: "PUBLISHED" },
        select: { section: true, slug: true, version: true, publishedAtUtc: true },
        orderBy: { section: "asc" },
    })
        .catch(() => []);
    return {
        schemaVersion: "PROOVRA_METHODOLOGY_MANIFEST_V1",
        generatedAtUtc: new Date().toISOString(),
        sections: rows.map((r) => ({
            section: r.section,
            slug: r.slug,
            version: r.version,
            publishedAtUtc: r.publishedAtUtc?.toISOString() ?? null,
        })),
    };
}
export async function buildAiDisclosureManifestEntry(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const rows = await prisma.trustCenterArticle
        .findMany({
        where: { teamId: input.teamId, kind: "AI_DISCLOSURE", state: "PUBLISHED" },
        select: { section: true, slug: true, version: true, publishedAtUtc: true },
        orderBy: { section: "asc" },
    })
        .catch(() => []);
    return {
        schemaVersion: "PROOVRA_AI_DISCLOSURE_MANIFEST_V1",
        generatedAtUtc: new Date().toISOString(),
        sections: rows.map((r) => ({
            section: r.section,
            slug: r.slug,
            version: r.version,
            publishedAtUtc: r.publishedAtUtc?.toISOString() ?? null,
        })),
    };
}
export async function buildSubprocessorManifestEntry(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const rows = await prisma.subprocessor
        .findMany({
        where: { teamId: input.teamId, state: "ACTIVE" },
        orderBy: { name: "asc" },
    })
        .catch(() => []);
    return {
        schemaVersion: "PROOVRA_SUBPROCESSOR_MANIFEST_V1",
        generatedAtUtc: new Date().toISOString(),
        subprocessors: rows.map((r) => ({
            slug: r.slug ?? "",
            name: r.name,
            vendor: r.vendor ?? "",
            region: r.region ?? "",
            purpose: r.purpose ?? "",
            dataCategories: Array.isArray(r.dataCategories)
                ? r.dataCategories
                : [],
            state: r.state,
            version: r.version,
            effectiveAtUtc: r.effectiveAtUtc.toISOString(),
        })),
    };
}
// ---------------------------------------------------------------------------
// Preview dispatcher — consumed by the /v1/trust/verification-package/preview
// HTTP route in trust-and-governance.routes.ts. Returns the SAME manifest
// shape that the worker emits inside the offline verification ZIP for the
// requested kind. Read-only, workspace-anchored.
// ---------------------------------------------------------------------------
export const VERIFICATION_PACKAGE_PREVIEW_KINDS = [
    "trust",
    "governance",
    "methodology",
    "ai-disclosure",
    "subprocessor",
];
export async function buildVerificationPackagePreview(input) {
    switch (input.kind) {
        case "trust":
            return buildTrustManifestEntry({ prisma: input.prisma, teamId: input.teamId });
        case "governance":
            return buildGovernanceManifestEntry({ prisma: input.prisma, teamId: input.teamId });
        case "methodology":
            return buildMethodologyManifestEntry({ prisma: input.prisma, teamId: input.teamId });
        case "ai-disclosure":
            return buildAiDisclosureManifestEntry({ prisma: input.prisma, teamId: input.teamId });
        case "subprocessor":
            return buildSubprocessorManifestEntry({ prisma: input.prisma, teamId: input.teamId });
    }
}
