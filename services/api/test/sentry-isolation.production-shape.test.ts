/**
 * Sentry alert audit (2026-11-26) — Sentry scope isolation under PRODUCTION's
 * OpenTelemetry setup.
 *
 * Production runs OTEL_ENABLED=true: our own NodeSDK (observability/otel.ts) and
 * Sentry with `skipOpenTelemetrySetup`. Without Sentry's context manager every
 * isolation scope collapsed onto one process-wide scope, and production events
 * carried other requests' and jobs' breadcrumbs, tags and extras; every
 * background error was filed under `GET /readyz`.
 *
 * This boots the REAL otel.ts and the REAL initSentry (recording transport: no
 * socket to Sentry) and proves, with concurrent requests, background runs and a
 * bare timer, that nothing crosses from one to another and that background work
 * is named for what it is.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Seen = {
  message: string;
  transaction: string | null;
  extra: Record<string, unknown>;
  tags: Record<string, unknown>;
  crumbs: string[];
};

const seen: Seen[] = [];
let server: http.Server;
let port = 0;
let captureException: (err: unknown, ctx?: Record<string, unknown>) => void;
let Sentry: typeof import("@sentry/node");
let runBackgroundOperation: typeof import("../src/runtime/background-work.js").runBackgroundOperation;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  process.env.OTEL_ENABLED = "true";
  // Spans go nowhere: an unreachable local collector, never the network.
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:9";
  process.env.OBSERVABILITY_TRANSPORT = "recording";
  const otel = await import("../src/observability/otel.js");
  otel.initOpenTelemetry({ defaultServiceName: "proovra-api", log: { info: () => undefined, warn: () => undefined } });
  const sentry = await import("../src/observability/sentry.js");
  sentry.initSentry();
  captureException = sentry.captureException;
  Sentry = await import("@sentry/node");
  ({ runBackgroundOperation } = await import("../src/runtime/background-work.js"));
  Sentry.getClient()!.on("beforeSendEvent", (event) => {
    seen.push({
      message: String(event.exception?.values?.[0]?.value ?? event.message ?? ""),
      transaction: event.transaction ?? null,
      extra: (event.extra ?? {}) as Record<string, unknown>,
      tags: (event.tags ?? {}) as Record<string, unknown>,
      crumbs: (event.breadcrumbs ?? []).filter((b) => b.category === "test").map((b) => String(b.message)),
    });
  });

  server = http.createServer(async (req, res) => {
    if (req.url?.startsWith("/a")) {
      Sentry.addBreadcrumb({ category: "test", message: "request-A step" });
      await sleep(40);
      captureException(new Error("A failed"), { userId: "user-A", evidenceId: "evidence-A", geo: { city: "A-town" } });
    } else {
      await sleep(80); // A is still in flight
      captureException(new Error("B failed"));
    }
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await Sentry.flush(500);
});

const get = (path: string) =>
  new Promise<void>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => { res.resume(); res.on("end", () => resolve()); }).on("error", reject);
  });
const find = async (msg: string) => {
  for (let i = 0; i < 100 && !seen.some((s) => s.message === msg); i += 1) await sleep(20);
  const e = seen.find((s) => s.message === msg);
  expect(e, `no event "${msg}" among ${seen.map((s) => s.message).join(", ")}`).toBeDefined();
  return e!;
};

describe("Sentry isolation under the production OpenTelemetry setup", () => {
  it("the global OpenTelemetry context manager is Sentry's", async () => {
    const api = await import("@opentelemetry/api");
    // context.with() must run through the manager that forks Sentry's scopes.
    const ctxMgr = (api.context as unknown as { _getContextManager(): unknown })._getContextManager();
    expect((ctxMgr as { constructor: { name: string } }).constructor.name).toMatch(/SentryContextManager/);
  });

  it("two CONCURRENT requests: each event carries only its own extras and breadcrumbs, under its own transaction", async () => {
    await Promise.all([get("/a/item"), get("/b/item")]);
    const a = await find("A failed");
    const b = await find("B failed");
    expect(a.extra).toMatchObject({ userId: "user-A", evidenceId: "evidence-A" });
    expect(a.crumbs).toEqual(["request-A step"]);
    expect(b.extra.userId).toBeUndefined();
    expect(b.extra.evidenceId).toBeUndefined();
    expect(b.extra.geo).toBeUndefined();
    expect(b.crumbs).toEqual([]);
    expect(a.transaction).toMatch(/\/a\/item/);
    expect(b.transaction).toMatch(/\/b\/item/);
  });

  it("concurrent background runs are isolated from each other and from requests, and named background.<operation>", async () => {
    await Promise.all([
      runBackgroundOperation("platform_maintenance", async () => {
        Sentry.addBreadcrumb({ category: "test", message: "maintenance step" });
        await sleep(30);
        captureException(new Error("maintenance failed"), { job: "platform_maintenance", step: "x" });
      }),
      runBackgroundOperation("billing_reconciler", async () => {
        await sleep(60);
        captureException(new Error("billing failed"));
      }),
    ]);
    const m = await find("maintenance failed");
    const bill = await find("billing failed");
    expect(m.transaction).toBe("background.platform_maintenance");
    expect(m.tags.background_operation).toBe("platform_maintenance");
    expect(m.crumbs).toEqual(["maintenance step"]);
    expect(bill.transaction).toBe("background.billing_reconciler");
    expect(bill.crumbs).toEqual([]);
    expect(bill.extra.job).toBeUndefined();
    expect(bill.extra.userId).toBeUndefined();
  });

  it("a bare timer capture after all of that inherits nothing: no request transaction, no extras, no breadcrumbs", async () => {
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        captureException(new Error("timer failed"));
        resolve();
      }, 10),
    );
    const t = await find("timer failed");
    expect(t.transaction ?? "").not.toMatch(/GET|readyz|\/a\/|\/b\//);
    expect(t.extra.userId).toBeUndefined();
    expect(t.extra.job).toBeUndefined();
    expect(t.crumbs).toEqual([]);
  });
});
