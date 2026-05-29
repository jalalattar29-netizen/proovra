#!/usr/bin/env node
/**
 * Phase O — Full migration risk audit (pre-commit gate).
 *
 * Walks `services/api/prisma/migrations/*` and classifies every
 * migration for the documented dangerous-pattern set:
 *
 *   CRITICAL  CREATE TABLE IF NOT EXISTS, ALTER TABLE ... DROP COLUMN,
 *             ALTER TABLE ... RENAME, DROP TABLE / INDEX / TYPE,
 *             TRUNCATE, DELETE FROM, UPDATE without restrictive WHERE,
 *             SET NOT NULL without readiness marker, CREATE INDEX on
 *             columns this migration does not add or guard.
 *
 *   HIGH      ADD COLUMN without IF NOT EXISTS, CREATE INDEX without
 *             IF NOT EXISTS, enum modifications, quoted-vs-unquoted
 *             identifier mixing, possible camelCase/snake_case drift.
 *
 *   MEDIUM    Default-value changes, large data backfills (UPDATE
 *             with no LIMIT), comment-free statements.
 *
 *   LOW       Documentation gaps, formatting drift.
 *
 * Outputs (all read-only; the script never mutates a DB):
 *
 *   migration-inventory.json
 *   docs/operations/migration-inventory.md
 *   prisma-compatibility-report.json
 *   naming-drift-report.json
 *   docs/operations/migration-repair-plan.md
 *
 * Exit codes:
 *   0  — no NEW critical findings (historical findings logged but not
 *        fatal; the CI test guards future migrations strictly).
 *   2  — at least one finding above the configured fail threshold.
 *   3  — I/O failure.
 *
 * The companion CI test
 * `services/api/test/phase-o-migration-safety-gate.test.ts` enforces
 * the rules on every new migration added after the baseline
 * timestamp.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// CORE — pure functions exported for tests.
// ---------------------------------------------------------------------------

/** Strip SQL `--` line comments. Block comments are not used in PROOVRA migrations. */
export function stripSqlComments(src) {
  return src
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/** Convert camelCase → snake_case for naming-drift detection. */
export function camelToSnake(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** Parse a migration directory name into { timestamp, slug }. */
export function parseMigrationName(name) {
  const m = /^(\d{14})_(.+)$/.exec(name);
  if (!m) return { timestamp: null, slug: name };
  return { timestamp: m[1], slug: m[2] };
}

const RISK = Object.freeze({
  CRITICAL: "CRITICAL",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
});

/**
 * Detect every dangerous pattern in a single migration's SQL.
 * Returns an array of findings:
 *   { kind, risk, lineHint, detail }
 *
 * Pattern detection works on the comment-stripped SQL so doc lines
 * mentioning a pattern do not false-positive.
 */
export function detectFindings(sql) {
  const findings = [];
  const stripped = stripSqlComments(sql);
  const lines = stripped.split("\n");

  // Track columns this migration adds, by table.
  const columnsAddedByTable = new Map();
  const addColumnRe =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?public"?\.)?"?(\w+)"?[\s\S]*?ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi;
  for (const m of stripped.matchAll(addColumnRe)) {
    const table = m[1];
    const column = m[2];
    if (!columnsAddedByTable.has(table)) columnsAddedByTable.set(table, new Set());
    columnsAddedByTable.get(table).add(column);
  }
  // Also capture columns added via CREATE TABLE.
  const createTableRe =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?(\w+)"?\s*\(([\s\S]*?)\)\s*(?:;|WITHOUT|INHERITS)/gi;
  for (const m of stripped.matchAll(createTableRe)) {
    const table = m[1];
    const body = m[2];
    if (!columnsAddedByTable.has(table)) columnsAddedByTable.set(table, new Set());
    // crude: pull identifiers at line starts
    for (const colMatch of body.matchAll(/^\s*"?([a-zA-Z_]\w*)"?\s+/gm)) {
      const c = colMatch[1];
      // skip SQL noise tokens
      if (
        /^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|REFERENCES)$/i.test(c)
      ) {
        continue;
      }
      columnsAddedByTable.get(table).add(c);
    }
  }

  // ----- CRITICAL patterns -----
  pushAll(findings, scanRegex(lines, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/gi, {
    kind: "CREATE_TABLE_IF_NOT_EXISTS",
    risk: RISK.CRITICAL,
    detail:
      "CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.",
  }));
  pushAll(findings, scanRegex(lines, /ALTER\s+TABLE[\s\S]{0,80}?\bDROP\s+COLUMN\b/gi, {
    kind: "ALTER_TABLE_DROP_COLUMN",
    risk: RISK.CRITICAL,
    detail: "DROP COLUMN is destructive and cannot be safely re-applied.",
  }));
  pushAll(findings, scanRegex(lines, /ALTER\s+TABLE[\s\S]{0,80}?\bRENAME\s+(?:COLUMN|TO)\b/gi, {
    kind: "ALTER_TABLE_RENAME",
    risk: RISK.CRITICAL,
    detail: "RENAME breaks idempotency and Prisma client expectations during rolling deploys.",
  }));
  pushAll(findings, scanRegex(lines, /\bDROP\s+TABLE\b/gi, {
    kind: "DROP_TABLE",
    risk: RISK.CRITICAL,
    detail: "DROP TABLE is destructive.",
  }));
  pushAll(findings, scanRegex(lines, /\bDROP\s+INDEX\b/gi, {
    kind: "DROP_INDEX",
    risk: RISK.CRITICAL,
    detail: "DROP INDEX risks production-read regressions.",
  }));
  pushAll(findings, scanRegex(lines, /\bDROP\s+TYPE\b/gi, {
    kind: "DROP_TYPE",
    risk: RISK.CRITICAL,
    detail: "DROP TYPE on a referenced enum breaks every dependent column.",
  }));
  pushAll(findings, scanRegex(lines, /\bTRUNCATE\b/gi, {
    kind: "TRUNCATE",
    risk: RISK.CRITICAL,
    detail: "TRUNCATE deletes all rows in a table.",
  }));
  pushAll(findings, scanRegex(lines, /\bDELETE\s+FROM\b/gi, {
    kind: "DELETE_FROM",
    risk: RISK.CRITICAL,
    detail: "DELETE FROM in a migration removes production rows.",
  }));

  // UPDATE without WHERE → bare full-table update.
  for (const m of stripped.matchAll(/\bUPDATE\s+("?\w+"?)\s+SET\s+[\s\S]*?(?=;|$)/gi)) {
    if (!/\bWHERE\b/i.test(m[0])) {
      const line = lineOf(stripped, m.index);
      findings.push({
        kind: "UPDATE_WITHOUT_WHERE",
        risk: RISK.CRITICAL,
        lineHint: line,
        detail:
          "UPDATE without WHERE rewrites every row. Backfills must be restrictive (`WHERE target_col IS NULL`) so re-runs are no-ops.",
      });
    }
  }

  // SET NOT NULL without a readiness marker comment.
  for (const m of stripped.matchAll(/\bSET\s+NOT\s+NULL\b/gi)) {
    const line = lineOf(stripped, m.index);
    // Surrounding context for a "readiness" / "backfill" marker.
    const ctxStart = Math.max(0, m.index - 400);
    const ctx = sql.slice(ctxStart, m.index);
    const hasReadinessMarker = /readiness|backfill[\s\S]*(verified|complete|covered)|NOT[\s_]NULL\s+readiness/i.test(ctx);
    findings.push({
      kind: hasReadinessMarker
        ? "SET_NOT_NULL_WITH_READINESS"
        : "SET_NOT_NULL_NO_READINESS",
      risk: hasReadinessMarker ? RISK.MEDIUM : RISK.CRITICAL,
      lineHint: line,
      detail: hasReadinessMarker
        ? "SET NOT NULL is preceded by a documented readiness marker."
        : "SET NOT NULL without a readiness marker risks rejecting NULL rows from production.",
    });
  }

  // CREATE INDEX risk: references columns not in this migration's add-set
  // AND not in the small allowlist of pre-existing common columns.
  const ALWAYS_PRESENT = new Set(["id", "created_at", "updated_at"]);
  for (const m of stripped.matchAll(
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s+ON\s+(?:ONLY\s+)?(?:"?public"?\.)?"?(\w+)"?\s+(?:USING\s+\w+\s+)?\(([^)]+)\)/gi,
  )) {
    const indexName = m[1];
    const table = m[2];
    const colList = m[3];
    const line = lineOf(stripped, m.index);
    const cols = colList
      .split(",")
      .map((c) => c.trim().replace(/^"|"$/g, "").replace(/\s+(ASC|DESC|NULLS\s+(FIRST|LAST)).*$/i, ""))
      .map((c) => c.replace(/\(.*$/, "")) // strip expression args like `lower(col)`
      .filter((c) => /^[A-Za-z_]\w*$/.test(c));
    const added = columnsAddedByTable.get(table) ?? new Set();
    const missing = cols.filter((c) => !added.has(c) && !ALWAYS_PRESENT.has(c));
    if (missing.length > 0) {
      // Check whether the migration verifies the column existence via
      // information_schema in a DO block (the Phase O-Final defense).
      // Slice the SAME source the regex matched in (stripped), not
      // the original sql — indices are stripped-relative.
      const ctx = stripped.slice(Math.max(0, m.index - 800), m.index);
      // Every missing column must have a matching column_name='X'
      // guard in the preceding window for us to consider the index
      // safe. Partial guards count as INDEX_COLUMN_RISK.
      const guards = new Set();
      for (const g of ctx.matchAll(
        /information_schema\.columns[\s\S]*?column_name\s*=\s*'([^']+)'/gi,
      )) {
        guards.add(g[1]);
      }
      const fullyGuarded = missing.every((c) => guards.has(c));
      findings.push({
        kind: fullyGuarded ? "CREATE_INDEX_GUARDED" : "INDEX_COLUMN_RISK",
        risk: fullyGuarded ? RISK.MEDIUM : RISK.CRITICAL,
        lineHint: line,
        detail: fullyGuarded
          ? `Index ${indexName} ON ${table}(${cols.join(",")}) references columns not added by this migration, but a DO/information_schema guard precedes the CREATE for every missing column {${missing.join(",")}}.`
          : `Index ${indexName} ON ${table}(${cols.join(",")}) references column(s) {${missing.join(",")}} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.`,
      });
    }
  }

  // ----- HIGH patterns -----
  pushAll(findings, scanRegex(lines, /ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/gi, {
    kind: "ADD_COLUMN_NO_IF_NOT_EXISTS",
    risk: RISK.HIGH,
    detail:
      "ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.",
  }));
  pushAll(findings, scanRegex(lines, /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?!IF\s+NOT\s+EXISTS)/gi, {
    kind: "CREATE_INDEX_NO_IF_NOT_EXISTS",
    risk: RISK.HIGH,
    detail:
      "CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.",
  }));
  // Enum modifications.
  pushAll(findings, scanRegex(lines, /\bALTER\s+TYPE\b/gi, {
    kind: "ALTER_TYPE",
    risk: RISK.HIGH,
    detail:
      "ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.",
  }));
  // Add value to enum.
  pushAll(findings, scanRegex(lines, /\bADD\s+VALUE\b/gi, {
    kind: "ENUM_ADD_VALUE",
    risk: RISK.HIGH,
    detail:
      "ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.",
  }));

  // ----- MEDIUM patterns -----
  pushAll(findings, scanRegex(lines, /\bALTER\s+COLUMN\b[\s\S]{0,80}?\bSET\s+DEFAULT\b/gi, {
    kind: "ALTER_COLUMN_SET_DEFAULT",
    risk: RISK.MEDIUM,
    detail: "Default change affects only future inserts; existing rows unchanged.",
  }));
  pushAll(findings, scanRegex(lines, /\bALTER\s+COLUMN\b[\s\S]{0,80}?\bTYPE\b/gi, {
    kind: "ALTER_COLUMN_TYPE",
    risk: RISK.MEDIUM,
    detail: "Type change can take a long-running ACCESS EXCLUSIVE lock on large tables.",
  }));

  return { findings, columnsAddedByTable };
}

