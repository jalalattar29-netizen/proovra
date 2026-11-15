/**
 * F-08 (Free-user audit 4d9b, capacity; 2026-11-15) — the overload gate and
 * the server's request bounds, on a real Fastify instance (in-process inject
 * and a real loopback socket for cancellation and the request timeout).
 */
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_API_MAX_IN_FLIGHT,
  installOverloadGate,
  isDatabasePoolTimeout,
  readOverloadGateSettings,
  readServerTimeouts,
} from "../src/middleware/overload-gate.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Gate = ReturnType<typeof installOverloadGate>;
const apps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function gated(settings: Partial<ReturnType<typeof readOverloadGateSettings>>, delay?: () => number) {
  const app = Fastify();
  const gate: Gate = installOverloadGate(
    app,
    { maxInFlight: 2, maxEventLoopDelayMs: 0, retryAfterSeconds: 2, sampleIntervalMs: 500, ...settings },
    delay ? { eventLoopDelayMs: delay } : {},
  );
  const releases: Array<() => void> = [];
  let handlerFinished = 0;
  app.get("/slow", async () => {
    await new Promise<void>((r) => releases.push(r));
    handlerFinished += 1;
    return { ok: true };
  });
  app.get("/fast", async () => ({ ok: true }));
  app.get("/healthz", async () => ({ ok: true }));
  apps.push(app);
  return { app, gate, releases, handlerFinished: () => handlerFinished };
}

describe("F-08 overload gate", () => {
  it("refuses beyond the in-flight cap with 503 SERVER_BUSY + Retry-After, never sheds health probes, and admits again once requests finish", async () => {
    const { app, gate, releases } = gated({ maxInFlight: 2 });
    const a = app.inject({ method: "GET", url: "/slow" });
    const b = app.inject({ method: "GET", url: "/slow" });
    while (releases.length < 2) await sleep(5);
    expect(gate.stats().inFlight).toBe(2);

    const refused = await app.inject({ method: "GET", url: "/fast" });
    expect(refused.statusCode).toBe(503);
    expect(refused.headers["retry-after"]).toBe("2");
    expect(refused.json().error.code).toBe("SERVER_BUSY");
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);

    releases.forEach((r) => r());
    expect((await a).statusCode).toBe(200);
    expect((await b).statusCode).toBe(200);
    expect(gate.stats().inFlight).toBe(0);
    expect((await app.inject({ method: "GET", url: "/fast" })).statusCode).toBe(200);
    expect(gate.stats().refused).toBe(1);
  });

  it("refuses new work while the event loop is delayed past the bound", async () => {
    let delay = 1_500;
    const { app } = gated({ maxInFlight: 0, maxEventLoopDelayMs: 1_000 }, () => delay);
    const refused = await app.inject({ method: "GET", url: "/fast" });
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe("SERVER_BUSY");
    delay = 10;
    expect((await app.inject({ method: "GET", url: "/fast" })).statusCode).toBe(200);
  });

  it("a client that disconnects mid-request releases its slot exactly once (no leak), and its handler still completes", async () => {
    const { app, gate, releases, handlerFinished } = gated({ maxInFlight: 2 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const req = httpRequest({ host: "127.0.0.1", port, path: "/slow", method: "GET" });
    req.on("error", () => undefined);
    req.end();
    while (releases.length < 1) await sleep(5);
    expect(gate.stats().inFlight).toBe(1);
    req.destroy();
    for (let i = 0; i < 100 && gate.stats().inFlight !== 0; i++) await sleep(10);
    expect(gate.stats().inFlight).toBe(0);
    releases[0]!();
    for (let i = 0; i < 100 && handlerFinished() === 0; i++) await sleep(10);
    expect(handlerFinished()).toBe(1);
    expect(gate.stats().inFlight).toBe(0);
  });
});

describe("F-08 settings", () => {
  it("defaults: in-flight 512, event-loop bound on only in production, retry-after 2; request timeout 60 s, keep-alive 72 s", () => {
    expect(readOverloadGateSettings({})).toMatchObject({ maxInFlight: DEFAULT_API_MAX_IN_FLIGHT, maxEventLoopDelayMs: 0, retryAfterSeconds: 2 });
    expect(readOverloadGateSettings({ NODE_ENV: "production" }).maxEventLoopDelayMs).toBe(1_000);
    expect(readOverloadGateSettings({ API_MAX_IN_FLIGHT: "0", API_MAX_EVENT_LOOP_DELAY_MS: "250" })).toMatchObject({ maxInFlight: 0, maxEventLoopDelayMs: 250 });
    expect(readServerTimeouts({})).toEqual({ requestTimeout: 60_000, keepAliveTimeout: 72_000 });
    expect(readServerTimeouts({ API_REQUEST_TIMEOUT_MS: "0" }).requestTimeout).toBe(0);
  });

  it("a bad value stops the process instead of being guessed at", () => {
    for (const bad of ["-1", "2.5", "lots"]) {
      expect(() => readOverloadGateSettings({ API_MAX_IN_FLIGHT: bad })).toThrow(/API_MAX_IN_FLIGHT/);
      expect(() => readServerTimeouts({ API_REQUEST_TIMEOUT_MS: bad })).toThrow(/API_REQUEST_TIMEOUT_MS/);
    }
  });

  it("recognises pg-pool's connection-wait timeout, also when wrapped", () => {
    expect(isDatabasePoolTimeout(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isDatabasePoolTimeout({ message: "driver adapter error", cause: new Error("timeout exceeded when trying to connect") })).toBe(true);
    expect(isDatabasePoolTimeout(new Error("duplicate key value violates unique constraint"))).toBe(false);
    expect(isDatabasePoolTimeout(null)).toBe(false);
  });
});

describe("F-08 request timeout semantics (Node http, as Fastify configures it)", () => {
  it("cuts a sender that stalls mid-body with 408, and does NOT cut a slow handler once the request has arrived", async () => {
    const { requestTimeout } = readServerTimeouts({ API_REQUEST_TIMEOUT_MS: "300" });
    // Node checks request deadlines every `connectionsCheckingInterval`
    // (30 s by default); the test shortens only that interval.
    const app = Fastify({
      requestTimeout,
      serverFactory: (handler) => createServer({ requestTimeout, connectionsCheckingInterval: 50 }, handler),
    });
    app.post("/echo", async () => ({ ok: true }));
    app.get("/long", async () => {
      await sleep(800);
      return { ok: true };
    });
    apps.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;

    // A slow handler (800 ms > 300 ms bound) is served: the request itself arrived at once.
    const long = await fetch(`http://127.0.0.1:${port}/long`);
    expect(long.status).toBe(200);

    // A sender that declares 100 bytes and sends 10, then stalls.
    const answer = await new Promise<string>((resolve) => {
      const sock = connect(port, "127.0.0.1", () => {
        sock.write("POST /echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"a\":12345");
      });
      let got = "";
      sock.on("data", (d) => (got += d.toString()));
      sock.on("close", () => resolve(got));
      sock.on("error", () => resolve(got));
      setTimeout(() => sock.destroy(), 5_000);
    });
    expect(answer).toMatch(/^HTTP\/1\.1 408/);
  });
});
