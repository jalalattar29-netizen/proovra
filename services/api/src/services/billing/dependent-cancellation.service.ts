/**
 * BILLING DEPENDENT-CANCELLATION CONVERGENCE (2026-08-27) — THE obligation
 * authority.
 *
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * A base PRO/TEAM cancellation succeeded at the provider; one dependent
 * recurring Storage add-on then failed to cancel; and the failure lived in an
 * in-memory counter that died with the HTTP response. Nothing was written, so
 * nothing could retry, nothing could alert, and no query could find it. The
 * add-on kept renewing — indefinitely — for a customer who had cancelled.
 *
 * THE MODEL
 * ---------------------------------------------------------------------------
 * The obligation to stop ONE add-on is persisted BEFORE any dependent provider
 * call is attempted, in the same transaction that records the base result.
 * After that, every subsequent step is a state transition on a durable row:
 *
 *   NONE ──request──> PENDING ──provider ok──> CONFIRMED
 *                        │
 *                        ├─ transient failure ─> RETRY_SCHEDULED ─┐
 *                        │                            ^           │
 *                        │                            └── retry ──┘
 *                        │
 *                        ├─ needs a human now ──────> ACTION_REQUIRED
 *                        └─ fast retries spent ─────> MANUAL_INTERVENTION
 *
 * CONFIRMED is the only resolved state, and only provider truth writes it. A
 * customer cannot dismiss the obligation and an operator cannot close it with
 * a note, because neither of those stops the money.
 *
 * WHY IT LIVES ON THE ADD-ON ROW
 * ---------------------------------------------------------------------------
 * The obligation is a property of the add-on. Keeping it there means one
 * indexed predicate finds every unresolved one, and there is no second ledger
 * that could disagree with the add-on's own status.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import {
  cancelStorageAddonAtProvider,
  type AddonCancellationReasonCode,
  type StorageAddonProviderCanceller,
} from "./storage-addon-cancellation.service.js";

const S = prismaPkg.DependentCancellationState;

/** The states that still owe the customer a cancellation. */
export const UNRESOLVED_STATES = [
  S.PENDING,
  S.RETRY_SCHEDULED,
  S.ACTION_REQUIRED,
  S.MANUAL_INTERVENTION,
] as const;

/**
 * THE RETRY SCHEDULE, in minutes after the failure that scheduled it.
 *
 * Fast at first because most provider failures are transient and a customer
 * watching their Billing page deserves convergence within minutes; then
 * widening, because a provider that has failed six times is not going to be
 * fixed by asking harder.
 *
 * Attempt 1 is the immediate attempt made by the cancellation request itself,
 * so this array is indexed by the number of attempts ALREADY made.
 */
export const RETRY_DELAYS_MINUTES = [1, 5, 15, 60, 360] as const;

/** After the fast schedule is spent: bounded daily reconciliation, forever. */
export const MANUAL_INTERVENTION_RETRY_MINUTES = 24 * 60;

/** Attempts before the obligation escalates to MANUAL_INTERVENTION. */
export const MAX_FAST_ATTEMPTS = RETRY_DELAYS_MINUTES.length + 1;

/** How long one worker may hold an add-on while it talks to the provider. */
const LEASE_MINUTES = 5;

function nextRetryAt(attemptCount: number, from: Date): Date {
  const delay =
    attemptCount <= RETRY_DELAYS_MINUTES.length
      ? RETRY_DELAYS_MINUTES[attemptCount - 1]!
      : MANUAL_INTERVENTION_RETRY_MINUTES;
  return new Date(from.getTime() + delay * 60_000);
}

/**
 * The add-ons a base cancellation obliges us to stop.
 *
 * Scoped to ONE billing subject: a personal account owns its `teamId: null`
 * add-ons, a workspace owns its own. `MONTHLY` + a provider binding is what
 * makes an add-on a subscription — a legacy ONE_TIME row has neither and is
 * never returned, so it never receives an obligation, never receives a
 * provider call, and never leaves `NONE`.
 */
