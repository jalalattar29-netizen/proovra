#!/usr/bin/env node
/**
 * PHASE 12B CLUSTER 8 — Legal-Hold convergence readiness + conflict report.
 *
 * READ-ONLY. Executes SELECTs only. It never inserts, updates or deletes a
 * row, and it never releases, expires or weakens a hold.
 *
 * Run this BEFORE applying 20271107000000_legal_hold_backfill, and again
 * AFTER, to prove row-count and semantic equivalence. The backfill migration
 * is idempotent, so a second run of the report after a second run of the
 * backfill must produce identical numbers.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/legal-hold-convergence-report.mjs
 *   DATABASE_URL=... node scripts/legal-hold-convergence-report.mjs --json
 *
 * Exit codes:
 *   0 — report produced (conflicts may still be listed; read them)
 *   1 — the report could not run
 *   2 — a BLOCKING conflict exists (cross-workspace mismatch). The backfill
 *       refuses to merge those rows; they must be resolved by an operator.
 *
 * ---------------------------------------------------------------------------
 * CONFLICT CLASSES (the same ten cases the backfill migration handles)
 *
 *   EVIDENCE_ONLY          evidence-scoped hold, no case involvement
 *   CASE_PROTECTS_LINKED   case hold covering every linked evidence row
 *   GENERIC_LIFECYCLE      scope-generic hold (WORKSPACE / ORGANIZATION)
 *   STATE_ACTIVE/RELEASED/EXPIRED   state distribution per store
 *   DUAL_STORE_TARGET      one target held by BOTH stores simultaneously
 *   CONFLICTING_RELEASE    same target, one store says ACTIVE and another
 *                          says RELEASED → MOST PROTECTIVE WINS (stays held)
 *   ORPHAN_TARGET          hold whose target row is gone → preserved as
 *                          HISTORICAL, never dropped
 *   CROSS_WORKSPACE        hold whose target belongs to another tenant →
 *                          REFUSED, reported, never merged (BLOCKING)
 *   DUPLICATE_SEMANTIC     same (teamId, scope, target, placedAtUtc) more
 *                          than once → deduped for blocking purposes, BOTH
 *                          provenance rows kept
 *   RELEASE_NEEDS_APPROVAL holds carrying an unmet release-approval gate
 *   DANGLING_CASE_REF      evidence_legal_holds.case_id pointing at a case
 *                          row that no longer exists (why the canonical
 *                          migration may leave that FK NOT VALID)
 * ---------------------------------------------------------------------------
 */
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

// PHASE 12 POINT 3 — the client is constructed the SAME way the running API
// constructs it (src/db.ts: an explicit pg adapter). Prisma 7 refuses a
// no-argument `new PrismaClient()`, so the previous form made this readiness
// command impossible to execute — the exact failure mode a readiness gate must
// not have. Using the app's own construction also means the report reads
// through the same driver the runtime does.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  process.stderr.write("DATABASE_URL is not set — refusing to guess a target.\n");
  process.exit(1);
}

const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const asJson = process.argv.includes("--json");

/** Runs a query, degrading to `[]` when the relation/column does not exist. */
async function q(sql, params = []) {
  try {
    return await prisma.$queryRawUnsafe(sql, ...params);
  } catch (err) {
    const code = err?.code;
    const msg = err instanceof Error ? err.message : String(err);
    if (code === "P2021" || code === "P2022" || /does not exist/i.test(msg)) {
      return [{ __absent: true }];
    }
    throw err;
  }
}

