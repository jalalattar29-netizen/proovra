/**
 * WS-SCHED / PRO-W2-13 — a machine-only cron route never admits a SESSION.
 *
 * At base, with the cron secret unset in a development/test deployment,
 * `checkCronSecret` fell back to "any ACTIVE OWNER/ADMIN of ANY workspace".
 * Every account owns a personal workspace, so any signed-in Free user whose
 * request reached the gate with `req.user` populated could drive the
 * platform-wide sweeps (lifecycle closures, notification retries, master
 * reconcile...). The gate now fails closed with a retryable 503
 * CONFIGURATION_ERROR in EVERY environment when the secret is missing, and a
 * correct header is still the only credential.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const { findFirst } = vi.hoisted(() => ({
  findFirst: vi.fn(async () => ({ id: "m1", role: "OWNER", status: "ACTIVE" })),
}));
vi.mock("../src/db.js", () => ({
  prisma: { teamMember: { findFirst } },
}));

import {
  requireIntegrationCronSecret,
  requireNotificationCronSecret,
  INTEGRATION_CRON_HEADER,
} from "../src/middleware/cron-secret.js";

const SECRET = "ws-sched-test-secret-0123456789";

async function buildApp() {
  const app = Fastify();
  const sweeps: string[] = [];
  // A session-authenticated request: simulate any route that ran requireAuth
  // (or any future global hook) before the cron gate.
  app.addHook("onRequest", async (req) => {
    if (req.headers["x-test-session"] === "1") {
      (req as unknown as { user: { sub: string } }).user = { sub: "free-user-1" };
    }
  });
  app.post("/sweep/integration", async (req, reply) => {
    const ok = await requireIntegrationCronSecret(req, reply);
    if (!ok) return;
    sweeps.push("integration");
    return { ran: true };
  });
  app.post("/sweep/notification", async (req, reply) => {
    const ok = await requireNotificationCronSecret(req, reply);
    if (!ok) return;
    sweeps.push("notification");
    return { ran: true };
  });
  await app.ready();
  return { app, sweeps };
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["INTEGRATION_CRON_SECRET", "NOTIFICATION_CRON_SECRET", "NODE_ENV", "APP_ENV", "DEPLOYMENT_ENVIRONMENT"]) {
    saved[k] = process.env[k];
  }
  delete process.env.INTEGRATION_CRON_SECRET;
  delete process.env.NOTIFICATION_CRON_SECRET;
  process.env.NODE_ENV = "test";
  findFirst.mockClear();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("PRO-W2-13 cron gate admits no session fallback", () => {
  it("secret unset + OWNER session in a test deployment -> 503, sweep never runs, membership never consulted", async () => {
    const { app, sweeps } = await buildApp();
    for (const path of ["/sweep/integration", "/sweep/notification"]) {
      const res = await app.inject({ method: "POST", url: path, headers: { "x-test-session": "1" } });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("CONFIGURATION_ERROR");
    }
    expect(sweeps).toEqual([]);
    expect(findFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it("secret unset + no session -> 503 (fails closed, retryable configuration error)", async () => {
    const { app, sweeps } = await buildApp();
    const res = await app.inject({ method: "POST", url: "/sweep/integration" });
    expect(res.statusCode).toBe(503);
    expect(sweeps).toEqual([]);
    await app.close();
  });

  it("secret set: correct header runs, wrong header and session-only are 401", async () => {
    process.env.INTEGRATION_CRON_SECRET = SECRET;
    const { app, sweeps } = await buildApp();
    const ok = await app.inject({
      method: "POST",
      url: "/sweep/integration",
      headers: { [INTEGRATION_CRON_HEADER]: SECRET },
    });
    expect(ok.statusCode).toBe(200);
    const wrong = await app.inject({
      method: "POST",
      url: "/sweep/integration",
      headers: { [INTEGRATION_CRON_HEADER]: "x".repeat(SECRET.length) },
    });
    expect(wrong.statusCode).toBe(401);
    const session = await app.inject({ method: "POST", url: "/sweep/integration", headers: { "x-test-session": "1" } });
    expect(session.statusCode).toBe(401);
    expect(sweeps).toEqual(["integration"]);
    await app.close();
  });
});
