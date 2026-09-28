/**
 * BILLING (2026-09-28) — READ-ONLY verifier for the two historical PayPal
 * storage attempts named in the billing incident audit:
 *
 *   a2cc1107-cf53-4b74-9cda-9a93dcbe6555  /  I-4P6XLPVJEMBK
 *   b5c641a3-4e54-45a5-9743-a9627189ec1e  /  I-X3KCTML39FWX
 *
 * What it does:
 *   1. SELECTs each local row (storage add-on attempt) and prints its status,
 *      checkout state, provider binding and whether any payment references it;
 *   2. with `--provider`, performs ONE PayPal GET per subscription (a read)
 *      and prints the HTTP outcome and provider status;
 *   3. prints the canonical next step, which it does NOT perform.
 *
 * What it never does: write a row, cancel or create anything at PayPal, mark
 * anything paid or abandoned, or grant capacity. Any disposition must be the
 * account owner's per-attempt action (Billing activity → Check status, then
 * Abandon) on a deployment that carries the repaired endpoints, which re-checks
 * the provider first.
 *
 *   pnpm --filter proovra-api exec tsx src/scripts/verify-historical-billing-attempts.ts [--provider]
 */

import { prisma } from "../db.js";
import { getPayPalSubscription, PayPalHttpError } from "../services/paypal.service.js";

export const HISTORICAL_ATTEMPTS = [
  { attemptId: "a2cc1107-cf53-4b74-9cda-9a93dcbe6555", providerRef: "I-4P6XLPVJEMBK" },
  { attemptId: "b5c641a3-4e54-45a5-9743-a9627189ec1e", providerRef: "I-X3KCTML39FWX" },
] as const;

const REFUSED_FLAGS = ["--apply", "--write", "--abandon", "--cancel", "--fix"];

async function providerRead(ref: string): Promise<Record<string, unknown>> {
  try {
    const sub = await getPayPalSubscription(ref);
    return { httpStatus: 200, providerStatus: String(sub.status ?? "UNKNOWN") };
  } catch (err) {
    if (err instanceof PayPalHttpError) {
      return { httpStatus: err.status, providerErrorName: err.providerErrorName, debugId: err.debugId };
    }
    return { httpStatus: null, error: "PROVIDER_UNREACHABLE" };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const refused = args.filter((a) => REFUSED_FLAGS.includes(a));
  if (refused.length > 0) {
    console.error(`Refused ${refused.join(", ")}: this verifier is read-only by design.`);
    process.exitCode = 2;
    return;
  }
  const withProvider = args.includes("--provider");

  for (const h of HISTORICAL_ATTEMPTS) {
    const row = await prisma.workspaceStorageAddon.findUnique({
      where: { id: h.attemptId },
      select: {
        id: true,
        ownerUserId: true,
        teamId: true,
        addonKey: true,
        status: true,
        paymentProvider: true,
        externalSubscriptionId: true,
        activatedAtUtc: true,
        amountCents: true,
        currency: true,
        createdAt: true,
        metadata: true,
      },
    });
    const payments = row
      ? await prisma.payment.count({
          where: { OR: [{ providerPaymentId: h.providerRef }, { providerPaymentId: h.attemptId }] },
        })
      : 0;
    const meta = (row?.metadata ?? {}) as Record<string, unknown>;
    const report = {
      attemptId: h.attemptId,
      found: Boolean(row),
      local: row
        ? {
            status: row.status,
            checkoutState: typeof meta.checkoutState === "string" ? meta.checkoutState : null,
            provider: row.paymentProvider,
            boundToExpectedProviderRef: row.externalSubscriptionId === h.providerRef,
            activated: Boolean(row.activatedAtUtc),
            workspaceScoped: row.teamId !== null,
            amountCents: row.amountCents,
            currency: row.currency,
            createdAtUtc: row.createdAt.toISOString(),
          }
        : null,
      paymentsReferencingIt: payments,
      provider: withProvider ? await providerRead(h.providerRef) : "not read (pass --provider)",
      canonicalNextStep: !row
        ? "Not in this database — check you are pointed at the intended environment. Nothing to do here."
        : row.status === "PENDING"
          ? "Owner: Billing activity → Check status (provider-first). Only if PayPal still cannot confirm it: Abandon, confirm. Never delete, mark paid or grant."
          : "No action: the row is not PENDING.",
    };
    console.log(JSON.stringify(report, null, 2));
  }
}

main()
  .catch((err) => {
    console.error("verifier failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
