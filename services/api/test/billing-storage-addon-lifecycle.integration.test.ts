/**
 * BILLING — recurring Storage add-on lifecycle safety, against live
 * PostgreSQL 16 with an INJECTED provider canceller.
 *
 * THE RISK BEING CLOSED
 * ---------------------------------------------------------------------------
 * A recurring Storage add-on is its own provider subscription. Cancelling the
 * PRO or TEAM plan it extends did nothing to it, so the provider kept charging
 * for storage on an account that no longer had the plan. The customer sees a
 * cancelled subscription and a monthly charge nobody can explain.
 *
 * WHAT THESE TESTS HOLD
 * ---------------------------------------------------------------------------
 * That the cascade is PROVIDER-FIRST and that a provider failure is never
 * written as a local cancellation. The second half is the one that matters:
 * marking an add-on cancelled locally when the provider refused is how a
 * silently charging orphan becomes invisible to everyone, including support.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps } from "./point7/product-fixtures.js";
import type { StorageAddonProviderCanceller } from "../src/services/billing/storage-addon-cancellation.service.js";

const GB = BigInt(1024) ** BigInt(3);

describe("BILLING — recurring storage add-on lifecycle (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let cascade: typeof import("../src/services/billing/storage-addon-dependency.service.js")["cancelDependentRecurringAddons"];

  /** Every provider call succeeds, and records what it was asked to do. */
  const acceptingCanceller = () => {
    const calls: Array<{ providerRef: string; mode: string }> = [];
    const fn: StorageAddonProviderCanceller = async ({ providerRef, mode }) => {
      calls.push({ providerRef, mode });
      return { ok: true as const, mode, terminal: mode === "IMMEDIATE" };
    };
    return { fn, calls };
  };

  /** The provider refuses. Nothing local may move. */
  const refusingCanceller: StorageAddonProviderCanceller = async ({ mode }) => ({
    ok: false as const,
    mode,
    reasonCode: "PROVIDER_UNAVAILABLE" as const,
  });

  async function seedAddon(input: {
    ownerUserId: string;
    teamId?: string | null;
    cycle: "MONTHLY" | "ONE_TIME";
    gb: number;
    status?: "ACTIVE" | "PENDING" | "PAST_DUE" | "CANCELED";
  }) {
    return prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId: input.ownerUserId,
        teamId: input.teamId ?? null,
        addonKey: "PERSONAL_10_GB",
        extraStorageBytes: BigInt(input.gb) * GB,
        billingCycle: input.cycle,
        status: input.status ?? "ACTIVE",
        paymentProvider: "STRIPE",
        ...(input.cycle === "MONTHLY"
          ? { externalSubscriptionId: `addon-${randomUUID()}` }
          : { externalPaymentId: `legacy-${randomUUID()}` }),
      },
      select: { id: true, externalSubscriptionId: true, extraStorageBytes: true },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ cancelDependentRecurringAddons: cascade } = await import(
      "../src/services/billing/storage-addon-dependency.service.js"
    ));

    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `bsal-${Date.now().toString(36)}`,
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
  // The cascade
  // =========================================================================
  // ===========================================================================
  // SUPERSEDED, and named rather than silently dropped.
  // ===========================================================================
  //
  // Four cases lived here: Stripe period-end cascade, PayPal immediate cascade,
  // a refused provider cancellation, and the repeat-clears-a-failure case. All
  // four drove `cancelDependentRecurringAddons` DIRECTLY — the weaker entry
  // point, which proved the helper and nothing above it. That is how a defect
  // in the layer immediately above them survived a green suite: the failure was
  // recorded nowhere and every one of these still passed.
  //
  // Every property they held is now proven through the real production
  // orchestration — `requestSubscriptionCancellation`, its atomic obligation
  // write, the durable failure state, the retry and the convergence — in
  // `billing-dependent-cancellation.integration.test.ts`. The cascade itself is
  // no longer a discovery function: it attempts DURABLE OBLIGATIONS, so calling
  // it without one now correctly finds nothing, and a test that recreated an
  // obligation by hand just to call it would be testing its own fixture.

  // =========================================================================
  // Isolation
  // =========================================================================
  it("one account's cascade never touches another account's add-on", async () => {
    const a = await seedPersonalTenant(deps, "PRO", { credits: 0 });
    const b = await seedPersonalTenant(deps, "PRO", { credits: 0 });
    const theirs = await seedAddon({
      ownerUserId: b.owner.userId,
      cycle: "MONTHLY",
      gb: 10,
    });

    const { fn, calls } = acceptingCanceller();
    const result = await cascade({
      ownerUserId: a.owner.userId,
      teamId: null,
      mode: "PERIOD_END",
      cancelAtProvider: fn,
    });

    expect(result.found).toBe(0);
    expect(calls).toEqual([]);
    const after = await prisma.workspaceStorageAddon.findUniqueOrThrow({
      where: { id: theirs.id },
      select: { status: true },
    });
    expect(after.status).toBe("ACTIVE");
  });

  // =========================================================================
  // Legacy one-time storage
  // =========================================================================
  it("a legacy one-time add-on is never cascaded, cancelled or re-charged", async () => {
    const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
    const legacy = await seedAddon({
      ownerUserId: t.owner.userId,
      cycle: "ONE_TIME",
      gb: 10,
    });

    const { fn, calls } = acceptingCanceller();
    const result = await cascade({
      ownerUserId: t.owner.userId,
      teamId: null,
      mode: "IMMEDIATE",
      cancelAtProvider: fn,
    });

    // It is not a provider subscription, so it is not a dependant.
    expect(result.found).toBe(0);
    expect(calls).toEqual([]);
    const after = await prisma.workspaceStorageAddon.findUniqueOrThrow({
      where: { id: legacy.id },
      select: { status: true, billingCycle: true, externalSubscriptionId: true },
    });
    expect(after.status).toBe("ACTIVE");
    expect(after.billingCycle).toBe("ONE_TIME");
    expect(after.externalSubscriptionId).toBeNull();
  });

  // =========================================================================
  // Capacity — the stacking rule, as the catalog actually implements it
  // =========================================================================
  describe("capacity", () => {
    /** The projection's own accounting, read the way the meter reads it. */
    async function capacityOf(ownerUserId: string) {
      const rows = await prisma.workspaceStorageAddon.findMany({
        where: {
          ownerUserId,
          teamId: null,
          status: { in: ["ACTIVE", "PAST_DUE"] },
        },
        select: { extraStorageBytes: true, billingCycle: true },
      });
      let recurring = 0n;
      let legacy = 0n;
      for (const r of rows) {
        if (r.billingCycle === "ONE_TIME") legacy += r.extraStorageBytes;
        else recurring += r.extraStorageBytes;
      }
      return { recurring, legacy };
    }

    it("STACKING is the rule: repeated purchases aggregate deterministically", async () => {
      // The catalog supports stacking — each purchase carries its own unique
      // `externalSubscriptionId`, and capacity is a SUM over live rows. This
      // test states that rule rather than inventing one, and it is the reason
      // no server-side uniqueness guard exists to enforce the opposite.
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const first = await seedAddon({
        ownerUserId: t.owner.userId,
        cycle: "MONTHLY",
        gb: 10,
      });
      await seedAddon({ ownerUserId: t.owner.userId, cycle: "MONTHLY", gb: 10 });

      expect((await capacityOf(t.owner.userId)).recurring).toBe(BigInt(20) * GB);

      // Cancelling ONE removes only its own capacity.
      await prisma.workspaceStorageAddon.update({
        where: { id: first.id },
        data: { status: "CANCELED" },
      });
      expect((await capacityOf(t.owner.userId)).recurring).toBe(BigInt(10) * GB);
    });

    it("a PAST_DUE add-on keeps contributing; a terminal one does not", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const addon = await seedAddon({
        ownerUserId: t.owner.userId,
        cycle: "MONTHLY",
        gb: 10,
        status: "PAST_DUE",
      });
      // Grace is the canonical lifecycle's, not a new duration invented here:
      // PAST_DUE still counts, which is what keeps a failed renewal from
      // instantly putting a customer over cap.
      expect((await capacityOf(t.owner.userId)).recurring).toBe(BigInt(10) * GB);

      await prisma.workspaceStorageAddon.update({
        where: { id: addon.id },
        data: { status: "CANCELED" },
      });
      expect((await capacityOf(t.owner.userId)).recurring).toBe(0n);
    });

    it("losing recurring capacity deletes no Evidence and keeps legacy capacity", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      const recurring = await seedAddon({
        ownerUserId: t.owner.userId,
        cycle: "MONTHLY",
        gb: 10,
      });
      await seedAddon({ ownerUserId: t.owner.userId, cycle: "ONE_TIME", gb: 5 });

      const evidence = await prisma.evidence.create({
        data: {
          ownerUserId: t.owner.userId,
          teamId: t.personalTeamId,
          organizationId: t.personalOrganizationId,
          type: "PHOTO",
          sizeBytes: BigInt(1024),
        },
        select: { id: true },
      });

      // PAYPAL, because only an IMMEDIATE provider cancellation is terminal.
      // A Stripe add-on is scheduled for period end and legitimately KEEPS its
      // capacity until then — the customer paid for this month.
      await prisma.workspaceStorageAddon.update({
        where: { id: recurring.id },
        data: { paymentProvider: "PAYPAL" },
      });
      // Record the obligation the way a base cancellation does, then attempt
      // it — the cascade acts on durable obligations now, not on discovery.
      const { recordDependentCancellationObligations } = await import(
        "../src/services/billing/dependent-cancellation.service.js"
      );
      await recordDependentCancellationObligations(
        {
          ownerUserId: t.owner.userId,
          teamId: null,
          triggeredBySubscriptionId: randomUUID(),
        },
        prisma,
      );
      const { fn } = acceptingCanceller();
      await cascade({
        ownerUserId: t.owner.userId,
        teamId: null,
        mode: "IMMEDIATE",
        cancelAtProvider: fn,
      });

      const capacity = await capacityOf(t.owner.userId);
      // The recurring capacity is gone …
      expect(capacity.recurring).toBe(0n);
      // … the LEGACY capacity is untouched …
      expect(capacity.legacy).toBe(BigInt(5) * GB);
      // … and the Evidence is exactly where it was. Capacity loss never
      // deletes a record; it bounds what may be ADDED.
      const still = await prisma.evidence.findUnique({
        where: { id: evidence.id },
        select: { id: true, deletedAt: true, lifecycleState: true },
      });
      expect(still?.id).toBe(evidence.id);
      expect(still?.deletedAt).toBeNull();
      expect(still?.lifecycleState).not.toBe("DESTROYED");
      void recurring;
    });
  });
});