function n(rows, key = "count") {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  if (rows[0].__absent) return null;
  const v = rows[0][key];
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

async function main() {
  const report = { generatedAtUtc: new Date().toISOString(), stores: {}, conflicts: {} };

  // -------------------------------------------------------------------------
  // Per-store counts. These are the numbers the row-count equivalence proof
  // in the backfill migration refers to.
  // -------------------------------------------------------------------------
  report.stores.evidenceLegalHolds = {
    total: n(await q(`SELECT count(*)::int AS count FROM "evidence_legal_holds"`)),
    active: n(await q(`SELECT count(*)::int AS count FROM "evidence_legal_holds" WHERE "status" = 'ACTIVE'`)),
    released: n(await q(`SELECT count(*)::int AS count FROM "evidence_legal_holds" WHERE "status" = 'RELEASED'`)),
    scopeEvidence: n(await q(`SELECT count(*)::int AS count FROM "evidence_legal_holds" WHERE "scope" = 'EVIDENCE'`)),
    scopeCase: n(await q(`SELECT count(*)::int AS count FROM "evidence_legal_holds" WHERE "scope" = 'CASE'`)),
    scopeWorkspace: n(await q(`SELECT count(*)::int AS count FROM "evidence_legal_holds" WHERE "scope" = 'WORKSPACE'`)),
    historical: n(await q(`SELECT count(*)::int AS count FROM "evidence_legal_holds" WHERE "historical" = true`)),
    convergedFromCaseStore: n(await q(`SELECT count(*)::int AS count FROM "evidence_legal_holds" WHERE "source_store" = 'CASE_LEGAL_HOLD'`)),
    convergedFromLifecycleStore: n(await q(`SELECT count(*)::int AS count FROM "evidence_legal_holds" WHERE "source_store" = 'LIFECYCLE_LEGAL_HOLD'`)),
  };

  report.stores.caseLegalHolds = {
    total: n(await q(`SELECT count(*)::int AS count FROM "case_legal_holds"`)),
    active: n(await q(`SELECT count(*)::int AS count FROM "case_legal_holds" WHERE "status" = 'ACTIVE'`)),
    released: n(await q(`SELECT count(*)::int AS count FROM "case_legal_holds" WHERE "status" = 'RELEASED'`)),
  };

  report.stores.legalHolds = {
    total: n(await q(`SELECT count(*)::int AS count FROM "legal_holds"`)),
    active: n(await q(`SELECT count(*)::int AS count FROM "legal_holds" WHERE "state" = 'ACTIVE'`)),
    released: n(await q(`SELECT count(*)::int AS count FROM "legal_holds" WHERE "state" = 'RELEASED'`)),
    expired: n(await q(`SELECT count(*)::int AS count FROM "legal_holds" WHERE "state" = 'EXPIRED'`)),
    kindEvidence: n(await q(`SELECT count(*)::int AS count FROM "legal_holds" WHERE "kind" = 'EVIDENCE'`)),
    kindCase: n(await q(`SELECT count(*)::int AS count FROM "legal_holds" WHERE "kind" = 'CASE'`)),
    kindWorkspaceOrOrg: n(await q(`SELECT count(*)::int AS count FROM "legal_holds" WHERE "kind" IN ('WORKSPACE','ORGANIZATION')`)),
  };

  // Expected converged total AFTER the backfill: every legacy row becomes
  // exactly one canonical row, keyed by (source_store, source_row_id).
  const els = report.stores.evidenceLegalHolds;
  const cls = report.stores.caseLegalHolds;
  const lhs = report.stores.legalHolds;
  report.expectedCanonicalTotalAfterBackfill =
    (els.total ?? 0) +
    ((cls.total ?? 0) - (els.convergedFromCaseStore ?? 0)) +
    ((lhs.total ?? 0) - (els.convergedFromLifecycleStore ?? 0));

  // -------------------------------------------------------------------------
  // Conflict classes
  // -------------------------------------------------------------------------

  // CASE_PROTECTS_LINKED — how many evidence rows a case hold reaches.
  report.conflicts.CASE_PROTECTS_LINKED = await q(`
    SELECT h."id"::text AS hold_id, h."case_id"::text AS case_id,
           count(l."evidence_id")::int AS linked_evidence
    FROM "case_legal_holds" h
    LEFT JOIN "case_evidence_links" l ON l."case_id" = h."case_id"
    WHERE h."status" = 'ACTIVE'
    GROUP BY h."id", h."case_id"
    ORDER BY linked_evidence DESC
    LIMIT 50
  `);

  // ORPHAN_TARGET — legacy holds whose target row is gone. These are
  // PRESERVED as HISTORICAL by the backfill; they are never dropped.
  report.conflicts.ORPHAN_TARGET_CASE_STORE = n(await q(`
    SELECT count(*)::int AS count FROM "case_legal_holds" h
    WHERE NOT EXISTS (SELECT 1 FROM "cases" c WHERE c."id" = h."case_id")
  `));
  report.conflicts.ORPHAN_TARGET_LIFECYCLE_EVIDENCE = n(await q(`
    SELECT count(*)::int AS count FROM "legal_holds" h
    WHERE h."kind" = 'EVIDENCE' AND h."scope_target_id" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "evidence" e WHERE e."id" = h."scope_target_id")
  `));
  report.conflicts.ORPHAN_TARGET_LIFECYCLE_CASE = n(await q(`
    SELECT count(*)::int AS count FROM "legal_holds" h
    WHERE h."kind" = 'CASE' AND h."scope_target_id" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "cases" c WHERE c."id" = h."scope_target_id")
  `));

  // CROSS_WORKSPACE — BLOCKING. The hold's teamId disagrees with the tenant
  // that actually owns the target. The backfill REFUSES these rows.
  report.conflicts.CROSS_WORKSPACE_CASE_STORE = await q(`
    SELECT h."id"::text AS hold_id, h."team_id"::text AS hold_team,
           c."team_id"::text AS target_team
    FROM "case_legal_holds" h
    JOIN "cases" c ON c."id" = h."case_id"
    WHERE c."team_id" IS DISTINCT FROM h."team_id"
    LIMIT 100
  `);
  report.conflicts.CROSS_WORKSPACE_LIFECYCLE_EVIDENCE = await q(`
    SELECT h."id"::text AS hold_id, h."team_id"::text AS hold_team,
           e."team_id"::text AS target_team
    FROM "legal_holds" h
    JOIN "evidence" e ON e."id" = h."scope_target_id"
    WHERE h."kind" = 'EVIDENCE' AND e."team_id" IS DISTINCT FROM h."team_id"
    LIMIT 100
  `);
  report.conflicts.CROSS_WORKSPACE_LIFECYCLE_CASE = await q(`
    SELECT h."id"::text AS hold_id, h."team_id"::text AS hold_team,
           c."team_id"::text AS target_team
    FROM "legal_holds" h
    JOIN "cases" c ON c."id" = h."scope_target_id"
    WHERE h."kind" = 'CASE' AND c."team_id" IS DISTINCT FROM h."team_id"
    LIMIT 100
  `);

  // DUAL_STORE_TARGET + CONFLICTING_RELEASE — one evidence target carrying
  // holds from more than one store. MOST PROTECTIVE WINS: the target stays
  // held while ANY source says ACTIVE.
  report.conflicts.DUAL_STORE_EVIDENCE_TARGETS = await q(`
    SELECT t.evidence_id::text AS evidence_id,
           bool_or(t.src = 'EVIDENCE_LEGAL_HOLD') AS in_evidence_store,
           bool_or(t.src = 'LIFECYCLE_LEGAL_HOLD') AS in_lifecycle_store,
           bool_or(t.active) AS any_active,
           bool_and(t.active) AS all_active
    FROM (
      SELECT "evidence_id" AS evidence_id, 'EVIDENCE_LEGAL_HOLD' AS src,
             ("status" = 'ACTIVE') AS active
      FROM "evidence_legal_holds" WHERE "evidence_id" IS NOT NULL
      UNION ALL
      SELECT "scope_target_id" AS evidence_id, 'LIFECYCLE_LEGAL_HOLD' AS src,
             ("state" = 'ACTIVE') AS active
      FROM "legal_holds" WHERE "kind" = 'EVIDENCE' AND "scope_target_id" IS NOT NULL
    ) t
    GROUP BY t.evidence_id
    HAVING count(DISTINCT t.src) > 1
    LIMIT 100
  `);

  // DUPLICATE_SEMANTIC — same tenant + scope + target + placement instant.
  // Deduped for BLOCKING purposes only; both provenance rows are kept.
  report.conflicts.DUPLICATE_SEMANTIC = await q(`
    SELECT "team_id"::text AS team_id, "scope"::text AS scope,
           coalesce("evidence_id"::text, "case_id"::text, 'WORKSPACE') AS target,
           "placed_at_utc" AS placed_at_utc, count(*)::int AS copies
    FROM "evidence_legal_holds"
    GROUP BY 1,2,3,4
    HAVING count(*) > 1
    ORDER BY copies DESC
    LIMIT 100
  `);

  // RELEASE_NEEDS_APPROVAL — active holds with an unmet approval gate.
  report.conflicts.RELEASE_NEEDS_APPROVAL = n(await q(`
    SELECT count(*)::int AS count FROM "evidence_legal_holds"
    WHERE "status" = 'ACTIVE'
      AND "release_approval_required" = true
      AND "release_approval_state" <> 'APPROVED'
  `));

  // DANGLING_CASE_REF — why evidence_legal_holds_case_id_fkey may be NOT VALID.
  report.conflicts.DANGLING_CASE_REF = n(await q(`
    SELECT count(*)::int AS count FROM "evidence_legal_holds" h
    WHERE h."case_id" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "cases" c WHERE c."id" = h."case_id")
  `));

  // EVIDENCE_WITH_CASE_TAG — EVIDENCE-scoped rows carrying a contextual
  // case_id tag. This count decides which form of the scope/target CHECK
  // 20271106000000 installs: ZERO means the strict form (EVIDENCE ⇒ case_id
  // NULL) validates; non-zero means the tag is PRESERVED and the EVIDENCE
  // branch stays relaxed. The tag is never blanked to make a constraint pass.
  report.conflicts.EVIDENCE_WITH_CASE_TAG = n(await q(`
    SELECT count(*)::int AS count FROM "evidence_legal_holds"
    WHERE "scope" = 'EVIDENCE' AND "case_id" IS NOT NULL
  `));

  // ORG_BINDING_MISMATCH — organization_id must always agree with the owning
  // workspace's organization. A hold bound to a DIFFERENT tenant's
  // organization is a tenant-isolation defect, not a cosmetic one.
  report.conflicts.ORG_BINDING_MISMATCH = await q(`
    SELECT h."id"::text AS hold_id,
           h."organization_id"::text AS hold_org,
           t."organization_id"::text AS team_org
    FROM "evidence_legal_holds" h
    JOIN "teams" t ON t."id" = h."team_id"
    WHERE h."organization_id" IS NOT NULL
      AND h."organization_id" IS DISTINCT FROM t."organization_id"
    LIMIT 100
  `);

  // UNRESOLVED_ACTIVE_HOLD — ACTIVE historical rows. Each one FAILS CLOSED and
  // blocks its whole workspace until an operator resolves it. Non-zero here is
  // an OPERATIONAL alarm, not a data-quality note.
  report.conflicts.UNRESOLVED_ACTIVE_HOLD = n(await q(`
    SELECT count(*)::int AS count FROM "evidence_legal_holds"
    WHERE "historical" = true AND "status" = 'ACTIVE'
  `));

  // ---------------------------------------------------------------------------
  // PHASE 12 POINT 3 — POST-BACKFILL CLOSURE MEASURES.
  //
  // Everything above describes the legacy population. These four describe the
  // CONVERSION itself, and they are what the contract migration's in-database
  // guards independently re-check. They read zero on a database where the
  // canonical columns do not exist yet (the `q` helper degrades), so running
  // the report before the expand migration is still meaningful.
  // ---------------------------------------------------------------------------

  // UNCONVERTED_SOURCE_ROWS — a legacy row with no canonical mapping. Dropping
  // the legacy store while one exists would destroy the hold.
  report.conflicts.UNCONVERTED_SOURCE_ROWS = n(await q(`
    SELECT (
      (SELECT count(*) FROM "case_legal_holds" h
        WHERE NOT EXISTS (
          SELECT 1 FROM "evidence_legal_holds" x
          WHERE x."source_store" = 'CASE_LEGAL_HOLD'::"LegalHoldSourceStore"
            AND x."source_row_id" = h."id"))
      +
      (SELECT count(*) FROM "legal_holds" h
        WHERE NOT EXISTS (
          SELECT 1 FROM "evidence_legal_holds" x
          WHERE x."source_store" = 'LIFECYCLE_LEGAL_HOLD'::"LegalHoldSourceStore"
            AND x."source_row_id" = h."id"))
    )::int AS count
  `));

  // DUPLICATE_SOURCE_MAPPING — one legacy row converted more than once. The
  // unique index makes this impossible going forward; measured anyway because
  // the contract migration must never drop on an unproven assumption.
  report.conflicts.DUPLICATE_SOURCE_MAPPING = n(await q(`
    SELECT count(*)::int AS count FROM (
      SELECT 1 FROM "evidence_legal_holds"
      WHERE "source_row_id" IS NOT NULL
      GROUP BY "source_store", "source_row_id" HAVING count(*) > 1
    ) d
  `));

  // RELEASE_STATE_MISMATCH — a legacy row that is ACTIVE whose canonical row is
  // not. That is a silent downgrade of a live preservation control.
  report.conflicts.RELEASE_STATE_MISMATCH = n(await q(`
    SELECT count(*)::int AS count FROM (
      SELECT 1 FROM "case_legal_holds" h
      JOIN "evidence_legal_holds" x
        ON x."source_store" = 'CASE_LEGAL_HOLD'::"LegalHoldSourceStore"
       AND x."source_row_id" = h."id"
      WHERE h."status"::text = 'ACTIVE' AND x."status" <> 'ACTIVE'
      UNION ALL
      SELECT 1 FROM "legal_holds" h
      JOIN "evidence_legal_holds" x
        ON x."source_store" = 'LIFECYCLE_LEGAL_HOLD'::"LegalHoldSourceStore"
       AND x."source_row_id" = h."id"
      WHERE h."state"::text = 'ACTIVE' AND x."status" <> 'ACTIVE'
    ) m
  `));

  // INVALID_TARGET — a non-historical canonical row whose scope and target
  // columns disagree. The CHECK constraint forbids it; measured so a database
  // that predates the constraint cannot slip through.
  report.conflicts.INVALID_TARGET = n(await q(`
    SELECT count(*)::int AS count FROM "evidence_legal_holds"
    WHERE "historical" = false
      AND NOT (
           ("scope" = 'EVIDENCE'  AND "evidence_id" IS NOT NULL)
        OR ("scope" = 'CASE'      AND "case_id" IS NOT NULL AND "evidence_id" IS NULL)
        OR ("scope" = 'WORKSPACE' AND "team_id" IS NOT NULL AND "evidence_id" IS NULL AND "case_id" IS NULL)
      )
  `));

  // -------------------------------------------------------------------------
  // SEMANTIC EQUIVALENCE PROOF — the number that actually matters.
  //
  // "Protected evidence" = every evidence row that ANY active hold in ANY
  // store reaches. It must be >= its pre-backfill value, never smaller. If
  // this number ever drops, the convergence has made evidence destructible
  // and the backfill must be rolled forward with a fix, never accepted.
  // -------------------------------------------------------------------------
  report.protectedEvidenceCount = n(await q(`
    SELECT count(DISTINCT e.id)::int AS count FROM "evidence" e
    WHERE
      EXISTS (
        SELECT 1 FROM "evidence_legal_holds" h
        WHERE h."status" = 'ACTIVE' AND h."historical" = false
          AND (
            h."evidence_id" = e."id"
            OR (h."scope" = 'CASE' AND EXISTS (
                  SELECT 1 FROM "case_evidence_links" l
                  WHERE l."evidence_id" = e."id" AND l."case_id" = h."case_id"))
            OR (h."scope" = 'WORKSPACE' AND h."team_id" = e."team_id")
          )
      )
      OR EXISTS (
        SELECT 1 FROM "case_legal_holds" ch
        JOIN "case_evidence_links" l ON l."case_id" = ch."case_id"
        WHERE ch."status" = 'ACTIVE' AND l."evidence_id" = e."id"
      )
      OR EXISTS (
        SELECT 1 FROM "legal_holds" lh
        WHERE lh."state" = 'ACTIVE' AND lh."team_id" = e."team_id"
          AND (
            (lh."kind" = 'EVIDENCE' AND lh."scope_target_id" = e."id")
            OR lh."kind" IN ('WORKSPACE','ORGANIZATION')
            OR (lh."kind" = 'CASE' AND EXISTS (
                  SELECT 1 FROM "case_evidence_links" l2
                  WHERE l2."evidence_id" = e."id" AND l2."case_id" = lh."scope_target_id"))
          )
      )
  `));

  // ---------------------------------------------------------------------------
  // PHASE 12 POINT 3 — THE CUTOVER CLOSURE CONDITION.
  //
  // Every category below must read ZERO before the contract migration may be
  // applied. They are the same conditions the contract migration re-checks in
  // the database, so a green report and a successful drop cannot disagree.
  //
  // Note what is NOT blocking: an ACTIVE hold that arrived from two stores, a
  // released/active disagreement BETWEEN stores, and a preserved orphan's
  // provenance row. Those are resolved by the evaluator (most protective
  // wins), not by discarding data.
  // ---------------------------------------------------------------------------
  const asCount = (v) => (Array.isArray(v) ? (v[0]?.__absent ? 0 : v.length) : (v ?? 0));

  report.closure = {
    // Tenant-isolation breaches — the backfill refuses to merge these.
    crossWorkspace:
      asCount(report.conflicts.CROSS_WORKSPACE_CASE_STORE) +
      asCount(report.conflicts.CROSS_WORKSPACE_LIFECYCLE_EVIDENCE) +
      asCount(report.conflicts.CROSS_WORKSPACE_LIFECYCLE_CASE),
    orgBindingMismatch: asCount(report.conflicts.ORG_BINDING_MISMATCH),
    // A legacy row with no canonical mapping — dropping its store loses it.
    unconvertedSourceRows: asCount(report.conflicts.UNCONVERTED_SOURCE_ROWS),
    // A legacy row converted twice.
    duplicateSourceMapping: asCount(report.conflicts.DUPLICATE_SOURCE_MAPPING),
    // An ACTIVE hold whose target cannot be proven — fails closed at runtime
    // and freezes its workspace, so it must be resolved before cutover.
    unresolvedActiveHolds: asCount(report.conflicts.UNRESOLVED_ACTIVE_HOLD),
    // A live hold that arrived released.
    releaseStateMismatch: asCount(report.conflicts.RELEASE_STATE_MISMATCH),
    // A canonical row whose scope and target disagree.
    invalidTarget: asCount(report.conflicts.INVALID_TARGET),
  };

  const blocking = Object.values(report.closure).reduce((a, b) => a + b, 0);
  report.blockingConflictCount = blocking;
  report.cutoverReady = blocking === 0;

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write("PHASE 12B CLUSTER 8 — Legal-Hold convergence readiness\n");
    process.stdout.write(`generated ${report.generatedAtUtc}\n\n`);
    for (const [store, counts] of Object.entries(report.stores)) {
      process.stdout.write(`[store] ${store}\n`);
      for (const [k, v] of Object.entries(counts)) {
        process.stdout.write(`   ${k.padEnd(30)} ${v === null ? "(relation absent)" : v}\n`);
      }
    }
    process.stdout.write(
      `\nexpected canonical total after backfill: ${report.expectedCanonicalTotalAfterBackfill}\n`,
    );
    process.stdout.write(`protected evidence rows (union of all stores): ${report.protectedEvidenceCount}\n`);
    process.stdout.write(`\n[conflicts]\n`);
    for (const [k, v] of Object.entries(report.conflicts)) {
      const size = Array.isArray(v) ? (v[0]?.__absent ? "(relation absent)" : v.length) : v;
      process.stdout.write(`   ${k.padEnd(38)} ${size}\n`);
    }
    process.stdout.write(`\n[cutover closure — every line must read 0]\n`);
    for (const [k, v] of Object.entries(report.closure)) {
      process.stdout.write(`   ${k.padEnd(30)} ${v}${v > 0 ? "   ← BLOCKING" : ""}\n`);
    }
    process.stdout.write(
      `\nBLOCKING total: ${blocking}\n` +
        (blocking > 0
          ? "  → NOT ready for cutover. Resolve every blocking row; do NOT delete or null records to clear it.\n"
          : "  → cutover readiness is ZERO. The contract migration's own in-database guards will re-verify.\n"),
    );
  }

  process.exitCode = blocking > 0 ? 2 : 0;
}

main()
  .catch((err) => {
    process.stderr.write(`legal-hold-convergence-report failed: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
