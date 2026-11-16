/**
 * FREE-USER AUDIT 0ea0 — GROUP API-G5-NOTIFY-PLATFORM (worker).
 *
 *   B8-F-002 — the worker pool's wait is bounded and a pool timeout is
 *              recognisable (the attempt fails and BullMQ retries it);
 *   B8-F-005 — the dead-letter sinks are trimmed past their retention;
 *   B8-F-006 — the report renderer blocks egress and page script;
 *   B8-F-301 — the integrity-recheck batch follows the population;
 *   B8-F-303 / B8-F-305 — report / OTS concurrency are operator settings.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  env: { DATABASE_URL: "postgresql://g5:g5@127.0.0.1:1/g5_never_connected" },
}));

vi.mock("../src/storage.js", () => ({ getObjectStream: vi.fn(), headObject: vi.fn() }));

import {
  databasePoolConnectionTimeoutMs,
  databasePoolHeadroomWarning,
  databasePoolStats,
  DEFAULT_WORKER_DATABASE_POOL_CONNECTION_TIMEOUT_MS,
  isDatabasePoolTimeout,
} from "../src/db.js";
import { deadLetterRetentionMs, trimDeadLetterQueue } from "../src/dead-letter-retention.js";
import { adaptiveIntegrityRecheckBatch, INTEGRITY_RECHECK_SWEEP_MAX_BATCH } from "../src/integrity-recheck.js";
import {
  injectReportRenderCsp,
  isAllowedReportRequestUrl,
  renderPdfFromHtml,
  resolveBrowserExecutablePath,
} from "../src/report-v2/render-pdf.js";
import { WORKER_CONCURRENCY_SETTINGS, workerQueueConcurrency } from "../src/worker-concurrency.js";

describe("B8-F-002 — bounded worker pool wait", () => {
  it("defaults to a 30 s connection timeout (never pg's wait-for-ever), 0 only when explicit; invalid values stop the process", () => {
    expect(databasePoolConnectionTimeoutMs(undefined)).toBe(DEFAULT_WORKER_DATABASE_POOL_CONNECTION_TIMEOUT_MS);
    expect(DEFAULT_WORKER_DATABASE_POOL_CONNECTION_TIMEOUT_MS).toBe(30_000);
    expect(databasePoolConnectionTimeoutMs("0")).toBe(0);
    expect(databasePoolConnectionTimeoutMs("5000")).toBe(5000);
    expect(() => databasePoolConnectionTimeoutMs("-1")).toThrow(/DATABASE_POOL_CONNECTION_TIMEOUT_MS/);
    expect(() => databasePoolConnectionTimeoutMs("abc")).toThrow();
  });

  it("a pool-wait timeout is recognised through the cause chain, and the startup check names a pool below the slots", () => {
    expect(isDatabasePoolTimeout(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isDatabasePoolTimeout({ message: "prisma failed", cause: { message: "Connection terminated due to connection timeout" } })).toBe(true);
    expect(isDatabasePoolTimeout(new Error("unique constraint"))).toBe(false);
    expect(databasePoolHeadroomWarning(10, 13)).toEqual({ required: 17, poolMax: 10 });
    expect(databasePoolHeadroomWarning(20, 13)).toBeNull();
    expect(databasePoolStats().max).toBe(10);
  });
});

describe("B8-F-005 — dead-letter retention", () => {
  it("trims every DLQ state older than the window (default 30 days)", async () => {
    const calls: Array<[number, number, string | undefined]> = [];
    const queue = {
      clean: async (grace: number, limit: number, type?: string) => {
        calls.push([grace, limit, type]);
        return type === "wait" ? ["a", "b"] : [];
      },
    };
    expect(await trimDeadLetterQueue(queue as never)).toBe(2);
    expect(calls.map((c) => c[2])).toEqual(["wait", "delayed", "paused", "failed"]);
    expect(calls[0]![0]).toBe(30 * 24 * 60 * 60 * 1000);
    expect(deadLetterRetentionMs("7")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(deadLetterRetentionMs("0")).toBe(30 * 24 * 60 * 60 * 1000);
    // Wired into the queue health sampler that already visits both sinks.
    const index = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/trimDeadLetterQueue\(dlq\)/);
    expect(index).toMatch(/\[mediaIntelligenceDlqQueueName, mediaIntelligenceDlqQueue\]/);
  });
});

describe("B8-F-006 — renderer defence in depth", () => {
  it("allows data:, about:blank and the report's own assets; blocks the network and other files", () => {
    expect(isAllowedReportRequestUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isAllowedReportRequestUrl("about:blank")).toBe(true);
    expect(isAllowedReportRequestUrl(pathToFileURL("/srv/app/dist/report-v2/assets/paper-silver.png").href)).toBe(true);
    expect(isAllowedReportRequestUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowedReportRequestUrl("https://evil.example/x.png")).toBe(false);
    expect(isAllowedReportRequestUrl(pathToFileURL("/etc/passwd").href)).toBe(false);
    expect(isAllowedReportRequestUrl("file:///srv/app/dist/report-v2/assets/../../../etc/passwd")).toBe(false);
    const html = injectReportRenderCsp("<!DOCTYPE html><html><head><title>t</title></head><body></body></html>");
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<title>"));
    expect(html).toContain("script-src 'none'");
  });

  const chrome = resolveBrowserExecutablePath();
  it.skipIf(!chrome)("a record field carrying raw markup cannot fetch or run script; the PDF still renders", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const blockedLog = () =>
      warn.mock.calls.map((c) => String(c[0])).find((line) => line.includes("report_render.blocked_requests")) ?? null;
    const page = (inner: string) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title></head>
        <body><div class="report-root" data-report-version="1">${inner}</div></body></html>`;
    try {
      // 1. Injected markup asking for the metadata endpoint: page CSP refuses
      //    the subresource, so the PDF renders and nothing is fetched.
      const pdf = await renderPdfFromHtml(
        page(`<p>Title <img src="http://169.254.169.254/latest/meta-data/"></p>`),
        { launchTimeoutMs: 90_000 },
      );
      expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
      expect(blockedLog()).toBeNull();
      // 1b. A navigation (meta refresh) is not governed by CSP: interception
      //     aborts it and the render is REFUSED instead of printing an error page.
      await expect(
        renderPdfFromHtml(
          page(`<p>Title</p><meta http-equiv="refresh" content="0;url=http://169.254.169.254/latest/meta-data/">`),
          { launchTimeoutMs: 90_000 },
        ),
      ).rejects.toThrow(/renderer_blocked_navigation/);
      warn.mockClear();
      // 2. Injected script: had it run, it would navigate away and the render
      //    would be refused (1b). It does not run, so the PDF renders.
      const scripted = await renderPdfFromHtml(
        page(`<p>Title</p><script>location.href = "http://169.254.169.254/latest/meta-data/";</script>`),
        { launchTimeoutMs: 90_000 },
      );
      expect(scripted.subarray(0, 4).toString()).toBe("%PDF");
      expect(blockedLog()).toBeNull();
    } finally {
      warn.mockRestore();
    }
  }, 180_000);
});

describe("B8-F-301 — integrity-recheck batch follows the population", () => {
  it("keeps the base batch for a small population, grows to sustain 30 days, and flags capacity beyond the cap", () => {
    const fifteenMin = 15 * 60 * 1000;
    expect(adaptiveIntegrityRecheckBatch({ due: 10, eligible: 50_000, intervalMs: fifteenMin, baseBatch: 25 }).limit).toBe(25);
    const big = adaptiveIntegrityRecheckBatch({ due: 5_000, eligible: 300_000, intervalMs: fifteenMin, baseBatch: 25 });
    expect(big.limit).toBe(Math.ceil(300_000 / (30 * 96)));
    expect(big.limit * 96 * 30).toBeGreaterThanOrEqual(300_000);
    expect(big.capacityExceeded).toBe(false);
    const huge = adaptiveIntegrityRecheckBatch({ due: 0, eligible: 1_000_000, intervalMs: fifteenMin, baseBatch: 25 });
    expect(huge.limit).toBe(INTEGRITY_RECHECK_SWEEP_MAX_BATCH);
    expect(huge.capacityExceeded).toBe(true);
  });
});

describe("B8-F-303 / B8-F-305 — consumer concurrency settings", () => {
  it("unset keeps report 2 / ots 1; a whole number 1..32 raises it; anything else stops the process", () => {
    expect(workerQueueConcurrency(WORKER_CONCURRENCY_SETTINGS.report, {})).toBe(2);
    expect(workerQueueConcurrency(WORKER_CONCURRENCY_SETTINGS.otsUpgrade, {})).toBe(1);
    expect(workerQueueConcurrency(WORKER_CONCURRENCY_SETTINGS.report, { WORKER_REPORT_CONCURRENCY: "4" })).toBe(4);
    expect(() => workerQueueConcurrency(WORKER_CONCURRENCY_SETTINGS.otsUpgrade, { WORKER_OTS_UPGRADE_CONCURRENCY: "0" })).toThrow(/WORKER_OTS_UPGRADE_CONCURRENCY/);
    expect(fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")).toContain(
      "concurrency: workerQueueConcurrency(WORKER_CONCURRENCY_SETTINGS.report)",
    );
  });
});
