/**
 * BILLING CHECKOUT ATTEMPTS + BILLING ACTIVITY (2026-09-28) — runtime proof on
 * live PostgreSQL 16 + Redis, with PayPal answered by an in-process STATEFUL
 * fake (no socket is opened; the outbound guard stays installed).
 *
 * What is proven here is PROOVRA's behaviour against PayPal's documented
 * answers — the requests it builds, the rows it writes, and how it converges
 * whatever order the answers arrive in. It is NOT proof that the real PayPal
 * accepts them; that needs the Sandbox run described in the billing audit.
 *
 * Covered:
 *   - two pending storage attempts + an empty payment table -> Billing activity
 *   - pending plan and credit purchases in Billing activity
 *   - duplicate click -> one provider create (stable PayPal-Request-Id reuse)
 *   - lost create response -> webhook binds the attempt by custom_id
 *   - credit approval vs completed capture; return and webhook in both orders
 *   - account re-check across every attempt type with 404/401/5xx/malformed
 *   - provider-first abandonment, and provider truth winning afterwards
 *   - cross-account refusal of every read and action
 *   - a never-activated PayPal plan cancelled later cannot downgrade a payer
 *   - storage create diagnostics survive the CREATED webhook
 *   - a PayPal plan change keeps the subscription's own currency
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedPersonalTenant,
  type FixtureDeps,
  type PersonalTenant,
} from "./point7/product-fixtures.js";

const PAYPAL = "http://127.0.0.1:9/attempts-paypal-fake";
/** Per-run suffix: the disposable database outlives one run. */
const RUN = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
const I_EURSUB0001 = `I-EURSUB${RUN}`;
const I_NOTFOUND0001 = `I-NOTFOUND${RUN}`;
const I_OPEN00000001 = `I-OPEN0000${RUN}`;
const I_AUTH00000001 = `I-AUTH0000${RUN}`;
const ORDERDOWN00001 = `ORDERDOWN0${RUN}`;
const ORDERODD000001 = `ORDERODD00${RUN}`;
const I_FOREIGN00001 = `I-FOREIGN0${RUN}`;

type Sub = {
  id: string;
  status: string;
  custom_id: string;
  plan_id: string;
  update_time: string;
  create_time: string;
};
type Order = {
  id: string;
  status: string;
  custom_id: string;
  amount: { currency_code: string; value: string };
  captures: Array<{ id: string; status: string; amount: { currency_code: string; value: string }; update_time: string }>;
  update_time: string;
};

/** A deterministic in-memory PayPal. `fail` forces an HTTP status for a resource id. */
class FakePayPal {
  subs = new Map<string, Sub>();
  orders = new Map<string, Order>();
  byRequestId = new Map<string, string>();
  fail = new Map<string, { status: number; body?: unknown }>();
  createFailure: { status: number } | null = null;
  calls: Array<{ method: string; url: string; body: string | null; requestId: string | null }> = [];
  captureStatus = "COMPLETED";
  private seq = 0;
  /** Unique per fake, so ids never collide with another test's rows. */
  private readonly ns = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  private tick = Date.parse("2026-09-28T10:00:00Z");

  now(): string {
    this.tick += 1000;
    return new Date(this.tick).toISOString();
  }

