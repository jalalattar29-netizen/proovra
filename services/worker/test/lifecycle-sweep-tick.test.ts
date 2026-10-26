/**
 * MEMBERS AUDIT LIFE-11 — the worker-side lifecycle sweep tick.
 *
 * The real `runLifecycleSweepTick` against a real local HTTP server (no fetch
 * mock): the request it makes, how it reads the API's summary, and its
 * fail-soft contract — missing configuration, an HTTP error and an unreachable
 * API each return `{ ok: false }` and never throw, and only a transport
 * failure is a Sentry incident.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTEGRATION_CRON_HEADER } from "@proovra/shared";

const { captureExceptionMock, warnMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
  warnMock: vi.fn(),
}));
vi.mock("../src/logger.js", () => ({
  logger: { info: () => {}, warn: warnMock, error: () => {}, debug: () => {} },
}));
vi.mock("../src/sentry.js", () => ({ captureException: captureExceptionMock }));

import { runLifecycleSweepTick } from "../src/lifecycle-sweep.js";

type Seen = { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string };

let server: Server | null = null;
const seen: Seen[] = [];
const saved = {
  base: process.env.INTERNAL_API_BASE_URL,
  api: process.env.API_BASE_URL,
  secret: process.env.INTEGRATION_CRON_SECRET,
};

async function serve(status: number, body: unknown): Promise<string> {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`;
}

beforeEach(() => {
  seen.length = 0;
  captureExceptionMock.mockReset();
  warnMock.mockReset();
  delete process.env.API_BASE_URL;
  process.env.INTEGRATION_CRON_SECRET = "lifecycle-test-secret";
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  for (const [k, v] of [
    ["INTERNAL_API_BASE_URL", saved.base],
    ["API_BASE_URL", saved.api],
    ["INTEGRATION_CRON_SECRET", saved.secret],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("LIFE-11 — worker lifecycle sweep tick", () => {
  it("POSTs the one lifecycle tick with the cron secret and a correlation id, and reads the summary", async () => {
    process.env.INTERNAL_API_BASE_URL = await serve(200, { summary: { failures: 2 } });
    const result = await runLifecycleSweepTick({ trigger: "test" });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe("/v1/internal/lifecycle/run");
    expect(seen[0]!.headers[INTEGRATION_CRON_HEADER]).toBe("lifecycle-test-secret");
    expect(seen[0]!.headers["x-correlation-id"]).toBe(result.correlationId);
    expect(result).toMatchObject({ ok: true, failures: 2 });
    // Processor failures are said out loud, but are not an incident.
    expect(warnMock.mock.calls.some(([, msg]) => msg === "lifecycle_sweep.processor_failures")).toBe(true);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("a clean tick reports no failures and warns about nothing", async () => {
    process.env.INTERNAL_API_BASE_URL = await serve(200, { summary: { failures: 0 } });
    expect(await runLifecycleSweepTick()).toMatchObject({ ok: true, failures: 0 });
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("an unconfigured sweep says so on every tick and calls nothing", async () => {
    process.env.INTERNAL_API_BASE_URL = await serve(200, {});
    delete process.env.INTEGRATION_CRON_SECRET;
    expect(await runLifecycleSweepTick()).toMatchObject({ ok: false, error: "not_configured" });
    expect(seen).toHaveLength(0);
    expect(warnMock.mock.calls.some(([, msg]) => msg === "lifecycle_sweep.not_configured")).toBe(true);
  });

  it("an HTTP refusal is a logged failure, not a throw and not an incident", async () => {
    process.env.INTERNAL_API_BASE_URL = await serve(503, { error: "busy" });
    expect(await runLifecycleSweepTick()).toMatchObject({ ok: false, error: "http_503" });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("an unreachable API is captured and returned, never thrown", async () => {
    const base = await serve(200, {});
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    process.env.INTERNAL_API_BASE_URL = base;
    const result = await runLifecycleSweepTick();
    expect(result.ok).toBe(false);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
