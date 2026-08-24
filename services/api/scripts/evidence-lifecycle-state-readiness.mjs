#!/usr/bin/env node
/**
 * READINESS GATE for the evidence lifecycle-state backfill
 * (20271220000001_evidence_lifecycle_state_backfill).
 *
 * A backfill is a claim: "after this ran, the column agrees with the facts it
 * was derived from". The migration inventory refuses to classify a BACKFILL
 * without a command that can CHECK that claim against a real database, because
 * a backfill nobody can verify is indistinguishable from one that silently
 * skipped rows.
 *
 * WHAT IT PROVES
 * ---------------------------------------------------------------------------
 * Three disagreements, each of which would mean a runtime reader and the
 * migration disagree about what a record IS:
 *
 *   1. a record with `deleted_at` set that is neither TRASHED nor DESTROYED —
 *      it would list under Active while sitting in a user's trash;
 *   2. a record with `archived_at` set, no `deleted_at`, that is not ARCHIVED
 *      and not DESTROYED — it would list under Active after being archived;
 *   3. a TRASHED record with no `deleted_at` — the state pointer claims a trash
 *      event that never happened, so the trash-grace reconciler would have no
 *      deadline to read.
 *
 * It deliberately does NOT flag a record whose `lifecycle_state` is a
 * governance-internal posture (UNDER_REVIEW, ON_HOLD, RETENTION_LOCKED,
 * PENDING_DESTRUCTION) with no lifecycle event timestamps. Those are left alone
 * by design — see the migration header — and the canonical authority resolves
 * them to the ACTIVE product state from their timestamps.
 *
 * READ-ONLY. It runs three COUNT queries and writes nothing.
 *
 * Usage:
 *   DATABASE_URL=postgres://… node scripts/evidence-lifecycle-state-readiness.mjs
 *
 * Exit codes:
 *   0  converged
 *   2  no database target supplied (never guesses)
 *   3  target is on a non-local host and --allow-remote was not passed
 *   5  the column and the timestamps disagree on at least one row
 *   7  the check could not run
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import { classifyHost, parseDatabaseHost } from "./db-host-policy.mjs";

const url =
  process.env.DATABASE_URL ??
  process.env.DRIFT_CHECK_DATABASE_URL ??
  process.env.P6_TARGET ??
  null;

if (!url) {
  console.error(
    "evidence-lifecycle-state-readiness: no DATABASE_URL supplied. This script never guesses a target.",
  );
  process.exit(2);
}

// A read-only check is safe to run against production ON PURPOSE — that is
// where the answer matters — but it must be a deliberate act, not something a
// misconfigured shell does by accident.
const allowRemote = process.argv.includes("--allow-remote");
const { host } = parseDatabaseHost(url);
if (classifyHost(host) !== "local" && !allowRemote) {
  console.error(
    `evidence-lifecycle-state-readiness: refusing a non-local host (${host}) without --allow-remote.`,
  );
  process.exit(3);
}

// Constructed INSIDE main, not at module scope. A constructor that throws at
// import time escapes the `.catch` below entirely and the script exits with a
// stack trace and an unhelpful code — which is exactly what a gate must not do.
async function main() {
  // Prisma 7 rejects both a no-argument constructor and the old `datasources`
  // block; the driver adapter is how a target URL is supplied now. Matching
  // `src/db.ts` and the other readiness scripts, which is the whole reason this
  // one is runnable at all — a readiness gate that cannot start proves nothing.
  const pool = new pg.Pool({ connectionString: url });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const [trashedMismatch] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "evidence"
        WHERE "deleted_at" IS NOT NULL
          AND "lifecycle_state" NOT IN ('TRASHED', 'DESTROYED')`,
    );
    const [archivedMismatch] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "evidence"
        WHERE "deleted_at" IS NULL
          AND "archived_at" IS NOT NULL
          AND "lifecycle_state" NOT IN ('ARCHIVED', 'DESTROYED')`,
    );
    const [trashedWithoutEvent] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "evidence"
        WHERE "lifecycle_state" = 'TRASHED'
          AND "deleted_at" IS NULL`,
    );

    const rows = [
      ["trashed rows not marked TRASHED/DESTROYED", trashedMismatch.n],
      ["archived rows not marked ARCHIVED/DESTROYED", archivedMismatch.n],
      ["TRASHED rows with no trash timestamp", trashedWithoutEvent.n],
    ];

    console.log("");
  console.log("  evidence lifecycle-state backfill readiness");
  console.log("  ─────────────────────────────────────────────────────────");
  console.log(`  host    : ${host}`);
  for (const [label, n] of rows) {
    console.log(`  ${n === 0 ? "OK  " : "FAIL"}  ${label}: ${n}`);
  }
  console.log("");

  const total = rows.reduce((sum, [, n]) => sum + n, 0);
  if (total > 0) {
    console.error(
      `  evidence-lifecycle-state-readiness: ${total} row(s) disagree with the backfill precedence.`,
    );
    console.error(
      "  Re-run migration 20271220000001; it is idempotent and safe to apply again.",
    );
    process.exit(5);
  }
  console.log("  evidence-lifecycle-state-readiness: OK — converged.");
  console.log("");
  } finally {
    await prisma.$disconnect().catch(() => null);
    await pool.end().catch(() => null);
  }
}

main().catch((err) => {
  console.error("evidence-lifecycle-state-readiness: could not run the check");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(7);
});
