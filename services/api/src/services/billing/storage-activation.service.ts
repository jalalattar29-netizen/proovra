/**
 * BILLING PAYPAL INTEGRITY (2026-09-28) — THE storage activation decision.
 *
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * A provider-activated storage subscription reached the database four ways —
 * the PayPal webhook, the PayPal return confirmation, the per-attempt re-check
 * and the account re-check / hourly sweep — and they disagreed. The first two
 * refused an activation whose plan id or scope did not check out and wrote
 * NOTHING, leaving a PENDING row PayPal was billing every month; the last two
 * granted the same row with no check at all. What a customer got depended on
 * which path ran first.
 *
 * THE RULE
 * ---------------------------------------------------------------------------
 * Every path hands its provider observation to `applyStorageSubscriptionObservation`.
 * A never-activated add-on becomes ACTIVE only when ALL hold:
 *
 *   * the provider object names the same payer, SKU and attempt as the row;
 *   * the row is personal (a workspace is not a self-service storage subject);
 *   * PayPal bills the plan configured for this SKU in the row's currency (or
 *     the exact plan id recorded when the checkout was created) — the plan's
 *     price was verified against the catalogue at creation;
 *   * the account may hold the SKU on its current plan.
 *
 * A provider-ACTIVE subscription that fails any of these is not left pending:
 * PROOVRA asks the provider to cancel it, marks the add-on FAILED (nothing
 * granted), keeps a durable cancellation obligation if the provider did not
 * confirm, and records a billing review item — the first period was charged.
 * An add-on that was already granted is kept in step with its provider state
 * without re-deciding eligibility (a plan-id rotation must not revoke storage
 * a customer is paying for).
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { getStorageAddonDefinition, upsertWorkspaceStorageAddon } from "../billing.service.js";
import { recordBillingReviewItem } from "./billing-review.service.js";
import { findLivePersonalBaseSubscription } from "./base-subscription.service.js";
import { resolveCommercialContext } from "./commercial-context.service.js";
import {
  cancelStorageAddonAtProvider,
  type StorageAddonProviderCanceller,
} from "./storage-addon-cancellation.service.js";
import {
  storageAddonEligibleForPlan,
  storageAddonFreeEligible,
  storageAddonRequiresPaidPlan,
} from "./storage-addon-rules.js";
import { storageAddonStatusFromSubscription } from "./subscription-lifecycle.handlers.js";
import { UNGRANTABLE_PROVIDER_ACTIVE } from "./dependent-cancellation.service.js";
import { cancelSupersededSubscriptionAtProvider } from "./base-subscription-supersession.service.js";

export type StorageObservation = {
  provider: prismaPkg.PaymentProvider;
  subscriptionId: string;
  /** Canonical status of the provider subscription. */
  status: prismaPkg.SubscriptionStatus;
  /** PayPal: the billed plan id. Stripe: null (price verified at checkout). */
  planId: string | null;
  /**
   * Who and what the PROVIDER object names (PayPal custom_id, Stripe
   * metadata). Null when the observation carries none (a reconciliation read
   * of a row PROOVRA itself bound) — then the row's own identity is used.
   */
  claimed: {
    userId: string;
    teamId: string | null;
    addonKey: prismaPkg.StorageAddonKey;
    attemptId?: string | null;
  } | null;
  currentPeriodEnd: Date | null;
  observedAtUtc: Date | null;
  source: string;
  /** Provider payment id when the observation is a completed checkout. */
  externalPaymentId?: string | null;
};

export type StorageActivationResult =
  | { outcome: "GRANTED" | "UPDATED" | "UNCHANGED"; addonId: string; status: prismaPkg.WorkspaceStorageAddonStatus }
  | {
      outcome: "REFUSED";
      addonId: string | null;
      reason: StorageRefusalReason;
      canceledAtProvider: boolean;
    }
  | { outcome: "IGNORED"; reason: "NO_LOCAL_RECORD" | "IDENTITY_MISMATCH" };

