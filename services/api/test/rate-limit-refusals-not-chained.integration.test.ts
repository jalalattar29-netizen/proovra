/**
 * F-01 — a rate-limiter refusal does not append to the audit chain
 * (live PostgreSQL + Redis, the real routes).
 *
 * Every `admin_audit_logs` row takes the platform-wide hash-chain lock. A
 * refused sign-in or Public Verify read still appended one, so an anonymous
 * flood beyond the limit became a queue of serialized transactions holding pool
 * connections — refusing a request cost as much as serving it. Refusals are now
 * logged (`auth.rate_limited`, `public_verify.rate_limited`); the real outcomes
 * (a wrong password, an admitted read) are still audited.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Json = Record<string, unknown>;

describe("F-01 — limiter refusals are logged, not chained (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let hashPassword: (typeof import("../src/services/email-password-auth.service.js"))["hashPassword"];
  const savedVerifyMax = process.env.VERIFY_RATE_LIMIT_MAX;
  const startedAt = new Date();

  beforeAll(async () => {
    process.env.VERIFY_RATE_LIMIT_MAX = "2";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
  }, 900_000);

  afterAll(async () => {
    if (savedVerifyMax === undefined) delete process.env.VERIFY_RATE_LIMIT_MAX;
    else process.env.VERIFY_RATE_LIMIT_MAX = savedVerifyMax;
    await h?.cleanup();
  }, 300_000);

  const refusalRow = (m: Json) =>
    m.reason === "rate_limited" || m.denialReason === "rate_limited" || m.outcome === "rate_limited";

  /** The audit rows for `action` the given requests produced (by their x-request-id). */
  async function rowsFor(action: string, requestIds: string[]) {
    await h.handlersSettled();
    const rows = await prisma.adminAuditLog.findMany({
      where: { action, createdAt: { gte: startedAt }, requestId: { in: requestIds } },
      select: { metadata: true },
    });
    return rows.map((r) => (r.metadata ?? {}) as Json);
  }

  it("a sign-in flood from one address: the wrong passwords are audited, the refusals are not", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 20}`;
    const email = `f01-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const statuses: number[] = [];
    const requestIds: string[] = [];
    for (let i = 0; i < 16; i += 1) {
      const r = await h.app.inject({
        method: "POST",
        url: "/v1/auth/email/login",
        remoteAddress: ip,
        headers: { "content-type": "application/json" },
        payload: { email, password: "WrongPassword123" } as never,
      });
      statuses.push(r.statusCode);
      requestIds.push(String(r.headers["x-request-id"]));
    }
    // The limit is 10 per minute per address.
    expect(statuses.filter((s) => s === 401)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(6);

    // Control: each real outcome (a wrong password) is still in the chain —
    // waited for, since the append is fire-and-forget.
    const deadline = Date.now() + 15_000;
    let rows = await rowsFor("auth.email_login", requestIds);
    while (rows.filter((m) => m.reason === "invalid_credentials").length < 10 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      rows = await rowsFor("auth.email_login", requestIds);
    }
    expect(rows.filter((m) => m.reason === "invalid_credentials")).toHaveLength(10);
    // The six refusals appended nothing.
    expect(rows.filter(refusalRow)).toHaveLength(0);
  });

  it("a Public Verify flood from one address: the refusals append nothing to the chain", async () => {
    const ip = `198.18.0.${Math.floor(Math.random() * 200) + 20}`;
    const statuses: number[] = [];
    const requestIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await h.app.inject({ method: "GET", url: `/public/verify/${randomUUID()}`, remoteAddress: ip });
      statuses.push(r.statusCode);
      requestIds.push(String(r.headers["x-request-id"]));
    }
    expect(requestIds.every((id) => id.length > 8)).toBe(true);
    expect(statuses.slice(0, 2).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(2)).toEqual([429, 429, 429, 429]);
    // Give any (wrongly) fired append time to land before counting.
    await new Promise((r) => setTimeout(r, 500));
    const rows = await rowsFor("verification.page_opened", requestIds);
    expect(rows.filter(refusalRow)).toHaveLength(0);
  });

  // ===========================================================================
  // B-21 — a per-account sign-in budget across addresses (round 3)
  // ===========================================================================
  describe("B-21 — per-account sign-in budget", () => {
    let octet = 1;
    /** Every attempt from a fresh address, so the per-address bucket never decides. */
    const attempt = (email: string, password: string) =>
      h.app.inject({
        method: "POST",
        url: "/v1/auth/email/login",
        remoteAddress: `198.51.${Math.floor(Math.random() * 200) + 20}.${(octet++ % 250) + 1}`,
        headers: { "content-type": "application/json" },
        payload: { email, password } as never,
      });
    const shape = (r: { statusCode: number; body: string; headers: Record<string, unknown> }) => {
      const b = JSON.parse(r.body) as { error?: { code?: string; message?: string; details?: unknown } };
      return { status: r.statusCode, code: b.error?.code, message: b.error?.message, details: b.error?.details ?? null, keys: Object.keys(b.error ?? {}).sort() };
    };

    it("10 attempts on one account from 10 addresses are answered; the 11th — even with the right password — is refused, known or unknown alike", async () => {
      const PASSWORD = "Account-Budget-Pass-1";
      const email = `b21-${randomUUID().slice(0, 8)}@test.proovra.local`;
      const u = await prisma.user.create({
        data: { email, provider: "EMAIL", providerUserId: email, passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() },
      });

      const statuses: number[] = [];
      for (let i = 0; i < 10; i += 1) statuses.push((await attempt(email, "WrongPassword123")).statusCode);
      expect(statuses).toEqual(Array(10).fill(401));

      // The 11th, from yet another address, with the identifier re-cased.
      const refused = await attempt(email.toUpperCase(), "WrongPassword123");
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
      const sessionsBefore = await prisma.authenticatedSession.count({ where: { userId: u.id } });
      const rightPassword = await attempt(email, PASSWORD);
      expect(rightPassword.statusCode).toBe(429);
      expect(await prisma.authenticatedSession.count({ where: { userId: u.id } })).toBe(sessionsBefore);

      // An address with no account is throttled identically: same status, code, message and keys.
      const ghost = `b21-ghost-${randomUUID().slice(0, 8)}@test.proovra.local`;
      for (let i = 0; i < 10; i += 1) expect((await attempt(ghost, "WrongPassword123")).statusCode).toBe(401);
      const ghostRefused = await attempt(ghost, "WrongPassword123");
      expect(shape(ghostRefused)).toEqual(shape(refused));

      // Another account is untouched by this account's budget.
      const other = `b21-other-${randomUUID().slice(0, 8)}@test.proovra.local`;
      expect((await attempt(other, "WrongPassword123")).statusCode).toBe(401);

      // F-01 — the refusals are logged, not chained.
      const ids = [refused, rightPassword, ghostRefused].map((r) => String(r.headers["x-request-id"]));
      await new Promise((r) => setTimeout(r, 500));
      const rows = await rowsFor("auth.email_login", ids);
      expect(rows).toHaveLength(0);
    });
  });
});
