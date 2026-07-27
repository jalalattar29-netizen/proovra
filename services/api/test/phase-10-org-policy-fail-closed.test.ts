/**
 * PHASE 10 §1 correction 1 — ORGANIZATION SECURITY-POLICY ENFORCEMENT FAILS
 * CLOSED. An infrastructure read failure (session / workspace / organization /
 * policy / SSO connection) during org-context enforcement must NEVER be
 * converted to allow: the REAL `requireAuth` middleware returns a generic 503
 * `SECURITY_CONTEXT_UNAVAILABLE` and the route handler is NEVER invoked, with
 * zero mutation and no tenant/existence leak. A COMPUTED denial (non-compliant
 * session) yields the canonical 401. Personal/OWNED requests never require org
 * policy.
 *
 * Real middleware + real `evaluateOrgContextForSession` / gates; only db reads
 * are stubbed (and made to throw per-case). Leaf collaborators that are NOT the
 * subject (revocation / Phase-4A gate / timeout / heartbeat / secret) are
 * neutralised so the request reaches the org-context composition.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-secret-phase10-fail-closed-contract-only";
// getSecret("AUTH_JWT_SECRET") falls back to process.env — set it so the real
// signer/verifier agree without mocking the secret accessor.
process.env.AUTH_JWT_SECRET = SECRET;

// Configurable throwing prisma: `H.throwOn` names a `model.method` that throws.
const H = vi.hoisted(() => ({
  throwOn: null as string | null,
  team: { isPersonal: false, organizationId: "org-1", organization: { status: "ACTIVE" } } as
    | { isPersonal: boolean; organizationId: string | null; organization: { status: string } | null }
    | null,
  ssoRequired: false,
  managed: false,
  handlerCalls: 0,
  writes: [] as string[],
}));

vi.mock("../src/services/identity-security/session-revocation.service.js", () => ({
  isSessionRevoked: async () => false,
  hashSessionId: (s: string) => s, // identity hash is fine for the test
}));
vi.mock("../src/services/governance/policy-runtime-gates.service.js", () => ({
  gateSecurityAction: async () => ({ ok: true }),
}));
vi.mock("../src/services/identity-security/session-timeout-policy.service.js", () => ({
  enforceSessionTimeoutPolicy: async () => ({ action: "none" }),
}));
vi.mock("../src/services/access-control/session-inventory.service.js", () => ({
  recordHeartbeat: async () => null,
}));

vi.mock("../src/db.js", () => {
  const call = (model: string, method: string) => {
    const key = `${model}.${method}`;
    if (H.throwOn === key) throw new Error(`INFRA_FAILURE:${key}`);
    if (/^(update|create|upsert|delete)/.test(method)) H.writes.push(key);
    if (model === "authenticatedSession" && method === "findFirst")
      return { teamId: "ws-org", lastSeenAtUtc: new Date() };
    if (model === "team" && method === "findUnique")
      // Inject CUSTOMER kind so resolveSecurityPolicy routes to the org policy.
      return H.team && H.team.organization
        ? { ...H.team, organization: { ...H.team.organization, kind: "CUSTOMER" } }
        : H.team;
    if (model === "user" && method === "findUnique")
      return {
        identityMode: H.managed ? "MANAGED_ENTERPRISE" : "STANDARD",
        managingOrganizationId: H.managed ? "org-1" : null,
        managedIdentitySource: H.managed ? "SAML" : null,
        managedBySsoConnectionId: null,
      };
    if (model === "organizationSecurityPolicy" && method === "findUnique")
      return {
        teamId: "ws-org", policyVersion: 1, ssoRequired: H.ssoRequired,
        managedIdentityRequired: false, noPersonalSpace: false, securityMode: "STANDARD",
        maxSessionAgeSeconds: null, idleTimeoutSeconds: null, concurrentSessionLimit: null,
        stepUpIntervalSeconds: null, allowedAuthMethods: [],
      };
    if (model === "ssoConnection" && method === "findUnique") return null;
    return null;
  };
  const prisma = new Proxy({}, {
    get(_t, model: string) {
      if (String(model).startsWith("$")) return async () => 0;
      return new Proxy({}, { get: (_t2, method: string) => async () => call(String(model), String(method)) });
    },
  });
  return { prisma };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let requireAuth: any;
let signJwt: any;
let resolvedSecret: string;

async function build(tokenClaims: object): Promise<{ app: FastifyInstance; token: string }> {
  const app = Fastify();
  app.get("/protected", { preHandler: requireAuth as never }, async () => {
    H.handlerCalls += 1;
    return { ok: true };
  });
  await app.ready();
  // Sign with the EXACT secret requireAuth's verifier resolves, so signer +
  // verifier always agree regardless of env timing.
  const token = signJwt({ sub: "user-1", provider: "EMAIL", email: "u@x.com", authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000), ...tokenClaims }, resolvedSecret, 3600);
  return { app, token };
}
const hit = (app: FastifyInstance, token: string) =>
  app.inject({ method: "GET", url: "/protected", headers: { authorization: `Bearer ${token}` } });

beforeEach(async () => {
  process.env.AUTH_JWT_SECRET = SECRET;
  ({ requireAuth } = await import("../src/middleware/auth.js"));
  ({ signJwt } = await import("../src/services/jwt.js"));
  const { getSecret } = await import("../src/config/runtime-secrets.js");
  resolvedSecret = getSecret("AUTH_JWT_SECRET") as string;
  H.throwOn = null;
  H.team = { isPersonal: false, organizationId: "org-1", organization: { status: "ACTIVE" } };
  H.ssoRequired = false; H.managed = false; H.handlerCalls = 0; H.writes.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("§1c1 — infra read failure FAILS CLOSED (503, handler never called)", () => {
  // Managed-identity is NOT read in the login-path org enforcement (correction
  // 4/5 decoupled mandatory-SSO from managed status); its read-failure fail-
  // closed belongs to the no-personal path (§6), tested there.
  const cases: Array<[string, string, object]> = [
    ["session state read (authenticatedSession.findFirst)", "authenticatedSession.findFirst", {}],
    ["workspace/organization read (team.findUnique)", "team.findUnique", {}],
    ["policy read (organizationSecurityPolicy.findUnique)", "organizationSecurityPolicy.findUnique", {}],
    ["SSO connection read (ssoConnection.findUnique)", "ssoConnection.findUnique", { authMethod: "SAML", ssoConnId: "conn-A" }],
  ];
  for (const [label, throwKey, claims] of cases) {
    it(`${label} throws → 503, zero mutation, no existence leak`, async () => {
      if (throwKey === "ssoConnection.findUnique") { H.ssoRequired = true; }
      const { app, token } = await build(claims);
      H.throwOn = throwKey;
      const res = await hit(app, token);
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("SECURITY_CONTEXT_UNAVAILABLE");
      // No tenant/existence details leaked.
      expect(res.body).not.toContain("org-1");
      expect(res.body).not.toContain("ws-org");
      expect(H.handlerCalls).toBe(0); // route handler never reached
      expect(H.writes).toEqual([]); // zero mutation
    });
  }
});

describe("§1c1 — machine metric: NO organization-policy fail-open branch", () => {
  it("middleware/auth.ts contains no fail-OPEN for the org security-policy path", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const mw = readFileSync(resolve(__dirname, "../src/middleware/auth.ts"), "utf8");
    // The old fail-open catch ("Fail OPEN on policy-engine read failure") is gone.
    expect(mw).not.toMatch(/Fail OPEN on policy/i);
    // The org-context section fails CLOSED with the generic 503.
    expect(mw).toMatch(/SECURITY_CONTEXT_UNAVAILABLE/);
    expect(mw).toMatch(/auth\.security_context_unavailable/);
  });
});

describe("§1c1 — computed denial → 401 (not 503); personal exempt; happy path 200", () => {
  it("mandatory-SSO non-compliant session → 401 reauthenticate (COMPUTED, not infra)", async () => {
    H.ssoRequired = true; // STANDARD PASSWORD user, ssoRequired org (correction 4: denied)
    const { app, token } = await build({});
    const res = await hit(app, token);
    expect(res.statusCode).toBe(401);
    expect(H.handlerCalls).toBe(0);
    expect(H.writes).toEqual([]);
  });

  it("PERSONAL workspace session does NOT require org policy → handler reached (200)", async () => {
    H.team = { isPersonal: true, organizationId: null, organization: null };
    const { app, token } = await build({});
    const res = await hit(app, token);
    expect(res.statusCode).toBe(200);
    expect(H.handlerCalls).toBe(1);
  });

  it("compliant ORGANIZATION session (non-SSO org) → handler reached (200)", async () => {
    const { app, token } = await build({});
    const res = await hit(app, token);
    expect(res.statusCode).toBe(200);
    expect(H.handlerCalls).toBe(1);
  });
});
