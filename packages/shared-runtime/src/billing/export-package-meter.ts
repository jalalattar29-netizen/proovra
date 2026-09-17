/**
 * THE export-package monthly meter — the ONE writer of
 * `QUOTA_EXPORT_PACKAGES_PER_MONTH` consumption, and the entitlement period
 * clock its reader uses.
 *
 * WHY IT LIVES HERE. An exchange package becomes READY in the Worker
 * (`buildExchangePackage`, the builder that produces the artifact for every
 * package the product creates). The writer used to live in the API's
 * `entitlement.service.ts`, which the Worker may not import (the service build
 * boundary), so the Worker's READY step — the one every real package goes
 * through — recorded no usage at all and the monthly quota could not trip.
 * (The API's explicit completion path, `markPackageReady`, was removed with its
 * retired route on 2026-09-17.)
 *
 * WHY THE PERIOD CLOCK MOVED WITH IT. The reader (`assertQuotaEntitlement` in
 * the API) and this writer must name the same period row. Both now derive it
 * from `classifyEntitlementPeriod` / `entitlementPeriodStart` below, so gate
 * and meter still read ONE clock.
 *
 * IT THROWS. Callers invoke it inside the same transaction as the conditional
 * transition to READY; a swallowed failure there would commit READY with no
 * meter, and a retry would find no DRAFT/BUILDING row to transition — the
 * package would stay unmetered forever. A throw rolls the transition back.
 */

export type EntitlementPeriod = "DAY" | "MONTH";

/** The period an entitlement key is metered over. */
export function classifyEntitlementPeriod(key: string): EntitlementPeriod {
  if (key.endsWith("PER_DAY")) return "DAY";
  if (key.endsWith("PER_MONTH")) return "MONTH";
  return "MONTH";
}

/** The UTC start of the period containing `now`. */
export function entitlementPeriodStart(
  period: EntitlementPeriod,
  now: Date = new Date(),
): Date {
  if (period === "DAY") {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
    );
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

export const EXPORT_PACKAGE_METER_KEY = "QUOTA_EXPORT_PACKAGES_PER_MONTH" as const;

/**
 * Structural client: a `PrismaClient` or an interactive-transaction client
 * from either host, without importing either host's generated types.
 */
export type ExportPackageMeterClient = {
  entitlementUsage: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert: (args: any) => PromiseLike<unknown>;
  };
};

export async function recordExportPackageUsage(input: {
  prisma: ExportPackageMeterClient;
  teamId: string;
  amount?: number;
}): Promise<void> {
  const key = EXPORT_PACKAGE_METER_KEY;
  const start = entitlementPeriodStart(classifyEntitlementPeriod(key));
  const amount = BigInt(Math.max(0, Math.floor(input.amount ?? 1)));
  if (amount === 0n) return;
  /*
   * The upsert is the idempotency mechanism for the PERIOD ROW, not for the
   * package: `(teamId, key, periodStartUtc)` is unique, so concurrent first
   * writes in the same month cannot both insert. What makes it exactly-once
   * PER PACKAGE is the caller's conditional transition — only the transaction
   * that actually moved the package to READY gets here.
   */
  await input.prisma.entitlementUsage.upsert({
    where: {
      teamId_key_periodStartUtc: {
        teamId: input.teamId,
        key,
        periodStartUtc: start,
      },
    },
    create: {
      teamId: input.teamId,
      key,
      periodStartUtc: start,
      consumed: amount,
    },
    update: { consumed: { increment: amount } },
  });
}
