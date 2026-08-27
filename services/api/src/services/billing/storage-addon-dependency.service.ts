/**
 * BILLING RECONCILIATION (2026-08-27) — the Storage add-on dependency contract.
 *
 * THE RISK THIS CLOSES
 * ---------------------------------------------------------------------------
 * A recurring Storage add-on is its OWN provider subscription, separate from
 * the PRO or TEAM subscription it depends on. Cancelling the base plan
 * therefore did nothing to the add-on: the provider kept charging for storage
 * attached to an account that no longer had the plan the storage extends. The
 * customer sees a cancelled subscription and a monthly charge they cannot
 * explain, and nothing in the product knows the two are related.
 *
 * THE CONTRACT
 * ---------------------------------------------------------------------------
 *   * A recurring PERSONAL add-on depends on the PRO personal subscription.
 *   * A recurring WORKSPACE add-on depends on that workspace's TEAM
 *     subscription.
 *   * Enterprise is contract-managed and has no self-service add-on to cascade.
 *   * A LEGACY one-time entitlement is not a provider subscription. It is
 *     never cancelled, never charged again, and is deliberately invisible to
 *     everything here.
 *
 * PROVIDER FIRST, ALWAYS
 * ---------------------------------------------------------------------------
 * Nothing local is written for an add-on the provider did not confirm. A
 * failure produces ACTION_REQUIRED and leaves the add-on exactly as it was —
 * because the alternative, marking it cancelled locally, is precisely how a
 * silently charging orphan becomes invisible. The customer is told the truth:
 * the base plan is cancelled, one add-on is not, and it needs attention.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { stripeRequest, stripeRequestRaw } from "../stripe.service.js";
import { cancelPayPalSubscription } from "../paypal.service.js";

/**
 * The provider call, injectable.
 *
 * Production passes nothing and gets the real Stripe and PayPal clients. The
 * contract suites pass a deterministic function, so every rule below — provider
 * first, no local write without confirmation, ACTION_REQUIRED on failure — is
 * proven against a real database without a credential or a socket.
 *
 * It resolves to nothing on success and THROWS on failure, which is the same
 * shape the real clients have; a canceller that returned a boolean would invite
 * a caller to ignore it.
 */
export type DependentAddonCanceller = (input: {
  provider: prismaPkg.PaymentProvider;
  providerRef: string;
  mode: "PERIOD_END" | "IMMEDIATE";
}) => Promise<void>;

/** What happened to the dependent add-ons of one base cancellation. */
export type DependentCancellationResult = {
  /** Add-ons found depending on the cancelled base subscription. */
  found: number;
  /** Add-ons the provider confirmed will stop. */
  scheduled: number;
  /**
   * Add-ons the provider did NOT confirm. Non-zero means the caller must
   * report ACTION_REQUIRED: something is still charging.
   */
  failed: number;
};

/**
 * The recurring add-ons that depend on one base billing subject.
 *
 * A personal subject owns its `teamId: null` add-ons; a workspace owns its own.
 * `billingCycle: MONTHLY` and a non-null `externalSubscriptionId` together are
 * what make an add-on a provider subscription — a legacy one-time row has
 * neither and is never returned.
 */
export async function findDependentRecurringAddons(input: {
  ownerUserId: string;
  teamId: string | null;
}) {
  return prisma.workspaceStorageAddon.findMany({
    where: {
      ...(input.teamId
        ? { teamId: input.teamId }
        : { ownerUserId: input.ownerUserId, teamId: null }),
      billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
      externalSubscriptionId: { not: null },
      status: {
        in: [
          prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
          prismaPkg.WorkspaceStorageAddonStatus.PENDING,
          prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE,
        ],
      },
    },
    select: {
      id: true,
      paymentProvider: true,
      externalSubscriptionId: true,
      status: true,
    },
  });
}

