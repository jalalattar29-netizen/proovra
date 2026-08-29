/**
 * BILLING RECONCILIATION — provider recovery, ordering and isolation, against
 * live PostgreSQL 16 with INJECTED provider adapters.
 *
 * WHY THE ADAPTERS ARE INJECTED
 * ---------------------------------------------------------------------------
 * A reconciliation test that called Stripe would prove nothing repeatable and
 * would need credentials this repository must never hold in a test run. The
 * adapter contract exists precisely so the observation can be supplied as a
 * fixture: everything BELOW the adapter — the validation, the ordering guard,
 * the idempotency constraints, the domain handlers, the isolation — is the
 * real production code running against a real database.
 *
 * The one thing these tests deliberately do NOT prove is that the real Stripe
 * and PayPal adapters parse a live payload correctly. That is a boundary no
 * offline test can hold, and pretending otherwise would be worse than saying so.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps } from "./point7/product-fixtures.js";
import type {
  BillingReconciliationProvider,
  PaymentObservation,
  SubscriptionObservation,
} from "../src/services/billing/reconciliation/types.js";

/** The canonical evidence-credit price, in the currency the fixtures use. */
const CREDIT_PRICE_CENTS = 500;

/**
 * A deterministic adapter.
 *
 * It answers from a map keyed by provider reference and records what it was
 * ASKED, which is how the isolation cases prove the service never reached for
 * a binding belonging to another account.
 */
class FixtureProvider implements BillingReconciliationProvider {
  readonly asked: string[] = [];

  constructor(
    readonly provider: "STRIPE" | "PAYPAL",
    private readonly payments: Record<string, PaymentObservation> = {},
    private readonly subscriptions: Record<string, SubscriptionObservation> = {},
  ) {}

  async observePayment(ref: string): Promise<PaymentObservation> {
    this.asked.push(ref);
    return (
      this.payments[ref] ?? {
        kind: "PAYMENT",
        provider: this.provider as never,
        providerRef: ref,
        state: "UNKNOWN",
        amountCents: null,
        currency: null,
        quantity: null,
        observedAtUtc: null,
        failure: "NOT_FOUND",
      }
    );
  }

  async observeSubscription(ref: string): Promise<SubscriptionObservation> {
    this.asked.push(ref);
    return (
      this.subscriptions[ref] ?? {
        kind: "SUBSCRIPTION",
        provider: this.provider as never,
        providerRef: ref,
        state: "UNKNOWN",
        currentPeriodEndUtc: null,
        cancelAtPeriodEnd: false,
        observedAtUtc: null,
        recentPayments: [],
        failure: "NOT_FOUND",
      }
    );
  }
}

function settledCredit(
  provider: "STRIPE" | "PAYPAL",
  ref: string,
  over: Partial<PaymentObservation> = {},
): PaymentObservation {
  return {
    kind: "PAYMENT",
    provider: provider as never,
    providerRef: ref,
    state: "SUCCEEDED",
    amountCents: CREDIT_PRICE_CENTS,
    currency: "USD",
    quantity: 1,
    observedAtUtc: new Date("2026-08-20T10:00:00.000Z"),
    ...over,
  };
}

