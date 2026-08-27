/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — THE evidence-credit wallet.
 *
 * The defect this closes
 * ---------------------------------------------------------------------------
 * A paid PAYG purchase called `addCredits(userId, 1)` and left the account on
 * FREE, because no production path ever writes `entitlements.plan = 'PAYG'`.
 * On FREE, `paygCreditsRequiredPerCompletion` is 0, so the credit-spend branch
 * of the evidence gate was unreachable: at three records the buyer was refused
 * with `FREE_LIMIT_REACHED` while holding paid, unspendable credits.
 *
 * Separately, `consumeWorkspaceCompletionCredits` was invoked from INSIDE the
 * evidence-completion transaction but against the GLOBAL prisma client, so the
 * decrement was not part of that transaction: a completion that rolled back
 * still burned the credit. And `entitlements.credits` is a bare integer with
 * no history, so neither a double-spend nor a lost credit was detectable
 * afterwards.
 *
 * The model
 * ---------------------------------------------------------------------------
 * A credit wallet layered over the Personal FREE account. `PLAN_CAPABILITIES`
 * remains the plan authority; this module owns exactly one quantity — how many
 * purchased evidence completions an account has left — and the ledger that
 * proves every movement of it.
 *
 *   `entitlements.credits`             the fast balance the enforcement path
 *                                      reads and decrements CONDITIONALLY.
 *   `evidence_credit_ledger_entries`   the immutable history that proves it.
 *
 * Both are written in the SAME transaction, always. The ledger's UNIQUE
 * `evidence_id` is the double-spend guard: two concurrent completions for one
 * record may both pass the balance check, but only one can insert, and the
 * loser's transaction — decrement included — rolls back.
 *
 * Consumption order is fixed by `resolvePersonalEvidenceAdmission` in
 * @proovra/shared-billing: the plan allowance is always spent before a paid
 * credit.
 */

import * as prismaPkg from "@prisma/client";
import {
  EVIDENCE_CREDIT_PRODUCT,
  type EvidenceFundingSource,
} from "@proovra/shared-billing";

import { prisma } from "../../db.js";
import { DomainError } from "../../errors.js";

/**
 * Structural transaction client. Accepts the global client or a Prisma
 * interactive-transaction client, so every caller can bind wallet movement to
 * its own atomic unit of work.
 */
export type EvidenceCreditClient = Pick<
  prismaPkg.Prisma.TransactionClient,
  "entitlement" | "evidenceCreditLedgerEntry"
>;

const P2002_UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === P2002_UNIQUE_VIOLATION
  );
}

export type EvidenceCreditWallet = {
  /** Unspent purchased credits. The value the admission decision reads. */
  availableCredits: number;
  /** Lifetime credits purchased (sum of PURCHASE entries). */
  purchasedCredits: number;
  /** Lifetime credits spent on completions (absolute sum of CONSUMPTION). */
  consumedCredits: number;
  /**
   * True when the wallet has ledger history. A `false` here with a positive
   * balance means the balance predates the ledger (an opening balance carried
   * over by the migration), which the Billing projection states honestly
   * rather than reporting a fabricated purchase history.
   */
  hasLedgerHistory: boolean;
};

/**
 * Read the wallet for one account.
 *
 * `availableCredits` comes from `entitlements.credits` — the column the
 * conditional decrement actually guards — and never from a ledger sum, so the
 * number shown is the number that will be enforced.
 */
export async function readEvidenceCreditWallet(
  userId: string,
): Promise<EvidenceCreditWallet> {
  const [entitlement, grouped] = await Promise.all([
    prisma.entitlement.findFirst({
      where: { userId, active: true },
      orderBy: { createdAt: "desc" },
      select: { credits: true },
    }),
    prisma.evidenceCreditLedgerEntry.groupBy({
      by: ["entryType"],
      where: { userId },
      _sum: { creditsDelta: true },
    }),
  ]);

  let purchased = 0;
  let consumed = 0;
  for (const row of grouped) {
    const sum = row._sum.creditsDelta ?? 0;
    if (row.entryType === prismaPkg.EvidenceCreditEntryType.CONSUMPTION) {
      consumed += Math.abs(sum);
    } else {
      // PURCHASE and REVERSAL both add credits back to the wallet.
      purchased += sum;
    }
  }

  return {
    availableCredits: Math.max(0, entitlement?.credits ?? 0),
    purchasedCredits: purchased,
    consumedCredits: consumed,
    hasLedgerHistory: grouped.length > 0,
  };
}

/**
 * Grant purchased evidence credits.
 *
 * Idempotent on `(provider, providerRef)`: the partial unique index on PURCHASE
 * rows makes a second grant for the same provider payment a no-op rather than
 * a double credit. Webhook delivery is already deduplicated by the unique
 * provider event id; this is the second line, at the database.
 *
 * Called ONLY from a verified provider webhook. Nothing here accepts a
 * client-declared credit count.
 */
