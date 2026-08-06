#!/usr/bin/env node
/**
 * Track 1B — deterministic backfill of canonical CaseEvidenceLink rows
 * from the legacy `evidence.case_id` column.
 *
 * NOTE (Track 1B closure): the legacy column is DROPPED by migration
 * 20271105000000_evidence_case_id_removal. This script is only
 * meaningful on databases that have NOT yet applied that migration —
 * its evidence reads use raw SQL over `evidence.case_id` (the column no
 * longer exists in the Prisma client), so it stays runnable PRE-drop
 * and becomes inert (reports zero rows / fails the probe gracefully)
 * AFTER the drop.
 *
 *   node scripts/backfill-case-evidence-links.mjs --check
 *     READ-ONLY readiness / conflict report. Prints counts:
 *       evidenceWithCaseId  — evidence rows with case_id NOT NULL
 *       linksExisting       — of those, rows whose (caseId, evidenceId)
 *                             canonical link already exists
 *       missingLinks        — rows needing a backfilled link
 *       conflictingLinks    — rows where a link exists to a DIFFERENT
 *                             case than evidence.case_id (divergence that
 *                             needs operator review; the backfill still
 *                             creates the matching link — it never
 *                             deletes the divergent one)
 *
 *   node scripts/backfill-case-evidence-links.mjs
 *     Creates the missing links (role PRIMARY, source SYSTEM, reason
 *     "backfill:evidence.caseId"). Deterministic: evidence is walked in
 *     ascending id order with a keyset cursor; the write is idempotent
 *     (skip when ANY link for the pair exists), so re-runs converge.
 *
 * Never mutates `evidence.case_id` and never deletes link rows.
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

// PHASE 12 POINT 3 — constructed exactly as the running API constructs it
// (src/db.ts). Prisma 7 rejects a no-argument `new PrismaClient()`, which made
// this readiness command unrunnable — the one thing a readiness gate must
// never be.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  process.stderr.write("DATABASE_URL is not set — refusing to guess a target.\n");
  process.exit(1);
}

const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const CHECK_ONLY = process.argv.includes("--check");
const BATCH = 500;
const BACKFILL_REASON = "backfill:evidence.caseId";

/** True when evidence.case_id still exists (pre-drop database). */
async function legacyColumnExists() {
  const rows = await prisma.$queryRaw`
    SELECT 1 AS present
      FROM information_schema.columns
     WHERE table_name = 'evidence'
       AND column_name = 'case_id'
     LIMIT 1
  `;
  return Array.isArray(rows) && rows.length > 0;
}

