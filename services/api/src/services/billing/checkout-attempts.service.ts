/**
 * BILLING CHECKOUT ATTEMPTS (2026-09-28) — the durable record of a PayPal PLAN
 * or EVIDENCE-CREDIT checkout, written before the provider is called.
 *
 * WHY
 * ---------------------------------------------------------------------------
 * PayPal storage checkouts already committed a local row before leaving for
 * PayPal and used its id as the `PayPal-Request-Id`. Plan and credit
 * checkouts did not: the provider resource was created first, with no
 * idempotency key, and the only local trace was written afterwards (a
 * TRIALING subscription row for a plan, nothing at all for a credit order).
 * A lost create response therefore left a live PayPal resource PROOVRA could
 * not see, and an unapproved credit order never appeared anywhere on Billing.
 *
 * WHAT THIS MODULE IS
 * ---------------------------------------------------------------------------
 * Pure persistence and transition rules. It imports no provider client, so
 * the settlement service (webhooks, return routes) and the recovery service
 * can both record what the provider said without an import cycle.
 *
 * It is NOT an entitlement authority. A plan is written only by
 * `syncPlanForSubscription`, credits only by `grantEvidenceCredits`, payments
 * only by `recordPayment`. This row answers "what did the customer start, and
 * what has the provider told us about it".
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";

const S = prismaPkg.BillingCheckoutAttemptStatus;

/** The closed vocabulary of `checkout_state`. */
export type CheckoutState =
  | "PROVIDER_CREATE_IN_PROGRESS"
  | "PROVIDER_OUTCOME_UNKNOWN"
  | "AWAITING_CUSTOMER_APPROVAL"
  | "CAPTURE_PENDING"
  | "PROVIDER_REJECTED"
  | "NEEDS_REVIEW"
  | "SETTLED"
  | "PROVIDER_CANCELED"
  | "PROVIDER_EXPIRED"
  | "PAYMENT_DECLINED"
  | "LOCALLY_ABANDONED";

/** How long a just-created attempt is treated as a duplicate click. */
export const CHECKOUT_REUSE_WINDOW_MS = 2 * 60 * 1000;

/**
 * May a row in `current` move to `next`?
 *
 * Provider truth moves a PENDING row anywhere. A local ABANDONED row still
 * yields to any terminal provider fact — the customer's decision never hides
 * a payment the provider later proves. A provider-rejected create (FAILED
 * before any resource existed) can only be corrected by a provider-proven
 * completion. COMPLETED, CANCELED and EXPIRED are final.
 */
export function mayTransitionCheckoutAttempt(
  current: prismaPkg.BillingCheckoutAttemptStatus,
  next: prismaPkg.BillingCheckoutAttemptStatus,
): boolean {
  if (current === next) return false;
  switch (current) {
    case S.PENDING:
      return true;
    case S.ABANDONED:
      return next === S.COMPLETED || next === S.CANCELED || next === S.EXPIRED || next === S.FAILED;
    case S.FAILED:
      return next === S.COMPLETED;
    default:
      return false;
  }
}

export type OpenCheckoutAttemptGate =
  | { kind: "OPEN"; attemptId: string }
  | {
      kind: "BLOCKED";
      reason: "PLAN_ATTEMPT_PENDING" | "CHECKOUT_IN_PROGRESS";
      attempt: {
        id: string;
        planKey: prismaPkg.PlanType | null;
        providerBound: boolean;
        createdAt: Date;
      };
    }
  | {
      kind: "REUSE";
      attempt: { id: string; providerResourceId: string; createdAt: Date };
    };

type LockClient = Pick<prismaPkg.Prisma.TransactionClient, "$executeRaw">;

/**
 * Serialize checkout creation for one payer and product, and commit the
 * attempt BEFORE any provider call.
 *
 * PLAN: any PENDING plan attempt blocks a second one (one live base
 * subscription per Personal account). A bound attempt for the SAME tier made
 * within the reuse window is a duplicate click and is returned for reuse, so
 * the browser is sent to the approval page PayPal already issued instead of a
 * second subscription being created.
 *
 * EVIDENCE_CREDIT: each purchase is independent, so an older pending order
 * does not block. A bound order created within the reuse window is reused
 * (duplicate click); an unbound one still in flight is refused as
 * CHECKOUT_IN_PROGRESS rather than racing a second create.
 *
 * `extraBlock` lets the caller add the legacy TRIALING-subscription check
 * inside the same lock and transaction.
 */