  answer(method: string, url: string, body: string | null, requestId: string | null): { status: number; body: unknown } {
    this.calls.push({ method, url, body, requestId });
    const path = url.slice(PAYPAL.length);
    if (path === "/v1/oauth2/token") return { status: 200, body: { access_token: "fake" } };
    if (path.startsWith("/v1/billing/plans/")) {
      return { status: 200, body: { id: path.split("/").pop(), status: "ACTIVE" } };
    }
    if (path === "/v1/billing/subscriptions" && method === "POST") {
      if (this.createFailure) return { status: this.createFailure.status, body: { name: "X", message: "x" } };
      const existing = requestId ? this.byRequestId.get(requestId) : undefined;
      if (existing) return { status: 200, body: this.subBody(this.subs.get(existing)!) };
      const parsed = JSON.parse(body ?? "{}") as { plan_id: string; custom_id: string };
      const id = `I-${this.ns}${(++this.seq).toString().padStart(6, "0")}`;
      const t = this.now();
      this.subs.set(id, { id, status: "APPROVAL_PENDING", custom_id: parsed.custom_id, plan_id: parsed.plan_id, update_time: t, create_time: t });
      if (requestId) this.byRequestId.set(requestId, id);
      return { status: 201, body: this.subBody(this.subs.get(id)!) };
    }
    const subMatch = path.match(/^\/v1\/billing\/subscriptions\/([^/?]+)(\/.*)?$/);
    if (subMatch) {
      const id = decodeURIComponent(subMatch[1]!);
      const forced = this.fail.get(id);
      if (forced) return { status: forced.status, body: forced.body ?? { name: "ERR" } };
      const sub = this.subs.get(id);
      if (!sub) return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
      if (subMatch[2]?.startsWith("/transactions")) return { status: 200, body: { transactions: [] } };
      if (subMatch[2] === "/revise" && method === "POST") {
        const parsed = JSON.parse(body ?? "{}") as { plan_id: string };
        return { status: 200, body: { plan_id: parsed.plan_id, links: [] } };
      }
      return { status: 200, body: this.subBody(sub) };
    }
    if (path === "/v2/checkout/orders" && method === "POST") {
      if (this.createFailure) return { status: this.createFailure.status, body: { name: "X", message: "x" } };
      const existing = requestId ? this.byRequestId.get(requestId) : undefined;
      if (existing) return { status: 200, body: this.orderBody(this.orders.get(existing)!) };
      const parsed = JSON.parse(body ?? "{}") as { purchase_units: Array<{ custom_id: string; amount: Order["amount"] }> };
      const id = `O${this.ns}${(++this.seq).toString().padStart(8, "0")}`;
      this.orders.set(id, {
        id,
        status: "CREATED",
        custom_id: parsed.purchase_units[0]!.custom_id,
        amount: parsed.purchase_units[0]!.amount,
        captures: [],
        update_time: this.now(),
      });
      if (requestId) this.byRequestId.set(requestId, id);
      return { status: 201, body: this.orderBody(this.orders.get(id)!) };
    }
    if (path.startsWith("/v2/payments/captures/")) return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
    const orderMatch = path.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    if (orderMatch) {
      const id = decodeURIComponent(orderMatch[1]!);
      const forced = this.fail.get(id);
      if (forced) return { status: forced.status, body: forced.body ?? { name: "ERR" } };
      const order = this.orders.get(id);
      if (!order) return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
      if (orderMatch[2]) {
        if (order.status === "COMPLETED") {
          return { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] } };
        }
        if (order.status !== "APPROVED") {
          return { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] } };
        }
        order.status = "COMPLETED";
        order.update_time = this.now();
        order.captures.push({ id: `CAP${this.ns}${(++this.seq).toString().padStart(6, "0")}`, status: this.captureStatus, amount: order.amount, update_time: order.update_time });
        return { status: 201, body: this.orderBody(order) };
      }
      return { status: 200, body: this.orderBody(order) };
    }
    return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
  }

  subBody(sub: Sub) {
    return {
      ...sub,
      status_update_time: sub.update_time,
      billing_info: sub.status === "ACTIVE" ? { next_billing_time: "2026-10-28T10:00:00Z" } : {},
      links:
        sub.status === "APPROVAL_PENDING"
          ? [{ rel: "approve", href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${sub.id}` }]
          : [],
    };
  }

  orderBody(order: Order) {
    return {
      id: order.id,
      status: order.status,
      update_time: order.update_time,
      purchase_units: [
        { custom_id: order.custom_id, amount: order.amount, payments: { captures: order.captures } },
      ],
      links:
        order.status === "CREATED"
          ? [{ rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}` }]
          : [],
    };
  }

  setSub(id: string, status: string) {
    const sub = this.subs.get(id)!;
    sub.status = status;
    sub.update_time = this.now();
  }
}

