/**
 * Phase HOME-DATA-OWNERSHIP — personal team-ownership backfill.
 *
 *   Dry run (default — read-only, prints the full repair plan):
 *     pnpm --filter proovra-api tsx scripts/backfill-personal-team-ownership.ts
 *
 *   Apply:
 *     pnpm --filter proovra-api tsx scripts/backfill-personal-team-ownership.ts --apply
 *
 *   Also bootstrap personal Teams for owners that lack one (uses the
 *   same concurrency-safe ensurePersonalWorkspace helper as the
 *   platform-context request path):
 *     ... --apply --bootstrap-missing
 *
 * WHAT IT REPAIRS
 *
 *   1. evidence.team_id IS NULL          → owner's personal Team id
 *   2. evidence.team_id → no Team row    → owner's personal Team id
 *      (dangling reference; the FK-less legacy column allowed these)
 *   3. cases.team_id   IS NULL / dangling → owner's personal Team id
 *
 *   Alongside team_id, evidence.organization_id is stamped from the
 *   personal Team's organization_id WHERE it was NULL — required by the
 *   Phase A1 CHECK constraint (team_id NOT NULL ⇒ organization_id NOT
 *   NULL). Rows that already carry a non-null organization_id keep it.
 *
 * RULES
 *   - Never overwrites a valid team_id.
 *   - Owners WITHOUT a personal Team are skipped and logged (unless
 *     --bootstrap-missing, which creates the Team+Org via the
 *     production bootstrap helper).
 *   - Idempotent: a second run finds zero rows to repair.
 *   - Dry-run executes ONLY SELECTs.
 *   - Per-owner UPDATEs run in one transaction per owner; a failure on
 *     one owner does not poison the rest.
 */

import "dotenv/config";

import { prisma } from "../src/db.js";
import { ensurePersonalWorkspace } from "../src/services/platform-context/workspace-bootstrap.service.js";

const APPLY = process.argv.includes("--apply");
const BOOTSTRAP_MISSING = process.argv.includes("--bootstrap-missing");

type Row = Record<string, unknown>;

