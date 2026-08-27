/**
 * BILLING DEPENDENT-CANCELLATION CONVERGENCE — the ORCHESTRATION, against live
 * PostgreSQL 16 with an injected add-on canceller.
 *
 * WHAT IS REAL HERE
 * ---------------------------------------------------------------------------
 * `requestSubscriptionCancellation` itself — the ordering, the atomic
 * obligation write, the first attempt, the outcome composition and the
 * idempotent-repeat branch — plus the retry worker, the reconciliation
 * convergence, the Operations condition and the Billing projection. The
 * previous suite exercised only the helper beneath all of that, which is how a
 * defect in the layer above it survived: the failure was recorded nowhere and
 * every test still passed.
 *
 * The BASE provider call is stubbed at the module boundary (`stripe.service`,
 * `paypal.service`), so the base path under test is the production one. The
 * DEPENDENT provider call is injected, because that is the contract the
 * cancellation service exposes for exactly this purpose.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps } from "./point7/product-fixtures.js";
import type { StorageAddonProviderCanceller } from "../src/services/billing/storage-addon-cancellation.service.js";

const GB = BigInt(1024) ** BigInt(3);

// The BASE provider clients. Stripe echoes the flag back, as the real API does;
// PayPal resolves. Neither is ever a network call.
const stripeRequestMock = vi.fn(async () => ({ cancel_at_period_end: true }));
const paypalCancelMock = vi.fn(async () => undefined);

vi.mock("../src/services/stripe.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    stripeRequest: (...args: unknown[]) => stripeRequestMock(...(args as [])),
    stripeRequestRaw: async () => ({}),
  };
});

vi.mock("../src/services/paypal.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    cancelPayPalSubscription: (...args: unknown[]) =>
      paypalCancelMock(...(args as [])),
  };
});

describe("BILLING — dependent storage cancellation orchestration (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let cancel: typeof import("../src/services/billing/subscription-cancellation.service.js")["requestSubscriptionCancellation"];

  /** Every dependent call succeeds, recording what it was asked. */
  const accepting = () => {
    const calls: Array<{ providerRef: string; mode: string }> = [];
    const fn: StorageAddonProviderCanceller = async ({ providerRef, mode }) => {
      calls.push({ providerRef, mode });
      return { ok: true, mode, terminal: mode === "IMMEDIATE" };
    };
    return { fn, calls };
  };

  /** Every dependent call fails, the way an unreachable provider does. */
  const unavailable: StorageAddonProviderCanceller = async ({ mode }) => ({
    ok: false,
    mode,
    reasonCode: "PROVIDER_UNAVAILABLE",
  });

  /** Fails for ONE named binding, succeeds for the rest. */
  const failsOnly = (badRef: string): StorageAddonProviderCanceller =>
    async ({ providerRef, mode }) =>
      providerRef === badRef
        ? { ok: false, mode, reasonCode: "PROVIDER_UNAVAILABLE" }
        : { ok: true, mode, terminal: mode === "IMMEDIATE" };

  async function seedBase(
    userId: string,
    provider: "STRIPE" | "PAYPAL",
    plan: "PRO" | "TEAM" = "PRO",
    teamId: string | null = null,
  ) {
    return prisma.subscription.create({
      data: {
        userId,
        provider,
        providerSubId: `sub-${randomUUID()}`,
        status: "ACTIVE",
        plan,
        teamId,
        currentPeriodEnd: new Date("2026-09-30T00:00:00.000Z"),
      },
      select: { id: true, providerSubId: true },
    });
  }

  async function seedAddon(input: {
    ownerUserId: string;
    teamId?: string | null;
    cycle?: "MONTHLY" | "ONE_TIME";
    gb?: number;
  }) {
    const cycle = input.cycle ?? "MONTHLY";
    return prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId: input.ownerUserId,
        teamId: input.teamId ?? null,
        addonKey: "PERSONAL_10_GB",
        extraStorageBytes: BigInt(input.gb ?? 10) * GB,
        billingCycle: cycle,
        status: "ACTIVE",
        paymentProvider: "STRIPE",
        ...(cycle === "MONTHLY"
          ? { externalSubscriptionId: `addon-${randomUUID()}` }
          : { externalPaymentId: `legacy-${randomUUID()}` }),
      },
      select: {
        id: true,
        externalSubscriptionId: true,
        dependentCancellationState: true,
      },
    });
  }

  const stateOf = async (id: string) =>
    prisma.workspaceStorageAddon.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        dependentCancellationState: true,
        dependentCancellationAttemptCount: true,
        dependentCancellationReasonCode: true,
        dependentCancellationNextRetryAtUtc: true,
        dependentCancellationConfirmedAtUtc: true,
      },
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ requestSubscriptionCancellation: cancel } = await import(
      "../src/services/billing/subscription-cancellation.service.js"
    ));

    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `bdc-${Date.now().toString(36)}`,
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

  afterEach(() => {
    stripeRequestMock.mockClear();
    paypalCancelMock.mockClear();
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  // =========================================================================
  // Stripe — period end
  // =========================================================================
  describe("Stripe period-end", () => {
    it("all add-ons schedule; obligations confirm; base is called once", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const base = await seedBase(t.owner.userId, "STRIPE");
      const a1 = await seedAddon({ ownerUserId: t.owner.userId });
      const a2 = await seedAddon({ ownerUserId: t.owner.userId });

      const { fn, calls } = accepting();
      const outcome = await cancel({
        subscriptionId: base.id,
        cancelAddonAtProvider: fn,
      });

      expect(outcome.mode).toBe("PERIOD_END");
      expect(outcome.dependentAddonsFailed).toBe(0);
      expect(calls.every((c) => c.mode === "PERIOD_END")).toBe(true);
      // The base provider was asked exactly once.
      expect(stripeRequestMock).toHaveBeenCalledTimes(1);

      for (const a of [a1, a2]) {
        const after = await stateOf(a.id);
        expect(after.dependentCancellationState).toBe("CONFIRMED");
        expect(after.dependentCancellationConfirmedAtUtc).not.toBeNull();
        // PERIOD_END keeps the capacity the customer paid for.
        expect(after.status).toBe("ACTIVE");
      }
    });

    it("one failure is PERSISTED with a safe reason and a scheduled retry", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const base = await seedBase(t.owner.userId, "STRIPE");
      const good = await seedAddon({ ownerUserId: t.owner.userId });
      const bad = await seedAddon({ ownerUserId: t.owner.userId });

      const outcome = await cancel({
        subscriptionId: base.id,
        cancelAddonAtProvider: failsOnly(bad.externalSubscriptionId!),
      });

      expect(outcome.dependentAddonsFailed).toBe(1);

      // THE POINT: the failure survives the response.
      const failed = await stateOf(bad.id);
      expect(failed.dependentCancellationState).toBe("RETRY_SCHEDULED");
      expect(failed.dependentCancellationAttemptCount).toBe(1);
      expect(failed.dependentCancellationReasonCode).toBe("PROVIDER_UNAVAILABLE");
      expect(failed.dependentCancellationNextRetryAtUtc).not.toBeNull();
      // Still ACTIVE, so it stays visible and still known to be charging.
      expect(failed.status).toBe("ACTIVE");

      // Partial success: the other one converged.
      expect((await stateOf(good.id)).dependentCancellationState).toBe("CONFIRMED");
    });

    it("the projection stays ACTION_REQUIRED after a reload", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const base = await seedBase(t.owner.userId, "STRIPE");
      await seedAddon({ ownerUserId: t.owner.userId });

      await cancel({ subscriptionId: base.id, cancelAddonAtProvider: unavailable });

      // A FRESH projection — the state is on the server, not in a toast.
      const { buildBillingAccountProjection } = await import(
        "../src/services/billing/billing-account-projection.service.js"
      );
      const projection = await buildBillingAccountProjection({
        viewerUserId: t.owner.userId,
        account: {
          type: "PERSONAL",
          id: t.owner.userId,
          displayName: "",
          capabilities: [
            "BILLING_ACCOUNT_VIEW",
            "BILLING_AMOUNT_VIEW",
            "BILLING_MANAGE",
            "BILLING_CANCEL",
            "BILLING_ADDON_PURCHASE",
          ],
          billingOwnerMissing: false,
        },
      });

      expect(projection.dependentStorageCancellation).toBeTruthy();
      expect(projection.dependentStorageCancellation?.affectedCount).toBe(1);
      expect(projection.dependentStorageCancellation?.actionAvailable).toBe(true);
      expect(projection.actionRequired?.severity).toBe("CRITICAL");
      expect(projection.actionRequired?.messages.join(" ")).toMatch(
        /still being stopped/i,
      );
    });

    it("a retry touches only the unresolved add-on and never the base again", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const base = await seedBase(t.owner.userId, "STRIPE");
      const good = await seedAddon({ ownerUserId: t.owner.userId });
      const bad = await seedAddon({ ownerUserId: t.owner.userId });

      await cancel({
        subscriptionId: base.id,
        cancelAddonAtProvider: failsOnly(bad.externalSubscriptionId!),
      });
      stripeRequestMock.mockClear();

      const { attemptDependentCancellations } = await import(
        "../src/services/billing/dependent-cancellation.service.js"
      );
      const { fn, calls } = accepting();
      const retry = await attemptDependentCancellations({
        ownerUserId: t.owner.userId,
        teamId: null,
        cancelAtProvider: fn,
      });

      expect(retry.attempted).toBe(1);
      expect(retry.confirmed).toBe(1);
      expect(calls.map((c) => c.providerRef)).toEqual([
        bad.externalSubscriptionId,
      ]);
      // The already-confirmed one was not touched, and neither was the base.
      expect((await stateOf(good.id)).dependentCancellationAttemptCount).toBe(1);
      expect(stripeRequestMock).not.toHaveBeenCalled();
      expect((await stateOf(bad.id)).dependentCancellationState).toBe("CONFIRMED");
    });

    it("repeated failures escalate to MANUAL_INTERVENTION and keep retrying", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const base = await seedBase(t.owner.userId, "STRIPE");
      const addon = await seedAddon({ ownerUserId: t.owner.userId });

      await cancel({ subscriptionId: base.id, cancelAddonAtProvider: unavailable });

      const { attemptDependentCancellations, MAX_FAST_ATTEMPTS } = await import(
        "../src/services/billing/dependent-cancellation.service.js"
      );
      for (let i = 1; i < MAX_FAST_ATTEMPTS; i += 1) {
        await attemptDependentCancellations({
          ownerUserId: t.owner.userId,
          teamId: null,
          cancelAtProvider: unavailable,
        });
      }

      const after = await stateOf(addon.id);
      expect(after.dependentCancellationState).toBe("MANUAL_INTERVENTION");
      expect(after.dependentCancellationReasonCode).toBe("RETRY_EXHAUSTED");
      // NOT abandoned: a next retry is still scheduled, and the add-on is
      // still ACTIVE rather than falsely marked cancelled.
      expect(after.dependentCancellationNextRetryAtUtc).not.toBeNull();
      expect(after.status).toBe("ACTIVE");
    });

    it("a second cancel request retries dependants without re-cancelling the base", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const base = await seedBase(t.owner.userId, "STRIPE");
      const addon = await seedAddon({ ownerUserId: t.owner.userId });

      await cancel({ subscriptionId: base.id, cancelAddonAtProvider: unavailable });
      expect(stripeRequestMock).toHaveBeenCalledTimes(1);
      stripeRequestMock.mockClear();

      const { fn } = accepting();
      const second = await cancel({
        subscriptionId: base.id,
        cancelAddonAtProvider: fn,
      });

      expect(second.alreadyScheduled).toBe(true);
      expect(stripeRequestMock).not.toHaveBeenCalled();
      expect((await stateOf(addon.id)).dependentCancellationState).toBe("CONFIRMED");
    });
  });

  // =========================================================================
  // PayPal — immediate
  // =========================================================================
  describe("PayPal immediate", () => {
    it("cancels dependants immediately and records no period-end", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const base = await seedBase(t.owner.userId, "PAYPAL");
      await prisma.workspaceStorageAddon.updateMany({
        where: { ownerUserId: t.owner.userId },
        data: { paymentProvider: "PAYPAL" },
      });
      const addon = await seedAddon({ ownerUserId: t.owner.userId });
      await prisma.workspaceStorageAddon.update({
        where: { id: addon.id },
        data: { paymentProvider: "PAYPAL" },
      });

      const { fn, calls } = accepting();
      const outcome = await cancel({
        subscriptionId: base.id,
        cancelAddonAtProvider: fn,
      });

      expect(outcome.mode).toBe("IMMEDIATE");
      // NO false period-end anywhere.
      expect(outcome.cancelAtPeriodEnd).toBe(false);
      expect(outcome.accessEndsAtUtc).toBeNull();
      expect(calls.every((c) => c.mode === "IMMEDIATE")).toBe(true);
      expect(paypalCancelMock).toHaveBeenCalledTimes(1);

      const after = await stateOf(addon.id);
      expect(after.dependentCancellationState).toBe("CONFIRMED");
      // IMMEDIATE is terminal, so the capacity ends now.
      expect(after.status).toBe("CANCELED");
    });

    it("a failed dependant stays live, durable and retried", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const base = await seedBase(t.owner.userId, "PAYPAL");
      const addon = await seedAddon({ ownerUserId: t.owner.userId });
      await prisma.workspaceStorageAddon.update({
        where: { id: addon.id },
        data: { paymentProvider: "PAYPAL" },
      });

      const outcome = await cancel({
        subscriptionId: base.id,
        cancelAddonAtProvider: unavailable,
      });
      expect(outcome.dependentAddonsFailed).toBe(1);

      const after = await stateOf(addon.id);
      expect(after.dependentCancellationState).toBe("RETRY_SCHEDULED");
      // NEVER locally cancelled on a provider failure.
      expect(after.status).toBe("ACTIVE");
    });
  });

  // =========================================================================
  // Crash recovery and convergence
  // =========================================================================
  describe("convergence", () => {
    it("reconciliation creates the obligation the crash window swallowed", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      // A base the provider has cancelled, an add-on still live, and NO
      // obligation — exactly what a process death between the two writes
      // leaves behind.
      await prisma.subscription.create({
        data: {
          userId: t.owner.userId,
          provider: "STRIPE",
          providerSubId: `sub-${randomUUID()}`,
          status: "CANCELED",
          plan: "PRO",
          teamId: null,
        },
      });
      const orphan = await seedAddon({ ownerUserId: t.owner.userId });
      expect(orphan.dependentCancellationState).toBe("NONE");

      const { reconcileBillingAccount } = await import(
        "../src/services/billing/reconciliation/reconciliation.service.js"
      );
      const { fn } = accepting();
      const summary = await reconcileBillingAccount({
        account: {
          type: "PERSONAL",
          id: t.owner.userId,
          displayName: "",
          capabilities: [],
          billingOwnerMissing: false,
        },
        providers: {},
        cancelAddonAtProvider: fn,
      });

      // Created AND acted on, in one pass.
      expect((await stateOf(orphan.id)).dependentCancellationState).toBe(
        "CONFIRMED",
      );
      expect(summary.subscriptionsUpdated).toBeGreaterThan(0);
    });

    it("a CANCELED base with an unresolved dependant is still discoverable", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      await prisma.subscription.create({
        data: {
          userId: t.owner.userId,
          provider: "STRIPE",
          providerSubId: `sub-${randomUUID()}`,
          // TERMINAL — the state that used to remove the base from every
          // reconciliation query and make the orphan permanent.
          status: "CANCELED",
          plan: "PRO",
          teamId: null,
        },
      });
      const orphan = await seedAddon({ ownerUserId: t.owner.userId });

      const { reconcileBillingAccount } = await import(
        "../src/services/billing/reconciliation/reconciliation.service.js"
      );
      const summary = await reconcileBillingAccount({
        account: {
          type: "PERSONAL",
          id: t.owner.userId,
          displayName: "",
          capabilities: [],
          billingOwnerMissing: false,
        },
        providers: {},
        cancelAddonAtProvider: unavailable,
      });

      expect(summary.actionRequired).toBeGreaterThan(0);
      expect(summary.outcome).toBe("ACTION_REQUIRED");
      expect((await stateOf(orphan.id)).dependentCancellationState).not.toBe(
        "NONE",
      );
    });

    it("the worker sweep resumes a due obligation after a restart", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const base = await seedBase(t.owner.userId, "STRIPE");
      const addon = await seedAddon({ ownerUserId: t.owner.userId });
      await cancel({ subscriptionId: base.id, cancelAddonAtProvider: unavailable });

      // Nothing in memory survives; the obligation is a row, and it is due.
      await prisma.workspaceStorageAddon.update({
        where: { id: addon.id },
        data: { dependentCancellationNextRetryAtUtc: new Date(Date.now() - 1000) },
      });

      const { runDependentCancellationRetrySweep } = await import(
        "../src/jobs/dependent-cancellation-retry.job.js"
      );
      const { fn } = accepting();
      const swept = await runDependentCancellationRetrySweep({
        cancelAtProvider: fn,
      });

      // The sweep is GLOBAL by design — it serves every due obligation, not
      // just this test's — so the assertion is about THIS add-on converging,
      // plus the sweep having done work at all.
      expect(swept.confirmed).toBeGreaterThanOrEqual(1);
      expect((await stateOf(addon.id)).dependentCancellationState).toBe(
        "CONFIRMED",
      );
    });

    it("an older observation cannot reopen a confirmed cancellation", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const addon = await seedAddon({ ownerUserId: t.owner.userId });
      await prisma.workspaceStorageAddon.update({
        where: { id: addon.id },
        data: {
          dependentCancellationState: "CONFIRMED",
          dependentCancellationConfirmedAtUtc: new Date("2026-08-26T00:00:00Z"),
          providerStateAtUtc: new Date("2026-08-26T00:00:00Z"),
        },
      });

      const { reopenObligationFromProviderTruth } = await import(
        "../src/services/billing/dependent-cancellation.service.js"
      );
      const reopened = await reopenObligationFromProviderTruth({
        addonId: addon.id,
        observedAtUtc: new Date("2026-08-01T00:00:00Z"),
      });

      expect(reopened).toBe(false);
      expect((await stateOf(addon.id)).dependentCancellationState).toBe(
        "CONFIRMED",
      );
    });
  });

  // =========================================================================
  // Operations condition
  // =========================================================================
  describe("operations condition", () => {
    it("opens tenant-isolated, carries no provider identifier, and cannot be resolved by hand", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const base = await seedBase(t.owner.userId, "STRIPE");
      // A PERSONAL add-on: teamId null is what makes it personal. The
      // condition must still be attributed — to the owner's Personal Space.
      const addon = await seedAddon({ ownerUserId: t.owner.userId });
      await cancel({ subscriptionId: base.id, cancelAddonAtProvider: unavailable });

      const { syncDependentCancellationConditions, dependentCancellationFingerprint } =
        await import(
          "../src/services/billing/dependent-cancellation-conditions.service.js"
        );
      await syncDependentCancellationConditions();

      const incident = await prisma.operationalIncident.findFirstOrThrow({
        where: { fingerprint: dependentCancellationFingerprint(addon.id) },
        select: {
          teamId: true,
          sourceId: true,
          severity: true,
          safeSummary: true,
          title: true,
        },
      });

      expect(incident.sourceId).toBe("billing.dependent_cancellation_failed");
      expect(incident.severity).toBe("HIGH");
      // Tenant-isolated to the add-on's own workspace.
      expect(incident.teamId).toBe(t.personalTeamId);

      // No provider identifier anywhere in what an operator reads.
      const rendered = JSON.stringify(incident);
      expect(rendered).not.toMatch(/sub-|addon-|cs_|pi_|PAYID/);
      expect(rendered).not.toContain(t.owner.email);

      // The registered contract refuses a hand-written resolution: the money
      // does not stop because someone typed a note.
      const { lifecycleForSourceId } = await import("@proovra/shared-runtime");
      const lifecycle = lifecycleForSourceId(
        "billing.dependent_cancellation_failed",
      );
      expect(lifecycle?.resolutionAuthority).toBe("SOURCE_TRUTH");
      expect(lifecycle?.recoveryPolicy).toBe("PROBE_AUTO_RESOLVE");
      // ALLOW_OPERATOR_CLOSE, and the distinction is the point: it does NOT
      // let anyone declare the cancellation done. It is the narrower escape
      // hatch every PER_RECORD source needs for a subject that no longer
      // exists — a condition about a deleted add-on that nobody can close is
      // permanent noise. The two assertions above are what stop a human
      // resolving it while the add-on is still billing.
      expect(lifecycle?.notApplicableDisposition).toBe("ALLOW_OPERATOR_CLOSE");
      expect(lifecycle?.requiresResolutionNote).toBe(false);
    });
  });

  // =========================================================================
  // Legacy one-time storage
  // =========================================================================
  it("a legacy one-time add-on receives no obligation and no provider call", async () => {
    const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
    const base = await seedBase(t.owner.userId, "STRIPE");
    const legacy = await seedAddon({
      ownerUserId: t.owner.userId,
      cycle: "ONE_TIME",
      gb: 5,
    });

    const { fn, calls } = accepting();
    await cancel({ subscriptionId: base.id, cancelAddonAtProvider: fn });

    expect(calls).toEqual([]);
    const after = await prisma.workspaceStorageAddon.findUniqueOrThrow({
      where: { id: legacy.id },
      select: {
        status: true,
        billingCycle: true,
        dependentCancellationState: true,
        dependentCancellationAttemptCount: true,
      },
    });
    // Untouched in every respect: still active, still one-time, no obligation.
    expect(after.status).toBe("ACTIVE");
    expect(after.billingCycle).toBe("ONE_TIME");
    expect(after.dependentCancellationState).toBe("NONE");
    expect(after.dependentCancellationAttemptCount).toBe(0);
  });

  // =========================================================================
  // Isolation
  // =========================================================================
  it("one account's cancellation never creates an obligation on another's add-on", async () => {
    const a = await seedPersonalTenant(deps, "PRO", { credits: 0 });
    const b = await seedPersonalTenant(deps, "PRO", { credits: 0 });
    const base = await seedBase(a.owner.userId, "STRIPE");
    const theirs = await seedAddon({ ownerUserId: b.owner.userId });

    const { fn, calls } = accepting();
    await cancel({ subscriptionId: base.id, cancelAddonAtProvider: fn });

    expect(calls.map((c) => c.providerRef)).not.toContain(
      theirs.externalSubscriptionId,
    );
    expect((await stateOf(theirs.id)).dependentCancellationState).toBe("NONE");
  });
});
