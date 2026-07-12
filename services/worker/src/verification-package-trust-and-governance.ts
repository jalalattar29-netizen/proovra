/**
 * PROOVRA Phase 4A Closure — Verification package trust + governance manifests.
 *
 * Produces five OPTIONAL advisory JSON files that the verification package
 * may carry. All manifests:
 *   * Are additive only — downstream tooling works without them.
 *   * Never include raw article bodies, PII, or storage keys.
 *   * Are workspace-anchored on teamId.
 *
 * Paths under the `intelligence/` prefix:
 *   intelligence/trust-manifest.json
 *   intelligence/governance-manifest.json
 *   intelligence/methodology-manifest.json
 *   intelligence/ai-disclosure-manifest.json
 *   intelligence/subprocessor-manifest.json
 */

import type { PrismaClient } from "@prisma/client";

export type TrustAndGovernanceManifestEntry = {
  path: string;
  json: unknown;
};

export async function buildTrustAndGovernanceManifests(input: {
  prisma: PrismaClient;
  teamId: string;
}): Promise<ReadonlyArray<TrustAndGovernanceManifestEntry>> {
  const { prisma, teamId } = input;
  const now = new Date().toISOString();
  const out: TrustAndGovernanceManifestEntry[] = [];

  try {
    // --- trust-manifest.json ---
    const trustRows = await prisma.trustCenterArticle
      .findMany({
        where: { kind: "TRUST_CENTER", state: "PUBLISHED" },
        select: { section: true, slug: true, title: true },
        orderBy: { section: "asc" },
      })
      .catch(() => []);
    const activeSubprocessorCount = await prisma.subprocessor
      .count({ where: { state: "ACTIVE" } })
      .catch(() => 0);
    out.push({
      path: "intelligence/trust-manifest.json",
      json: {
        schemaVersion: "PROOVRA_TRUST_MANIFEST_V1",
        generatedAtUtc: now,
        trustArticles: trustRows.map((r) => ({
          section: r.section,
          slug: r.slug,
          title: r.title,
          version: null,
          publishedAtUtc: null,
        })),
        activeSubprocessorCount,
      },
    });
  } catch {
    // advisory — never fail package generation
  }

  try {
    // --- governance-manifest.json ---
    const policyRows = await prisma.governancePolicy
      .findMany({
        where: { teamId },
        select: { kind: true, state: true },
      })
      .catch(() => []);
    const policiesActive = policyRows.filter((p) => p.state === "ACTIVE").length;
    const policyCount = policyRows.length;
    const accessReviewCampaignCount = await prisma.accessReviewCampaign
      .count({ where: { teamId } })
      .catch(() => 0);
    const delegatedAdminActiveGrants = await prisma.delegatedAdminGrant
      .count({ where: { teamId, state: "ACTIVE" } })
      .catch(() => 0);
    const crossOrgActiveGrants = await prisma.crossOrgReviewGrant
      .count({ where: { teamId, state: "ACCEPTED" } })
      .catch(() => 0);
    out.push({
      path: "intelligence/governance-manifest.json",
      json: {
        schemaVersion: "PROOVRA_GOVERNANCE_MANIFEST_V1",
        generatedAtUtc: now,
        policyCount,
        policiesActive,
        accessReviewCampaignCount,
        delegatedAdminActiveGrants,
        crossOrgActiveGrants,
      },
    });
  } catch {
    // advisory
  }

  try {
    // --- methodology-manifest.json ---
    const mRows = await prisma.trustCenterArticle
      .findMany({
        where: { kind: "METHODOLOGY", state: "PUBLISHED" },
        select: { section: true, slug: true },
        orderBy: { section: "asc" },
      })
      .catch(() => []);
    out.push({
      path: "intelligence/methodology-manifest.json",
      json: {
        schemaVersion: "PROOVRA_METHODOLOGY_MANIFEST_V1",
        generatedAtUtc: now,
        sections: mRows.map((r) => ({
          section: r.section,
          slug: r.slug,
          version: null,
          publishedAtUtc: null,
        })),
      },
    });
  } catch {
    // advisory
  }

  try {
    // --- ai-disclosure-manifest.json ---
    const aiRows = await prisma.trustCenterArticle
      .findMany({
        where: { kind: "AI_DISCLOSURE", state: "PUBLISHED" },
        select: { section: true, slug: true },
        orderBy: { section: "asc" },
      })
      .catch(() => []);
    out.push({
      path: "intelligence/ai-disclosure-manifest.json",
      json: {
        schemaVersion: "PROOVRA_AI_DISCLOSURE_MANIFEST_V1",
        generatedAtUtc: now,
        sections: aiRows.map((r) => ({
          section: r.section,
          slug: r.slug,
          version: null,
          publishedAtUtc: null,
        })),
      },
    });
  } catch {
    // advisory
  }

  try {
    // --- subprocessor-manifest.json ---
    const spRows = await prisma.subprocessor
      .findMany({
        where: { state: "ACTIVE" },
        select: { id: true, name: true, category: true, country: true },
        orderBy: { name: "asc" },
      })
      .catch(() => []);
    out.push({
      path: "intelligence/subprocessor-manifest.json",
      json: {
        schemaVersion: "PROOVRA_SUBPROCESSOR_MANIFEST_V1",
        generatedAtUtc: now,
        subprocessors: spRows.map((r) => ({
          slug: r.id,
          name: r.name,
          vendor: r.category,
          region: r.country ?? null,
          version: null,
          effectiveAtUtc: null,
        })),
      },
    });
  } catch {
    // advisory
  }

  return out;
}
