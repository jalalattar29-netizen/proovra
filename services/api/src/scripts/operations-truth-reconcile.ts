// Configuration is loaded EXPLICITLY (Phase 12 Point 7): never as a side
// effect of importing the database client.
import "../env.js";

/**
 * OPERATIONS TRUTH — EXISTING-DATA RECONCILIATION. DRY RUN BY DEFAULT.
 *
 *   Dry run (read-only; prints bounded counts per rule, never payloads):
 *     pnpm --filter proovra-api ops:operations-truth-reconcile -- [--limit=1000]
 *
 *   Apply (owner-controlled; separate approval):
 *     OPERATIONS_TRUTH_RECONCILE_APPLY=I_HAVE_OWNER_APPROVAL \
 *     pnpm --filter proovra-api ops:operations-truth-reconcile -- --apply [--limit=1000]
 *
 *   Optional bounds, for either mode:
 *     --team=<workspaceUuid>   every rule restricted to one workspace (rules
 *                              whose rows carry no workspace are skipped);
 *     --source=<sourceId>      only the rules (and rows) of that source;
 *     --rule=<rule>[,<rule>]   only the named rules.
 *   e.g. a dry run of the OPS-13 security reclassification for one workspace:
 *     pnpm --filter proovra-api ops:operations-truth-reconcile -- \
 *       --rule=reclassified_security_signals --team=<workspaceUuid>
 *
 * Safe to rerun: every rule acts only on rows still in the state it repairs.
 * Run the dry run first, review the counts, then apply, then dry-run again —
 * the second dry run must report zero changes (or only `truncated` rules,
 * which need another pass). See docs/operations/remediation/
 * OPERATIONS-TRUTH-RECONCILIATION.md for the owner-controlled order.
 */

import { createHash } from "node:crypto";

import { prisma } from "../db.js";
import {
  RECONCILIATION_RULES,
  reconcileOperationsTruth,
  type ReconciliationRule,
} from "../services/operations/operations-truth-reconciliation.service.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const val = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
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
  const apply = flag("apply");
  if (apply && process.env.OPERATIONS_TRUTH_RECONCILE_APPLY !== "I_HAVE_OWNER_APPROVAL") {
    process.stderr.write(
      "Refusing --apply: set OPERATIONS_TRUTH_RECONCILE_APPLY=I_HAVE_OWNER_APPROVAL after reviewing a dry run.\n",
    );
    process.exitCode = 2;
    return;
  }
  const limit = val("limit") ? Number(val("limit")) : undefined;
  const team = val("team");
  if (team !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(team)) {
    process.stderr.write("Refusing: --team must be a workspace UUID.\n");
    process.exitCode = 2;
    return;
  }
  const source = val("source");
  if (source !== undefined && !/^[a-z_]+\.[a-z_]+$/.test(source)) {
    process.stderr.write("Refusing: --source must be a registered source id (e.g. identity.idp_outage).\n");
    process.exitCode = 2;
    return;
  }
  const ruleArg = val("rule");
  const ruleList = ruleArg ? ruleArg.split(",").map((r) => r.trim()).filter(Boolean) : [];
  const unknown = ruleList.filter((r) => !(RECONCILIATION_RULES as readonly string[]).includes(r));
  if (unknown.length > 0) {
    process.stderr.write(`Refusing: unknown --rule ${unknown.join(", ")}. Known: ${RECONCILIATION_RULES.join(", ")}\n`);
    process.exitCode = 2;
    return;
  }
  const report = await reconcileOperationsTruth({
    apply,
    limitPerRule: limit,
    teamId: team ?? null,
    sourceId: source ?? null,
    rules: ruleList.length > 0 ? (ruleList as ReconciliationRule[]) : null,
  });
  process.stdout.write(`${JSON.stringify({ database: databaseFingerprint(), ...report }, null, 2)}\n`);
}

main()
  .catch((err) => {
    process.stderr.write(`operations-truth-reconcile failed: ${err instanceof Error ? err.name : "error"}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
