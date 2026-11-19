/**
 * WS-FREG (remediation cdcb8ae) — Free row B7A-F-008, regression obligation.
 *
 * The non-production fallback of the cron-secret gate admits an ACTIVE
 * OWNER/ADMIN of ANY workspace, and every account owns a personal workspace,
 * so the fallback is only safe because the routes it guards register NO
 * `requireAuth` and nothing global sets `req.user`. With no secret configured
 * the gate therefore answers 401 to everyone in development — even a request
 * carrying a bearer token — and never reaches the membership query or the
 * sweep. In production with no secret it is 503 CONFIGURATION_ERROR; with a
 * secret only the exact header value passes.
 *
 * The REAL route module and the REAL gate are registered; only the database
 * client and the sweep body are faked, so a regression that put `requireAuth`
 * (or a global user hook) in front of the route, or widened the fallback,
 * changes what these requests observe.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findFirst: vi.fn(async () => ({ userId: "owner-1", role: "OWNER", status: "ACTIVE" })),
  tick: vi.fn(async () => ({ processed: 0 })),
}));

vi.mock("../src/db.js", () => ({
  prisma: { teamMember: { findFirst: m.findFirst } },
}));

vi.mock("../src/services/lifecycle/lifecycle-scheduler.service.js", () => ({
  runLifecycleTick: m.tick,
}));

import { INTEGRATION_CRON_HEADER } from "../src/middleware/cron-secret.js";
import { internalLifecycleRoutes } from "../src/routes/internal-lifecycle.routes.js";

const ENV_KEYS = ["INTEGRATION_CRON_SECRET", "NODE_ENV", "PROOVRA_ENV", "APP_ENV", "DEPLOY_ENV"] as const;
const saved: Record<string, string | undefined> = {};

let app: FastifyInstance;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  app = Fastify();
  await app.register(internalLifecycleRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  m.findFirst.mockClear();
  m.tick.mockClear();
  for (const k of ["INTEGRATION_CRON_SECRET", "PROOVRA_ENV", "APP_ENV", "DEPLOY_ENV"]) delete process.env[k];
});

afterEach(() => {
  delete process.env.INTEGRATION_CRON_SECRET;
});

const post = (headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/v1/internal/lifecycle/run", headers });

describe("B7A-F-008 — the cron fallback fails closed on routes without requireAuth", () => {
  // PRO-W2-13 (WS-SCHED) — a missing secret is 503 CONFIGURATION_ERROR in EVERY
  // environment (development used to answer 401); it still fails closed.
  it("development, no secret: a bearer-carrying request is refused (503) and neither the membership query nor the sweep runs", async () => {
    process.env.NODE_ENV = "development";
    const res = await post({ authorization: "Bearer a.b.c" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("CONFIGURATION_ERROR");
    expect(m.findFirst).not.toHaveBeenCalled();
    expect(m.tick).not.toHaveBeenCalled();
  });

  it("production, no secret: 503 CONFIGURATION_ERROR, no sweep", async () => {
    process.env.NODE_ENV = "production";
    const res = await post({ authorization: "Bearer a.b.c" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("CONFIGURATION_ERROR");
    expect(m.tick).not.toHaveBeenCalled();
  });

  it("an undeclared environment (NODE_ENV unset) is not development: 503, no fallback", async () => {
    delete process.env.NODE_ENV;
    const res = await post();
    expect(res.statusCode).toBe(503);
    expect(m.findFirst).not.toHaveBeenCalled();
    expect(m.tick).not.toHaveBeenCalled();
  });

  it("secret configured: a wrong or missing header is 401; the exact header runs the sweep once", async () => {
    process.env.NODE_ENV = "development";
    process.env.INTEGRATION_CRON_SECRET = "freg-cron-secret-0123456789";
    expect((await post()).statusCode).toBe(401);
    expect((await post({ [INTEGRATION_CRON_HEADER]: "freg-cron-secret-0123456788" })).statusCode).toBe(401);
    expect(m.tick).not.toHaveBeenCalled();
    const ok = await post({ [INTEGRATION_CRON_HEADER]: "freg-cron-secret-0123456789" });
    expect(ok.statusCode).toBe(200);
    expect(m.tick).toHaveBeenCalledTimes(1);
    expect(m.findFirst).not.toHaveBeenCalled();
  });

  // Every caller of the three gates: the route that calls one registers no
  // preHandler (requireAuth or otherwise) between its `app.<verb>(` and the
  // gate call, so `req.user` is never set when the fallback runs.
  it("no cron-secret-gated route registers a preHandler in front of the gate", () => {
    const dir = fileURLToPath(new URL("../src/routes/", import.meta.url));
    const gate = /require(?:Integration|Notification)CronSecret\(|requireSearchReindexSecret\(/g;
    const callers: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      const src = readFileSync(join(dir, name), "utf8");
      for (const hit of src.matchAll(gate)) {
        const before = src.slice(0, hit.index);
        const open = Math.max(before.lastIndexOf("app.post("), before.lastIndexOf("app.get("));
        if (open < 0) continue; // the import line
        const head = before.slice(open);
        callers.push(`${name}:${hit.index}`);
        expect(head, `${name}: route before its cron gate`).not.toMatch(/preHandler|requireAuth|onRequest/);
      }
    }
    // The packet's known callers (16 at cdcb8aef8) — a vanished scan is a failure, not a pass.
    expect(callers.length).toBeGreaterThanOrEqual(15);
  });
});
