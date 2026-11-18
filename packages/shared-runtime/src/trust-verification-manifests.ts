/**
 * THE trust + governance verification-package manifest builder (RG-20,
 * PRO-G2-01).
 *
 * One implementation for both hosts: the API's
 * GET /v1/trust/verification-package/preview and the Worker's verification
 * package (intelligence/*.json) both call these functions, so the preview an
 * operator inspects is exactly what the sealed package carries.
 *
 * Hard rules:
 *   * EVERY query is anchored on the package's workspace (`teamId`).
 *     TrustCenterArticle and Subprocessor are per-workspace rows; a query
 *     without the predicate sealed other tenants' titles and vendor names into
 *     immutable packages.
 *   * Every list read is bounded (`take`), so package size never grows with
 *     the tenant count or an unbounded custom article set.
 *   * NEVER raw article bodies — slugs, titles, versions, publish times only.
 *   * Advisory: a failed read yields an empty section, never a failed package.
 */
import type { PrismaClient } from "@prisma/client";
import {
  GOVERNANCE_POLICY_KINDS,
  type AiDisclosureManifestEntry,
  type AiDisclosureSection,
  type GovernanceManifestEntry,
  type GovernancePolicyKind,
  type MethodologyManifestEntry,
  type MethodologySection,
  type SubprocessorDataCategory,
  type SubprocessorManifestEntry,
  type SubprocessorState,
  type TrustManifestEntry,
} from "@proovra/shared";

/** Upper bound on rows of one family read into one manifest. */
export const TRUST_MANIFEST_MAX_ROWS = 500;

type ManifestPrisma = Pick<
  PrismaClient,
  | "trustCenterArticle"
  | "subprocessor"
  | "governancePolicy"
  | "accessReviewCampaign"
  | "memberDelegatedAdminScope"
  | "crossOrgReviewGrant"
>;

type ArticleRow = {
  section: string;
  slug: string;
  title?: string;
  version: number | null;
  publishedAtUtc: Date | null;
};

async function publishedArticles(
  prisma: ManifestPrisma,
  teamId: string,
  kind: "TRUST_CENTER" | "METHODOLOGY" | "AI_DISCLOSURE",
): Promise<ArticleRow[]> {
  return (await prisma.trustCenterArticle
    .findMany({
      where: { teamId, kind, state: "PUBLISHED" },
      select: { section: true, slug: true, title: true, version: true, publishedAtUtc: true },
      orderBy: [{ section: "asc" }, { slug: "asc" }],
      take: TRUST_MANIFEST_MAX_ROWS,
    })
    .catch(() => [])) as ArticleRow[];
}

function iso(d: Date | null | undefined): string | null {
  return d instanceof Date ? d.toISOString() : null;
}

export async function buildTrustManifestEntry(input: {
  prisma: ManifestPrisma;
  teamId: string;
}): Promise<TrustManifestEntry> {
  const rows = await publishedArticles(input.prisma, input.teamId, "TRUST_CENTER");
  const subprocessorCount = await input.prisma.subprocessor
    .count({ where: { teamId: input.teamId, state: "ACTIVE" } })
    .catch(() => 0);
  return {
    schemaVersion: "PROOVRA_TRUST_MANIFEST_V1",
    generatedAtUtc: new Date().toISOString(),
    trustArticles: rows.map((r) => ({
      section: r.section,
      slug: r.slug,
      title: r.title ?? "",
      version: r.version ?? 1,
      publishedAtUtc: iso(r.publishedAtUtc),
    })),
    activeSubprocessorCount: subprocessorCount,
  };
}

