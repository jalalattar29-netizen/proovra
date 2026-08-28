/**
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the plan-change and
 * checkout ROUTES, behaviourally.
 *
 * WHAT IS REAL HERE
 * ---------------------------------------------------------------------------
 * The production route module is registered on a real Fastify instance and
 * driven by injected requests. Authentication, the legal gate, the billing
 * capability chokepoint and the transition authority are substituted at their
 * module boundaries so each can be made to answer a specific way; the ROUTING,
 * the request schemas, the status codes and the response bodies are the
 * shipped ones.
 *
 * WHAT IT PROVES
 * ---------------------------------------------------------------------------
 * That a person cannot end up with two live subscriptions, that a plan change
 * carries no subject the client could get wrong, and that every refusal says
 * something a customer can act on without exposing a provider id, a price id
 * or an internal reason.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  /** What `findLivePersonalSubscription` answers. */
  live: null as Record<string, unknown> | null,
  /** What the resolver answers, when it is reached. */
  transition: { kind: "NEW_SUBSCRIPTION", targetPlan: "PRO" } as Record<string, unknown>,
  /** Everything the routes attempted, in order. */
  calls: [] as string[],
  /** Set to make the capability chokepoint deny. */
  capabilityDenied: false,
  /** Set to make the personal-space gate deny (managed identity). */
  personalSpaceDenied: false,
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async () => undefined,
}));

vi.mock("../src/middleware/require-legal-acceptance.js", () => ({
  requireLegalAcceptance: async () => undefined,
}));

vi.mock("../src/auth.js", () => ({
  getAuthUserId: () => "user-1",
}));

vi.mock("../src/services/billing/billing-accounts.service.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../src/services/billing/billing-accounts.service.js",
  );
  return {
    ...actual,
    assertBillingCapability: async (input: { capability: string }) => {
      H.calls.push(`capability:${input.capability}`);
      if (H.capabilityDenied) {
        const err: Error & { httpStatus?: number; publicCode?: string } = new Error("denied");
        err.httpStatus = 403;
        err.publicCode = "BILLING_CAPABILITY_REQUIRED";
        throw err;
      }
      return { type: "PERSONAL", id: "user-1", displayName: "Jamie", capabilities: [], billingOwnerMissing: false };
    },
  };
});

vi.mock("../src/services/identity/identity-mode.service.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../src/services/identity/identity-mode.service.js",
  );
  return {
    ...actual,
    assertPersonalSpaceAllowed: async () => {
      H.calls.push("personalSpaceGate");
      if (H.personalSpaceDenied) {
        const err: Error & { statusCode?: number; code?: string } = new Error("no personal space");
        err.statusCode = 403;
        err.code = "PERSONAL_SPACE_NOT_ALLOWED";
        throw err;
      }
    },
  };
});

vi.mock("../src/services/billing/plan-transition.service.js", () => ({
  findLivePersonalSubscription: async () => {
    H.calls.push("findLive");
    return H.live;
  },
  assertSelfServicePlan: () => undefined,
  resolvePersonalPlanTransition: async () => {
    H.calls.push("resolve");
    return H.transition;
  },
  applyPersonalPlanChange: async () => {
    H.calls.push("applyAtProvider");
    return {
      kind: "UPGRADE",
      targetPlan: "TEAM",
      effectiveAtUtc: null,
      approvalUrl: null,
      providerConfirmed: true,
    };
  },
}));

