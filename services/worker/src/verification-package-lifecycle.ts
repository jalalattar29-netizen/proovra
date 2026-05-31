/**
 * PROOVRA Phase 4B — Verification package lifecycle + exchange manifests.
 *
 * Produces seven OPTIONAL advisory JSON files that the verification package
 * may carry. All manifests:
 *   * Are additive only — the offline verifier works without them.
 *   * Never include raw reasons or PII.
 *   * Carry only bounded counts + bounded ids + bounded states.
 *   * Are workspace-anchored on teamId; optional evidenceId narrows scope.
 *
 * Paths under the `lifecycle/` prefix:
 *   lifecycle/lifecycle-manifest.json
 *   lifecycle/retention-manifest.json
 *   lifecycle/legal-hold-manifest.json
 *   lifecycle/archive-manifest.json
 *   lifecycle/destruction-manifest.json
 *   lifecycle/exchange-manifest.json
 *   lifecycle/transfer-manifest.json
 *
 * Shape-compatible with the API-side preview writers in
 * services/api/src/services/lifecycle/lifecycle-manifest.service.ts.
 * If you change one side, change the other.
 */

import type { PrismaClient } from "@prisma/client";

export type LifecycleManifestFileEntry = {
  path: string;
  json: unknown;
};

const MAX_IDS = 50;

function evidenceIdMatches(json: unknown, evidenceId: string): boolean {
  if (!Array.isArray(json)) return false;
  return json.some((v) => typeof v === "string" && v === evidenceId);
}

