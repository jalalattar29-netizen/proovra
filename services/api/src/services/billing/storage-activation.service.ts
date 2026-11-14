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
import { keepPaidPeriodAfterProviderCancel } from "./paid-period.service.js";
import { findLivePersonalBaseSubscription } from "./base-subscription.service.js";
import { resolveCommercialContext } from "./commercial-context.service.js";
import {
  cancelStorageAddonAtProvider,
  type StorageAddonProviderCanceller,
} from "./storage-addon-cancellation.service.js";
import { readActiveInternalPlanGrant } from "@proovra/shared-runtime";
import {
  storageAddonEligibleForPlan,
  storageAddonFreeEligible,
  storageAddonRequiresPaidPlan,
} from "./storage-addon-rules.js";
import { storageAddonStatusFromSubscription } from "./subscription-lifecycle.handlers.js";
import { UNGRANTABLE_PROVIDER_ACTIVE } from "./dependent-cancellation.service.js";
import { cancelSupersededSubscriptionAtProvider } from "./base-subscription-supersession.service.js";
import { personalStorageCheckoutLockKey } from "./checkout-attempts.service.js";
import { payerLegacyWorkspaceIds } from "./billing-accounts.service.js";
import { automaticAddonCancellationEnabled } from "./automatic-effects.js";

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
  /**
   * Stripe only: the `billing_checkout_attempts` id the session or subscription
   * metadata names. It dates the purchase for the duplicate rule; it never
   * identifies the add-on row (PayPal's row IS its attempt).
   */
  checkoutAttemptId?: string | null;
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
  | "NO_LOCAL_RECORD"
  /** Another add-on of this size went live after this purchase was started. */
  | "DUPLICATE_PURCHASE";

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
    reason:
      input.reason === "DUPLICATE_PURCHASE"
        ? "DUPLICATE_STORAGE_PURCHASE"
        : input.row
          ? "STORAGE_ACTIVATION_REFUSED"
          : "STORAGE_SUBSCRIPTION_WITHOUT_RECORD",
    providerAction: canceledAtProvider ? "CANCELED_AT_PROVIDER" : "CANCEL_FAILED",
    refundReviewRequired: true,
    detail: { refusal: input.reason, addonKey: input.addonKey, addonId },
  });
  return { canceledAtProvider, addonId };
}

const LIVE_ADDON: prismaPkg.WorkspaceStorageAddonStatus[] = [
  prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
  prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE,
];
/** A first-activation decision older than this no longer stands in for a live add-on. */
const ACTIVATION_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

