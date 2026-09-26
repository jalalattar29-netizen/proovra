// Configuration is loaded EXPLICITLY (Phase 12 Point 7): never as a side
// effect of importing the database client.
import "../env.js";

/**
 * HISTORICAL PACKAGE RECOVERY — DRY RUN BY DEFAULT.
 *
 *   Dry run (read-only; writes the reviewable report to --out):
 *     pnpm --filter proovra-api package-recovery:dry-run -- \
 *       [--workspace=<uuid>] [--max-records=1000] [--page-size=200] \
 *       [--batch-size=25] [--after=<evidence uuid>] \
 *       [--storage-check=head|full|none] [--out=<dir>]
 *
 *   Execute an APPROVED plan (separate owner approval required; never part
 *   of a dry run):
 *     PACKAGE_RECOVERY_BACKFILL_EXECUTE=I_HAVE_OWNER_APPROVAL \
 *     pnpm --filter proovra-api package-recovery:dry-run -- \
 *       --execute --approval=<approval.json> [--out=<dir>]
 *
 * The approval file names the plan hash printed by the dry run, the exact
 * dry-run parameters, who approved it, a reference to the decision, and an
 * authorized operator per workspace. Execution re-discovers and refuses when
 * the plan has changed. See src/services/reports/package-recovery-backfill.service.ts.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { prisma } from "../db.js";
import {
  discoverPackageRecoveryCandidates,
  executePackageRecoveryPlan,
  renderPackageRecoveryPlanMarkdown,
  type PackageRecoveryApproval,
  type ReportStorageCheck,
} from "../services/reports/package-recovery-backfill.service.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const val = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const num = (name: string): number | undefined => {
  const v = val(name);
  return v === undefined ? undefined : Number(v);
};

/** Which database, without printing its credentials. */
function databaseFingerprint(): string {
  const raw = process.env.DATABASE_URL ?? "";
  try {
    const u = new URL(raw);
    return createHash("sha256").update(`${u.hostname}:${u.port}/${u.pathname}`).digest("hex").slice(0, 16);
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const outDir = resolve(val("out") ?? `package-recovery-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(outDir, { recursive: true });

  if (flag("execute")) {
    const approvalPath = val("approval");
    const approval = approvalPath
      ? (JSON.parse(readFileSync(resolve(approvalPath), "utf8")) as PackageRecoveryApproval)
      : null;
    const result = await executePackageRecoveryPlan(approval);
    writeFileSync(join(outDir, "execution-result.json"), JSON.stringify(result, null, 2));
    process.stdout.write(`${JSON.stringify({ kind: result.kind, ...(result.kind === "refused" ? { reason: result.reason } : { runId: result.runId, records: result.results.length }) })}\n`);
    process.exitCode = result.kind === "refused" ? 2 : 0;
    return;
  }

  const plan = await discoverPackageRecoveryCandidates({
    workspaceId: val("workspace") ?? null,
    maxRecords: num("max-records"),
    pageSize: num("page-size"),
    batchSize: num("batch-size"),
    afterEvidenceId: val("after") ?? null,
    storageCheck: (val("storage-check") as ReportStorageCheck | undefined) ?? "head",
  });
  const source = {
    databaseFingerprint: databaseFingerprint(),
    gitSha: process.env.GIT_SHA ?? process.env.RELEASE_SHA ?? null,
  };
  writeFileSync(join(outDir, "plan.json"), JSON.stringify({ ...plan, source }, null, 2));
  writeFileSync(join(outDir, "plan.md"), `${renderPackageRecoveryPlanMarkdown(plan)}\n- Database fingerprint: \`${source.databaseFingerprint}\`\n`);
  process.stdout.write(
    `${JSON.stringify({
      mode: plan.mode,
      runId: plan.runId,
      planHash: plan.planHash,
      totals: plan.totals,
      estimatedBytes: plan.storageEstimate.estimatedBytes,
      truncated: plan.truncated,
      out: outDir,
    })}\n`,
  );
}

main()
  .catch((err) => {
    process.stderr.write(`package-recovery-backfill: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
