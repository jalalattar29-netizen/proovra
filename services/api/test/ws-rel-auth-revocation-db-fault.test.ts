/**
 * WS-REL / PRO-S1-08 — a database fault in the session-revocation read is an
 * unavailable security context, not an ended session.
 *
 * At base, every non-pool error thrown by `isSessionRevoked` answered
 * 401 UNAUTHORIZED. The native app maps a bare UNAUTHORIZED to "session ended"
 * and purges its stored token; the extension deletes its token on any 401. A
 * transient DB fault therefore signed every native/extension user out. The
 * canonical rule in the same middleware (session-state read, security policy)
 * is 503 SECURITY_CONTEXT_UNAVAILABLE: still fail-closed, but retryable.
 *
 * Real `requireAuth`; only the revocation read and db are stubbed.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  process.env.AUTH_JWT_SECRET = "test-secret-ws-rel-revocation-db-fault-only";
  return {
    revocation: "ok" as "ok" | "revoked" | "conn_error" | "pool_timeout",
    handlerCalls: 0,
  };
});

vi.mock("../src/services/identity-security/session-revocation.service.js", () => ({
  isSessionRevoked: async () => {
    if (H.revocation === "revoked") return true;
    if (H.revocation === "conn_error") {
      throw Object.assign(new Error("Can't reach database server at db:5432"), { code: "P1001" });
    }
    if (H.revocation === "pool_timeout") {
      throw new Error("timeout exceeded when trying to connect");
    }
    return false;
  },
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
    if (model === "authenticatedSession" && method === "findFirst")
      return { teamId: null, lastSeenAtUtc: new Date() };
    if (model === "governancePolicyAssignment" && method === "findMany") return [];
    if (model === "user" && method === "findUnique")
      return {
        identityMode: "STANDARD",
        managingOrganizationId: null,
        managedIdentitySource: null,
        managedBySsoConnectionId: null,
      };
    return null;
  };
  const prisma = new Proxy(
    {},
    {
      get(_t, model: string) {
        if (String(model).startsWith("$")) return async () => 0;
        return new Proxy({}, { get: (_t2, method: string) => async () => call(String(model), String(method)) });
      },
    },
  );
  return { prisma };
});

import { requireAuth } from "../src/middleware/auth.js";
import { signJwt } from "../src/services/jwt.js";
import { getSecret } from "../src/config/runtime-secrets.js";

async function build(): Promise<{ app: FastifyInstance; token: string }> {
  const app = Fastify();
  app.get("/protected", { preHandler: requireAuth as never }, async () => {
    H.handlerCalls += 1;
    return { ok: true };
  });
  await app.ready();
  const token = signJwt(
    {
      sub: "user-1",
      provider: "EMAIL",
      email: "u@x.com",
      authMethod: "PASSWORD",
      authAt: Math.floor(Date.now() / 1000),
    },
    getSecret("AUTH_JWT_SECRET") as string,
    3600,
  );
  return { app, token };
}
const hit = (app: FastifyInstance, token: string) =>
  app.inject({ method: "GET", url: "/protected", headers: { authorization: `Bearer ${token}` } });

beforeEach(() => {
  H.revocation = "ok";
  H.handlerCalls = 0;
});

describe("PRO-S1-08 revocation-read failure is 503, never a sign-out 401", () => {
  it("healthy read, not revoked → handler reached", async () => {
    const { app, token } = await build();
    const res = await hit(app, token);
    expect(res.statusCode).toBe(200);
    expect(H.handlerCalls).toBe(1);
  });

  it("revoked session still gets 401 UNAUTHORIZED (clients sign out)", async () => {
    const { app, token } = await build();
    H.revocation = "revoked";
    const res = await hit(app, token);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("UNAUTHORIZED");
    expect(H.handlerCalls).toBe(0);
  });

  it("a DB connection error → 503 SECURITY_CONTEXT_UNAVAILABLE with Retry-After, handler not reached", async () => {
    const { app, token } = await build();
    H.revocation = "conn_error";
    const res = await hit(app, token);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe("SECURITY_CONTEXT_UNAVAILABLE");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(res.body).not.toContain("db:5432");
    expect(H.handlerCalls).toBe(0);
  });

  it("the same token succeeds once the DB recovers (token preserved)", async () => {
    const { app, token } = await build();
    H.revocation = "conn_error";
    expect((await hit(app, token)).statusCode).toBe(503);
    H.revocation = "ok";
    expect((await hit(app, token)).statusCode).toBe(200);
  });

  it("a pool timeout stays 503 (F-08 unchanged)", async () => {
    const { app, token } = await build();
    H.revocation = "pool_timeout";
    const res = await hit(app, token);
    expect(res.statusCode).toBe(503);
    expect(H.handlerCalls).toBe(0);
  });
});
