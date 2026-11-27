/**
 * Review remediation (2026-11-27) — plan-bound, audited reconciliation of
 * existing Review records. See the service for the categories.
 *
 *   # 1. Plan (read-only): writes the complete plan, every affected record,
 *   #    and prints its hash.
 *   pnpm --filter proovra-api ops:review-remediation-reconcile plan --out plan.json [--team <uuid>]
 *
 *   # 2. Apply the owner-approved categories of THAT plan (hash required):
 *   pnpm --filter proovra-api ops:review-remediation-reconcile apply --plan plan.json \
 *     --plan-hash <sha256> --categories legacy_integrity_escalations,escalated_by_backfill --operator "<name>"
 *
 *   # 3. Undo exactly what that plan applied (from its audit rows):
 *   pnpm --filter proovra-api ops:review-remediation-reconcile compensate --plan plan.json \
 *     --plan-hash <sha256> --operator "<name>"
 *
 * Apply never touches a record that is not in the plan. A record whose value
 * changed since planning is reported and left alone. Every change writes a
 * durable tenant audit row (action review.remediation.reconcile.applied,
 * correlation = plan hash, operator, record, before/after). Report-only
 * categories cannot be applied. The categories that change behaviour
 * (legacy_administrative_escalations, legacy_creatorless_escalations,
 * legacy_escalated_status) need the owner's approval of the listed records.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { prisma } from "../db.js";
import {
  ReconcilePlanError,
  applyReconciliationPlan,
  buildReconciliationPlan,
  compensateReconciliationPlan,
  type ReconciliationPlan,
} from "../services/reviewer-ops/review-remediation-reconcile.service.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

function readPlan(path: string): ReconciliationPlan {
  const raw = JSON.parse(readFileSync(path, "utf8")) as ReconciliationPlan;
  return { kind: raw.kind, version: raw.version, teamId: raw.teamId ?? null, items: raw.items };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "plan" || command === undefined || command.startsWith("--")) {
    const plan = await buildReconciliationPlan({ teamId: arg("team") }, prisma);
    const out = arg("out") ?? `review-remediation-plan-${plan.planHash.slice(0, 12)}.json`;
    writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
    console.log(JSON.stringify({ script: "review-remediation-reconcile", command: "plan", planHash: plan.planHash, out, counts: plan.counts }, null, 2));
    return;
  }
  const planPath = arg("plan");
  const planHash = arg("plan-hash");
  const operator = arg("operator") ?? "";
  if (!planPath || !planHash) {
    console.error("--plan <file> and --plan-hash <sha256> are required");
    process.exitCode = 2;
    return;
  }
  const plan = readPlan(planPath);
  try {
    if (command === "apply") {
      const categories = (arg("categories") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (categories.length === 0) {
        console.error("--categories <a,b> is required (the owner-approved categories)");
        process.exitCode = 2;
        return;
      }
      const report = await applyReconciliationPlan({ plan, expectedPlanHash: planHash, categories, operator }, prisma);
      console.log(JSON.stringify({ script: "review-remediation-reconcile", command: "apply", ...report }, null, 2));
      if (report.summary.failed > 0) process.exitCode = 1;
      return;
    }
    if (command === "compensate") {
      const report = await compensateReconciliationPlan({ plan, expectedPlanHash: planHash, operator }, prisma);
      console.log(JSON.stringify({ script: "review-remediation-reconcile", command: "compensate", ...report }, null, 2));
      if (report.results.some((r) => r.outcome === "failed")) process.exitCode = 1;
      return;
    }
    console.error(`Unknown command: ${command} (plan | apply | compensate)`);
    process.exitCode = 2;
  } catch (err) {
    if (err instanceof ReconcilePlanError) {
      console.error(`Refused: ${err.code}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