export async function openCheckoutAttempt(input: {
  userId: string;
  product: prismaPkg.BillingCheckoutProduct;
  provider: prismaPkg.PaymentProvider;
  planKey?: prismaPkg.PlanType | null;
  amountCents: number;
  currency: string;
  now?: Date;
  extraBlock?: (
    tx: prismaPkg.Prisma.TransactionClient,
  ) => Promise<OpenCheckoutAttemptGate | null>;
}): Promise<OpenCheckoutAttemptGate> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    await (tx as LockClient).$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`billing-checkout-attempt:${input.provider}:${input.product}:${input.userId}`}))
    `;

    const pending = await tx.billingCheckoutAttempt.findFirst({
      where: {
        userId: input.userId,
        product: input.product,
        provider: input.provider,
        status: S.PENDING,
        ...(input.product === prismaPkg.BillingCheckoutProduct.EVIDENCE_CREDIT
          ? { createdAt: { gte: new Date(now.getTime() - CHECKOUT_REUSE_WINDOW_MS) } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        planKey: true,
        providerResourceId: true,
        checkoutState: true,
        createdAt: true,
      },
    });

    if (pending) {
      const fresh = now.getTime() - pending.createdAt.getTime() < CHECKOUT_REUSE_WINDOW_MS;
      const samePlan = (pending.planKey ?? null) === (input.planKey ?? null);
      if (
        fresh &&
        samePlan &&
        pending.providerResourceId &&
        pending.checkoutState === "AWAITING_CUSTOMER_APPROVAL"
      ) {
        return {
          kind: "REUSE" as const,
          attempt: {
            id: pending.id,
            providerResourceId: pending.providerResourceId,
            createdAt: pending.createdAt,
          },
        };
      }
      if (
        input.product === prismaPkg.BillingCheckoutProduct.PLAN ||
        !pending.providerResourceId
      ) {
        return {
          kind: "BLOCKED" as const,
          reason:
            input.product === prismaPkg.BillingCheckoutProduct.PLAN
              ? ("PLAN_ATTEMPT_PENDING" as const)
              : ("CHECKOUT_IN_PROGRESS" as const),
          attempt: {
            id: pending.id,
            planKey: pending.planKey,
            providerBound: Boolean(pending.providerResourceId),
            createdAt: pending.createdAt,
          },
        };
      }
    }

    // Checked AFTER this product's own attempts, so a duplicate click on a
    // bound attempt is reused rather than refused by the TRIALING row that
    // same attempt produced.
    const extra = input.extraBlock ? await input.extraBlock(tx) : null;
    if (extra) return extra;

    const attempt = await tx.billingCheckoutAttempt.create({
      data: {
        userId: input.userId,
        product: input.product,
        provider: input.provider,
        planKey: input.planKey ?? null,
        amountCents: input.amountCents,
        currency: input.currency.toUpperCase(),
        status: S.PENDING,
        checkoutState: "PROVIDER_CREATE_IN_PROGRESS",
      },
      select: { id: true },
    });
    return { kind: "OPEN" as const, attemptId: attempt.id };
  });
}

/** Correlation facts captured from a successful create. Never a token. */
export type CheckoutCreateDiagnostics = {
  providerHttpStatus: number | null;
  providerDebugId: string | null;
  providerEnvironment: string | null;
  providerClientIdFingerprint: string | null;
  providerPlanId: string | null;
  providerCurrency: string | null;
  approvalLinkIdentity: prismaPkg.Prisma.InputJsonObject | null;
};

function asObject(value: prismaPkg.Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Bind the provider resource the create returned.
 *
 * Tolerates the CREATED webhook having bound it first (same id), and never
 * moves a row a webhook already advanced past PENDING.
 */
export async function bindCheckoutAttempt(input: {
  attemptId: string;
  providerResourceId: string;
  diagnostics: CheckoutCreateDiagnostics;
}): Promise<void> {
  const row = await prisma.billingCheckoutAttempt.findUnique({
    where: { id: input.attemptId },
    select: { status: true, checkoutState: true, metadata: true, providerResourceId: true },
  });
  if (!row) return;
  if (row.providerResourceId && row.providerResourceId !== input.providerResourceId) {
    // A different resource already claims this attempt. Never rebind.
    throw new Error("Checkout attempt is already bound to a different provider resource");
  }
  await prisma.billingCheckoutAttempt.update({
    where: { id: input.attemptId },
    data: {
      providerResourceId: input.providerResourceId,
      ...(row.status === S.PENDING &&
      (row.checkoutState === "PROVIDER_CREATE_IN_PROGRESS" ||
        row.checkoutState === "PROVIDER_OUTCOME_UNKNOWN")
        ? { checkoutState: "AWAITING_CUSTOMER_APPROVAL" }
        : {}),
      metadata: {
        ...asObject(row.metadata),
        create: { ...input.diagnostics },
      } as prismaPkg.Prisma.InputJsonObject,
    },
  });
}

/**
 * Record a create that did not return a resource.
 *
 * `rejected` means PayPal refused before creating anything (a 4xx, or the
 * configuration check before the call): FAILED, nothing to approve. Anything
 * else — a timeout, a 5xx, a dropped connection — may have created a resource,
 * so the row stays PENDING with an explicit unknown outcome.
 */
export async function recordCheckoutCreateFailure(input: {
  attemptId: string;
  rejected: boolean;
}): Promise<void> {
  await prisma.billingCheckoutAttempt.updateMany({
    where: { id: input.attemptId, status: S.PENDING, providerResourceId: null },
    data: input.rejected
      ? { status: S.FAILED, checkoutState: "PROVIDER_REJECTED" }
      : { checkoutState: "PROVIDER_OUTCOME_UNKNOWN" },
  });
}

/** Whether a thrown create error proves PayPal created nothing. */
export function isProviderCreateRejection(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "publicCode" in error &&
    ["PAYMENT_PROVIDER_REJECTED", "PAYMENTS_UNAVAILABLE"].includes(
      String((error as { publicCode?: unknown }).publicCode ?? ""),
    )
  );
}

/**
 * Record what the PROVIDER said about an attempt, from any path — webhook,
 * return route, per-attempt re-check, account re-check.
 *
 * Found by provider resource id or, for a resource whose create response was
 * lost, by the attempt id PROOVRA wrote into its `custom_id`; the owner must
 * match either way. Binds the resource when it was unbound. Transitions are
 * monotonic (`mayTransitionCheckoutAttempt`) and ordered by the provider's own
 * timestamp. Returns whether anything changed.
 */
export async function recordCheckoutAttemptProviderOutcome(input: {
  provider: prismaPkg.PaymentProvider;
  userId: string;
  product: prismaPkg.BillingCheckoutProduct;
  providerResourceId: string;
  attemptId?: string | null;
  status: prismaPkg.BillingCheckoutAttemptStatus;
  checkoutState: CheckoutState;
  observedAtUtc?: Date | null;
  providerPaymentRef?: string | null;
}): Promise<boolean> {
  const row =
    (await prisma.billingCheckoutAttempt.findUnique({
      where: {
        provider_providerResourceId: {
          provider: input.provider,
          providerResourceId: input.providerResourceId,
        },
      },
    })) ??
    (input.attemptId
      ? await prisma.billingCheckoutAttempt.findUnique({ where: { id: input.attemptId } })
      : null);
  if (!row) return false;
  if (row.userId !== input.userId || row.product !== input.product) return false;
  if (row.providerResourceId && row.providerResourceId !== input.providerResourceId) {
    return false;
  }

  if (
    input.observedAtUtc &&
    row.providerStateAtUtc &&
    input.observedAtUtc.getTime() < row.providerStateAtUtc.getTime()
  ) {
    return false;
  }

  const statusChanges =
    row.status !== input.status && mayTransitionCheckoutAttempt(row.status, input.status);
  const stateChanges =
    row.status === S.PENDING &&
    input.status === S.PENDING &&
    row.checkoutState !== input.checkoutState;
  const binds = !row.providerResourceId;
  if (!statusChanges && !stateChanges && !binds) return false;

  const updated = await prisma.billingCheckoutAttempt.updateMany({
    where: {
      id: row.id,
      status: row.status,
      checkoutState: row.checkoutState,
      providerStateAtUtc: row.providerStateAtUtc,
    },
    data: {
      providerResourceId: input.providerResourceId,
      ...(statusChanges || stateChanges
        ? { status: statusChanges ? input.status : row.status, checkoutState: input.checkoutState }
        : {}),
      ...(statusChanges && input.status === S.COMPLETED
        ? { completedAtUtc: input.observedAtUtc ?? new Date() }
        : {}),
      ...(input.providerPaymentRef ? { providerPaymentRef: input.providerPaymentRef } : {}),
      ...(input.observedAtUtc ? { providerStateAtUtc: input.observedAtUtc } : {}),
    },
  });
  return updated.count > 0;
}

/** Persist the outcome of the last provider check, for the activity list. */
export async function noteCheckoutAttemptCheck(input: {
  attemptId: string;
  outcome: string;
  checkedAtUtc?: Date;
}): Promise<void> {
  const row = await prisma.billingCheckoutAttempt.findUnique({
    where: { id: input.attemptId },
    select: { metadata: true },
  });
  if (!row) return;
  await prisma.billingCheckoutAttempt.update({
    where: { id: input.attemptId },
    data: {
      metadata: {
        ...asObject(row.metadata),
        lastProviderCheck: {
          outcome: input.outcome,
          atUtc: (input.checkedAtUtc ?? new Date()).toISOString(),
        },
      } as prismaPkg.Prisma.InputJsonObject,
    },
  });
}

/** The customer's local disposition. Only a PENDING row can be abandoned. */
export async function markCheckoutAttemptAbandoned(input: {
  attemptId: string;
  userId: string;
}): Promise<boolean> {
  const updated = await prisma.billingCheckoutAttempt.updateMany({
    where: { id: input.attemptId, userId: input.userId, status: S.PENDING },
    data: { status: S.ABANDONED, checkoutState: "LOCALLY_ABANDONED" },
  });
  return updated.count > 0;
}
