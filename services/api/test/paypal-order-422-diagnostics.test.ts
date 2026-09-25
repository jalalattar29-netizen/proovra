/**
 * PAYPAL 422 DIAGNOSTICS + the exact Orders API request.
 *
 * The evidence-credit checkout failed in Production with PayPal
 * 422 UNPROCESSABLE_ENTITY (paypal-debug-id 09f8161575975). The error that
 * reached the log carried PayPal's top-level message only, so the one part of a
 * 422 that names the failing rule — `details[].issue` / `field` /
 * `description` — was thrown away and the failure could not be diagnosed.
 *
 * `fetch` is mocked: nothing here reaches PayPal and nothing is charged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPayPalCheckout } from "../src/services/billing-checkout.service.js";
import {
  PayPalHttpError,
  createPayPalOrder,
  getPayPalOrder,
  parsePayPalErrorDetails,
} from "../src/services/paypal.service.js";
import { DomainError } from "../src/errors.js";

const USER = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "test-client-id-XYZ";
const SECRET = "test-secret-value-DO-NOT-LOG";

type Call = { url: string; init: RequestInit };
let calls: Call[];

function tokenResponse() {
  return new Response(JSON.stringify({ access_token: "A21-access-token-DO-NOT-LOG" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(second: () => Response) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith("/v1/oauth2/token") ? tokenResponse() : second();
    }),
  );
}

const PAYPAL_422 = {
  name: "UNPROCESSABLE_ENTITY",
  message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
  debug_id: "09f8161575975",
  details: [
    {
      field: "/purchase_units/@reference_id=='default'/amount/currency_code",
      value: "EUR",
      location: "body",
      issue: "CURRENCY_NOT_SUPPORTED",
      description: "Currency code is not currently supported. Contact payer jane.doe@example.com card 4111111111111111",
    },
  ],
  links: [{ href: "https://developer.paypal.com/docs/api/orders/v2/#error-CURRENCY_NOT_SUPPORTED", rel: "information_link" }],
};

beforeEach(() => {
  process.env.PAYPAL_CLIENT_ID = CLIENT_ID;
  process.env.PAYPAL_SECRET = SECRET;
  process.env.PAYPAL_API_BASE = "https://api-m.sandbox.paypal.com";
  process.env.APP_BASE_URL = "https://app.proovra.com";
  delete process.env.BILLING_PAYG_PRICE_CENTS_USD;
  delete process.env.BILLING_PAYG_PRICE_CENTS_EUR;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PayPal 422 diagnostics", () => {
  it("parses details[] issue/field/location/description and drops `value`", () => {
    const [d] = parsePayPalErrorDetails(PAYPAL_422);
    expect(d).toMatchObject({
      issue: "CURRENCY_NOT_SUPPORTED",
      field: "/purchase_units/@reference_id=='default'/amount/currency_code",
      location: "body",
    });
    expect(Object.keys(d!)).not.toContain("value");
  });

  it("an order-create 422 becomes a bounded PAYMENT_PROVIDER_REJECTED with the provider diagnostics in operator metadata", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify(PAYPAL_422), {
          status: 422,
          headers: { "content-type": "application/json", "paypal-debug-id": "09f8161575975" },
        }),
    );

    const err = await createPayPalOrder({
      userId: USER,
      plan: "PAYG",
      currency: "EUR",
      amount: "5.00",
      returnUrl: "https://app.proovra.com/billing?success=1",
      cancelUrl: "https://app.proovra.com/billing?canceled=1",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DomainError);
    const domain = err as DomainError;
    expect(domain.httpStatus).toBe(502);
    expect(domain.publicCode).toBe("PAYMENT_PROVIDER_REJECTED");
    expect(domain.publicMessage).toMatch(/nothing was charged/);
    expect(domain.metadata).toMatchObject({
      provider: "paypal",
      operation: "order_create",
      providerStatus: 422,
      providerErrorName: "UNPROCESSABLE_ENTITY",
      paypalDebugId: "09f8161575975",
      providerIssue: "CURRENCY_NOT_SUPPORTED",
      providerField: "/purchase_units/@reference_id=='default'/amount/currency_code",
    });

    // The developer message names the issue and field too…
    expect(domain.message).toMatch(/CURRENCY_NOT_SUPPORTED/);
    expect(domain.message).toMatch(/09f8161575975/);

    // …and nothing sensitive: no credential, token, payer e-mail, card
    // number, or the echoed request `value`.
    const everything = JSON.stringify({ message: domain.message, metadata: domain.metadata, publicMessage: domain.publicMessage });
    for (const secret of [CLIENT_ID, SECRET, "A21-access-token-DO-NOT-LOG", "jane.doe@example.com", "4111111111111111"]) {
      expect(everything).not.toContain(secret);
    }
    expect(domain.publicMessage).not.toMatch(/CURRENCY|422|debug/i);
  });

  it("a non-JSON PayPal error body is still bounded and carries the debug id", async () => {
    mockFetch(() => new Response("x".repeat(5000), { status: 422, headers: { "paypal-debug-id": "abc123" } }));
    const err = (await getPayPalOrder("ORDER123").catch((e: unknown) => e)) as PayPalHttpError;
    expect(err).toBeInstanceOf(PayPalHttpError);
    expect(err.status).toBe(422);
    expect(err.debugId).toBe("abc123");
    expect(err.message.length).toBeLessThan(400);
  });
});

describe("the exact evidence-credit Orders API request", () => {
  it("sends a CAPTURE order at the server price with a compact custom_id and a credits return URL", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ id: "ORDER-NEW", status: "CREATED", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-NEW" }] }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await createPayPalCheckout({
      userId: USER,
      plan: "PAYG",
      currency: "usd",
      productKey: "EVIDENCE_CREDIT",
    });

    expect(result.mode).toBe("order");
    const orderCall = calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!;
    expect(orderCall.init.method).toBe("POST");
    const body = JSON.parse(String(orderCall.init.body));

    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units).toHaveLength(1);
    const unit = body.purchase_units[0];
    expect(unit.custom_id).toBe(`${USER}::PAYG`);
    expect(unit.custom_id.length).toBeLessThanOrEqual(127);
    expect(unit.amount).toEqual({ currency_code: "USD", value: "5.00" });
    expect(unit.description.length).toBeLessThanOrEqual(127);

    const ctx = body.application_context;
    expect(ctx.return_url).toBe("https://app.proovra.com/billing?success=1&provider=paypal&kind=credits");
    expect(ctx.cancel_url).toBe("https://app.proovra.com/billing?canceled=1&provider=paypal&kind=credits");
    expect(ctx.shipping_preference).toBe("NO_SHIPPING");
    expect(ctx.user_action).toBe("PAY_NOW");

    // No card data, no payer data, no credentials in the request body.
    expect(String(orderCall.init.body)).not.toContain(SECRET);
  });

  it("a malformed price override can never produce a non-decimal amount", async () => {
    process.env.BILLING_PAYG_PRICE_CENTS_USD = "not-a-number";
    mockFetch(() => new Response(JSON.stringify({ id: "O", status: "CREATED" }), { status: 201 }));
    await createPayPalCheckout({ userId: USER, plan: "PAYG", currency: "USD", productKey: "EVIDENCE_CREDIT" });
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!.init.body));
    expect(body.purchase_units[0].amount.value).toMatch(/^\d+\.\d{2}$/);
    expect(Number(body.purchase_units[0].amount.value)).toBeGreaterThan(0);
  });
});
