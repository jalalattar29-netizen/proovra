/**
 * PRO-G2-01 (RG-20) — the verification package's trust / methodology /
 * AI-disclosure / subprocessor manifests are workspace-anchored.
 *
 * The fake store below answers each query the way Postgres would: it applies
 * every predicate in the `where` it is given. A builder that forgets the
 * workspace predicate therefore reads the other tenant's rows, exactly as the
 * production query did.
 */
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { buildTrustAndGovernanceManifests } from "../src/verification-package-trust-and-governance.js";

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR" || k === "AND") continue;
    if (v !== null && typeof v === "object" && !(v instanceof Date)) continue;
    if (row[k] !== v) return false;
  }
  return true;
}

function table(rows: Row[], seen: Row[]) {
  return {
    findMany: async (args: { where?: Row; take?: number } = {}) => {
      seen.push(args.where ?? {});
      const out = rows.filter((r) => matches(r, args.where));
      return typeof args.take === "number" ? out.slice(0, args.take) : out;
    },
    count: async (args: { where?: Row } = {}) => {
      seen.push(args.where ?? {});
      return rows.filter((r) => matches(r, args.where)).length;
    },
  };
}

function article(teamId: string, kind: string, slug: string, title: string): Row {
  return {
    teamId,
    kind,
    section: "general",
    slug,
    title,
    state: "PUBLISHED",
    version: 1,
    publishedAtUtc: new Date("2026-01-01T00:00:00Z"),
  };
}

function subprocessor(teamId: string, name: string): Row {
  return {
    id: `${teamId}-${name}`,
    teamId,
    name,
    slug: name.toLowerCase(),
    vendor: name,
    region: "EU",
    purpose: "hosting",
    dataCategories: [],
    category: "PROVIDER",
    country: "DE",
    state: "ACTIVE",
    version: 1,
    effectiveAtUtc: new Date("2026-01-01T00:00:00Z"),
  };
}

function fakePrisma(seen: Row[]): PrismaClient {
  const articles = [
    article("team-a", "TRUST_CENTER", "a-canary", "A-canary"),
    article("team-a", "METHODOLOGY", "a-method", "A-method"),
    article("team-a", "AI_DISCLOSURE", "a-ai", "A-ai"),
    article("team-b", "TRUST_CENTER", "b-own", "B-own"),
    article("team-b", "METHODOLOGY", "b-method", "B-method"),
    article("team-b", "AI_DISCLOSURE", "b-ai", "B-ai"),
  ];
  const subs = [subprocessor("team-a", "AcmeSecretVendor"), subprocessor("team-b", "BVendor")];
  return {
    trustCenterArticle: table(articles, seen),
    subprocessor: table(subs, seen),
    governancePolicy: table([], seen),
    accessReviewCampaign: table([], seen),
    memberDelegatedAdminScope: table([], seen),
    crossOrgReviewGrant: table([], seen),
  } as unknown as PrismaClient;
}

describe("verification package trust manifests — tenant isolation (PRO-G2-01)", () => {
  it("workspace B's package carries only workspace B's articles and subprocessors", async () => {
    const seen: Row[] = [];
    const entries = await buildTrustAndGovernanceManifests({
      prisma: fakePrisma(seen),
      teamId: "team-b",
    });
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("A-canary");
    expect(serialized).not.toContain("a-method");
    expect(serialized).not.toContain("a-ai");
    expect(serialized).not.toContain("AcmeSecretVendor");
    expect(serialized).toContain("B-own");
    expect(serialized).toContain("b-method");
    expect(serialized).toContain("b-ai");
    expect(serialized).toContain("BVendor");

    const trust = entries.find((e) => e.path === "intelligence/trust-manifest.json")?.json as {
      activeSubprocessorCount: number;
    };
    expect(trust.activeSubprocessorCount).toBe(1);

    // Every read the builder made carried the workspace predicate.
    for (const where of seen) expect(where.teamId).toBe("team-b");
  });

  it("emits the same five manifest paths as the API preview", async () => {
    const entries = await buildTrustAndGovernanceManifests({
      prisma: fakePrisma([]),
      teamId: "team-b",
    });
    expect(entries.map((e) => e.path).sort()).toEqual([
      "intelligence/ai-disclosure-manifest.json",
      "intelligence/governance-manifest.json",
      "intelligence/methodology-manifest.json",
      "intelligence/subprocessor-manifest.json",
      "intelligence/trust-manifest.json",
    ]);
  });
});
