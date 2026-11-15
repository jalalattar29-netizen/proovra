/**
 * F-08 (Free-user audit 4d9b, capacity; 2026-11-15) — a request that cannot
 * get a pooled connection within DATABASE_POOL_CONNECTION_TIMEOUT_MS is
 * answered 503 SERVER_BUSY + Retry-After, promptly, instead of queueing for
 * ever (pg's default) — and never a 401 that signs the client out. Live
 * PostgreSQL 16, the real server and pool; the pool is made small here so it
 * can be exhausted deliberately.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

// Read by src/db.ts when it is first imported (in beforeAll, below).
process.env.DATABASE_POOL_MAX = "3";
process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS = "300";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("F-08 the pool wait is bounded and overload is a 503, not a hang (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let poolStats: (typeof import("../src/db.js"))["databasePoolStats"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma, databasePoolStats: poolStats } = await import("../src/db.js"));
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
    delete process.env.DATABASE_POOL_MAX;
    delete process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS;
  });

  const me = () =>
    h.app.inject({ method: "GET", url: "/v1/users/me", headers: { authorization: `Bearer ${h.fixtures.personal.token}` } });

  it("the real server states its request bounds (requestTimeout 60 s, keep-alive 72 s)", () => {
    expect(h.app.server.requestTimeout).toBe(60_000);
    expect(h.app.server.keepAliveTimeout).toBe(72_000);
  });

  it("with every connection held, an authenticated request is refused 503 + Retry-After within the bound, and served again once they return", async () => {
    expect(poolStats().max).toBe(3);
    expect((await me()).statusCode).toBe(200);

    // Three long statements hold all three connections (a stalled dependency).
    const holders = Array.from({ length: 3 }, () =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_sleep(2)`;
      }, { maxWait: 5_000, timeout: 10_000 }),
    );
    await sleep(150);
    const s = poolStats();
    expect(s.totalCount - s.idleCount).toBe(3);

    const t0 = Date.now();
    const refused = await me();
    const elapsed = Date.now() - t0;
    expect(refused.statusCode, refused.body).toBe(503);
    expect(refused.headers["retry-after"]).toBe("2");
    expect(JSON.parse(refused.body).error.code).toBe("SERVER_BUSY");
    // Bounded by the 300 ms pool wait (plus request overhead), not by the 2 s holders.
    expect(elapsed).toBeLessThan(1_500);

    await Promise.all(holders);
    const served = await me();
    expect(served.statusCode, served.body).toBe(200);
    await sleep(50);
    const after = poolStats();
    expect(after.waitingCount).toBe(0);
    console.log(
      `[F-08 measurement, LOCAL] pool max 3, connection wait bound 300 ms, 3 connections held 2 s: ` +
        `request refused 503 in ${elapsed} ms; served 200 after release; pool waiters after = ${after.waitingCount}`,
    );
  });
});
