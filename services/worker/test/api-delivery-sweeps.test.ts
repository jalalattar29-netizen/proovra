/**
 * WORKFLOW-008 — the worker calls each delivery route with the header and secret
 * the route verifies, and a sweep that cannot run says so.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { INTEGRATION_CRON_HEADER, NOTIFICATION_CRON_HEADER } from "@proovra/shared";
import { readFileSync } from "node:fs";

import { API_DELIVERY_SWEEPS, runApiDeliverySweep } from "../src/api-delivery-sweeps.js";

const bySweep = (name: string) => API_DELIVERY_SWEEPS.find((s) => s.name === name)!;

describe("API delivery sweeps", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("covers every route the audit found with no caller, each on its own contract", () => {
    expect(API_DELIVERY_SWEEPS.map((s) => [s.path, s.header, s.secretEnv]).sort()).toEqual(
      [
        ["/v1/communications/process-retries", INTEGRATION_CRON_HEADER, "INTEGRATION_CRON_SECRET"],
        ["/v1/notifications/process-retries", NOTIFICATION_CRON_HEADER, "NOTIFICATION_CRON_SECRET"],
        ["/v1/notifications/run-digests", NOTIFICATION_CRON_HEADER, "NOTIFICATION_CRON_SECRET"],
        ["/v1/notifications/run-reminders", NOTIFICATION_CRON_HEADER, "NOTIFICATION_CRON_SECRET"],
        // AUD-0003
        ["/v1/governance/reconcile-retention", INTEGRATION_CRON_HEADER, "INTEGRATION_CRON_SECRET"],
        ["/v1/integrations/process-webhook-retries", INTEGRATION_CRON_HEADER, "INTEGRATION_CRON_SECRET"],
        ["/v1/integrations/webhooks/cleanup-deliveries", INTEGRATION_CRON_HEADER, "INTEGRATION_CRON_SECRET"],
        ["/v1/integrations/process-secret-cleanup", INTEGRATION_CRON_HEADER, "INTEGRATION_CRON_SECRET"],
        ["/v1/review-operations/reconcile-slas", INTEGRATION_CRON_HEADER, "INTEGRATION_CRON_SECRET"],
      ].sort(),
    );
  });

  it("the worker bootstrap starts them under the cron lock", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/startApiDeliverySweepSchedulers\(\);\n/);
    expect(index).toMatch(/withCronLock\(`api-delivery-\$\{sweep\.name\}`/);
    expect(index).toMatch(/stopApiDeliverySweepSchedulers\(\);/);
  });

  it("sends the secret on the route's header and reports success", async () => {
    vi.stubEnv("INTERNAL_API_BASE_URL", "http://api.test/");
    vi.stubEnv("NOTIFICATION_CRON_SECRET", "notification-secret-0123456789");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await runApiDeliverySweep(bySweep("notification-retries"));
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/v1/notifications/process-retries");
    expect((init.headers as Record<string, string>)[NOTIFICATION_CRON_HEADER]).toBe("notification-secret-0123456789");
  });

  it("a refused call is a failed sweep, never a success", async () => {
    vi.stubEnv("INTERNAL_API_BASE_URL", "http://api.test");
    vi.stubEnv("INTEGRATION_CRON_SECRET", "integration-secret-0123456789");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    const result = await runApiDeliverySweep(bySweep("communication-retries"));
    expect(result).toMatchObject({ ok: false, error: "http_401" });
  });

  it("with no secret it makes no call and reports not_configured", async () => {
    vi.stubEnv("INTERNAL_API_BASE_URL", "http://api.test");
    vi.stubEnv("INTEGRATION_CRON_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await runApiDeliverySweep(bySweep("communication-retries"));
    expect(result).toMatchObject({ ok: false, error: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a network failure is reported, never thrown", async () => {
    vi.stubEnv("INTERNAL_API_BASE_URL", "http://api.test");
    vi.stubEnv("NOTIFICATION_CRON_SECRET", "notification-secret-0123456789");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const result = await runApiDeliverySweep(bySweep("notification-digests"));
    expect(result).toMatchObject({ ok: false, error: "TypeError" });
  });
});