async function main() {
  if (!(await legacyColumnExists())) {
    console.log(
      JSON.stringify(
        {
          mode: CHECK_ONLY ? "check" : "backfill",
          inert: true,
          note:
            "evidence.case_id no longer exists (drop migration applied); nothing to backfill.",
        },
        null,
        2,
      ),
    );
    return;
  }

  let cursor = null;
  let evidenceWithCaseId = 0;
  let linksExisting = 0;
  let missingLinks = 0;
  let conflictingLinks = 0;
  let created = 0;

  for (;;) {
    // Raw SQL — the Prisma client no longer models evidence.case_id.
    const rows = await prisma.$queryRaw(
      Prisma.sql`
        SELECT e."id"::text AS id,
               e."team_id"::text AS team_id,
               e."case_id"::text AS case_id
          FROM "evidence" e
         WHERE "case_id" IS NOT NULL
           -- PHASE 12 POINT 3 — a pointer at a case row that no longer exists
           -- is NOT convertible: writing a link for it would create an
           -- association to a missing Case and then fail the foreign key the
           -- contract migration adds. The docstring above always claimed these
           -- were skipped; this clause is what actually skips them. They stay
           -- visible as orphanCasePointers in --check for an operator to
           -- resolve, and are never silently dropped.
           AND EXISTS (SELECT 1 FROM "cases" c WHERE c."id" = e."case_id")
           ${cursor ? Prisma.sql`AND e."id" > ${cursor}::uuid` : Prisma.empty}
         ORDER BY e."id" ASC
         LIMIT ${BATCH}
      `,
    );
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const e of rows) {
      if (!e.case_id) continue;
      evidenceWithCaseId += 1;

      const links = await prisma.caseEvidenceLink.findMany({
        where: { evidenceId: e.id },
        select: { caseId: true },
      });
      const hasMatching = links.some((l) => l.caseId === e.case_id);
      const hasOther = links.some((l) => l.caseId !== e.case_id);
      if (hasOther) conflictingLinks += 1;

      if (hasMatching) {
        linksExisting += 1;
        continue;
      }
      missingLinks += 1;

      if (CHECK_ONLY) continue;

      await prisma.caseEvidenceLink.create({
        data: {
          teamId: e.team_id ?? null,
          caseId: e.case_id,
          evidenceId: e.id,
          role: "PRIMARY",
          source: "SYSTEM",
          reason: BACKFILL_REASON,
        },
      });
      created += 1;
    }
  }

  // ---------------------------------------------------------------------------
  // PHASE 12 POINT 3 — CUTOVER CLOSURE MEASURES.
  //
  // The counts above describe the legacy population. These describe whether the
  // legacy column is SAFE TO DROP, and they are the same conditions the
  // contract migration re-checks in the database, so a green report and a
  // successful drop cannot disagree. Every one must read zero.
  // ---------------------------------------------------------------------------
  const one = async (sql) => {
    try {
      const rows = await prisma.$queryRawUnsafe(sql);
      return Number(rows?.[0]?.count ?? 0);
    } catch (err) {
      // The column is already gone (post-drop) — those categories are moot.
      const msg = err instanceof Error ? err.message : String(err);
      if (/does not exist/i.test(msg)) return 0;
      throw err;
    }
  };

  const closure = {
    // A legacy pointer at a LIVE case with no canonical link.
    //
    // PHASE 12 POINT 3 — measured in SQL, not carried over from the walk
    // counter above. The walk counter describes what the pass FOUND before it
    // wrote anything, so in backfill mode it stayed at its pre-write value and
    // the report contradicted itself: linksCreated=N alongside missingLinks=N
    // and dropReady=false. Every other closure measure is a post-state SQL
    // read; this one now is too, so both modes report the same truth.
    missingLinks: await one(`
      SELECT count(*)::int AS count FROM "evidence" e
      JOIN "cases" c ON c."id" = e."case_id"
      WHERE e."case_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "case_evidence_links" l
          WHERE l."evidence_id" = e."id" AND l."case_id" = e."case_id")`),
    // A legacy pointer at a case that no longer exists — an unresolved
    // association, reported rather than discarded.
    orphanCasePointers: await one(`
      SELECT count(*)::int AS count FROM "evidence" e
      WHERE e."case_id" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "cases" c WHERE c."id" = e."case_id")`),
    // A canonical link that crosses a workspace boundary.
    crossWorkspaceLinks: await one(`
      SELECT count(*)::int AS count FROM "case_evidence_links" l
      JOIN "cases" c ON c."id" = l."case_id"
      JOIN "evidence" e ON e."id" = l."evidence_id"
      WHERE c."team_id" IS DISTINCT FROM e."team_id"
         OR l."team_id" IS DISTINCT FROM e."team_id"`),
    // More than one link for the same (case, evidence) pair.
    duplicateLinks: await one(`
      SELECT count(*)::int AS count FROM (
        SELECT 1 FROM "case_evidence_links"
        GROUP BY "case_id", "evidence_id" HAVING count(*) > 1
      ) d`),
    // A link whose endpoints no longer exist.
    orphanLinks: await one(`
      SELECT count(*)::int AS count FROM "case_evidence_links" l
      WHERE NOT EXISTS (SELECT 1 FROM "cases" c WHERE c."id" = l."case_id")
         OR NOT EXISTS (SELECT 1 FROM "evidence" e WHERE e."id" = l."evidence_id")`),
  };

  // PHASE 12 POINT 3 — `conflictingLinks` is ADVISORY, deliberately not summed
  // into the blocking total. Evidence linked to more than one case is a
  // SUPPORTED state (CaseEvidenceLink is many-to-many with PRIMARY/SUPPORTING
  // roles), so counting it as blocking made a legitimate configuration
  // permanently un-droppable — the gate could never reach zero however the
  // operator resolved it. What actually matters is that no association is LOST:
  // that is `missingLinks`, which already covers every legacy pointer without a
  // matching canonical link. It is also the one measure the contract migration
  // does not re-check, so summing it here broke the guarantee above that a
  // green report and a successful drop cannot disagree.
  const advisory = { conflictingLinks };

  const blocking = Object.values(closure).reduce((a, b) => a + b, 0);

  const report = {
    mode: CHECK_ONLY ? "check" : "backfill",
    evidenceWithCaseId,
    linksExisting,
    missingLinks,
    conflictingLinks,
    closure,
    advisory,
    blockingCount: blocking,
    dropReady: blocking === 0,
    ...(CHECK_ONLY ? {} : { linksCreated: created }),
  };
  console.log(JSON.stringify(report, null, 2));

  if (blocking > 0) {
    console.error(
      `NOT READY to drop evidence.case_id — ${blocking} blocking row(s): ` +
        Object.entries(closure)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ") +
        ". Resolve them; do NOT delete or null records to clear this.",
    );
    process.exitCode = 2;
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
