/**
 * WS-SCHED / PRO-W2-10 — worker-driven API sweeps share the bootstrap's API
 * base (with its default) and a sweep that cannot run raises ONE alert.
 * WS-SCHED / PRO-W2-08 (B8-F-301) — the integrity recheck batch is sized for
 * the configured cadence.
 */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const errorMock = vi.hoisted(() => vi.fn());
const warnMock = vi.hoisted(() => vi.fn());
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: warnMock, error: errorMock, debug: vi.fn() },
}));
vi.mock("../src/sentry.js", () => ({ captureException: vi.fn() }));

import { API_DELIVERY_SWEEPS, runApiDeliverySweep } from "../src/api-delivery-sweeps.js";
import { runAutomationDispatchSweepTick } from "../src/automation-dispatch.js";
import { adaptiveIntegrityRecheckBatch } from "../src/integrity-recheck.js";
import {
  INTERNAL_API_BASE_DEFAULT,
  resetSweepNotConfiguredAlerts,
  resolveInternalApiBase,
} from "../src/internal-api.js";
import { runLifecycleSweepTick } from "../src/lifecycle-sweep.js";
import { runOrgInviteDeliverySweep } from "../src/org-invite-delivery.worker.js";

const alerts = () =>
  errorMock.mock.calls.filter(([, msg]) => msg === "operational.alert").map(([ctx]) => ctx as Record<string, unknown>);

describe("worker internal API base and sweep configuration (PRO-W2-10)", () => {
  beforeEach(() => {
    errorMock.mockClear();
    warnMock.mockClear();
    resetSweepNotConfiguredAlerts();
    vi.stubEnv("INTERNAL_API_BASE_URL", "");
    vi.stubEnv("API_BASE_URL", "");
    vi.stubEnv("INTEGRATION_CRON_SECRET", "");
    vi.stubEnv("NOTIFICATION_CRON_SECRET", "");
    vi.stubEnv("IDENTITY_RECONCILE_CRON_SECRET", "");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("the resolver prefers INTERNAL_API_BASE_URL, then API_BASE_URL, then the bootstrap default; no trailing slash", () => {
    expect(resolveInternalApiBase({})).toBe(INTERNAL_API_BASE_DEFAULT);
    expect(resolveInternalApiBase({ API_BASE_URL: "http://b.test/" })).toBe("http://b.test");
    expect(resolveInternalApiBase({ INTERNAL_API_BASE_URL: " http://a.test// ", API_BASE_URL: "http://b.test" })).toBe("http://a.test");
  });

  it("with no base URL configured every sweep calls the default API address (it used to answer not_configured)", async () => {
    vi.stubEnv("INTEGRATION_CRON_SECRET", "s-int");
    vi.stubEnv("NOTIFICATION_CRON_SECRET", "s-not");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ ok: true, summary: { failures: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await runApiDeliverySweep(API_DELIVERY_SWEEPS[0]!);
    await runAutomationDispatchSweepTick();
    await runLifecycleSweepTick();
    await runOrgInviteDeliverySweep();
    expect(urls).toHaveLength(4);
    for (const u of urls) expect(u.startsWith(`${INTERNAL_API_BASE_DEFAULT}/v1/`), u).toBe(true);
    expect(alerts()).toEqual([]);
  });

  it("a missing cron secret makes no call and raises one alert per sweep, however many ticks run", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (let tick = 0; tick < 3; tick += 1) {
      for (const sweep of API_DELIVERY_SWEEPS) await runApiDeliverySweep(sweep);
      await runAutomationDispatchSweepTick();
      await runLifecycleSweepTick();
      await runOrgInviteDeliverySweep();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    const raised = alerts();
    expect(raised.map((a) => a.sweep).sort()).toEqual(
      [...API_DELIVERY_SWEEPS.map((s) => s.name), "automation-dispatch", "lifecycle-sweep", "org-invite-delivery"].sort(),
    );
    for (const a of raised) {
      expect(a).toMatchObject({ alert: true, severity: "critical", reason: "worker_api_sweep_not_configured" });
      // The variable is named; no value travels.
      expect(a.missing).toEqual([expect.stringMatching(/_CRON_SECRET$/)]);
    }
  });
});

describe("integrity recheck sizing follows the configured cadence (PRO-W2-08, B8-F-301)", () => {
  it("a 7-day cadence needs a larger sustaining batch than the 30-day default, and alerts when the cap cannot hold it", () => {
    const base = { due: 0, eligible: 200_000, intervalMs: 15 * 60_000, baseBatch: 25, maxBatch: 200 };
    const monthly = adaptiveIntegrityRecheckBatch(base);
    const weekly = adaptiveIntegrityRecheckBatch({ ...base, cadenceDays: 7 });
    expect(monthly.sustainable).toBe(Math.ceil(200_000 / (30 * 96)));
    expect(monthly.capacityExceeded).toBe(false);
    expect(weekly.sustainable).toBe(Math.ceil(200_000 / (7 * 96)));
    expect(weekly.capacityExceeded).toBe(true);
  });

  it("the scheduler passes the canonical setting into the sizing", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const call = index.slice(index.indexOf("adaptiveIntegrityRecheckBatch({"), index.indexOf("limit = plan.limit"));
    expect(call).toMatch(/cadenceDays: integrityRecheckIntervalDays\(\)/);
  });
});
