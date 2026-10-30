/**
 * BILLING REMEDIATION (2026-10-30, AUD-05, AUD-29) — money a provider returned.
 *
 * A payment status can only say "refunded". It cannot say how much, it cannot
 * tell a redelivered partial refund from a second one, and it let two partial
 * refunds of a capture read as two reviews with nothing adding up. Each provider
 * movement is one append-only row keyed by the provider's own identity. The
 * payment's `refundedAmountCents` is their sum, written in the same transaction
 * under a row lock, and `status` reads REFUNDED only when all of it came back.
 * `amountCents` is never edited: the original charge stays visible.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";

export type PaymentAdjustmentKind = "REFUND" | "REVERSAL";

export type PaymentAdjustmentResult = {
  /** False when this provider movement was already recorded. */
  applied: boolean;
  refundedAmountCents: number;
  /** All of the original amount has been returned. */
  fullyRefunded: boolean;
};

/**
 * Record ONE provider movement. Idempotent on (provider, providerAdjustmentId).
 *
 * `cumulativeCents` is for a provider that reports a running total (Stripe's
 * `amount_refunded`): the delta is taken under the lock, so two deliveries of
 * different totals cannot both add their whole value.
 */
export async function applyPaymentAdjustment(input: {
  paymentId: string;
  provider: prismaPkg.PaymentProvider;
  providerAdjustmentId: string;
  kind: PaymentAdjustmentKind;
  amountCents?: number;
  cumulativeCents?: number;
  currency: string;
  observedAtUtc?: Date | null;
}): Promise<PaymentAdjustmentResult> {
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ amount_cents: number; refunded_amount_cents: number }>>`
      SELECT amount_cents, refunded_amount_cents FROM payments WHERE id = ${input.paymentId}::uuid FOR UPDATE
    `;
    if (!locked) throw new Error("Payment disappeared while recording an adjustment");
    const before = locked.refunded_amount_cents;
    const settled = (refunded: number, applied: boolean): PaymentAdjustmentResult => ({
      applied,
      refundedAmountCents: refunded,
      fullyRefunded: refunded >= locked.amount_cents,
    });

    const seen = await tx.paymentAdjustment.findUnique({
      where: {
        provider_providerAdjustmentId: {
          provider: input.provider,
          providerAdjustmentId: input.providerAdjustmentId,
        },
      },
      select: { id: true },
    });
    if (seen) return settled(before, false);

    const delta = Math.max(
      0,
      input.cumulativeCents !== undefined ? input.cumulativeCents - before : (input.amountCents ?? 0),
    );
    // An older running total delivered late: nothing new moved.
    if (delta === 0 && input.cumulativeCents !== undefined) return settled(before, false);

    await tx.paymentAdjustment.create({
      data: {
        paymentId: input.paymentId,
        provider: input.provider,
        providerAdjustmentId: input.providerAdjustmentId,
        kind: input.kind,
        amountCents: delta,
        currency: input.currency,
        observedAtUtc: input.observedAtUtc ?? null,
      },
    });
    const refunded = Math.min(locked.amount_cents, before + delta);
    await tx.payment.update({
      where: { id: input.paymentId },
      data: {
        refundedAmountCents: refunded,
        ...(refunded >= locked.amount_cents ? { status: prismaPkg.PaymentStatus.REFUNDED } : {}),
      },
    });
    return settled(refunded, true);
  });
}
