/**
 * Review remediation (2026-11-27) — scoped, idempotent reconciliation of
 * existing Review records. DRY RUN by default (prints counts and sample ids per
 * category; changes nothing).
 *
 *   pnpm --filter proovra-api ops:review-remediation-reconcile
 *   pnpm --filter proovra-api ops:review-remediation-reconcile --team <uuid>
 *   pnpm --filter proovra-api ops:review-remediation-reconcile --apply legacy_integrity_escalations,escalated_by_backfill
 *
 * `legacy_administrative_escalations` changes what existing escalations mean
 * (they stop forcing an independent second decision for rounds with no FIRST
 * decision yet). Apply it only with the owner's approval of the listed scope.
 * Report-only categories cannot be applied. See the service for compensation.
 */
import { prisma } from "../db.js";
import {
  REVIEW_REMEDIATION_CATEGORIES,
  reconcileReviewRemediation,
  type ReviewRemediationCategory,
} from "../services/reviewer-ops/review-remediation-reconcile.service.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main(): Promise<void> {
  const applyRaw = arg("apply");
  const apply = (applyRaw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as ReviewRemediationCategory[];
  const unknown = apply.filter((c) => !(REVIEW_REMEDIATION_CATEGORIES as ReadonlyArray<string>).includes(c));
  if (unknown.length > 0) {
    console.error(`Unknown categories: ${unknown.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const report = await reconcileReviewRemediation({ apply, teamId: arg("team") }, prisma);
  console.log(
    JSON.stringify({ script: "review-remediation-reconcile", ...report, timestamp: new Date().toISOString() }, null, 2),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
