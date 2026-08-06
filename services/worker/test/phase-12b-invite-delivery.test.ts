/**
 * Macro-Wave A2 — org-invite delivery sweep tick (worker side).
 *
 * The worker's role in the durable invite-delivery chain is deliberately
 * thin: it SCHEDULES the api-side sweep (POST /v1/org-invite-deliveries/
 * process, cron-secret guarded) — the token + email authorities live in
 * the api, so the worker never sees a raw token, an accept URL, or a
 * recipient address. This matrix drives the REAL sweep caller with a
 * mocked HTTP transport only, and pins:
 *
 *   - machine-auth: the x-cron-secret header + endpoint path;
 *   - batchSize forwarding;
 *   - summary parsing (pickedUp/sent/retried/failed/cancelled);
 *   - fail-soft contract: missing config, HTTP errors, thrown transport
 *     errors all return a structured { ok:false } — NEVER a throw (a
 *     stuck sweep must not crash the worker);
 *   - zero token exposure: the request the worker sends contains no
 *     token-shaped material (it physically has none to leak).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
const { captureExceptionMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
}));
vi.mock("../src/sentry.js", () => ({ captureException: captureExceptionMock }));

import { runOrgInviteDeliverySweep } from "../src/org-invite-delivery.worker.js";

const fetchMock = vi.fn();

const ENV_KEYS = [
  "INTERNAL_API_BASE_URL",
  "API_BASE_URL",
  "INTEGRATION_CRON_SECRET",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.INTERNAL_API_BASE_URL = "http://api.internal:4000/";
  delete process.env.API_BASE_URL;
  process.env.INTEGRATION_CRON_SECRET = "cron-secret-1";
  fetchMock.mockReset();
  captureExceptionMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function okResponse(summary: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ summary }),
  };
}

describe("Macro-Wave A2 — worker sweep tick (machine-auth + parsing)", () => {
  it("POSTs the cron-secret-guarded sweep endpoint and maps the summary", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ pickedUp: 3, sent: 2, retried: 1, failed: 0, cancelled: 0 }),
    );
    const result = await runOrgInviteDeliverySweep({
      trigger: "test",
      batchSize: 25,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    // Trailing slash on the base is normalized away.
    expect(url).toBe("http://api.internal:4000/v1/org-invite-deliveries/process");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-cron-secret"]).toBe("cron-secret-1");
    expect(headers["x-trigger"]).toBe("test");
    expect(JSON.parse(String(init.body))).toEqual({ batchSize: 25 });

    expect(result).toMatchObject({
      ok: true,
      pickedUp: 3,
      sent: 2,
      retried: 1,
      failed: 0,
      cancelled: 0,
    });
    // The worker request carries NO token-shaped material — it has none.
    expect(String(init.body)).not.toMatch(/[0-9a-f]{64}/);
  });

  it("omits batchSize from the body when not configured (api default applies)", async () => {
    fetchMock.mockResolvedValue(okResponse({}));
    await runOrgInviteDeliverySweep({});
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({});
  });
});

describe("Macro-Wave A2 — worker sweep tick (fail-soft matrix)", () => {
  const failCases: Array<{
    name: string;
    setup: () => void;
    expectError: (e: string | undefined) => void;
    expectFetchCalls: number;
  }> = [
    {
      name: "missing base URL → structured error, no HTTP call",
      setup: () => {
        delete process.env.INTERNAL_API_BASE_URL;
        delete process.env.API_BASE_URL;
      },
      expectError: (e) => expect(e).toContain("INTERNAL_API_BASE_URL"),
      expectFetchCalls: 0,
    },
    {
      name: "missing cron secret → structured error, no HTTP call",
      setup: () => {
        delete process.env.INTEGRATION_CRON_SECRET;
      },
      expectError: (e) => expect(e).toContain("INTEGRATION_CRON_SECRET"),
      expectFetchCalls: 0,
    },
    {
      name: "HTTP 401 (bad secret) → ok:false http_401",
      setup: () => {
        fetchMock.mockResolvedValue({
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ error: { code: "UNAUTHORIZED" } }),
        });
      },
      expectError: (e) => expect(e).toBe("http_401"),
      expectFetchCalls: 1,
    },
    {
      name: "transport throws → ok:false, sentry-captured, never a throw",
      setup: () => {
        fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
      },
      expectError: (e) => expect(e).toContain("ECONNREFUSED"),
      expectFetchCalls: 1,
    },
  ];

  for (const tc of failCases) {
    it(tc.name, async () => {
      tc.setup();
      const result = await runOrgInviteDeliverySweep({ trigger: "test" });
      expect(result.ok).toBe(false);
      expect(result.pickedUp).toBe(0);
      expect(result.sent).toBe(0);
      tc.expectError(result.error);
      expect(fetchMock).toHaveBeenCalledTimes(tc.expectFetchCalls);
    });
  }

  it("thrown transport errors reach Sentry (on-call visibility)", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    await runOrgInviteDeliverySweep({ trigger: "test" });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
