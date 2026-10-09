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
 * Safe to rerun: every rule acts only on rows still in the state it repairs.
 * Run the dry run first, review the counts, then apply, then dry-run again —
 * the second dry run must report zero changes (or only `truncated` rules,
 * which need another pass). See docs/operations/remediation/
 * OPERATIONS-TRUTH-RECONCILIATION.md for the owner-controlled order.
 */

import { createHash } from "node:crypto";

import { prisma } from "../db.js";
import { reconcileOperationsTruth } from "../services/operations/operations-truth-reconciliation.service.js";

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
  const report = await reconcileOperationsTruth({ apply, limitPerRule: limit });
  process.stdout.write(`${JSON.stringify({ database: databaseFingerprint(), ...report }, null, 2)}\n`);
}

main()
  .catch((err) => {
    process.stderr.write(`operations-truth-reconcile failed: ${err instanceof Error ? err.name : "error"}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