export async function buildLifecycleAndExchangeManifests(input: {
  prisma: PrismaClient;
  teamId: string;
  evidenceId?: string;
}): Promise<ReadonlyArray<LifecycleManifestFileEntry>> {
  const { prisma, teamId, evidenceId } = input;
  const now = new Date().toISOString();
  const out: LifecycleManifestFileEntry[] = [];

  // --- lifecycle-manifest.json ---
  try {
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
    out.push({
      path: "lifecycle/lifecycle-manifest.json",
      json: {
        schemaVersion: "PROOVRA_LIFECYCLE_MANIFEST_V1",
        generatedAtUtc: now,
        teamId,
        totalPolicies,
        totalLegalHolds,
        totalArchiveTransitions,
        totalDestructionRequests,
      },
    });
  } catch {
    // advisory — never fail package generation
  }

  // --- retention-manifest.json ---
  try {
    const row = await prisma.retentionPolicyConfig
      .findFirst({
        where: { teamId },
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
    out.push({
      path: "lifecycle/retention-manifest.json",
      json: {
        schemaVersion: "PROOVRA_RETENTION_MANIFEST_V1",
        generatedAtUtc: now,
        policyId: row?.id ?? "",
        policyName: row?.name ?? "",
        template: row?.template ?? "CUSTOM",
        years: row?.years ?? 0,
        appliesTo: row?.scopeKind ?? "WORKSPACE",
        isOverride: row?.isOverride ?? false,
      },
    });
  } catch {
    // advisory
  }

  // --- legal-hold-manifest.json ---
  try {
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
    out.push({
      path: "lifecycle/legal-hold-manifest.json",
      json: {
        schemaVersion: "PROOVRA_LEGAL_HOLD_MANIFEST_V1",
        generatedAtUtc: now,
        holdId: row?.id ?? "",
        kind: row?.kind ?? "EVIDENCE",
        state: row?.state ?? "ACTIVE",
        scopeTargetId: row?.scopeTargetId ?? null,
        createdAt: row?.createdAt?.toISOString() ?? now,
        releasedAtUtc: row?.releasedAtUtc?.toISOString() ?? null,
      },
    });
  } catch {
    // advisory
  }

  // --- archive-manifest.json ---
  try {
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
    out.push({
      path: "lifecycle/archive-manifest.json",
      json: {
        schemaVersion: "PROOVRA_ARCHIVE_MANIFEST_V1",
        generatedAtUtc: now,
        evidenceId: row?.evidenceId ?? evidenceId ?? "",
        fromTier: row?.fromTier ?? "HOT",
        toTier: row?.toTier ?? "HOT",
        transitionedAtUtc: row?.transitionedAtUtc?.toISOString() ?? now,
        costEstimateUsdMicros: row ? Number(row.costEstimateUsdMicros) : 0,
      },
    });
  } catch {
    // advisory
  }

  // --- destruction-manifest.json ---
  try {
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
        },
      })
      .catch(
        () =>
          [] as Array<{
            id: string;
            state: string;
            evidenceIds: unknown;
            certifiedAtUtc: Date | null;
          }>,
      );
    const row = evidenceId
      ? rows.find((r) => evidenceIdMatches(r.evidenceIds, evidenceId)) ?? null
      : rows[0] ?? null;
    // DestructionCertificate is a separate model — look it up by requestId if available.
    const cert = row
      ? await prisma.destructionCertificate
          .findFirst({
            where: { requestId: row.id },
            select: { certificateHash: true, evidenceCount: true },
          })
          .catch(() => null)
      : null;
    const evidenceCount = cert?.evidenceCount ??
      (Array.isArray(row?.evidenceIds) ? (row?.evidenceIds as unknown[]).length : 0);
    out.push({
      path: "lifecycle/destruction-manifest.json",
      json: {
        schemaVersion: "PROOVRA_DESTRUCTION_MANIFEST_V1",
        generatedAtUtc: now,
        requestId: row?.id ?? "",
        state: row?.state ?? "REQUESTED",
        evidenceCount,
        certifiedAtUtc: row?.certifiedAtUtc?.toISOString() ?? null,
        certificateHash: cert?.certificateHash ?? null,
      },
    });
  } catch {
    // advisory
  }

  // --- exchange-manifest.json ---
  try {
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
      .catch(
        () =>
          [] as Array<{
            id: string;
            kind: string;
            state: string;
            evidenceIds: unknown;
            packageSha256: string | null;
            createdAt: Date;
          }>,
      );
    const row = evidenceId
      ? rows.find((r) => evidenceIdMatches(r.evidenceIds, evidenceId)) ?? null
      : rows[0] ?? null;
    const evidenceCount = row
      ? Array.isArray(row.evidenceIds)
        ? row.evidenceIds.length
        : 0
      : 0;
    out.push({
      path: "lifecycle/exchange-manifest.json",
      json: {
        schemaVersion: "PROOVRA_EXCHANGE_MANIFEST_V1",
        generatedAtUtc: now,
        packageId: row?.id ?? "",
        kind: row?.kind ?? "EVIDENCE",
        state: row?.state ?? "DRAFT",
        evidenceCount,
        packageSha256: row?.packageSha256 ?? null,
        createdAt: row?.createdAt?.toISOString() ?? now,
      },
    });
  } catch {
    // advisory
  }

  // --- transfer-manifest.json ---
  try {
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
      .catch(
        () =>
          [] as Array<{
            id: string;
            fromOrganizationId: string;
            toOrganizationSlug: string;
            state: string;
            evidenceIds: unknown;
            createdAt: Date;
            completedAtUtc: Date | null;
          }>,
      );
    const row = evidenceId
      ? rows.find((r) => evidenceIdMatches(r.evidenceIds, evidenceId)) ?? null
      : rows[0] ?? null;
    const evidenceCount = row
      ? Array.isArray(row.evidenceIds)
        ? row.evidenceIds.length
        : 0
      : 0;
    out.push({
      path: "lifecycle/transfer-manifest.json",
      json: {
        schemaVersion: "PROOVRA_TRANSFER_MANIFEST_V1",
        generatedAtUtc: now,
        transferId: row?.id ?? "",
        fromOrganizationId: row?.fromOrganizationId ?? "",
        toOrganizationSlug: row?.toOrganizationSlug ?? "",
        state: row?.state ?? "INITIATED",
        evidenceCount,
        createdAt: row?.createdAt?.toISOString() ?? now,
        completedAtUtc: row?.completedAtUtc?.toISOString() ?? null,
      },
    });
  } catch {
    // advisory
  }

  return out;
}
