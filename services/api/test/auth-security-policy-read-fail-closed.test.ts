/**
 * THE PHASE-4A SECURITY GATE FAILS CLOSED IN THE REAL `requireAuth`.
 *
 * `middleware/auth.ts` has always said an infrastructure failure in the
 * security-policy composition must answer 503 SECURITY_CONTEXT_UNAVAILABLE and
 * never reach the handler. For the governance SECURITY policy that catch was
 * dead: the evaluator swallowed a failed `governancePolicyAssignment.findMany`
 * into "no policy" and the gate resolved ok:true — a configured requireMfa /
 * requireSaml BLOCK policy silently stopped applying.
 *
 * Unlike phase-10-org-policy-fail-closed (which neutralises the gate to test
 * the org-context half), this suite runs the REAL gate and REAL evaluator;
 * only db reads are stubbed.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-secret-auth-security-policy-fail-closed-only";
process.env.AUTH_JWT_SECRET = SECRET;

const H = vi.hoisted(() => ({
  throwOn: null as string | null,
  assignments: [] as unknown[],
  handlerCalls: 0,
  writes: [] as string[],
}));

vi.mock("../src/services/identity-security/session-revocation.service.js", () => ({
  isSessionRevoked: async () => false,
  hashSessionId: (s: string) => s,
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
    if (model === "governancePolicyAssignment" && method === "findMany") return H.assignments;
    if (model === "team" && method === "findUnique")
      return { isPersonal: false, organizationId: "org-1", organization: { status: "ACTIVE", kind: "CUSTOMER" } };
    if (model === "user" && method === "findUnique")
      return {
        identityMode: "STANDARD",
        managingOrganizationId: null,
        managedIdentitySource: null,
        managedBySsoConnectionId: null,
      };
    if (model === "organizationSecurityPolicy" && method === "findUnique")
      return {
        teamId: "ws-org", policyVersion: 1, ssoRequired: false,
        managedIdentityRequired: false, noPersonalSpace: false, securityMode: "STANDARD",
        maxSessionAgeSeconds: null, idleTimeoutSeconds: null, concurrentSessionLimit: null,
        stepUpIntervalSeconds: null, allowedAuthMethods: [],
      };
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

async function build(): Promise<{ app: FastifyInstance; token: string }> {
  const app = Fastify();
  app.get("/protected", { preHandler: requireAuth as never }, async () => {
    H.handlerCalls += 1;
    return { ok: true };
  });
  await app.ready();
  const token = signJwt(
    { sub: "user-1", provider: "EMAIL", email: "u@x.com", authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
    resolvedSecret,
    3600,
  );
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
  H.assignments = [];
  H.handlerCalls = 0;
  H.writes.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("governance SECURITY policy read failure → 503, handler never reached", () => {
  it("governancePolicyAssignment.findMany throws → 503 SECURITY_CONTEXT_UNAVAILABLE, zero mutation", async () => {
    const { app, token } = await build();
    H.throwOn = "governancePolicyAssignment.findMany";
    const res = await hit(app, token);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe("SECURITY_CONTEXT_UNAVAILABLE");
    expect(res.body).not.toContain("ws-org");
    expect(res.body).not.toContain("INFRA_FAILURE");
    expect(H.handlerCalls).toBe(0);
    expect(H.writes).toEqual([]);
  });

  it("an EMPTY policy set (nothing configured) → handler reached (200)", async () => {
    const { app, token } = await build();
    const res = await hit(app, token);
    expect(res.statusCode).toBe(200);
    expect(H.handlerCalls).toBe(1);
  });

  it("a configured BLOCK policy that is not met → 401 (computed denial, not infra)", async () => {
    H.assignments = [
      {
        scope: "WORKSPACE",
        scopeTargetId: "ws-org",
        isOverride: false,
        policy: {
          id: "p-1", kind: "SECURITY", slug: "s", name: "s", summary: "", state: "ACTIVE",
          enforcementMode: "BLOCK", rule: { allowedActions: ["something_else"] }, version: 1,
          createdByUserId: "u", createdAt: new Date(),
        },
      },
    ];
    const { app, token } = await build();
    const res = await hit(app, token);
    expect(res.statusCode).toBe(401);
    expect(H.handlerCalls).toBe(0);
  });
});
