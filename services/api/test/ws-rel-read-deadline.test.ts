/**
 * WS-REL / PRO-S1-05 — a read that cannot answer within its deadline is
 * refused busy instead of lingering N x the pool wait; writes and responses
 * already streaming are never cut.
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { installOverloadGate, readOverloadGateSettings } from "../src/middleware/overload-gate.js";

const apps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function gated(readDeadlineMs: number) {
  const app = Fastify();
  installOverloadGate(app, { maxInFlight: 100, maxEventLoopDelayMs: 0, retryAfterSeconds: 3, sampleIntervalMs: 500, readDeadlineMs });
  let writeFinished = 0;
  app.get("/stuck-read", async () => {
    await new Promise((r) => setTimeout(r, 300));
    return { ok: true };
  });
  app.post("/slow-write", async () => {
    await new Promise((r) => setTimeout(r, 120));
    writeFinished += 1;
    return { ok: true };
  });
  app.get("/fast", async () => ({ ok: true }));
  apps.push(app);
  return { app, writeFinished: () => writeFinished };
}

describe("PRO-S1-05 request deadline", () => {
  it("a stuck read answers 503 SERVER_BUSY with Retry-After at its deadline", async () => {
    const { app } = gated(50);
    const started = Date.now();
    const res = await app.inject({ method: "GET", url: "/stuck-read" });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("3");
    expect(res.json().error.code).toBe("SERVER_BUSY");
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("a write is never cut by the read deadline", async () => {
    const { app, writeFinished } = gated(50);
    const res = await app.inject({ method: "POST", url: "/slow-write" });
    expect(res.statusCode).toBe(200);
    expect(writeFinished()).toBe(1);
  });

  it("normal reads are unchanged", async () => {
    const { app } = gated(50);
    expect((await app.inject({ method: "GET", url: "/fast" })).statusCode).toBe(200);
  });

  it("the deadline is configurable and on by default", () => {
    expect(readOverloadGateSettings({}).readDeadlineMs).toBe(45_000);
    expect(readOverloadGateSettings({ API_READ_DEADLINE_MS: "0" }).readDeadlineMs).toBe(0);
  });
});