function claimedAt(metadata: prismaPkg.Prisma.JsonValue | null | undefined): Date | null {
  const raw = obj(metadata).activationClaimedAtUtc;
  if (typeof raw !== "string") return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * When the customer STARTED the purchase this row settles. PayPal: the row is the
 * attempt. Stripe: the checkout attempt its metadata (or its session) names.
 * Null when nothing dates it (a session from before attempts existed).
 */
async function purchaseStartedAt(
  tx: prismaPkg.Prisma.TransactionClient,
  row: AddonRow,
  obs: StorageObservation,
): Promise<Date | null> {
  if (obs.provider === prismaPkg.PaymentProvider.PAYPAL) return row.createdAt;
  const where = {
    userId: row.ownerUserId,
    product: prismaPkg.BillingCheckoutProduct.STORAGE_ADDON,
    provider: prismaPkg.PaymentProvider.STRIPE,
    storageAddonKey: row.addonKey,
  };
  const byId = obs.checkoutAttemptId
    ? await tx.billingCheckoutAttempt.findFirst({
        where: { ...where, id: obs.checkoutAttemptId },
        select: { createdAt: true },
      })
    : null;
  if (byId) return byId.createdAt;
  const sessionId = obs.externalPaymentId ?? row.externalPaymentId ?? null;
  const bySession = sessionId
    ? await tx.billingCheckoutAttempt.findFirst({
        where: { ...where, providerResourceId: sessionId },
        select: { createdAt: true },
      })
    : null;
  return bySession?.createdAt ?? null;
}

/**
 * FREE-AUDIT REMEDIATION (2026-11-13, DUP-STORAGE) — the settlement half of the
 * duplicate rule. Stacking a size is allowed, but only knowingly: checkout refuses
 * a second purchase of a size the customer holds unless they confirm it. A purchase
 * started BEFORE another add-on of the same size went live was therefore never a
 * decision to hold two (two tabs, an old approval link, an abandoned checkout paid
 * later). Its activation is not granted.
 *
 * Under the payer's storage lock: count the same-size add-ons that went live (or
 * were decided and are being written) after this purchase started; if none, record
 * this row's own decision so a concurrent activation sees it. True = duplicate. A
 * purchase nothing can date keeps the previous behaviour. Needs no schema change:
 * the decision is a stamp in the row's metadata, read under the lock.
 */
async function isDuplicateActivation(row: AddonRow, obs: StorageObservation): Promise<boolean> {
  if (row.teamId !== null) return false;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${personalStorageCheckoutLockKey(row.ownerUserId)}))
    `;
    const fresh = await tx.workspaceStorageAddon.findUnique({
      where: { id: row.id },
      select: { metadata: true },
    });
    // This row was already decided (a redelivery, or the return racing the webhook).
    if (claimedAt(fresh?.metadata)) return false;
    const startedAt = await purchaseStartedAt(tx, row, obs);
    if (startedAt) {
      const legacy = await payerLegacyWorkspaceIds(row.ownerUserId, tx);
      const now = Date.now();
      const others = await tx.workspaceStorageAddon.findMany({
        where: {
          ownerUserId: row.ownerUserId,
          addonKey: row.addonKey,
          id: { not: row.id },
          status: { in: [...LIVE_ADDON, prismaPkg.WorkspaceStorageAddonStatus.PENDING] },
          OR: [{ teamId: null }, { teamId: { in: legacy } }],
        },
        select: { status: true, activatedAtUtc: true, metadata: true },
      });
      const wentLiveSince = others.filter((o) => {
        if (LIVE_ADDON.includes(o.status)) {
          return o.activatedAtUtc !== null && o.activatedAtUtc.getTime() > startedAt.getTime();
        }
        const claim = claimedAt(o.metadata);
        return (
          claim !== null &&
          claim.getTime() > startedAt.getTime() &&
          now - claim.getTime() < ACTIVATION_CLAIM_TTL_MS
        );
      });
      if (wentLiveSince.length > 0) return true;
    }
    await tx.workspaceStorageAddon.update({
      where: { id: row.id },
      data: {
        metadata: {
          ...obj(fresh?.metadata),
          activationClaimedAtUtc: new Date().toISOString(),
        } as prismaPkg.Prisma.InputJsonObject,
      },
    });
    return false;
  });
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
  let dependsOnPlanGrantId: string | null | undefined;
  if (firstActivation) {
    // Refusing stops a subscription NOW and takes its capacity, which is right for
    // a purchase being decided and wrong for storage already in use. A row that is
    // live with no activation stamp predates the stamp: it has nothing to refuse.
    const alreadyLive =
      row.status === prismaPkg.WorkspaceStorageAddonStatus.ACTIVE ||
      row.status === prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE;
    const refusal: StorageRefusalReason | null = alreadyLive
      ? null
      : ((await refusalReason(row, obs)) ??
        ((await isDuplicateActivation(row, obs)) ? "DUPLICATE_PURCHASE" : null));
    if (
      refusal === "DUPLICATE_PURCHASE" &&
      obs.source === "billing_reconciliation" &&
      !automaticAddonCancellationEnabled()
    ) {
      // BILLING ACCEPTANCE hold — the sweep does not stop a subscription at the
      // provider until an operator enables it. Nothing is granted and nothing is
      // cancelled; the review item says what was held and that a refund review is
      // owed. A provider webhook or the customer's own return still applies the
      // refusal in full.
      await recordBillingReviewItem({
        userId: row.ownerUserId,
        provider: obs.provider,
        providerResourceId: obs.subscriptionId,
        product: "STORAGE_ADDON",
        reason: "DUPLICATE_STORAGE_PURCHASE",
        providerAction: "NONE",
        refundReviewRequired: true,
        detail: { addonKey: row.addonKey, addonId: row.id, held: "AUTOMATIC_ADDON_CANCELLATION" },
      });
      return { outcome: "REFUSED", addonId: row.id, reason: refusal, canceledAtProvider: false };
    }
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
    const requiresPlan = storageAddonRequiresPaidPlan(row.addonKey);
    const base = requiresPlan ? await findLivePersonalBaseSubscription(row.ownerUserId) : null;
    dependsOnSubscriptionId = base?.id ?? null;
    // BILLING DECISIONS (2026-10-31, D2) — when the paid plan does not offer this
    // SKU, the grant does. Read from the payer, never from a selected workspace.
    const grant =
      requiresPlan && !(base && storageAddonEligibleForPlan(base.plan, row.addonKey))
        ? await readActiveInternalPlanGrant(prisma, row.ownerUserId)
        : null;
    dependsOnPlanGrantId =
      grant && storageAddonEligibleForPlan(grant.plan as prismaPkg.PlanType, row.addonKey) ? grant.id : null;
  }

  if (
    obs.status === prismaPkg.SubscriptionStatus.CANCELED &&
    (await keepPaidPeriodAfterProviderCancel({ addonId: row.id, observedAtUtc: obs.observedAtUtc }))
  ) {
    return { outcome: "UNCHANGED", addonId: row.id, status: row.status };
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
    ...(dependsOnPlanGrantId !== undefined ? { dependsOnPlanGrantId } : {}),
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