export function dependentAddonWhere(input: {
  ownerUserId: string;
  teamId: string | null;
}): prismaPkg.Prisma.WorkspaceStorageAddonWhereInput {
  return {
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
  };
}

/**
 * Persist the obligation for every live dependent add-on, atomically.
 *
 * CALLED INSIDE THE CALLER'S TRANSACTION, together with the base cancellation
 * result. That is the crash-safety boundary: if the process dies between the
 * base provider call and this write, reconciliation observes a cancelled base
 * with no obligations and creates them; if it dies after this write, the
 * worker resumes them. There is no window in which the base is cancelled and
 * the intent to stop its dependants exists nowhere.
 *
 * Idempotent: an add-on that already carries an unresolved obligation is left
 * exactly as it is, so a repeated request neither duplicates the obligation nor
 * resets its attempt count.
 */
export async function recordDependentCancellationObligations(
  input: {
    ownerUserId: string;
    teamId: string | null;
    triggeredBySubscriptionId: string;
    now?: Date;
  },
  client: Pick<prismaPkg.Prisma.TransactionClient, "workspaceStorageAddon">,
): Promise<{ created: number; alreadyOpen: number }> {
  const now = input.now ?? new Date();

  const live = await client.workspaceStorageAddon.findMany({
    where: dependentAddonWhere(input),
    select: { id: true, dependentCancellationState: true },
  });

  const fresh = live.filter((a) => a.dependentCancellationState === S.NONE);
  const alreadyOpen = live.filter(
    (a) =>
      a.dependentCancellationState !== S.NONE &&
      a.dependentCancellationState !== S.CONFIRMED,
  );

  if (fresh.length > 0) {
    await client.workspaceStorageAddon.updateMany({
      where: { id: { in: fresh.map((a) => a.id) } },
      data: {
        dependentCancellationState: S.PENDING,
        dependentCancellationRequestedAtUtc: now,
        dependentCancellationTriggeredBySubscriptionId:
          input.triggeredBySubscriptionId,
        // Due immediately: the request itself makes the first attempt, and if
        // the process dies before it does, the worker picks it up at once.
        dependentCancellationNextRetryAtUtc: now,
        dependentCancellationReasonCode: null,
      },
    });
  }

  return { created: fresh.length, alreadyOpen: alreadyOpen.length };
}

export type ObligationAttemptResult = {
  attempted: number;
  confirmed: number;
  failed: number;
  escalated: number;
};

/**
 * Attempt every unresolved obligation for ONE billing subject.
 *
 * Used by the cancellation request (immediately after recording the
 * obligations), by the customer's dedicated retry action, by the worker, and
 * by reconciliation. One implementation, so a retry from any of them means the
 * same thing.
 */