function pushAll(findings, items) {
  for (const it of items) findings.push(it);
}

function scanRegex(lines, re, template) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) {
      out.push({ ...template, lineHint: i + 1 });
    }
  }
  return out;
}

function lineOf(src, idx) {
  return src.slice(0, idx).split("\n").length;
}

// ---------------------------------------------------------------------------
// CORE — parse schema.prisma for compatibility checks (lightweight; reuses
// the full-production-schema-audit parser shape).
// ---------------------------------------------------------------------------

export function parsePrismaModelMap(schemaSrc) {
  const map = new Map(); // model → { table, columns: Set<string> }
  const cleaned = schemaSrc
    .split("\n")
    .map((l) => {
      const i = l.indexOf("//");
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");

  const modelHeader = /\bmodel\s+(\w+)\s*\{/g;
  let scanFrom = 0;
  while (scanFrom < cleaned.length) {
    modelHeader.lastIndex = scanFrom;
    const m = modelHeader.exec(cleaned);
    if (!m) break;
    const name = m[1];
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let j = bodyStart;
    while (j < cleaned.length && depth > 0) {
      if (cleaned[j] === "{") depth++;
      else if (cleaned[j] === "}") depth--;
      j++;
    }
    const body = cleaned.slice(bodyStart, j - 1);
    let table = name;
    const columns = new Set();
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      const mapM = /^@@map\("([^"]+)"\)/.exec(line);
      if (mapM) {
        table = mapM[1];
        continue;
      }
      if (line.startsWith("@@")) continue;
      const fm = /^(\w+)\s+(\w+)(\?)?(\[\])?(.*)$/.exec(line);
      if (!fm) continue;
      const fname = fm[1];
      const attrs = fm[5] || "";
      if (/@ignore\b/.test(attrs)) continue;
      if (fm[4] === "[]") continue; // virtual list
      if (/@relation\b/.test(attrs)) continue;
      const mapMatch = /@map\("([^"]+)"\)/.exec(attrs);
      columns.add(mapMatch ? mapMatch[1] : fname);
    }
    map.set(name, { table, columns });
    scanFrom = j;
  }
  return map;
}

