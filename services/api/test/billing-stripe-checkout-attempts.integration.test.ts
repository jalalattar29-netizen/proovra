/**
 * BILLING CHECKOUT ATTEMPTS — STRIPE (2026-09-28) — runtime proof on live
 * PostgreSQL 16 + Redis, with Stripe answered by an in-process STATEFUL fake
 * (no socket is opened).
 *
 * What is proven here is PROOVRA's behaviour against Stripe's documented
 * answers: the requests it builds (Idempotency-Key, metadata), the rows it
 * writes and how it converges. It is NOT proof that real Stripe accepts them.
 *
 * Covered:
 *   - a plan checkout commits an attempt BEFORE Stripe and binds the session
 *   - duplicate click -> one session (reuse); another tier -> refused
 *   - an open Stripe plan checkout blocks a PayPal plan checkout (one base plan)
 *   - abandon expires the session AT STRIPE, then allows a new checkout
 *   - a lost credit create response is recovered by the completed session's
 *     attemptId; credits granted exactly once, only when paid
 *   - completed-but-unpaid is PROCESSING and cannot be abandoned
 *   - a 4xx create is FAILED; a 401 re-check is reported as such, never pending
 *   - a storage attempt that expires at Stripe is EXPIRED, nothing granted
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedPersonalTenant,
  type FixtureDeps,
  type PersonalTenant,
} from "./point7/product-fixtures.js";

const STRIPE = "https://api.stripe.com/v1";

/**
 * ENT-08 — the configured Stripe Prices this fake knows (one per self-service
 * offer, agreeing with the catalogue; filled in beforeAll from the commercial
 * authority). Checkout reads its Price back before creating a session.
 */
const FAKE_PRICES = new Map<string, { env: string; body: Record<string, unknown> }>();

type Session = {
  id: string;
  object: "checkout.session";
  status: "open" | "complete" | "expired";
  payment_status: "unpaid" | "paid" | "no_payment_required";
  mode: string;
  url: string | null;
  metadata: Record<string, string>;
  client_reference_id: string | null;
  amount_total: number;
  currency: string;
  subscription: string | null;
  created: number;
  expires_at: number;
  success_url?: string | null;
  cancel_url?: string | null;
};

class FakeStripe {
  sessions = new Map<string, Session>();
  subs = new Map<string, Record<string, unknown>>();
  byKey = new Map<string, string>();
  calls: Array<{ method: string; path: string; key: string | null }> = [];
  createFailure: { status: number } | null = null;
  customerFailure = false;
  loseCreateResponse = false;
  fail = new Map<string, number>();
  private seq = 0;
  private readonly ns = randomUUID().replace(/-/g, "").slice(0, 8);
  // Provider time starts at the real now (see the PayPal fake for why).
  private clock = Math.floor(Date.now() / 1000);

  answer(method: string, path: string, body: string | null, key: string | null): { status: number; body: unknown } {
    this.calls.push({ method, path, key });
    if (method === "GET" && path.startsWith("/prices/")) {
      const p = FAKE_PRICES.get(decodeURIComponent(path.slice("/prices/".length)));
      return p ? { status: 200, body: p.body } : { status: 404, body: { error: { code: "resource_missing" } } };
    }
    if (path === "/customers" && method === "POST") {
      if (this.customerFailure) return { status: 500, body: { error: { type: "api_error" } } };
      const id = key ? `cus_${key.slice(-16)}` : `cus_${++this.seq}`;
      return { status: 200, body: { id, object: "customer", livemode: false, metadata: {} } };
    }
    if (path.startsWith("/customers/") && method === "GET") {
      const id = decodeURIComponent(path.slice("/customers/".length));
      return { status: 200, body: { id, object: "customer", livemode: false, metadata: {}, currency: null } };
    }
    if (path === "/checkout/sessions" && method === "POST") {
      if (this.createFailure) {
        return { status: this.createFailure.status, body: { error: { type: "invalid_request_error", code: "parameter_invalid" } } };
      }
      const existing = key ? this.byKey.get(key) : undefined;
      if (existing) return { status: 200, body: this.sessions.get(existing) };
      const form = new URLSearchParams(body ?? "");
      const metadata: Record<string, string> = {};
      for (const [k, v] of form) {
        const m = k.match(/^metadata\[(.+)\]$/);
        if (m) metadata[m[1]!] = v;
      }
      const id = `cs_test_${this.ns}${(++this.seq).toString().padStart(4, "0")}`;
      const session: Session = {
        id,
        object: "checkout.session",
        status: "open",
        payment_status: "unpaid",
        mode: form.get("mode") ?? "payment",
        url: `https://checkout.stripe.com/c/pay/${id}`,
        metadata,
        client_reference_id: form.get("client_reference_id"),
        amount_total: Number(metadata.amountCents ?? "0"),
        currency: (metadata.currency ?? "usd").toLowerCase(),
        subscription: null,
        created: ++this.clock,
        expires_at: this.clock + 86_400,
        success_url: form.get("success_url"),
        cancel_url: form.get("cancel_url"),
      };
      this.sessions.set(id, session);
      if (key) this.byKey.set(key, id);
      if (this.loseCreateResponse) return { status: 504, body: { error: { type: "api_error" } } };
      return { status: 200, body: session };
    }
    const m = path.match(/^\/checkout\/sessions\/([^/?]+)(\/expire)?/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const forced = this.fail.get(id);
      if (forced) return { status: forced, body: { error: { type: "authentication_error" } } };
      const s = this.sessions.get(id);
      if (!s) return { status: 404, body: { error: { code: "resource_missing" } } };
      if (m[2]) {
        if (s.status !== "open") return { status: 400, body: { error: { code: "checkout_session_not_open" } } };
        s.status = "expired";
        s.url = null;
      }
      return { status: 200, body: s };
    }
    const sm = path.match(/^\/subscriptions\/([^/?]+)/);
    if (sm) {
      const sub = this.subs.get(decodeURIComponent(sm[1]!));
      if (!sub) return { status: 404, body: { error: { code: "resource_missing" } } };
      // E-06 — an immediate cancel (DELETE) ends the subscription.
      if (method === "DELETE") {
        sub.status = "canceled";
        sub.canceled_at = ++this.clock;
        return { status: 200, body: sub };
      }
      if (method === "POST") {
        if (this.fail.get(String(sub.id))) return { status: this.fail.get(String(sub.id))!, body: { error: { type: "api_error" } } };
        const form = new URLSearchParams(body ?? "");
        if (form.has("cancel_at_period_end")) sub.cancel_at_period_end = form.get("cancel_at_period_end") === "true";
      }
      return { status: 200, body: sub };
    }
    if (path.startsWith("/invoices")) return { status: 200, body: { data: [] } };
    return { status: 404, body: { error: { code: "resource_missing" } } };
  }

  pay(id: string, opts: { paid?: boolean; subscription?: string } = {}) {
    const s = this.sessions.get(id)!;
    s.status = "complete";
    s.payment_status = opts.paid === false ? "unpaid" : "paid";
    s.url = null;
    if (opts.subscription) s.subscription = opts.subscription;
  }
}