export type StorageRefusalReason =
  | "WORKSPACE_STORAGE_NOT_SUPPORTED"
  | "PLAN_ID_MISMATCH"
  | "NOT_ELIGIBLE_FOR_PLAN"
  | "NO_LOCAL_RECORD";

function obj(value: prismaPkg.Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The PayPal plan ids this SKU may legitimately be billed on, for a row. */
function acceptablePayPalPlanIds(row: {
  addonKey: prismaPkg.StorageAddonKey;
  currency: string | null;
  metadata: prismaPkg.Prisma.JsonValue | null;
}): string[] {
  const ids: string[] = [];
  const recorded = obj(row.metadata).providerPlanId;
  if (typeof recorded === "string" && recorded.trim()) ids.push(recorded.trim());
  const currency = row.currency === "USD" ? "USD" : row.currency === "EUR" ? "EUR" : null;
  const currencies = currency ? [currency] : (["USD", "EUR"] as const);
  for (const c of currencies) {
    const configured = process.env[`PAYPAL_PLAN_STORAGE_${row.addonKey}_${c}`]?.trim();
    if (configured) ids.push(configured);
  }
  return ids;
}

type AddonRow = NonNullable<Awaited<ReturnType<typeof findRow>>>;

async function findRow(obs: StorageObservation) {
  const attemptId = obs.claimed?.attemptId ?? null;
  const byAttempt = attemptId
    ? await prisma.workspaceStorageAddon.findUnique({ where: { id: attemptId } })
    : null;
  if (byAttempt) return byAttempt;
  return prisma.workspaceStorageAddon.findUnique({
    where: { externalSubscriptionId: obs.subscriptionId },
  });
}

async function refusalReason(row: AddonRow, obs: StorageObservation): Promise<StorageRefusalReason | null> {
  if (row.teamId !== null) return "WORKSPACE_STORAGE_NOT_SUPPORTED";
  if (obs.provider === prismaPkg.PaymentProvider.PAYPAL) {
    const accepted = acceptablePayPalPlanIds(row);
    if (!obs.planId || !accepted.includes(obs.planId)) return "PLAN_ID_MISMATCH";
  }
  if (storageAddonFreeEligible(row.addonKey)) return null;
  const scope = (
    await resolveCommercialContext({ type: "PERSONAL_ACCOUNT", userId: row.ownerUserId })
  ).scope;
  return storageAddonEligibleForPlan(scope.plan, row.addonKey) ? null : "NOT_ELIGIBLE_FOR_PLAN";
}

/**
 * Stop an ungrantable provider-active storage subscription and record why.
 * Never throws for a provider failure: the obligation stays durable and the
 * retry worker keeps asking.
 */
async function refuseActiveSubscription(input: {
  row: AddonRow | null;
  obs: StorageObservation;
  ownerUserId: string;
  addonKey: prismaPkg.StorageAddonKey;
  reason: StorageRefusalReason;
  cancelAtProvider?: StorageAddonProviderCanceller;
}): Promise<{ canceledAtProvider: boolean; addonId: string | null }> {
  // Stopped NOW, not at period end: nothing was granted for this period.
  // PayPal's cancel is immediate; Stripe's subscription is deleted.
  const canceledAtProvider = input.cancelAtProvider
    ? (
        await input.cancelAtProvider({
          provider: input.obs.provider,
          providerRef: input.obs.subscriptionId,
          mode: "IMMEDIATE",
        })
      ).ok
    : input.obs.provider === prismaPkg.PaymentProvider.STRIPE
      ? (await cancelSupersededSubscriptionAtProvider(input.obs.provider, input.obs.subscriptionId))
          .canceled
      : (
          await cancelStorageAddonAtProvider({
            provider: input.obs.provider,
            providerRef: input.obs.subscriptionId,
            reason: "Storage add-on could not be activated for this account",
          })
        ).ok;
  const now = new Date();
  let addonId = input.row?.id ?? null;
  const refusal = {
    activationRefused: input.reason,
    activationRefusedAtUtc: now.toISOString(),
    source: input.obs.source,
  };
  const obligation = canceledAtProvider
    ? {
        dependentCancellationState: prismaPkg.DependentCancellationState.CONFIRMED,
        dependentCancellationConfirmedAtUtc: now,
        canceledAtUtc: now,
      }
    : {
        dependentCancellationState: prismaPkg.DependentCancellationState.PENDING,
        dependentCancellationRequestedAtUtc: now,
        dependentCancellationNextRetryAtUtc: now,
      };
  if (input.row) {
    await prisma.workspaceStorageAddon.update({
      where: { id: input.row.id },
      data: {
        status: prismaPkg.WorkspaceStorageAddonStatus.FAILED,
        externalSubscriptionId: input.row.externalSubscriptionId ?? input.obs.subscriptionId,
        paymentProvider: input.row.paymentProvider ?? input.obs.provider,
        dependentCancellationReasonCode: UNGRANTABLE_PROVIDER_ACTIVE,
        ...obligation,
        metadata: { ...obj(input.row.metadata), ...refusal } as prismaPkg.Prisma.InputJsonObject,
      },
    });
  } else {
    // A provider-active subscription with NO local record (its workspace row
    // was deleted, or it was never recorded). The record is created now, so
    // the only trace of a live provider obligation is never lost again.
    const created = await prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId: input.ownerUserId,
        teamId: null,
        addonKey: input.addonKey,
        extraStorageBytes: getStorageAddonDefinition(input.addonKey).storageBytes,
        billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
        status: prismaPkg.WorkspaceStorageAddonStatus.FAILED,
        paymentProvider: input.obs.provider,
        externalSubscriptionId: input.obs.subscriptionId,
        dependentCancellationReasonCode: UNGRANTABLE_PROVIDER_ACTIVE,
        ...obligation,
        metadata: {
          ...refusal,
          claimedTeamId: input.obs.claimed?.teamId ?? null,
        } as prismaPkg.Prisma.InputJsonObject,
      },
    });
    addonId = created.id;
  }
  await recordBillingReviewItem({
    userId: input.ownerUserId,
    provider: input.obs.provider,
    providerResourceId: input.obs.subscriptionId,
    product: "STORAGE_ADDON",
    reason: input.row ? "STORAGE_ACTIVATION_REFUSED" : "STORAGE_SUBSCRIPTION_WITHOUT_RECORD",
    providerAction: canceledAtProvider ? "CANCELED_AT_PROVIDER" : "CANCEL_FAILED",
    refundReviewRequired: true,
    detail: { refusal: input.reason, addonKey: input.addonKey, addonId },
  });
  return { canceledAtProvider, addonId };
}