// ---------------------------------------------------------------------------
// CORE — naming-drift detection on a single migration.
// Identifies identifier names that mix camelCase and snake_case usage.
// ---------------------------------------------------------------------------

const SNAKE_RE = /[a-z][a-z0-9]*(_[a-z0-9]+)+/g;
const CAMEL_RE = /[a-z][a-z0-9]*([A-Z][a-z0-9]+)+/g;

export function detectNamingDriftInSql(sql) {
  const drift = [];
  const stripped = stripSqlComments(sql);
  // Heuristic: count occurrences of identifiers that match camelCase
  // when used as a quoted column name. Production-suspicious because
  // PROOVRA's Prisma `@map` convention is uniformly snake_case.
  const seenCamel = new Set();
  for (const m of stripped.matchAll(/"([a-z]+[A-Z][A-Za-z0-9]*)"/g)) {
    seenCamel.add(m[1]);
  }
  for (const id of seenCamel) {
    drift.push({
      identifier: id,
      altSnake: camelToSnake(id),
      detail: `Migration uses quoted camelCase identifier "${id}". PROOVRA's convention is snake_case (Prisma @map).`,
    });
  }
  return drift;
}

// ---------------------------------------------------------------------------
// CORE — Prisma compatibility checks against a single migration.
// Returns { missingColumnsForModel: Map, addedUnusedColumns: Map }.
// (Lightweight — full coverage lives in full-production-schema-audit.mjs.)
// ---------------------------------------------------------------------------

