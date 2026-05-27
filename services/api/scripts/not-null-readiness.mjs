#!/usr/bin/env node
/**
 * Phase 2.7X Stage 5 — NOT NULL tightening readiness probe.
 *
 * Read-only diagnostic. Refuses to write. For each column that
 * Stage 6 is considering tightening from NULL to NOT NULL, this
 * reports:
 *
 *   - the current null count in the live LOCAL DB
 *   - whether runtime code paths assume the column is non-null
 *   - whether tightening would block on existing data
 *   - what the recommended remediation is
 *
 * The exit code is deliberately ALWAYS 0 on success (this is a
 * report, not a gate). Use the report output to decide whether
 * to commit a tightening migration in Stage 6.
 *
 * Usage:
 *   pnpm --filter proovra-api db:not-null-readiness
 *
 * Hard rules:
 *   - This script NEVER mutates anything.
 *   - Refuses to run against a non-local DB (same classification
 *     guard as check-org-consistency).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import {
  classifyHost,
  parseDatabaseHost,
} from "./db-host-policy.mjs";

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile(resolve(process.cwd(), ".env"));
loadEnvFile(resolve(process.cwd(), "services/api/.env"));

const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
if (!databaseUrl) {
  process.stderr.write("[not-null-readiness] DATABASE_URL not set.\n");
  process.exit(1);
}
const { host } = parseDatabaseHost(databaseUrl);
const classification = classifyHost(host);
if (classification !== "local") {
  process.stderr.write(
    "[not-null-readiness] REFUSED: report-only on local DB.\n",
  );
  process.exit(2);
}

/**
 * Tightening candidates — populated from the Phase 2.7 staged
 * migration plan (Stage 5-6 cutover). Each entry has:
 *
 *   table        — Postgres table name
 *   column       — Postgres column name (snake_case)
 *   countSql     — SELECT COUNT(*) FROM table WHERE column IS NULL
 *   runtimeDep   — runtime code paths that assume NOT NULL
 *   safeIfZero   — true if "0 nulls today" + runtime dep tolerance
 *                  implies tightening is safe; false if there's a
 *                  semantic concern even at 0 nulls
 *   remediation  — what to do if nulls exist
 */
const candidates = [
  {
    id: "teams.organization_id",
    table: "teams",
    column: "organization_id",
    countSql: `SELECT COUNT(*)::int AS n FROM teams WHERE organization_id IS NULL`,
    runtimeDep:
      "Phase 2.7X Stage 6 — NOW NOT NULL at schema level. The Stage 6 migration tightened this. Future drift can't occur unless Stage 7 explicitly relaxes the constraint.",
    safeIfZero: true,
    remediation:
      "Already tightened (Stage 6). Re-run `pnpm db:backfill:orgs` if any drift somehow occurred (it cannot at the schema level).",
  },
  {
    id: "organizations.billing_owner_user_id",
    table: "organizations",
    column: "billing_owner_user_id",
    countSql: `SELECT COUNT(*)::int AS n FROM organizations WHERE billing_owner_user_id IS NULL`,
    runtimeDep:
      "Stage 4 POST /v1/orgs sets it to the creator's userId. Backfill sets it to the team owner. No production read path requires it yet, but Stage 6 billing aggregation will.",
    safeIfZero: false,
    remediation:
      "Confirm Stage 4 mutation always populates; investigate any NULLs as backfill drift.",
  },
  {
    id: "organization_invites.invited_by_user_id",
    table: "organization_invites",
    column: "invited_by_user_id",
    countSql: `SELECT COUNT(*)::int AS n FROM organization_invites WHERE invited_by_user_id IS NULL`,
    runtimeDep:
      "Stage 4 POST /v1/orgs/:id/invites enforces non-null. The schema already declares NOT NULL at this column, so this check is defense-in-depth.",
    safeIfZero: true,
    remediation: "n/a — already NOT NULL in schema.",
  },
  {
    id: "organization_memberships.user_id",
    table: "organization_memberships",
    column: "user_id",
    countSql: `SELECT COUNT(*)::int AS n FROM organization_memberships WHERE user_id IS NULL`,
    runtimeDep:
      "Schema declares NOT NULL. FK with CASCADE delete on users(id).",
    safeIfZero: true,
    remediation: "n/a — already NOT NULL.",
  },
];

const pool = new pg.Pool({ connectionString: databaseUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const rows = [];
try {
  for (const c of candidates) {
    const result = await prisma.$queryRawUnsafe(c.countSql);
    const nullCount = Number(result[0]?.n ?? 0);
    const verdict =
      nullCount === 0 && c.safeIfZero
        ? "READY"
        : nullCount === 0
        ? "READY-SOFT"
        : "BLOCKED";
    rows.push({
      id: c.id,
      nullCount,
      runtimeDep: c.runtimeDep,
      verdict,
      remediation: c.remediation,
    });
  }
} finally {
  await prisma.$disconnect().catch(() => {});
}

process.stderr.write("\n");
process.stderr.write("───────────────────────────────────────────────────────────────\n");
process.stderr.write("  PROOVRA Phase 2.7X Stage 5 — NOT NULL tightening readiness\n");
process.stderr.write("───────────────────────────────────────────────────────────────\n");
process.stderr.write(
  `  ${"Field".padEnd(48)}  ${"Nulls".padEnd(6)}  Verdict\n`,
);
process.stderr.write(
  `  ${"-".repeat(48)}  ${"------"}  ${"----------"}\n`,
);
for (const r of rows) {
  process.stderr.write(
    `  ${r.id.padEnd(48)}  ${String(r.nullCount).padEnd(6)}  ${r.verdict}\n`,
  );
}
process.stderr.write("───────────────────────────────────────────────────────────────\n");
process.stderr.write("  Verdicts:\n");
process.stderr.write("    READY       — 0 nulls AND runtime tolerates tightening today.\n");
process.stderr.write("    READY-SOFT  — 0 nulls BUT a semantic concern remains.\n");
process.stderr.write("    BLOCKED     — non-zero nulls; remediation required first.\n");
process.stderr.write("───────────────────────────────────────────────────────────────\n\n");

for (const r of rows) {
  if (r.verdict === "BLOCKED") {
    process.stderr.write(`  BLOCKED: ${r.id}\n    ${r.remediation}\n`);
  }
}

process.exit(0);