export async function buildGovernanceManifestEntry(input: {
  prisma: ManifestPrisma;
  teamId: string;
}): Promise<GovernanceManifestEntry> {
  const { prisma, teamId } = input;
  const policyRows = (await prisma.governancePolicy
    .findMany({
      where: { teamId },
      select: { kind: true, state: true },
      take: TRUST_MANIFEST_MAX_ROWS,
    })
    .catch(() => [])) as Array<{ kind: string; state: string }>;
  const policiesPerKind = {} as Record<GovernancePolicyKind, number>;
  for (const k of GOVERNANCE_POLICY_KINDS) policiesPerKind[k] = 0;
  let policiesActive = 0;
  for (const p of policyRows) {
    policiesPerKind[p.kind as GovernancePolicyKind] =
      (policiesPerKind[p.kind as GovernancePolicyKind] ?? 0) + 1;
    if (p.state === "ACTIVE") policiesActive += 1;
  }
  const accessReviewCampaignCount = await prisma.accessReviewCampaign
    .count({ where: { teamId } })
    .catch(() => 0);
  // Members audit DOM-09 — live member delegated scopes.
  const delegatedAdminActiveGrants = await prisma.memberDelegatedAdminScope
    .count({
      where: {
        teamId,
        revokedAtUtc: null,
        OR: [{ expiresAtUtc: null }, { expiresAtUtc: { gt: new Date() } }],
      },
    })
    .catch(() => 0);
  const crossOrgActive = await prisma.crossOrgReviewGrant
    .count({ where: { teamId, state: "ACCEPTED" } })
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

export async function buildMethodologyManifestEntry(input: {
  prisma: ManifestPrisma;
  teamId: string;
}): Promise<MethodologyManifestEntry> {
  const rows = await publishedArticles(input.prisma, input.teamId, "METHODOLOGY");
  return {
    schemaVersion: "PROOVRA_METHODOLOGY_MANIFEST_V1",
    generatedAtUtc: new Date().toISOString(),
    sections: rows.map((r) => ({
      section: r.section as MethodologySection,
      slug: r.slug,
      version: r.version ?? 1,
      publishedAtUtc: iso(r.publishedAtUtc),
    })),
  };
}

export async function buildAiDisclosureManifestEntry(input: {
  prisma: ManifestPrisma;
  teamId: string;
}): Promise<AiDisclosureManifestEntry> {
  const rows = await publishedArticles(input.prisma, input.teamId, "AI_DISCLOSURE");
  return {
    schemaVersion: "PROOVRA_AI_DISCLOSURE_MANIFEST_V1",
    generatedAtUtc: new Date().toISOString(),
    sections: rows.map((r) => ({
      section: r.section as AiDisclosureSection,
      slug: r.slug,
      version: r.version ?? 1,
      publishedAtUtc: iso(r.publishedAtUtc),
    })),
  };
}

export async function buildSubprocessorManifestEntry(input: {
  prisma: ManifestPrisma;
  teamId: string;
}): Promise<SubprocessorManifestEntry> {
  const rows = (await input.prisma.subprocessor
    .findMany({
      where: { teamId: input.teamId, state: "ACTIVE" },
      select: {
        slug: true,
        name: true,
        vendor: true,
        region: true,
        purpose: true,
        dataCategories: true,
        state: true,
        version: true,
        effectiveAtUtc: true,
      },
      orderBy: [{ name: "asc" }, { slug: "asc" }],
      take: TRUST_MANIFEST_MAX_ROWS,
    })
    .catch(() => [])) as Array<{
    slug: string | null;
    name: string;
    vendor: string | null;
    region: string | null;
    purpose: string | null;
    dataCategories: unknown;
    state: string;
    version: number | null;
    effectiveAtUtc: Date | null;
  }>;
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
        ? (r.dataCategories as ReadonlyArray<SubprocessorDataCategory>)
        : [],
      state: r.state as SubprocessorState,
      version: r.version ?? 1,
      effectiveAtUtc: iso(r.effectiveAtUtc) ?? "",
    })),
  };
}

export const TRUST_VERIFICATION_MANIFEST_PATHS = {
  trust: "intelligence/trust-manifest.json",
  governance: "intelligence/governance-manifest.json",
  methodology: "intelligence/methodology-manifest.json",
  "ai-disclosure": "intelligence/ai-disclosure-manifest.json",
  subprocessor: "intelligence/subprocessor-manifest.json",
} as const;

export type TrustVerificationManifestKind = keyof typeof TRUST_VERIFICATION_MANIFEST_PATHS;

/**
 * Every manifest of one workspace, as the package carries them. A family whose
 * builder throws is omitted (advisory), never filled from another workspace.
 */
export async function buildTrustVerificationManifests(input: {
  prisma: ManifestPrisma;
  teamId: string;
}): Promise<ReadonlyArray<{ path: string; json: unknown }>> {
  const builders: Array<[TrustVerificationManifestKind, () => Promise<unknown>]> = [
    ["trust", () => buildTrustManifestEntry(input)],
    ["governance", () => buildGovernanceManifestEntry(input)],
    ["methodology", () => buildMethodologyManifestEntry(input)],
    ["ai-disclosure", () => buildAiDisclosureManifestEntry(input)],
    ["subprocessor", () => buildSubprocessorManifestEntry(input)],
  ];
  const out: Array<{ path: string; json: unknown }> = [];
  for (const [kind, build] of builders) {
    try {
      out.push({ path: TRUST_VERIFICATION_MANIFEST_PATHS[kind], json: await build() });
    } catch {
      // advisory — never fail package generation
    }
  }
  return out;
}
