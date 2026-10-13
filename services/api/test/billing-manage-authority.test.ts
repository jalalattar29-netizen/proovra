/**
 * ONE AUTHORITY FOR FINANCIAL COMMITMENTS — `billing.manage`.
 *
 * The canonical permission matrix (packages/shared/src/permissions.ts) makes
 * `billing.manage` OWNER-only, and every billing mutation route authorizes
 * through the PAYER's billing account (billing-accounts.service.ts). The
 * platform-context envelope used to grant BILLING_MANAGE to workspace ADMINs
 * as well — offering controls the API refuses — and to withhold it from the
 * Personal Space owner, who is the payer.
 *
 * Proves, per role (OWNER, ADMIN, MEMBER→REVIEWER, VIEWER):
 *   - the canonical permission result;
 *   - the envelope's BILLING_VIEW / BILLING_MANAGE / ORG_BILLING_MANAGE equal
 *     the canonical `billing.read` / `billing.manage`, and
 *     INTELLIGENCE_POLICY_MANAGE equals `intelligence.policy.manage`;
 *   - billing.read and billing.manage are never conflated;
 *   - Personal Space ownership resolves as the payer (OWNER), and team
 *     ownership resolves by the membership role, not by administration;
 *   - the registry derives these keys from the canonical helper rather than
 *     a role list of its own.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { roleHasPermission } from "@proovra/shared";

import { resolveCapabilities } from "../src/services/platform-context/capability-registry.js";

const ROLES = ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const;

/** The intended rule, stated once. */
const EXPECTED = {
  OWNER: { read: true, manage: true, intelligence: true },
  ADMIN: { read: true, manage: false, intelligence: true },
  MEMBER: { read: true, manage: false, intelligence: false },
  VIEWER: { read: false, manage: false, intelligence: false },
} as const;

function teamCaps(role: (typeof ROLES)[number], workspaceKind: "OWNED" | "ORGANIZATION") {
  return resolveCapabilities({
    scope: "TEAM",
    workspaceKind,
    role,
    plan: "TEAM",
    isPlatformAdmin: false,
    memberCount: 4,
  });
}

describe("billing.manage — the canonical permission", () => {
  for (const role of ROLES) {
    it(`${role}: billing.read=${EXPECTED[role].read}, billing.manage=${EXPECTED[role].manage}`, () => {
      expect(roleHasPermission(role, "billing.read")).toBe(EXPECTED[role].read);
      expect(roleHasPermission(role, "billing.manage")).toBe(EXPECTED[role].manage);
      expect(roleHasPermission(role, "intelligence.policy.manage")).toBe(EXPECTED[role].intelligence);
    });
  }
});

describe("the envelope agrees with the canonical permission", () => {
  for (const kind of ["OWNED", "ORGANIZATION"] as const) {
    for (const role of ROLES) {
      it(`${kind} workspace, ${role}`, () => {
        const c = teamCaps(role, kind);
        expect(c.BILLING_VIEW).toBe(EXPECTED[role].read);
        expect(c.BILLING_MANAGE).toBe(EXPECTED[role].manage);
        expect(c.ORG_BILLING_MANAGE).toBe(EXPECTED[role].manage);
        expect(c.INTELLIGENCE_POLICY_MANAGE).toBe(EXPECTED[role].intelligence);
      });
    }
  }

  it("a workspace ADMIN keeps read access and its own admin tier, but no financial control", () => {
    const admin = teamCaps("ADMIN", "OWNED");
    expect(admin.BILLING_VIEW).toBe(true);
    expect(admin.BILLING_MANAGE).toBe(false);
    // Unrelated admin authority is untouched.
    expect(admin.TEAM_MANAGE).toBe(true);
    expect(admin.SETTINGS_MANAGE).toBe(true);
  });

  it("billing.read never implies billing.manage", () => {
    for (const role of ROLES) {
      const c = teamCaps(role, "OWNED");
      if (c.BILLING_MANAGE) expect(c.BILLING_VIEW, role).toBe(true);
      if (role !== "OWNER") expect(c.BILLING_MANAGE, role).toBe(false);
    }
  });
});

describe("ownership resolves to the payer", () => {
  it("the Personal Space owner is the payer: BILLING_VIEW and BILLING_MANAGE", () => {
    const c = resolveCapabilities({
      scope: "PERSONAL",
      workspaceKind: "PERSONAL",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
      memberCount: 1,
    });
    expect(c.BILLING_VIEW).toBe(true);
    expect(c.BILLING_MANAGE).toBe(true);
    // A Personal Space is not an organization: no org-tier billing key.
    expect(c.ORG_BILLING_MANAGE).toBe(false);
  });

  it("no workspace selected: account-tier billing view only, no workspace billing control", () => {
    const c = resolveCapabilities({ scope: null, role: null, plan: null, isPlatformAdmin: false });
    expect(c.ACCOUNT_BILLING_VIEW).toBe(true);
    expect(c.BILLING_MANAGE).toBe(false);
  });

  it("an unprovable workspace kind fails closed", () => {
    const c = resolveCapabilities({
      scope: "TEAM",
      workspaceKind: "UNKNOWN",
      role: "OWNER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    expect(c.BILLING_MANAGE).toBe(false);
  });

  it("platform administration grants no tenant billing control", () => {
    const c = resolveCapabilities({
      scope: "TEAM",
      workspaceKind: "OWNED",
      role: "VIEWER",
      plan: "TEAM",
      isPlatformAdmin: true,
    });
    expect(c.BILLING_MANAGE).toBe(false);
  });
});

describe("the registry derives these keys from the canonical helper", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/services/platform-context/capability-registry.ts", import.meta.url)),
    "utf8",
  );
  it("no role list grants BILLING_MANAGE or BILLING_VIEW by hand", () => {
    expect(src).not.toMatch(/"BILLING_MANAGE",/);
    expect(src).not.toMatch(/"BILLING_VIEW",/);
    expect(src).not.toMatch(/BILLING_MANAGE\s*=\s*true/);
  });
  it("each key is the canonical permission for the viewer's role", () => {
    expect(src).toContain('map.BILLING_VIEW = roleHasPermission(role, "billing.read")');
    expect(src).toContain('map.BILLING_MANAGE = roleHasPermission(role, "billing.manage")');
    expect(src).toContain('map.INTELLIGENCE_POLICY_MANAGE = roleHasPermission(role, "intelligence.policy.manage")');
  });
});
