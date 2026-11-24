/**
 * Stage C (team remediation, T-047 / T-050 / T-044) — DRY-RUN BY DEFAULT repair of
 * stored review SLA and escalation facts. See
 * services/reviewer-ops/review-sla-truth-repair.service.ts for exactly what is
 * changed (and that no decision, status or escalation status ever is).
 *
 * USAGE:
 *   tsx src/scripts/repair-review-sla-truth.ts                 # dry run: lists changes
 *   tsx src/scripts/repair-review-sla-truth.ts --team <id>     # one workspace
 *   tsx src/scripts/repair-review-sla-truth.ts --apply         # write + audit (operator-approved)
 *
 * Idempotent: a second run finds nothing to change. Rollback: the output lists
 * before/after per workflow; the tenant audit rows
 * `reviewer.review.sla_truth_repair` carry the same.
 */

import { prisma } from "../db.js";
import { repairReviewSlaTruth } from "../services/reviewer-ops/review-sla-truth-repair.service.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const teamId = arg("team") ?? undefined;
  const result = await repairReviewSlaTruth({ apply, teamId }, prisma);
  console.log(
    JSON.stringify(
      {
        script: "repair-review-sla-truth",
        ...result,
        byKind: result.changes.reduce<Record<string, number>>((acc, c) => {
          acc[c.kind] = (acc[c.kind] ?? 0) + 1;
          return acc;
        }, {}),
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
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
