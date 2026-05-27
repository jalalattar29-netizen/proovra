#!/usr/bin/env node
/**
 * Phase A1 — Evidence tenancy diagnostic.
 *
 * READ-ONLY. Inspects the live database and surfaces tenancy
 * inconsistencies between `evidence`, `teams`, and `organizations`.
 * Output is human-readable + machine-greppable per-row. Operators
 * use this BEFORE applying the A1 migration to size the population,
 * and AFTER to confirm the backfill landed cleanly.
 *
 * Four checks, exit-code-distinct:
 *
 *   1. evidence_team_org_mismatch:
 *      rows where `evidence.team_id` is set, the bound team has a
 *      real organization_id, and `evidence.organization_id` either
 *      is NULL or is set to a value that disagrees with the team's
 *      organization.
 *
 *   2. evidence_org_id_equals_team_id (the Phase A1 write-path bug):
 *      rows where `evidence.organization_id` equals the team's id
 *      instead of the team's organization_id.
 *
 *   3. evidence_org_dangling_fk:
 *      rows where `evidence.organization_id` points at a uuid that
 *      does not exist in `organizations`.
 *
 *   4. personal_mode_rows_with_team:
 *      rows where `team_id IS NULL` but `organization_id IS NOT NULL`.
 *      The A1 CHECK constraint disallows the reverse; this is the
 *      complementary anomaly.
 *
 * Hard rules:
 *   * Never mutates.
 *   * Refuses to run against a non-local host unless
 *     `TENANCY_DIAGNOSTIC_ALLOW_REMOTE=1` is set.
 *   * Bounded output: 50 rows max per check.
 *
 * Exit codes:
 *   0  all clean
 *   1  internal error
 *   2  host refusal
 *   7  at least one WARN (no FAIL)
 *   8  at least one FAIL
 *
 * Usage:
 *   pnpm --filter proovra-api exec node scripts/evidence-tenancy-diagnostic.mjs
 *   pnpm --filter proovra-api exec node scripts/evidence-tenancy-diagnostic.mjs --export-csv ./tmp/tenancy.csv
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

const args = process.argv.slice(2);
function getFlagValue(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}
const exportCsvPath = getFlagValue("export-csv");
const allowRemote = process.env.TENANCY_DIAGNOSTIC_ALLOW_REMOTE === "1";

const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
if (!databaseUrl) {
  process.stderr.write("[evidence-tenancy] DATABASE_URL not set.\n");
  process.exit(1);
}
const { host, database } = parseDatabaseHost(databaseUrl);
const classification = classifyHost(host);
if (classification !== "local" && !allowRemote) {
  process.stderr.write(
    `[evidence-tenancy] REFUSED: host "${host}" classification=${classification}.\n` +
      "  Set TENANCY_DIAGNOSTIC_ALLOW_REMOTE=1 to run against a non-local host.\n",
  );
  process.exit(2);
}

process.stderr.write("\n");
process.stderr.write(
  "──────────────────────────────────────────────────────────\n",
);
process.stderr.write("  PROOVRA Phase A1 — evidence tenancy diagnostic\n");
process.stderr.write(
  "──────────────────────────────────────────────────────────\n",
);
process.stderr.write(`  host         : ${host}\n`);
process.stderr.write(`  database     : ${database}\n`);
process.stderr.write(`  classification: ${classification.toUpperCase()}\n`);
process.stderr.write(
  "──────────────────────────────────────────────────────────\n\n",
);

const pool = new pg.Pool({ connectionString: databaseUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const findings = [];
let fail = 0;
let warn = 0;

try {
  // Check 1 — evidence_team_org_mismatch
  const mismatch = await prisma.$queryRawUnsafe(
    `SELECT e.id AS evidence_id,
            e.team_id,
            e.organization_id AS evidence_org_id,
            t.organization_id AS team_org_id
       FROM evidence e
       JOIN teams t ON t.id = e.team_id
       WHERE e.team_id IS NOT NULL
         AND t.organization_id IS NOT NULL
         AND (e.organization_id IS NULL
              OR e.organization_id <> t.organization_id)
       LIMIT 50`,
  );
  if (mismatch.length === 0) {
    findings.push({
      id: "1-evidence-team-org-mismatch",
      status: "PASS",
      detail: "Every evidence row with a team has matching organization_id.",
    });
  } else {
    fail += 1;
    findings.push({
      id: "1-evidence-team-org-mismatch",
      status: "FAIL",
      detail: `${mismatch.length} evidence rows have organization_id != team.organization_id (or NULL while team has a real org).`,
      sample: mismatch.slice(0, 5),
      rows: mismatch,
    });
  }

  // Check 2 — evidence_org_id_equals_team_id (the Phase A1 bug)
  const teamIdInOrgCol = await prisma.$queryRawUnsafe(
    `SELECT e.id AS evidence_id, e.team_id, e.organization_id
       FROM evidence e
       WHERE e.team_id IS NOT NULL
         AND e.organization_id = e.team_id
       LIMIT 50`,
  );
  if (teamIdInOrgCol.length === 0) {
    findings.push({
      id: "2-evidence-org-equals-team-id",
      status: "PASS",
      detail: "No evidence row has organization_id == team_id (the Phase A1 write-path bug).",
    });
  } else {
    fail += 1;
    findings.push({
      id: "2-evidence-org-equals-team-id",
      status: "FAIL",
      detail: `${teamIdInOrgCol.length} evidence rows have organization_id set to the team's uuid (the pre-A1 write-path bug). The A1 migration UPDATE will heal these.`,
      sample: teamIdInOrgCol.slice(0, 5),
      rows: teamIdInOrgCol,
    });
  }

  // Check 3 — evidence_org_dangling_fk
  const dangling = await prisma.$queryRawUnsafe(
    `SELECT e.id AS evidence_id, e.organization_id
       FROM evidence e
       LEFT JOIN organizations o ON o.id = e.organization_id
       WHERE e.organization_id IS NOT NULL
         AND o.id IS NULL
       LIMIT 50`,
  );
  if (dangling.length === 0) {
    findings.push({
      id: "3-evidence-org-fk-dangling",
      status: "PASS",
      detail: "Every non-null evidence.organization_id resolves to a real organization.",
    });
  } else {
    fail += 1;
    findings.push({
      id: "3-evidence-org-fk-dangling",
      status: "FAIL",
      detail: `${dangling.length} evidence rows reference a non-existent organization_id (will be rejected by the A1 FK).`,
      sample: dangling.slice(0, 5),
      rows: dangling,
    });
  }

  // Check 4 — personal_mode_rows_with_team
  const inverse = await prisma.$queryRawUnsafe(
    `SELECT e.id AS evidence_id, e.organization_id
       FROM evidence e
       WHERE e.team_id IS NULL
         AND e.organization_id IS NOT NULL
       LIMIT 50`,
  );
  if (inverse.length === 0) {
    findings.push({
      id: "4-personal-mode-with-org-id",
      status: "PASS",
      detail: "No evidence row has team_id IS NULL AND organization_id IS NOT NULL.",
    });
  } else {
    warn += 1;
    findings.push({
      id: "4-personal-mode-with-org-id",
      status: "WARN",
      detail: `${inverse.length} evidence rows have organization_id set but no team_id. Not a hard violation, but indicates earlier inconsistent writes.`,
      sample: inverse.slice(0, 5),
      rows: inverse,
    });
  }
} catch (err) {
  process.stderr.write(`[evidence-tenancy] internal error: ${err?.message ?? err}\n`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
}

await prisma.$disconnect().catch(() => {});

// Render
process.stderr.write("\n");
for (const f of findings) {
  const icon = f.status === "PASS" ? "✓" : f.status === "WARN" ? "⚠" : "✗";
  process.stderr.write(
    `  [${f.status.padEnd(4, " ")}] ${icon}  ${f.id}\n         ${f.detail}\n`,
  );
  if (f.sample && f.sample.length > 0) {
    for (const row of f.sample) {
      process.stderr.write(`           ${JSON.stringify(row)}\n`);
    }
  }
}
process.stderr.write(
  "──────────────────────────────────────────────────────────\n",
);
process.stderr.write(
  `  Result: ${fail} fail / ${warn} warn / ${findings.length - fail - warn} pass\n`,
);
process.stderr.write(
  "──────────────────────────────────────────────────────────\n\n",
);

if (exportCsvPath) {
  const dir = dirname(exportCsvPath);
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const rows = [
    "check_id,status,evidence_id,team_id,evidence_org_id,team_org_id",
  ];
  for (const f of findings) {
    for (const r of f.rows ?? []) {
      rows.push(
        [
          f.id,
          f.status,
          r.evidence_id ?? "",
          r.team_id ?? "",
          r.evidence_org_id ?? r.organization_id ?? "",
          r.team_org_id ?? "",
        ].join(","),
      );
    }
  }
  writeFileSync(exportCsvPath, `${rows.join("\n")}\n`, "utf8");
  process.stderr.write(`[evidence-tenancy] wrote ${exportCsvPath}\n`);
}

if (fail > 0) process.exit(8);
if (warn > 0) process.exit(7);
process.exit(0);