/**
 * The production canceller.
 *
 * Stripe distinguishes the two modes at the API level: a period-end
 * cancellation is a flag on the subscription, an immediate one is a DELETE. A
 * flag that comes back false means the call succeeded and the provider did NOT
 * agree to what was asked, which must be a failure — recording a cancellation
 * the provider did not make is the whole defect class.
 *
 * PayPal has one cancel and it is immediate, which is why the mode never
 * reaches it.
 */
// A FUNCTION DECLARATION, and called directly below rather than through a
// `?? defaultCanceller` variable. The call-graph authority resolves direct
// calls; an indirection through a local const made the Stripe write inside it
// look like a terminal writer with no entrypoint, which is the same signature
// as genuinely dead code. Keeping it directly callable keeps the map honest.
async function cancelAtProviderDirectly({
  provider,
  providerRef,
  mode,
}: Parameters<DependentAddonCanceller>[0]): Promise<void> {
  if (provider === prismaPkg.PaymentProvider.STRIPE) {
    if (mode === "IMMEDIATE") {
      await stripeRequestRaw(`/subscriptions/${providerRef}`, "DELETE");
      return;
    }
    const body = new URLSearchParams();
    body.append("cancel_at_period_end", "true");
    const response = await stripeRequest(`/subscriptions/${providerRef}`, body);
    if (response["cancel_at_period_end"] !== true) {
      throw new Error("Stripe did not confirm the scheduled cancellation");
    }
    return;
  }
  await cancelPayPalSubscription(providerRef, "Base subscription canceled");
}

/**
 * Cancel every recurring add-on that depends on a base subscription now ending.
 *
 * `mode` follows the base cancellation, because an add-on that outlives its
 * plan by a month is the same defect in miniature:
 *
 *   PERIOD_END  Stripe — the add-on is flagged to stop renewing, and the
 *               customer keeps the storage they already paid for.
 *   IMMEDIATE   PayPal — the agreement ends now, because PayPal offers nothing
 *               else and promising a period end we cannot deliver is the
 *               defect the cancellation service exists to prevent.
 *
 * The local row is marked CANCELED only where the provider confirmed. The
 * terminal transition still arrives by webhook; this records the requested,
 * confirmed intent so the projection can stop counting the capacity.
 */
export async function cancelDependentRecurringAddons(input: {
  ownerUserId: string;
  teamId: string | null;
  mode: "PERIOD_END" | "IMMEDIATE";
  /** Injected by contract tests; production uses the real clients. */
  cancelAtProvider?: DependentAddonCanceller;
}): Promise<DependentCancellationResult> {
  const addons = await findDependentRecurringAddons({
    ownerUserId: input.ownerUserId,
    teamId: input.teamId,
  });

  const result: DependentCancellationResult = {
    found: addons.length,
    scheduled: 0,
    failed: 0,
  };

  for (const addon of addons) {
    const provider = addon.paymentProvider;
    const ref = addon.externalSubscriptionId;
    if (!provider || !ref) {
      // A recurring row with no binding cannot be cancelled remotely and must
      // not be reported as cancelled. It needs a person.
      result.failed += 1;
      continue;
    }

    try {
      if (input.cancelAtProvider) {
        await input.cancelAtProvider({
          provider,
          providerRef: ref,
          mode: input.mode,
        });
      } else {
        await cancelAtProviderDirectly({
          provider,
          providerRef: ref,
          mode: input.mode,
        });
      }
    } catch {
      // NO local write. The add-on stays exactly as it was, and the caller
      // reports ACTION_REQUIRED rather than claiming a clean cancellation.
      result.failed += 1;
      continue;
    }

    await prisma.workspaceStorageAddon.update({
      where: { id: addon.id },
      data: {
        // PERIOD_END keeps the capacity the customer paid for until the
        // provider's own terminal event; IMMEDIATE ends it now, which is what
        // PayPal actually did.
        status:
          input.mode === "IMMEDIATE"
            ? prismaPkg.WorkspaceStorageAddonStatus.CANCELED
            : addon.status,
        canceledAtUtc: new Date(),
      },
    });
    result.scheduled += 1;
  }

  return result;
}