export async function attemptDependentCancellations(input: {
  ownerUserId: string;
  teamId: string | null;
  cancelAtProvider?: StorageAddonProviderCanceller;
  now?: Date;
  /** Only attempt obligations whose retry time has arrived. */
  dueOnly?: boolean;
  limit?: number;
}): Promise<ObligationAttemptResult> {
  const now = input.now ?? new Date();

  const candidates = await prisma.workspaceStorageAddon.findMany({
    where: {
      ...(input.teamId
        ? { teamId: input.teamId }
        : { ownerUserId: input.ownerUserId, teamId: null }),
      dependentCancellationState: { in: [...UNRESOLVED_STATES] },
      ...(input.dueOnly
        ? { dependentCancellationNextRetryAtUtc: { lte: now } }
        : {}),
    },
    orderBy: { dependentCancellationNextRetryAtUtc: "asc" },
    take: input.limit ?? 25,
    select: {
      id: true,
      paymentProvider: true,
      externalSubscriptionId: true,
      dependentCancellationAttemptCount: true,
    },
  });

  const result: ObligationAttemptResult = {
    attempted: 0,
    confirmed: 0,
    failed: 0,
    escalated: 0,
  };

  for (const addon of candidates) {
    // THE DURABLE LEASE. A conditional update is the claim: only one worker's
    // `updateMany` can match an unleased row, so a second worker — or the
    // customer's retry racing the sweep — finds nothing and moves on.
    const claimed = await prisma.workspaceStorageAddon.updateMany({
      where: {
        id: addon.id,
        dependentCancellationState: { in: [...UNRESOLVED_STATES] },
        OR: [
          { dependentCancellationLeaseUntilUtc: null },
          { dependentCancellationLeaseUntilUtc: { lt: now } },
        ],
      },
      data: {
        dependentCancellationLeaseUntilUtc: new Date(
          now.getTime() + LEASE_MINUTES * 60_000,
        ),
      },
    });
    if (claimed.count !== 1) continue;

    result.attempted += 1;
    const attemptCount = addon.dependentCancellationAttemptCount + 1;

    const outcome = await cancelStorageAddonAtProvider({
      provider: addon.paymentProvider ?? prismaPkg.PaymentProvider.STRIPE,
      providerRef: addon.externalSubscriptionId,
      cancelAtProvider: input.cancelAtProvider,
    });

    if (outcome.ok) {
      await prisma.workspaceStorageAddon.update({
        where: { id: addon.id },
        data: {
          dependentCancellationState: S.CONFIRMED,
          dependentCancellationConfirmedAtUtc: now,
          dependentCancellationAttemptCount: attemptCount,
          dependentCancellationNextRetryAtUtc: null,
          dependentCancellationReasonCode: null,
          dependentCancellationLeaseUntilUtc: null,
          canceledAtUtc: now,
          // Only a TERMINAL provider statement ends the capacity. A period-end
          // schedule leaves the add-on ACTIVE, because the customer has paid
          // for this month and the terminal transition is the provider's to
          // make, by webhook or by reconciliation.
          ...(outcome.terminal
            ? { status: prismaPkg.WorkspaceStorageAddonStatus.CANCELED }
            : {}),
        },
      });
      result.confirmed += 1;
      continue;
    }

    const escalate = attemptCount >= MAX_FAST_ATTEMPTS;
    await prisma.workspaceStorageAddon.update({
      where: { id: addon.id },
      data: {
        // ACTION_REQUIRED while fast retries remain — the customer can see it
        // and the retry is coming. MANUAL_INTERVENTION once they are spent:
        // still charging, still escalated, still retried daily. Never
        // abandoned, and never marked resolved without provider truth.
        dependentCancellationState: escalate
          ? S.MANUAL_INTERVENTION
          : S.RETRY_SCHEDULED,
        dependentCancellationFailedAtUtc: now,
        dependentCancellationAttemptCount: attemptCount,
        dependentCancellationNextRetryAtUtc: nextRetryAt(attemptCount, now),
        dependentCancellationReasonCode: escalate
          ? ("RETRY_EXHAUSTED" satisfies AddonCancellationReasonCode)
          : outcome.reasonCode,
        dependentCancellationLeaseUntilUtc: null,
      },
    });
    result.failed += 1;
    if (escalate) result.escalated += 1;
  }

  return result;
}

/**
 * Mark an obligation CONFIRMED from an independent provider observation.
 *
 * Reconciliation calls this when the provider itself reports the add-on
 * subscription is cancelled or scheduled to cancel — which is a stronger proof
 * than our own call succeeding, and the reason a customer whose retry never
 * worked still converges once the provider agrees.
 */
export async function confirmObligationFromProviderTruth(input: {
  addonId: string;
  observedAtUtc: Date;
}): Promise<boolean> {
  const updated = await prisma.workspaceStorageAddon.updateMany({
    where: {
      id: input.addonId,
      dependentCancellationState: { in: [...UNRESOLVED_STATES] },
      // ORDERING. An observation older than the state already recorded cannot
      // resolve it, which is what stops a slow poll confirming a cancellation
      // that a newer observation has already shown to be live again.
      OR: [
        { providerStateAtUtc: null },
        { providerStateAtUtc: { lte: input.observedAtUtc } },
      ],
    },
    data: {
      dependentCancellationState: S.CONFIRMED,
      dependentCancellationConfirmedAtUtc: input.observedAtUtc,
      dependentCancellationNextRetryAtUtc: null,
      dependentCancellationReasonCode: null,
      dependentCancellationLeaseUntilUtc: null,
    },
  });
  return updated.count === 1;
}

