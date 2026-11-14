/**
 * F-02 — PayPal OAuth token reuse and the webhook's missing-header pre-check.
 *
 * Every PayPal call minted a fresh client-credentials token, and every POST to
 * /webhooks/paypal — signed or not — cost two outbound PayPal requests (token +
 * verify) before any local check. Now:
 *   - the token is reused until `expires_in` minus a margin, and a 401 on a call
 *     that used it forgets it;
 *   - a webhook POST without `paypal-transmission-sig` / `-id` is refused locally
 *     (400, `missing_signature`) and reaches PayPal not at all.
 *
 * `fetch` is stubbed: nothing here reaches PayPal.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPayPalAccessTokenCache,
  getPayPalAccessToken,
  getPayPalOrder,
} from "../src/services/paypal.service.js";
import { webhooksRoutes } from "../src/routes/webhooks.routes.js";

const BASE = "https://api-m.sandbox.paypal.com";
type Call = { url: string; method: string };
let calls: Call[] = [];
let tokenSeq = 0;

function stubPayPal(opts: { expiresIn?: number | null; orderStatus?: number } = {}) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: String(init.method ?? "GET") });
      if (String(url).endsWith("/v1/oauth2/token")) {
        tokenSeq += 1;
        return new Response(
          JSON.stringify({
            access_token: `A21-token-${tokenSeq}`,
            ...(opts.expiresIn === null ? {} : { expires_in: opts.expiresIn ?? 32_400 }),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const status = opts.orderStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? { id: "ORDER-1", status: "APPROVED" } : { name: "AUTHENTICATION_FAILURE" }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}
const tokenCalls = () => calls.filter((c) => c.url.endsWith("/v1/oauth2/token")).length;

beforeEach(() => {
  process.env.PAYPAL_CLIENT_ID = "test-client-id-F02";
  process.env.PAYPAL_SECRET = "test-secret-F02-DO-NOT-LOG";
  process.env.PAYPAL_API_BASE = BASE;
  process.env.PAYPAL_WEBHOOK_ID = "WH-F02";
  clearPayPalAccessTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("F-02 — PayPal access token reuse", () => {
  it("reuses one token across calls until it expires", async () => {
    stubPayPal();
    const a = await getPayPalAccessToken();
    const b = await getPayPalAccessToken();
    await getPayPalOrder("ORDER-1");
    await getPayPalOrder("ORDER-1");
    expect(a).toBe(b);
    expect(tokenCalls()).toBe(1);
  });

  it("concurrent callers share one token fetch", async () => {
    stubPayPal();
    const tokens = await Promise.all([getPayPalAccessToken(), getPayPalAccessToken(), getPayPalAccessToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(tokenCalls()).toBe(1);
  });

  it("a 401 on a call forgets the token, and the next call mints a new one", async () => {
    stubPayPal({ orderStatus: 401 });
    const first = await getPayPalAccessToken();
    await expect(getPayPalOrder("ORDER-1")).rejects.toThrow();
    stubPayPal();
    const second = await getPayPalAccessToken();
    expect(second).not.toBe(first);
    expect(tokenCalls()).toBe(1);
  });

  it("a token with no stated lifetime, or one inside the safety margin, is not kept", async () => {
    stubPayPal({ expiresIn: null });
    await getPayPalAccessToken();
    await getPayPalAccessToken();
    expect(tokenCalls()).toBe(2);
    stubPayPal({ expiresIn: 60 });
    await getPayPalAccessToken();
    await getPayPalAccessToken();
    expect(tokenCalls()).toBe(2);
  });
});

describe("F-02 — /webhooks/paypal refuses an unsigned POST before calling PayPal", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify();
    await app.register(webhooksRoutes, { prefix: "/webhooks" });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const post = (headers: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: "/webhooks/paypal",
      headers: { "content-type": "application/json", ...headers },
      payload: JSON.stringify({ id: "WH-F02-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} }),
    });

  it("no transmission headers: 400 and zero outbound calls", async () => {
    stubPayPal();
    const res = await post({});
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("a signature without its transmission id (or the reverse): 400 and zero outbound calls", async () => {
    stubPayPal();
    expect((await post({ "paypal-transmission-sig": "sig" })).statusCode).toBe(400);
    expect((await post({ "paypal-transmission-id": "tid" })).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("control: a POST carrying both headers goes on to PayPal's verifier", async () => {
    stubPayPal();
    await post({ "paypal-transmission-sig": "sig", "paypal-transmission-id": "tid" });
    expect(calls.some((c) => c.url.endsWith("/v1/notifications/verify-webhook-signature"))).toBe(true);
  });
});