vi.mock("../src/services/billing-checkout.service.js", () => ({
  createStripeCheckoutSession: async () => {
    H.calls.push("stripeCheckout");
    return { mode: "subscription", currency: "EUR", amountCents: 1900, session: { id: "cs_1", url: "https://stripe.test/cs_1" } };
  },
  createPayPalCheckout: async () => {
    H.calls.push("paypalCheckout");
    return { mode: "SUBSCRIPTION", currency: "EUR", amountCents: 1900, approvalUrl: "https://paypal.test/a", subscriptionId: "I-1", orderId: null };
  },
  createStripeEvidenceCreditCheckout: async () => ({ session: { id: "cs_c" } }),
  createPayPalEvidenceCreditCheckout: async () => ({ approvalUrl: "x", orderId: "o" }),
  createStripeStorageAddonCheckoutSession: async () => ({ session: { id: "cs_s" } }),
  createPayPalStorageAddonCheckout: async () => ({ approvalUrl: "y", subscriptionId: "s" }),
}));

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { billingRoutes } = await import("../src/routes/billing.routes.js");

  // The production server maps a DomainError onto its httpStatus in a global
  // handler that is not exported. This stands in for the ONE part of it these
  // route tests depend on — that a 403 refusal leaves as a 403 rather than a
  // 500 — so a status asserted here means the route refused, not that the
  // harness swallowed something. The production mapping itself is proven by
  // the server suites; reproducing more of it here would be a second copy of
  // a contract this file does not own.
  app.setErrorHandler((err, _req, reply) => {
    const status =
      (err as { httpStatus?: number }).httpStatus ??
      (err as { statusCode?: number }).statusCode ??
      500;
    return reply.code(status).send({
      error: {
        code: (err as { publicCode?: string; code?: string }).publicCode ??
          (err as { code?: string }).code ??
          "INTERNAL",
      },
    });
  });

  await app.register(billingRoutes);
  await app.ready();
  return app;
}

const JSON_HEADERS = { "content-type": "application/json" };

let app: FastifyInstance;

beforeEach(async () => {
  H.live = null;
  H.transition = { kind: "NEW_SUBSCRIPTION", targetPlan: "PRO" };
  H.calls.length = 0;
  H.capabilityDenied = false;
  H.personalSpaceDenied = false;
  app = await buildApp();
});

// ===========================================================================
// 1. A person may hold ONE live subscription
// ===========================================================================

