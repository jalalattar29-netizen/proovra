/**
 * B-09 — when the shared limiter cannot decide, the sign-in refusal says so.
 *
 * Every public auth bucket is `bound: "global"`, so with Redis configured and
 * unreachable the limiter refuses (fail closed, services/rate-limit.ts) — the
 * stated policy. It no longer tells a person who made one attempt that they made
 * too many: `details.reason` is `limiter_unavailable` and the message says the
 * service is briefly unavailable. DEC-20 (WS-REL): a dependency failure is a
 * bounded, retryable 503 SERVER_BUSY with Retry-After — the busy answer every
 * client already renders — and actual exhaustion stays 429. A real over-limit
 * refusal is unchanged.
 *
 * The REAL authRoutes plugin on a bare Fastify app; the limiter's decision is
 * the double (an outage cannot be produced against the shared test Redis
 * without disturbing other suites), the database is inert.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const decision = vi.hoisted(() => ({ store: "unavailable" as "unavailable" | "redis" }));

vi.mock("../src/db.js", () => ({
  prisma: new Proxy(
    {},
    {
      get() {
        return new Proxy({}, { get: () => async () => null });
      },
    },
  ),
}));
vi.mock("../src/services/rate-limit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/rate-limit.js")>();
  return {
    ...actual,
    enforceRateLimit: async () => ({
      allowed: false,
      remaining: 0,
      resetAtMs: Date.now() + 30_000,
      store: decision.store,
    }),
  };
});

import { authRoutes } from "../src/routes/auth.routes.js";
import { extensionOAuthRoutes } from "../src/routes/extension-oauth.routes.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(authRoutes as never);
  await app.register(extensionOAuthRoutes as never);
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});

const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: payload as never });

describe("B-09 — a limiter outage is not 'too many attempts'", () => {
  it("login, register, resend and reset-request answer 503 SERVER_BUSY with reason limiter_unavailable", async () => {
    decision.store = "unavailable";
    for (const [url, payload] of [
      ["/v1/auth/email/login", { email: "a@example.test", password: "x" }],
      ["/v1/auth/email/register", { email: "a@example.test", password: "Abcdefghijk1" }],
      ["/v1/auth/email/resend-verification", { email: "a@example.test" }],
      ["/v1/auth/password-reset/request", { email: "a@example.test" }],
    ] as const) {
      const res = await post(url, payload);
      expect(res.statusCode, url).toBe(503);
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
      const err = (res.json() as { error: { code: string; message: string; details?: { reason?: string } } }).error;
      expect(err.code).toBe("SERVER_BUSY");
      expect(err.details?.reason, url).toBe("limiter_unavailable");
      expect(err.message).not.toMatch(/too many/i);
    }
  });

  it("matrix review NEW-RG-22-1/2: password-reset confirm and passkey-handoff options answer 503 on an outage, 429 on exhaustion", async () => {
    for (const [url, payload] of [
      ["/v1/auth/password-reset/confirm", { token: "x".repeat(40), password: "Abcdefghijk1!" }],
      ["/v1/auth/mfa/passkey-handoff/options", { token: "x".repeat(40) }],
      // NEW-RG-22-3 — the extension's public token endpoint (the authorize and
      // approve buckets share the same branch behind requireAuth).
      ["/v1/oauth/extension/token", { grant_type: "authorization_code", code: "x" }],
    ] as const) {
      decision.store = "unavailable";
      const outage = await post(url, payload);
      expect(outage.statusCode, `${url} ${outage.body}`).toBe(503);
      expect(Number(outage.headers["retry-after"])).toBeGreaterThan(0);
      const err = (outage.json() as { error: { code: string; details?: { reason?: string } } }).error;
      expect(err.code).toBe("SERVER_BUSY");
      expect(err.details?.reason, url).toBe("limiter_unavailable");

      decision.store = "redis";
      const exhausted = await post(url, payload);
      expect(exhausted.statusCode, `${url} ${exhausted.body}`).toBe(429);
    }
  });

  it("control: a real over-limit refusal keeps its words and carries no outage reason", async () => {
    decision.store = "redis";
    const res = await post("/v1/auth/email/login", { email: "a@example.test", password: "x" });
    expect(res.statusCode).toBe(429);
    const err = (res.json() as { error: { code: string; message: string; details?: unknown } }).error;
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.message).toBe("Too many sign-in attempts. Wait a minute and try again.");
    expect(err.details).toBeUndefined();
  });
});
