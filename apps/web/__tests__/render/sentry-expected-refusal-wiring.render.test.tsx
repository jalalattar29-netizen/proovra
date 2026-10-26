/**
 * MEMBERS RE-AUDIT AUD-05 / DEFECT 18 — the WEB Sentry wiring, exercised.
 *
 * The classifier was unit-tested, but nothing proved that the code which
 * actually talks to Sentry consults it: deleting the early return in
 * `captureException` passed every suite. This drives the real `initSentry`
 * and `captureException` against a recording fake of `@sentry/browser`, with
 * errors produced by the REAL `apiFetch` from real HTTP responses:
 *
 *   - `captureException(err)`: a typed 4xx refusal and a code-less 409/422 (second
 *     re-audit N-7) are not sent; a code-less 401/403/404/405/413/415 is;
 *   - `captureException(err)`: a 409 business refusal (typed, and code-less)
 *     never reaches `Sentry.captureException`; a 500 and a network failure do;
 *   - the `beforeSend` hook `initSentry` installs: drops an event whose
 *     original exception is a business refusal (the unhandled-rejection path,
 *     which bypasses the wrapper), keeps a 500.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  initOptions: null as null | {
    beforeSend?: (event: unknown, hint?: { originalException?: unknown }) => unknown;
  },
  captured: [] as unknown[],
}));

vi.mock("@sentry/browser", () => ({
  init: (opts: typeof sentry.initOptions) => {
    sentry.initOptions = opts;
  },
  captureException: (err: unknown) => {
    sentry.captured.push(err);
  },
  withScope: (fn: (scope: { setExtra: () => void }) => void) => fn({ setExtra: () => {} }),
}));

vi.mock("../../lib/consent", () => ({ hasAnalyticsConsent: () => true }));

import { apiFetch } from "../../lib/api";
import { captureException, initSentry } from "../../lib/sentry";

const realFetch = globalThis.fetch;

function respond(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-request-id": "req-aud-05" },
    })) as typeof fetch;
}

async function failure(status: number, body: unknown): Promise<unknown> {
  respond(status, body);
  try {
    await apiFetch("/v1/teams/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/members", { method: "POST" });
  } catch (err) {
    return err;
  }
  throw new Error("expected the request to fail");
}

async function networkFailure(): Promise<unknown> {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    await apiFetch("/v1/teams/x");
  } catch (err) {
    return err;
  }
  throw new Error("expected a network failure");
}

beforeAll(() => {
  process.env.NEXT_PUBLIC_SENTRY_DSN = "https://public@sentry.test.invalid/1";
  initSentry();
});

afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;
});

beforeEach(() => {
  sentry.captured.length = 0;
});

describe("AUD-05 — web: business refusals are not Sentry incidents; faults are", () => {
  it("initSentry installed the hooks", () => {
    expect(typeof sentry.initOptions?.beforeSend).toBe("function");
  });

  it("captureException: a typed 409 refusal is NOT sent", async () => {
    const err = await failure(409, { error: { code: "WORKSPACE_SEAT_LIMIT_REACHED", message: "No seat." } });
    captureException(err, { where: "invite" });
    expect(sentry.captured).toEqual([]);
  });

  it("captureException: a code-less 409 business answer is NOT sent", async () => {
    const err = await failure(409, { message: "This member is already in the Collaboration Team." });
    expect((err as { code?: string }).code).toBe("API_ERROR");
    captureException(err);
    expect(sentry.captured).toEqual([]);
  });

  it("captureException: a code-less 422 validation answer is NOT sent", async () => {
    captureException(await failure(422, { message: "no" }));
    expect(sentry.captured).toEqual([]);
  });

  it("captureException: typed 4xx refusals (403, 404, 401, 429) are NOT sent", async () => {
    captureException(await failure(403, { error: { code: "WORKSPACE_ACCESS_DENIED" } }));
    captureException(await failure(404, { error: { code: "TEAM_NOT_FOUND" } }));
    captureException(await failure(401, { error: { code: "UNAUTHORIZED" } }));
    captureException(await failure(429, { error: { code: "RATE_LIMITED" } }));
    expect(sentry.captured).toEqual([]);
  });

  // Second re-audit N-7 — a code-less 401 / 403 / 404 is a fault (an auth
  // regression, Fastify's 404 for a removed or mistyped route), not a refusal.
  it("captureException: code-less 401 / 403 / 404 answers ARE sent", async () => {
    const sent: unknown[] = [];
    for (const status of [401, 403, 404]) {
      const err = await failure(status, { message: "no" });
      sent.push(err);
      captureException(err);
    }
    expect(sentry.captured).toEqual(sent);
  });

  it("captureException: code-less 405 / 413 / 415 answers ARE sent", async () => {
    const sent: unknown[] = [];
    for (const status of [405, 413, 415]) {
      const err = await failure(status, { message: "no" });
      sent.push(err);
      captureException(err);
    }
    expect(sentry.captured).toEqual(sent);
  });

  it("captureException: a 500 IS sent", async () => {
    const err = await failure(500, { error: { code: "INTERNAL_ERROR" } });
    captureException(err);
    expect(sentry.captured).toEqual([err]);
  });

  it("captureException: a network failure IS sent", async () => {
    const err = await networkFailure();
    captureException(err);
    expect(sentry.captured).toEqual([err]);
  });

  it("captureException: a code-less 400 (an unexpected request) IS sent", async () => {
    const err = await failure(400, { message: "bad" });
    captureException(err);
    expect(sentry.captured).toEqual([err]);
  });

  it("beforeSend: an event whose original exception is a 409 refusal is dropped; a 500 is kept", async () => {
    const beforeSend = sentry.initOptions!.beforeSend!;
    const refusal = await failure(409, { error: { code: "WORKSPACE_SEAT_LIMIT_REACHED" } });
    const fault = await failure(500, { error: { code: "INTERNAL_ERROR" } });

    expect(beforeSend({ message: "unhandled rejection" }, { originalException: refusal })).toBeNull();
    expect(beforeSend({ message: "unhandled rejection" }, { originalException: fault })).not.toBeNull();
    expect(beforeSend({ message: "plain error" }, { originalException: new Error("boom") })).not.toBeNull();
    const routeMissing = await failure(404, { message: "Route POST:/v1/teamz not found" });
    expect(beforeSend({ message: "unhandled rejection" }, { originalException: routeMissing })).not.toBeNull();
  });
});