describe("Stripe checkout attempts (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let settleStripeCheckoutSession: typeof import("../src/services/billing/stripe-settlement.service.js")["settleStripeCheckoutSession"];
  let startStripeStorageCheckout: typeof import("../src/services/billing/stripe-checkout-start.service.js")["startStripeStorageCheckout"];
  let withPendingStorageAddonCheckoutGate: typeof import("../src/services/billing/pending-checkout-attempt.service.js")["withPendingStorageAddonCheckoutGate"];
  let reconcileCheckoutAttempts: typeof import("../src/services/billing/checkout-attempt-recovery.service.js")["reconcileCheckoutAttempts"];
  let emptySummary: typeof import("../src/services/billing/reconciliation/types.js")["emptySummary"];
  let deps: FixtureDeps;
  const tag = `bsa-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

  const call = (method: "POST" | "GET", url: string, token: string, payload?: unknown) =>
    harness.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(method === "POST" ? { payload: (payload ?? {}) as never } : {}),
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (res: { body: string }) => JSON.parse(res.body) as Record<string, any>;

  async function withStripe<T>(fake: FakeStripe, fn: () => Promise<T>): Promise<T> {
    const previous = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const previousPrices = new Map([...FAKE_PRICES.values()].map((p) => [p.env, process.env[p.env]]));
    for (const [id, p] of FAKE_PRICES) process.env[p.env] = id;
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (!url.startsWith(STRIPE)) return realFetch(input as never, init);
      const headers = new Headers(init?.headers);
      const out = fake.answer(
        init?.method ?? "GET",
        url.slice(STRIPE.length),
        init?.body == null ? null : String(init.body),
        headers.get("idempotency-key"),
      );
      return new Response(JSON.stringify(out.body), {
        status: out.status,
        headers: { "content-type": "application/json", "request-id": "req_fake" },
      });
    });
    try {
      return await fn();
    } finally {
      spy.mockRestore();
      if (previous === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previous;
      for (const [k, v] of previousPrices) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  const payer = (plan: "FREE" | "PRO" = "FREE"): Promise<PersonalTenant> => seedPersonalTenant(deps, plan);
  const activity = async (t: PersonalTenant) => {
    const res = await call("GET", `/v1/billing/accounts/PERSONAL/${t.owner.userId}/history`, t.owner.token);
    expect(res.statusCode, res.body).toBe(200);
    return json(res);
  };
  const attemptBase = (t: PersonalTenant, id: string) =>
    `/v1/billing/accounts/PERSONAL/${t.owner.userId}/checkout-attempts/${id}`;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ settleStripeCheckoutSession } = await import("../src/services/billing/stripe-settlement.service.js"));
    ({ startStripeStorageCheckout } = await import("../src/services/billing/stripe-checkout-start.service.js"));
    ({ withPendingStorageAddonCheckoutGate } = await import("../src/services/billing/pending-checkout-attempt.service.js"));
    ({ reconcileCheckoutAttempts } = await import("../src/services/billing/checkout-attempt-recovery.service.js"));
    ({ emptySummary } = await import("../src/services/billing/reconciliation/types.js"));
    const offers = await import("../src/services/billing/commercial-offer.service.js");
    for (const currency of ["USD", "EUR"] as const) {
      for (const o of offers.allSelfServiceOffers(currency)) {
        const p = o.product;
        const env =
          p.kind === "PLAN"
            ? `STRIPE_${p.plan}_PRICE_ID_${currency}`
            : p.kind === "EVIDENCE_CREDIT"
              ? `STRIPE_PAYG_PRICE_ID_${currency}`
              : `STRIPE_STORAGE_${p.addonKey}_MONTHLY_${currency}_PRICE_ID`;
        const id = `price_bsa_${offers.describeOffer(o).replace(/[^A-Za-z0-9]/g, "_")}`;
        FAKE_PRICES.set(id, {
          env,
          body: {
            id,
            active: true,
            currency: o.currency.toLowerCase(),
            unit_amount: o.amountCents,
            type: o.interval === "MONTH" ? "recurring" : "one_time",
            recurring: o.interval === "MONTH" ? { interval: "month", interval_count: 1 } : null,
          },
        });
      }
    }
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

  it("a customer Stripe cannot settle refuses the checkout before any session, and the retry finishes the same creation", async () => {
    const t = await payer();
    const fake = new FakeStripe();
    await withStripe(fake, async () => {
      fake.customerFailure = true;
      const refused = await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "PRO", currency: "EUR" });
      expect(refused.statusCode, refused.body).toBe(503);
      expect(JSON.parse(refused.body).error.code).toBe("CHECKOUT_CUSTOMER_UNRESOLVED");
      expect(fake.calls.filter((c) => c.path === "/checkout/sessions")).toEqual([]);

      fake.customerFailure = false;
      const retried = await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "PRO", currency: "EUR" });
      expect(retried.statusCode, retried.body).toBe(200);
      const keys = new Set(fake.calls.filter((c) => c.path === "/customers").map((c) => c.key));
      expect(keys.size).toBe(1);
    });
  });

  it("a plan checkout commits an attempt first, uses it as the Idempotency-Key, reuses on a double click and blocks another plan on either provider", async () => {
    const t = await payer();
    const fake = new FakeStripe();
    await withStripe(fake, async () => {
      const a = await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "PRO", currency: "EUR" });
      expect(a.statusCode, a.body).toBe(200);
      const attempt = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { userId: t.owner.userId } });
      expect(attempt).toMatchObject({
        provider: "STRIPE",
        product: "PLAN",
        planKey: "PRO",
        status: "PENDING",
        checkoutState: "AWAITING_CUSTOMER_APPROVAL",
        providerResourceId: json(a).session.id,
        currency: "EUR",
      });
      const create = fake.calls.find((c) => c.method === "POST" && c.path === "/checkout/sessions")!;
      expect(create.key).toBe(`proovra-checkout-${attempt.id}`);
      expect(fake.sessions.get(json(a).session.id)!.metadata.attemptId).toBe(attempt.id);
      expect(fake.sessions.get(json(a).session.id)!.client_reference_id).toBe(attempt.id);

      const b = await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "PRO", currency: "EUR" });
      expect(b.statusCode, b.body).toBe(200);
      expect(json(b).session.id).toBe(json(a).session.id);
      expect(fake.calls.filter((c) => c.method === "POST" && c.path === "/checkout/sessions")).toHaveLength(1);

      const c = await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "TEAM", currency: "EUR" });
      expect(c.statusCode).toBe(409);
      expect(json(c).code).toBe("PLAN_CHECKOUT_ALREADY_OPEN");

      // One base plan per person, whichever provider: PayPal is refused too.
      const p = await call("POST", "/v1/billing/checkout/paypal", t.owner.token, { plan: "PRO", currency: "EUR" });
      expect(p.statusCode, p.body).toBe(409);
      expect(json(p).code).toBe("PLAN_CHECKOUT_ALREADY_OPEN");
      expect(json(p).message).toMatch(/card \(Stripe\)/);

      const list = await activity(t);
      expect(list.activity[0]).toMatchObject({
        product: "PLAN",
        providerLabel: "Card",
        state: "AWAITING_APPROVAL",
        statusLabel: "Waiting for payment",
      });
      expect(list.activity[0].explanation).toMatch(/Stripe payment page/);
      expect(list.activity[0].explanation).not.toMatch(/PayPal/);
      expect(JSON.stringify(list.activity)).not.toContain(json(a).session.id);
    });
  });

  it("abandoning an open Stripe checkout expires it AT STRIPE, and a new checkout can start", async () => {
    const t = await payer();
    const fake = new FakeStripe();
    await withStripe(fake, async () => {
      const a = await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "PRO", currency: "USD" });
      const sessionId = json(a).session.id as string;
      const attempt = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { userId: t.owner.userId } });

      const check = await call("POST", `${attemptBase(t, attempt.id)}/recheck`, t.owner.token, {});
      expect(json(check)).toMatchObject({ product: "PLAN", provider: "STRIPE", outcome: "STILL_PENDING" });
      expect(json(check).resumeUrl).toBe(`https://checkout.stripe.com/c/pay/${sessionId}`);

      const first = await call("POST", `${attemptBase(t, attempt.id)}/abandon`, t.owner.token, {});
      expect(json(first)).toMatchObject({ outcome: "ABANDON_CONFIRMATION_REQUIRED", cancelsAtProvider: true });
      expect(json(first).warning).toMatch(/asks Stripe to close it/);
      expect(fake.sessions.get(sessionId)!.status).toBe("open");

      const confirmed = await call("POST", `${attemptBase(t, attempt.id)}/abandon`, t.owner.token, { confirmed: true });
      expect(json(confirmed)).toMatchObject({ outcome: "ABANDONED", cancelsAtProvider: true });
      expect(fake.sessions.get(sessionId)!.status).toBe("expired");
      // PRO-BL1C-02 — the audit row states the provider act (it said
      // LOCAL_ABANDONMENT / cancelsAtProvider:false for every abandon).
      await vi.waitFor(async () => {
        const rows = await prisma.adminAuditLog.findMany({
          where: { action: "billing.checkout_attempt_abandoned", resourceId: attempt.id },
          select: { metadata: true },
        });
        const acts = rows.map((r) => r.metadata as Record<string, unknown>);
        expect(acts).toContainEqual(expect.objectContaining({ result: "ABANDONED", act: "PROVIDER_CANCELLATION", cancelsAtProvider: true }));
        expect(acts).toContainEqual(expect.objectContaining({ result: "ABANDON_CONFIRMATION_REQUIRED", cancelsAtProvider: false }));
      });
      expect(await prisma.billingCheckoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({
        status: "CANCELED",
        checkoutState: "PROVIDER_CANCELED",
      });
      expect((await activity(t)).activity[0]).toMatchObject({ state: "CANCELED", statusLabel: "Canceled" });

      const again = await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "PRO", currency: "USD" });
      expect(again.statusCode, again.body).toBe(200);
      expect(json(again).session.id).not.toBe(sessionId);
    });
  });

  it("an expire Stripe cannot confirm leaves the checkout visible and open", async () => {
    const t = await payer();
    const fake = new FakeStripe();
    await withStripe(fake, async () => {
      const a = await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "PRO", currency: "USD" });
      const sessionId = json(a).session.id as string;
      const attempt = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { userId: t.owner.userId } });
      const realAnswer = fake.answer.bind(fake);
      fake.answer = (method, path, body, key) =>
        path.endsWith("/expire") ? { status: 500, body: { error: { type: "api_error" } } } : realAnswer(method, path, body, key);
      const res = await call("POST", `${attemptBase(t, attempt.id)}/abandon`, t.owner.token, { confirmed: true });
      expect(json(res)).toMatchObject({ outcome: "PROVIDER_CANCEL_FAILED", cancelsAtProvider: false });
      expect(fake.sessions.get(sessionId)!.status).toBe("open");
      expect((await prisma.billingCheckoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe("PENDING");
    });
  });

  it("a lost credit create response is recovered from the completed session's attemptId; credits only when paid, exactly once", async () => {
    const t = await payer();
    const fake = new FakeStripe();
    await withStripe(fake, async () => {
      fake.loseCreateResponse = true;
      const res = await call("POST", "/v1/billing/credits/checkout/stripe", t.owner.token, { currency: "USD" });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      fake.loseCreateResponse = false;
      const attempt = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { userId: t.owner.userId } });
      expect(attempt).toMatchObject({ product: "EVIDENCE_CREDIT", status: "PENDING", checkoutState: "PROVIDER_OUTCOME_UNKNOWN", providerResourceId: null });

      const check = await call("POST", `${attemptBase(t, attempt.id)}/recheck`, t.owner.token, {});
      expect(json(check).outcome).toBe("NOT_PROVIDER_BOUND");
      expect((await activity(t)).activity[0]).toMatchObject({ state: "NOT_CONFIRMED_BY_PROVIDER" });

      const [sessionId] = [...fake.sessions.keys()];
      const credits0 = (await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).credits ?? 0;

      // Completed but the payment method is still settling: nothing granted.
      fake.pay(sessionId!, { paid: false });
      const { settleStripeCheckoutSession } = await import("../src/services/billing/stripe-settlement.service.js");
      const unpaid = await settleStripeCheckoutSession({ session: fake.sessions.get(sessionId!) as never });
      expect(unpaid.outcome).toBe("PENDING");
      const bound = await prisma.billingCheckoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(bound).toMatchObject({ providerResourceId: sessionId, status: "PENDING", checkoutState: "CAPTURE_PENDING" });
      expect(await prisma.payment.count({ where: { userId: t.owner.userId } })).toBe(0);
      const notAllowed = await call("POST", `${attemptBase(t, attempt.id)}/abandon`, t.owner.token, { confirmed: true });
      expect(json(notAllowed).outcome).toBe("ABANDON_NOT_ALLOWED");
      expect(json(notAllowed).warning).toMatch(/^Stripe /);

      // Paid: webhook and re-check both apply it; the grant happens once.
      fake.pay(sessionId!, { paid: true });
      await settleStripeCheckoutSession({ session: fake.sessions.get(sessionId!) as never });
      const again = await call("POST", `${attemptBase(t, attempt.id)}/recheck`, t.owner.token, {});
      expect(json(again).currentStatus).toBe("COMPLETED");
      const credits1 = (await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).credits ?? 0;
      expect(credits1 - credits0).toBe(1);
      expect(await prisma.payment.count({ where: { userId: t.owner.userId, providerPaymentId: sessionId } })).toBe(1);
      expect((await activity(t)).activity).toEqual([]);
    });
  });

  it("a 4xx storage create is FAILED; a 401 re-check says so; an expired session is EXPIRED and grants nothing", async () => {
    const t = await payer("PRO");
    const fake = new FakeStripe();
    await withStripe(fake, async () => {
      fake.createFailure = { status: 400 };
      const bad = await call("POST", "/v1/billing/storage-addons/checkout/stripe", t.owner.token, {
        addonKey: "PERSONAL_50_GB",
        billingCycle: "MONTHLY",
      });
      expect(bad.statusCode).toBeGreaterThanOrEqual(400);
      const failed = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { userId: t.owner.userId } });
      expect(failed).toMatchObject({ product: "STORAGE_ADDON", storageAddonKey: "PERSONAL_50_GB", status: "FAILED", checkoutState: "PROVIDER_REJECTED" });
      fake.createFailure = null;

      const ok = await call("POST", "/v1/billing/storage-addons/checkout/stripe", t.owner.token, {
        addonKey: "PERSONAL_50_GB",
        billingCycle: "MONTHLY",
      });
      expect(ok.statusCode, ok.body).toBe(200);
      const sessionId = json(ok).session.id as string;
      const attempt = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { userId: t.owner.userId, providerResourceId: sessionId } });
      const listed = (await activity(t)).activity.find((i: { id: string }) => i.id === attempt.id);
      expect(listed).toMatchObject({ product: "STORAGE", providerLabel: "Card", recurring: true });
      expect(listed.description).toMatch(/storage add-on/);

      fake.fail.set(sessionId, 401);
      const unauthorized = await call("POST", `${attemptBase(t, attempt.id)}/recheck`, t.owner.token, {});
      expect(json(unauthorized)).toMatchObject({ product: "STORAGE", outcome: "PROVIDER_AUTHORIZATION_FAILED" });
      expect((await activity(t)).activity.find((i: { id: string }) => i.id === attempt.id).state).toBe("PROVIDER_UNVERIFIED");
      fake.fail.delete(sessionId);

      fake.sessions.get(sessionId)!.status = "expired";
      const expired = await call("POST", `${attemptBase(t, attempt.id)}/recheck`, t.owner.token, {});
      expect(json(expired)).toMatchObject({ outcome: "UPDATED", currentStatus: "EXPIRED" });
      expect(await prisma.workspaceStorageAddon.count({ where: { ownerUserId: t.owner.userId, paymentProvider: "STRIPE" } })).toBe(0);
    });
  });

  describe("restart a subscription set to end", () => {
    async function scheduled(t: PersonalTenant, provider: "STRIPE" | "PAYPAL", fake?: FakeStripe) {
      const providerSubId = provider === "STRIPE" ? `sub_${randomUUID().slice(0, 12)}` : `I-R${randomUUID().slice(0, 10).toUpperCase()}`;
      const end = new Date(Date.now() + 10 * 86_400_000);
      const row = await prisma.subscription.create({
        data: {
          userId: t.owner.userId,
          provider,
          providerSubId,
          status: "ACTIVE",
          plan: "PRO",
          currentPeriodEnd: end,
          cancelAtPeriodEnd: provider === "STRIPE",
          canceledAtUtc: new Date(),
        },
      });
      fake?.subs.set(providerSubId, {
        id: providerSubId,
        status: "active",
        cancel_at_period_end: true,
        current_period_end: Math.floor(end.getTime() / 1000),
      });
      return row;
    }

    it("Stripe: the provider is asked first; renewal is back on only when Stripe confirms", async () => {
      const t = await payer("PRO");
      const fake = new FakeStripe();
      const row = await scheduled(t, "STRIPE", fake);
      await withStripe(fake, async () => {
        fake.fail.set(row.providerSubId, 500);
        const down = await call("POST", "/v1/billing/subscription/resume", t.owner.token, {});
        expect(down.statusCode).toBe(502);
        expect((await prisma.subscription.findUniqueOrThrow({ where: { id: row.id } })).cancelAtPeriodEnd).toBe(true);
        fake.fail.delete(row.providerSubId);

        const ok = await call("POST", "/v1/billing/subscription/resume", t.owner.token, {});
        expect(ok.statusCode, ok.body).toBe(200);
        expect(json(ok).resume).toMatchObject({ result: "RESUMED", provider: "STRIPE" });
        expect(fake.subs.get(row.providerSubId)!.cancel_at_period_end).toBe(false);
        expect(await prisma.subscription.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
          cancelAtPeriodEnd: false,
          canceledAtUtc: null,
          status: "ACTIVE",
        });
        const again = await call("POST", "/v1/billing/subscription/resume", t.owner.token, {});
        expect(json(again).resume.result).toBe("NOT_SCHEDULED_TO_END");
      });
    });

    it("PayPal: refused with the truth — a PayPal cancellation cannot be undone", async () => {
      const t = await payer("PRO");
      await scheduled(t, "PAYPAL");
      const res = await call("POST", "/v1/billing/subscription/resume", t.owner.token, {});
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain("PROVIDER_CANNOT_RESTART");
      expect(res.body).toMatch(/subscribe again/);
    });
  });

  it("legacy teamId rows: Personal re-check includes the payer's own workspace rows and never another owner's", async () => {
    const t = await payer("PRO");
    const other = await payer();
    const fake = new FakeStripe();
    const mine = `sub_legacy_${randomUUID().slice(0, 10)}`;
    const foreign = `sub_foreign_${randomUUID().slice(0, 10)}`;
    const end = Math.floor(Date.now() / 1000) + 5 * 86_400;
    // Paid by t, workspace-scoped under the old TEAM model, workspace still t's.
    const own = await prisma.subscription.create({
      data: { userId: t.owner.userId, teamId: t.personalTeamId, provider: "STRIPE", providerSubId: mine, status: "ACTIVE", plan: "PRO" },
    });
    // Paid by t but against a workspace ANOTHER person owns: not reconciled here.
    const theirs = await prisma.subscription.create({
      data: { userId: t.owner.userId, teamId: other.personalTeamId, provider: "STRIPE", providerSubId: foreign, status: "ACTIVE", plan: "PRO" },
    });
    fake.subs.set(mine, { id: mine, status: "active", cancel_at_period_end: true, current_period_end: end, metadata: { userId: t.owner.userId, plan: "PRO" } });
    fake.subs.set(foreign, { id: foreign, status: "active", cancel_at_period_end: true, current_period_end: end, metadata: { userId: t.owner.userId, plan: "PRO" } });
    await withStripe(fake, async () => {
      const res = await call("POST", `/v1/billing/accounts/PERSONAL/${t.owner.userId}/reconcile`, t.owner.token, {});
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).summary).toMatchObject({ checked: 1, subscriptionsUpdated: 1 });
    });
    expect(fake.calls.some((c) => c.path.startsWith(`/subscriptions/${mine}`))).toBe(true);
    expect(fake.calls.some((c) => c.path.includes(foreign))).toBe(false);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: own.id } })).currentPeriodEnd?.getTime()).toBe(end * 1000);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: theirs.id } })).currentPeriodEnd).toBeNull();
    // The other owner's re-check does not reach t's row either (not its payer).
    const before = fake.calls.length;
    await withStripe(fake, async () => {
      await call("POST", `/v1/billing/accounts/PERSONAL/${other.owner.userId}/reconcile`, other.owner.token, {});
    });
    expect(fake.calls.slice(before).some((c) => c.path.includes(foreign) || c.path.includes(mine))).toBe(false);
  });

  it("the plan price is the provider-billed currency; unknown currency shows no figure; two live base subscriptions are flagged", async () => {
    const t = await payer("PRO");
    const sub = await prisma.subscription.create({
      data: {
        userId: t.owner.userId,
        provider: "PAYPAL",
        providerSubId: `I-EUR${randomUUID().slice(0, 10).toUpperCase()}`,
        status: "ACTIVE",
        plan: "PRO",
        billedCurrency: "EUR",
        currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
      },
    });
    const view = async () => {
      const res = await call("GET", `/v1/billing/accounts/PERSONAL/${t.owner.userId}?currency=USD`, t.owner.token);
      expect(res.statusCode, res.body).toBe(200);
      return json(res);
    };
    const eur = await view();
    expect(eur.plan).toMatchObject({ currency: "EUR", paymentProviderLabel: "PayPal" });
    expect(typeof eur.plan.priceCents).toBe("number");
    expect(eur.actionRequired).toBeNull();

    await prisma.subscription.update({ where: { id: sub.id }, data: { billedCurrency: null } });
    const unknown = await view();
    expect(unknown.plan.currency).toBeUndefined();
    expect(unknown.plan.priceCents).toBeUndefined();

    // A second live base subscription (e.g. an abandoned PayPal approval later
    // approved at PayPal): flagged, never auto-cancelled.
    await prisma.subscription.create({
      data: { userId: t.owner.userId, provider: "STRIPE", providerSubId: `sub_dup_${randomUUID().slice(0, 10)}`, status: "ACTIVE", plan: "PRO", billedCurrency: "USD" },
    });
    const dup = await view();
    expect(dup.actionRequired).toMatchObject({ severity: "CRITICAL", reassurance: null });
    expect(dup.actionRequired.messages.join(" ")).toMatch(/2 plan subscriptions are active/);
    expect(await prisma.subscription.count({ where: { userId: t.owner.userId, status: "ACTIVE" } })).toBe(2);
  });

  it("another account can neither re-check nor abandon a Stripe attempt", async () => {
    const t = await payer();
    const other = await payer();
    const fake = new FakeStripe();
    await withStripe(fake, async () => {
      await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "PRO", currency: "USD" });
      const attempt = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { userId: t.owner.userId } });
      const foreign = `/v1/billing/accounts/PERSONAL/${other.owner.userId}/checkout-attempts/${attempt.id}`;
      expect((await call("POST", `${foreign}/recheck`, other.owner.token, {})).statusCode).toBe(404);
      expect((await call("POST", `${foreign}/abandon`, other.owner.token, { confirmed: true })).statusCode).toBe(404);
      expect((await call("POST", `${attemptBase(t, attempt.id)}/recheck`, other.owner.token, {})).statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // FREE-AUDIT REMEDIATION (2026-11-13) — F-13, F-14, DUP-STORAGE
  // -------------------------------------------------------------------------

  it("F-13: the Stripe return names its attempt; the cancel return frees the next plan checkout; a stale cancel after payment changes nothing", async () => {
    const t = await payer();
    const fake = new FakeStripe();
    await withStripe(fake, async () => {
      const a = await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "PRO", currency: "USD" });
      expect(a.statusCode, a.body).toBe(200);
      const sessionId = json(a).session.id as string;
      const attempt = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { userId: t.owner.userId } });
      const session = fake.sessions.get(sessionId)!;
      expect(session.cancel_url!.endsWith(`/billing?canceled=1&attempt=${attempt.id}`)).toBe(true);
      expect(session.success_url!.endsWith(`/billing?success=1&attempt=${attempt.id}`)).toBe(true);

      // Backed out of Stripe: before, this blocked every plan checkout.
      const blocked = await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "TEAM", currency: "USD" });
      expect(json(blocked).code).toBe("PLAN_CHECKOUT_ALREADY_OPEN");
      // What the cancel return asks: abandon THIS attempt, provider-first.
      const back = await call("POST", `${attemptBase(t, attempt.id)}/abandon`, t.owner.token, { confirmed: true });
      expect(json(back)).toMatchObject({ outcome: "ABANDONED", cancelsAtProvider: true });
      expect(fake.sessions.get(sessionId)!.status).toBe("expired");
      const next = await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "TEAM", currency: "USD" });
      expect(next.statusCode, next.body).toBe(200);

      // A paid credit, then its stale cancel link: the payment stands.
      const c = await call("POST", "/v1/billing/credits/checkout/stripe", t.owner.token, { currency: "USD" });
      const creditSession = json(c).session.id as string;
      expect(fake.sessions.get(creditSession)!.cancel_url).toMatch(/canceled=1&kind=credits&attempt=/);
      const creditAttempt = await prisma.billingCheckoutAttempt.findFirstOrThrow({
        where: { userId: t.owner.userId, product: "EVIDENCE_CREDIT" },
      });
      const credits0 = (await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).credits ?? 0;
      fake.pay(creditSession, { paid: true });
      await settleStripeCheckoutSession({ session: fake.sessions.get(creditSession) as never });
      const stale = await call("POST", `${attemptBase(t, creditAttempt.id)}/abandon`, t.owner.token, { confirmed: true });
      expect(json(stale).outcome).toBe("ALREADY_RESOLVED");
      expect((await prisma.billingCheckoutAttempt.findUniqueOrThrow({ where: { id: creditAttempt.id } })).status).toBe("COMPLETED");
      const credits1 = (await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).credits ?? 0;
      expect(credits1 - credits0).toBe(1);
    });
  });

  it("F-14: the success return's re-check settles a paid session before the webhook; the late and repeated webhook add nothing", async () => {
    const t = await payer();
    const fake = new FakeStripe();
    await withStripe(fake, async () => {
      const c = await call("POST", "/v1/billing/credits/checkout/stripe", t.owner.token, { currency: "EUR" });
      const sessionId = json(c).session.id as string;
      const attempt = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { userId: t.owner.userId } });
      const credits0 = (await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).credits ?? 0;

      // Returned while Stripe still shows the page open: pending, nothing granted.
      const early = await call("POST", `${attemptBase(t, attempt.id)}/recheck`, t.owner.token, {});
      expect(json(early)).toMatchObject({ currentStatus: "PENDING", outcome: "STILL_PENDING", waitingFor: "PAYMENT_PAGE" });

      fake.pay(sessionId, { paid: true });
      const confirmed = await call("POST", `${attemptBase(t, attempt.id)}/recheck`, t.owner.token, {});
      expect(json(confirmed)).toMatchObject({ currentStatus: "COMPLETED", outcome: "UPDATED" });

      const late = await settleStripeCheckoutSession({ session: fake.sessions.get(sessionId) as never });
      const repeated = await settleStripeCheckoutSession({ session: fake.sessions.get(sessionId) as never });
      expect(late.outcome).toBe("ALREADY_GRANTED");
      expect(repeated.outcome).toBe("ALREADY_GRANTED");
      const credits1 = (await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).credits ?? 0;
      expect(credits1 - credits0).toBe(1);
      expect(await prisma.payment.count({ where: { userId: t.owner.userId, providerPaymentId: sessionId } })).toBe(1);
    });
  });

  it("E-02: a paid card plan superseded by a plan already live is recorded and answered as superseded, never as applied", async () => {
    const t = await payer();
    const fake = new FakeStripe();
    await withStripe(fake, async () => {
      const a = await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "PRO", currency: "USD" });
      expect(a.statusCode, a.body).toBe(200);
      const sessionId = json(a).session.id as string;
      const attempt = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { userId: t.owner.userId, product: "PLAN" } });
      // Meanwhile the buyer approved an older PayPal link: that plan is live first.
      const kept = await prisma.subscription.create({
        data: {
          userId: t.owner.userId,
          provider: "PAYPAL",
          providerSubId: `I-E02${randomUUID().slice(0, 10).toUpperCase()}`,
          status: "ACTIVE",
          plan: "PRO",
          currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
        },
      });
      const planBefore = (await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).plan;
      const subId = `sub_e02${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      fake.subs.set(subId, {
        id: subId,
        status: "active",
        currency: "usd",
        metadata: { userId: t.owner.userId, plan: "PRO", attemptId: attempt.id },
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
      });
      fake.pay(sessionId, { paid: true, subscription: subId });

      const res = await call("POST", `${attemptBase(t, attempt.id)}/recheck`, t.owner.token, {});
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toMatchObject({ currentStatus: "COMPLETED", superseded: true });
      expect(await prisma.billingCheckoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({
        status: "COMPLETED",
        checkoutState: "SUPERSEDED",
      });
      expect(
        (await prisma.subscription.findUniqueOrThrow({
          where: { provider_providerSubId: { provider: "STRIPE", providerSubId: subId } },
        })).supersededBySubscriptionId,
      ).toBe(kept.id);
      // The card plan granted nothing.
      expect((await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).plan).toBe(planBefore);

      // A later re-check (or the webhook settling it again) still says so.
      const again = await call("POST", `${attemptBase(t, attempt.id)}/recheck`, t.owner.token, {});
      expect(json(again)).toMatchObject({ currentStatus: "COMPLETED", superseded: true });
      const webhook = await settleStripeCheckoutSession({ session: fake.sessions.get(sessionId) as never });
      expect(webhook).toMatchObject({ product: "PLAN", outcome: "APPLIED", superseded: true });
    });
  });

  it("F-13: an unpaid card plan checkout older than the approval window is expired at Stripe by the next plan checkout", async () => {
    const t = await payer();
    const fake = new FakeStripe();
    await withStripe(fake, async () => {
      const a = await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "PRO", currency: "USD" });
      const sessionId = json(a).session.id as string;
      const attempt = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { userId: t.owner.userId } });
      await prisma.billingCheckoutAttempt.update({
        where: { id: attempt.id },
        data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      });
      const next = await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "TEAM", currency: "USD" });
      expect(next.statusCode, next.body).toBe(200);
      expect(fake.sessions.get(sessionId)!.status).toBe("expired");
      expect(await prisma.billingCheckoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({
        status: "CANCELED",
        checkoutState: "LOCALLY_EXPIRED",
      });
    });
  });

  it("F-13: a card plan checkout whose payment is settling is never expired, however old", async () => {
    const t = await payer();
    const fake = new FakeStripe();
    await withStripe(fake, async () => {
      const a = await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "PRO", currency: "USD" });
      const sessionId = json(a).session.id as string;
      const attempt = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { userId: t.owner.userId } });
      await prisma.billingCheckoutAttempt.update({
        where: { id: attempt.id },
        data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      });
      fake.pay(sessionId, { paid: false }); // completed, payment still settling
      const next = await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "TEAM", currency: "USD" });
      expect(next.statusCode).toBe(409);
      expect(fake.sessions.get(sessionId)!.status).toBe("complete");
      expect((await prisma.billingCheckoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe("PENDING");
    });
  });

  it("DUP-STORAGE: a card and a PayPal purchase of the same size started together open exactly one checkout; another size stays allowed", async () => {
    const fake = new FakeStripe();
    await withStripe(fake, async () => {
      for (let round = 0; round < 4; round++) {
        const t = await payer();
        const paypalCreate = vi.fn(async () => ({
          result: {},
          providerSubId: `I-${randomUUID().slice(0, 12).toUpperCase()}`,
          providerHttpStatus: 201,
          providerDebugId: null,
          providerEnvironment: "sandbox",
          providerClientIdFingerprint: "fp",
          providerPlanId: "P-FAKE",
          providerCurrency: "EUR",
          approvalLinkIdentity: null,
        }));
        const [card, paypal] = await Promise.all([
          startStripeStorageCheckout({
            userId: t.owner.userId,
            addonKey: "PERSONAL_10_GB",
            currency: "EUR",
            teamId: null,
            workspacePlan: "FREE",
          }),
          withPendingStorageAddonCheckoutGate({
            ownerUserId: t.owner.userId,
            teamId: null,
            addonKey: "PERSONAL_10_GB",
            extraStorageBytes: 1n,
            currency: "EUR",
            amountCents: 299,
            create: paypalCreate,
          }),
        ]);
        const opened = [card.kind === "CREATED", paypal.kind === "CREATED"].filter(Boolean).length;
        expect(opened, JSON.stringify({ card: card.kind, paypal: paypal.kind })).toBe(1);
        if (card.kind === "BLOCKED") expect(card.httpBody.code).toBe("STORAGE_PURCHASE_PENDING");
        if (paypal.kind === "DUPLICATE") expect(paypal.finding.code).toBe("STORAGE_PURCHASE_PENDING");
        expect(paypalCreate.mock.calls.length).toBe(paypal.kind === "CREATED" ? 1 : 0);

        // A different size is a different purchase, and stays allowed.
        const other = await startStripeStorageCheckout({
          userId: t.owner.userId,
          addonKey: "PERSONAL_50_GB",
          currency: "EUR",
          teamId: null,
          workspacePlan: "FREE",
        });
        expect(other.kind).toBe("CREATED");
      }
    });
  });

  it("the subscription mutations are bounded per person, and a billing 429 says when to retry", async () => {
    const t = await payer();
    let last: { statusCode: number; headers: Record<string, unknown>; body: string } | null = null;
    for (let i = 0; i < 21; i++) {
      last = await call("POST", "/v1/billing/subscription/cancel", t.owner.token, {});
    }
    expect(last!.statusCode).toBe(429);
    const retryAfter = Number(last!.headers["retry-after"]);
    expect(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 300).toBe(true);
    // The bucket is per person: another person is unaffected.
    const other = await payer();
    expect((await call("POST", "/v1/billing/subscription/cancel", other.owner.token, {})).statusCode).not.toBe(429);
  });

  it("F-26c: plan and credit offers say which provider can sell them, from configuration", async () => {
    const t = await payer();
    const view = async () => {
      const res = await call("GET", `/v1/billing/accounts/PERSONAL/${t.owner.userId}`, t.owner.token);
      expect(res.statusCode, res.body).toBe(200);
      return json(res);
    };
    const paypalEnv = ["PAYPAL_CLIENT_ID", "PAYPAL_SECRET", "PAYPAL_PRO_PLAN_ID_USD", "PAYPAL_PRO_PLAN_ID_EUR"] as const;
    const saved = Object.fromEntries(paypalEnv.map((k) => [k, process.env[k]]));
    try {
      for (const k of paypalEnv) delete process.env[k];
      const previousKey = process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_SECRET_KEY;
      try {
        // Nothing configured: no provider can sell; the buttons would only 503.
        const none = await view();
        const pro = none.planOffers.find((o: { planKey: string }) => o.planKey === "PRO");
        expect(pro.checkoutAvailability).toEqual({ stripe: false, paypal: false });
        expect(none.wallet.checkoutAvailability).toEqual({ stripe: false, paypal: false });
      } finally {
        if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY;
        else process.env.STRIPE_SECRET_KEY = previousKey;
      }

      await withStripe(new FakeStripe(), async () => {
        // Stripe key and prices configured; PayPal credentials present but no plan id.
        process.env.PAYPAL_CLIENT_ID = "client-test";
        process.env.PAYPAL_SECRET = "secret-test";
        const cardOnly = await view();
        const pro = cardOnly.planOffers.find((o: { planKey: string }) => o.planKey === "PRO");
        expect(pro.checkoutAvailability).toEqual({ stripe: true, paypal: false });
        // A credit is a PayPal order: credentials are enough.
        expect(cardOnly.wallet.checkoutAvailability).toEqual({ stripe: true, paypal: true });

        process.env.PAYPAL_PRO_PLAN_ID_USD = "P-PRO-USD";
        process.env.PAYPAL_PRO_PLAN_ID_EUR = "P-PRO-EUR";
        const both = await view();
        expect(both.planOffers.find((o: { planKey: string }) => o.planKey === "PRO").checkoutAvailability).toEqual({
          stripe: true,
          paypal: true,
        });
      });
    } finally {
      for (const k of paypalEnv) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it("DUP-STORAGE: a card purchase still being created blocks the PayPal route for that size before PayPal is called", async () => {
    const t = await payer();
    await prisma.billingCheckoutAttempt.create({
      data: {
        userId: t.owner.userId,
        product: "STORAGE_ADDON",
        provider: "STRIPE",
        storageAddonKey: "PERSONAL_10_GB",
        amountCents: 299,
        currency: "EUR",
        status: "PENDING",
        checkoutState: "PROVIDER_CREATE_IN_PROGRESS",
      },
    });
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      const res = await call("POST", "/v1/billing/storage-addons/checkout/paypal", t.owner.token, {
        addonKey: "PERSONAL_10_GB",
        billingCycle: "MONTHLY",
        currency: "EUR",
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(json(res)).toMatchObject({ code: "STORAGE_PURCHASE_PENDING", details: { pendingProvider: "STRIPE" } });
      expect(spy.mock.calls.filter(([u]) => String(u).includes("paypal.com"))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("E-01: an open card storage checkout of a size blocks a second one for the approval window, not only 2 minutes; closed or expired ones do not", async () => {
    const t = await payer();
    const fake = new FakeStripe();
    const start = (addonKey: "PERSONAL_10_GB" | "PERSONAL_50_GB") =>
      startStripeStorageCheckout({
        userId: t.owner.userId,
        addonKey,
        currency: "EUR",
        teamId: null,
        workspacePlan: "FREE",
      });
    const sessionCreates = () => fake.calls.filter((c) => c.method === "POST" && c.path === "/checkout/sessions").length;
    await withStripe(fake, async () => {
      const first = await start("PERSONAL_10_GB");
      expect(first.kind).toBe("CREATED");
      const firstId = (first as { attemptId: string }).attemptId;
      // Tab A is left open; tab B tries again three hours later.
      await prisma.billingCheckoutAttempt.update({
        where: { id: firstId },
        data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
      });
      const creates = sessionCreates();
      const second = await start("PERSONAL_10_GB");
      expect(second.kind).toBe("BLOCKED");
      expect((second as { httpBody: unknown }).httpBody).toMatchObject({
        code: "STORAGE_PURCHASE_PENDING",
        details: { pendingProvider: "STRIPE", attemptId: firstId, retry: "RECONCILE_STORAGE_ATTEMPT" },
      });
      expect(sessionCreates()).toBe(creates);
      expect(
        await prisma.billingCheckoutAttempt.count({
          where: { userId: t.owner.userId, product: "STORAGE_ADDON", storageAddonKey: "PERSONAL_10_GB" },
        }),
      ).toBe(1);

      // Another size is another purchase.
      expect((await start("PERSONAL_50_GB")).kind).toBe("CREATED");

      // Past the approval window the old page no longer blocks.
      await prisma.billingCheckoutAttempt.update({
        where: { id: firstId },
        data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      });
      const third = await start("PERSONAL_10_GB");
      expect(third.kind).toBe("CREATED");

      // An abandoned attempt does not block either.
      const thirdId = (third as { attemptId: string }).attemptId;
      await prisma.billingCheckoutAttempt.update({
        where: { id: thirdId },
        data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000), status: "ABANDONED" },
      });
      expect((await start("PERSONAL_10_GB")).kind).toBe("CREATED");
    });
  });

  // AUDIT E-01 recheck (2026-11-15, slice COM) — SIMULATED PROVIDER (the
  // in-process Stripe fake above; not Stripe test mode).
  describe("E-01 recheck: repeat storage purchases", () => {
    const startFor = (t: PersonalTenant) => (confirmation?: { heldCount: number | null }) =>
      startStripeStorageCheckout({
        userId: t.owner.userId,
        addonKey: "PERSONAL_10_GB",
        currency: "EUR",
        teamId: null,
        workspacePlan: "FREE",
        confirmation: confirmation ?? null,
      });
    const created = (r: Awaited<ReturnType<typeof startStripeStorageCheckout>>) => {
      expect(r.kind, JSON.stringify(r)).toBe("CREATED");
      const c = r as unknown as { attemptId: string; session: { id: string } };
      return { attemptId: c.attemptId, sessionId: c.session.id };
    };
    const blockedCode = (r: Awaited<ReturnType<typeof startStripeStorageCheckout>>) =>
      r.kind === "BLOCKED" ? (r.httpBody as { code?: string; details?: Record<string, unknown> }) : null;
    const live10 = (userId: string) =>
      prisma.workspaceStorageAddon.count({ where: { ownerUserId: userId, addonKey: "PERSONAL_10_GB", status: { in: ["ACTIVE", "PAST_DUE"] } } });
    const reviewItems = (userId: string) => prisma.billingReviewItem.count({ where: { userId } });

    it("a completed purchase does not block a confirmed second one; the first's late settlement changes nothing; the second's open page blocks a third", async () => {
      const t = await payer();
      const start = startFor(t);
      const fake = new FakeStripe();
      await withStripe(fake, async () => {
        const first = created(await start());
        fake.pay(first.sessionId, { subscription: `sub_e01a_${randomUUID().slice(0, 8)}` });
        const settled = await call("POST", `${attemptBase(t, first.attemptId)}/recheck`, t.owner.token, {});
        expect(json(settled), settled.body).toMatchObject({ currentStatus: "COMPLETED" });
        expect(await live10(t.owner.userId)).toBe(1);

        // A repeat with no statement is told what is already held ...
        expect(blockedCode(await start())).toMatchObject({ code: "STORAGE_ADDON_ALREADY_HELD", details: { activeCount: 1 } });
        // ... and a stated second purchase is a legitimate new purchase.
        const second = created(await start({ heldCount: 1 }));

        // The first session's webhook arrives late (and twice): nothing new.
        for (let i = 0; i < 2; i++) {
          const late = await settleStripeCheckoutSession({ session: fake.sessions.get(first.sessionId) as never });
          expect(late.outcome).toBe("APPLIED");
        }
        expect(await live10(t.owner.userId)).toBe(1);
        expect((await prisma.billingCheckoutAttempt.findUniqueOrThrow({ where: { id: second.attemptId } })).status).toBe("PENDING");

        // While the second page is open, a third is the SAME purchase: a repeat
        // click inside the reuse window is sent back to that page ...
        const again = await start({ heldCount: 1 });
        expect(again.kind).toBe("REUSED");
        expect((again as { attemptId: string }).attemptId).toBe(second.attemptId);
        // ... and later it is refused, even with a statement. (Time moves for
        // both: the first went live four hours ago, the second opened three.)
        await prisma.workspaceStorageAddon.updateMany({
          where: { ownerUserId: t.owner.userId, addonKey: "PERSONAL_10_GB", status: "ACTIVE" },
          data: { activatedAtUtc: new Date(Date.now() - 4 * 60 * 60 * 1000) },
        });
        await prisma.billingCheckoutAttempt.update({
          where: { id: second.attemptId },
          data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
        });
        expect(blockedCode(await start({ heldCount: 1 }))).toMatchObject({
          code: "STORAGE_PURCHASE_PENDING",
          details: { pendingProvider: "STRIPE", attemptId: second.attemptId },
        });

        // The second is paid: granted (bought after the first went live), never a duplicate.
        fake.pay(second.sessionId, { subscription: `sub_e01b_${randomUUID().slice(0, 8)}` });
        expect((await settleStripeCheckoutSession({ session: fake.sessions.get(second.sessionId) as never })).outcome).toBe("APPLIED");
        expect(await live10(t.owner.userId)).toBe(2);
        // Every redelivery afterwards changes nothing and opens no refund review.
        await settleStripeCheckoutSession({ session: fake.sessions.get(first.sessionId) as never });
        await settleStripeCheckoutSession({ session: fake.sessions.get(second.sessionId) as never });
        expect(await live10(t.owner.userId)).toBe(2);
        expect(await reviewItems(t.owner.userId)).toBe(0);
        expect(await prisma.billingCheckoutAttempt.count({ where: { userId: t.owner.userId, status: "COMPLETED" } })).toBe(2);
      });
    });

    it("a card purchase whose payment is still settling blocks a second one on either provider however old; once it settles a stated repeat is allowed", async () => {
      const t = await payer();
      const start = startFor(t);
      const fake = new FakeStripe();
      await withStripe(fake, async () => {
        const first = created(await start());
        // Paid by a method still settling: complete at Stripe, not yet paid.
        fake.pay(first.sessionId, { paid: false });
        await call("POST", `${attemptBase(t, first.attemptId)}/recheck`, t.owner.token, {});
        const row = await prisma.billingCheckoutAttempt.findUniqueOrThrow({ where: { id: first.attemptId } });
        expect(row).toMatchObject({ status: "PENDING", checkoutState: "CAPTURE_PENDING" });
        // Past the 24 h approval window: settling payments are never expired.
        await prisma.billingCheckoutAttempt.update({
          where: { id: first.attemptId },
          data: { createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000) },
        });

        const sessions = () => fake.calls.filter((c) => c.method === "POST" && c.path === "/checkout/sessions").length;
        const before = sessions();
        expect(blockedCode(await start())).toMatchObject({
          code: "STORAGE_PURCHASE_PENDING",
          details: { pendingProvider: "STRIPE", attemptId: first.attemptId },
        });
        expect(sessions()).toBe(before);
        // The same purchase retried with PayPal is refused before any PayPal row
        // (the PayPal request id) exists, so PayPal is never asked.
        const viaPayPal = await call("POST", "/v1/billing/storage-addons/checkout/paypal", t.owner.token, {
          addonKey: "PERSONAL_10_GB",
          billingCycle: "MONTHLY",
          currency: "EUR",
        });
        expect(viaPayPal.statusCode, viaPayPal.body).toBe(409);
        expect(json(viaPayPal)).toMatchObject({ code: "STORAGE_PURCHASE_PENDING", details: { pendingProvider: "STRIPE", attemptId: first.attemptId } });
        expect(await prisma.workspaceStorageAddon.count({ where: { ownerUserId: t.owner.userId, paymentProvider: "PAYPAL" } })).toBe(0);

        // Stripe settles it: one add-on, and a stated repeat is a new purchase.
        fake.pay(first.sessionId, { paid: true, subscription: `sub_e01c_${randomUUID().slice(0, 8)}` });
        const settled = await call("POST", `${attemptBase(t, first.attemptId)}/recheck`, t.owner.token, {});
        expect(json(settled), settled.body).toMatchObject({ currentStatus: "COMPLETED" });
        expect(await live10(t.owner.userId)).toBe(1);
        created(await start({ heldCount: 1 }));
      });
    });

    it("cross-provider retry: an open PayPal approval blocks the card checkout of that size, and an open card page blocks PayPal; a closed one blocks neither", async () => {
      const t = await payer();
      const start = startFor(t);
      const fake = new FakeStripe();
      await withStripe(fake, async () => {
        const paypalCreate = vi.fn(async () => ({
          result: {},
          providerSubId: `I-${randomUUID().slice(0, 12).toUpperCase()}`,
          providerHttpStatus: 201,
          providerDebugId: null,
          providerEnvironment: "sandbox",
          providerClientIdFingerprint: "fp",
          providerPlanId: "P-FAKE",
          providerCurrency: "EUR",
          approvalLinkIdentity: null,
        }));
        const paypal = await withPendingStorageAddonCheckoutGate({
          ownerUserId: t.owner.userId,
          teamId: null,
          addonKey: "PERSONAL_10_GB",
          extraStorageBytes: 1n,
          currency: "EUR",
          amountCents: 299,
          create: paypalCreate,
        });
        expect(paypal.kind).toBe("CREATED");
        const paypalRowId = (paypal as { attemptId: string }).attemptId;
        // The buyer comes back three hours later and pays by card instead.
        await prisma.workspaceStorageAddon.update({ where: { id: paypalRowId }, data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) } });
        expect(blockedCode(await start({ heldCount: 0 }))).toMatchObject({
          code: "STORAGE_PURCHASE_PENDING",
          details: { pendingProvider: "PAYPAL", attemptId: paypalRowId },
        });

        // Abandoned: no longer open, so the card checkout starts ...
        await prisma.workspaceStorageAddon.update({ where: { id: paypalRowId }, data: { status: "ABANDONED" } });
        const card = created(await start());
        await prisma.billingCheckoutAttempt.update({ where: { id: card.attemptId }, data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) } });
        // ... and its open page now blocks the PayPal retry of that size.
        const viaPayPal = await call("POST", "/v1/billing/storage-addons/checkout/paypal", t.owner.token, {
          addonKey: "PERSONAL_10_GB",
          billingCycle: "MONTHLY",
          currency: "EUR",
        });
        expect(viaPayPal.statusCode, viaPayPal.body).toBe(409);
        expect(json(viaPayPal)).toMatchObject({ code: "STORAGE_PURCHASE_PENDING", details: { pendingProvider: "STRIPE", attemptId: card.attemptId } });
        expect(paypalCreate.mock.calls.length).toBe(1);
      });
    });
  });


  // AUDIT E-06 (2026-11-15, slice COM) — SIMULATED PROVIDER. The hold on
  // automatic add-on cancellation covers the SWEEP only (automatic-effects.ts);
  // the customer's own re-check of ONE attempt applies a duplicate refusal in full.
  it("E-06: a duplicate card storage purchase found by the customer's own re-check is stopped at Stripe; the sweep only holds it", async () => {
    const previous = process.env.BILLING_AUTO_ADDON_CANCELLATION;
    delete process.env.BILLING_AUTO_ADDON_CANCELLATION;
    try {
      for (const arm of ["recheck", "sweep"] as const) {
        const t = await payer();
        const fake = new FakeStripe();
        await withStripe(fake, async () => {
          const start = () =>
            startStripeStorageCheckout({ userId: t.owner.userId, addonKey: "PERSONAL_10_GB", currency: "EUR", teamId: null, workspacePlan: "FREE" });
          const first = (await start()) as unknown as { kind: string; attemptId: string; session: { id: string } };
          expect(first.kind).toBe("CREATED");
          // An old page left open past the approval window, then a second purchase.
          await prisma.billingCheckoutAttempt.update({ where: { id: first.attemptId }, data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } });
          const second = (await start()) as unknown as { kind: string; attemptId: string; session: { id: string } };
          expect(second.kind).toBe("CREATED");
          fake.pay(second.session.id, { subscription: `sub_e06b_${randomUUID().slice(0, 8)}` });
          expect((await settleStripeCheckoutSession({ session: fake.sessions.get(second.session.id) as never })).outcome).toBe("APPLIED");

          // The OLD page is paid afterwards: a purchase started before the other went live.
          const dupSub = `sub_e06a_${randomUUID().slice(0, 8)}`;
          fake.subs.set(dupSub, { id: dupSub, object: "subscription", status: "active", metadata: {} });
          fake.pay(first.session.id, { subscription: dupSub });
          if (arm === "recheck") {
            const res = await call("POST", `${attemptBase(t, first.attemptId)}/recheck`, t.owner.token, {});
            expect(res.statusCode, res.body).toBe(200);
          } else {
            await reconcileCheckoutAttempts({
              account: { type: "PERSONAL", id: t.owner.userId, displayName: "", capabilities: ["BILLING_MANAGE"], billingOwnerMissing: false } as never,
              summary: emptySummary(),
              deps: { providers: { STRIPE: {} as never } },
            });
          }
          const deletes = fake.calls.filter((c) => c.method === "DELETE" && c.path === `/subscriptions/${dupSub}`).length;
          const review = await prisma.billingReviewItem.findFirstOrThrow({
            where: { userId: t.owner.userId, providerResourceId: dupSub, reason: "DUPLICATE_STORAGE_PURCHASE" },
          });
          expect(review.refundReviewRequired).toBe(true);
          if (arm === "recheck") {
            expect(deletes).toBe(1);
            expect(review.providerAction).toBe("CANCELED_AT_PROVIDER");
          } else {
            expect(deletes).toBe(0);
            expect(review.providerAction).toBe("NONE");
            expect(review.detail).toMatchObject({ held: "AUTOMATIC_ADDON_CANCELLATION" });
          }
          // Either way nothing extra is granted: one live add-on, the second purchase's.
          expect(
            await prisma.workspaceStorageAddon.count({
              where: { ownerUserId: t.owner.userId, addonKey: "PERSONAL_10_GB", status: { in: ["ACTIVE", "PAST_DUE"] } },
            }),
          ).toBe(1);
        });
      }
    } finally {
      if (previous === undefined) delete process.env.BILLING_AUTO_ADDON_CANCELLATION;
      else process.env.BILLING_AUTO_ADDON_CANCELLATION = previous;
    }
  });

});