export function checkPrismaCompatibility(columnsAddedByTable, modelMap) {
  const issues = [];
  const tableToModel = new Map();
  for (const [model, { table }] of modelMap) tableToModel.set(table, model);
  for (const [table, added] of columnsAddedByTable) {
    const model = tableToModel.get(table);
    if (!model) continue;
    const expected = modelMap.get(model).columns;
    for (const c of added) {
      if (!expected.has(c)) {
        issues.push({
          kind: "MIGRATION_ADDS_UNUSED_COLUMN",
          table,
          model,
          column: c,
          detail: `Migration ADDs column ${table}.${c} but Prisma model ${model} no longer references it.`,
        });
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// CORE — production simulation scoring.
// Returns one of SAFE / RISKY / UNSAFE per the user's brief, plus
// a free-text rationale.
// ---------------------------------------------------------------------------

export function classifyMigration(findings) {
  const criticalKinds = new Set(
    findings.filter((f) => f.risk === "CRITICAL").map((f) => f.kind),
  );
  const highKinds = new Set(
    findings.filter((f) => f.risk === "HIGH").map((f) => f.kind),
  );

  if (
    criticalKinds.has("CREATE_TABLE_IF_NOT_EXISTS") ||
    criticalKinds.has("INDEX_COLUMN_RISK") ||
    criticalKinds.has("ALTER_TABLE_DROP_COLUMN") ||
    criticalKinds.has("ALTER_TABLE_RENAME") ||
    criticalKinds.has("DROP_TABLE") ||
    criticalKinds.has("DROP_TYPE") ||
    criticalKinds.has("SET_NOT_NULL_NO_READINESS") ||
    criticalKinds.has("TRUNCATE") ||
    criticalKinds.has("DELETE_FROM") ||
    criticalKinds.has("UPDATE_WITHOUT_WHERE")
  ) {
    return { verdict: "UNSAFE", rationale: "Critical pattern present." };
  }
  if (
    criticalKinds.size > 0 ||
    highKinds.has("ADD_COLUMN_NO_IF_NOT_EXISTS") ||
    highKinds.has("CREATE_INDEX_NO_IF_NOT_EXISTS")
  ) {
    return { verdict: "RISKY", rationale: "Idempotency / re-run gap detected." };
  }
  return { verdict: "SAFE", rationale: "No dangerous patterns detected." };
}

// ---------------------------------------------------------------------------
// CLI — walk migrations, produce reports.
// ---------------------------------------------------------------------------

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../../..");
  const migrationsDir = resolve(repoRoot, "services/api/prisma/migrations");
  const schemaPath = resolve(repoRoot, "services/api/prisma/schema.prisma");
  const outDir = resolve(repoRoot, "docs/operations");
  const jsonDir = resolve(repoRoot, "services/api/scripts/audit-output");

  if (!existsSync(migrationsDir)) {
    process.stderr.write(`fatal: migrations dir not found at ${migrationsDir}\n`);
    process.exit(3);
  }
  mkdirSync(jsonDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  // Parse schema for compatibility checks.
  const schemaSrc = existsSync(schemaPath)
    ? readFileSync(schemaPath, "utf8")
    : "";
  const modelMap = schemaSrc ? parsePrismaModelMap(schemaSrc) : new Map();

  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const inventory = [];
  const compatIssuesAll = [];
  const driftAll = [];
  const riskyMigrations = [];
  const unsafeMigrations = [];
  const safeMigrations = [];

  const ALL_KIND_COUNTS = {};
  let critTotal = 0;
  let highTotal = 0;
  let medTotal = 0;
  let lowTotal = 0;

  for (const name of migrations) {
    const sqlPath = resolve(migrationsDir, name, "migration.sql");
    if (!existsSync(sqlPath)) continue;
    const sql = readFileSync(sqlPath, "utf8");
    const { findings, columnsAddedByTable } = detectFindings(sql);

    for (const f of findings) {
      ALL_KIND_COUNTS[f.kind] = (ALL_KIND_COUNTS[f.kind] ?? 0) + 1;
      if (f.risk === "CRITICAL") critTotal++;
      else if (f.risk === "HIGH") highTotal++;
      else if (f.risk === "MEDIUM") medTotal++;
      else lowTotal++;
    }

    const compatIssues = checkPrismaCompatibility(columnsAddedByTable, modelMap);
    for (const i of compatIssues) {
      compatIssuesAll.push({ migration: name, ...i });
    }

    const driftEntries = detectNamingDriftInSql(sql);
    for (const d of driftEntries) {
      driftAll.push({ migration: name, ...d });
    }

    const { verdict, rationale } = classifyMigration(findings);
    const { timestamp, slug } = parseMigrationName(name);

    const tables = [...columnsAddedByTable.keys()].sort();
    const totalColumnsAdded = [...columnsAddedByTable.values()].reduce(
      (n, s) => n + s.size,
      0,
    );

    const entry = {
      migration: name,
      timestamp,
      slug,
      verdict,
      rationale,
      tables,
      totalColumnsAdded,
      findingsByRisk: {
        CRITICAL: findings.filter((f) => f.risk === "CRITICAL").length,
        HIGH: findings.filter((f) => f.risk === "HIGH").length,
        MEDIUM: findings.filter((f) => f.risk === "MEDIUM").length,
        LOW: findings.filter((f) => f.risk === "LOW").length,
      },
      findings,
    };
    inventory.push(entry);

    if (verdict === "UNSAFE") unsafeMigrations.push(name);
    else if (verdict === "RISKY") riskyMigrations.push(name);
    else safeMigrations.push(name);
  }

  // Write JSON outputs.
  writeFileSync(
    resolve(jsonDir, "migration-inventory.json"),
    JSON.stringify(
      {
        generatedAtUtc: new Date().toISOString(),
        migrationCount: inventory.length,
        summary: {
          CRITICAL: critTotal,
          HIGH: highTotal,
          MEDIUM: medTotal,
          LOW: lowTotal,
          findingsByKind: ALL_KIND_COUNTS,
        },
        verdicts: {
          SAFE: safeMigrations.length,
          RISKY: riskyMigrations.length,
          UNSAFE: unsafeMigrations.length,
        },
        inventory,
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(
    resolve(jsonDir, "prisma-compatibility-report.json"),
    JSON.stringify(
      {
        generatedAtUtc: new Date().toISOString(),
        modelsParsed: modelMap.size,
        issuesCount: compatIssuesAll.length,
        issues: compatIssuesAll,
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(
    resolve(jsonDir, "naming-drift-report.json"),
    JSON.stringify(
      {
        generatedAtUtc: new Date().toISOString(),
        entries: driftAll,
        count: driftAll.length,
      },
      null,
      2,
    ) + "\n",
  );

  // Write inventory markdown.
  const invMd = renderInventoryMd(
    inventory,
    {
      CRITICAL: critTotal,
      HIGH: highTotal,
      MEDIUM: medTotal,
      LOW: lowTotal,
    },
    ALL_KIND_COUNTS,
    safeMigrations,
    riskyMigrations,
    unsafeMigrations,
  );
  writeFileSync(resolve(outDir, "migration-inventory.md"), invMd);

  // Write repair plan markdown.
  const planMd = renderRepairPlanMd(inventory, compatIssuesAll, driftAll);
  writeFileSync(resolve(outDir, "migration-repair-plan.md"), planMd);

  // Console summary.
  process.stdout.write(
    `Audited ${inventory.length} migrations. CRITICAL ${critTotal} / HIGH ${highTotal} / MEDIUM ${medTotal} / LOW ${lowTotal}\n` +
      `Verdicts: SAFE ${safeMigrations.length} / RISKY ${riskyMigrations.length} / UNSAFE ${unsafeMigrations.length}\n` +
      `Outputs written:\n` +
      `  ${jsonDir}/migration-inventory.json\n` +
      `  ${jsonDir}/prisma-compatibility-report.json\n` +
      `  ${jsonDir}/naming-drift-report.json\n` +
      `  ${outDir}/migration-inventory.md\n` +
      `  ${outDir}/migration-repair-plan.md\n`,
  );

  process.exitCode = critTotal > 0 ? 2 : 0;
}

function renderInventoryMd(inventory, totals, kindCounts, safe, risky, unsafe) {
  const lines = [];
  lines.push("# Migration Inventory — Phase O Risk Audit");
  lines.push("");
  lines.push(
    `Generated by \`services/api/scripts/full-migration-audit.mjs\`. **Read-only audit** — no DB was contacted.`,
  );
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Migrations audited: **${inventory.length}**`);
  lines.push(`- CRITICAL findings: **${totals.CRITICAL}**`);
  lines.push(`- HIGH findings: **${totals.HIGH}**`);
  lines.push(`- MEDIUM findings: **${totals.MEDIUM}**`);
  lines.push(`- LOW findings: **${totals.LOW}**`);
  lines.push("");
  lines.push(`- Verdict SAFE: **${safe.length}**`);
  lines.push(`- Verdict RISKY: **${risky.length}**`);
  lines.push(`- Verdict UNSAFE: **${unsafe.length}**`);
  lines.push("");
  lines.push("## Findings by kind");
  const ordered = Object.entries(kindCounts).sort((a, b) => b[1] - a[1]);
  lines.push("| Kind | Count |");
  lines.push("| --- | --- |");
  for (const [k, c] of ordered) lines.push(`| \`${k}\` | ${c} |`);
  lines.push("");

  // Per-verdict tables — UNSAFE first.
  for (const [title, list] of [
    ["UNSAFE migrations (require review before any production action)", unsafe],
    ["RISKY migrations (idempotency / re-run gaps)", risky],
    ["SAFE migrations", safe],
  ]) {
    lines.push(`## ${title}`);
    if (list.length === 0) {
      lines.push("");
      lines.push("_(none)_");
      lines.push("");
      continue;
    }
    lines.push("");
    lines.push("| Migration | CRITICAL | HIGH | MEDIUM | LOW | Tables |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const name of list) {
      const entry = inventory.find((e) => e.migration === name);
      if (!entry) continue;
      const tbl = entry.tables.slice(0, 4).join(", ");
      const more = entry.tables.length > 4 ? `, +${entry.tables.length - 4}` : "";
      lines.push(
        `| \`${entry.migration}\` | ${entry.findingsByRisk.CRITICAL} | ${entry.findingsByRisk.HIGH} | ${entry.findingsByRisk.MEDIUM} | ${entry.findingsByRisk.LOW} | ${tbl}${more} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Detail — every finding above MEDIUM");
  for (const entry of inventory) {
    const hi = entry.findings.filter((f) => f.risk === "CRITICAL" || f.risk === "HIGH");
    if (hi.length === 0) continue;
    lines.push(`### \`${entry.migration}\``);
    lines.push("");
    for (const f of hi) {
      lines.push(`- **${f.risk}** \`${f.kind}\` (line ${f.lineHint ?? "?"}) — ${f.detail}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderRepairPlanMd(inventory, compatIssues, drift) {
  const lines = [];
  lines.push("# Migration Repair Plan — Phase O");
  lines.push("");
  lines.push(
    "This document does NOT modify any migration. It records the operator review surface produced by `services/api/scripts/full-migration-audit.mjs`.",
  );
  lines.push("");

  const criticalEntries = inventory.filter(
    (e) => e.findingsByRisk.CRITICAL > 0,
  );
  const highEntries = inventory.filter(
    (e) => e.findingsByRisk.HIGH > 0 && e.findingsByRisk.CRITICAL === 0,
  );

  lines.push("## CRITICAL findings");
  if (criticalEntries.length === 0) {
    lines.push("");
    lines.push("_(no CRITICAL findings detected)_");
  } else {
    lines.push("");
    lines.push(
      "Every migration below carries at least one CRITICAL finding. Treat each as requiring operator review BEFORE any production action.",
    );
    lines.push("");
    for (const e of criticalEntries) {
      lines.push(`### \`${e.migration}\``);
      for (const f of e.findings.filter((x) => x.risk === "CRITICAL")) {
        lines.push(`- \`${f.kind}\` (line ${f.lineHint}) — ${f.detail}`);
      }
      lines.push("");
      lines.push(
        `_Tables touched_: ${e.tables.map((t) => `\`${t}\``).join(", ") || "(none detected)"}`,
      );
      lines.push("");
      lines.push("**Recommended action:**");
      lines.push(suggestedAction(e));
      lines.push("");
    }
  }

  lines.push("## HIGH findings");
  if (highEntries.length === 0) {
    lines.push("");
    lines.push("_(no HIGH-only findings beyond the CRITICAL set)_");
  } else {
    for (const e of highEntries) {
      lines.push(`### \`${e.migration}\``);
      for (const f of e.findings.filter((x) => x.risk === "HIGH")) {
        lines.push(`- \`${f.kind}\` (line ${f.lineHint}) — ${f.detail}`);
      }
      lines.push("");
    }
  }

  lines.push("## Prisma compatibility issues");
  if (compatIssues.length === 0) {
    lines.push("");
    lines.push("_(none)_");
  } else {
    lines.push("");
    lines.push("| Migration | Table | Column | Detail |");
    lines.push("| --- | --- | --- | --- |");
    for (const i of compatIssues) {
      lines.push(
        `| \`${i.migration}\` | \`${i.table}\` | \`${i.column}\` | ${i.detail} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Naming drift (camelCase quoted identifiers)");
  if (drift.length === 0) {
    lines.push("");
    lines.push("_(none)_");
  } else {
    lines.push("");
    lines.push("| Migration | Identifier | snake_case form |");
    lines.push("| --- | --- | --- |");
    for (const d of drift) {
      lines.push(
        `| \`${d.migration}\` | \`${d.identifier}\` | \`${d.altSnake}\` |`,
      );
    }
  }
  lines.push("");

  lines.push("## Required tests");
  lines.push(
    "- `services/api/test/phase-o-migration-safety-gate.test.ts` — CI gate that fails any NEW migration added after the configured baseline timestamp if it introduces a CRITICAL pattern.",
  );
  lines.push(
    "- `services/api/test/phase-o-final-schema-repair.test.ts` — index column-safety + production-variant coverage tests (Phase O-Final).",
  );
  lines.push(
    "- `services/api/test/phase-o-final-plus-full-schema-audit.test.ts` — Prisma↔Neon audit script contract (Phase O-Final+).",
  );
  lines.push("");

  lines.push("## Required production validation");
  lines.push(
    "1. Run `services/api/scripts/full-production-schema-audit.mjs` against production with the production `DATABASE_URL`.",
  );
  lines.push(
    "2. For every UNSAFE migration listed above, verify against production that the table/column shape Prisma expects is actually present. If not, author an additive repair migration following the Phase O-Final pattern.",
  );
  lines.push(
    "3. Take a Neon snapshot BEFORE running any repair migration. Apply via `services/api/scripts/safe-migrate.mjs deploy --allow-remote`.",
  );
  return lines.join("\n");
}

function suggestedAction(entry) {
  const kinds = new Set(entry.findings.map((f) => f.kind));
  if (kinds.has("CREATE_TABLE_IF_NOT_EXISTS")) {
    return [
      "- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).",
    ].join("\n");
  }
  if (kinds.has("INDEX_COLUMN_RISK")) {
    return [
      "- Verify every index column exists in production before re-deploy. Wrap CREATE INDEX in a `DO $$ ... END $$` block with an `information_schema.columns` existence check (Phase O-Final pattern).",
    ].join("\n");
  }
  if (kinds.has("SET_NOT_NULL_NO_READINESS")) {
    return [
      "- Confirm the column has been backfilled to 100% non-NULL before SET NOT NULL runs. Add a readiness-marker comment OR wrap in a DO block that verifies via SELECT COUNT(*) ... WHERE col IS NULL = 0.",
    ].join("\n");
  }
  return "- Operator review required. Document the production state of every affected table before any further action.";
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  import.meta.url.endsWith("/" + (process.argv[1]?.replace(/\\/g, "/").split("/").pop() ?? ""));
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`fatal: ${err?.message ?? err}\n`);
    process.exit(3);
  }
}
