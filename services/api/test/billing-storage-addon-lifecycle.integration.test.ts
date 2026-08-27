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
import type { DependentAddonCanceller } from "../src/services/billing/storage-addon-dependency.service.js";

const GB = BigInt(1024) ** BigInt(3);

describe("BILLING — recurring storage add-on lifecycle (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let cascade: typeof import("../src/services/billing/storage-addon-dependency.service.js")["cancelDependentRecurringAddons"];

  /** Every provider call succeeds, and records what it was asked to do. */
  const acceptingCanceller = () => {
    const calls: Array<{ providerRef: string; mode: string }> = [];
    const fn: DependentAddonCanceller = async ({ providerRef, mode }) => {
      calls.push({ providerRef, mode });
    };
    return { fn, calls };
  };

  /** The provider refuses. Nothing local may move. */
  const refusingCanceller: DependentAddonCanceller = async () => {
    throw new Error("provider refused");
  };

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
  it("a Stripe period-end base cancellation schedules its dependants for the same end", async () => {
    const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
    const addon = await seedAddon({
      ownerUserId: t.owner.userId,
      cycle: "MONTHLY",
      gb: 10,
    });

    const { fn, calls } = acceptingCanceller();
    const result = await cascade({
      ownerUserId: t.owner.userId,
      teamId: null,
      mode: "PERIOD_END",
      cancelAtProvider: fn,
    });

    expect(result.found).toBe(1);
    expect(result.scheduled).toBe(1);
    expect(result.failed).toBe(0);
    expect(calls).toEqual([
      { providerRef: addon.externalSubscriptionId, mode: "PERIOD_END" },
    ]);

    const after = await prisma.workspaceStorageAddon.findUniqueOrThrow({
      where: { id: addon.id },
      select: { status: true, canceledAtUtc: true },
    });
    // Scheduled, not terminated: the customer keeps the storage they paid for
    // until the provider's own terminal event arrives.
    expect(after.status).toBe("ACTIVE");
    expect(after.canceledAtUtc).not.toBeNull();
  });

  it("a PayPal immediate base cancellation ends its dependants now", async () => {
    const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
    const addon = await seedAddon({
      ownerUserId: t.owner.userId,
      cycle: "MONTHLY",
      gb: 10,
    });

    const { fn, calls } = acceptingCanceller();
    const result = await cascade({
      ownerUserId: t.owner.userId,
      teamId: null,
      mode: "IMMEDIATE",
      cancelAtProvider: fn,
    });

    expect(result.scheduled).toBe(1);
    expect(calls[0]?.mode).toBe("IMMEDIATE");
    const after = await prisma.workspaceStorageAddon.findUniqueOrThrow({
      where: { id: addon.id },
      select: { status: true },
    });
    expect(after.status).toBe("CANCELED");
  });

  it("a REFUSED provider cancellation writes nothing and reports failure", async () => {
    const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
    const addon = await seedAddon({
      ownerUserId: t.owner.userId,
      cycle: "MONTHLY",
      gb: 10,
    });

    const result = await cascade({
      ownerUserId: t.owner.userId,
      teamId: null,
      mode: "PERIOD_END",
      cancelAtProvider: refusingCanceller,
    });

    expect(result.found).toBe(1);
    expect(result.scheduled).toBe(0);
    expect(result.failed).toBe(1);

    // THE POINT. The add-on is untouched, so it is still visible as active and
    // still known to be charging — rather than marked cancelled and forgotten.
    const after = await prisma.workspaceStorageAddon.findUniqueOrThrow({
      where: { id: addon.id },
      select: { status: true, canceledAtUtc: true },
    });
    expect(after.status).toBe("ACTIVE");
    expect(after.canceledAtUtc).toBeNull();
  });

  it("repeating the cascade is safe and clears a previous failure", async () => {
    const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
    const addon = await seedAddon({
      ownerUserId: t.owner.userId,
      cycle: "MONTHLY",
      gb: 10,
    });

    const first = await cascade({
      ownerUserId: t.owner.userId,
      teamId: null,
      mode: "IMMEDIATE",
      cancelAtProvider: refusingCanceller,
    });
    expect(first.failed).toBe(1);

    const { fn } = acceptingCanceller();
    const second = await cascade({
      ownerUserId: t.owner.userId,
      teamId: null,
      mode: "IMMEDIATE",
      cancelAtProvider: fn,
    });
    expect(second.scheduled).toBe(1);

    const after = await prisma.workspaceStorageAddon.findUniqueOrThrow({
      where: { id: addon.id },
      select: { status: true },
    });
    expect(after.status).toBe("CANCELED");

    // A third pass finds nothing: a terminal add-on is no longer a dependant.
    const third = await cascade({
      ownerUserId: t.owner.userId,
      teamId: null,
      mode: "IMMEDIATE",
      cancelAtProvider: fn,
    });
    expect(third.found).toBe(0);
  });

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
