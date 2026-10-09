/**
 * Run ONE tick of the Operations scheduler against an e2e stack's own
 * database, through the product's own scheduler.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Platform conditions — worker liveness and queue final failures — are written
 * once per scheduler tick, never by a page visit or a workspace request
 * (OPS-001 / OPS-009 / OPS-022). The scheduler ticks every 15 minutes in the
 * API process, so a browser journey that has just made jobs fail for real
 * cannot wait for it. This runs `runWorkspaceOperationsSweep` — the same
 * function the interval timer calls, contending for the same per-workspace run
 * locks — once, from a separate process, the way `e2e-provision-org.ts` runs
 * the provisioning authority. Nothing here is a second implementation.
 *
 * NOT A PRODUCT ROUTE, DELIBERATELY: there is no HTTP way to make the
 * scheduler tick, and there should not be one.
 *
 * REFUSES A NON-LOOPBACK DATABASE OR REDIS.
 *
 * Prints one line of JSON: the tick's bounded result.
 */
import { prisma } from "../src/db.js";
import { runWorkspaceOperationsSweep } from "../src/jobs/workspace-operations-reconciliation.job.js";

function hostOf(raw: string | undefined): string {
  try {
    return raw ? new URL(raw).hostname : "";
  } catch {
    return "";
  }
}

const LOCAL = ["localhost", "127.0.0.1", "::1", "postgres", "redis"];
for (const [name, value] of [
  ["DATABASE_URL", process.env.DATABASE_URL],
  ["REDIS_URL", process.env.REDIS_URL],
] as const) {
  if (!value) {
    console.error(`e2e-operations-sweep: ${name} is not set`);
    process.exit(2);
  }
  if (!LOCAL.includes(hostOf(value))) {
    console.error(
      `e2e-operations-sweep: REFUSED — ${name} host "${hostOf(value)}" is not a local address. ` +
        "This script runs the Operations scheduler and will only do so against a disposable local stack.",
    );
    process.exit(3);
  }
}

const result = await runWorkspaceOperationsSweep({ trigger: "cli" })
  .catch((err) => {
    console.error("e2e-operations-sweep: " + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
console.log(JSON.stringify(result));
// Queue handles keep sockets open; this is a one-shot process.
process.exit(0);
