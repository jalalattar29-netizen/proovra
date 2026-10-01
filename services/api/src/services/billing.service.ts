import { prisma } from "../db.js";
// PHASE 12 REMEDIATION §6.1 (2026-08-06) — the ONE seat-OCCUPANCY authority,
// shared with the worker. The seat-CEILING comparison stays
// `computeOverSeatLimit` in this file — one quantity, one comparison.
import * as prismaPkg from "@prisma/client";
import { writeAnalyticsEvent } from "./analytics-event.service.js";
import {
  decidePaymentTransition,
  observedStateFromPaymentStatus,
} from "./billing/reconciliation/payment-status.js";
import {
  decideSubscriptionStatusWrite,
} from "./billing/subscription-status.js";
// COMMERCIAL CLOSURE (2026-09-08) — the canonical capability table, read by the
// downgrade grandfather below to learn whether the target plan has a lifetime
// record cap at all.
import { getPlanCapabilities } from "@proovra/shared-billing";

const GB = 1024n * 1024n * 1024n;

type StorageAddonDefinition = {
  key: prismaPkg.StorageAddonKey;
  billingShape: "SINGLE_OCCUPANT" | "SHARED";
  storageBytes: bigint;
  priceCents: number;
  currency: string;
  label: string;
};

const STORAGE_ADDON_DEFINITIONS: readonly StorageAddonDefinition[] = [
  {
    key: prismaPkg.StorageAddonKey.PERSONAL_10_GB,
    billingShape: "SINGLE_OCCUPANT",
    storageBytes: 10n * GB,
    priceCents: 299,
    currency: "EUR",
    label: "+10 GB",
  },
  {
    key: prismaPkg.StorageAddonKey.PERSONAL_50_GB,
    billingShape: "SINGLE_OCCUPANT",
    storageBytes: 50n * GB,
    priceCents: 799,
    currency: "EUR",
    label: "+50 GB",
  },
  {
    key: prismaPkg.StorageAddonKey.PERSONAL_200_GB,
    billingShape: "SINGLE_OCCUPANT",
    storageBytes: 200n * GB,
    priceCents: 1999,
    currency: "EUR",
    label: "+200 GB",
  },
  {
    key: prismaPkg.StorageAddonKey.TEAM_100_GB,
    billingShape: "SHARED",
    storageBytes: 100n * GB,
    priceCents: 999,
    currency: "EUR",
    label: "+100 GB",
  },
  {
    key: prismaPkg.StorageAddonKey.TEAM_500_GB,
    billingShape: "SHARED",
    storageBytes: 500n * GB,
    priceCents: 3499,
    currency: "EUR",
    label: "+500 GB",
  },
  {
    key: prismaPkg.StorageAddonKey.TEAM_1_TB,
    billingShape: "SHARED",
    storageBytes: 1024n * GB,
    priceCents: 5999,
    currency: "EUR",
    label: "+1 TB",
  },
] as const;

async function trackBillingEvent(params: {
  eventType: string;
  userId: string;
  teamId?: string | null;
  plan?: prismaPkg.PlanType | null;
  provider?: prismaPkg.PaymentProvider | null;
  paymentStatus?: prismaPkg.PaymentStatus | null;
  subscriptionStatus?: prismaPkg.SubscriptionStatus | null;
  metadata?: Record<string, unknown>;
}) {
  try {
    await writeAnalyticsEvent({
      eventType: params.eventType,
      userId: params.userId,
      entityType: params.teamId ? "team_billing" : "personal_billing",
      entityId: params.teamId ?? params.userId,
      sessionId: `system_${params.eventType}_${params.teamId ?? params.userId}`,
      visitorId: `system_billing_${params.userId}`,
      path: params.teamId ? "/billing/team" : "/billing",
      skipSessionUpsert: true,
      metadata: {
        teamId: params.teamId ?? null,
        plan: params.plan ?? null,
        provider: params.provider ?? null,
        paymentStatus: params.paymentStatus ?? null,
        subscriptionStatus: params.subscriptionStatus ?? null,
        ...(params.metadata ?? {}),
      },
    });
  } catch {
    // analytics must never block billing flows
  }
}

function toNullableJsonInput(
  value: Record<string, unknown> | null | undefined
):
  | prismaPkg.Prisma.NullableJsonNullValueInput
  | prismaPkg.Prisma.InputJsonValue {
  if (value == null) {
    return prismaPkg.Prisma.JsonNull;
  }

  return value as prismaPkg.Prisma.InputJsonValue;
}

export function getStorageAddonDefinition(
  key: prismaPkg.StorageAddonKey
): StorageAddonDefinition {
  const found = STORAGE_ADDON_DEFINITIONS.find((item) => item.key === key);
  if (!found) {
    throw new Error(`Unknown storage addon key: ${String(key)}`);
  }
  return found;
}

