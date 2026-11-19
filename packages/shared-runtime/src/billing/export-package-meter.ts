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

/**
 * Structural raw-SQL client for the reservation pair below (a `PrismaClient`
 * or an interactive transaction from either host).
 */
export type ExportPackageReservationClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $queryRaw: (query: TemplateStringsArray, ...values: any[]) => PromiseLike<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $executeRaw: (query: TemplateStringsArray, ...values: any[]) => PromiseLike<unknown>;
};

/**
 * WS-SCHED / PRO-BL2-02 — RESERVE one export-package unit at admission.
 *
 * The gate used to READ `entitlement_usage` and the worker wrote it only at
 * READY, so every build in flight was uncounted and N concurrent requests at
 * `limit - 1` all passed. This is ONE conditional statement (the shape
 * `reserveWorkspaceAiOperation` uses): the row is created at 1 or incremented
 * only while `consumed < limit`, so concurrent requests at `limit - 1` admit
 * exactly one. A limit of zero or less never admits.
 *
 * The package that holds the reservation records the returned period
 * (`quota_reserved_period_start_utc`), and the worker's READY step does NOT
 * meter it again; a build that fails or a package revoked before READY gives
 * the unit back through `releaseExportPackageUnit`.
 */
export async function reserveExportPackageUnit(input: {
  prisma: ExportPackageReservationClient;
  teamId: string;
  limit: number;
  now?: Date;
}): Promise<{ reserved: true; periodStartUtc: Date } | { reserved: false }> {
  const limit = Math.floor(input.limit);
  if (!Number.isFinite(limit) || limit <= 0) return { reserved: false };
  const key = EXPORT_PACKAGE_METER_KEY;
  const start = entitlementPeriodStart(classifyEntitlementPeriod(key), input.now);
  const rows = (await input.prisma.$queryRaw`
    INSERT INTO entitlement_usage (id, team_id, key, period_start_utc, consumed, updated_at)
    VALUES (gen_random_uuid(), ${input.teamId}::uuid, ${key}, ${start}, 1, now())
    ON CONFLICT (team_id, key, period_start_utc)
    DO UPDATE SET consumed = entitlement_usage.consumed + 1, updated_at = now()
    WHERE entitlement_usage.consumed < ${BigInt(limit)}
    RETURNING consumed`) as unknown[];
  if (!Array.isArray(rows) || rows.length === 0) return { reserved: false };
  return { reserved: true, periodStartUtc: start };
}

/** Give back one reserved unit of the named period. Never below zero. */
export async function releaseExportPackageUnit(input: {
  prisma: ExportPackageReservationClient;
  teamId: string;
  periodStartUtc: Date;
}): Promise<void> {
  await input.prisma.$executeRaw`
    UPDATE entitlement_usage
       SET consumed = consumed - 1, updated_at = now()
     WHERE team_id = ${input.teamId}::uuid
       AND key = ${EXPORT_PACKAGE_METER_KEY}
       AND period_start_utc = ${input.periodStartUtc}
       AND consumed > 0`;
}

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
