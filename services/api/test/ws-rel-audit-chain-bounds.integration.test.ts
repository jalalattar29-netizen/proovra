/**
 * WS-REL / PRO-S1-01 (+ PRO-W2C-03, PRO-S1-02) — the platform audit chain is
 * not a free resource for anonymous traffic, and a waiter is bounded.
 * Live PostgreSQL, the real routes and the real append.
 *
 *  - 20 cookie-less sign-outs append zero chain rows (they are logged and
 *    counted); a signed-in sign-out still appends exactly one.
 *  - With the chain lock held by a slow transaction, an append fails fast with
 *    a bounded, retryable 503 SERVER_BUSY instead of waiting behind it.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("PRO-S1-01 audit-chain bounds (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let hashPassword: (typeof import("../src/services/email-password-auth.service.js"))["hashPassword"];
  let appendPlatformAuditLog: (typeof import("../src/services/platform-audit-log.service.js"))["appendPlatformAuditLog"];
  let ADMIN_AUDIT_ADVISORY_LOCK_KEY: number;
  const startedAt = new Date();

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
    ({ appendPlatformAuditLog } = await import("../src/services/platform-audit-log.service.js"));
    ({ ADMIN_AUDIT_ADVISORY_LOCK_KEY } = await import("@proovra/shared-runtime"));
  }, 900_000);

  afterAll(async () => {
    delete process.env.AUDIT_CHAIN_LOCK_WAIT_MS;
    await h?.cleanup();
  }, 300_000);

  it("cookie-less sign-outs append no chain rows; a signed-in sign-out appends one", async () => {
    const requestIds: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const r = await h.app.inject({ method: "POST", url: "/v1/auth/logout", remoteAddress: `198.18.7.${i + 1}` });
      expect(r.statusCode).toBe(200);
      requestIds.push(String(r.headers["x-request-id"]));
    }
    await h.handlersSettled();
    await new Promise((r) => setTimeout(r, 300));
    const anonymousRows = await prisma.adminAuditLog.count({
      where: { action: "auth.logout", createdAt: { gte: startedAt }, requestId: { in: requestIds } },
    });
    expect(anonymousRows).toBe(0);

    const PASSWORD = "Ws-Rel-Logout-Pass-1";
    const email = `wsrel-${randomUUID().slice(0, 8)}@test.proovra.local`;
    await prisma.user.create({
      data: { email, provider: "EMAIL", providerUserId: email, passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() },
    });
    const login = await h.app.inject({
      method: "POST",
      url: "/v1/auth/email/login",
      remoteAddress: "198.18.8.1",
      headers: { "content-type": "application/json" },
      payload: { email, password: PASSWORD } as never,
    });
    expect(login.statusCode).toBe(200);
    const token = (login.json() as { token: string }).token;
    const out = await h.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      remoteAddress: "198.18.8.1",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(out.statusCode).toBe(200);
    // Held until written (PRO-S1-02): no polling needed.
    const rows = await prisma.adminAuditLog.count({
      where: { action: "auth.logout", createdAt: { gte: startedAt }, requestId: String(out.headers["x-request-id"]) },
    });
    expect(rows).toBe(1);
  });

  it("an append waiting behind a held chain lock fails fast with a retryable 503", async () => {
    process.env.AUDIT_CHAIN_LOCK_WAIT_MS = "300";
    let release!: () => void;
    const holding = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_AUDIT_ADVISORY_LOCK_KEY})`;
        locked();
        await holding;
      },
      { timeout: 20_000, maxWait: 5_000 },
    );
    await lockTaken;
    const started = Date.now();
    let caught: unknown = null;
    try {
      await appendPlatformAuditLog({
        userId: null,
        isPublic: true,
        action: "ws_rel.lock_bound_probe",
        category: "test",
        severity: "info",
        source: "api",
        outcome: "success",
        metadata: {},
      });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - started;
    release();
    await holder;
    expect(caught).not.toBeNull();
    expect((caught as { httpStatus?: number }).httpStatus).toBe(503);
    expect((caught as { publicCode?: string }).publicCode).toBe("SERVER_BUSY");
    expect(elapsed).toBeLessThan(3_000);
    // Uncontended again: the next append succeeds.
    await appendPlatformAuditLog({
      userId: null,
      isPublic: true,
      action: "ws_rel.lock_bound_probe",
      category: "test",
      severity: "info",
      source: "api",
      outcome: "success",
      metadata: {},
    });
    delete process.env.AUDIT_CHAIN_LOCK_WAIT_MS;
  });
});
