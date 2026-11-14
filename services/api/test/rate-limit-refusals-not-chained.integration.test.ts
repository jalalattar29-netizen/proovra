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
  const savedVerifyMax = process.env.VERIFY_RATE_LIMIT_MAX;
  const startedAt = new Date();

  beforeAll(async () => {
    process.env.VERIFY_RATE_LIMIT_MAX = "2";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
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
});
