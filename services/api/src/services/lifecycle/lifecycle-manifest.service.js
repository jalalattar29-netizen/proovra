/**
 * PROOVRA Phase 4B — Lifecycle + Exchange verification-package
 * MANIFEST PREVIEW helpers (API-side).
 *
 * API-side preview helpers. Production ZIP emission lives in
 * services/worker/src/verification-package-lifecycle.ts.
 * Schemas MUST stay shape-compatible.
 *
 * Seven bounded entries:
 *   lifecycle-manifest.json
 *   retention-manifest.json
 *   legal-hold-manifest.json
 *   archive-manifest.json
 *   destruction-manifest.json
 *   exchange-manifest.json
 *   transfer-manifest.json
 *
 * Hard rules:
 *   * NEVER raw reasons, NEVER PII.
 *   * Bounded counts + bounded ids + bounded states only.
 *   * Workspace-anchored on teamId.
 *   * Optional evidenceId narrows scope but is never required.
 */
import { prisma as defaultPrisma } from "../../db.js";
const MAX_IDS = 50;
function nowUtc() {
    return new Date().toISOString();
}
function evidenceIdMatches(json, evidenceId) {
    if (!Array.isArray(json))
        return false;
    return json.some((v) => typeof v === "string" && v === evidenceId);
}
// ---------------------------------------------------------------------------
// Lifecycle summary
// ---------------------------------------------------------------------------
export async function buildLifecycleManifestEntry(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const { teamId, evidenceId } = input;
    const totalPolicies = await prisma.retentionPolicyConfig
        .count({ where: { teamId } })
        .catch(() => 0);
    const totalLegalHolds = await prisma.legalHold
        .count({
        where: evidenceId
            ? { teamId, scopeTargetId: evidenceId }
            : { teamId },
    })
        .catch(() => 0);
    const totalArchiveTransitions = await prisma.archiveTierTransition
        .count({
        where: evidenceId ? { teamId, evidenceId } : { teamId },
    })
        .catch(() => 0);
    const totalDestructionRequests = await prisma.destructionRequest
        .count({ where: { teamId } })
        .catch(() => 0);
    return {
        schemaVersion: "PROOVRA_LIFECYCLE_MANIFEST_V1",
        generatedAtUtc: nowUtc(),
        teamId,
        totalPolicies,
        totalLegalHolds,
        totalArchiveTransitions,
        totalDestructionRequests,
    };
}
// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------
export async function buildRetentionManifestEntry(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const { teamId } = input;
    const row = await prisma.retentionPolicyConfig
        .findFirst({
        where: { teamId, state: "ACTIVE" },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            name: true,
            template: true,
            years: true,
            scopeKind: true,
            isOverride: true,
        },
    })
        .catch(() => null);
    return {
        schemaVersion: "PROOVRA_RETENTION_MANIFEST_V1",
        generatedAtUtc: nowUtc(),
        policyId: row?.id ?? "",
        policyName: row?.name ?? "",
        template: (row?.template ?? "CUSTOM"),
        years: row?.years ?? 0,
        appliesTo: row?.scopeKind ?? "WORKSPACE",
        isOverride: row?.isOverride ?? false,
    };
}
// ---------------------------------------------------------------------------
// Legal hold
// ---------------------------------------------------------------------------
export async function buildLegalHoldManifestEntry(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const { teamId, evidenceId } = input;
    const row = await prisma.legalHold
        .findFirst({
        where: evidenceId
            ? { teamId, scopeTargetId: evidenceId }
            : { teamId, state: "ACTIVE" },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            kind: true,
            state: true,
            scopeTargetId: true,
            createdAt: true,
            releasedAtUtc: true,
        },
    })
        .catch(() => null);
    return {
        schemaVersion: "PROOVRA_LEGAL_HOLD_MANIFEST_V1",
        generatedAtUtc: nowUtc(),
        holdId: row?.id ?? "",
        kind: (row?.kind ?? "EVIDENCE"),
        state: (row?.state ?? "ACTIVE"),
        scopeTargetId: row?.scopeTargetId ?? null,
        createdAt: row?.createdAt?.toISOString() ?? nowUtc(),
        releasedAtUtc: row?.releasedAtUtc?.toISOString() ?? null,
    };
}
// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------
export async function buildArchiveManifestEntry(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const { teamId, evidenceId } = input;
    const row = await prisma.archiveTierTransition
        .findFirst({
        where: evidenceId ? { teamId, evidenceId } : { teamId },
        orderBy: { transitionedAtUtc: "desc" },
        select: {
            evidenceId: true,
            fromTier: true,
            toTier: true,
            transitionedAtUtc: true,
            costEstimateUsdMicros: true,
        },
    })
        .catch(() => null);
    return {
        schemaVersion: "PROOVRA_ARCHIVE_MANIFEST_V1",
        generatedAtUtc: nowUtc(),
        evidenceId: row?.evidenceId ?? evidenceId ?? "",
        fromTier: (row?.fromTier ?? "HOT"),
        toTier: (row?.toTier ?? "HOT"),
        transitionedAtUtc: row?.transitionedAtUtc?.toISOString() ?? nowUtc(),
        costEstimateUsdMicros: row ? Number(row.costEstimateUsdMicros) : 0,
    };
}
// ---------------------------------------------------------------------------
// Destruction
// ---------------------------------------------------------------------------
export async function buildDestructionManifestEntry(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const { teamId, evidenceId } = input;
    const rows = await prisma.destructionRequest
        .findMany({
        where: { teamId },
        orderBy: { createdAt: "desc" },
        take: MAX_IDS,
        select: {
            id: true,
            state: true,
            evidenceIds: true,
            certifiedAtUtc: true,
            certificate: { select: { certificateHash: true, evidenceCount: true } },
        },
    })
        .catch(() => []);
    const row = evidenceId
        ? rows.find((r) => evidenceIdMatches(r.evidenceIds, evidenceId)) ?? null
        : rows[0] ?? null;
    const evidenceCount = row
        ? row.certificate?.evidenceCount ??
            (Array.isArray(row.evidenceIds) ? row.evidenceIds.length : 0)
        : 0;
    return {
        schemaVersion: "PROOVRA_DESTRUCTION_MANIFEST_V1",
        generatedAtUtc: nowUtc(),
        requestId: row?.id ?? "",
        state: (row?.state ?? "REQUESTED"),
        evidenceCount,
        certifiedAtUtc: row?.certifiedAtUtc?.toISOString() ?? null,
        certificateHash: row?.certificate?.certificateHash ?? null,
    };
}
// ---------------------------------------------------------------------------
// Exchange package
// ---------------------------------------------------------------------------
export async function buildExchangeManifestEntry(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const { teamId, evidenceId } = input;
    const rows = await prisma.evidenceExchangePackage
        .findMany({
        where: { teamId },
        orderBy: { createdAt: "desc" },
        take: MAX_IDS,
        select: {
            id: true,
            kind: true,
            state: true,
            evidenceIds: true,
            packageSha256: true,
            createdAt: true,
        },
    })
        .catch(() => []);
    const row = evidenceId
        ? rows.find((r) => evidenceIdMatches(r.evidenceIds, evidenceId)) ?? null
        : rows[0] ?? null;
    const evidenceCount = row
        ? Array.isArray(row.evidenceIds)
            ? row.evidenceIds.length
            : 0
        : 0;
    return {
        schemaVersion: "PROOVRA_EXCHANGE_MANIFEST_V1",
        generatedAtUtc: nowUtc(),
        packageId: row?.id ?? "",
        kind: (row?.kind ?? "EVIDENCE"),
        state: (row?.state ?? "DRAFT"),
        evidenceCount,
        packageSha256: row?.packageSha256 ?? null,
        createdAt: row?.createdAt?.toISOString() ?? nowUtc(),
    };
}
// ---------------------------------------------------------------------------
// Chain transfer
// ---------------------------------------------------------------------------
export async function buildTransferManifestEntry(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const { teamId, evidenceId } = input;
    const rows = await prisma.chainTransfer
        .findMany({
        where: { teamId },
        orderBy: { createdAt: "desc" },
        take: MAX_IDS,
        select: {
            id: true,
            fromOrganizationId: true,
            toOrganizationSlug: true,
            state: true,
            evidenceIds: true,
            createdAt: true,
            completedAtUtc: true,
        },
    })
        .catch(() => []);
    const row = evidenceId
        ? rows.find((r) => evidenceIdMatches(r.evidenceIds, evidenceId)) ?? null
        : rows[0] ?? null;
    const evidenceCount = row
        ? Array.isArray(row.evidenceIds)
            ? row.evidenceIds.length
            : 0
        : 0;
    return {
        schemaVersion: "PROOVRA_TRANSFER_MANIFEST_V1",
        generatedAtUtc: nowUtc(),
        transferId: row?.id ?? "",
        fromOrganizationId: row?.fromOrganizationId ?? "",
        toOrganizationSlug: row?.toOrganizationSlug ?? "",
        state: (row?.state ?? "INITIATED"),
        evidenceCount,
        createdAt: row?.createdAt?.toISOString() ?? nowUtc(),
        completedAtUtc: row?.completedAtUtc?.toISOString() ?? null,
    };
}
// ---------------------------------------------------------------------------
// Preview dispatcher
// ---------------------------------------------------------------------------
export const VERIFICATION_PACKAGE_LIFECYCLE_PREVIEW_KINDS = [
    "lifecycle",
    "retention",
    "legal-hold",
    "archive",
    "destruction",
    "exchange",
    "transfer",
];
export async function buildLifecyclePackagePreview(input) {
    const args = {
        prisma: input.prisma,
        teamId: input.teamId,
        evidenceId: input.evidenceId,
    };
    switch (input.kind) {
        case "lifecycle":
            return buildLifecycleManifestEntry(args);
        case "retention":
            return buildRetentionManifestEntry(args);
        case "legal-hold":
            return buildLegalHoldManifestEntry(args);
        case "archive":
            return buildArchiveManifestEntry(args);
        case "destruction":
            return buildDestructionManifestEntry(args);
        case "exchange":
            return buildExchangeManifestEntry(args);
        case "transfer":
            return buildTransferManifestEntry(args);
    }
}