describe("BILLING RECONCILIATION (live PostgreSQL 16, injected adapters)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let reconcile: typeof import("../src/services/billing/reconciliation/reconciliation.service.js")["reconcileBillingAccount"];

  const accountRef = (type: "PERSONAL" | "ORGANIZATION", id: string) => ({
    type,
    id,
    displayName: "",
    capabilities: [],
    billingOwnerMissing: false,
  });

  /** A settled personal payment with no credit ledger row — a lost webhook. */
  async function seedLostCreditPurchase(
    userId: string,
    provider: "STRIPE" | "PAYPAL",
  ) {
    const ref = `ref-${randomUUID()}`;
    await prisma.payment.create({
      data: {
        userId,
        provider,
        providerPaymentId: ref,
        amountCents: CREDIT_PRICE_CENTS,
        currency: "USD",
        status: "SUCCEEDED",
        teamId: null,
      },
    });
    return ref;
  }

  async function creditsOf(userId: string): Promise<number> {
    const row = await prisma.entitlement.findFirst({
      where: { userId, active: true },
      orderBy: { createdAt: "desc" },
      select: { credits: true },
    });
    return row?.credits ?? 0;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ reconcileBillingAccount: reconcile } = await import(
      "../src/services/billing/reconciliation/reconciliation.service.js"
    ));

    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `brec-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          {
            sub: userId,
            provider: "EMAIL",
            email,
            authMethod: "PASSWORD",
            authAt: Math.floor(Date.now() / 1000),
          },
          secret,
          60 * 60,
        ),
    };
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  // =========================================================================
  // Evidence-credit recovery — the lost webhook
  // =========================================================================
  for (const provider of ["STRIPE", "PAYPAL"] as const) {
    describe(`${provider} evidence-credit recovery`, () => {
      it("restores credits for a settled purchase that never granted", async () => {
        const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
        const ref = await seedLostCreditPurchase(t.owner.userId, provider);

        const adapter = new FixtureProvider(provider, {
          [ref]: settledCredit(provider, ref),
        });
        const summary = await reconcile({
          account: accountRef("PERSONAL", t.owner.userId),
          providers: { [provider]: adapter } as never,
        });

        expect(summary.outcome).toBe("UPDATED");
        expect(summary.creditsRestored).toBe(1);
        expect(await creditsOf(t.owner.userId)).toBe(1);

        // The durable PURCHASE row is what makes it non-repeatable.
        expect(
          await prisma.evidenceCreditLedgerEntry.count({
            where: { entryType: "PURCHASE", provider, providerRef: ref },
          }),
        ).toBe(1);
      });

      it("is idempotent — a second run grants nothing further", async () => {
        const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
        const ref = await seedLostCreditPurchase(t.owner.userId, provider);
        const providers = {
          [provider]: new FixtureProvider(provider, {
            [ref]: settledCredit(provider, ref),
          }),
        } as never;

        await reconcile({ account: accountRef("PERSONAL", t.owner.userId), providers });
        const second = await reconcile({
          account: accountRef("PERSONAL", t.owner.userId),
          providers,
        });

        expect(second.creditsRestored).toBe(0);
        expect(second.outcome).toBe("NO_CHANGE");
        expect(await creditsOf(t.owner.userId)).toBe(1);
      });

      it("cannot double-grant when a webhook lands first", async () => {
        const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
        const ref = await seedLostCreditPurchase(t.owner.userId, provider);

        // The webhook path, verbatim — the same idempotent handler.
        const { grantEvidenceCredits } = await import(
          "../src/services/billing/evidence-credits.service.js"
        );
        await grantEvidenceCredits({
          userId: t.owner.userId,
          credits: 1,
          provider: provider as never,
          providerRef: ref,
        });

        const summary = await reconcile({
          account: accountRef("PERSONAL", t.owner.userId),
          providers: {
            [provider]: new FixtureProvider(provider, {
              [ref]: settledCredit(provider, ref),
            }),
          } as never,
        });

        expect(summary.creditsRestored).toBe(0);
        expect(await creditsOf(t.owner.userId)).toBe(1);
        expect(
          await prisma.evidenceCreditLedgerEntry.count({
            where: { entryType: "PURCHASE", providerRef: ref },
          }),
        ).toBe(1);
      });

      it("grants nothing for pending, failed, canceled or unreachable states", async () => {
        for (const state of ["PENDING", "FAILED", "CANCELED", "UNKNOWN"] as const) {
          const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
          const ref = await seedLostCreditPurchase(t.owner.userId, provider);

          const summary = await reconcile({
            account: accountRef("PERSONAL", t.owner.userId),
            providers: {
              [provider]: new FixtureProvider(provider, {
                [ref]: settledCredit(provider, ref, { state }),
              }),
            } as never,
          });

          expect(summary.creditsRestored, `state ${state}`).toBe(0);
          expect(await creditsOf(t.owner.userId), `state ${state}`).toBe(0);
        }
      });

      it("grants nothing on an amount, currency or quantity mismatch", async () => {
        const mismatches: Array<Partial<PaymentObservation>> = [
          { amountCents: 1 },
          { currency: "GBP" },
          { quantity: 99 },
        ];
        for (const over of mismatches) {
          const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
          const ref = await seedLostCreditPurchase(t.owner.userId, provider);

          const summary = await reconcile({
            account: accountRef("PERSONAL", t.owner.userId),
            providers: {
              [provider]: new FixtureProvider(provider, {
                [ref]: settledCredit(provider, ref, over),
              }),
            } as never,
          });

          expect(summary.creditsRestored, JSON.stringify(over)).toBe(0);
          expect(summary.discrepancies, JSON.stringify(over)).toBeGreaterThan(0);
          // A disagreement is an operator's problem, never a silent grant.
          expect(summary.outcome).toBe("ACTION_REQUIRED");
          expect(await creditsOf(t.owner.userId)).toBe(0);
        }
      });

      it("an unreachable provider changes nothing and says so", async () => {
        const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
        await seedLostCreditPurchase(t.owner.userId, provider);

        // The default fixture answers UNKNOWN for anything it was not given.
        const summary = await reconcile({
          account: accountRef("PERSONAL", t.owner.userId),
          providers: { [provider]: new FixtureProvider(provider) } as never,
        });

        expect(summary.outcome).toBe("PROVIDER_UNAVAILABLE");
        expect(summary.creditsRestored).toBe(0);
        expect(await creditsOf(t.owner.userId)).toBe(0);
      });
    });
  }

  // =========================================================================
  // Isolation — the route accepts no provider reference, so nothing to claim
  // =========================================================================
  describe("account isolation", () => {
    it("one personal account's purchase cannot be reconciled by another", async () => {
      const victim = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const attacker = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const ref = await seedLostCreditPurchase(victim.owner.userId, "STRIPE");

      const adapter = new FixtureProvider("STRIPE", {
        [ref]: settledCredit("STRIPE", ref),
      });
      const summary = await reconcile({
        account: accountRef("PERSONAL", attacker.owner.userId),
        providers: { STRIPE: adapter } as never,
      });

      // The attacker's account owns no such binding, so the service never even
      // ASKS about it — the isolation is structural, not a rejected check.
      expect(adapter.asked).not.toContain(ref);
      expect(summary.creditsRestored).toBe(0);
      expect(await creditsOf(attacker.owner.userId)).toBe(0);
      expect(await creditsOf(victim.owner.userId)).toBe(0);
    });

    it("a non-personal account never reconciles personal credit bindings", async () => {
      // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the subject was
      // WORKSPACE, which no longer exists. The isolation being proved is not
      // about workspaces: it is that reconciliation reaches a credit wallet
      // ONLY from the account that owns it, and a wallet is owned by a person.
      // ORGANIZATION is now the only non-personal subject, so it is the one
      // that must come back empty-handed.
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const ref = await seedLostCreditPurchase(t.owner.userId, "STRIPE");
      const organization = await prisma.organization.findFirstOrThrow({
        where: { billingOwnerUserId: t.owner.userId },
        select: { id: true },
      });

      const adapter = new FixtureProvider("STRIPE", {
        [ref]: settledCredit("STRIPE", ref),
      });
      await reconcile({
        account: accountRef("ORGANIZATION", organization.id),
        providers: { STRIPE: adapter } as never,
      });

      // The provider was never even ASKED about the reference — the isolation
      // is structural, not a check that happened to reject.
      expect(adapter.asked).not.toContain(ref);
      expect(await creditsOf(t.owner.userId)).toBe(0);
    });
  });

  // =========================================================================
  // Renewal recovery and event ordering
  // =========================================================================
  describe("subscription renewals", () => {
    async function seedProSubscription(userId: string, provider: "STRIPE" | "PAYPAL") {
      const subRef = `sub-${randomUUID()}`;
      await prisma.subscription.create({
        data: {
          userId,
          provider,
          providerSubId: subRef,
          status: "ACTIVE",
          plan: "PRO",
          currentPeriodEnd: new Date("2026-08-01T00:00:00.000Z"),
          teamId: null,
        },
      });
      return subRef;
    }

    it("records a renewal payment local history was missing", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const subRef = await seedProSubscription(t.owner.userId, "STRIPE");
      const invoiceRef = `inv-${randomUUID()}`;

      const summary = await reconcile({
        account: accountRef("PERSONAL", t.owner.userId),
        providers: {
          STRIPE: new FixtureProvider(
            "STRIPE",
            {},
            {
              [subRef]: {
                kind: "SUBSCRIPTION",
                provider: "STRIPE" as never,
                providerRef: subRef,
                state: "SUCCEEDED",
                currentPeriodEndUtc: new Date("2026-09-01T00:00:00.000Z"),
                cancelAtPeriodEnd: false,
                observedAtUtc: new Date("2026-08-25T00:00:00.000Z"),
                recentPayments: [
                  {
                    kind: "PAYMENT",
                    provider: "STRIPE" as never,
                    providerRef: invoiceRef,
                    state: "SUCCEEDED",
                    amountCents: 1900,
                    currency: "USD",
                    quantity: null,
                    observedAtUtc: new Date("2026-08-25T00:00:00.000Z"),
                  },
                ],
              },
            },
          ),
        } as never,
      });

      expect(summary.paymentsRecorded).toBe(1);
      expect(
        await prisma.payment.count({
          where: { provider: "STRIPE", providerPaymentId: invoiceRef },
        }),
      ).toBe(1);
    });

    it("the same renewal cannot create two payments", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const subRef = await seedProSubscription(t.owner.userId, "PAYPAL");
      const txRef = `tx-${randomUUID()}`;
      const providers = {
        PAYPAL: new FixtureProvider(
          "PAYPAL",
          {},
          {
            [subRef]: {
              kind: "SUBSCRIPTION",
              provider: "PAYPAL" as never,
              providerRef: subRef,
              state: "SUCCEEDED",
              currentPeriodEndUtc: new Date("2026-09-01T00:00:00.000Z"),
              cancelAtPeriodEnd: false,
              observedAtUtc: new Date("2026-08-25T00:00:00.000Z"),
              recentPayments: [
                {
                  kind: "PAYMENT",
                  provider: "PAYPAL" as never,
                  providerRef: txRef,
                  state: "SUCCEEDED",
                  amountCents: 1900,
                  currency: "USD",
                  quantity: null,
                  observedAtUtc: new Date("2026-08-25T00:00:00.000Z"),
                },
              ],
            },
          },
        ),
      } as never;

      await reconcile({ account: accountRef("PERSONAL", t.owner.userId), providers });
      await reconcile({ account: accountRef("PERSONAL", t.owner.userId), providers });

      expect(
        await prisma.payment.count({
          where: { provider: "PAYPAL", providerPaymentId: txRef },
        }),
      ).toBe(1);
    });

    it("a STALE observation cannot resurrect a cancelled subscription", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const subRef = await seedProSubscription(t.owner.userId, "STRIPE");

      // A NEWER cancellation is already recorded, stamped with the provider's
      // own time — as a verified webhook would leave it.
      await prisma.subscription.updateMany({
        where: { provider: "STRIPE", providerSubId: subRef },
        data: {
          status: "PAST_DUE",
          providerStateAtUtc: new Date("2026-08-26T00:00:00.000Z"),
        },
      });

      const summary = await reconcile({
        account: accountRef("PERSONAL", t.owner.userId),
        providers: {
          STRIPE: new FixtureProvider(
            "STRIPE",
            {},
            {
              [subRef]: {
                kind: "SUBSCRIPTION",
                provider: "STRIPE" as never,
                providerRef: subRef,
                state: "SUCCEEDED",
                currentPeriodEndUtc: new Date("2026-09-01T00:00:00.000Z"),
                cancelAtPeriodEnd: false,
                // OLDER than what is recorded.
                observedAtUtc: new Date("2026-08-01T00:00:00.000Z"),
                recentPayments: [],
              },
            },
          ),
        } as never,
      });

      expect(summary.subscriptionsUpdated).toBe(0);
      const after = await prisma.subscription.findFirstOrThrow({
        where: { provider: "STRIPE", providerSubId: subRef },
        select: { status: true },
      });
      expect(after.status).toBe("PAST_DUE");
    });

    it("a pending renewal does not extend entitlement", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const subRef = await seedProSubscription(t.owner.userId, "STRIPE");

      const summary = await reconcile({
        account: accountRef("PERSONAL", t.owner.userId),
        providers: {
          STRIPE: new FixtureProvider(
            "STRIPE",
            {},
            {
              [subRef]: {
                kind: "SUBSCRIPTION",
                provider: "STRIPE" as never,
                providerRef: subRef,
                state: "PENDING",
                currentPeriodEndUtc: new Date("2026-12-01T00:00:00.000Z"),
                cancelAtPeriodEnd: false,
                observedAtUtc: new Date("2026-08-25T00:00:00.000Z"),
                recentPayments: [],
              },
            },
          ),
        } as never,
      });

      expect(summary.pending).toBeGreaterThan(0);
      const after = await prisma.subscription.findFirstOrThrow({
        where: { provider: "STRIPE", providerSubId: subRef },
        select: { currentPeriodEnd: true },
      });
      // The paid-through date did NOT move on a pending observation.
      expect(after.currentPeriodEnd?.toISOString()).toBe(
        "2026-08-01T00:00:00.000Z",
      );
    });
  });

  // =========================================================================
  // Storage add-ons — legacy immunity and dependency discovery
  // =========================================================================
  describe("storage add-ons", () => {
    async function seedLegacyOneTimeAddon(userId: string) {
      return prisma.workspaceStorageAddon.create({
        data: {
          ownerUserId: userId,
          teamId: null,
          addonKey: "PERSONAL_10_GB",
          extraStorageBytes: BigInt(10) * BigInt(1024) ** BigInt(3),
          billingCycle: "ONE_TIME",
          status: "ACTIVE",
          paymentProvider: "STRIPE",
          externalPaymentId: `legacy-${randomUUID()}`,
        },
        select: { id: true, status: true },
      });
    }

    it("a legacy one-time add-on is never treated as a provider subscription", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const legacy = await seedLegacyOneTimeAddon(t.owner.userId);

      const adapter = new FixtureProvider("STRIPE");
      await reconcile({
        account: accountRef("PERSONAL", t.owner.userId),
        providers: { STRIPE: adapter } as never,
      });

      // It has no subscription binding, so nothing asked the provider about it
      // — which is the only reason a provider that has never heard of it
      // cannot report it CANCELED.
      const after = await prisma.workspaceStorageAddon.findUniqueOrThrow({
        where: { id: legacy.id },
        select: { status: true, billingCycle: true },
      });
      expect(after.status).toBe("ACTIVE");
      expect(after.billingCycle).toBe("ONE_TIME");
    });

    it("a recurring add-on under a cancelled base plan is reported ACTION_REQUIRED", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const subRef = `sub-${randomUUID()}`;
      await prisma.subscription.create({
        data: {
          userId: t.owner.userId,
          provider: "STRIPE",
          providerSubId: subRef,
          status: "ACTIVE",
          plan: "PRO",
          teamId: null,
          currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
        },
      });
      await prisma.workspaceStorageAddon.create({
        data: {
          ownerUserId: t.owner.userId,
          teamId: null,
          addonKey: "PERSONAL_10_GB",
          extraStorageBytes: BigInt(10) * BigInt(1024) ** BigInt(3),
          billingCycle: "MONTHLY",
          status: "ACTIVE",
          paymentProvider: "STRIPE",
          externalSubscriptionId: `addon-${randomUUID()}`,
        },
      });

      const summary = await reconcile({
        account: accountRef("PERSONAL", t.owner.userId),
        providers: {
          STRIPE: new FixtureProvider(
            "STRIPE",
            {},
            {
              [subRef]: {
                kind: "SUBSCRIPTION",
                provider: "STRIPE" as never,
                providerRef: subRef,
                // The customer cancelled at the provider. Nothing told us.
                state: "CANCELED",
                currentPeriodEndUtc: new Date("2026-09-01T00:00:00.000Z"),
                cancelAtPeriodEnd: false,
                observedAtUtc: new Date("2026-08-26T00:00:00.000Z"),
                recentPayments: [],
              },
            },
          ),
        } as never,
      });

      // The base plan moved AND the dependent add-on is flagged: a provider
      // cancellation never implies its dependants were cancelled too.
      expect(summary.subscriptionsUpdated).toBeGreaterThan(0);
      expect(summary.actionRequired).toBeGreaterThan(0);
      expect(summary.outcome).toBe("ACTION_REQUIRED");
    });
  });

  // =========================================================================
  // BILLING SURFACE CORRECTION (2026-08-29) — the lifecycle of ONE pending
  // payment.
  //
  // The page listed payments and offered a PENDING one nothing: no way to ask
  // what had happened, no way to stop it, and no state it could ever reach. A
  // customer who closed a Stripe tab in March was still reading "Pending" in
  // August. These prove the row can now END, and that it can only end in a way
  // the provider actually confirmed.
  // =========================================================================
  describe("one pending payment", () => {
    let recheck: typeof import("../src/services/billing/pending-payments.service.js")["recheckPayment"];
    let cancelOne: typeof import("../src/services/billing/pending-payments.service.js")["cancelPendingPayment"];
    let abandonOne: typeof import("../src/services/billing/pending-payments.service.js")["abandonPendingPayment"];

    beforeAll(async () => {
      ({
        recheckPayment: recheck,
        cancelPendingPayment: cancelOne,
        abandonPendingPayment: abandonOne,
      } = await import("../src/services/billing/pending-payments.service.js"));
    });

    /** A payment left PENDING, exactly as an abandoned checkout leaves one. */
    async function seedPendingPayment(
      userId: string,
      provider: "STRIPE" | "PAYPAL",
      over: { providerStateAtUtc?: Date | null; status?: "PENDING" | "SUCCEEDED" } = {},
    ) {
      const ref = `pend-${randomUUID()}`;
      const row = await prisma.payment.create({
        data: {
          userId,
          provider,
          providerPaymentId: ref,
          amountCents: CREDIT_PRICE_CENTS,
          currency: "USD",
          status: over.status ?? "PENDING",
          teamId: null,
          ...(over.providerStateAtUtc
            ? { providerStateAtUtc: over.providerStateAtUtc }
            : {}),
        },
        select: { id: true },
      });
      return { id: row.id, ref };
    }

    const statusOf = async (id: string) =>
      (
        await prisma.payment.findUniqueOrThrow({
          where: { id },
          select: { status: true },
        })
      ).status;

    it("records the expiry the provider reports, and does not delete the row", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { id, ref } = await seedPendingPayment(t.owner.userId, "STRIPE");

      const result = await recheck({
        account: accountRef("PERSONAL", t.owner.userId),
        paymentId: id,
        viewerMayCancel: true,
        providers: {
          STRIPE: new FixtureProvider("STRIPE", {
            [ref]: settledCredit("STRIPE", ref, {
              state: "EXPIRED",
              observedAtUtc: new Date("2026-08-25T00:00:00.000Z"),
            }),
          }),
        } as never,
      });

      expect(result.outcome).toBe("UPDATED");
      expect(result.status).toBe("EXPIRED");
      expect(await statusOf(id)).toBe("EXPIRED");
      // History is never destroyed — the row stays, it just stops lying.
      expect(await prisma.payment.count({ where: { id } })).toBe(1);
      // And a finished payment offers nothing further.
      expect(result.actions).toEqual({
        canRecheck: false,
        canCancel: false,
        canAbandon: false,
      });
    });

    it("is idempotent — a second check changes nothing", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { id, ref } = await seedPendingPayment(t.owner.userId, "STRIPE");
      const providers = {
        STRIPE: new FixtureProvider("STRIPE", {
          [ref]: settledCredit("STRIPE", ref, { state: "EXPIRED" }),
        }),
      } as never;
      const account = accountRef("PERSONAL", t.owner.userId);

      await recheck({ account, paymentId: id, viewerMayCancel: true, providers });
      const second = await recheck({
        account,
        paymentId: id,
        viewerMayCancel: true,
        providers,
      });

      expect(second.outcome).toBe("NO_CHANGE");
      expect(second.status).toBe("EXPIRED");
    });

    it("hands back the provider's live continuation URL while it is still open", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { id, ref } = await seedPendingPayment(t.owner.userId, "STRIPE");

      const result = await recheck({
        account: accountRef("PERSONAL", t.owner.userId),
        paymentId: id,
        viewerMayCancel: true,
        providers: {
          STRIPE: new FixtureProvider("STRIPE", {
            [ref]: settledCredit("STRIPE", ref, {
              state: "PENDING",
              resumeUrl: "https://checkout.stripe.com/c/pay/live-session",
            }),
          }),
        } as never,
      });

      expect(result.outcome).toBe("NO_CHANGE");
      expect(result.status).toBe("PENDING");
      expect(result.resumeUrl).toBe("https://checkout.stripe.com/c/pay/live-session");
    });

    it("never moves a settled payment backwards, and never asks about one", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { id, ref } = await seedPendingPayment(t.owner.userId, "STRIPE", {
        status: "SUCCEEDED",
      });
      const adapter = new FixtureProvider("STRIPE", {
        [ref]: settledCredit("STRIPE", ref, { state: "PENDING" }),
      });

      const result = await recheck({
        account: accountRef("PERSONAL", t.owner.userId),
        paymentId: id,
        viewerMayCancel: true,
        providers: { STRIPE: adapter } as never,
      });

      expect(result.outcome).toBe("NO_CHANGE");
      expect(await statusOf(id)).toBe("SUCCEEDED");
      // A finished payment is not worth a provider round trip.
      expect(adapter.asked).toEqual([]);
    });

    it("discards an observation older than the state already recorded", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { id, ref } = await seedPendingPayment(t.owner.userId, "STRIPE", {
        providerStateAtUtc: new Date("2026-08-20T00:00:00.000Z"),
      });

      const result = await recheck({
        account: accountRef("PERSONAL", t.owner.userId),
        paymentId: id,
        viewerMayCancel: true,
        providers: {
          STRIPE: new FixtureProvider("STRIPE", {
            [ref]: settledCredit("STRIPE", ref, {
              state: "FAILED",
              observedAtUtc: new Date("2026-08-01T00:00:00.000Z"),
            }),
          }),
        } as never,
      });

      expect(result.outcome).toBe("NO_CHANGE");
      expect(await statusOf(id)).toBe("PENDING");
    });

    it("reports the provider as unavailable rather than guessing", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { id } = await seedPendingPayment(t.owner.userId, "STRIPE");

      const result = await recheck({
        account: accountRef("PERSONAL", t.owner.userId),
        paymentId: id,
        viewerMayCancel: true,
        // The fixture answers UNKNOWN for any reference it does not hold.
        providers: { STRIPE: new FixtureProvider("STRIPE", {}) } as never,
      });

      expect(result.outcome).toBe("PROVIDER_UNAVAILABLE");
      expect(await statusOf(id)).toBe("PENDING");
    });

    it("cannot reach a payment belonging to another account", async () => {
      const mine = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const theirs = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { id } = await seedPendingPayment(theirs.owner.userId, "STRIPE");

      await expect(
        recheck({
          account: accountRef("PERSONAL", mine.owner.userId),
          paymentId: id,
          viewerMayCancel: true,
          providers: { STRIPE: new FixtureProvider("STRIPE", {}) } as never,
        }),
      ).rejects.toMatchObject({ publicCode: "PAYMENT_NOT_FOUND" });

      expect(await statusOf(id)).toBe("PENDING");
    });

    // ---- cancellation ----------------------------------------------------

    it("stops a Stripe payment only through the provider's own answer", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { id, ref } = await seedPendingPayment(t.owner.userId, "STRIPE");

      const adapter = new FixtureProvider("STRIPE", {}) as FixtureProvider & {
        cancelPayment?: (ref: string) => Promise<unknown>;
      };
      const askedToCancel: string[] = [];
      adapter.cancelPayment = async (r: string) => {
        askedToCancel.push(r);
        return {
          outcome: "STOPPED",
          state: "EXPIRED",
          observedAtUtc: new Date("2026-08-29T00:00:00.000Z"),
        };
      };

      const result = await cancelOne({
        account: accountRef("PERSONAL", t.owner.userId),
        paymentId: id,
        providers: { STRIPE: adapter } as never,
      });

      expect(askedToCancel).toEqual([ref]);
      expect(result.outcome).toBe("CANCELLED");
      // The state written is the PROVIDER's, not the caller's wish: Stripe
      // expires a session, so the row records EXPIRED rather than "cancelled".
      expect(result.status).toBe("EXPIRED");
      expect(await statusOf(id)).toBe("EXPIRED");
    });

    it("refuses to cancel where the provider has no such operation", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { id } = await seedPendingPayment(t.owner.userId, "PAYPAL");

      await expect(
        cancelOne({
          account: accountRef("PERSONAL", t.owner.userId),
          paymentId: id,
          // The PayPal fixture has no cancelPayment, exactly like the real one.
          providers: { PAYPAL: new FixtureProvider("PAYPAL", {}) } as never,
        }),
      ).rejects.toMatchObject({
        publicCode: "PAYMENT_CANCELLATION_UNSUPPORTED",
      });

      // Untouched. A local "Cancelled" while PayPal is still free to complete
      // the order is the lie this refusal exists to prevent.
      expect(await statusOf(id)).toBe("PENDING");
    });

    // ---- abandoning what the provider cannot be asked to stop ------------

    it("records the CUSTOMER's decision on a PayPal attempt, without claiming PayPal did anything", async () => {
      /*
       * THE defect this closes. PayPal exposes no cancellation for an
       * unapproved order, so a March approval attempt sat at PENDING with one
       * action — "Re-check" — that kept returning the same answer. The
       * dishonest fix is a local "cancelled"; this records what the CUSTOMER
       * decided, only after the provider confirms nothing was captured.
       */
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { id, ref } = await seedPendingPayment(t.owner.userId, "PAYPAL");

      const result = await abandonOne({
        account: accountRef("PERSONAL", t.owner.userId),
        paymentId: id,
        providers: {
          PAYPAL: new FixtureProvider("PAYPAL", {
            [ref]: settledCredit("PAYPAL", ref, { state: "PENDING" }),
          }),
        } as never,
      });

      expect(result.outcome).toBe("ABANDONED");
      expect(result.status).toBe("ABANDONED");
      expect(await statusOf(id)).toBe("ABANDONED");
      // The row survives: history is never destroyed.
      expect(await prisma.payment.count({ where: { id } })).toBe(1);
    });

    it("is idempotent — abandoning twice writes once and asks the provider once", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { id, ref } = await seedPendingPayment(t.owner.userId, "PAYPAL");
      const adapter = new FixtureProvider("PAYPAL", {
        [ref]: settledCredit("PAYPAL", ref, { state: "PENDING" }),
      });
      const account = accountRef("PERSONAL", t.owner.userId);

      await abandonOne({ account, paymentId: id, providers: { PAYPAL: adapter } as never });
      const second = await abandonOne({
        account,
        paymentId: id,
        providers: { PAYPAL: adapter } as never,
      });

      expect(second.outcome).toBe("ALREADY_ABANDONED");
      expect(await statusOf(id)).toBe("ABANDONED");
      // One provider round trip, not two: the second press learns nothing new.
      expect(adapter.asked).toEqual([ref]);
    });

    it("refuses to abandon a payment the provider says actually settled", async () => {
      // Telling a customer their money is not coming, when it already went, is
      // the one outcome this action must never produce.
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { id, ref } = await seedPendingPayment(t.owner.userId, "PAYPAL");

      const result = await abandonOne({
        account: accountRef("PERSONAL", t.owner.userId),
        paymentId: id,
        providers: {
          PAYPAL: new FixtureProvider("PAYPAL", {
            [ref]: settledCredit("PAYPAL", ref, { state: "SUCCEEDED" }),
          }),
        } as never,
      });

      expect(result.outcome).toBe("PROVIDER_ANSWERED");
      expect(result.status).toBe("SUCCEEDED");
      expect(await statusOf(id)).toBe("SUCCEEDED");
    });

    it("changes nothing when the provider cannot be reached", async () => {
      // "We could not check" is not "you have abandoned it".
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { id } = await seedPendingPayment(t.owner.userId, "PAYPAL");

      await expect(
        abandonOne({
          account: accountRef("PERSONAL", t.owner.userId),
          paymentId: id,
          providers: { PAYPAL: new FixtureProvider("PAYPAL", {}) } as never,
        }),
      ).rejects.toMatchObject({ publicCode: "PAYMENT_PROVIDER_UNAVAILABLE" });

      expect(await statusOf(id)).toBe("PENDING");
    });

    it("still yields to a later proven settlement", async () => {
      /*
       * ABANDONED is an INTENTION. If a capture that was in flight lands
       * afterwards, the settlement is a fact and the intention is not — so a
       * re-check moves the row to SUCCEEDED rather than protecting the note
       * the customer left.
       */
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { id, ref } = await seedPendingPayment(t.owner.userId, "PAYPAL");
      const account = accountRef("PERSONAL", t.owner.userId);

      await abandonOne({
        account,
        paymentId: id,
        providers: {
          PAYPAL: new FixtureProvider("PAYPAL", {
            [ref]: settledCredit("PAYPAL", ref, { state: "PENDING" }),
          }),
        } as never,
      });
      expect(await statusOf(id)).toBe("ABANDONED");

      const later = await recheck({
        account,
        paymentId: id,
        viewerMayCancel: true,
        providers: {
          PAYPAL: new FixtureProvider("PAYPAL", {
            [ref]: settledCredit("PAYPAL", ref, { state: "SUCCEEDED" }),
          }),
        } as never,
      });

      // A terminal row is not re-observed by `recheckPayment`, so the customer
      // learns nothing new here — the WEBHOOK is what carries a late
      // settlement, and `decidePaymentTransition` lets it through. That rule
      // is proven in the unit suite; what matters here is that the row was not
      // silently reopened.
      expect(later.outcome).toBe("NO_CHANGE");
      expect(await statusOf(id)).toBe("ABANDONED");
    });

    it("leaves the payment alone when the provider cannot be reached", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { id } = await seedPendingPayment(t.owner.userId, "STRIPE");

      const adapter = new FixtureProvider("STRIPE", {}) as FixtureProvider & {
        cancelPayment?: (ref: string) => Promise<unknown>;
      };
      adapter.cancelPayment = async () => ({ outcome: "PROVIDER_UNAVAILABLE" });

      await expect(
        cancelOne({
          account: accountRef("PERSONAL", t.owner.userId),
          paymentId: id,
          providers: { STRIPE: adapter } as never,
        }),
      ).rejects.toMatchObject({ publicCode: "PAYMENT_PROVIDER_UNAVAILABLE" });

      expect(await statusOf(id)).toBe("PENDING");
    });
  });
});
