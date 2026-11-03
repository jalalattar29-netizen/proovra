/**
 * THE SWEEPS, TIMED ONE AT A TIME, on the capacity fixture.
 *
 *   node e2e/acceptance/stack.mjs tsx ../../e2e/acceptance/capacity/sweeps.ts --label=before [--only=regex]
 *
 * Calls the same functions the worker's timers and the API's cron routes call, so
 * the statements are the production statements. The fixture's evidence has no
 * stored object version, which leaves the tier sweep's read path in full and stops
 * it before storage, so storage time is not in these numbers.
 *
 * Refuses anything but the acceptance fixture on a loopback host, and needs the API
 * running from the same stack for the cron-secret routes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prisma } from "../../../services/api/src/db.js";
import "../../../services/api/src/register-shared-runtime.js";
import { localSeedDatabaseRefusal } from "../../../services/api/scripts/lib/local-seed-guard.js";
import {
  operationsSweepCoverage,
  runWorkspaceOperationsSweep,
} from "../../../services/api/src/jobs/workspace-operations-reconciliation.job.js";
import { runArchiveTierAutoTransitions } from "../../../services/worker/src/governance/archive-tier-auto-transition.worker.js";
import { runRetentionReconciliation } from "../../../services/worker/src/governance/retention-reconciliation.worker.js";
import { runTrashGraceReconciliation } from "../../../services/worker/src/governance/trash-grace-reconciler.js";
import { processArchiveRestoreRequests } from "../../../services/worker/src/governance/archive-restore.js";
import { reconcileStrandedReportRequests } from "../../../services/worker/src/report-generation-authority.js";

{
  const refusal = localSeedDatabaseRefusal();
  if (refusal) throw new Error(`capacity sweeps: REFUSED, ${refusal}`);
  const name = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "");
  if (name !== "proovra_acceptance_fixture" || process.env.PROOVRA_TEST_STACK !== "1") {
    throw new Error(`capacity sweeps: REFUSED, not the acceptance fixture (${name}).`);
  }
}

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const label = arg("label") ?? "sweeps";
const onlyArg = arg("only");
const only = onlyArg ? new RegExp(onlyArg) : null;
const API = "http://localhost:8391";

async function cron(path: string, header: string, secret: string | undefined) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [header]: secret ?? "" },
    body: "{}",
    signal: AbortSignal.timeout(590_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${body.slice(0, 200)}`);
  return { status: res.status };
}

const NOTIFY = "x-proovra-cron-secret";
const INTEGRATION = "x-proovra-integration-cron-secret";

const SWEEPS: Array<[string, () => Promise<unknown>]> = [
  ["archive_tier_transition", () => runArchiveTierAutoTransitions({ trigger: "capacity" })],
  ["retention_reconciliation", () => runRetentionReconciliation({ trigger: "capacity" } as never)],
  ["trash_grace", () => runTrashGraceReconciliation({})],
  ["archive_restore", () => processArchiveRestoreRequests()],
  ["report_stranded_requests", () => reconcileStrandedReportRequests({} as never)],
  ["operations_sweep_one_tick", () => runWorkspaceOperationsSweep({ trigger: "capacity" } as never)],
  ["operations_coverage", () => operationsSweepCoverage()],
  ["notification_retries", () => cron("/v1/notifications/process-retries", NOTIFY, process.env.NOTIFICATION_CRON_SECRET)],
  ["notification_reminders", () => cron("/v1/notifications/run-reminders", NOTIFY, process.env.NOTIFICATION_CRON_SECRET)],
  ["notification_digests", () => cron("/v1/notifications/run-digests", NOTIFY, process.env.NOTIFICATION_CRON_SECRET)],
  ["communication_retries", () => cron("/v1/communications/process-retries", INTEGRATION, process.env.INTEGRATION_CRON_SECRET)],
  ["lifecycle_tick", () => cron("/v1/internal/lifecycle/run", INTEGRATION, process.env.INTEGRATION_CRON_SECRET)],
];

type Statement = { calls: bigint; rows: bigint; total: number; max: number; blocks: bigint; query: string };

async function main() {
  const out = [];
  for (const [name, run] of SWEEPS) {
    if (only && !only.test(name)) continue;
    await prisma.$queryRawUnsafe(`SELECT pg_stat_statements_reset()::text`);
    const started = Date.now();
    let outcome: string;
    let summary: unknown = null;
    try {
      summary = await run();
      outcome = "ok";
    } catch (err) {
      outcome = `failed: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`;
    }
    const wallMs = Date.now() - started;
    const top = await prisma.$queryRawUnsafe<Statement[]>(
      `SELECT calls, rows, round(total_exec_time::numeric, 1)::float8 AS total, round(max_exec_time::numeric, 1)::float8 AS max,
              shared_blks_hit + shared_blks_read AS blocks, left(regexp_replace(query, '\\s+', ' ', 'g'), 300) AS query
         FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%'
        ORDER BY total_exec_time DESC LIMIT 8`,
    );
    const [totals] = await prisma.$queryRawUnsafe<Array<{ calls: bigint; rows: bigint; total: number; blocks: bigint }>>(
      `SELECT sum(calls)::bigint AS calls, sum(rows)::bigint AS rows, round(sum(total_exec_time)::numeric, 1)::float8 AS total,
              sum(shared_blks_hit + shared_blks_read)::bigint AS blocks
         FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%'`,
    );
    const row = {
      name,
      outcome,
      wallMs,
      statements: Number(totals?.calls ?? 0),
      dbRows: Number(totals?.rows ?? 0),
      dbMs: totals?.total ?? 0,
      dbBlocks: Number(totals?.blocks ?? 0),
      summary,
      top: top.map((t) => ({ ...t, calls: Number(t.calls), rows: Number(t.rows), blocks: Number(t.blocks) })),
    };
    out.push(row);
    console.log(
      `${name.padEnd(30)} ${outcome.padEnd(6)} wall=${wallMs}ms stmts=${row.statements} rows=${row.dbRows} dbMs=${row.dbMs} blocks=${row.dbBlocks}`,
    );
  }
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".p7tmp", "capacity");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, `${label}-sweeps.json`),
    JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2),
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    process.exit(1);
  });
