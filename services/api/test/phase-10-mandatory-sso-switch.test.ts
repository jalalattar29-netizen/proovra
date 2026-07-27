/**
 * PHASE 10 §10.2/§10.7 — PRODUCTION-PATH test of mandatory-SSO + session
 * policy at the org-context establishment seam (real
 * POST /v1/platform/context/switch-workspace). The REAL canonical gates
 * (`evaluateOrgLoginMethod`/`evaluateSessionAgainstPolicy` →
 * `resolveSecurityPolicy` + `isManagedEnterprise`) run; only the db and auth
 * transport are substituted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const H = vi.hoisted(() => ({
  authMethod: "PASSWORD" as string,
  ssoConnId: null as string | null,
  iat: Math.floor(Date.now() / 1000),
  policy: { ssoRequired: false, maxSessionAgeSeconds: null as number | null, allowedAuthMethods: [] as string[] },
  identityMode: "MANAGED_ENTERPRISE" as string,
  membershipStatus: "ACTIVE" as string,
  orgStatus: "ACTIVE" as string,
  // The SSO connection the session's ssoConnId resolves to.
  conn: { status: "ACTIVE" as string, orgId: "org-1" as string | null } as { status: string; orgId: string | null } | null,
  writes: [] as string[],
}));

vi.mock("../src/middleware/auth.js", () => ({
  // Faithful to the real requireAuth: it exposes the PRIMARY-authentication
  // time as `authAt` on req.user (the switch gate keys session age off authAt,
  // never token iat). H.iat is the mock's session-time proxy.
  requireAuth: async (req: { user?: unknown }) => { (req as { user: unknown }).user = { sub: "user-1", authMethod: H.authMethod, ssoConnId: H.ssoConnId, authAt: H.iat, iat: H.iat }; },
}));
vi.mock("../src/db.js", () => {
  const prisma = new Proxy({}, {
    get(_t, model: string) {
      if (String(model).startsWith("$")) return async () => 0;
      return new Proxy({}, {
        get(_t2, method: string) {
          return async () => {
            if (/^(update|create|upsert|delete)/.test(String(method))) H.writes.push(`${model}.${String(method)}`);
            if (model === "user" && method === "findUnique") return { currentWorkspaceId: null, id: "user-1", identityMode: H.identityMode, organizationId: "org-1", managingOrganizationId: H.identityMode === "MANAGED_ENTERPRISE" ? "org-1" : null, managedIdentitySource: H.identityMode === "MANAGED_ENTERPRISE" ? "SAML" : null, managedBySsoConnectionId: null };
            if (model === "teamMember" && method === "findUnique") return { status: H.membershipStatus };
            if (model === "team" && method === "findUnique") return { id: "ws-org", isPersonal: false, organizationId: "org-1", organization: { status: H.orgStatus, kind: "CUSTOMER" } };
            if (model === "ssoConnection" && method === "findUnique") return H.conn ? { status: H.conn.status, team: { organizationId: H.conn.orgId } } : null;
            if (model === "organizationSecurityPolicy" && method === "findUnique")
              return { teamId: "ws-org", policyVersion: 1, ssoRequired: H.policy.ssoRequired, managedIdentityRequired: false, noPersonalSpace: false, securityMode: "STANDARD", maxSessionAgeSeconds: H.policy.maxSessionAgeSeconds, idleTimeoutSeconds: null, concurrentSessionLimit: null, stepUpIntervalSeconds: null, allowedAuthMethods: H.policy.allowedAuthMethods };
            if (method === "findMany") return [];
            if (method === "count") return 0;
            return null;
          };
        },
      });
    },
  });
  return { prisma };
});

import { platformContextRoutes } from "../src/routes/platform-context.routes.js";

const WS = "33333333-3333-4333-8333-333333333333";
let app: FastifyInstance;
beforeEach(async () => {
  H.authMethod = "PASSWORD"; H.iat = Math.floor(Date.now() / 1000);
  H.policy = { ssoRequired: false, maxSessionAgeSeconds: null, allowedAuthMethods: [] };
  H.identityMode = "MANAGED_ENTERPRISE"; H.membershipStatus = "ACTIVE"; H.orgStatus = "ACTIVE"; H.writes.length = 0;
  H.ssoConnId = null; H.conn = { status: "ACTIVE", orgId: "org-1" };
  app = Fastify();
  await app.register(platformContextRoutes);
  await app.ready();
});
const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/v1/platform/context/switch-workspace", headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });

describe("§10.2 — mandatory SSO at org-context establishment (real gate)", () => {
  it("managed PASSWORD user CANNOT enter an SSO-required Org → 403, ZERO mutation, no existence leak", async () => {
    H.policy.ssoRequired = true; H.authMethod = "PASSWORD";
    const res = await post({ workspaceId: WS });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("workspace_membership_required"); // no org-existence leak
    expect(H.writes.filter((w) => w.startsWith("user.update"))).toEqual([]); // zero mutation
  });
  it("managed SAML session bound to THIS Org's ACTIVE connection CAN enter", async () => {
    H.policy.ssoRequired = true; H.authMethod = "SAML"; H.ssoConnId = "conn-A"; H.conn = { status: "ACTIVE", orgId: "org-1" };
    const res = await post({ workspaceId: WS });
    expect(res.statusCode).not.toBe(403);
    expect(H.writes).toContain("user.update");
  });
  it("§1 CROSS-ORG: Org-A SAML/OIDC connection does NOT satisfy Org-B → 403, zero mutation", async () => {
    H.policy.ssoRequired = true; H.authMethod = "SAML"; H.ssoConnId = "conn-A"; H.conn = { status: "ACTIVE", orgId: "org-2" }; // conn belongs to a different org
    const res = await post({ workspaceId: WS });
    expect(res.statusCode).toBe(403);
    expect(H.writes.filter((w) => w.startsWith("user.update"))).toEqual([]);
  });
  it("§1 SSO method but MISSING connection binding → denied (unbound)", async () => {
    H.policy.ssoRequired = true; H.authMethod = "OIDC"; H.ssoConnId = null;
    const res = await post({ workspaceId: WS });
    expect(res.statusCode).toBe(403);
  });
  it("§1 REVOKED/stale connection does not satisfy the policy → denied", async () => {
    H.policy.ssoRequired = true; H.authMethod = "SAML"; H.ssoConnId = "conn-A"; H.conn = { status: "REVOKED", orgId: "org-1" };
    const res = await post({ workspaceId: WS });
    expect(res.statusCode).toBe(403);
  });
  it("correction 4 — a STANDARD (non-managed) user IS forced through org SSO when entering an org workspace", async () => {
    // Mandatory SSO is a login-method policy (decoupled from managed identity):
    // a STANDARD user entering an ssoRequired ORGANIZATION workspace with
    // password is DENIED — no managed-status exemption.
    H.policy.ssoRequired = true; H.authMethod = "PASSWORD"; H.identityMode = "STANDARD";
    const res = await post({ workspaceId: WS });
    expect(res.statusCode).toBe(403);
  });
  it("forged authMethod cannot be supplied by the client body — only session provenance counts", async () => {
    H.policy.ssoRequired = true; H.authMethod = "PASSWORD";
    // Even if a client sends authMethod:"SAML" in the body, the gate reads the
    // SESSION provenance (PASSWORD) → denied.
    const res = await post({ workspaceId: WS, authMethod: "SAML" });
    expect(res.statusCode).toBe(403);
  });
});

describe("§1 — provenance mapping + legacy fail-closed", () => {
  it("provenance maps to the policy vocabulary; legacy/unknown → non-SSO (fail closed)", async () => {
    const { provenanceToPolicyAuthMethod } = await import("../src/services/jwt.js");
    expect(provenanceToPolicyAuthMethod("SAML")).toBe("SSO");
    expect(provenanceToPolicyAuthMethod("OIDC")).toBe("SSO");
    expect(provenanceToPolicyAuthMethod("SOCIAL_OAUTH")).toBe("OAUTH");
    expect(provenanceToPolicyAuthMethod("PASSWORD")).toBe("PASSWORD");
    expect(provenanceToPolicyAuthMethod("MAGIC_LINK")).toBe("PASSWORD");
    // §6 (2026-07-23): missing/UNKNOWN/legacy-GUEST provenance is NEVER coerced
    // to PASSWORD — it returns null → the caller must require reauthentication.
    expect(provenanceToPolicyAuthMethod(undefined)).toBeNull();
    expect(provenanceToPolicyAuthMethod(null)).toBeNull();
    expect(provenanceToPolicyAuthMethod("GUEST")).toBeNull();
  });
  it("a LEGACY managed session (no provenance) fails closed → reauthenticate", async () => {
    // §6 (2026-07-23): missing/unknown provenance is NEVER coerced to PASSWORD.
    // It resolves to null → the org-context gate requires REAUTHENTICATION (401),
    // with zero mutation. (In production such a token is already rejected at
    // requireAuth; this asserts the switch gate's defence-in-depth null guard.)
    H.policy.ssoRequired = true; H.authMethod = undefined as never; // legacy token
    const res = await post({ workspaceId: WS });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).code).toBe("session_policy_reauth_required");
    expect(JSON.parse(res.body).reason).toBe("reauthentication_required");
    expect(H.writes.filter((w) => w.startsWith("user.update"))).toEqual([]); // zero mutation
  });
});

describe("§7/§9 — anti-divergence: no ambiguous/forged auth provenance", () => {
  it("no production mint infers SSO from provider === EMAIL; SAML/OIDC set explicit provenance", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const saml = readFileSync(fileURLToPath(new URL("../src/routes/saml-auth.routes.ts", import.meta.url)), "utf8");
    const oidc = readFileSync(fileURLToPath(new URL("../src/routes/sso-auth.routes.ts", import.meta.url)), "utf8");
    expect(saml).toMatch(/authMethod:\s*"SAML"/);
    expect(oidc).toMatch(/authMethod:\s*"OIDC"/);
    // No path derives auth method by string-matching provider === "EMAIL".
    expect(saml + oidc).not.toMatch(/provider\s*===\s*"EMAIL"/);
  });
  it("§2/§3 corrections: guest REMOVED, verify≠PASSWORD, MFA augments, SSO is org-bound", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const authRoutes = readFileSync(fileURLToPath(new URL("../src/routes/auth.routes.ts", import.meta.url)), "utf8");
    const svc = readFileSync(fileURLToPath(new URL("../src/services/identity/org-security-policy.service.ts", import.meta.url)), "utf8");
    // Guest LOGIN was PHYSICALLY DELETED (2026-07-23): no GUEST provenance mint,
    // no route, no retired 410 code survives. (Full coverage:
    // phase-10-guest-login-removed.)
    expect(authRoutes).not.toMatch(/jwtPayloadFromUser\([^)]*"GUEST"/);
    expect(authRoutes).not.toContain("/v1/auth/guest");
    expect(authRoutes).not.toContain("GUEST_LOGIN_RETIRED");
    // Email-verification mint is not PASSWORD (§2).
    expect(authRoutes).toMatch(/Verification succeeded[\s\S]{0,400}jwtPayloadFromUser\(fullUser, "MAGIC_LINK"\)/);
    // MFA augments (mfaAt) rather than replacing primary (§3).
    expect(authRoutes).toMatch(/mfaAt: Math\.floor\(Date\.now\(\) \/ 1000\)/);
    // SSO is org-bound: the gate resolves the connection + checks org/status (§1).
    expect(svc).toMatch(/ssoConnection\.findUnique/);
    expect(svc).toMatch(/sso_connection_wrong_organization/);
    expect(svc).toMatch(/conn\.status !== "ACTIVE"/);
  });
  it("the switch gate reads SESSION provenance, never a request field", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const ctx = readFileSync(fileURLToPath(new URL("../src/routes/platform-context.routes.ts", import.meta.url)), "utf8");
    const callIdx = ctx.indexOf("const method = provenanceToPolicyAuthMethod(");
    const block = ctx.slice(callIdx, callIdx + 300);
    expect(block).toMatch(/req\.user/);
    expect(block).not.toMatch(/req\.body|req\.query|req\.headers/);
  });
});

describe("§10.7 — session lifetime at org-context establishment (real gate)", () => {
  it("a session older than max-age is rejected with reauth", async () => {
    H.authMethod = "SAML"; H.policy.maxSessionAgeSeconds = 3600; H.iat = Math.floor(Date.now() / 1000) - 2 * 3600;
    const res = await post({ workspaceId: WS });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).code).toBe("session_policy_reauth_required");
    expect(H.writes.filter((w) => w.startsWith("user.update"))).toEqual([]);
  });
  it("a fresh compliant SAML session under max-age passes", async () => {
    H.authMethod = "SAML"; H.policy.maxSessionAgeSeconds = 3600; H.iat = Math.floor(Date.now() / 1000) - 60;
    const res = await post({ workspaceId: WS });
    expect(res.statusCode).not.toBe(401);
  });
});
