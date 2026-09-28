/**
 * BILLING PAYPAL INTEGRITY (2026-09-28) — the money and entitlement
 * invariants of the PayPal repair, proven on live PostgreSQL 16 + Redis with
 * PayPal answered by an in-process STATEFUL fake (no socket is opened; the
 * outbound guard stays installed).
 *
 * This is proof of PROOVRA's behaviour against PayPal's DOCUMENTED answers. It
 * is not PayPal Sandbox proof.
 *
 * Findings covered (audit 2026-09-28): A dependent storage cancellation,
 * B abandoned approvals / duplicate subscriptions, C storage activation
 * parity, D pre-create failures, E product identity of payments, F lost
 * capture response + sweep, G refunds, H workspace storage target, I plan
 * revisions awaiting approval, J/K price authority, N buyer cancel + expiry,
 * O truthful re-check concurrency, P PAST_DUE ordering.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedPersonalTenant,
  type FixtureDeps,
  type PersonalTenant,
} from "./point7/product-fixtures.js";

const PAYPAL = "http://127.0.0.1:9/integrity-paypal-fake";
const GB = BigInt(1024) ** BigInt(3);

type Sub = {
  id: string;
  status: string;
  custom_id: string;
  plan_id: string;
  update_time: string;
};
type Capture = { id: string; status: string; amount: { currency_code: string; value: string }; update_time: string };
type Order = {
  id: string;
  status: string;
  custom_id: string;
  amount: { currency_code: string; value: string };
  captures: Capture[];
  update_time: string;
};

class FakePayPal {
  subs = new Map<string, Sub>();
  orders = new Map<string, Order>();
  byRequestId = new Map<string, string>();
  calls: Array<{ method: string; path: string; requestId: string | null; body: string | null }> = [];
  tokenFails = false;
  /** Perform the capture at "PayPal" but lose the HTTP response. */
  loseCaptureResponse = false;
  planPrices: Record<string, { value: string; currency_code: string }> = {
    "P-PRO-USD": { value: "19.00", currency_code: "USD" },
    "P-TEAM-USD": { value: "79.00", currency_code: "USD" },
    "P-STORAGE-10-EUR": { value: "2.99", currency_code: "EUR" },
    "P-STORAGE-50-EUR": { value: "7.99", currency_code: "EUR" },
  };
  private seq = 0;
  private readonly ns = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  private tick = Date.now();

  now(): string {
    this.tick += 1000;
    return new Date(this.tick).toISOString();
  }

  id(prefix: string): string {
    return `${prefix}${this.ns}${(++this.seq).toString().padStart(6, "0")}`;
  }

  answer(method: string, url: string, body: string | null, requestId: string | null): { status: number; body: unknown } {
    const path = url.slice(PAYPAL.length);
    this.calls.push({ method, path, requestId, body });
    if (path === "/v1/oauth2/token") {
      return this.tokenFails ? { status: 503, body: { name: "SERVICE_UNAVAILABLE" } } : { status: 200, body: { access_token: "fake" } };
    }
    if (path === "/v1/notifications/verify-webhook-signature") {
      return { status: 200, body: { verification_status: "SUCCESS" } };
    }
    if (path.startsWith("/v1/billing/plans/")) {
      const id = path.split("/").pop()!;
      return {
        status: 200,
        body: {
          id,
          status: "ACTIVE",
          billing_cycles: [
            {
              tenure_type: "REGULAR",
              frequency: { interval_unit: "MONTH", interval_count: 1 },
              pricing_scheme: { fixed_price: this.planPrices[id] ?? { value: "0.00", currency_code: "USD" } },
            },
          ],
        },
      };
    }
    if (path === "/v1/billing/subscriptions" && method === "POST") {
      const existing = requestId ? this.byRequestId.get(requestId) : undefined;
      if (existing) return { status: 200, body: this.subBody(this.subs.get(existing)!) };
      const parsed = JSON.parse(body ?? "{}") as { plan_id: string; custom_id: string };
      const id = this.id("I-");
      this.subs.set(id, { id, status: "APPROVAL_PENDING", custom_id: parsed.custom_id, plan_id: parsed.plan_id, update_time: this.now() });
      if (requestId) this.byRequestId.set(requestId, id);
      return { status: 201, body: this.subBody(this.subs.get(id)!) };
    }
    const subMatch = path.match(/^\/v1\/billing\/subscriptions\/([^/?]+)(\/[a-z]+)?/);
    if (subMatch) {
      const sub = this.subs.get(decodeURIComponent(subMatch[1]!));
      if (!sub) return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
      if (subMatch[2] === "/transactions") return { status: 200, body: { transactions: [] } };
      if (subMatch[2] === "/cancel") {
        if (sub.status !== "ACTIVE" && sub.status !== "SUSPENDED") {
          return { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "SUBSCRIPTION_STATUS_INVALID" }] } };
        }
        sub.status = "CANCELLED";
        sub.update_time = this.now();
        return { status: 204, body: {} };
      }
      if (subMatch[2] === "/revise") {
        const parsed = JSON.parse(body ?? "{}") as { plan_id: string };
        return {
          status: 200,
          body: { plan_id: parsed.plan_id, links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=${this.id("BA-")}` }] },
        };
      }
      return { status: 200, body: this.subBody(sub) };
    }
    if (path === "/v2/checkout/orders" && method === "POST") {
      const existing = requestId ? this.byRequestId.get(requestId) : undefined;
      if (existing) return { status: 200, body: this.orderBody(this.orders.get(existing)!) };
      const parsed = JSON.parse(body ?? "{}") as { purchase_units: Array<{ custom_id: string; amount: Order["amount"] }> };
      const id = this.id("O");
      this.orders.set(id, { id, status: "CREATED", custom_id: parsed.purchase_units[0]!.custom_id, amount: parsed.purchase_units[0]!.amount, captures: [], update_time: this.now() });
      if (requestId) this.byRequestId.set(requestId, id);
      return { status: 201, body: this.orderBody(this.orders.get(id)!) };
    }
    const capMatch = path.match(/^\/v2\/payments\/captures\/([^/]+)$/);
    if (capMatch) {
      for (const order of this.orders.values()) {
        const cap = order.captures.find((c) => c.id === capMatch[1]);
        if (cap) return { status: 200, body: { ...cap, supplementary_data: { related_ids: { order_id: order.id } } } };
      }
      return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
    }
    const orderMatch = path.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    if (orderMatch) {
      const order = this.orders.get(decodeURIComponent(orderMatch[1]!));
      if (!order) return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
      if (orderMatch[2]) {
        // PayPal-Request-Id makes a retried capture return the original.
        if (order.status === "COMPLETED") {
          return this.loseCaptureResponse
            ? { status: 504, body: { name: "GATEWAY_TIMEOUT" } }
            : { status: 201, body: this.orderBody(order) };
        }
        if (order.status !== "APPROVED") {
          return { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] } };
        }
        order.status = "COMPLETED";
        order.update_time = this.now();
        order.captures.push({ id: this.id("CAP"), status: "COMPLETED", amount: order.amount, update_time: order.update_time });
        if (this.loseCaptureResponse) return { status: 504, body: { name: "GATEWAY_TIMEOUT" } };
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
      billing_info: sub.status === "ACTIVE" ? { next_billing_time: new Date(Date.now() + 30 * 86400_000).toISOString() } : {},
      links: sub.status === "APPROVAL_PENDING" ? [{ rel: "approve", href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${sub.id}` }] : [],
    };
  }

  orderBody(order: Order) {
    return {
      id: order.id,
      status: order.status,
      update_time: order.update_time,
      purchase_units: [{ custom_id: order.custom_id, amount: order.amount, payments: { captures: order.captures } }],
      links: order.status === "CREATED" ? [{ rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}` }] : [],
    };
  }

  setSub(id: string, status: string, at?: string) {
    const sub = this.subs.get(id)!;
    sub.status = status;
    sub.update_time = at ?? this.now();
  }
}

describe("BILLING PAYPAL INTEGRITY (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  const tag = `bpi-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

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
      PAYPAL_WEBHOOK_ID: "WH-FAKE",
      PAYPAL_API_BASE: PAYPAL,
      PAYPAL_PRO_PLAN_ID_USD: "P-PRO-USD",
      PAYPAL_TEAM_PLAN_ID_USD: "P-TEAM-USD",
      PAYPAL_PLAN_STORAGE_PERSONAL_10_GB_EUR: "P-STORAGE-10-EUR",
      PAYPAL_PLAN_STORAGE_PERSONAL_50_GB_EUR: "P-STORAGE-50-EUR",
    };
    const previous = new Map(Object.keys(settings).map((k) => [k, process.env[k]]));
    Object.assign(process.env, settings);
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (!url.startsWith(PAYPAL)) return realFetch(input as never, init);
      const headers = new Headers(init?.headers);
      const out = fake.answer(init?.method ?? "GET", url, init?.body == null ? null : String(init.body), headers.get("paypal-request-id"));
      return new Response(out.status === 204 ? null : JSON.stringify(out.body), {
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

  const payer = (plan: "FREE" | "PRO" | "TEAM" = "FREE"): Promise<PersonalTenant> => seedPersonalTenant(deps, plan);
  const account = (userId: string) => ({
    type: "PERSONAL" as const,
    id: userId,
    displayName: "",
    capabilities: ["BILLING_MANAGE", "BILLING_ADDON_PURCHASE", "BILLING_HISTORY_VIEW", "BILLING_CANCEL"] as never,
    billingOwnerMissing: false,
  });
  const planOf = async (userId: string) =>
    (await prisma.entitlement.findFirstOrThrow({ where: { userId, active: true }, orderBy: { createdAt: "desc" } })).plan;
  const creditsOf = async (userId: string) =>
    (await prisma.entitlement.findFirstOrThrow({ where: { userId, active: true }, orderBy: { createdAt: "desc" } })).credits;

  async function seedBase(userId: string, over: Record<string, unknown> = {}) {
    return prisma.subscription.create({
      data: {
        userId,
        provider: "STRIPE",
        providerSubId: `sub_${randomUUID()}`,
        status: "ACTIVE",
        plan: "PRO",
        currentPeriodEnd: new Date(Date.now() + 20 * 86400_000),
        activatedAtUtc: new Date(Date.now() - 10 * 86400_000),
        ...over,
      } as never,
    });
  }

  async function seedAddon(userId: string, over: Record<string, unknown> = {}) {
    return prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId: userId,
        teamId: null,
        addonKey: "PERSONAL_10_GB",
        extraStorageBytes: 10n * GB,
        billingCycle: "MONTHLY",
        status: "ACTIVE",
        paymentProvider: "STRIPE",
        externalSubscriptionId: `addon_${randomUUID()}`,
        activatedAtUtc: new Date(),
        ...over,
      } as never,
    });
  }

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

  // =========================================================================
  // A — dependent storage cancellation
  // =========================================================================
  describe("A: a cancelled plan row cancels only storage that depends on it", () => {
    const accepting = () => {
      const calls: string[] = [];
      const fn = async ({ providerRef, mode }: { providerRef: string; mode: "PERIOD_END" | "IMMEDIATE" }) => {
        calls.push(providerRef);
        return { ok: true as const, mode, terminal: true };
      };
      return { fn, calls };
    };
    const reconcile = async (userId: string, fn: ReturnType<typeof accepting>["fn"]) => {
      const { reconcileBillingAccount } = await import("../src/services/billing/reconciliation/reconciliation.service.js");
      return reconcileBillingAccount({ account: account(userId), providers: {}, cancelAddonAtProvider: fn });
    };

    it("an abandoned TRIALING checkout, a historic cancelled plan and a resubscription never cancel valid storage", async () => {
      const t = await payer("PRO");
      // A never-activated PayPal approval the customer abandoned.
      await seedBase(t.owner.userId, { provider: "PAYPAL", status: "CANCELED", activatedAtUtc: null, currentPeriodEnd: null, locallyTerminatedAtUtc: new Date() });
      // A plan that WAS active, cancelled before the customer resubscribed.
      await seedBase(t.owner.userId, { status: "CANCELED" });
      // The plan the customer pays for now.
      await seedBase(t.owner.userId, { status: "ACTIVE" });
      // Free-eligible storage, and paid-only storage the live plan satisfies.
      const personal = await seedAddon(t.owner.userId);
      const paidOnly = await seedAddon(t.owner.userId, { addonKey: "TEAM_100_GB", extraStorageBytes: 100n * GB });
      // A pre-repair obligation written by the old any-cancelled-row rule.
      await prisma.workspaceStorageAddon.update({
        where: { id: personal.id },
        data: { dependentCancellationState: "PENDING", dependentCancellationNextRetryAtUtc: new Date(0) },
      });

      const { fn, calls } = accepting();
      await reconcile(t.owner.userId, fn);
      // The retry worker path, too.
      const { attemptDependentCancellations } = await import("../src/services/billing/dependent-cancellation.service.js");
      await attemptDependentCancellations({ ownerUserId: t.owner.userId, teamId: null, cancelAtProvider: fn, dueOnly: true });

      expect(calls).toEqual([]);
      const rows = await prisma.workspaceStorageAddon.findMany({
        where: { id: { in: [personal.id, paidOnly.id] } },
        select: { id: true, status: true, dependentCancellationState: true, dependentCancellationReasonCode: true },
      });
      expect(rows.every((r) => r.status === "ACTIVE")).toBe(true);
      expect(rows.find((r) => r.id === personal.id)).toMatchObject({
        dependentCancellationState: "NONE",
        dependentCancellationReasonCode: "OBLIGATION_WITHDRAWN_NOT_DEPENDENT",
      });
    });

    it("storage bought while Free is never cascaded by a plan cancellation", async () => {
      const t = await payer("FREE");
      await seedBase(t.owner.userId, { status: "CANCELED" });
      const addon = await seedAddon(t.owner.userId, { addonKey: "PERSONAL_50_GB", extraStorageBytes: 50n * GB });
      const { fn, calls } = accepting();
      await reconcile(t.owner.userId, fn);
      expect(calls).toEqual([]);
      expect((await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: addon.id } })).status).toBe("ACTIVE");
    });

    it("a genuine dependant — paid-only storage whose base plan ended with no replacement — is cancelled exactly once", async () => {
      const t = await payer("TEAM");
      const base = await seedBase(t.owner.userId, { plan: "TEAM", status: "CANCELED" });
      const addon = await seedAddon(t.owner.userId, { addonKey: "TEAM_100_GB", extraStorageBytes: 100n * GB, dependsOnSubscriptionId: base.id });
      const { fn, calls } = accepting();
      await reconcile(t.owner.userId, fn);
      await reconcile(t.owner.userId, fn);
      expect(calls).toEqual([addon.externalSubscriptionId]);
      expect(await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: addon.id } })).toMatchObject({
        status: "CANCELED",
        dependentCancellationState: "CONFIRMED",
        dependentCancellationTriggeredBySubscriptionId: base.id,
      });
    });
  });

  // =========================================================================
  // B — abandoned approvals, late approval, second purchase
  // =========================================================================
  describe("B: an abandoned or superseded approval can never become a silent second subscription", () => {
    async function paypalSubRow(userId: string, fake: FakePayPal, plan: "PRO" | "TEAM") {
      const id = fake.id("I-");
      fake.subs.set(id, { id, status: "APPROVAL_PENDING", custom_id: `${userId}::${plan}`, plan_id: `P-${plan}-USD`, update_time: fake.now() });
      await prisma.subscription.create({
        data: { userId, provider: "PAYPAL", providerSubId: id, status: "TRIALING", plan },
      });
      return id;
    }

    it("late approval after a second purchase: the duplicate is cancelled at PayPal, recorded for refund review, and grants nothing", async () => {
      const t = await payer("FREE");
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        const subId = await paypalSubRow(t.owner.userId, fake, "PRO");
        const row = await prisma.subscription.findFirstOrThrow({ where: { providerSubId: subId } });
        const { terminalizePendingPlanCheckout } = await import("../src/services/billing/subscription-cancellation.service.js");
        await terminalizePendingPlanCheckout({ subscriptionId: row.id });
        // The local abandonment is LOCAL: no provider time is invented.
        expect(await prisma.subscription.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
          status: "CANCELED",
          providerStateAtUtc: null,
        });
        // The customer then buys TEAM by card.
        const { syncPlanForSubscription } = await import("../src/services/billing/subscription-lifecycle.handlers.js");
        await syncPlanForSubscription({ userId: t.owner.userId, plan: "TEAM", provider: "STRIPE", providerSubId: `sub_${randomUUID()}`, status: "ACTIVE", observedAtUtc: new Date() });
        expect(await planOf(t.owner.userId)).toBe("TEAM");

        // …and completes the abandoned PayPal approval in an old tab.
        fake.setSub(subId, "ACTIVE");
        const { applyPayPalSubscriptionState } = await import("../src/services/billing/paypal-settlement.service.js");
        const applied = await applyPayPalSubscriptionState({ subscriptionId: subId, source: "BILLING.SUBSCRIPTION.ACTIVATED" });
        expect(applied).toMatchObject({ outcome: "APPLIED", superseded: true });
        expect(await planOf(t.owner.userId)).toBe("TEAM");
        expect(fake.subs.get(subId)!.status).toBe("CANCELLED");
        expect((await prisma.subscription.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("CANCELED");
        expect(await prisma.billingReviewItem.findFirstOrThrow({ where: { providerResourceId: subId } })).toMatchObject({
          reason: "DUPLICATE_BASE_SUBSCRIPTION",
          providerAction: "CANCELED_AT_PROVIDER",
          refundReviewRequired: true,
        });
      });
    });

    it("late approval with no other plan: the charge is honoured — the plan is granted, never lost", async () => {
      const t = await payer("FREE");
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        const subId = await paypalSubRow(t.owner.userId, fake, "PRO");
        const row = await prisma.subscription.findFirstOrThrow({ where: { providerSubId: subId } });
        const { terminalizePendingPlanCheckout } = await import("../src/services/billing/subscription-cancellation.service.js");
        await terminalizePendingPlanCheckout({ subscriptionId: row.id });
        fake.setSub(subId, "ACTIVE");
        const { applyPayPalSubscriptionState } = await import("../src/services/billing/paypal-settlement.service.js");
        await applyPayPalSubscriptionState({ subscriptionId: subId, source: "BILLING.SUBSCRIPTION.ACTIVATED" });
        expect(await planOf(t.owner.userId)).toBe("PRO");
        expect((await prisma.subscription.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("ACTIVE");
      });
    });

    it("a row the OLD code terminalized with a LOCAL time newer than PayPal's approval is repaired by a live read", async () => {
      const t = await payer("FREE");
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        const subId = await paypalSubRow(t.owner.userId, fake, "PRO");
        // Approved at PayPal BEFORE the old local stamp.
        fake.setSub(subId, "ACTIVE", new Date(Date.now() - 60_000).toISOString());
        await prisma.subscription.updateMany({
          where: { providerSubId: subId },
          data: { status: "CANCELED", providerStateAtUtc: new Date() },
        });
        const { applyPayPalSubscriptionState } = await import("../src/services/billing/paypal-settlement.service.js");
        await applyPayPalSubscriptionState({ subscriptionId: subId, source: "checkout_attempt_recheck" });
        expect(await planOf(t.owner.userId)).toBe("PRO");
      });
    });

    it("two activations racing for one payer: exactly one becomes the entitlement", async () => {
      const t = await payer("FREE");
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        const a = await paypalSubRow(t.owner.userId, fake, "PRO");
        const b = await paypalSubRow(t.owner.userId, fake, "TEAM");
        fake.setSub(a, "ACTIVE");
        fake.setSub(b, "ACTIVE");
        const { applyPayPalSubscriptionState } = await import("../src/services/billing/paypal-settlement.service.js");
        const results = await Promise.all([
          applyPayPalSubscriptionState({ subscriptionId: a, source: "race" }),
          applyPayPalSubscriptionState({ subscriptionId: b, source: "race" }),
        ]);
        expect(results.filter((r) => r.outcome === "APPLIED" && r.superseded).length).toBe(1);
        const live = await prisma.subscription.findMany({
          where: { userId: t.owner.userId, status: { in: ["ACTIVE", "PAST_DUE"] } },
        });
        expect(live).toHaveLength(1);
        expect(await planOf(t.owner.userId)).toBe(live[0]!.plan);
      });
    });
  });

  // =========================================================================
  // C / H — storage activation parity, and no workspace target
  // =========================================================================
  describe("C/H: every path grants storage by the same rule; a workspace target is refused", () => {
    it("webhook, return and reconciliation reach the same outcome — granted on the configured plan, refused and stopped otherwise", async () => {
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        const { applyPayPalSubscriptionState } = await import("../src/services/billing/paypal-settlement.service.js");
        const { reconcileBillingAccount, defaultReconciliationProviders } = await import(
          "../src/services/billing/reconciliation/reconciliation.service.js"
        );
        const run = async (plan: string, via: "webhook" | "sweep") => {
          const t = await payer("FREE");
          const res = await call("POST", "/v1/billing/storage-addons/checkout/paypal", t.owner.token, { addonKey: "PERSONAL_10_GB" });
          expect(res.statusCode, res.body).toBe(200);
          const subId = json(res).subscription.id as string;
          fake.subs.get(subId)!.plan_id = plan;
          fake.setSub(subId, "ACTIVE");
          if (via === "webhook") {
            await applyPayPalSubscriptionState({ subscriptionId: subId, source: "BILLING.SUBSCRIPTION.ACTIVATED" });
          } else {
            await reconcileBillingAccount({ account: account(t.owner.userId), providers: defaultReconciliationProviders() });
          }
          return prisma.workspaceStorageAddon.findFirstOrThrow({ where: { externalSubscriptionId: subId } });
        };
        for (const via of ["webhook", "sweep"] as const) {
          expect((await run("P-STORAGE-10-EUR", via)).status, via).toBe("ACTIVE");
          const refused = await run("P-STORAGE-50-EUR", via);
          expect(refused.status, via).toBe("FAILED");
          expect(fake.subs.get(refused.externalSubscriptionId!)!.status, via).toBe("CANCELLED");
          expect(await prisma.billingReviewItem.count({ where: { providerResourceId: refused.externalSubscriptionId!, reason: "STORAGE_ACTIVATION_REFUSED" } })).toBe(1);
        }
      });
    });

    it("a teamId on a storage checkout is refused before any attempt row or provider call", async () => {
      const t = await payer("PRO");
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        for (const provider of ["paypal", "stripe"]) {
          const res = await call("POST", `/v1/billing/storage-addons/checkout/${provider}`, t.owner.token, {
            addonKey: "TEAM_100_GB",
            teamId: t.personalTeamId,
          });
          expect(res.statusCode).toBe(400);
          expect(json(res).code ?? json(res).error?.code).toBe("CHECKOUT_TARGET_NOT_SUPPORTED");
        }
        expect(fake.calls).toEqual([]);
        expect(await prisma.workspaceStorageAddon.count({ where: { ownerUserId: t.owner.userId } })).toBe(0);
      });
    });
  });

  // =========================================================================
  // E — product identity; F — lost capture response
  // =========================================================================
  describe("E/F: only credit purchases are credit purchases; a lost capture is recovered once", () => {
    it("a plan or storage renewal at exactly the credit price is never granted as a credit", async () => {
      const t = await payer("PRO");
      const previous = process.env.BILLING_PAYG_PRICE_CENTS_USD;
      process.env.BILLING_PAYG_PRICE_CENTS_USD = "1900";
      try {
        for (const product of ["PLAN", "STORAGE_ADDON"] as const) {
          await prisma.payment.create({
            data: { userId: t.owner.userId, provider: "PAYPAL", providerPaymentId: `SALE${randomUUID().slice(0, 8)}`, amountCents: 1900, currency: "USD", status: "SUCCEEDED", product },
          });
        }
        // A historic row with no product, which the provider says is a PLAN.
        const historic = `SALE${randomUUID().slice(0, 8)}`;
        await prisma.payment.create({
          data: { userId: t.owner.userId, provider: "PAYPAL", providerPaymentId: historic, amountCents: 1900, currency: "USD", status: "SUCCEEDED" },
        });
        const asked: string[] = [];
        const adapter = {
          provider: "PAYPAL",
          async observePayment(ref: string) {
            asked.push(ref);
            return { kind: "PAYMENT", provider: "PAYPAL", providerRef: ref, state: "SUCCEEDED", amountCents: 1900, currency: "USD", quantity: null, observedAtUtc: new Date(), productKey: "PLAN" };
          },
          async observeSubscription() {
            throw new Error("not used");
          },
        };
        const { reconcileBillingAccount } = await import("../src/services/billing/reconciliation/reconciliation.service.js");
        const summary = await reconcileBillingAccount({ account: account(t.owner.userId), providers: { PAYPAL: adapter } as never });
        expect(summary.creditsRestored).toBe(0);
        expect(summary.unavailable).toBe(0);
        expect(await creditsOf(t.owner.userId)).toBe(0);
        // Typed rows are never asked about; the historic row is classified once.
        expect(asked).toEqual([historic]);
        expect((await prisma.payment.findFirstOrThrow({ where: { providerPaymentId: historic } })).product).toBe("PLAN");
        await reconcileBillingAccount({ account: account(t.owner.userId), providers: { PAYPAL: adapter } as never });
        expect(asked).toEqual([historic]);
      } finally {
        if (previous === undefined) delete process.env.BILLING_PAYG_PRICE_CENTS_USD;
        else process.env.BILLING_PAYG_PRICE_CENTS_USD = previous;
      }
    });

    it("a capture PayPal completed but whose response was lost is settled by the sweep — one capture, one credit", async () => {
      const t = await payer("FREE");
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        const start = await call("POST", "/v1/billing/credits/checkout/paypal", t.owner.token, { currency: "USD" });
        expect(start.statusCode, start.body).toBe(200);
        const orderId = json(start).order.id as string;
        fake.orders.get(orderId)!.status = "APPROVED";
        fake.loseCaptureResponse = true;
        const back = await call("POST", `/v1/billing/credits/checkout/paypal/${orderId}/capture`, t.owner.token);
        expect(back.statusCode).toBeGreaterThanOrEqual(500);
        const attempt = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { userId: t.owner.userId } });
        expect(attempt).toMatchObject({ status: "PENDING", checkoutState: "CAPTURE_PENDING" });
        expect(await creditsOf(t.owner.userId)).toBe(0);

        // The webhook never comes. The sweep selects the open attempt.
        fake.loseCaptureResponse = false;
        await prisma.billingCheckoutAttempt.update({ where: { id: attempt.id }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
        const { selectReconciliationCandidates, runBillingReconciliationSweep } = await import("../src/jobs/billing-reconciliation.job.js");
        expect((await selectReconciliationCandidates(500)).map((c) => c.id)).toContain(t.owner.userId);
        const { defaultReconciliationProviders, reconcileBillingAccount } = await import("../src/services/billing/reconciliation/reconciliation.service.js");
        await reconcileBillingAccount({ account: account(t.owner.userId), providers: defaultReconciliationProviders() });
        await reconcileBillingAccount({ account: account(t.owner.userId), providers: defaultReconciliationProviders() });
        void runBillingReconciliationSweep;

        expect(await creditsOf(t.owner.userId)).toBe(1);
        expect(await prisma.evidenceCreditLedgerEntry.count({ where: { userId: t.owner.userId, entryType: "PURCHASE" } })).toBe(1);
        expect((await prisma.billingCheckoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe("COMPLETED");
        expect(fake.orders.get(orderId)!.captures).toHaveLength(1);
        // Every capture call used the same PayPal-Request-Id.
        const captureIds = new Set(fake.calls.filter((c) => c.path.endsWith("/capture")).map((c) => c.requestId));
        expect(captureIds.size).toBe(1);
        expect((await prisma.payment.findFirstOrThrow({ where: { userId: t.owner.userId } })).product).toBe("EVIDENCE_CREDIT");
      });
    });
  });

  // =========================================================================
  // D / J / K — pre-create failures and price authority
  // =========================================================================
  describe("D/J/K: refusals before create never block; price mismatches never grant", () => {
    it("a token failure or a plan billed at another price refuses with nothing created, and does not block the next checkout", async () => {
      const t = await payer("FREE");
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        fake.tokenFails = true;
        const first = await call("POST", "/v1/billing/checkout/paypal", t.owner.token, { plan: "PRO", currency: "USD" });
        expect(first.statusCode).toBe(503);
        fake.tokenFails = false;
        fake.planPrices["P-PRO-USD"] = { value: "19.00", currency_code: "EUR" };
        const second = await call("POST", "/v1/billing/checkout/paypal", t.owner.token, { plan: "PRO", currency: "USD" });
        expect(second.statusCode).toBe(503);
        expect(fake.calls.filter((c) => c.path === "/v1/billing/subscriptions" && c.method === "POST")).toEqual([]);
        const attempts = await prisma.billingCheckoutAttempt.findMany({ where: { userId: t.owner.userId } });
        expect(attempts.map((a) => [a.status, a.checkoutState])).toEqual([
          ["FAILED", "PROVIDER_REJECTED"],
          ["FAILED", "PROVIDER_REJECTED"],
        ]);
        fake.planPrices["P-PRO-USD"] = { value: "19.00", currency_code: "USD" };
        const third = await call("POST", "/v1/billing/checkout/paypal", t.owner.token, { plan: "PRO", currency: "USD" });
        expect(third.statusCode, third.body).toBe(200);
      });
    });

    it("a credit captured at a different amount than its attempt was sold at grants nothing and opens a refund review", async () => {
      const t = await payer("FREE");
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        const start = await call("POST", "/v1/billing/credits/checkout/paypal", t.owner.token, { currency: "USD" });
        const orderId = json(start).order.id as string;
        // The catalogue price changes while the payment is in flight; the
        // purchase is still judged at the price it was sold at.
        const previous = process.env.BILLING_PAYG_PRICE_CENTS_USD;
        process.env.BILLING_PAYG_PRICE_CENTS_USD = "700";
        try {
          fake.orders.get(orderId)!.status = "APPROVED";
          const back = await call("POST", `/v1/billing/credits/checkout/paypal/${orderId}/capture`, t.owner.token);
          expect(json(back).outcome).toBe("GRANTED");
          // Now a capture at a different amount than the attempt.
          const start2 = await call("POST", "/v1/billing/credits/checkout/paypal", t.owner.token, { currency: "USD" });
          const order2 = fake.orders.get(json(start2).order.id as string)!;
          const attempt2 = await prisma.billingCheckoutAttempt.findFirstOrThrow({ where: { providerResourceId: order2.id } });
          await prisma.billingCheckoutAttempt.update({ where: { id: attempt2.id }, data: { amountCents: 500 } });
          order2.status = "COMPLETED";
          order2.captures.push({ id: fake.id("CAP"), status: "COMPLETED", amount: order2.amount, update_time: fake.now() });
          const { handlePayPalCaptureWebhook } = await import("../src/services/billing/paypal-settlement.service.js");
          const hook = await handlePayPalCaptureWebhook({ id: order2.captures[0]!.id, supplementary_data: { related_ids: { order_id: order2.id } } });
          expect(hook).toMatchObject({ outcome: "REJECTED", reason: "AMOUNT_MISMATCH" });
          expect(await creditsOf(t.owner.userId)).toBe(1);
          expect(await prisma.billingReviewItem.count({ where: { userId: t.owner.userId, reason: "AMOUNT_MISMATCH", refundReviewRequired: true } })).toBe(1);
        } finally {
          if (previous === undefined) delete process.env.BILLING_PAYG_PRICE_CENTS_USD;
          else process.env.BILLING_PAYG_PRICE_CENTS_USD = previous;
        }
      });
    });
  });

  // =========================================================================
  // G — refunds and reversals
  // =========================================================================
  describe("G: a refunded credit purchase is reversed once, auditably", () => {
    it("PAYMENT.CAPTURE.REFUNDED reverses the credit; a redelivery does nothing more; a spent credit is sent to review", async () => {
      const t = await payer("FREE");
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        const buy = async () => {
          const start = await call("POST", "/v1/billing/credits/checkout/paypal", t.owner.token, { currency: "USD" });
          const orderId = json(start).order.id as string;
          fake.orders.get(orderId)!.status = "APPROVED";
          await call("POST", `/v1/billing/credits/checkout/paypal/${orderId}/capture`, t.owner.token);
          return fake.orders.get(orderId)!.captures[0]!.id;
        };
        const refundEvent = (captureId: string, id = `WH-${randomUUID()}`) =>
          harness.app.inject({
            method: "POST",
            url: "/webhooks/paypal",
            headers: { "content-type": "application/json" },
            payload: JSON.stringify({
              id,
              event_type: "PAYMENT.CAPTURE.REFUNDED",
              resource: {
                id: `REF-${captureId}`,
                status: "COMPLETED",
                links: [{ rel: "up", href: `${PAYPAL}/v2/payments/captures/${captureId}` }],
              },
            }),
          });

        const c1 = await buy();
        expect(await creditsOf(t.owner.userId)).toBe(1);
        const eventId = `WH-${randomUUID()}`;
        expect((await refundEvent(c1, eventId)).statusCode).toBe(200);
        expect((await refundEvent(c1, eventId)).statusCode).toBe(200);
        expect((await refundEvent(c1)).statusCode).toBe(200);
        expect(await creditsOf(t.owner.userId)).toBe(0);
        expect(await prisma.evidenceCreditLedgerEntry.count({ where: { userId: t.owner.userId, entryType: "REVERSAL" } })).toBe(1);
        expect((await prisma.payment.findFirstOrThrow({ where: { providerPaymentId: c1 } })).status).toBe("REFUNDED");

        // A credit already spent cannot be taken back from its record.
        const c2 = await buy();
        await prisma.entitlement.updateMany({ where: { userId: t.owner.userId, active: true }, data: { credits: 0 } });
        await refundEvent(c2);
        expect(await creditsOf(t.owner.userId)).toBe(0);
        expect(await prisma.billingReviewItem.count({ where: { providerResourceId: c2, reason: "CREDIT_REFUND_AFTER_CONSUMPTION" } })).toBe(1);
      });
    });
  });

  // =========================================================================
  // I / N — revisions awaiting approval; buyer cancel and expiry
  // =========================================================================
  describe("I/N: nothing waits forever for an approval nobody will give", () => {
    it("a PayPal revision awaiting approval can be re-issued, and lapses", async () => {
      const t = await payer("PRO");
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        const id = fake.id("I-");
        fake.subs.set(id, { id, status: "ACTIVE", custom_id: `${t.owner.userId}::PRO`, plan_id: "P-PRO-USD", update_time: fake.now() });
        const row = await seedBase(t.owner.userId, { provider: "PAYPAL", providerSubId: id });
        const first = await call("POST", "/v1/billing/subscription/plan", t.owner.token, { plan: "TEAM" });
        expect(json(first)).toMatchObject({ outcome: "UPGRADE", providerConfirmed: false });
        expect(json(first).approvalUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
        // Asking again is NOT "already there": a fresh approval is issued.
        const again = await call("POST", "/v1/billing/subscription/plan", t.owner.token, { plan: "TEAM" });
        expect(json(again).outcome).toBe("UPGRADE");
        expect(json(again).approvalUrl).not.toBe(json(first).approvalUrl);
        // Never approved: after the approval window it lapses.
        await prisma.subscription.update({ where: { id: row.id }, data: { pendingPlanRequestedAtUtc: new Date(Date.now() - 80 * 3600_000) } });
        const { expireUnapprovedPlanChange } = await import("../src/services/billing/plan-transition.service.js");
        expect(await expireUnapprovedPlanChange(row.id)).toBe(true);
        expect(await prisma.subscription.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ pendingPlan: null, pendingPlanAwaitingApproval: false });
      });
    });

    it("the buyer's cancel at PayPal closes the attempt, so the next plan checkout is not blocked", async () => {
      const t = await payer("FREE");
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        const start = await call("POST", "/v1/billing/checkout/paypal", t.owner.token, { plan: "PRO", currency: "USD" });
        const subId = json(start).subscription.id as string;
        const other = await payer("FREE");
        const foreign = await call("POST", "/v1/billing/checkout/paypal/returns/canceled", other.owner.token, { subscriptionId: subId });
        expect(json(foreign).outcome).toBe("NO_ATTEMPT");
        const back = await call("POST", "/v1/billing/checkout/paypal/returns/canceled", t.owner.token, { subscriptionId: subId });
        expect(json(back).outcome).toBe("ABANDONED");
        const next = await call("POST", "/v1/billing/checkout/stripe", t.owner.token, { plan: "PRO", currency: "USD" });
        expect(json(next).code).not.toBe("PLAN_CHECKOUT_ALREADY_OPEN");
      });
    });

    it("an approval older than 24 hours is closed provider-first when a new checkout starts", async () => {
      const t = await payer("FREE");
      const fake = new FakePayPal();
      await withPayPal(fake, async () => {
        const start = await call("POST", "/v1/billing/checkout/paypal", t.owner.token, { plan: "PRO", currency: "USD" });
        expect(start.statusCode, start.body).toBe(200);
        await prisma.billingCheckoutAttempt.updateMany({ where: { userId: t.owner.userId }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
        const next = await call("POST", "/v1/billing/checkout/paypal", t.owner.token, { plan: "TEAM", currency: "USD" });
        expect(next.statusCode, next.body).toBe(200);
        const attempts = await prisma.billingCheckoutAttempt.findMany({ where: { userId: t.owner.userId }, orderBy: { createdAt: "asc" } });
        expect(attempts[0]).toMatchObject({ status: "ABANDONED", checkoutState: "LOCALLY_EXPIRED" });
      });
    });
  });

  // =========================================================================
  // O / P
  // =========================================================================
  describe("O/P: truthful concurrency, ordered status", () => {
    it("a re-check refused because one is running says nothing was checked", async () => {
      const t = await payer("FREE");
      const { acquireLease } = await import("../src/services/rate-limit.js");
      const held = await acquireLease(`billing_reconcile:PERSONAL:${t.owner.userId}`, 60_000);
      expect(held.acquired).toBe(true);
      try {
        const res = await call("POST", `/v1/billing/accounts/PERSONAL/${t.owner.userId}/reconcile`, t.owner.token);
        expect(res.statusCode).toBe(409);
        expect(json(res)).toMatchObject({ outcome: "BUSY", checked: false });
      } finally {
        await held.release();
      }
      const ran = await call("POST", `/v1/billing/accounts/PERSONAL/${t.owner.userId}/reconcile`, t.owner.token);
      expect(json(ran)).toMatchObject({ checked: true });
      // Released when it finished: an immediate second press runs again.
      const again = await call("POST", `/v1/billing/accounts/PERSONAL/${t.owner.userId}/reconcile`, t.owner.token);
      expect(json(again)).toMatchObject({ checked: true });
    });

    it("a PAST_DUE fact cannot reopen a CANCELED subscription", async () => {
      const t = await payer("FREE");
      const row = await seedBase(t.owner.userId, { status: "CANCELED", providerStateAtUtc: new Date(Date.now() - 1000) });
      const { upsertSubscription } = await import("../src/services/billing.service.js");
      await upsertSubscription({ userId: t.owner.userId, provider: "STRIPE", providerSubId: row.providerSubId, status: "PAST_DUE", plan: "PRO", observedAtUtc: new Date() });
      await upsertSubscription({ userId: t.owner.userId, provider: "STRIPE", providerSubId: row.providerSubId, status: "PAST_DUE", plan: "PRO" });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("CANCELED");
    });
  });
});