describe("Billing checkout attempts + activity (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let pricing: typeof import("../src/services/billing-pricing.service.js");
  let deps: FixtureDeps;
  const tag = `bca-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

  const call = (method: "POST" | "GET", url: string, token: string, payload?: unknown) =>
    harness.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(method === "POST" ? { payload: (payload ?? {}) as never } : {}),
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (res: { body: string }) => JSON.parse(res.body) as Record<string, any>;

  async function withPayPal<T>(fake: FakePayPal, fn: () => Promise<T>): Promise<T> {
    const settings: Record<string, string> = {
      PAYPAL_CLIENT_ID: "fake-client",
      PAYPAL_SECRET: "fake-secret",
      PAYPAL_API_BASE: PAYPAL,
      PAYPAL_PRO_PLAN_ID_USD: "P-PRO-USD",
      PAYPAL_PRO_PLAN_ID_EUR: "P-PRO-EUR",
      PAYPAL_TEAM_PLAN_ID_USD: "P-TEAM-USD",
      PAYPAL_TEAM_PLAN_ID_EUR: "P-TEAM-EUR",
      PAYPAL_PLAN_STORAGE_PERSONAL_50_GB_EUR: "P-STORAGE-50-EUR",
      PAYPAL_PLAN_STORAGE_PERSONAL_50_GB_USD: "P-STORAGE-50-USD",
    };
    const previous = new Map(Object.keys(settings).map((k) => [k, process.env[k]]));
    Object.assign(process.env, settings);
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (!url.startsWith(PAYPAL)) return realFetch(input as never, init);
      const headers = new Headers(init?.headers);
      const out = fake.answer(
        init?.method ?? "GET",
        url,
        init?.body == null ? null : String(init.body),
        headers.get("paypal-request-id"),
      );
      return new Response(JSON.stringify(out.body), {
        status: out.status,
        headers: { "content-type": "application/json", "paypal-debug-id": "fake-debug" },
      });
    });
    try {
      return await fn();
    } finally {
      spy.mockRestore();
      for (const [k, v] of previous) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  async function payer(plan: "FREE" | "PRO" = "FREE"): Promise<PersonalTenant> {
    return seedPersonalTenant(deps, plan);
  }

  const activity = async (t: PersonalTenant) => {
    const res = await call("GET", `/v1/billing/accounts/PERSONAL/${t.owner.userId}/history`, t.owner.token);
    expect(res.statusCode, res.body).toBe(200);
    return json(res);
  };

  async function seedStorageAttempt(userId: string, providerSubId: string | null, extra: Record<string, unknown> = {}) {
    return prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId: userId,
        addonKey: "PERSONAL_50_GB",
        extraStorageBytes: 50n * 1024n * 1024n * 1024n,
        billingCycle: "MONTHLY",
        status: "PENDING",
        paymentProvider: "PAYPAL",
        externalSubscriptionId: providerSubId,
        currency: "EUR",
        amountCents: 799,
        metadata: { source: "paypal.storage_addon_checkout", checkoutState: providerSubId ? "AWAITING_CUSTOMER_APPROVAL" : "PROVIDER_OUTCOME_UNKNOWN" },
        ...extra,
      },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    pricing = await import("../src/services/billing-pricing.service.js");
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

  // ---------------------------------------------------------------------------
  it("two pending 50 GB storage attempts with no payments appear in Billing activity, not as 'No payments'", async () => {
    const t = await payer();
    await seedStorageAttempt(t.owner.userId, `I-A${randomUUID().slice(0, 10).toUpperCase()}`);
    await seedStorageAttempt(t.owner.userId, `I-B${randomUUID().slice(0, 10).toUpperCase()}`);

    const body = await activity(t);
    expect(body.items).toEqual([]);
    expect(body.activity).toHaveLength(2);
    for (const item of body.activity) {
      expect(item).toMatchObject({
        product: "STORAGE",
        description: "+50 GB storage add-on",
        providerLabel: "PayPal",
        state: "AWAITING_APPROVAL",
        amountCents: 799,
        currency: "EUR",
        recurring: true,
        actions: { canRecheck: true, canAbandon: true },
      });
      expect(item.explanation).toMatch(/not in your payment history/);
      // No provider id, no internal reference in the DTO.
      expect(JSON.stringify(item)).not.toMatch(/I-A|I-B|SA-/);
    }
  });

  it("a storage attempt's create diagnostics survive the CREATED webhook write", async () => {
    const t = await payer();
    const ref = `I-D${randomUUID().slice(0, 10).toUpperCase()}`;
    const row = await seedStorageAttempt(t.owner.userId, ref, {
      metadata: { checkoutState: "AWAITING_CUSTOMER_APPROVAL", providerDebugId: "dbg-create", providerHttpStatus: 201 },
    });
    const { upsertWorkspaceStorageAddon } = await import("../src/services/billing.service.js");
    await upsertWorkspaceStorageAddon({
      attemptId: row.id,
      ownerUserId: t.owner.userId,
      addonKey: "PERSONAL_50_GB",
      billingCycle: "MONTHLY",
      status: "PENDING",
      paymentProvider: "PAYPAL",
      externalSubscriptionId: ref,
      metadata: { source: "BILLING.SUBSCRIPTION.CREATED" },
    });
    const after = await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.metadata).toMatchObject({
      providerDebugId: "dbg-create",
      providerHttpStatus: 201,
      source: "BILLING.SUBSCRIPTION.CREATED",
    });
    expect(after.externalSubscriptionId).toBe(ref);
  });

  // ---------------------------------------------------------------------------
  describe("evidence credits", () => {
    it("duplicate click reuses the same PayPal order; return then webhook grants exactly once", async () => {
      const t = await payer();
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        const a = await call("POST", "/v1/billing/credits/checkout/paypal", t.owner.token, { currency: "USD" });
        const b = await call("POST", "/v1/billing/credits/checkout/paypal", t.owner.token, { currency: "USD" });
        expect(a.statusCode, a.body).toBe(200);
        expect(b.statusCode, b.body).toBe(200);
        expect(json(a).order.id).toBe(json(b).order.id);
        expect(fake.calls.filter((c) => c.method === "POST" && c.url.endsWith("/v2/checkout/orders"))).toHaveLength(1);

        const orderId = json(a).order.id as string;
        const attempt = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { userId: t.owner.userId } });
        expect(attempt).toMatchObject({ product: "EVIDENCE_CREDIT", providerResourceId: orderId, checkoutState: "AWAITING_CUSTOMER_APPROVAL" });
        expect(fake.orders.get(orderId)!.custom_id).toBe(`${t.owner.userId}::PAYG:${attempt.id}`);
        expect(attempt.amountCents).toBe(pricing.getPlanPriceCents("PAYG", "USD"));

        // Pending credit purchase is in Billing activity before any payment.
        const pending = await activity(t);
        expect(pending.items).toEqual([]);
        expect(pending.activity[0]).toMatchObject({ product: "EVIDENCE_CREDIT", state: "AWAITING_APPROVAL" });

        // Approval alone grants nothing.
        fake.orders.get(orderId)!.status = "APPROVED";
        expect(await prisma.evidenceCreditLedgerEntry.count({ where: { userId: t.owner.userId } })).toBe(0);

        // Return route captures; the webhook afterwards is a no-op.
        const ret = await call("POST", `/v1/billing/credits/checkout/paypal/${orderId}/capture`, t.owner.token, {});
        expect(json(ret)).toMatchObject({ outcome: "GRANTED" });
        const { settlePayPalEvidenceCreditOrder } = await import("../src/services/billing/paypal-settlement.service.js");
        const hook = await settlePayPalEvidenceCreditOrder({ orderId, capture: true });
        expect(hook.outcome).toBe("ALREADY_GRANTED");

        expect(await prisma.evidenceCreditLedgerEntry.count({ where: { userId: t.owner.userId, entryType: "PURCHASE" } })).toBe(1);
        expect(await prisma.payment.count({ where: { userId: t.owner.userId, status: "SUCCEEDED" } })).toBe(1);
        const done = await prisma.billingCheckoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
        expect(done).toMatchObject({ status: "COMPLETED", checkoutState: "SETTLED" });
        expect(done.providerPaymentRef).toMatch(/^CAP/);

        const after = await activity(t);
        expect(after.activity).toEqual([]);
        expect(after.items).toHaveLength(1);
        expect(after.items[0]).toMatchObject({ status: "SUCCEEDED", description: expect.stringMatching(/[Ee]vidence credit/) });
      });
    });

    it("webhook first, then return: still exactly one grant", async () => {
      const t = await payer();
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        const a = await call("POST", "/v1/billing/credits/checkout/paypal", t.owner.token, { currency: "EUR" });
        const orderId = json(a).order.id as string;
        fake.orders.get(orderId)!.status = "APPROVED";
        const { settlePayPalEvidenceCreditOrder } = await import("../src/services/billing/paypal-settlement.service.js");
        expect((await settlePayPalEvidenceCreditOrder({ orderId, capture: true })).outcome).toBe("GRANTED");
        const ret = await call("POST", `/v1/billing/credits/checkout/paypal/${orderId}/capture`, t.owner.token, {});
        expect(json(ret).outcome).toBe("ALREADY_GRANTED");
        expect(await prisma.evidenceCreditLedgerEntry.count({ where: { userId: t.owner.userId, entryType: "PURCHASE" } })).toBe(1);
      });
    });

    it("a PENDING capture grants nothing, cannot be abandoned, and completes once later", async () => {
      const t = await payer();
      const fake = new FakePayPal();
      fake.captureStatus = "PENDING";
      await withPayPal(fake, async () => {
        const a = await call("POST", "/v1/billing/credits/checkout/paypal", t.owner.token, {});
        const orderId = json(a).order.id as string;
        fake.orders.get(orderId)!.status = "APPROVED";
        const ret = await call("POST", `/v1/billing/credits/checkout/paypal/${orderId}/capture`, t.owner.token, {});
        expect(json(ret)).toMatchObject({ outcome: "PENDING", credits: 0 });
        const attempt = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { userId: t.owner.userId } });
        expect(attempt.checkoutState).toBe("CAPTURE_PENDING");
        const list = await activity(t);
        expect(list.activity[0]).toMatchObject({ state: "PROCESSING", actions: { canAbandon: false } });

        const ab = await call("POST", `/v1/billing/accounts/PERSONAL/${t.owner.userId}/checkout-attempts/${attempt.id}/abandon`, t.owner.token, { confirmed: true });
        expect(json(ab).outcome).toBe("ABANDON_NOT_ALLOWED");
        expect(await prisma.evidenceCreditLedgerEntry.count({ where: { userId: t.owner.userId } })).toBe(0);

        // PayPal completes the capture; the capture webhook settles it once.
        const order = fake.orders.get(orderId)!;
        order.captures[0]!.status = "COMPLETED";
        order.captures[0]!.update_time = fake.now();
        order.update_time = order.captures[0]!.update_time;
        const { handlePayPalCaptureWebhook } = await import("../src/services/billing/paypal-settlement.service.js");
        const hook = await handlePayPalCaptureWebhook({ id: order.captures[0]!.id, supplementary_data: { related_ids: { order_id: orderId } } });
        expect(hook?.outcome).toBe("GRANTED");
        const again = await handlePayPalCaptureWebhook({ id: order.captures[0]!.id, supplementary_data: { related_ids: { order_id: orderId } } });
        expect(again?.outcome).toBe("ALREADY_GRANTED");
        expect(await prisma.evidenceCreditLedgerEntry.count({ where: { userId: t.owner.userId, entryType: "PURCHASE" } })).toBe(1);
        expect((await prisma.billingCheckoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe("COMPLETED");
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe("plans", () => {
    it("a lost create response is recovered by the CREATED/ACTIVATED webhook via custom_id, and upgrades only on ACTIVE", async () => {
      const t = await payer();
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        // PayPal creates the subscription, but PROOVRA never sees the response.
        fake.createFailure = null;
        const realAnswer = fake.answer.bind(fake);
        let createdId = "";
        fake.answer = (method, url, body, requestId) => {
          const out = realAnswer(method, url, body, requestId);
          if (method === "POST" && url.endsWith("/v1/billing/subscriptions")) {
            createdId = (out.body as { id: string }).id;
            return { status: 504, body: { name: "GATEWAY_TIMEOUT" } };
          }
          return out;
        };
        const res = await call("POST", "/v1/billing/checkout/paypal", t.owner.token, { plan: "TEAM", currency: "USD" });
        expect(res.statusCode).toBeGreaterThanOrEqual(500);
        const attempt = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { userId: t.owner.userId } });
        expect(attempt).toMatchObject({ status: "PENDING", checkoutState: "PROVIDER_OUTCOME_UNKNOWN", providerResourceId: null });
        expect(fake.subs.get(createdId)!.custom_id).toBe(`${t.owner.userId}::TEAM:${attempt.id}`);

        const list = await activity(t);
        expect(list.activity[0]).toMatchObject({ product: "PLAN", description: "Team plan", state: "NOT_CONFIRMED_BY_PROVIDER" });

        // Webhook CREATED (live read) binds the attempt; nothing is granted.
        const { applyPayPalSubscriptionState } = await import("../src/services/billing/paypal-settlement.service.js");
        await applyPayPalSubscriptionState({ subscriptionId: createdId, source: "BILLING.SUBSCRIPTION.CREATED" });
        const bound = await prisma.billingCheckoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
        expect(bound).toMatchObject({ providerResourceId: createdId, checkoutState: "AWAITING_CUSTOMER_APPROVAL" });
        expect((await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).plan).toBe("FREE");

        // Buyer approves; ACTIVATED webhook applies TEAM and completes the attempt.
        fake.setSub(createdId, "ACTIVE");
        await applyPayPalSubscriptionState({ subscriptionId: createdId, source: "BILLING.SUBSCRIPTION.ACTIVATED" });
        expect((await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).plan).toBe("TEAM");
        expect((await prisma.billingCheckoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe("COMPLETED");
        expect((await activity(t)).activity).toEqual([]);

        // A stale page cannot buy a second base subscription.
        const second = await call("POST", "/v1/billing/checkout/paypal", t.owner.token, { plan: "PRO", currency: "USD" });
        expect(second.statusCode).toBe(409);
        expect(json(second).code).toBe("SUBSCRIPTION_ALREADY_ACTIVE");
      });
    });

    it("duplicate click on a plan checkout reuses the PayPal subscription already issued", async () => {
      const t = await payer();
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        const a = await call("POST", "/v1/billing/checkout/paypal", t.owner.token, { plan: "PRO", currency: "USD" });
        const b = await call("POST", "/v1/billing/checkout/paypal", t.owner.token, { plan: "PRO", currency: "USD" });
        expect(a.statusCode, a.body).toBe(200);
        expect(b.statusCode, b.body).toBe(200);
        expect(json(b).subscription.id).toBe(json(a).subscription.id);
        expect(fake.calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/billing/subscriptions"))).toHaveLength(1);
        // A different tier while one is open is refused, not created.
        const c = await call("POST", "/v1/billing/checkout/paypal", t.owner.token, { plan: "TEAM", currency: "USD" });
        expect(c.statusCode).toBe(409);
        expect(json(c).code).toBe("PAYPAL_DIFFERENT_PLAN_PENDING");
      });
    });

    it("abandoning an open approval is provider-first, confirmed, local-only, and provider truth still wins later", async () => {
      const t = await payer();
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        const a = await call("POST", "/v1/billing/checkout/paypal", t.owner.token, { plan: "PRO", currency: "USD" });
        const subId = json(a).subscription.id as string;
        const attempt = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { userId: t.owner.userId } });
        const base = `/v1/billing/accounts/PERSONAL/${t.owner.userId}/checkout-attempts/${attempt.id}`;

        const check = await call("POST", `${base}/recheck`, t.owner.token, {});
        expect(json(check)).toMatchObject({ product: "PLAN", outcome: "STILL_PENDING" });
        expect(json(check).resumeUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);

        const first = await call("POST", `${base}/abandon`, t.owner.token, {});
        expect(json(first)).toMatchObject({ outcome: "ABANDON_CONFIRMATION_REQUIRED", cancelsAtProvider: false });
        expect(json(first).warning).toMatch(/does not cancel/);
        expect((await prisma.billingCheckoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe("PENDING");

        const confirmed = await call("POST", `${base}/abandon`, t.owner.token, { confirmed: true });
        expect(json(confirmed).outcome).toBe("ABANDONED");
        expect((await prisma.subscription.findFirstOrThrow({ where: { providerSubId: subId } })).status).toBe("CANCELED");
        expect(fake.calls.some((c) => c.url.endsWith("/cancel"))).toBe(false);

        // The customer can start again.
        const again = await call("POST", "/v1/billing/checkout/paypal", t.owner.token, { plan: "PRO", currency: "USD" });
        expect(again.statusCode, again.body).toBe(200);

        // ...and if they later approve the OLD one at PayPal, it still applies.
        fake.setSub(subId, "ACTIVE");
        const { applyPayPalSubscriptionState } = await import("../src/services/billing/paypal-settlement.service.js");
        await applyPayPalSubscriptionState({ subscriptionId: subId, source: "BILLING.SUBSCRIPTION.ACTIVATED" });
        expect((await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).plan).toBe("PRO");
        expect((await prisma.billingCheckoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe("COMPLETED");
      });
    });

    it("a never-activated PayPal approval that PayPal later cancels cannot downgrade a paid (or granted) payer", async () => {
      const t = await payer("PRO");
      // An unrelated live Stripe subscription carries PRO.
      await prisma.subscription.create({
        data: { userId: t.owner.userId, provider: "STRIPE", providerSubId: `sub_${randomUUID().slice(0, 10)}`, status: "ACTIVE", plan: "PRO" },
      });
      const trialing = `I-OLD${randomUUID().slice(0, 8).toUpperCase()}`;
      await prisma.subscription.create({
        data: { userId: t.owner.userId, provider: "PAYPAL", providerSubId: trialing, status: "TRIALING", plan: "TEAM" },
      });
      const { syncPlanForSubscription } = await import("../src/services/billing/subscription-lifecycle.handlers.js");
      await syncPlanForSubscription({
        userId: t.owner.userId,
        plan: "TEAM",
        provider: "PAYPAL",
        providerSubId: trialing,
        status: "CANCELED",
        observedAtUtc: new Date(),
      });
      expect((await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).plan).toBe("PRO");

      // Granted PRO, no subscription at all: same protection.
      const g = await payer("PRO");
      const gTrial = `I-GR${randomUUID().slice(0, 8).toUpperCase()}`;
      await prisma.subscription.create({
        data: { userId: g.owner.userId, provider: "PAYPAL", providerSubId: gTrial, status: "TRIALING", plan: "TEAM" },
      });
      await syncPlanForSubscription({ userId: g.owner.userId, plan: "TEAM", provider: "PAYPAL", providerSubId: gTrial, status: "CANCELED", observedAtUtc: new Date() });
      expect((await prisma.entitlement.findFirstOrThrow({ where: { userId: g.owner.userId, active: true } })).plan).toBe("PRO");

      // The subscription that DID carry the plan still downgrades when it ends.
      const p = await payer("PRO");
      const live = `I-LIVE${randomUUID().slice(0, 8).toUpperCase()}`;
      await prisma.subscription.create({
        data: { userId: p.owner.userId, provider: "PAYPAL", providerSubId: live, status: "ACTIVE", plan: "PRO" },
      });
      await syncPlanForSubscription({ userId: p.owner.userId, plan: "PRO", provider: "PAYPAL", providerSubId: live, status: "CANCELED", observedAtUtc: new Date() });
      expect((await prisma.entitlement.findFirstOrThrow({ where: { userId: p.owner.userId, active: true } })).plan).toBe("FREE");
    });

    it("a PayPal plan change keeps the subscription's own currency (EUR), not a USD default", async () => {
      const t = await payer("PRO");
      const fake = new FakePayPal();
      const subId = I_EURSUB0001;
      fake.subs.set(subId, { id: subId, status: "ACTIVE", custom_id: `${t.owner.userId}::PRO`, plan_id: "P-PRO-EUR", update_time: fake.now(), create_time: fake.now() });
      await prisma.subscription.create({
        data: { userId: t.owner.userId, provider: "PAYPAL", providerSubId: subId, status: "ACTIVE", plan: "PRO", currentPeriodEnd: new Date(Date.now() + 20 * 86400_000) },
      });
      await withPayPal(fake, async () => {
        const res = await call("POST", "/v1/billing/subscription/plan", t.owner.token, { plan: "TEAM" });
        expect(res.statusCode, res.body).toBe(200);
        const revise = fake.calls.find((c) => c.url.endsWith("/revise"));
        expect(JSON.parse(revise!.body!)).toEqual({ plan_id: "P-TEAM-EUR" });
      });
      // Scheduled, not granted.
      expect((await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).plan).toBe("PRO");
    });
  });

  // ---------------------------------------------------------------------------
  describe("account re-check covers every attempt type and reports provider failures truthfully", () => {
    it("404 / 401 / 5xx / malformed / unbound / still-pending are each classified, and nothing is created", async () => {
      const t = await payer();
      const fake = new FakePayPal();
      // storage: 404 (like the two production attempts), unbound, still pending
      const s404 = await seedStorageAttempt(t.owner.userId, I_NOTFOUND0001);
      const sUnbound = await seedStorageAttempt(t.owner.userId, null);
      fake.subs.set(I_OPEN00000001, { id: I_OPEN00000001, status: "APPROVAL_PENDING", custom_id: `sa2|${t.owner.userId}|-|p50|${randomUUID()}`, plan_id: "P-STORAGE-50-EUR", update_time: fake.now(), create_time: fake.now() });
      const sOpen = await seedStorageAttempt(t.owner.userId, I_OPEN00000001);
      // plan: 401 and 5xx
      const p401 = await prisma.billingCheckoutAttempt.create({
        data: { userId: t.owner.userId, product: "PLAN", provider: "PAYPAL", planKey: "PRO", amountCents: 1900, currency: "USD", checkoutState: "AWAITING_CUSTOMER_APPROVAL", providerResourceId: I_AUTH00000001 },
      });
      fake.fail.set(I_AUTH00000001, { status: 401 });
      const credit5xx = await prisma.billingCheckoutAttempt.create({
        data: { userId: t.owner.userId, product: "EVIDENCE_CREDIT", provider: "PAYPAL", amountCents: 500, currency: "USD", checkoutState: "AWAITING_CUSTOMER_APPROVAL", providerResourceId: ORDERDOWN00001 },
      });
      fake.fail.set(ORDERDOWN00001, { status: 503 });
      // credit: malformed (unknown order status)
      fake.orders.set(ORDERODD000001, { id: ORDERODD000001, status: "SOMETHING_NEW", custom_id: `${t.owner.userId}::PAYG`, amount: { currency_code: "USD", value: "5.00" }, captures: [], update_time: fake.now() });
      const creditOdd = await prisma.billingCheckoutAttempt.create({
        data: { userId: t.owner.userId, product: "EVIDENCE_CREDIT", provider: "PAYPAL", amountCents: 500, currency: "USD", checkoutState: "AWAITING_CUSTOMER_APPROVAL", providerResourceId: ORDERODD000001 },
      });

      const res = await withPayPal(fake, () =>
        call("POST", `/v1/billing/accounts/PERSONAL/${t.owner.userId}/reconcile`, t.owner.token, {}),
      );
      expect(res.statusCode, res.body).toBe(200);
      const summary = json(res).summary;
      const by = (id: string) => summary.attempts.find((a: { attemptId: string }) => a.attemptId === id);
      expect(by(s404.id)).toMatchObject({ product: "STORAGE", outcome: "PROVIDER_REFERENCE_NOT_FOUND" });
      expect(by(sUnbound.id)).toMatchObject({ product: "STORAGE", outcome: "NOT_PROVIDER_BOUND" });
      expect(by(sOpen.id)).toMatchObject({ product: "STORAGE", outcome: "STILL_PENDING" });
      expect(by(p401.id)).toMatchObject({ product: "PLAN", outcome: "PROVIDER_AUTHORIZATION_FAILED" });
      expect(by(credit5xx.id)).toMatchObject({ product: "EVIDENCE_CREDIT", outcome: "PROVIDER_UNAVAILABLE" });
      expect(by(creditOdd.id)).toMatchObject({ product: "EVIDENCE_CREDIT", outcome: "PROVIDER_MALFORMED" });
      expect(summary.pending).toBe(1); // ONLY the provider-confirmed open approval
      expect(summary.unavailable).toBe(1);
      expect(summary.actionRequired).toBe(4);
      expect(summary.attempts.every((a: { providerStatus?: unknown }) => a.providerStatus === undefined)).toBe(true);
      expect(fake.calls.filter((c) => c.method === "POST" && !c.url.endsWith("/oauth2/token"))).toEqual([]);

      // The activity list now says WHY each is still open.
      const list = await activity(t);
      const state = (id: string) => list.activity.find((a: { id: string }) => a.id === id)?.state;
      expect(state(s404.id)).toBe("PROVIDER_NO_RECORD");
      expect(state(sUnbound.id)).toBe("NOT_CONFIRMED_BY_PROVIDER");
      expect(state(sOpen.id)).toBe("AWAITING_APPROVAL");
      expect(state(credit5xx.id)).toBe("PROVIDER_UNREACHABLE");
      expect(state(p401.id)).toBe("PROVIDER_UNVERIFIED");

      // After abandoning the 404 attempt, a re-check no longer asks for action on it.
      const ab = await withPayPal(fake, () =>
        call("POST", `/v1/billing/accounts/PERSONAL/${t.owner.userId}/checkout-attempts/${s404.id}/abandon`, t.owner.token, { confirmed: true }),
      );
      expect(json(ab)).toMatchObject({ outcome: "ABANDONED", cancelsAtProvider: false });
      expect(fake.calls.some((c) => c.url.includes("/cancel"))).toBe(false);
      const { reconcileBillingAccount } = await import("../src/services/billing/reconciliation/reconciliation.service.js");
      const { listBillingAccountsForViewer } = await import("../src/services/billing/billing-accounts.service.js");
      const account = (await listBillingAccountsForViewer(t.owner.userId)).find((a) => a.type === "PERSONAL")!;
      const again = await withPayPal(fake, () => reconcileBillingAccount({ account }));
      const abandoned = again.attempts.find((a) => a.attemptId === s404.id);
      expect(abandoned).toMatchObject({ outcome: "PROVIDER_REFERENCE_NOT_FOUND", locallyAbandoned: true });
      expect(again.actionRequired).toBe(3);
      const storage = await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: s404.id } });
      expect(storage.status).toBe("ABANDONED");
    });
  });

  // ---------------------------------------------------------------------------
  it("another account can neither read nor act on these attempts", async () => {
    const owner = await payer();
    const stranger = await payer();
    const s = await seedStorageAttempt(owner.owner.userId, I_FOREIGN00001);
    const plan = await prisma.billingCheckoutAttempt.create({
      data: { userId: owner.owner.userId, product: "PLAN", provider: "PAYPAL", planKey: "PRO", amountCents: 1900, currency: "USD", checkoutState: "PROVIDER_OUTCOME_UNKNOWN" },
    });
    const foreignHistory = await call("GET", `/v1/billing/accounts/PERSONAL/${owner.owner.userId}/history`, stranger.owner.token);
    expect(foreignHistory.statusCode).toBe(404);
    for (const id of [s.id, plan.id]) {
      for (const action of ["recheck", "abandon"]) {
        // Own account path, foreign attempt id -> 404, nothing changes.
        const own = await call("POST", `/v1/billing/accounts/PERSONAL/${stranger.owner.userId}/checkout-attempts/${id}/${action}`, stranger.owner.token, { confirmed: true });
        expect(own.statusCode, `${action} ${id}`).toBe(404);
        // Foreign account path -> 404 account.
        const foreign = await call("POST", `/v1/billing/accounts/PERSONAL/${owner.owner.userId}/checkout-attempts/${id}/${action}`, stranger.owner.token, { confirmed: true });
        expect(foreign.statusCode).toBe(404);
      }
    }
    expect((await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("PENDING");
    expect((await prisma.billingCheckoutAttempt.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe("PENDING");
    expect((await activity(stranger)).activity).toEqual([]);
  });

  it("a repeated click on one attempt's action is refused while the first runs", async () => {
    const t = await payer();
    const plan = await prisma.billingCheckoutAttempt.create({
      data: { userId: t.owner.userId, product: "PLAN", provider: "PAYPAL", planKey: "PRO", amountCents: 1900, currency: "USD", checkoutState: "PROVIDER_OUTCOME_UNKNOWN" },
    });
    const url = `/v1/billing/accounts/PERSONAL/${t.owner.userId}/checkout-attempts/${plan.id}/recheck`;
    const [a, b] = await Promise.all([call("POST", url, t.owner.token, {}), call("POST", url, t.owner.token, {})]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const ok = a.statusCode === 200 ? a : b;
    expect(json(ok)).toMatchObject({ outcome: "NOT_PROVIDER_BOUND", currentStatus: "PENDING" });
  });
});
