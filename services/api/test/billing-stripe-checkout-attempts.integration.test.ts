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
};

class FakeStripe {
  sessions = new Map<string, Session>();
  subs = new Map<string, Record<string, unknown>>();
  byKey = new Map<string, string>();
  calls: Array<{ method: string; path: string; key: string | null }> = [];
  createFailure: { status: number } | null = null;
  loseCreateResponse = false;
  fail = new Map<string, number>();
  private seq = 0;
  private readonly ns = randomUUID().replace(/-/g, "").slice(0, 8);
  private clock = 1_790_000_000;

  answer(method: string, path: string, body: string | null, key: string | null): { status: number; body: unknown } {
    this.calls.push({ method, path, key });
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
});
