/**
 * BATCH K7 (part B) — runtime proof for the self-service billing actions the UI
 * mutation sweep could not drive to their SUCCESS branch.
 *
 *   POST /v1/billing/checkout/stripe                                 billing.routes.ts
 *   POST /v1/billing/checkout/paypal                                 billing.routes.ts
 *   POST /v1/billing/storage-addons/checkout/stripe                  billing.routes.ts
 *   POST /v1/billing/storage-addons/checkout/paypal                  billing.routes.ts
 *   POST /v1/billing/accounts/:type/:id/reconcile                    billing.routes.ts
 *   POST /v1/billing/accounts/:type/:id/payments/:paymentId/recheck  billing.routes.ts
 *   POST /v1/billing/accounts/:type/:id/payments/:paymentId/cancel   billing.routes.ts
 *   POST /v1/billing/accounts/:type/:id/payments/:paymentId/abandon  billing.routes.ts
 *   POST /v1/billing/accounts/:type/:id/retry-storage-cancellation   billing.routes.ts
 *
 * Payloads are the real consumers':
 *   - apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx
 *     (`{ plan, currency }`, `{ addonKey, billingCycle: "MONTHLY", currency }`)
 *   - apps/web/lib/api/billing-accounts.ts
 *     (`{}` for reconcile / recheck / cancel / retry, `{ confirmed }` for abandon)
 *
 * THE EXTERNAL BOUNDARY
 * ---------------------------------------------------------------------------
 * Stripe and PayPal are real third parties. Two states are proven:
 *
 *   1. UNCONFIGURED (the harness default — every provider key is scrubbed):
 *      the bounded contract. Checkouts answer 503 PAYMENTS_UNAVAILABLE before
 *      any request is built; reconciliation reads UNKNOWN and moves nothing it
 *      may not move; a provider-dependent cancellation is 503 and unchanged.
 *   2. A FAKE TRANSPORT, installed only inside the test that needs it: the
 *      provider settings are obviously-fake local strings, PayPal's base is a
 *      loopback address, and `fetch` is intercepted in-process so no socket is
 *      ever opened (the outbound guard stays installed). The fake answers the
 *      exact endpoints the product calls, which proves the request the product
 *      BUILDS and the local effect of each provider answer. It does not prove
 *      that the real provider accepts it — that is the external dependency.
 *
 * Disposable local PostgreSQL + Redis only — the harness refuses anything else.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedOrganizationTenant,
  seedPersonalTenant,
  type FixtureDeps,
  type PersonalTenant,
} from "./point7/product-fixtures.js";

const STRIPE_API = "https://api.stripe.com/v1";
const PAYPAL_FAKE_BASE = "http://127.0.0.1:9/k7-paypal-fake";

type ProviderCall = { url: string; method: string; body: string | null };
type FakeAnswer = { status?: number; body: unknown } | undefined;

describe("K7-B — self-service billing actions (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let pricing: typeof import("../src/services/billing-pricing.service.js");
  let paypalPolicy: typeof import("../src/services/paypal-checkout-policy.service.js");
  let deps: FixtureDeps;
  const tag = `k7b-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

  const call = (method: "POST", url: string, token: string, payload: unknown) =>
    harness.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: payload as never,
    });

  // Response bodies are asserted structurally below; a loose read type keeps each assertion one line.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (res: { body: string }) => JSON.parse(res.body) as Record<string, any>;

  /** Fire-and-forget billing audits (`void emitTenantAudit(...)`) land after the response. */
  function waitForAudit(where: Record<string, unknown>) {
    return vi.waitFor(
      async () => {
        const row = await prisma.adminAuditLog.findFirst({ where, orderBy: { createdAt: "desc" } });
        if (!row) throw new Error(`audit row not yet written: ${JSON.stringify(where)}`);
        return row;
      },
      { timeout: 5_000, interval: 25 },
    );
  }

  /**
   * Run `fn` with the provider settings present and `fetch` answered in-process.
   * Anything that is not a provider URL goes to the real `fetch` unchanged (and
   * therefore still meets the outbound guard).
   */
  async function withFakeProviders<T>(
    answer: (req: ProviderCall) => FakeAnswer,
    fn: () => Promise<T>,
  ): Promise<{ result: T; calls: ProviderCall[] }> {
    const settings: Record<string, string> = {
      STRIPE_SECRET_KEY: "k7-local-fake-stripe-key",
      PAYPAL_CLIENT_ID: "k7-local-fake-paypal-client",
      PAYPAL_SECRET: "k7-local-fake-paypal-value",
      PAYPAL_API_BASE: PAYPAL_FAKE_BASE,
      PAYPAL_PRO_PLAN_ID_USD: "P-K7FAKEPROUSD",
      PAYPAL_PLAN_STORAGE_PERSONAL_10_GB_USD: "P-K7FAKESTORAGE10USD",
    };
    const previous = new Map(Object.keys(settings).map((k) => [k, process.env[k]]));
    Object.assign(process.env, settings);
    const realFetch = globalThis.fetch;
    const calls: ProviderCall[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (!url.startsWith(STRIPE_API) && !url.startsWith(PAYPAL_FAKE_BASE)) {
        return realFetch(input as never, init);
      }
      const req: ProviderCall = {
        url,
        method: init?.method ?? "GET",
        body: init?.body == null ? null : String(init.body),
      };
      calls.push(req);
      const out = answer(req);
      return new Response(JSON.stringify(out?.body ?? { error: { code: "resource_missing" } }), {
        status: out ? (out.status ?? 200) : 404,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      return { result: await fn(), calls };
    } finally {
      spy.mockRestore();
      for (const [k, v] of previous) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  const paypalToken = (req: ProviderCall): FakeAnswer =>
    req.url === `${PAYPAL_FAKE_BASE}/v1/oauth2/token`
      ? { body: { access_token: "k7-fake-access" } }
      : undefined;

  const form = (body: string | null) => new URLSearchParams(body ?? "");

  async function payer(plan: "FREE" | "PRO" = "FREE"): Promise<PersonalTenant> {
    return seedPersonalTenant(deps, plan);
  }

  async function seedPayment(
    userId: string,
    provider: "STRIPE" | "PAYPAL",
    status: "PENDING" | "SUCCEEDED",
    extra: { teamId?: string; amountCents?: number } = {},
  ) {
    const ref =
      provider === "STRIPE"
        ? `cs_k7_${randomUUID().replace(/-/g, "")}`
        : `K7${randomUUID().replace(/-/g, "").slice(0, 15).toUpperCase()}`;
    return prisma.payment.create({
      data: {
        userId,
        provider,
        providerPaymentId: ref,
        amountCents: extra.amountCents ?? 499,
        currency: "USD",
        status,
        teamId: extra.teamId ?? null,
      },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    pricing = await import("../src/services/billing-pricing.service.js");
    paypalPolicy = await import("../src/services/paypal-checkout-policy.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET!,
          60 * 60,
        ),
    };
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  // ===========================================================================
  // Plan checkouts
  // ===========================================================================

  describe("POST /v1/billing/checkout/stripe", () => {
    const url = "/v1/billing/checkout/stripe";

    it("unconfigured: the bounded 503 PAYMENTS_UNAVAILABLE, no provider request, no audit, no subscription", async () => {
      const t = await payer();
      const res = await call("POST", url, t.owner.token, { plan: "PRO", currency: "USD" });
      expect(res.statusCode, res.body).toBe(503);
      expect(json(res).error.code).toBe("PAYMENTS_UNAVAILABLE");
      expect(res.body).not.toMatch(/STRIPE_|secret/i);
      expect(await prisma.subscription.count({ where: { userId: t.owner.userId } })).toBe(0);
      expect(
        await prisma.adminAuditLog.count({ where: { userId: t.owner.userId, action: "billing.checkout_stripe_created" } }),
      ).toBe(0);
    });

    it("fake transport: a subscription session built from server-owned values, returned 200 and audited with the session id", async () => {
      const t = await payer();
      const sessionId = `cs_k7_${randomUUID().slice(0, 8)}`;
      const { result: res, calls } = await withFakeProviders(
        (req) =>
          req.url === `${STRIPE_API}/checkout/sessions` && req.method === "POST"
            ? { body: { id: sessionId, url: "https://checkout.example.invalid/k7" } }
            : undefined,
        () => call("POST", url, t.owner.token, { plan: "PRO", currency: "USD" }),
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toMatchObject({ provider: "STRIPE", mode: "subscription", session: { id: sessionId } });

      expect(calls).toHaveLength(1);
      const sent = form(calls[0]!.body);
      expect(sent.get("mode")).toBe("subscription");
      expect(sent.get("metadata[userId]")).toBe(t.owner.userId);
      expect(sent.get("metadata[plan]")).toBe("PRO");
      expect(sent.get("metadata[productKey]")).toBe("PLAN");
      expect(sent.get("metadata[amountCents]")).toBe(String(pricing.getPlanPriceCents("PRO", "USD")));
      expect(sent.get("subscription_data[metadata][userId]")).toBe(t.owner.userId);
      expect(sent.get("metadata[teamId]")).toBeNull();

      const audit = await waitForAudit({ action: "billing.checkout_stripe_created", userId: t.owner.userId });
      expect(audit).toMatchObject({ resourceId: sessionId, outcome: "success", resourceType: "billing", workspaceId: null });
      expect(audit.metadata).toMatchObject({ plan: "PRO", currency: "USD", mode: "subscription", teamId: null });
    });

    it("refused: a live subscriber gets 409 SUBSCRIPTION_ALREADY_ACTIVE and a workspace target is 400 — the provider is never asked", async () => {
      const t = await payer("PRO");
      await prisma.subscription.create({
        data: { userId: t.owner.userId, provider: "STRIPE", providerSubId: `sub_k7_${randomUUID().slice(0, 8)}`, status: "ACTIVE", plan: "PRO" },
      });
      const other = await payer();
      const { result, calls } = await withFakeProviders(
        () => ({ body: { id: "cs_should_not_exist" } }),
        async () => ({
          dup: await call("POST", url, t.owner.token, { plan: "TEAM", currency: "USD" }),
          target: await call("POST", url, other.owner.token, { plan: "PRO", teamId: harness.fixtures.teamA.teamId }),
        }),
      );
      expect(result.dup.statusCode).toBe(409);
      expect(json(result.dup)).toMatchObject({
        code: "SUBSCRIPTION_ALREADY_ACTIVE",
        details: { requestedPlan: "TEAM", changeEndpoint: "/v1/billing/subscription/plan" },
      });
      expect(result.target.statusCode).toBe(400);
      expect(calls).toEqual([]);
      expect(await prisma.subscription.count({ where: { userId: t.owner.userId } })).toBe(1);
    });
  });

  describe("POST /v1/billing/checkout/paypal", () => {
    const url = "/v1/billing/checkout/paypal";

    it("unconfigured: the bounded 503 PAYMENTS_UNAVAILABLE and no audit", async () => {
      const t = await payer();
      const res = await call("POST", url, t.owner.token, { plan: "PRO", currency: "USD" });
      expect(res.statusCode, res.body).toBe(503);
      expect(json(res).error.code).toBe("PAYMENTS_UNAVAILABLE");
      expect(res.body).not.toMatch(/PAYPAL_|secret/i);
      expect(
        await prisma.adminAuditLog.count({ where: { userId: t.owner.userId, action: "billing.checkout_paypal_created" } }),
      ).toBe(0);
    });

    it("fake transport: the configured PRO plan is checked ACTIVE, a subscription is created bound to the payer, 200 and audited", async () => {
      const t = await payer();
      const subscriptionId = `I-K7${randomUUID().slice(0, 8).toUpperCase()}`;
      const { result: res, calls } = await withFakeProviders(
        (req) =>
          paypalToken(req) ??
          (req.url === `${PAYPAL_FAKE_BASE}/v1/billing/plans/P-K7FAKEPROUSD`
            ? { body: { id: "P-K7FAKEPROUSD", status: "ACTIVE" } }
            : req.url === `${PAYPAL_FAKE_BASE}/v1/billing/subscriptions` && req.method === "POST"
              ? { body: { id: subscriptionId, status: "APPROVAL_PENDING", links: [{ rel: "approve", href: "https://paypal.example.invalid/approve" }] } }
              : undefined),
        () => call("POST", url, t.owner.token, { plan: "PRO", currency: "USD" }),
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toMatchObject({ provider: "PAYPAL", mode: "subscription", subscription: { id: subscriptionId } });

      const create = calls.find((c) => c.url.endsWith("/v1/billing/subscriptions"));
      const sent = JSON.parse(create!.body!) as { plan_id: string; custom_id: string };
      expect(sent.plan_id).toBe("P-K7FAKEPROUSD");
      // Read back with the webhook's own parser — the binding the webhook will trust.
      const { parsePayPalCustomId } = await import("../src/services/paypal-checkout-policy.service.js");
      expect(parsePayPalCustomId(sent.custom_id)).toEqual({ userId: t.owner.userId, plan: "PRO", teamId: null });

      const audit = await waitForAudit({ action: "billing.checkout_paypal_created", userId: t.owner.userId });
      expect(audit).toMatchObject({ resourceId: subscriptionId, outcome: "success" });
      expect(audit.metadata).toMatchObject({ plan: "PRO", mode: "subscription", currency: "USD" });
    });

    it("refused: a live subscriber gets 409 SUBSCRIPTION_ALREADY_ACTIVE — PayPal is never asked", async () => {
      const t = await payer("PRO");
      await prisma.subscription.create({
        data: { userId: t.owner.userId, provider: "PAYPAL", providerSubId: `I-K7LIVE${randomUUID().slice(0, 6)}`, status: "ACTIVE", plan: "PRO" },
      });
      const { result, calls } = await withFakeProviders(
        () => ({ body: {} }),
        () => call("POST", url, t.owner.token, { plan: "PRO", currency: "USD" }),
      );
      expect(result.statusCode).toBe(409);
      expect(json(result).code).toBe("SUBSCRIPTION_ALREADY_ACTIVE");
      expect(calls).toEqual([]);
    });
  });

  // ===========================================================================
  // Storage add-on checkouts
  // ===========================================================================

  const addonBody = { addonKey: "PERSONAL_10_GB", billingCycle: "MONTHLY", currency: "USD" };

  describe("POST /v1/billing/storage-addons/checkout/stripe", () => {
    const url = "/v1/billing/storage-addons/checkout/stripe";

    it("unconfigured: a PRO payer reaches the provider boundary and gets the bounded 503", async () => {
      const t = await payer("PRO");
      const res = await call("POST", url, t.owner.token, addonBody);
      expect(res.statusCode, res.body).toBe(503);
      expect(json(res).error.code).toBe("PAYMENTS_UNAVAILABLE");
      expect(await prisma.workspaceStorageAddon.count({ where: { ownerUserId: t.owner.userId } })).toBe(0);
    });

    it("fake transport: a recurring monthly add-on session bound to the payer, 200 and audited", async () => {
      const t = await payer("PRO");
      const sessionId = `cs_k7_addon_${randomUUID().slice(0, 8)}`;
      const { result: res, calls } = await withFakeProviders(
        (req) =>
          req.url === `${STRIPE_API}/checkout/sessions` ? { body: { id: sessionId } } : undefined,
        () => call("POST", url, t.owner.token, addonBody),
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toMatchObject({ provider: "STRIPE", mode: "subscription", session: { id: sessionId } });
      const sent = form(calls[0]!.body);
      expect(sent.get("mode")).toBe("subscription");
      expect(sent.get("metadata[userId]")).toBe(t.owner.userId);
      expect(sent.get("metadata[storageAddonKey]")).toBe("PERSONAL_10_GB");
      expect(sent.get("metadata[workspacePlan]")).toBe("PRO");
      expect(sent.get("line_items[0][price_data][recurring][interval]")).toBe("month");
      expect(sent.get("metadata[amountCents]")).toBe(
        String(pricing.getStorageAddonPriceCents({ addonKey: "PERSONAL_10_GB", currency: "USD" })),
      );

      const audit = await waitForAudit({ action: "billing.storage_addon_checkout_stripe_created", userId: t.owner.userId });
      expect(audit).toMatchObject({ resourceId: sessionId, outcome: "success" });
      expect(audit.metadata).toMatchObject({ addonKey: "PERSONAL_10_GB", billingCycle: "MONTHLY", workspacePlan: "PRO" });
    });

    // main 1a3f3a1c..659e3090 (commercial billing residuals) made storage
    // purchasable on FREE through the explicit FREE_STORAGE source, so the
    // former "FREE is refused" proof is now the FREE success branch.
    it("fake transport: a FREE payer buys storage too (FREE_STORAGE), bound to the payer's FREE plan", async () => {
      const t = await payer("FREE");
      const sessionId = `cs_k7_free_addon_${randomUUID().slice(0, 8)}`;
      const { result: res, calls } = await withFakeProviders(
        (req) =>
          req.url === `${STRIPE_API}/checkout/sessions` ? { body: { id: sessionId } } : undefined,
        () => call("POST", url, t.owner.token, addonBody),
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toMatchObject({ provider: "STRIPE", mode: "subscription", session: { id: sessionId } });
      const sent = form(calls[0]!.body);
      expect(sent.get("metadata[userId]")).toBe(t.owner.userId);
      expect(sent.get("metadata[workspacePlan]")).toBe("FREE");
    });
  });

  describe("POST /v1/billing/storage-addons/checkout/paypal", () => {
    const url = "/v1/billing/storage-addons/checkout/paypal";

    it("unconfigured: the bounded 503 PAYMENTS_UNAVAILABLE", async () => {
      const t = await payer("PRO");
      const res = await call("POST", url, t.owner.token, addonBody);
      expect(res.statusCode, res.body).toBe(503);
      expect(json(res).error.code).toBe("PAYMENTS_UNAVAILABLE");
    });

    it("fake transport: the configured storage plan is subscribed for the payer, 200 and audited", async () => {
      const t = await payer("PRO");
      const subscriptionId = `I-K7ADD${randomUUID().slice(0, 6).toUpperCase()}`;
      const { result: res, calls } = await withFakeProviders(
        (req) =>
          paypalToken(req) ??
          (req.url.startsWith(`${PAYPAL_FAKE_BASE}/v1/billing/plans/`)
            ? { body: { id: "P-K7FAKESTORAGE10USD", status: "ACTIVE" } }
            : req.url === `${PAYPAL_FAKE_BASE}/v1/billing/subscriptions` && req.method === "POST"
              ? { body: { id: subscriptionId, status: "APPROVAL_PENDING", links: [] } }
              : undefined),
        () => call("POST", url, t.owner.token, addonBody),
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toMatchObject({ provider: "PAYPAL", mode: "subscription", subscription: { id: subscriptionId } });
      const create = calls.find((c) => c.url.endsWith("/v1/billing/subscriptions") && c.method === "POST");
      const sent = JSON.parse(create!.body!) as { plan_id: string; custom_id: string };
      expect(sent.plan_id).toBe("P-K7FAKESTORAGE10USD");
      // The custom_id is the COMPACT sa1 form: the JSON object it replaced was
      // 147+ characters for a UUID payer, over PayPal's 127-character limit,
      // so PayPal refused every storage checkout with 400 INVALID_REQUEST.
      // Cycle (always MONTHLY) and workspace plan are not carried: the webhook
      // re-reads the plan from the database when it applies the add-on.
      expect(sent.custom_id).toBe(`sa1|${t.owner.userId}|-|p10`);
      expect(sent.custom_id.length).toBeLessThanOrEqual(paypalPolicy.PAYPAL_CUSTOM_ID_MAX_LENGTH);
      // Decoded by THE parser the webhook and the return route use — the
      // identity PayPal hands back is exactly the payer, no team, 10 GB.
      expect(paypalPolicy.parsePayPalStorageAddonCustomId(sent.custom_id)).toEqual({
        userId: t.owner.userId,
        teamId: null,
        storageAddonKey: "PERSONAL_10_GB",
      });
      // A storage custom_id must never be readable as a PLAN checkout.
      expect(paypalPolicy.parsePayPalCustomId(sent.custom_id)).toEqual({
        userId: null,
        plan: null,
        teamId: null,
      });

      const audit = await waitForAudit({ action: "billing.storage_addon_checkout_paypal_created", userId: t.owner.userId });
      expect(audit).toMatchObject({ resourceId: subscriptionId, outcome: "success" });
    });

    it("a configured plan PayPal does not report ACTIVE is the bounded 503 — no subscription is created", async () => {
      // A FREE payer (FREE_STORAGE) reaches the provider. The plan lookup
      // answers without an ACTIVE status; this used to be a bare 500.
      const t = await payer("FREE");
      const { result, calls } = await withFakeProviders(
        (req) =>
          paypalToken(req) ??
          (req.url.startsWith(`${PAYPAL_FAKE_BASE}/v1/billing/plans/`)
            ? { body: { id: "P-K7FAKESTORAGE10USD", status: "INACTIVE" } }
            : undefined),
        () => call("POST", url, t.owner.token, addonBody),
      );
      expect(result.statusCode, result.body).toBe(503);
      expect(json(result).error.code).toBe("PAYMENTS_UNAVAILABLE");
      expect(result.body).not.toContain("P-K7FAKESTORAGE10USD");
      expect(calls.some((c) => c.url.endsWith("/v1/billing/subscriptions"))).toBe(false);
      expect(await prisma.workspaceStorageAddon.count({ where: { ownerUserId: t.owner.userId } })).toBe(0);
    });
  });

  // ===========================================================================
  // Account reconciliation and dependent-cancellation retry
  // ===========================================================================

  async function seedOrphanedAddon(ownerUserId: string, state: "NONE" | "RETRY_SCHEDULED" = "NONE") {
    return prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId,
        teamId: null,
        addonKey: "PERSONAL_10_GB",
        extraStorageBytes: BigInt(10 * 1024 ** 3),
        billingCycle: "MONTHLY",
        status: "ACTIVE",
        paymentProvider: "STRIPE",
        externalSubscriptionId: `sub_k7_addon_${randomUUID().slice(0, 12)}`,
        currency: "USD",
        dependentCancellationState: state,
        ...(state === "RETRY_SCHEDULED"
          ? { dependentCancellationAttemptCount: 1, dependentCancellationNextRetryAtUtc: new Date() }
          : {}),
      },
    });
  }

  describe("POST /v1/billing/accounts/:type/:id/reconcile", () => {
    it("unconfigured: 200, provider state UNKNOWN moves no payment, the orphaned add-on gets a durable retry obligation, audited", async () => {
      const t = await payer("PRO");
      const base = await prisma.subscription.create({
        data: { userId: t.owner.userId, provider: "STRIPE", providerSubId: `sub_k7_base_${randomUUID().slice(0, 8)}`, status: "CANCELED", plan: "PRO" },
      });
      const addon = await seedOrphanedAddon(t.owner.userId);
      const pending = await seedPayment(t.owner.userId, "STRIPE", "PENDING");

      const res = await call("POST", `/v1/billing/accounts/PERSONAL/${t.owner.userId}/reconcile`, t.owner.token, {});
      expect(res.statusCode, res.body).toBe(200);
      const body = json(res);
      expect(body.summary).toMatchObject({ creditsRestored: 0, paymentsRecorded: 0 });
      expect(body.summary.unavailable).toBeGreaterThanOrEqual(2);
      expect(body.summary.actionRequired).toBeGreaterThanOrEqual(1);

      expect((await prisma.payment.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("PENDING");
      const after = await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: addon.id } });
      expect(after).toMatchObject({
        status: "ACTIVE",
        dependentCancellationState: "RETRY_SCHEDULED",
        dependentCancellationTriggeredBySubscriptionId: base.id,
        dependentCancellationAttemptCount: 1,
        dependentCancellationReasonCode: "PROVIDER_UNAVAILABLE",
      });
      expect(after.dependentCancellationRequestedAtUtc).not.toBeNull();

      const audit = await waitForAudit({ action: "billing.account_reconciled", userId: t.owner.userId });
      expect(audit).toMatchObject({ outcome: "success", resourceId: t.owner.userId });
      expect(audit.metadata).toMatchObject({ accountType: "PERSONAL", result: body.outcome });
    });

    it("fake transport: a paid credit session whose webhook was lost is granted exactly once from the catalog", async () => {
      const t = await payer("FREE");
      const price = pricing.getPlanPriceCents("PAYG", "USD");
      const paid = await seedPayment(t.owner.userId, "STRIPE", "SUCCEEDED", { amountCents: price });
      const { result: res } = await withFakeProviders(
        (req) =>
          req.url.startsWith(`${STRIPE_API}/checkout/sessions/${paid.providerPaymentId}`)
            ? {
                body: {
                  id: paid.providerPaymentId,
                  payment_status: "paid",
                  status: "complete",
                  amount_total: price,
                  currency: "usd",
                  created: Math.floor(Date.now() / 1000) - 60,
                },
              }
            : undefined,
        () => call("POST", `/v1/billing/accounts/PERSONAL/${t.owner.userId}/reconcile`, t.owner.token, {}),
      );
      expect(res.statusCode, res.body).toBe(200);
      const { EVIDENCE_CREDIT_PRODUCT } = await import("@proovra/shared-billing");
      expect(json(res).summary.creditsRestored).toBe(EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase);
      const ledger = await prisma.evidenceCreditLedgerEntry.findMany({
        where: { userId: t.owner.userId, entryType: "PURCHASE", providerRef: paid.providerPaymentId },
      });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.creditsDelta).toBe(EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase);
      expect(
        (await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).credits,
      ).toBe(EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase);
    });

    it("refused: another person's account is 404 BILLING_ACCOUNT_NOT_FOUND; an organization billing role is 403 BILLING_CAPABILITY_REQUIRED", async () => {
      const t = await payer("PRO");
      const addon = await seedOrphanedAddon(t.owner.userId);
      await prisma.subscription.create({
        data: { userId: t.owner.userId, provider: "STRIPE", providerSubId: `sub_k7_base_${randomUUID().slice(0, 8)}`, status: "CANCELED", plan: "PRO" },
      });
      const stranger = await payer();
      const foreign = await call("POST", `/v1/billing/accounts/PERSONAL/${t.owner.userId}/reconcile`, stranger.owner.token, {});
      expect(foreign.statusCode).toBe(404);
      expect(json(foreign).error.code).toBe("BILLING_ACCOUNT_NOT_FOUND");
      const missing = await call("POST", `/v1/billing/accounts/PERSONAL/${randomUUID()}/reconcile`, stranger.owner.token, {});
      expect(missing.statusCode).toBe(404);
      expect(missing.body).toBe(foreign.body.replace(json(foreign).error.requestId, json(missing).error.requestId));

      const org = await seedOrganizationTenant(deps);
      const orgRes = await call("POST", `/v1/billing/accounts/ORGANIZATION/${org.organizationId}/reconcile`, org.owner.token, {});
      expect(orgRes.statusCode).toBe(403);
      expect(json(orgRes).error.code).toBe("BILLING_CAPABILITY_REQUIRED");

      expect((await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: addon.id } })).dependentCancellationState).toBe("NONE");
      expect(await prisma.adminAuditLog.count({ where: { action: "billing.account_reconciled", userId: { in: [stranger.owner.userId, org.owner.userId] } } })).toBe(0);
    });
  });

  describe("POST /v1/billing/accounts/:type/:id/retry-storage-cancellation", () => {
    it("unconfigured: 200 PENDING — the outstanding obligation is attempted and its failure recorded durably, audited", async () => {
      const t = await payer("PRO");
      const addon = await seedOrphanedAddon(t.owner.userId, "RETRY_SCHEDULED");
      const res = await call("POST", `/v1/billing/accounts/PERSONAL/${t.owner.userId}/retry-storage-cancellation`, t.owner.token, {});
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toMatchObject({
        outcome: "PENDING",
        supportRequired: false,
        summary: { status: "RETRY_SCHEDULED", affectedCount: 1 },
      });
      const after = await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: addon.id } });
      expect(after).toMatchObject({
        dependentCancellationState: "RETRY_SCHEDULED",
        dependentCancellationAttemptCount: 2,
        dependentCancellationReasonCode: "PROVIDER_UNAVAILABLE",
        dependentCancellationLeaseUntilUtc: null,
      });
      expect(after.dependentCancellationFailedAtUtc).not.toBeNull();

      const audit = await waitForAudit({ action: "billing.storage_addon_cancellation_retry", userId: t.owner.userId });
      expect(audit).toMatchObject({ outcome: "success", resourceId: t.owner.userId });
      expect(audit.metadata).toMatchObject({ accountType: "PERSONAL", attempted: 1, confirmed: 0, failed: 1 });
    });

    it("fake transport: Stripe confirms cancel-at-period-end, the obligation is CONFIRMED and the outcome UPDATED", async () => {
      const t = await payer("PRO");
      const addon = await seedOrphanedAddon(t.owner.userId, "RETRY_SCHEDULED");
      const { result: res, calls } = await withFakeProviders(
        (req) =>
          req.url === `${STRIPE_API}/subscriptions/${addon.externalSubscriptionId}` && req.method === "POST"
            ? { body: { id: addon.externalSubscriptionId, cancel_at_period_end: true } }
            : undefined,
        () => call("POST", `/v1/billing/accounts/PERSONAL/${t.owner.userId}/retry-storage-cancellation`, t.owner.token, {}),
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toEqual({ outcome: "UPDATED", summary: null, supportRequired: false });
      expect(form(calls[0]!.body).get("cancel_at_period_end")).toBe("true");
      const after = await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: addon.id } });
      expect(after.dependentCancellationState).toBe("CONFIRMED");
      expect(after.dependentCancellationConfirmedAtUtc).not.toBeNull();
      expect(after.canceledAtUtc).not.toBeNull();
    });

    it("refused: another person is 404, an organization billing role is 403 — the obligation is not attempted", async () => {
      const t = await payer("PRO");
      const addon = await seedOrphanedAddon(t.owner.userId, "RETRY_SCHEDULED");
      const stranger = await payer();
      const foreign = await call("POST", `/v1/billing/accounts/PERSONAL/${t.owner.userId}/retry-storage-cancellation`, stranger.owner.token, {});
      expect(foreign.statusCode).toBe(404);
      expect(json(foreign).error.code).toBe("BILLING_ACCOUNT_NOT_FOUND");
      const org = await seedOrganizationTenant(deps);
      const orgRes = await call("POST", `/v1/billing/accounts/ORGANIZATION/${org.organizationId}/retry-storage-cancellation`, org.owner.token, {});
      expect(orgRes.statusCode).toBe(403);
      expect(json(orgRes).error.code).toBe("BILLING_CAPABILITY_REQUIRED");
      expect((await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: addon.id } })).dependentCancellationAttemptCount).toBe(1);
    });
  });

  // ===========================================================================
  // One pending payment — recheck / cancel / abandon
  // ===========================================================================

  const paymentUrl = (userId: string, paymentId: string, leg: string) =>
    `/v1/billing/accounts/PERSONAL/${userId}/payments/${paymentId}/${leg}`;

  describe("POST .../payments/:paymentId/recheck", () => {
    it("unconfigured: 200 PROVIDER_UNAVAILABLE and the row is untouched; audited against the payment", async () => {
      const t = await payer();
      const p = await seedPayment(t.owner.userId, "STRIPE", "PENDING");
      const res = await call("POST", paymentUrl(t.owner.userId, p.id, "recheck"), t.owner.token, {});
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toMatchObject({ outcome: "PROVIDER_UNAVAILABLE", status: "PENDING", resumeUrl: null });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING");
      const audit = await waitForAudit({ action: "billing.payment_rechecked", userId: t.owner.userId });
      expect(audit).toMatchObject({ outcome: "success", resourceId: p.id });
      expect(audit.metadata).toMatchObject({ accountType: "PERSONAL", result: "PROVIDER_UNAVAILABLE", status: "PENDING" });
    });

    it("fake transport: Stripe reports the session paid, the row becomes SUCCEEDED with the provider time", async () => {
      const t = await payer();
      const p = await seedPayment(t.owner.userId, "STRIPE", "PENDING");
      const created = Math.floor(Date.now() / 1000) - 120;
      const { result: res } = await withFakeProviders(
        (req) =>
          req.url.startsWith(`${STRIPE_API}/checkout/sessions/${p.providerPaymentId}`)
            ? { body: { id: p.providerPaymentId, payment_status: "paid", status: "complete", amount_total: 499, currency: "usd", created } }
            : undefined,
        () => call("POST", paymentUrl(t.owner.userId, p.id, "recheck"), t.owner.token, {}),
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toMatchObject({ outcome: "UPDATED", status: "SUCCEEDED" });
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
      expect(row.status).toBe("SUCCEEDED");
      expect(row.providerStateAtUtc?.getTime()).toBe(created * 1000);
    });

    it("refused: another person is 404 BILLING_ACCOUNT_NOT_FOUND; the payer naming someone else's payment is 404 PAYMENT_NOT_FOUND", async () => {
      const t = await payer();
      const p = await seedPayment(t.owner.userId, "STRIPE", "PENDING");
      const stranger = await payer();
      const foreignPayment = await seedPayment(stranger.owner.userId, "STRIPE", "PENDING");
      const foreign = await call("POST", paymentUrl(t.owner.userId, p.id, "recheck"), stranger.owner.token, {});
      expect(foreign.statusCode).toBe(404);
      expect(json(foreign).error.code).toBe("BILLING_ACCOUNT_NOT_FOUND");
      const crossed = await call("POST", paymentUrl(t.owner.userId, foreignPayment.id, "recheck"), t.owner.token, {});
      expect(crossed.statusCode).toBe(404);
      expect(json(crossed).error.code).toBe("PAYMENT_NOT_FOUND");
      expect(await prisma.adminAuditLog.count({ where: { action: "billing.payment_rechecked", resourceId: { in: [p.id, foreignPayment.id] } } })).toBe(0);
    });
  });

  describe("POST .../payments/:paymentId/cancel", () => {
    it("unconfigured: 503 PAYMENT_PROVIDER_UNAVAILABLE — nothing is marked cancelled locally, nothing audited", async () => {
      const t = await payer();
      const p = await seedPayment(t.owner.userId, "STRIPE", "PENDING");
      const res = await call("POST", paymentUrl(t.owner.userId, p.id, "cancel"), t.owner.token, {});
      expect(res.statusCode, res.body).toBe(503);
      expect(json(res).error.code).toBe("PAYMENT_PROVIDER_UNAVAILABLE");
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING");
      expect(await prisma.adminAuditLog.count({ where: { action: "billing.payment_cancelled", userId: t.owner.userId } })).toBe(0);
    });

    it("fake transport: an open session is expired at Stripe, the row takes Stripe's answer, 200 CANCELLED and audited", async () => {
      const t = await payer();
      const p = await seedPayment(t.owner.userId, "STRIPE", "PENDING");
      const now = Math.floor(Date.now() / 1000);
      const { result: res, calls } = await withFakeProviders(
        (req) => {
          const session = `${STRIPE_API}/checkout/sessions/${p.providerPaymentId}`;
          if (req.url === `${session}/expire` && req.method === "POST") {
            return { body: { id: p.providerPaymentId, payment_status: "unpaid", status: "expired", expires_at: now } };
          }
          if (req.url.startsWith(session) && req.method === "GET") {
            return { body: { id: p.providerPaymentId, payment_status: "unpaid", status: "open", created: now - 300 } };
          }
          return undefined;
        },
        () => call("POST", paymentUrl(t.owner.userId, p.id, "cancel"), t.owner.token, {}),
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toMatchObject({ outcome: "CANCELLED", status: "EXPIRED" });
      expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("EXPIRED");
      const audit = await waitForAudit({ action: "billing.payment_cancelled", userId: t.owner.userId });
      expect(audit).toMatchObject({ outcome: "success", resourceId: p.id });
      expect(audit.metadata).toMatchObject({ result: "CANCELLED", status: "EXPIRED" });
    });

    it("refused: a PayPal payment is 409 PAYMENT_CANCELLATION_UNSUPPORTED; an organization billing role is 403", async () => {
      const t = await payer();
      const pp = await seedPayment(t.owner.userId, "PAYPAL", "PENDING");
      const unsupported = await call("POST", paymentUrl(t.owner.userId, pp.id, "cancel"), t.owner.token, {});
      expect(unsupported.statusCode).toBe(409);
      expect(json(unsupported).error.code).toBe("PAYMENT_CANCELLATION_UNSUPPORTED");
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: pp.id } })).status).toBe("PENDING");

      const org = await seedOrganizationTenant(deps);
      const orgPayment = await seedPayment(org.owner.userId, "STRIPE", "PENDING", { teamId: org.workspaceId });
      const orgRes = await call(
        "POST",
        `/v1/billing/accounts/ORGANIZATION/${org.organizationId}/payments/${orgPayment.id}/cancel`,
        org.owner.token,
        {},
      );
      expect(orgRes.statusCode).toBe(403);
      expect(json(orgRes).error.code).toBe("BILLING_CAPABILITY_REQUIRED");
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: orgPayment.id } })).status).toBe("PENDING");
    });
  });

  describe("POST .../payments/:paymentId/abandon", () => {
    it("provider unreachable: first answer asks for confirmation, the confirmed request records ABANDONED; both audited against the payment", async () => {
      const t = await payer();
      const p = await seedPayment(t.owner.userId, "PAYPAL", "PENDING");
      const url = paymentUrl(t.owner.userId, p.id, "abandon");

      const ask = await call("POST", url, t.owner.token, { confirmed: false });
      expect(ask.statusCode, ask.body).toBe(200);
      expect(json(ask)).toMatchObject({
        outcome: "ABANDON_CONFIRMATION_REQUIRED",
        status: "PENDING",
        providerFailure: "PROVIDER_UNAVAILABLE",
        confirmation: { canConfirmAbandon: true },
      });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING");
      const asked = await waitForAudit({ action: "billing.payment_abandoned", userId: t.owner.userId });
      expect(asked).toMatchObject({ resourceId: p.id });
      expect(asked.metadata).toMatchObject({ act: "CONFIRMATION_REQUESTED" });

      const confirmed = await call("POST", url, t.owner.token, { confirmed: true });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(json(confirmed)).toMatchObject({ outcome: "ABANDONED", status: "ABANDONED" });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("ABANDONED");
      await vi.waitFor(
        async () => {
          const rows = await prisma.adminAuditLog.findMany({
            where: { action: "billing.payment_abandoned", userId: t.owner.userId, resourceId: p.id },
          });
          expect(rows.map((r) => (r.metadata as { act?: string }).act).sort()).toEqual([
            "CONFIRMATION_REQUESTED",
            "LOCAL_ABANDONMENT",
          ]);
        },
        { timeout: 5_000, interval: 25 },
      );

      // Idempotent: a repeat changes nothing.
      const again = await call("POST", url, t.owner.token, { confirmed: true });
      expect(json(again)).toMatchObject({ outcome: "ALREADY_ABANDONED", status: "ABANDONED" });
    });

    it("refused: a settled payment cannot be abandoned; another person is 404; an organization billing role is 403", async () => {
      const t = await payer();
      const settled = await seedPayment(t.owner.userId, "PAYPAL", "SUCCEEDED");
      const finished = await call("POST", paymentUrl(t.owner.userId, settled.id, "abandon"), t.owner.token, { confirmed: true });
      expect(finished.statusCode).toBe(200);
      expect(json(finished)).toMatchObject({ outcome: "ALREADY_FINISHED", status: "SUCCEEDED" });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: settled.id } })).status).toBe("SUCCEEDED");

      const p = await seedPayment(t.owner.userId, "PAYPAL", "PENDING");
      const stranger = await payer();
      const foreign = await call("POST", paymentUrl(t.owner.userId, p.id, "abandon"), stranger.owner.token, { confirmed: true });
      expect(foreign.statusCode).toBe(404);
      expect(json(foreign).error.code).toBe("BILLING_ACCOUNT_NOT_FOUND");

      const org = await seedOrganizationTenant(deps);
      const orgPayment = await seedPayment(org.owner.userId, "PAYPAL", "PENDING", { teamId: org.workspaceId });
      const orgRes = await call(
        "POST",
        `/v1/billing/accounts/ORGANIZATION/${org.organizationId}/payments/${orgPayment.id}/abandon`,
        org.owner.token,
        { confirmed: true },
      );
      expect(orgRes.statusCode).toBe(403);
      expect(json(orgRes).error.code).toBe("BILLING_CAPABILITY_REQUIRED");

      expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING");
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: orgPayment.id } })).status).toBe("PENDING");
    });
  });
});
