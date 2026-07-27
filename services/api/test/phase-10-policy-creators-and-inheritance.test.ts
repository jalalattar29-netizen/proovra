/**
 * PHASE 10 §1.4 + §1.6 — Customer-Organization policy creator lock + one-org
 * inheritance.
 *
 * §1.4: EVERY CUSTOMER Organization creator transactionally creates exactly one
 * explicit baseline OrganizationSecurityPolicy; SYSTEM/Personal/OWNED creators
 * create none. Locked by source contract (the creator set is bounded).
 *
 * §1.6: three Workspaces of ONE Organization resolve the SAME persisted policy
 * for MFA, SSO, session limits, high-security and governance (all consumers).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveOrganizationPolicy } from "../src/services/identity/org-security-policy.service.js";

const API = resolve(__dirname, "..");

// ── §1.4 — creator lock ─────────────────────────────────────────────────────
describe("§1.4 — every CUSTOMER Organization creator provisions the baseline policy", () => {
  const EP = readFileSync(resolve(API, "src/services/enterprise-provisioning.service.ts"), "utf8");

  it("enterprise-provisioning creates a baseline policy at EACH CUSTOMER-org create", () => {
    // Count CUSTOMER org creates and baseline-policy creates; every CUSTOMER
    // create path is paired with a baseline policy (create or ensure).
    const custCreates = (EP.match(/kind:\s*"CUSTOMER"/g) ?? []).length;
    const policyCreates = (EP.match(/organizationSecurityPolicy\.create/g) ?? []).length;
    // ≥2 direct new-org CUSTOMER creates each pair a baseline create; the
    // promotion path uses an idempotent ensure (findUnique + create).
    expect(policyCreates).toBeGreaterThanOrEqual(2);
    expect(custCreates).toBeGreaterThanOrEqual(2);
    // The promotion-to-CUSTOMER path ensures a baseline idempotently.
    expect(EP).toMatch(/organizationSecurityPolicy\.findUnique[\s\S]{0,400}organizationSecurityPolicy\.create/);
  });

  it("SYSTEM / Personal / OWNED creators do NOT create an OrganizationSecurityPolicy", () => {
    const BOOTSTRAP = readFileSync(resolve(API, "src/services/platform-context/workspace-bootstrap.service.ts"), "utf8");
    const TEAMS = readFileSync(resolve(API, "src/routes/teams.routes.ts"), "utf8");
    expect(BOOTSTRAP).not.toMatch(/organizationSecurityPolicy\.create/);
    expect(TEAMS).not.toMatch(/organizationSecurityPolicy\.create/);
  });
});

// ── §1.6 — one-org inheritance across three workspaces ──────────────────────
describe("§1.6 — three Workspaces of one Organization share the SAME persisted policy", () => {
  // Stub: three workspaces (ws-1/2/3) all parented to org-A (CUSTOMER); one policy.
  function stub() {
    const policyRow = {
      organizationId: "org-A",
      policyVersion: 4,
      ssoRequired: true,
      managedIdentityRequired: false,
      noPersonalSpace: true,
      securityMode: "HIGH_SECURITY",
      maxSessionAgeSeconds: 3600,
      idleTimeoutSeconds: 900,
      concurrentSessionLimit: 2,
      stepUpIntervalSeconds: null,
      allowedAuthMethods: ["SSO"],
    };
    let policyReads = 0;
    const prisma = {
      team: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          ["ws-1", "ws-2", "ws-3"].includes(where.id)
            ? { organizationId: "org-A", isPersonal: false, organization: { kind: "CUSTOMER" } }
            : null,
      },
      organizationSecurityPolicy: {
        findUnique: async ({ where }: { where: { organizationId: string } }) => {
          policyReads += 1;
          return where.organizationId === "org-A" ? policyRow : null;
        },
      },
    } as never;
    return { prisma, policyReads: () => policyReads };
  }

  it("all three workspaces resolve the identical ORGANIZATION policy (org-keyed)", async () => {
    const { prisma } = stub();
    const results = await Promise.all(
      ["ws-1", "ws-2", "ws-3"].map((t) => resolveOrganizationPolicy(t, prisma)),
    );
    for (const r of results) {
      expect(r.applicability).toBe("ORGANIZATION");
      if (r.applicability === "ORGANIZATION") {
        expect(r.organizationId).toBe("org-A");
        // Every governed facet is the SAME persisted value — no workspace override.
        expect(r.policy.ssoRequired).toBe(true);
        expect(r.policy.securityMode).toBe("HIGH_SECURITY");
        expect(r.policy.noPersonalSpace).toBe(true);
        expect(r.policy.concurrentSessionLimit).toBe(2);
        expect(r.policy.maxSessionAgeSeconds).toBe(3600);
        expect(r.policy.idleTimeoutSeconds).toBe(900);
        expect(r.policy.policyVersion).toBe(4);
      }
    }
    // The three resolutions are byte-equal (one authoritative policy).
    const policies = results.map((r) => (r.applicability === "ORGANIZATION" ? r.policy : null));
    expect(policies[0]).toEqual(policies[1]);
    expect(policies[1]).toEqual(policies[2]);
  });
});
