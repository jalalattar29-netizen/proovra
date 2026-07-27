/**
 * PHASE 10 §policy-convergence — OrganizationSecurityPolicy is ORGANIZATION-
 * scoped. `resolveOrgSecurityPolicy(organizationId)` is the ONE authority;
 * `resolveSecurityPolicy(teamId)` is a zero-decision compatibility projection
 * (workspace → parent org → org policy). Two workspaces of the same Organization
 * therefore always resolve the SAME policy; a workspace cannot redefine it.
 * Personal/OWNED workspaces (no parent org) get the default posture.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveOrgSecurityPolicy,
  resolveOrganizationPolicy,
} from "../src/services/identity/org-security-policy.service.js";

// Helper: the ORGANIZATION policy or throw (tests that expect an org policy).
async function orgPolicyOf(teamId: string, prisma: never) {
  const r = await resolveOrganizationPolicy(teamId, prisma);
  if (r.applicability !== "ORGANIZATION") throw new Error(`expected ORGANIZATION, got ${r.applicability}`);
  return r.policy;
}

const API = resolve(__dirname, "..");

/** Stub: workspaces → org map + the ONE org policy row. */
function stub(opts: {
  teamOrg: Record<string, string | null>;
  orgPolicy: Record<string, { concurrentSessionLimit?: number | null; ssoRequired?: boolean }>;
}) {
  const reads: string[] = [];
  const prisma = {
    team: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        reads.push(`team:${where.id}`);
        const org = opts.teamOrg[where.id] ?? null;
        // CUSTOMER org so resolution routes to the org policy; null org = personal/owned.
        return { organizationId: org, isPersonal: false, organization: org ? { kind: "CUSTOMER" } : null };
      },
    },
    organizationSecurityPolicy: {
      findUnique: async ({ where }: { where: { organizationId: string } }) => {
        reads.push(`policy:org:${where.organizationId}`);
        const p = opts.orgPolicy[where.organizationId];
        return p ? { organizationId: where.organizationId, ...p } : null;
      },
    },
  } as never;
  return { prisma, reads };
}

describe("§policy-convergence — one Organization policy, shared by its workspaces", () => {
  it("two workspaces in the SAME org resolve the SAME policy", async () => {
    const { prisma } = stub({
      teamOrg: { "ws-1": "org-A", "ws-2": "org-A" },
      orgPolicy: { "org-A": { concurrentSessionLimit: 3, ssoRequired: true } },
    });
    const p1 = await orgPolicyOf("ws-1", prisma);
    const p2 = await orgPolicyOf("ws-2", prisma);
    expect(p1.concurrentSessionLimit).toBe(3);
    expect(p1.ssoRequired).toBe(true);
    expect(p2).toEqual(p1); // identical — a workspace cannot redefine org policy
  });

  it("resolveOrganizationPolicy reads the org policy by organizationId (projection)", async () => {
    const { prisma, reads } = stub({
      teamOrg: { "ws-1": "org-A" },
      orgPolicy: { "org-A": { concurrentSessionLimit: 1 } },
    });
    await resolveOrganizationPolicy("ws-1", prisma);
    // The DECISION row is keyed by organizationId, not teamId.
    expect(reads).toContain("policy:org:org-A");
    expect(reads.some((r) => r.startsWith("policy:team"))).toBe(false);
  });

  it("Org-A and Org-B are isolated (different policies)", async () => {
    const { prisma } = stub({
      teamOrg: { "ws-a": "org-A", "ws-b": "org-B" },
      orgPolicy: { "org-A": { concurrentSessionLimit: 2 }, "org-B": { concurrentSessionLimit: 9 } },
    });
    expect((await orgPolicyOf("ws-a", prisma)).concurrentSessionLimit).toBe(2);
    expect((await orgPolicyOf("ws-b", prisma)).concurrentSessionLimit).toBe(9);
  });

  it("a Personal/OWNED workspace (no parent org) → NOT_APPLICABLE (no fabricated policy fields)", async () => {
    const { prisma, reads } = stub({ teamOrg: { "ws-personal": null }, orgPolicy: {} });
    const r = await resolveOrganizationPolicy("ws-personal", prisma);
    expect(r.applicability).toBe("NOT_APPLICABLE");
    expect(r).not.toHaveProperty("policy");
    // No org policy lookup happens for a workspace with no parent org.
    expect(reads.some((rr) => rr.startsWith("policy:org"))).toBe(false);
  });

  it("resolveOrgSecurityPolicy is the canonical org-keyed authority", async () => {
    const { prisma } = stub({ teamOrg: {}, orgPolicy: { "org-A": { concurrentSessionLimit: 5 } } });
    const p = await resolveOrgSecurityPolicy("org-A", prisma);
    expect(p.organizationId).toBe("org-A");
    expect(p.concurrentSessionLimit).toBe(5);
  });
});

describe("§policy-convergence — machine metrics (source contracts)", () => {
  const SVC = readFileSync(resolve(API, "src/services/identity/org-security-policy.service.ts"), "utf8");
  const SCHEMA = readFileSync(resolve(API, "prisma/schema.prisma"), "utf8");

  it("the canonical org resolver reads the policy by organizationId", () => {
    expect(SVC).toMatch(/resolveOrgSecurityPolicy/);
    expect(SVC).toMatch(/organizationSecurityPolicy\.findUnique\(\{\s*where:\s*\{\s*organizationId\s*\}/);
  });

  it("the ONLY teamId adapter is zero-decision (organizationIdForPolicy); no teamId-keyed policy read", () => {
    expect(SVC).toMatch(/ZERO-DECISION/);
    expect(SVC).toMatch(/organizationIdForPolicy/);
    expect(SVC).not.toMatch(/organizationSecurityPolicy\.findUnique\(\{\s*where:\s*\{\s*teamId\s*\}/);
    expect(SVC).not.toMatch(/organizationSecurityPolicy\.findFirst\(\{\s*where:\s*\{\s*teamId/);
  });

  it("the schema makes organizationId the authoritative unique key + migration authored", () => {
    expect(SCHEMA).toMatch(/organizationId\s+String\?\s+@unique\s+@map\("organization_id"\)/);
    expect(() =>
      readFileSync(resolve(API, "prisma/migrations/20271005000000_org_security_policy_org_scoped/migration.sql"), "utf8"),
    ).not.toThrow();
  });

  it("the write path binds organizationId + rejects non-Customer-org workspaces", () => {
    expect(SVC).toMatch(/ORG_SECURITY_POLICY_NOT_APPLICABLE/);
    expect(SVC).toMatch(/kind\s*!==\s*"CUSTOMER"/);
  });
});
