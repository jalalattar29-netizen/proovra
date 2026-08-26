#!/usr/bin/env node
/**
 * IS THE OPERATIONS SOURCE-IDENTITY BACKFILL COMPLETE?
 *
 * ---------------------------------------------------------------------------
 * WHAT "COMPLETE" MEANS HERE, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * NOT "every row has a source_id". That would be the wrong bar and it would
 * never be met: rows whose fingerprint no registered pattern claims are
 * DELIBERATELY left NULL, because a guessed source is a guessed lifecycle and
 * the runtime already fails those closed to NO_DIRECT_RESOLUTION.
 *
 * Complete means: every row the backfill COULD have stamped, it did. A row
 * still NULL whose fingerprint matches a known prefix is the real failure —
 * it means the UPDATE did not reach it, and that row is now failing closed for
 * a reason nobody intended.
 *
 * ---------------------------------------------------------------------------
 * WHY IT ASKS THE REGISTRY RATHER THAN RESTATING THE PREFIXES
 * ---------------------------------------------------------------------------
 * The migration, the runtime resolver and this check must agree about which
 * fingerprints mean which source. Three hand-maintained copies of that table
 * would be three chances to disagree, and the one that disagreed silently
 * would be this one — a readiness check that passes because it is asking the
 * wrong question is worse than no check.
 *
 * So the prefixes come from `resolveConditionSource`, which is also what the
 * runtime uses.
 *
 * Usage:
 *   DATABASE_URL=... node services/api/scripts/operations-source-identity-readiness.mjs [--json]
 *
 * Exit: 0 ready, 1 incomplete, 2 could not run.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  OPERATIONS_SOURCE_LIFECYCLES,
  resolveConditionSource,
} from "@proovra/shared-runtime";

const asJson = process.argv.includes("--json");

function prefixes() {
  const out = [];
  for (const lifecycle of OPERATIONS_SOURCE_LIFECYCLES) {
    for (const pattern of lifecycle.legacyFingerprints) {
      if (pattern.kind !== "PREFIX") continue;
      // Confirm the round trip rather than trusting the declaration: a prefix
      // two sources both claimed would make this check stamp-or-not by
      // whichever the registry happened to list first.
      const back = resolveConditionSource({ fingerprint: `${pattern.prefix}:probe` });
      if (back.lifecycle.sourceId === lifecycle.sourceId) {
        out.push({ sourceId: lifecycle.sourceId, prefix: `${pattern.prefix}:` });
      }
    }
  }
  return out;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("operations-source-identity-readiness: DATABASE_URL is not set.");
    process.exit(2);
  }
  // Prisma 7 rejects both a no-argument constructor and the old `datasources`
  // block; the driver adapter is how a target URL is supplied now. Matching
  // `src/db.ts` and the sibling readiness scripts, which is the whole reason
  // this one is runnable at all — a readiness gate that cannot start proves
  // nothing.
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const known = prefixes();
    const total = await prisma.operationalIncident.count();
    const stamped = await prisma.operationalIncident.count({
      where: { NOT: { sourceId: null } },
    });

    // THE ONE NUMBER THAT MATTERS: rows the backfill should have reached and
    // did not.
    const missed = [];
    for (const { sourceId, prefix } of known) {
      const n = await prisma.operationalIncident.count({
        where: { sourceId: null, fingerprint: { startsWith: prefix } },
      });
      if (n > 0) missed.push({ sourceId, prefix, rows: n });
    }

    // Rows legitimately left NULL: no pattern claims them, and they fail
    // closed. Reported so the number is visible rather than assumed to be
    // zero — a growing one means an emitter is writing an unregistered shape.
    const unclaimed = total - stamped - missed.reduce((s, m) => s + m.rows, 0);

    const ready = missed.length === 0;
    const report = {
      ready,
      totalIncidents: total,
      stamped,
      unclaimedLegacyRows: Math.max(0, unclaimed),
      missedByPrefix: missed,
      knownPrefixes: known.length,
    };

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("─".repeat(63));
      console.log("  Operations source-identity backfill readiness");
      console.log("─".repeat(63));
      console.log(`  incidents            : ${total}`);
      console.log(`  with a source id     : ${stamped}`);
      console.log(`  unclaimed (fail closed): ${report.unclaimedLegacyRows}`);
      console.log(`  known prefixes       : ${known.length}`);
      if (ready) {
        console.log("\n  READY — every row a known prefix claims carries its source id.");
      } else {
        console.log("\n  INCOMPLETE — rows a known prefix claims are still NULL:");
        for (const m of missed) {
          console.log(`    ${m.prefix} -> ${m.sourceId}: ${m.rows} row(s)`);
        }
        console.log("\n  Re-apply 20271226000000_operational_incident_source_identity.");
      }
      console.log("─".repeat(63));
    }
    process.exit(ready ? 0 : 1);
  } catch (err) {
    console.error(
      "operations-source-identity-readiness: could not run —",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(2);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

void main();