export function listStorageAddonDefinitions() {
  return [...STORAGE_ADDON_DEFINITIONS];
}

/**
 * THE writer of a user's initial active entitlement (UC-COM-004).
 *
 * It was check-then-create with no uniqueness, so two concurrent first
 * requests inserted two ACTIVE entitlements and the wallet/plan readers could
 * disagree about which one holds a purchase. The check and the insert now run
 * in ONE transaction under a per-user advisory lock, so concurrent callers
 * serialise and exactly one row is created; the requested partial unique index
 * (entitlements(user_id) WHERE active) is the database backstop, and a unique
 * violation from it is answered with the winner's row.
 */
export async function ensureEntitlement(userId: string) {
  const existing = await prisma.entitlement.findFirst({
    where: { userId, active: true },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;

  const outcome = await prisma
    .$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`entitlement:${userId}`}))`;
      const winner = await tx.entitlement.findFirst({
        where: { userId, active: true },
        orderBy: { createdAt: "desc" },
      });
      if (winner) return { row: winner, created: false };
      const row = await tx.entitlement.create({
        data: {
          userId,
          plan: prismaPkg.PlanType.FREE,
          credits: 0,
          teamSeats: 0,
          active: true,
        },
      });
      return { row, created: true };
    })
    .catch(async (err: unknown) => {
      if ((err as { code?: string }).code !== "P2002") throw err;
      const row = await prisma.entitlement.findFirst({
        where: { userId, active: true },
        orderBy: { createdAt: "desc" },
      });
      if (!row) throw err;
      return { row, created: false };
    });
  if (!outcome.created) return outcome.row;
  const created = outcome.row;

  await trackBillingEvent({
    eventType: "billing_plan_changed",
    userId,
    plan: created.plan,
    metadata: {
      reason: "entitlement_initialized",
      credits: created.credits,
      teamSeats: created.teamSeats,
    },
  });

  return created;
}

export async function getActiveEntitlement(userId: string) {
  return ensureEntitlement(userId);
}

export async function setPersonalPlan(
  userId: string,
  plan: prismaPkg.PlanType
) {
  // ===========================================================================
  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — TEAM IS A PERSONAL PLAN.
  // ===========================================================================
  //
  // This function used to refuse TEAM outright, with the code
  // `TEAM_NOT_ALLOWED_FOR_PERSONAL_WORKSPACE`. That single line was where the
  // obsolete model was codified: it made TEAM unreachable on the workspace a
  // customer actually works in, so buying it meant creating a SECOND workspace
  // and leaving your evidence behind in the first.
  //
  // The product model has exactly two context kinds — PERSONAL and
  // ORGANIZATION — and the self-service progression FREE → PRO → TEAM applies
  // to the same Personal Workspace throughout. TEAM is a tier, not a place.
  //
  // PAYG is still refused, and that refusal is unrelated: it is a legacy
  // resolution row, never an assignable plan. ENTERPRISE is refused too — it is
  // an Organization contract, provisioned by Sales, and a personal entitlement
  // claiming it would be a self-service Enterprise grant.
  if (plan === prismaPkg.PlanType.ENTERPRISE) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "ENTERPRISE is an Organization contract, not a personal plan"
    );
    err.statusCode = 409;
    err.code = "ENTERPRISE_NOT_SELF_SERVICE";
    throw err;
  }

  // BILLING PRODUCTION CLOSURE (2026-08-27) — PAYG is not a plan any writer may
  // produce.
  //
  // This is THE single writer of `entitlements.plan`, which makes it the one
  // place the invariant can be stated once and be true everywhere. Evidence
  // credits are a wallet over whatever plan the account is on; promoting an
  // account to the legacy PAYG row would hand it that row's grandfathered
  // terms — 5 GB of storage and 50 AI operations a month that no purchase pays
  // for — and would rebind every future completion to a credit.
  //
  // The catalog row stays, because historical entitlements still resolve
  // through it. Nothing may CREATE another one.
  if (plan === prismaPkg.PlanType.PAYG) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "PAYG is a legacy resolution row, not an assignable plan"
    );
    err.statusCode = 409;
    err.code = "PAYG_NOT_ASSIGNABLE";
    throw err;
  }

  await ensureEntitlement(userId);

  /**
   * THE DOWNGRADE GRANDFATHER, DECIDED WHERE THE PLAN IS WRITTEN.
   *
   * ---------------------------------------------------------------------------
   * COMMERCIAL CLOSURE (2026-09-08)
   * ---------------------------------------------------------------------------
   * A TEAM customer holding 350 records who moves to PRO used to land on PRO's
   * 100-record lifetime cap with no adjustment. Nothing was deleted — the
   * platform never deletes evidence for a plan change — but the account was
   * INSTANTLY over cap and could not create anything at all, including with
   * purchased credits, because `resolvePersonalEvidenceAdmission` compares a
   * lifetime count against a lifetime cap and 350 is not below 100. The
   * customer's own history became the thing blocking them.
   *
   * THE RULE:
   *   * moving to a plan WITH a lifetime cap (FREE, PRO) freezes the cap at the
   *     records that already exist, when that is more than the plan includes.
   *     Existing evidence stays valid and reachable; the plan grants NO new
   *     free capacity above it. Record 351 needs a credit or a higher plan —
   *     which is exactly what the customer chose when they downgraded.
   *   * moving to a plan with NO lifetime cap (TEAM, ENTERPRISE) CLEARS the
   *     override. A stale frozen number must not survive an upgrade and then
   *     silently govern a later downgrade: the cap is recomputed from the
   *     records that exist at the moment the downgrade happens, which is the
   *     only count that describes the customer's actual history.
   *
   * `legacyRecordCapOverride` is REUSED rather than joined by a second field.
   * It already means exactly this — "the effective lifetime record cap for this
   * payer, substituting the plan default" — it is already interpreted in
   * exactly one place (`resolveCommercialContext(...).limits`), and a second
   * override column would be a second authority over one number.
   *
   * The count uses the canonical enforcement predicate so the cap that is
   * frozen and the count it is later compared against are the same population.
   * Imported dynamically to keep the static graph acyclic: the enforcement
   * module reaches this one through `workspace-billing`.
   */
  const nextCaps = getPlanCapabilities(plan);
  /**
   * Tri-state on purpose. "Do not touch it" and "clear it" are different
   * instructions, and collapsing them into `null` would let a failed count
   * erase a real grandfather.
   */
  let overrideWrite: { legacyRecordCapOverride: number | null } | null = null;
  if (nextCaps.maxEvidenceRecords === null) {
    overrideWrite = { legacyRecordCapOverride: null };
  } else {
    try {
      const { countPersonalEvidenceRecords } = await import(
        "./billing-enforcement.service.js"
      );
      const existing = await countPersonalEvidenceRecords(userId);
      overrideWrite = {
        legacyRecordCapOverride:
          existing > nextCaps.maxEvidenceRecords ? existing : null,
      };
    } catch {
      // Count unavailable — leave whatever is there. The plan write proceeds.
      overrideWrite = null;
    }
  }

  await prisma.entitlement.updateMany({
    where: {
      userId,
      active: true,
    },
    data: {
      plan,
      teamSeats: 0,
      ...(overrideWrite ?? {}),
    },
  });

  const next = await ensureEntitlement(userId);

  await trackBillingEvent({
    eventType: "billing_plan_changed",
    userId,
    plan,
    metadata: {
      billingShape: "SINGLE_OCCUPANT",
      credits: next.credits ?? 0,
      teamSeats: next.teamSeats ?? 0,
    },
  });

  return next;
}

// BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `activateTeamPlan` was
// DELETED, with zero-consumer proof.
//
// After TEAM became a tier of the Personal Workspace, its only remaining
// caller was the DEV-ONLY plan route, which is 403'd in production — the
// capability analyzer classified the write as MODULE_SCOPED rather than
// route-attributed, which is the map's way of saying "no production path
// reaches this". Enterprise provisioning does not use it either: that service
// writes `billingPlan` on its own `team.create`/`team.update`, in three
// places, and always has.
//
// A workspace's commercial columns are therefore written by exactly one thing
// now — Enterprise provisioning — which is the only remaining reason a
// workspace has a plan at all.

// BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `cancelTeamPlan` was
// DELETED, with zero-consumer proof.
//
// Its only live caller was the webhook's TEAM branch, which applied a cancelled
// TEAM subscription to a WORKSPACE's billing columns. TEAM is now a tier of the
// Personal Workspace, so a cancellation writes the personal entitlement and
// there is no workspace state to clear. `workspace-closure.service.ts` never
// called it, and no other module did.
//
// The safety property it carried — a billing cancellation deletes no Evidence
// and purges no memberships — is NOT retired with it: the assertion moves to
// `activateTeamPlan`, which survives for Enterprise provisioning and writes the
// same columns. See `phase-9-commercial-invariants.test.ts`.

/**
 * BILLING PAYPAL INTEGRITY (2026-09-28) — the closed vocabulary of
 * `payments.product`.
 *
 *   PLAN / STORAGE_ADDON / EVIDENCE_CREDIT  written by the writer that knows;
 *   STORAGE_ADDON_ONE_TIME                  a legacy one-time storage order;
 *   SUBSCRIPTION_UNSPECIFIED                a historic recurring payment whose
 *                                           plan-vs-storage split is unknown;
 *   UNCLASSIFIED                            a historic row the provider could
 *                                           not attribute to a credit order.
 *
 * The last two are PROVISIONAL: a writer that later proves the product
 * replaces them. A definite product is never re-labelled.
 */
export type PaymentProduct =
  | "PLAN"
  | "STORAGE_ADDON"
  | "EVIDENCE_CREDIT"
  | "STORAGE_ADDON_ONE_TIME"
  | "SUBSCRIPTION_UNSPECIFIED"
  | "UNCLASSIFIED";

export function isProvisionalPaymentProduct(product: string | null | undefined): boolean {
  return product === "SUBSCRIPTION_UNSPECIFIED" || product === "UNCLASSIFIED";
}

export async function recordPayment(params: {
  userId: string;
  provider: prismaPkg.PaymentProvider;
  providerPaymentId: string;
  amountCents: number;
  currency: string;
  status: prismaPkg.PaymentStatus;
  teamId?: string | null;
  /**
   * The PROVIDER's own timestamp for this fact, when the caller has one.
   *
   * Optional because most webhook handlers do not carry it today; absent, the
   * monotonicity rule still applies and only the ordering rule is unavailable.
   */
  observedAtUtc?: Date | null;
  /**
   * BILLING PAYPAL INTEGRITY (2026-09-28) — WHAT the payment paid for. Every
   * writer states it; credit recovery reads EVIDENCE_CREDIT rows only, so a
   * plan or storage renewal can never be mistaken for a credit purchase.
   */
  product: PaymentProduct;
  checkoutAttemptId?: string | null;
  /** The PayPal order / subscription (Stripe session / subscription) id. */
  providerResourceId?: string | null;
}) {
  /*
   * BILLING SURFACE CORRECTION (2026-08-29) — a settled payment is never
   * moved backwards.
   *
   * This was a plain upsert whose `update` wrote `status` unconditionally.
   * Webhooks are not delivered in order and are redelivered on retry, so a
   * PayPal `APPROVAL_PENDING` arriving after the capture had settled — or any
   * redelivery of an older event — rewrote a SUCCEEDED row to PENDING, and the
   * customer's history then said their paid subscription was still being
   * processed.
   *
   * The rules live in ONE place (`decidePaymentTransition`), shared with the
   * reconciliation poll and the per-row re-check, so all three routes into
   * this row agree about what may overwrite what.
   *
   * The update is a COMPARE-AND-SET on the status we read, so two webhooks
   * racing produce one transition rather than two.
   */
  const existing = await prisma.payment.findUnique({
    where: {
      provider_providerPaymentId: {
        provider: params.provider,
        providerPaymentId: params.providerPaymentId,
      },
    },
    select: {
      id: true,
      status: true,
      providerStateAtUtc: true,
      userId: true,
      product: true,
      checkoutAttemptId: true,
      providerResourceId: true,
    },
  });

  if (existing && existing.userId !== params.userId) {
    // One provider payment belongs to one payer. A second writer naming a
    // different payer is a correlation fault, never a re-assignment.
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Provider payment is bound to a different payer",
    );
    err.statusCode = 409;
    err.code = "PROVIDER_PAYMENT_SUBJECT_MISMATCH";
    throw err;
  }

  let payment;
  if (!existing) {
    payment = await prisma.payment
      .create({
        data: {
          userId: params.userId,
          provider: params.provider,
          providerPaymentId: params.providerPaymentId,
          amountCents: params.amountCents,
          currency: params.currency,
          status: params.status,
          teamId: params.teamId ?? null,
          product: params.product,
          checkoutAttemptId: params.checkoutAttemptId ?? null,
          providerResourceId: params.providerResourceId ?? null,
          ...(params.observedAtUtc
            ? { providerStateAtUtc: params.observedAtUtc }
            : {}),
        },
      })
      .catch(async (err: unknown) => {
        // A concurrent writer (return route vs webhook) inserted the same
        // provider payment first. Converge on its row through the normal
        // compare-and-set path instead of failing the request.
        if ((err as { code?: string }).code !== "P2002") throw err;
        return null;
      });
    if (!payment) return recordPayment(params);
  } else {
    // Identity is written once and completed, never replaced: a later writer
    // may fill what an earlier one could not know, but cannot re-label it.
    const identity = {
      ...(!existing.product || isProvisionalPaymentProduct(existing.product)
        ? existing.product === params.product
          ? {}
          : { product: params.product }
        : {}),
      ...(!existing.checkoutAttemptId && params.checkoutAttemptId
        ? { checkoutAttemptId: params.checkoutAttemptId }
        : {}),
      ...(!existing.providerResourceId && params.providerResourceId
        ? { providerResourceId: params.providerResourceId }
        : {}),
    };
    if (Object.keys(identity).length > 0) {
      await prisma.payment.update({ where: { id: existing.id }, data: identity });
    }

    const decision = decidePaymentTransition({
      current: existing.status,
      currentObservedAtUtc: existing.providerStateAtUtc,
      observed: observedStateFromPaymentStatus(params.status),
      observedAtUtc: params.observedAtUtc ?? null,
    });

    if (decision.apply) {
      await prisma.payment.updateMany({
        // The status predicate is the compare-and-set: if another delivery
        // moved the row between the read and here, this matches nothing and
        // that other delivery's transition stands.
        where: { id: existing.id, status: existing.status },
        data: {
          status: decision.status,
          amountCents: params.amountCents,
          currency: params.currency,
          teamId: params.teamId ?? null,
          ...(params.observedAtUtc
            ? { providerStateAtUtc: params.observedAtUtc }
            : {}),
        },
      });
    }

    payment = await prisma.payment.findUniqueOrThrow({
      where: { id: existing.id },
    });
  }

  await trackBillingEvent({
    eventType:
      params.status === prismaPkg.PaymentStatus.SUCCEEDED
        ? "billing_payment_succeeded"
        : params.status === prismaPkg.PaymentStatus.FAILED
          ? "billing_payment_failed"
          : params.status === prismaPkg.PaymentStatus.REFUNDED
            ? "billing_payment_refunded"
            : "billing_checkout_completed",
    userId: params.userId,
    teamId: params.teamId ?? null,
    provider: params.provider,
    paymentStatus: params.status,
    metadata: {
      paymentId: params.providerPaymentId,
      amountCents: params.amountCents,
      currency: params.currency,
    },
  });

  return payment;
}

type SubscriptionWriteClient = Pick<prismaPkg.Prisma.TransactionClient, "subscription" | "team">;

export async function upsertSubscription(
  params: {
    userId: string;
    provider: prismaPkg.PaymentProvider;
    providerSubId: string;
    status: prismaPkg.SubscriptionStatus;
    plan: prismaPkg.PlanType;
    currentPeriodEnd?: Date | null;
    teamId?: string | null;
    observedAtUtc?: Date | null;
    /**
     * BILLING (2026-09-28) — what the PROVIDER bills, when this fact carries
     * it. Absent leaves the recorded value; it is never guessed.
     */
    billedCurrency?: string | null;
    billedUnitAmountCents?: number | null;
  },
  /**
   * BILLING PAYPAL INTEGRITY (2026-09-28) — the caller's transaction, so an
   * activation can be decided and written under one per-payer lock
   * (`syncPlanForSubscription`). Defaults to the global client.
   */
  client: SubscriptionWriteClient = prisma,
) {
  const billed = {
    ...(params.billedCurrency ? { billedCurrency: params.billedCurrency.toUpperCase() } : {}),
    ...(typeof params.billedUnitAmountCents === "number" && params.billedUnitAmountCents >= 0
      ? { billedUnitAmountCents: params.billedUnitAmountCents }
      : {}),
  };
  const existing = await client.subscription.findUnique({
    where: {
      provider_providerSubId: {
        provider: params.provider,
        providerSubId: params.providerSubId,
      },
    },
    select: {
      id: true,
      status: true,
      plan: true,
      teamId: true,
      currentPeriodEnd: true,
      providerStateAtUtc: true,
      userId: true,
      activatedAtUtc: true,
      // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — read so a landed
      // schedule can be cleared below.
      pendingPlan: true,
    },
  });

  const readCurrent = () =>
    client.subscription.findUniqueOrThrow({
      where: {
        provider_providerSubId: {
          provider: params.provider,
          providerSubId: params.providerSubId,
        },
      },
    });

  // §9.10 STALE/OUT-OF-ORDER PROTECTION (2026-07-23): a provider event whose
  // billing period is OLDER than the stored row's cannot restore an older
  // entitlement state. Provider events for the same subscription advance
  // monotonically in currentPeriodEnd; an event carrying an earlier period
  // end than what we already recorded is a late/retried delivery of an
  // older state — skip the write (idempotent no-op) and keep the newer row.
  if (
    existing &&
    existing.currentPeriodEnd &&
    params.currentPeriodEnd &&
    params.currentPeriodEnd.getTime() < existing.currentPeriodEnd.getTime()
  ) {
    return readCurrent();
  }

  // BILLING PAYPAL INTEGRITY (2026-09-28) — a LEGACY workspace-bound row whose
  // workspace was deleted has had its `teamId` set NULL by the foreign key
  // (ON DELETE SET NULL), while the provider's `custom_id` still names the
  // old workspace. That is the SAME subject, not a rebinding: without this,
  // every later provider fact for the subscription threw SUBJECT_MISMATCH and
  // a cancellation or renewal could never be applied.
  let teamId = params.teamId ?? null;
  if (existing && existing.teamId === null && teamId !== null) {
    const stillExists = await client.team.findUnique({ where: { id: teamId }, select: { id: true } });
    if (!stillExists) teamId = null;
  }

  // §9.10 SUBJECT BINDING: a provider subscription id maps to exactly ONE
  // commercial subject. A retried/late event may not silently REBIND the
  // stored row to a different user or workspace — fail closed instead.
  if (
    existing &&
    (existing.userId !== params.userId || (existing.teamId ?? null) !== teamId)
  ) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Provider subscription is bound to a different commercial subject"
    );
    err.statusCode = 409;
    err.code = "PROVIDER_SUBSCRIPTION_SUBJECT_MISMATCH";
    throw err;
  }

  if (existing) {
    const decision = decideSubscriptionStatusWrite({
      current: existing.status,
      currentObservedAtUtc: existing.providerStateAtUtc,
      next: params.status,
      observedAtUtc: params.observedAtUtc ?? null,
    });
    if (!decision.apply) return readCurrent();
  }

  const becomesActive = params.status === prismaPkg.SubscriptionStatus.ACTIVE;
  const subscription = await client.subscription.upsert({
    where: {
      provider_providerSubId: {
        provider: params.provider,
        providerSubId: params.providerSubId,
      },
    },
    update: {
      status: params.status,
      plan: params.plan,
      currentPeriodEnd: params.currentPeriodEnd ?? null,
      teamId,
      ...billed,
      ...(params.observedAtUtc
        ? { providerStateAtUtc: params.observedAtUtc }
        : {}),
      ...(becomesActive && !existing?.activatedAtUtc
        ? { activatedAtUtc: params.observedAtUtc ?? new Date() }
        : {}),
      // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — a SCHEDULED plan
      // change is cleared the moment it stops being in the future: the
      // scheduled plan is now the plan in force, or the subscription ended
      // before it could be. It is cleared HERE, in the one writer every
      // provider fact passes through.
      ...(existing?.pendingPlan &&
      (existing.pendingPlan === params.plan ||
        params.status === prismaPkg.SubscriptionStatus.CANCELED)
        ? {
            pendingPlan: null,
            pendingPlanEffectiveAtUtc: null,
            pendingPlanAwaitingApproval: false,
            pendingPlanRequestedAtUtc: null,
          }
        : {}),
    },
    create: {
      userId: params.userId,
      provider: params.provider,
      providerSubId: params.providerSubId,
      status: params.status,
      plan: params.plan,
      currentPeriodEnd: params.currentPeriodEnd ?? null,
      teamId,
      ...billed,
      ...(params.observedAtUtc
        ? { providerStateAtUtc: params.observedAtUtc }
        : {}),
      ...(becomesActive ? { activatedAtUtc: params.observedAtUtc ?? new Date() } : {}),
    },
  });

  await trackBillingEvent({
    eventType:
      params.status === prismaPkg.SubscriptionStatus.CANCELED
        ? "billing_subscription_canceled"
        : existing
          ? "billing_subscription_updated"
          : "billing_subscription_created",
    userId: params.userId,
    teamId,
    plan: params.plan,
    provider: params.provider,
    subscriptionStatus: params.status,
    metadata: {
      providerSubId: params.providerSubId,
      currentPeriodEnd: params.currentPeriodEnd
        ? params.currentPeriodEnd.toISOString()
        : null,
      previousStatus: existing?.status ?? null,
      previousPlan: existing?.plan ?? null,
    },
  });

  return subscription;
}

function existingMetadata(
  value: prismaPkg.Prisma.JsonValue | null | undefined,
): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function upsertWorkspaceStorageAddon(params: {
  attemptId?: string | null;
  ownerUserId: string;
  teamId?: string | null;
  addonKey: prismaPkg.StorageAddonKey;
  billingCycle: prismaPkg.StorageAddonBillingCycle;
  status: prismaPkg.WorkspaceStorageAddonStatus;
  paymentProvider?: prismaPkg.PaymentProvider | null;
  externalSubscriptionId?: string | null;
  externalPaymentId?: string | null;
  currency?: string | null;
  amountCents?: number | null;
  currentPeriodEnd?: Date | null;
  expiresAtUtc?: Date | null;
  observedAtUtc?: Date | null;
  metadata?: Record<string, unknown> | null;
  /**
   * BILLING PAYPAL INTEGRITY (2026-09-28) — the base subscription this add-on
   * depends on, decided by the storage activation authority at FIRST
   * activation. Undefined leaves the recorded value.
   */
  dependsOnSubscriptionId?: string | null;
}) {
  /**
   * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — BOTH cycles are writable
   * again, and the reason is not symmetry.
   *
   * This used to reject anything but ONE_TIME. A one-time payment cannot fund
   * perpetual storage, and nothing ever expired one: `expiresAtUtc` was
   * written `null` on every row and `WorkspaceStorageAddonStatus.EXPIRED` had
   * no writer anywhere in the codebase. A single €2.99 purchase therefore
   * granted 10 GB for ever — including after the base subscription was
   * cancelled — which is an unbounded liability sold as a top-up.
   *
   * New purchases are MONTHLY subscriptions. ONE_TIME remains writable ONLY so
   * that grandfathered rows can still be updated in place by their provider's
   * webhooks; no checkout path can create one any more.
   */
  const definition = getStorageAddonDefinition(params.addonKey);

  const existingByAttempt = params.attemptId
    ? await prisma.workspaceStorageAddon.findUnique({
        where: { id: params.attemptId },
      })
    : null;

  if (
    existingByAttempt &&
    (existingByAttempt.ownerUserId !== params.ownerUserId ||
      existingByAttempt.teamId !== (params.teamId ?? null) ||
      existingByAttempt.addonKey !== params.addonKey)
  ) {
    throw new Error("Storage add-on attempt ownership or product mismatch");
  }

  const existingBySubscription = params.externalSubscriptionId
    ? await prisma.workspaceStorageAddon.findUnique({
        where: {
          externalSubscriptionId: params.externalSubscriptionId,
        },
      })
    : null;

  const existingByPayment =
    !existingBySubscription && params.externalPaymentId
      ? await prisma.workspaceStorageAddon.findUnique({
          where: {
            externalPaymentId: params.externalPaymentId,
          },
        })
      : null;

  const existing = existingByAttempt ?? existingBySubscription ?? existingByPayment;

  if (
    existing?.providerStateAtUtc &&
    params.observedAtUtc &&
    params.observedAtUtc.getTime() < existing.providerStateAtUtc.getTime()
  ) {
    return existing;
  }

  const status =
    existing?.status === prismaPkg.WorkspaceStorageAddonStatus.ABANDONED &&
    params.status === prismaPkg.WorkspaceStorageAddonStatus.PENDING
      ? existing.status
      : params.status === prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE &&
          !existing?.activatedAtUtc
        ? prismaPkg.WorkspaceStorageAddonStatus.FAILED
        : params.status;

  const data = {
    ownerUserId: params.ownerUserId,
    teamId: params.teamId ?? null,
    addonKey: params.addonKey,
    extraStorageBytes: definition.storageBytes,
    // Honour the cycle the caller states. Hardcoding ONE_TIME here silently
    // rewrote a recurring add-on's own identity on every webhook update.
    billingCycle: params.billingCycle,
    status,
    // BILLING CHECKOUT ATTEMPTS (2026-09-28) — a lifecycle event that does
    // not name a field leaves it as it was. These were written
    // `params.x ?? null`, so a subscription webhook (which carries no payment
    // id) erased the row's recorded payment id and provider.
    paymentProvider: params.paymentProvider ?? existing?.paymentProvider ?? null,
    externalSubscriptionId:
      params.externalSubscriptionId ?? existing?.externalSubscriptionId ?? null,
    externalPaymentId: params.externalPaymentId ?? existing?.externalPaymentId ?? null,
    // Provider lifecycle events do not repeat the checkout price. Preserve the
    // durable attempt's commercial identity instead of silently replacing it
    // with catalogue defaults during webhook settlement.
    currency: (
      params.currency ?? existing?.currency ?? definition.currency
    ).toUpperCase(),
    amountCents:
      params.amountCents ?? existing?.amountCents ?? definition.priceCents,
    activatedAtUtc:
      status === prismaPkg.WorkspaceStorageAddonStatus.ACTIVE
        ? existing?.activatedAtUtc ?? new Date()
        : existing?.activatedAtUtc ?? null,
    // A recurring add-on HAS a period end; a grandfathered one-time row does
    // not. Hardcoding null erased the renewal date for every recurring row.
    currentPeriodEnd:
      params.billingCycle === prismaPkg.StorageAddonBillingCycle.MONTHLY
        ? params.currentPeriodEnd ?? existing?.currentPeriodEnd ?? null
        : null,
    expiresAtUtc: params.expiresAtUtc ?? existing?.expiresAtUtc ?? null,
    canceledAtUtc:
      status === prismaPkg.WorkspaceStorageAddonStatus.CANCELED
        ? existing?.canceledAtUtc ?? new Date()
        : existing?.canceledAtUtc ?? null,
    // MERGED, never replaced. The create route records the safe correlation
    // diagnostics (HTTP status, paypal-debug-id, plan id, approval-link
    // identity) seconds before PayPal's CREATED webhook arrives; replacing the
    // object with `{ source }` erased exactly the evidence the 2026-09-26
    // incident lacked.
    metadata: toNullableJsonInput(
      params.metadata === undefined || params.metadata === null
        ? existingMetadata(existing?.metadata)
        : { ...(existingMetadata(existing?.metadata) ?? {}), ...params.metadata },
    ),
    ...(params.observedAtUtc
      ? { providerStateAtUtc: params.observedAtUtc }
      : {}),
    ...(params.dependsOnSubscriptionId !== undefined
      ? { dependsOnSubscriptionId: params.dependsOnSubscriptionId }
      : {}),
  };

  let addon: prismaPkg.WorkspaceStorageAddon;
  if (existing) {
    const applied = await prisma.workspaceStorageAddon.updateMany({
      where: {
        id: existing.id,
        status: existing.status,
        providerStateAtUtc: existing.providerStateAtUtc,
      },
      data,
    });
    addon = await prisma.workspaceStorageAddon.findUniqueOrThrow({
      where: { id: existing.id },
    });
    // A webhook or reconciliation writer advanced the row after our read.
    // Its state wins; do not emit an event describing a write we did not make.
    if (applied.count === 0) return addon;
  } else {
    addon = await prisma.workspaceStorageAddon.create({ data });
  }

  await trackBillingEvent({
    eventType:
      status === prismaPkg.WorkspaceStorageAddonStatus.ACTIVE
        ? existing
          ? "billing_storage_addon_updated"
          : "billing_storage_addon_activated"
        : status === prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE
          ? "billing_storage_addon_past_due"
          : status === prismaPkg.WorkspaceStorageAddonStatus.PENDING
            ? "billing_storage_addon_pending"
            : status === prismaPkg.WorkspaceStorageAddonStatus.CANCELED
              ? "billing_storage_addon_canceled"
              : status === prismaPkg.WorkspaceStorageAddonStatus.EXPIRED
                ? "billing_storage_addon_expired"
                : "billing_storage_addon_failed",
    userId: params.ownerUserId,
    teamId: params.teamId ?? null,
    provider: params.paymentProvider ?? null,
    metadata: {
      addonId: addon.id,
      addonKey: addon.addonKey,
      billingCycle: addon.billingCycle,
      extraStorageBytes: addon.extraStorageBytes.toString(),
      externalSubscriptionId: addon.externalSubscriptionId,
      externalPaymentId: addon.externalPaymentId,
      status: addon.status,
      currentPeriodEnd: addon.currentPeriodEnd?.toISOString() ?? null,
      expiresAtUtc: addon.expiresAtUtc?.toISOString() ?? null,
    },
  });

  return addon;
}

export async function cancelWorkspaceStorageAddon(params: {
  addonId: string;
  ownerUserId: string;
}) {
  const addon = await prisma.workspaceStorageAddon.findUnique({
    where: { id: params.addonId },
  });

  if (!addon) {
    const err: Error & { statusCode?: number } = new Error(
      "Storage addon not found"
    );
    err.statusCode = 404;
    throw err;
  }

  if (addon.ownerUserId !== params.ownerUserId) {
    const err: Error & { statusCode?: number } = new Error(
      "You are not allowed to manage this storage addon"
    );
    err.statusCode = 403;
    throw err;
  }

  const updated = await prisma.workspaceStorageAddon.update({
    where: { id: addon.id },
    data: {
      status: prismaPkg.WorkspaceStorageAddonStatus.CANCELED,
      canceledAtUtc: new Date(),
    },
  });

  await trackBillingEvent({
    eventType: "billing_storage_addon_canceled",
    userId: updated.ownerUserId,
    teamId: updated.teamId ?? null,
    provider: updated.paymentProvider ?? null,
    metadata: {
      addonId: updated.id,
      addonKey: updated.addonKey,
      externalSubscriptionId: updated.externalSubscriptionId,
      billingCycle: updated.billingCycle,
    },
  });

  return updated;
}

// BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `syncTeamBillingSnapshot`
// was DELETED. Zero consumers. It branched on `plan === TEAM` to activate or
// cancel a WORKSPACE's commercial state — the obsolete model exactly: a TEAM
// subscription no longer has a workspace whose state it could sync.

export function computeOverSeatLimit(input: {
  activeMemberCount: number;
  includedSeats: number;
}): boolean {
  // `includedSeats: 0` means "no seat ceiling", never "zero seats allowed".
  if (input.includedSeats <= 0) return false;
  return input.activeMemberCount > input.includedSeats;
}

export async function refreshTeamSeatState(teamId: string) {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      ownerUserId: true,
      billingPlan: true,
      includedSeats: true,
      _count: {
        // P5 domain remediation (2026-07-21) — ACTIVE-only seat counting.
        select: { members: { where: { status: "ACTIVE" } } },
      },
    },
  });

  if (!team) return null;

  const overSeatLimit = computeOverSeatLimit({
    activeMemberCount: team._count.members,
    includedSeats: team.includedSeats,
  });

  const updated = await prisma.team.update({
    where: { id: teamId },
    data: {
      overSeatLimit,
    },
  });

  if (overSeatLimit) {
    await trackBillingEvent({
      eventType: "team_seat_limit_reached",
      userId: team.ownerUserId,
      teamId,
      plan: team.billingPlan,
      metadata: {
        memberCount: team._count.members,
        includedSeats: team.includedSeats,
      },
    });
  }

  return updated;
}

// BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `markTeamBillingCanceled`
// was DELETED. Zero consumers: a one-line wrapper over `cancelTeamPlan` that
// nothing outside this file ever called.