export async function grantEvidenceCredits(params: {
  userId: string;
  credits: number;
  provider: prismaPkg.PaymentProvider;
  providerRef: string;
}): Promise<{ granted: boolean; balanceAfter: number }> {
  const credits = Math.max(0, Math.floor(params.credits));
  if (credits === 0) {
    const wallet = await readEvidenceCreditWallet(params.userId);
    return { granted: false, balanceAfter: wallet.availableCredits };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.evidenceCreditLedgerEntry.findFirst({
        where: {
          entryType: prismaPkg.EvidenceCreditEntryType.PURCHASE,
          provider: params.provider,
          providerRef: params.providerRef,
        },
        select: { balanceAfter: true },
      });
      if (existing) {
        return { granted: false, balanceAfter: existing.balanceAfter };
      }

      const entitlement = await tx.entitlement.findFirst({
        where: { userId: params.userId, active: true },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (!entitlement) {
        // `ensureEntitlement` runs before every grant call site; a missing row
        // here means the account was removed mid-flight. Fail closed rather
        // than creating an entitlement from a webhook.
        throw new DomainError("No active entitlement for credit grant", {
          httpStatus: 409,
          publicCode: "ENTITLEMENT_NOT_FOUND",
          publicMessage: "This account cannot receive evidence credits.",
          reportability: "OPERATIONAL_WARNING",
          severity: "warning",
        });
      }

      const updated = await tx.entitlement.update({
        where: { id: entitlement.id },
        data: { credits: { increment: credits } },
        select: { credits: true },
      });

      await tx.evidenceCreditLedgerEntry.create({
        data: {
          userId: params.userId,
          entryType: prismaPkg.EvidenceCreditEntryType.PURCHASE,
          creditsDelta: credits,
          provider: params.provider,
          providerRef: params.providerRef,
          balanceAfter: updated.credits,
        },
      });

      return { granted: true, balanceAfter: updated.credits };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Concurrent delivery of the same provider payment won the race.
      const wallet = await readEvidenceCreditWallet(params.userId);
      return { granted: false, balanceAfter: wallet.availableCredits };
    }
    throw err;
  }
}

/**
 * Consume ONE credit for a completed Evidence record.
 *
 * MUST be called with the same transaction client as the completion write, so
 * a rolled-back completion rolls back the spend. Calling it against the global
 * client is exactly the defect this replaces.
 *
 * Returns `alreadyConsumed: true` when this Evidence record has already spent
 * a credit — the idempotent-retry path. A retried or re-delivered completion
 * for one record can never burn a second credit, because `evidence_id` is
 * unique in the ledger.
 */
export async function consumeEvidenceCreditForCompletion(
  params: { userId: string; evidenceId: string },
  client: EvidenceCreditClient,
): Promise<{ consumed: boolean; alreadyConsumed: boolean; balanceAfter: number }> {
  const existing = await client.evidenceCreditLedgerEntry.findUnique({
    where: { evidenceId: params.evidenceId },
    select: { balanceAfter: true, entryType: true },
  });
  if (existing && existing.entryType === prismaPkg.EvidenceCreditEntryType.CONSUMPTION) {
    return {
      consumed: false,
      alreadyConsumed: true,
      balanceAfter: existing.balanceAfter,
    };
  }

  const required = EVIDENCE_CREDIT_PRODUCT.creditsPerCompletion;

  // THE atomic guard. `credits: { gte: required }` in the WHERE makes the
  // decrement conditional at the database, so two concurrent transactions
  // cannot both take the last credit — the second matches zero rows.
  const decremented = await client.entitlement.updateMany({
    where: { userId: params.userId, active: true, credits: { gte: required } },
    data: { credits: { decrement: required } },
  });

  if (decremented.count !== 1) {
    throw new DomainError("Insufficient evidence credits", {
      httpStatus: 402,
      publicCode: "INSUFFICIENT_EVIDENCE_CREDITS",
      publicMessage:
        "You have used your included records and have no evidence credits left. Buy more to continue.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
      metadata: { limitKind: "evidence_credits" },
    });
  }

  const entitlement = await client.entitlement.findFirst({
    where: { userId: params.userId, active: true },
    orderBy: { createdAt: "desc" },
    select: { credits: true },
  });
  const balanceAfter = Math.max(0, entitlement?.credits ?? 0);

  // The unique `evidence_id` makes this the serialization point: if a
  // concurrent transaction already inserted for this record, this INSERT
  // raises P2002 and the whole transaction — decrement included — rolls back.
  await client.evidenceCreditLedgerEntry.create({
    data: {
      userId: params.userId,
      entryType: prismaPkg.EvidenceCreditEntryType.CONSUMPTION,
      creditsDelta: -required,
      evidenceId: params.evidenceId,
      balanceAfter,
    },
  });

  return { consumed: true, alreadyConsumed: false, balanceAfter };
}

/**
 * How ONE Evidence record's completion was funded.
 *
 * The ledger is the authority: a CONSUMPTION entry for the record means the
 * record was paid for with a credit, and therefore earns the paid outputs
 * (report, verification package, public verify) regardless of the account's
 * recurring plan. Absence means the plan allowance covered it.
 *
 * Used by the API and — through the worker's own thin reader — by the report
 * and verification-package pipelines, so both hosts answer the question from
 * the same row.
 */
export async function resolveEvidenceFunding(
  evidenceId: string,
): Promise<EvidenceFundingSource> {
  const entry = await prisma.evidenceCreditLedgerEntry.findUnique({
    where: { evidenceId },
    select: { entryType: true },
  });
  return entry?.entryType === prismaPkg.EvidenceCreditEntryType.CONSUMPTION
    ? "EVIDENCE_CREDIT"
    : "PLAN";
}

/**
 * Bulk variant for list projections. One query, no N+1.
 */
export async function resolveEvidenceFundingMany(
  evidenceIds: readonly string[],
): Promise<Map<string, EvidenceFundingSource>> {
  const out = new Map<string, EvidenceFundingSource>();
  if (evidenceIds.length === 0) return out;

  const rows = await prisma.evidenceCreditLedgerEntry.findMany({
    where: {
      evidenceId: { in: [...evidenceIds] },
      entryType: prismaPkg.EvidenceCreditEntryType.CONSUMPTION,
    },
    select: { evidenceId: true },
  });

  for (const id of evidenceIds) out.set(id, "PLAN");
  for (const row of rows) {
    if (row.evidenceId) out.set(row.evidenceId, "EVIDENCE_CREDIT");
  }
  return out;
}
