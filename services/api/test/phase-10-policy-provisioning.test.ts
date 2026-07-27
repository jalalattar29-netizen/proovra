/**
 * PHASE 10 §3 — NO DEFAULT ORGANIZATION POLICY for non-org or missing rows.
 *
 * Personal/OWNED/SYSTEM → NOT_APPLICABLE (default posture; never a governed
 * decision). A CUSTOMER Organization with a MISSING policy → FAILS CLOSED
 * (`POLICY_NOT_PROVISIONED`) — no synthesized allow-oriented default. Enterprise
 * provisioning creates the explicit baseline policy transactionally.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveOrgSecurityPolicy,
  resolveOrganizationPolicy,
} from "../src/services/identity/org-security-policy.service.js";

const API = resolve(__dirname, "..");

/** Stub: team→(org, kind) map + org policy rows. */
function stub(opts: {
  teams: Record<string, { organizationId: string | null; kind: string | null }>;
  policies: Record<string, { ssoRequired?: boolean; concurrentSessionLimit?: number | null }>;
}) {
  const prisma = {
    team: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const t = opts.teams[where.id];
        if (!t) return null;
        return { organizationId: t.organizationId, isPersonal: false, organization: t.kind ? { kind: t.kind } : null };
      },
    },
    organizationSecurityPolicy: {
      findUnique: async ({ where }: { where: { organizationId: string } }) => opts.policies[where.organizationId] ?? null,
    },
  } as never;
  return { prisma };
}

describe("§3 — NOT_APPLICABLE for Personal / OWNED / SYSTEM (no fabricated policy fields)", () => {
  it("Personal workspace (no parent org) → NOT_APPLICABLE PERSONAL, no throw, no policy", async () => {
    const { prisma } = stub({ teams: { "ws-personal": { organizationId: null, kind: null } }, policies: {} });
    const r = await resolveOrganizationPolicy("ws-personal", prisma);
    expect(r.applicability).toBe("NOT_APPLICABLE");
    expect(r).not.toHaveProperty("policy");
  });

  it("OWNED / SYSTEM-org workspace → NOT_APPLICABLE (not governed by Customer policy)", async () => {
    const { prisma } = stub({ teams: { "ws-owned": { organizationId: "sys-org", kind: "SYSTEM" } }, policies: {} });
    const r = await resolveOrganizationPolicy("ws-owned", prisma);
    expect(r.applicability).toBe("NOT_APPLICABLE");
    if (r.applicability === "NOT_APPLICABLE") expect(r.reason).toBe("SYSTEM");
  });
});

describe("§3 — CUSTOMER Organization policy is REQUIRED (fail closed on missing)", () => {
  it("CUSTOMER workspace with a provisioned policy → ORGANIZATION + the persisted policy", async () => {
    const { prisma } = stub({
      teams: { "ws-cust": { organizationId: "org-A", kind: "CUSTOMER" } },
      policies: { "org-A": { ssoRequired: true, concurrentSessionLimit: 3 } },
    });
    const r = await resolveOrganizationPolicy("ws-cust", prisma);
    expect(r.applicability).toBe("ORGANIZATION");
    if (r.applicability === "ORGANIZATION") {
      expect(r.policy.ssoRequired).toBe(true);
      expect(r.policy.concurrentSessionLimit).toBe(3);
    }
  });

  it("CUSTOMER workspace with a MISSING policy → FAILS CLOSED (POLICY_NOT_PROVISIONED)", async () => {
    const { prisma } = stub({ teams: { "ws-cust": { organizationId: "org-A", kind: "CUSTOMER" } }, policies: {} });
    await expect(resolveOrganizationPolicy("ws-cust", prisma)).rejects.toMatchObject({ code: "POLICY_NOT_PROVISIONED", statusCode: 503 });
  });

  it("resolveOrgSecurityPolicy fails closed on a missing CUSTOMER policy (no synthesized default)", async () => {
    const { prisma } = stub({ teams: {}, policies: {} });
    await expect(resolveOrgSecurityPolicy("org-A", prisma)).rejects.toMatchObject({ code: "POLICY_NOT_PROVISIONED" });
  });
});

describe("§3 — provisioning creates the explicit baseline + no read-time synthesis (source contracts)", () => {
  it("enterprise provisioning creates the baseline OrganizationSecurityPolicy in the tx", () => {
    const src = readFileSync(resolve(API, "src/services/enterprise-provisioning.service.ts"), "utf8");
    expect(src).toMatch(/organizationSecurityPolicy\.create/);
    // Created inside the provisioning $transaction (same tx as org.create).
    expect(src).toMatch(/organizationId:\s*org\.id/);
  });

  it("the resolver NEVER synthesizes an allow-oriented default for a missing CUSTOMER policy", () => {
    const src = readFileSync(resolve(API, "src/services/identity/org-security-policy.service.ts"), "utf8");
    // resolveOrgSecurityPolicy throws on a null row rather than coercing a default.
    expect(src).toMatch(/if \(!row\) \{\s*throw policyNotProvisioned/);
    // No request-time auto-create fallback in the resolver.
    expect(src).not.toMatch(/organizationSecurityPolicy\.create[\s\S]{0,80}resolveOrgSecurityPolicy/);
  });
});