/**
 * Apply ONE provider observation of a recurring storage subscription.
 * The only writer through which a storage subscription becomes capacity.
 */
export async function applyStorageSubscriptionObservation(
  obs: StorageObservation,
  deps: { cancelAtProvider?: StorageAddonProviderCanceller } = {},
): Promise<StorageActivationResult> {
  let row = await findRow(obs);

  if (!row && obs.provider === prismaPkg.PaymentProvider.STRIPE && obs.claimed) {
    // Stripe storage checkouts keep their attempt in billing_checkout_attempts
    // and have no add-on row until the provider reports the subscription. The
    // record is created (PENDING, grants nothing) so the SAME decision below
    // applies to it; a concurrent writer that created it first wins.
    await prisma.workspaceStorageAddon
      .create({
        data: {
          ownerUserId: obs.claimed.userId,
          teamId: obs.claimed.teamId ?? null,
          addonKey: obs.claimed.addonKey,
          extraStorageBytes: getStorageAddonDefinition(obs.claimed.addonKey).storageBytes,
          billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
          status: prismaPkg.WorkspaceStorageAddonStatus.PENDING,
          paymentProvider: obs.provider,
          externalSubscriptionId: obs.subscriptionId,
          ...(obs.externalPaymentId ? { externalPaymentId: obs.externalPaymentId } : {}),
          metadata: { source: obs.source } as prismaPkg.Prisma.InputJsonObject,
        },
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code !== "P2002") throw err;
      });
    row = await findRow(obs);
  }

  if (!row) {
    if (obs.status === prismaPkg.SubscriptionStatus.ACTIVE && obs.claimed) {
      const refused = await refuseActiveSubscription({
        row: null,
        obs,
        ownerUserId: obs.claimed.userId,
        addonKey: obs.claimed.addonKey,
        reason: "NO_LOCAL_RECORD",
        cancelAtProvider: deps.cancelAtProvider,
      });
      return { outcome: "REFUSED", addonId: refused.addonId, reason: "NO_LOCAL_RECORD", canceledAtProvider: refused.canceledAtProvider };
    }
    return { outcome: "IGNORED", reason: "NO_LOCAL_RECORD" };
  }

  // Identity: the provider object must name what the row is.
  if (
    obs.claimed &&
    (obs.claimed.userId !== row.ownerUserId ||
      obs.claimed.addonKey !== row.addonKey ||
      (obs.claimed.teamId ?? null) !== (row.teamId ?? null))
  ) {
    return { outcome: "IGNORED", reason: "IDENTITY_MISMATCH" };
  }
  if (row.externalSubscriptionId && row.externalSubscriptionId !== obs.subscriptionId) {
    return { outcome: "IGNORED", reason: "IDENTITY_MISMATCH" };
  }

  // A refused activation stays refused. Its cancellation obligation is the
  // retry worker's; a later CANCELLED observation confirms it.
  if (obj(row.metadata).activationRefused) {
    if (obs.status === prismaPkg.SubscriptionStatus.CANCELED && row.dependentCancellationState !== prismaPkg.DependentCancellationState.CONFIRMED) {
      await prisma.workspaceStorageAddon.update({
        where: { id: row.id },
        data: {
          dependentCancellationState: prismaPkg.DependentCancellationState.CONFIRMED,
          dependentCancellationConfirmedAtUtc: obs.observedAtUtc ?? new Date(),
          canceledAtUtc: row.canceledAtUtc ?? obs.observedAtUtc ?? new Date(),
        },
      });
      return { outcome: "UPDATED", addonId: row.id, status: row.status };
    }
    return { outcome: "UNCHANGED", addonId: row.id, status: row.status };
  }

  const firstActivation =
    obs.status === prismaPkg.SubscriptionStatus.ACTIVE && !row.activatedAtUtc;

  let dependsOnSubscriptionId: string | null | undefined;
  if (firstActivation) {
    const refusal = await refusalReason(row, obs);
    if (refusal) {
      const refused = await refuseActiveSubscription({
        row,
        obs,
        ownerUserId: row.ownerUserId,
        addonKey: row.addonKey,
        reason: refusal,
        cancelAtProvider: deps.cancelAtProvider,
      });
      return { outcome: "REFUSED", addonId: row.id, reason: refusal, canceledAtProvider: refused.canceledAtProvider };
    }
    dependsOnSubscriptionId = storageAddonRequiresPaidPlan(row.addonKey)
      ? ((await findLivePersonalBaseSubscription(row.ownerUserId))?.id ?? null)
      : null;
  }

  const before = row.status;
  const updated = await upsertWorkspaceStorageAddon({
    attemptId: row.id,
    ownerUserId: row.ownerUserId,
    teamId: row.teamId,
    addonKey: row.addonKey,
    billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
    status: storageAddonStatusFromSubscription(obs.status),
    paymentProvider: obs.provider,
    externalSubscriptionId: obs.subscriptionId,
    externalPaymentId: obs.externalPaymentId ?? null,
    currentPeriodEnd: obs.currentPeriodEnd,
    observedAtUtc: obs.observedAtUtc,
    metadata: { source: obs.source },
    ...(dependsOnSubscriptionId !== undefined ? { dependsOnSubscriptionId } : {}),
  });
  if (firstActivation && updated.status === prismaPkg.WorkspaceStorageAddonStatus.ACTIVE) {
    return { outcome: "GRANTED", addonId: updated.id, status: updated.status };
  }
  return {
    outcome: updated.status !== before ? "UPDATED" : "UNCHANGED",
    addonId: updated.id,
    status: updated.status,
  };
}
