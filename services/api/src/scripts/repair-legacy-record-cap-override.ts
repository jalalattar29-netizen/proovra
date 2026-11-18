/**
 * PRO-BL2-01 (WS-BILL, 2026-11-18) — DRY-RUN BY DEFAULT inventory/repair of
 * downgrade grandfathers frozen ABOVE durable history.
 *
 * Before the fix, `setPersonalPlan` froze `entitlements.legacy_record_cap_override`
 * from sealed plan-funded records PLUS live unsealed reservations. Reservations
 * release by deletion or TTL, so an override can exceed the records that
 * actually exist and grant free plan slots for life on the lower plan.
 *
 * For each active entitlement with an override on a capped plan, this computes
 * the corrected value with the SAME measure the plan writer now uses
 * (`measurePersonalPlanOccupancy`: sealed plan-funded records, under the
 * payer's capacity lock) and proposes it ONLY when it is LOWER than the stored
 * one (never raises; NULL when the history fits the plan's own cap).
 *
 * USAGE (never against production in this remediation):
 *   tsx src/scripts/repair-legacy-record-cap-override.ts            # dry run, counts + ids
 *   tsx src/scripts/repair-legacy-record-cap-override.ts --user <id> # one payer
 *   tsx src/scripts/repair-legacy-record-cap-override.ts --apply     # write (owner-approved only)
 *
 * Idempotent: a second run finds nothing to lower. Rollback: the dry-run output
 * lists before/after per entitlement id; restore those values to undo.
 * Limitation: a record already admitted on the inflated cap stays as issued.
 */

import { getPlanCapabilities } from "@proovra/shared-billing";

import { prisma } from "../db.js";
import { measurePersonalPlanOccupancy } from "../services/billing-enforcement.service.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const onlyUser = arg("user");
  const rows = await prisma.entitlement.findMany({
    where: { active: true, legacyRecordCapOverride: { not: null }, ...(onlyUser ? { userId: onlyUser } : {}) },
    select: { id: true, userId: true, plan: true, legacyRecordCapOverride: true },
  });
  const changes: Array<{ entitlementId: string; userId: string; plan: string; before: number; after: number | null }> = [];
  let examined = 0;
  for (const row of rows) {
    examined += 1;
    const cap = getPlanCapabilities(row.plan).maxEvidenceRecords;
    if (cap === null || row.legacyRecordCapOverride === null) continue;
    const before = row.legacyRecordCapOverride;
    const result = await prisma.$transaction(async (tx) => {
      const sealed = await measurePersonalPlanOccupancy(row.userId, tx as never);
      const after = sealed > cap ? sealed : null;
      // Never raise: only a strictly lower cap (or none at all) is proposed.
      const lowers = after === null || after < before;
      if (lowers && apply) {
        await tx.entitlement.updateMany({
          where: { id: row.id, legacyRecordCapOverride: before },
          data: { legacyRecordCapOverride: after },
        });
      }
      return { lowers, after };
    });
    if (result.lowers) {
      changes.push({ entitlementId: row.id, userId: row.userId, plan: String(row.plan), before, after: result.after });
    }
  }
  console.log(
    JSON.stringify(
      {
        script: "repair-legacy-record-cap-override",
        mode: apply ? "APPLY" : "DRY_RUN",
        examined,
        toLower: changes.length,
        changes,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(
      JSON.stringify({
        script: "repair-legacy-record-cap-override",
        error: err instanceof Error ? err.message.slice(0, 200) : "unknown_error",
      }),
    );
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
