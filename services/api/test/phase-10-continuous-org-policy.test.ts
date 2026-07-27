/**
 * PHASE 10 §1 — CONTINUOUS organization-context policy enforcement.
 *
 * `evaluateOrgContextForSession` is the ONE canonical composition wired into
 * the authenticated hot path (`requireAuth`) so mandatory-SSO (org-bound) + org
 * lifecycle + session policy are re-evaluated on EVERY request operating in an
 * ORGANIZATION workspace — not only at the switch-workspace seam. Runs against
 * the REAL service (real evaluateOrgLoginMethod / evaluateSessionAgainstPolicy /
 * resolveSecurityPolicy) with an in-memory prisma stub. Every negative class
 * asserts a denial with ZERO mutation (the function only reads).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateOrgContextForSession } from "../src/services/identity/org-security-policy.service.js";

type Team = { isPersonal: boolean; organizationId: string | null; organization: { status: string } | null };
type Policy = { ssoRequired: boolean; maxSessionAgeSeconds: number | null; allowedAuthMethods: string[] };

function stub(opts: {
  team: Team | null;
  policy?: Policy;
  managed?: boolean;
  managingOrgId?: string | null;
  conn?: { status: string; orgId: string } | null;
}) {
  const writes: string[] = [];
  const policy = opts.policy ?? { ssoRequired: false, maxSessionAgeSeconds: null, allowedAuthMethods: [] };
  const prisma = {
    team: {
      // Inject CUSTOMER kind so resolveSecurityPolicy routes to the org policy
      // (SYSTEM/no-org → NOT_APPLICABLE default, tested via the personal cases).
      findUnique: async () =>
        opts.team && opts.team.organization
          ? { ...opts.team, organization: { ...opts.team.organization, kind: "CUSTOMER" } }
          : opts.team,
    },
    user: {
      findUnique: async () => ({
        identityMode: opts.managed ? "MANAGED_ENTERPRISE" : "STANDARD",
        managingOrganizationId: opts.managed ? (opts.managingOrgId ?? "org-1") : null,
        managedIdentitySource: opts.managed ? "SAML" : null,
        managedBySsoConnectionId: null,
      }),
      update: async () => { writes.push("user.update"); return {}; },
    },
    organizationSecurityPolicy: {
      findUnique: async () => ({
        teamId: "ws", policyVersion: 1, ssoRequired: policy.ssoRequired,
        managedIdentityRequired: false, noPersonalSpace: false, securityMode: "STANDARD",
        maxSessionAgeSeconds: policy.maxSessionAgeSeconds, idleTimeoutSeconds: null,
        concurrentSessionLimit: null, stepUpIntervalSeconds: null, allowedAuthMethods: policy.allowedAuthMethods,
      }),
    },
    ssoConnection: {
      findUnique: async () => (opts.conn ? { status: opts.conn.status, team: { organizationId: opts.conn.orgId } } : null),
    },
  } as never;
  return { prisma, writes };
}

const NOW = 1_700_000_000_000;
const base = { userId: "u1", teamId: "ws", authAtMs: NOW - 60_000, lastSeenAtMs: NOW, nowMs: NOW };

describe("§1 — personal / owned workspaces are exempt", () => {
  it("a PERSONAL workspace is allowed (no org policy applies)", async () => {
    const { prisma } = stub({ team: { isPersonal: true, organizationId: null, organization: null } });
    const d = await evaluateOrgContextForSession({ ...base, method: "PASSWORD" }, prisma);
    expect(d.allowed).toBe(true);
  });
  it("an OWNED (org-less) workspace is allowed", async () => {
    const { prisma } = stub({ team: { isPersonal: false, organizationId: null, organization: null } });
    const d = await evaluateOrgContextForSession({ ...base, method: "PASSWORD" }, prisma);
    expect(d.allowed).toBe(true);
  });
});

describe("§1 — fail closed on missing / ambiguous context", () => {
  it("unknown workspace → denied (workspace_not_found), zero mutation", async () => {
    const { prisma, writes } = stub({ team: null });
    const d = await evaluateOrgContextForSession({ ...base, method: "PASSWORD" }, prisma);
    expect(d.allowed).toBe(false);
    expect((d as { reason?: string }).reason).toBe("workspace_not_found");
    expect(writes).toEqual([]);
  });
  it("suspended Organization → denied (organization_suspended)", async () => {
    const { prisma } = stub({ team: { isPersonal: false, organizationId: "org-1", organization: { status: "SUSPENDED" } } });
    const d = await evaluateOrgContextForSession({ ...base, method: "PASSWORD" }, prisma);
    expect(d.allowed).toBe(false);
    expect((d as { reason?: string }).reason).toBe("organization_suspended");
  });
});

describe("§1 — mandatory SSO re-evaluated continuously", () => {
  it("managed PASSWORD user in an ssoRequired Org → denied", async () => {
    const { prisma, writes } = stub({
      team: { isPersonal: false, organizationId: "org-1", organization: { status: "ACTIVE" } },
      policy: { ssoRequired: true, maxSessionAgeSeconds: null, allowedAuthMethods: [] },
      managed: true, managingOrgId: "org-1",
    });
    const d = await evaluateOrgContextForSession({ ...base, method: "PASSWORD" }, prisma);
    expect(d.allowed).toBe(false);
    expect(writes).toEqual([]);
  });
  it("Org-A SSO connection cannot satisfy Org-B (cross-org) → denied", async () => {
    const { prisma } = stub({
      team: { isPersonal: false, organizationId: "org-1", organization: { status: "ACTIVE" } },
      policy: { ssoRequired: true, maxSessionAgeSeconds: null, allowedAuthMethods: [] },
      managed: true, managingOrgId: "org-1",
      conn: { status: "ACTIVE", orgId: "org-2" }, // connection belongs to a different org
    });
    const d = await evaluateOrgContextForSession({ ...base, method: "SSO", ssoConnId: "conn-A" }, prisma);
    expect(d.allowed).toBe(false);
    expect((d as { reason?: string }).reason).toBe("sso_connection_wrong_organization");
  });
  it("valid org-bound SAML session → allowed", async () => {
    const { prisma } = stub({
      team: { isPersonal: false, organizationId: "org-1", organization: { status: "ACTIVE" } },
      policy: { ssoRequired: true, maxSessionAgeSeconds: null, allowedAuthMethods: [] },
      managed: true, managingOrgId: "org-1",
      conn: { status: "ACTIVE", orgId: "org-1" },
    });
    const d = await evaluateOrgContextForSession({ ...base, method: "SSO", ssoConnId: "conn-A" }, prisma);
    expect(d.allowed).toBe(true);
  });
});

describe("§1 — session age re-evaluated continuously", () => {
  it("a session older than max-age → denied", async () => {
    const { prisma } = stub({
      team: { isPersonal: false, organizationId: "org-1", organization: { status: "ACTIVE" } },
      policy: { ssoRequired: false, maxSessionAgeSeconds: 3600, allowedAuthMethods: [] },
    });
    const old = { ...base, authAtMs: NOW - 2 * 3600 * 1000 };
    const d = await evaluateOrgContextForSession({ ...old, method: "PASSWORD" }, prisma);
    expect(d.allowed).toBe(false);
  });
});

describe("§1 — middleware wires the gate + fails closed", () => {
  const MW = readFileSync(resolve(__dirname, "../src/middleware/auth.ts"), "utf8");
  it("requireAuth calls evaluateOrgContextForSession and 401s on denial", () => {
    expect(MW).toMatch(/evaluateOrgContextForSession\(/);
    expect(MW).toMatch(/auth\.org_context_policy_denied/);
    expect(MW).toMatch(/reason:\s*["']reauthentication_required["']/);
  });
});