function n(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

async function counts(label: string): Promise<{
  evidenceTotal: number;
  evidenceNullTeam: number;
  evidenceDangling: number;
  casesTotal: number;
  casesNullTeam: number;
  casesDangling: number;
}> {
  const [r] = await prisma.$queryRawUnsafe<Row[]>(`
    SELECT
      (SELECT COUNT(*) FROM evidence)                                                          AS evidence_total,
      (SELECT COUNT(*) FROM evidence WHERE team_id IS NULL)                                    AS evidence_null_team,
      (SELECT COUNT(*) FROM evidence e WHERE e.team_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = e.team_id))                        AS evidence_dangling,
      (SELECT COUNT(*) FROM cases)                                                             AS cases_total,
      (SELECT COUNT(*) FROM cases WHERE team_id IS NULL)                                       AS cases_null_team,
      (SELECT COUNT(*) FROM cases c WHERE c.team_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = c.team_id))                        AS cases_dangling
  `);
  const out = {
    evidenceTotal: n(r.evidence_total),
    evidenceNullTeam: n(r.evidence_null_team),
    evidenceDangling: n(r.evidence_dangling),
    casesTotal: n(r.cases_total),
    casesNullTeam: n(r.cases_null_team),
    casesDangling: n(r.cases_dangling),
  };
  console.log(`\n=== ${label} ===`);
  console.log(
    `evidence: total=${out.evidenceTotal} null_team=${out.evidenceNullTeam} dangling_team=${out.evidenceDangling}`,
  );
  console.log(
    `cases:    total=${out.casesTotal} null_team=${out.casesNullTeam} dangling_team=${out.casesDangling}`,
  );
  return out;
}

async function main(): Promise<void> {
  console.log(
    `backfill-personal-team-ownership — mode=${APPLY ? "APPLY" : "DRY-RUN"}` +
      (BOOTSTRAP_MISSING ? " (+bootstrap-missing)" : ""),
  );

  const before = await counts("BEFORE");

  // ---------------------------------------------------------------
  // Owners holding repairable rows (NULL or dangling team_id), with
  // their personal Team (if any).
  // ---------------------------------------------------------------
  const owners = await prisma.$queryRawUnsafe<Row[]>(`
    WITH repairable AS (
      SELECT e.owner_user_id, COUNT(*) AS evidence_rows
      FROM evidence e
      WHERE e.team_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = e.team_id)
      GROUP BY e.owner_user_id
    ),
    repairable_cases AS (
      SELECT c.owner_user_id, COUNT(*) AS case_rows
      FROM cases c
      WHERE c.team_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = c.team_id)
      GROUP BY c.owner_user_id
    )
    SELECT
      COALESCE(r.owner_user_id, rc.owner_user_id)        AS owner_user_id,
      u.email                                            AS owner_email,
      u.id IS NOT NULL                                   AS owner_exists,
      COALESCE(r.evidence_rows, 0)                       AS evidence_rows,
      COALESCE(rc.case_rows, 0)                          AS case_rows,
      pt.id                                              AS personal_team_id,
      pt.organization_id                                 AS personal_org_id
    FROM repairable r
    FULL OUTER JOIN repairable_cases rc ON rc.owner_user_id = r.owner_user_id
    LEFT JOIN users u ON u.id::text = COALESCE(r.owner_user_id, rc.owner_user_id)::text
    LEFT JOIN teams pt ON pt.owner_user_id::text = u.id::text AND pt.is_personal = true
    ORDER BY COALESCE(r.evidence_rows, 0) DESC
  `);

  console.log(`\nOwners with repairable rows: ${owners.length}`);

  let repairedEvidence = 0;
  let repairedCases = 0;
  let bootstrapped = 0;
  const skipped: Array<{ owner: string; rows: number; reason: string }> = [];
  const repairedByOwner: Array<{
    owner: string;
    evidence: number;
    cases: number;
    personalTeamId: string;
  }> = [];

  for (const o of owners) {
    const ownerUserId = String(o.owner_user_id);
    const ownerLabel = (o.owner_email as string | null) ?? ownerUserId;
    const evidenceRows = n(o.evidence_rows);
    const caseRows = n(o.case_rows);
    let personalTeamId = (o.personal_team_id as string | null) ?? null;

    if (o.owner_exists !== true) {
      skipped.push({
        owner: ownerLabel,
        rows: evidenceRows + caseRows,
        reason: "owner user row no longer exists — cannot resolve a personal team",
      });
      continue;
    }

    if (!personalTeamId && BOOTSTRAP_MISSING && APPLY) {
      const boot = await ensurePersonalWorkspace({ userId: ownerUserId });
      personalTeamId = boot.teamId;
      bootstrapped += 1;
      console.log(
        `bootstrapped personal team ${personalTeamId} for ${ownerLabel}`,
      );
    }

    if (!personalTeamId) {
      skipped.push({
        owner: ownerLabel,
        rows: evidenceRows + caseRows,
        reason: BOOTSTRAP_MISSING
          ? "no personal team (dry-run; would bootstrap on --apply)"
          : "owner has no personal Team row (re-run with --bootstrap-missing to create one)",
      });
      continue;
    }

    if (!APPLY) {
      console.log(
        `DRY-RUN would repair ${ownerLabel}: evidence=${evidenceRows} cases=${caseRows} → team ${personalTeamId}`,
      );
      repairedByOwner.push({
        owner: ownerLabel,
        evidence: evidenceRows,
        cases: caseRows,
        personalTeamId,
      });
      continue;
    }

    try {
      const [evCount, caseCount] = await prisma.$transaction(async (tx) => {
        // Evidence: NULL or dangling team_id → personal team. The
        // organization_id is stamped from the personal team ONLY where
        // currently NULL (Phase A1 CHECK: team_id ⇒ organization_id).
        const ev = await tx.$executeRawUnsafe(
          `
          UPDATE evidence e
          SET team_id = $1::uuid,
              organization_id = COALESCE(
                e.organization_id,
                (SELECT t.organization_id FROM teams t WHERE t.id = $1::uuid)
              )
          WHERE e.owner_user_id::text = $2
            AND (
              e.team_id IS NULL
              OR NOT EXISTS (SELECT 1 FROM teams t2 WHERE t2.id = e.team_id)
            )
          `,
          personalTeamId,
          ownerUserId,
        );
        const cs = await tx.$executeRawUnsafe(
          `
          UPDATE cases c
          SET team_id = $1::uuid
          WHERE c.owner_user_id::text = $2
            AND (
              c.team_id IS NULL
              OR NOT EXISTS (SELECT 1 FROM teams t2 WHERE t2.id = c.team_id)
            )
          `,
          personalTeamId,
          ownerUserId,
        );
        return [ev, cs] as const;
      });
      repairedEvidence += evCount;
      repairedCases += caseCount;
      repairedByOwner.push({
        owner: ownerLabel,
        evidence: evCount,
        cases: caseCount,
        personalTeamId,
      });
      console.log(
        `repaired ${ownerLabel}: evidence=${evCount} cases=${caseCount} → team ${personalTeamId}`,
      );
    } catch (err) {
      skipped.push({
        owner: ownerLabel,
        rows: evidenceRows + caseRows,
        reason: `update failed: ${(err as Error).message.split("\n")[0]}`,
      });
    }
  }

  const after = await counts("AFTER");

  console.log("\n=== SUMMARY ===");
  console.log(`mode:                      ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`evidence NULL before:      ${before.evidenceNullTeam}`);
  console.log(`evidence dangling before:  ${before.evidenceDangling}`);
  console.log(`evidence NULL after:       ${after.evidenceNullTeam}`);
  console.log(`evidence dangling after:   ${after.evidenceDangling}`);
  console.log(`cases NULL before/after:   ${before.casesNullTeam} → ${after.casesNullTeam}`);
  console.log(`cases dangling before/after: ${before.casesDangling} → ${after.casesDangling}`);
  console.log(`evidence rows repaired:    ${repairedEvidence}`);
  console.log(`case rows repaired:        ${repairedCases}`);
  console.log(`personal teams bootstrapped: ${bootstrapped}`);
  console.log("\nrepaired by owner:");
  for (const r of repairedByOwner) {
    console.log(
      `  ${r.owner}: evidence=${r.evidence} cases=${r.cases} team=${r.personalTeamId}`,
    );
  }
  console.log("\nskipped owners:");
  if (skipped.length === 0) console.log("  (none)");
  for (const s of skipped) {
    console.log(`  ${s.owner}: ${s.rows} rows — ${s.reason}`);
  }
}

main()
  .catch((err) => {
    console.error("BACKFILL FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