/**
 * Reopen a CONFIRMED obligation the provider now says is live again.
 *
 * Confirmation is a statement about a moment, not a promise about the future.
 * A subscription that reappears as active — a provider-side reinstatement, a
 * failed cancellation that reported success — must become an obligation again
 * rather than staying quietly closed.
 */
export async function reopenObligationFromProviderTruth(input: {
  addonId: string;
  observedAtUtc: Date;
}): Promise<boolean> {
  const updated = await prisma.workspaceStorageAddon.updateMany({
    where: {
      id: input.addonId,
      dependentCancellationState: S.CONFIRMED,
      OR: [
        { providerStateAtUtc: null },
        { providerStateAtUtc: { lte: input.observedAtUtc } },
      ],
    },
    data: {
      dependentCancellationState: S.ACTION_REQUIRED,
      dependentCancellationFailedAtUtc: input.observedAtUtc,
      dependentCancellationNextRetryAtUtc: input.observedAtUtc,
      dependentCancellationConfirmedAtUtc: null,
      dependentCancellationReasonCode:
        "PROVIDER_STATE_MISMATCH" satisfies AddonCancellationReasonCode,
    },
  });
  return updated.count === 1;
}

/** The safe, client-facing summary of one account's outstanding obligations. */
export type DependentCancellationSummary = {
  status: prismaPkg.DependentCancellationState;
  affectedCount: number;
  lastAttemptAtUtc: string | null;
  nextRetryAtUtc: string | null;
  actionAvailable: boolean;
  supportRequired: boolean;
};

/**
 * Summarise one billing subject's outstanding obligations.
 *
 * Counts and timestamps only. No add-on id, no provider id, no reason code, no
 * error text — this is rendered verbatim by the Billing page, so anything
 * unsafe here would be unsafe on screen.
 */
export async function summarizeDependentCancellations(input: {
  ownerUserId: string;
  teamId: string | null;
}): Promise<DependentCancellationSummary | null> {
  const rows = await prisma.workspaceStorageAddon.findMany({
    where: {
      ...(input.teamId
        ? { teamId: input.teamId }
        : { ownerUserId: input.ownerUserId, teamId: null }),
      dependentCancellationState: { in: [...UNRESOLVED_STATES] },
    },
    select: {
      dependentCancellationState: true,
      dependentCancellationFailedAtUtc: true,
      dependentCancellationNextRetryAtUtc: true,
    },
  });

  if (rows.length === 0) return null;

  const supportRequired = rows.some(
    (r) => r.dependentCancellationState === S.MANUAL_INTERVENTION,
  );
  const lastAttempt = rows
    .map((r) => r.dependentCancellationFailedAtUtc)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const nextRetry = rows
    .map((r) => r.dependentCancellationNextRetryAtUtc)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return {
    // The most urgent state governs the summary: one add-on needing a human
    // is the fact the customer has to know, whatever the others are doing.
    status: supportRequired
      ? S.MANUAL_INTERVENTION
      : rows.some((r) => r.dependentCancellationState === S.ACTION_REQUIRED)
        ? S.ACTION_REQUIRED
        : rows.some((r) => r.dependentCancellationState === S.RETRY_SCHEDULED)
          ? S.RETRY_SCHEDULED
          : S.PENDING,
    affectedCount: rows.length,
    lastAttemptAtUtc: lastAttempt?.toISOString() ?? null,
    nextRetryAtUtc: nextRetry?.toISOString() ?? null,
    actionAvailable: true,
    supportRequired,
  };
}