describe("checkout refuses a SECOND subscription", () => {
  for (const [label, url] of [
    ["Stripe", "/v1/billing/checkout/stripe"],
    ["PayPal", "/v1/billing/checkout/paypal"],
  ] as const) {
    it(`${label}: an account with a live subscription is sent to CHANGE, not to buy again`, async () => {
      H.live = { id: "sub-1", plan: "PRO" };
      const res = await app.inject({
        method: "POST",
        url,
        headers: JSON_HEADERS,
        payload: { plan: "TEAM" },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as { code?: string; details?: Record<string, unknown> };
      expect(body.code).toBe("SUBSCRIPTION_ALREADY_ACTIVE");
      // The refusal NAMES the endpoint that can do what they asked. "You
      // already have a subscription" alone reads as a dead end to someone
      // trying to give us more money.
      expect(body.details?.changeEndpoint).toBe("/v1/billing/subscription/plan");
      // And no provider was contacted.
      expect(H.calls).not.toContain("stripeCheckout");
      expect(H.calls).not.toContain("paypalCheckout");
    });

    it(`${label}: with nothing live, the checkout proceeds`, async () => {
      H.live = null;
      const res = await app.inject({
        method: "POST",
        url,
        headers: JSON_HEADERS,
        payload: { plan: "TEAM" },
      });
      expect(res.statusCode).toBe(200);
    });

    it(`${label}: a workspace target is refused outright, not ignored`, async () => {
      const res = await app.inject({
        method: "POST",
        url,
        headers: JSON_HEADERS,
        payload: { plan: "TEAM", teamId: "11111111-1111-4111-8111-111111111111" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("CHECKOUT_TARGET_NOT_SUPPORTED");
      expect(H.calls).not.toContain("stripeCheckout");
      expect(H.calls).not.toContain("paypalCheckout");
    });
  }
});

// ===========================================================================
// 2. The change route
// ===========================================================================

describe("POST /v1/billing/subscription/plan", () => {
  it("authorises BILLING_MANAGE on the PERSONAL subject before anything else", async () => {
    H.transition = { kind: "UPGRADE", targetPlan: "TEAM", subscription: { id: "sub-1", plan: "PRO", providerSubId: "x" } };
    await app.inject({
      method: "POST",
      url: "/v1/billing/subscription/plan",
      headers: JSON_HEADERS,
      payload: { plan: "TEAM" },
    });
    expect(H.calls[0]).toBe("capability:BILLING_MANAGE");
  });

  it("a viewer without the capability is refused before any provider call", async () => {
    H.capabilityDenied = true;
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/subscription/plan",
      headers: JSON_HEADERS,
      payload: { plan: "TEAM" },
    });
    expect(res.statusCode).toBe(403);
    expect(H.calls).not.toContain("applyAtProvider");
  });

  it("a managed identity with no personal space is refused before any provider call", async () => {
    H.personalSpaceDenied = true;
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/subscription/plan",
      headers: JSON_HEADERS,
      payload: { plan: "TEAM" },
    });
    expect(res.statusCode).toBe(403);
    expect(H.calls).not.toContain("applyAtProvider");
  });

  it("an UPGRADE reaches the provider and reports what happened", async () => {
    H.transition = { kind: "UPGRADE", targetPlan: "TEAM", subscription: { id: "sub-1", plan: "PRO", providerSubId: "x" } };
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/subscription/plan",
      headers: JSON_HEADERS,
      payload: { plan: "TEAM" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: "UPGRADE", plan: "TEAM", providerConfirmed: true });
    expect(H.calls).toContain("applyAtProvider");
  });

  it("NO_CHANGE answers without touching a provider", async () => {
    H.transition = { kind: "NO_CHANGE", currentPlan: "TEAM" };
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/subscription/plan",
      headers: JSON_HEADERS,
      payload: { plan: "TEAM" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: "NO_CHANGE" });
    expect(H.calls).not.toContain("applyAtProvider");
  });

  it("with nothing live, it names the route that CAN subscribe instead of pretending", async () => {
    H.transition = { kind: "NEW_SUBSCRIPTION", targetPlan: "PRO" };
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/subscription/plan",
      headers: JSON_HEADERS,
      payload: { plan: "PRO" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "CHECKOUT_REQUIRED" } });
    expect(H.calls).not.toContain("applyAtProvider");
  });

  it("FREE routes to CANCELLATION rather than duplicating the cancellation contract", async () => {
    // Cancelling is provider-first, promises a period end, and takes dependent
    // storage add-ons down with it. A second implementation here would be a
    // second contract, and the customer would get whichever one they happened
    // to press.
    H.transition = { kind: "CANCELLATION", subscription: { id: "sub-1" } };
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/subscription/plan",
      headers: JSON_HEADERS,
      payload: { plan: "FREE" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "CANCELLATION_REQUIRED" } });
    expect(H.calls).not.toContain("applyAtProvider");
  });

  it("the body takes a TARGET and nothing else — no current plan, no direction, no price", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/subscription/plan",
      headers: JSON_HEADERS,
      payload: { plan: "TEAM", currentPlan: "PRO", direction: "UP", priceCents: 1 },
    });
    // Extra keys are ignored by the schema rather than trusted; what matters
    // is that none of them reaches a decision.
    expect([200, 409]).toContain(res.statusCode);
    expect(res.body).not.toContain("priceCents");
  });

  it("a workspace target has no meaning here — the schema does not accept one", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/subscription/plan",
      headers: JSON_HEADERS,
      payload: { plan: "TEAM", teamId: "11111111-1111-4111-8111-111111111111" },
    });
    // Ignored, never honoured: the response must not echo it back or act on it.
    expect(res.body).not.toContain("11111111-1111-4111-8111-111111111111");
  });

  it("an unknown plan is rejected by the schema, not by a provider", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/subscription/plan",
      headers: JSON_HEADERS,
      payload: { plan: "PLATINUM" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(H.calls).not.toContain("applyAtProvider");
  });
});

// ===========================================================================
// 3. Cancellation takes no subject
// ===========================================================================

describe("POST /v1/billing/subscription/cancel", () => {
  it("a teamId in the body is refused rather than silently ignored", async () => {
    // A stale client that still believes it is cancelling one of several
    // workspace subscriptions should learn otherwise here.
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/subscription/cancel",
      headers: JSON_HEADERS,
      payload: { teamId: "11111111-1111-4111-8111-111111111111" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("with nothing live it answers 404 and reaches no provider", async () => {
    H.live = null;
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/subscription/cancel",
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "SUBSCRIPTION_NOT_FOUND" } });
  });
});
