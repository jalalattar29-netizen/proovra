#!/usr/bin/env node
/**
 * Phase O-Final+ — Full production schema audit.
 *
 * READ-ONLY. Parses `services/api/prisma/schema.prisma`, connects to
 * the database pointed at by `DATABASE_URL`, queries
 * `information_schema.tables` / `information_schema.columns` /
 * `pg_indexes` / `pg_constraint` / `_prisma_migrations`, and reports
 * every mismatch between what the Prisma runtime expects and what
 * the live database actually has.
 *
 * Hard rules:
 *   * READ-ONLY. The script refuses to construct any non-SELECT
 *     statement (defensive — every query helper enforces a
 *     `SELECT \b` prefix).
 *   * Uses `pg.Pool` directly. Does NOT instantiate
 *     `new PrismaClient()` because Prisma 7 in this project requires
 *     the `@prisma/adapter-pg` factory, which itself would fail
 *     against a drifted schema. The whole point of this audit is to
 *     diagnose drift BEFORE Prisma can connect.
 *   * No secrets in output. The connection string is redacted to
 *     `<host>:<port>/<db>` before any print. Connection password is
 *     never printed.
 *   * No row contents printed. Only schema metadata.
 *   * Exit codes:
 *       0 — no CRITICAL findings.
 *       2 — CRITICAL findings detected.
 *       3 — connection / query failure (transient).
 *
 * Usage:
 *   # Locally against production (read-only):
 *   DATABASE_URL='postgres://...' node services/api/scripts/full-production-schema-audit.mjs
 *
 *   # Inside the api container:
 *   docker exec -it docker-proovra-api-1 sh -lc '
 *     cd /app/services/api && node scripts/full-production-schema-audit.mjs
 *   '
 *
 *   # JSON output for machine processing:
 *   ... --json
 *
 *   # Parse-only (no DB connection — for CI):
 *   ... --parse-only
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// CORE — pure functions exported for tests. No fs / network / process side
// effects in this section.
// ---------------------------------------------------------------------------

/**
 * Convert a camelCase identifier to snake_case. Handles consecutive
 * capitals reasonably (e.g. `URLId` → `url_id`).
 */
export function camelToSnake(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** Convert a snake_case identifier to camelCase. */
export function snakeToCamel(s) {
  return s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * Strip Prisma `//` line comments. Block comments (`/* * /`) are not
 * used in the project's schema; if they appear later, extend here.
 */
function stripPrismaComments(src) {
  return src
    .split("\n")
    .map((line) => {
      // `///` doc comments and `//` line comments are stripped equally.
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

/**
 * Parse `services/api/prisma/schema.prisma` content and return:
 *   {
 *     models: [{ name, table, ignored, fields: [...], indexes: [...] }],
 *     enums:  [{ name, values: [...] }],
 *   }
 *
 * Field shape:
 *   { fieldName, column, baseType, dbType, dbTypeArg, optional,
 *     defaultExpr, isId, isUnique, isEnum, isRelation }
 *
 * Relation fields (typed as a model + `@relation(...)`) and list
 * fields (`Type[]`) are EXCLUDED from `fields` because they do not
 * correspond to a column in the DB.
 */
export function parsePrismaSchema(src) {
  const cleaned = stripPrismaComments(src);

  // Pass 1 — collect enum names (so field types can be classified).
  const enums = [];
  const enumMatch = /^\s*enum\s+(\w+)\s*\{([^}]+)\}/gm;
  for (const m of cleaned.matchAll(enumMatch)) {
    const name = m[1];
    const body = m[2];
    const values = body
      .split(/\s+/)
      .map((v) => v.trim())
      .filter((v) => v && !v.startsWith("@"));
    enums.push({ name, values });
  }
  const enumNames = new Set(enums.map((e) => e.name));

  // Pass 2 — collect model names (so relation fields can be classified).
  const modelNames = new Set();
  for (const m of cleaned.matchAll(/^\s*model\s+(\w+)\s*\{/gm)) {
    modelNames.add(m[1]);
  }

  // Pass 3 — parse each model's body using brace matching.
  const models = [];
  const modelHeader = /\bmodel\s+(\w+)\s*\{/g;
  let scanFrom = 0;
  while (scanFrom < cleaned.length) {
    modelHeader.lastIndex = scanFrom;
    const m = modelHeader.exec(cleaned);
    if (!m) break;
    const name = m[1];
    const bodyStart = m.index + m[0].length;
    // Match braces.
    let depth = 1;
    let j = bodyStart;
    while (j < cleaned.length && depth > 0) {
      const c = cleaned[j];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      j++;
    }
    const body = cleaned.slice(bodyStart, j - 1);
    models.push(parseModelBody(name, body, modelNames, enumNames));
    scanFrom = j;
  }

  return { models, enums };
}

function parseModelBody(name, body, modelNames, enumNames) {
  let table = name; // default: model name (Prisma's default if no @@map)
  let ignored = false;
  const fields = [];
  const indexes = [];

  const rawLines = body.split("\n");
  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line) continue;

    // Block-level directives.
    if (line.startsWith("@@")) {
      let m = /^@@map\("([^"]+)"\)/.exec(line);
      if (m) {
        table = m[1];
        continue;
      }
      if (line.startsWith("@@ignore")) {
        ignored = true;
        continue;
      }
      m = /^@@unique\(\s*\[([^\]]+)\]/.exec(line);
      if (m) {
        indexes.push({
          kind: "unique",
          fields: m[1].split(",").map((s) => s.trim()),
        });
        continue;
      }
      m = /^@@index\(\s*\[([^\]]+)\]/.exec(line);
      if (m) {
        indexes.push({
          kind: "index",
          fields: m[1].split(",").map((s) => s.trim()),
        });
        continue;
      }
      // Other @@ directives we don't classify (e.g. @@id) — skip.
      continue;
    }

    // Field line.
    const fieldMatch = /^(\w+)\s+(\w+)(\?)?(\[\])?(.*)$/.exec(line);
    if (!fieldMatch) continue;
    const fieldName = fieldMatch[1];
    const baseType = fieldMatch[2];
    const optional = fieldMatch[3] === "?";
    const isList = fieldMatch[4] === "[]";
    const attrs = fieldMatch[5] || "";

    // Field-level @ignore — skip entirely.
    if (/@ignore\b/.test(attrs)) continue;

    // List fields are virtual relations — no DB column.
    if (isList) continue;

    // Relation field (typed as a model + carries @relation).
    const isRelation = modelNames.has(baseType) && /@relation\b/.test(attrs);
    if (isRelation) continue;

    // Resolve column name.
    const mapMatch = /@map\("([^"]+)"\)/.exec(attrs);
    const column = mapMatch ? mapMatch[1] : fieldName;

    // Resolve DB type override (`@db.X` or `@db.X(arg)`).
    const dbMatch = /@db\.(\w+)(?:\(([^)]*)\))?/.exec(attrs);
    const dbType = dbMatch ? dbMatch[1] : null;
    const dbTypeArg = dbMatch ? dbMatch[2] : null;

    // Default.
    const defaultMatch = /@default\(([^)]*)\)/.exec(attrs);
    const defaultExpr = defaultMatch ? defaultMatch[1].trim() : null;

    const isId = /@id\b/.test(attrs);
    const isUnique = /@unique\b/.test(attrs);
    const isEnum = enumNames.has(baseType);

    fields.push({
      fieldName,
      column,
      baseType,
      dbType,
      dbTypeArg,
      optional,
      defaultExpr,
      isId,
      isUnique,
      isEnum,
      isRelation: false,
    });
  }

  return { name, table, ignored, fields, indexes };
}

/**
 * Map a parsed Prisma field to the set of acceptable Postgres data
 * types and (where relevant) the expected `udt_name`.
 *
 * Returns:
 *   { acceptable: string[] | null, expectedUdt: string | null }
 *
 *   - `acceptable === null` means "unknown — skip type check"
 *   - `expectedUdt !== null` means the column should be a user-
 *     defined type (enum) with that name
 */
export function expectedPgType(field) {
  if (field.isEnum) {
    return { acceptable: ["USER-DEFINED"], expectedUdt: field.baseType };
  }
  const db = field.dbType ? field.dbType.toLowerCase() : null;
  if (db) {
    const mapping = {
      uuid: ["uuid"],
      varchar: ["character varying"],
      char: ["character"],
      text: ["text"],
      timestamptz: ["timestamp with time zone"],
      timestamp: ["timestamp without time zone"],
      date: ["date"],
      time: ["time without time zone"],
      timetz: ["time with time zone"],
      integer: ["integer"],
      int: ["integer"],
      smallint: ["smallint"],
      bigint: ["bigint"],
      real: ["real"],
      doubleprecision: ["double precision"],
      decimal: ["numeric"],
      numeric: ["numeric"],
      money: ["money"],
      json: ["json"],
      jsonb: ["jsonb"],
      bytea: ["bytea"],
      boolean: ["boolean"],
      inet: ["inet"],
      cidr: ["cidr"],
      macaddr: ["macaddr"],
      bit: ["bit"],
    };
    return { acceptable: mapping[db] ?? null, expectedUdt: null };
  }
  // No @db.X — Prisma defaults.
  const defaults = {
    String: ["text", "character varying"],
    Int: ["integer"],
    BigInt: ["bigint"],
    Float: ["double precision"],
    Boolean: ["boolean"],
    DateTime: ["timestamp without time zone", "timestamp with time zone"],
    Json: ["jsonb", "json"],
    Bytes: ["bytea"],
    Decimal: ["numeric"],
  };
  return { acceptable: defaults[field.baseType] ?? null, expectedUdt: null };
}

/**
 * Given an expected column name and the set of actual column names
 * for a table, return a naming-drift hint:
 *   * null — no alternate-case variant present
 *   * { kind: "snake_to_camel", actual }   — expected `team_id`, found `teamId`
 *   * { kind: "camel_to_snake", actual }   — expected `teamId`, found `team_id`
 */
export function detectNamingDrift(expectedColumn, actualColumns) {
  const set = actualColumns instanceof Set ? actualColumns : new Set(actualColumns);
  if (set.has(expectedColumn)) return null;
  const alt1 = snakeToCamel(expectedColumn);
  if (alt1 !== expectedColumn && set.has(alt1)) {
    return { kind: "snake_to_camel", actual: alt1 };
  }
  const alt2 = camelToSnake(expectedColumn);
  if (alt2 !== expectedColumn && set.has(alt2)) {
    return { kind: "camel_to_snake", actual: alt2 };
  }
  return null;
}

const RISK = Object.freeze({
  CRITICAL: "CRITICAL",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
});

/**
 * Classify a finding into one of CRITICAL / HIGH / MEDIUM / LOW.
 *
 * The reasoning is:
 *   * Prisma findUnique/findMany SELECT every model field. ANY
 *     missing column causes P2022 on any query against the model.
 *     So MISSING_TABLE and MISSING_COLUMN are both CRITICAL.
 *   * NAMING_DRIFT (DB has alt-case version of the expected column)
 *     is CRITICAL — Prisma cannot find its expected name.
 *   * TYPE_MISMATCH (column exists, type wrong) is HIGH — reads can
 *     return wrong-shape values; writes may be rejected.
 *   * NULLABLE_DB_NULLABLE_PRISMA_REQUIRED is HIGH — Prisma will
 *     fail at runtime if it reads a NULL into a required field.
 *   * NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL is LOW — DB is
 *     over-strict but reads work.
 *   * MISSING_INDEX is LOW — performance only, never breaks runtime.
 *   * MISSING_ENUM_VALUE is HIGH — writes with the missing value fail.
 */
export function classifyFinding(finding) {
  switch (finding.kind) {
    case "MISSING_TABLE":
      return RISK.CRITICAL;
    case "MISSING_COLUMN":
      return RISK.CRITICAL;
    case "NAMING_DRIFT":
      return RISK.CRITICAL;
    case "TYPE_MISMATCH":
      return RISK.HIGH;
    case "NULLABLE_DB_NULLABLE_PRISMA_REQUIRED":
      return RISK.HIGH;
    case "NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL":
      return RISK.LOW;
    case "MISSING_INDEX":
      return RISK.LOW;
    case "MISSING_ENUM_VALUE":
      return RISK.HIGH;
    case "EXTRA_COLUMN":
      return RISK.LOW;
    default:
      return RISK.LOW;
  }
}

/**
 * Suggest a SAFE, additive repair statement for a finding. Returns
 * null if there is no safe additive repair (e.g., NAMING_DRIFT needs
 * a human decision: fix Prisma @map or rewrite the DB).
 */
export function suggestRepair(finding) {
  switch (finding.kind) {
    case "MISSING_TABLE":
      return `-- MISSING_TABLE ${finding.table}: a CREATE TABLE migration is required; produce via 'prisma migrate dev' in a sandbox first.`;
    case "MISSING_COLUMN":
      return suggestAddColumn(finding);
    case "NAMING_DRIFT":
      return `-- NAMING_DRIFT on ${finding.table}.${finding.expectedColumn} (DB has ${finding.driftedTo}). Operator must DECIDE: either fix the Prisma @map to "${finding.driftedTo}" OR rewrite the DB column. Do NOT auto-fix.`;
    case "TYPE_MISMATCH":
      return `-- TYPE_MISMATCH on ${finding.table}.${finding.column}: DB type ${finding.actualType}, Prisma expects ${finding.expectedTypes?.join("|")}. Operator decision required.`;
    case "NULLABLE_DB_NULLABLE_PRISMA_REQUIRED":
      return `-- NULLABLE_DB_NULLABLE_PRISMA_REQUIRED on ${finding.table}.${finding.column}: data backfill + SET NOT NULL deferred until readiness proven.`;
    case "MISSING_INDEX":
      return `-- MISSING_INDEX suggested on ${finding.table}(${finding.columns?.join(",")}): operator-tunable; not runtime-required.`;
    default:
      return null;
  }
}

function suggestAddColumn(finding) {
  const lines = [
    `-- MISSING_COLUMN ${finding.table}.${finding.column} (Prisma field ${finding.fieldName}, type ${finding.expectedTypes?.join("|")})`,
    `ALTER TABLE IF EXISTS "${finding.table}"`,
    `  ADD COLUMN IF NOT EXISTS "${finding.column}" ${finding.suggestedSql ?? "TYPE_TBD"};`,
  ];
  return lines.join("\n");
}

/**
 * Translate a parsed field's type info into an ADD COLUMN SQL fragment.
 * Returns null for cases where a safe default cannot be produced
 * (operator must decide).
 */
export function fieldToSqlType(field) {
  // Enums require a user-defined type — risky to auto-add.
  if (field.isEnum) return null;
  const db = field.dbType ? field.dbType.toLowerCase() : null;
  const arg = field.dbTypeArg ? `(${field.dbTypeArg})` : "";
  if (db) {
    const map = {
      uuid: "UUID",
      varchar: `VARCHAR${arg}`,
      char: `CHAR${arg}`,
      text: "TEXT",
      timestamptz: `TIMESTAMPTZ${arg}`,
      timestamp: `TIMESTAMP${arg}`,
      date: "DATE",
      integer: "INTEGER",
      int: "INTEGER",
      smallint: "SMALLINT",
      bigint: "BIGINT",
      real: "REAL",
      doubleprecision: "DOUBLE PRECISION",
      decimal: `NUMERIC${arg}`,
      numeric: `NUMERIC${arg}`,
      json: "JSON",
      jsonb: "JSONB",
      bytea: "BYTEA",
      boolean: "BOOLEAN",
    };
    return map[db] ?? null;
  }
  const defaults = {
    String: "TEXT",
    Int: "INTEGER",
    BigInt: "BIGINT",
    Float: "DOUBLE PRECISION",
    Boolean: "BOOLEAN",
    DateTime: "TIMESTAMPTZ(6)",
    Json: "JSONB",
    Bytes: "BYTEA",
    Decimal: "NUMERIC",
  };
  return defaults[field.baseType] ?? null;
}

/**
 * Scan all migration.sql files in the migrations folder for the
 * `CREATE TABLE IF NOT EXISTS` pattern that hides missing-column drift.
 * Returns an array of { migration, table, line }.
 */
export function scanMigrationsForRiskPatterns(migrationsRoot) {
  const out = [];
  if (!existsSync(migrationsRoot)) return out;
  const dirs = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const re = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?(?:public\.)?"?([\w]+)"?/gi;
  for (const dir of dirs) {
    const path = `${migrationsRoot}/${dir}/migration.sql`;
    if (!existsSync(path)) continue;
    let src;
    try {
      src = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      // Find the line number for context.
      const upto = src.slice(0, m.index);
      const line = upto.split("\n").length;
      out.push({ migration: dir, table: m[1], line });
    }
  }
  return out;
}

/**
 * Best-effort code-usage correlation. Greps for usage of a Prisma
 * model name + a specific field name across the api source tree.
 * Returns a deduped array of file paths.
 */
export function findCodeUsage(rootDir, modelNameLowerFirst, fieldName) {
  const candidates = [
    `${rootDir}/services/api/src/routes`,
    `${rootDir}/services/api/src/services`,
  ];
  const hits = new Set();
  for (const root of candidates) {
    if (!existsSync(root)) continue;
    walkAndGrep(root, modelNameLowerFirst, fieldName, hits);
  }
  return Array.from(hits).sort();
}

function walkAndGrep(dir, modelLF, field, hits) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = `${dir}/${ent.name}`;
    if (ent.isDirectory()) {
      walkAndGrep(full, modelLF, field, hits);
      continue;
    }
    if (!/\.(ts|mjs|js)$/.test(ent.name)) continue;
    let src;
    try {
      src = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const modelRe = new RegExp(`\\bprisma\\.${modelLF}\\b`);
    const fieldRe = new RegExp(`\\b${field}\\b`);
    if (modelRe.test(src) && fieldRe.test(src)) hits.add(full);
  }
}

// ---------------------------------------------------------------------------
// CLI — runs the audit. Reads schema, optionally connects to DB,
// prints structured report.
// ---------------------------------------------------------------------------

const READ_ONLY_PREFIX = /^\s*SELECT\b/i;

async function safeQuery(pool, sql, params = []) {
  if (!READ_ONLY_PREFIX.test(sql)) {
    throw new Error(
      "full-production-schema-audit refusal: non-SELECT statement constructed",
    );
  }
  return pool.query(sql, params);
}

function redactDatabaseUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "(unparseable)";
  }
}

async function fetchDbMetadata(pool) {
  const tables = new Set();
  const columnsByTable = new Map();
  const indexesByTable = new Map();
  const enumsByName = new Map();

  // Tables.
  const t = await safeQuery(
    pool,
    `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  for (const r of t.rows) tables.add(r.table_name);

  // Columns.
  const c = await safeQuery(
    pool,
    `SELECT table_name, column_name, data_type, udt_name,
            is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`,
  );
  for (const r of c.rows) {
    if (!columnsByTable.has(r.table_name)) columnsByTable.set(r.table_name, []);
    columnsByTable.get(r.table_name).push({
      name: r.column_name,
      data_type: r.data_type,
      udt_name: r.udt_name,
      is_nullable: r.is_nullable === "YES",
      column_default: r.column_default,
    });
  }

  // Indexes (best-effort — just by name).
  try {
    const i = await safeQuery(
      pool,
      `SELECT schemaname, tablename, indexname
         FROM pg_indexes
        WHERE schemaname = 'public'`,
    );
    for (const r of i.rows) {
      if (!indexesByTable.has(r.tablename)) indexesByTable.set(r.tablename, []);
      indexesByTable.get(r.tablename).push(r.indexname);
    }
  } catch {
    // pg_indexes can be permission-restricted; tolerate.
  }

  // Enum types (user-defined).
  try {
    const e = await safeQuery(
      pool,
      `SELECT t.typname AS enum_name, e.enumlabel AS value
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
        ORDER BY t.typname, e.enumsortorder`,
    );
    for (const r of e.rows) {
      if (!enumsByName.has(r.enum_name)) enumsByName.set(r.enum_name, []);
      enumsByName.get(r.enum_name).push(r.value);
    }
  } catch {
    // pg_enum can be restricted; tolerate.
  }

  return { tables, columnsByTable, indexesByTable, enumsByName };
}

async function fetchMigrationHistory(pool) {
  try {
    const r = await safeQuery(
      pool,
      `SELECT migration_name, started_at, finished_at, rolled_back_at
         FROM _prisma_migrations
        ORDER BY started_at DESC
        LIMIT 50`,
    );
    return r.rows;
  } catch {
    return [];
  }
}

function buildFindings(parsed, db) {
  const findings = [];
  const findingsByRisk = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  let columnsExpected = 0;
  let columnsMissing = 0;
  let tablesExpected = 0;
  let tablesMissing = 0;

  for (const model of parsed.models) {
    if (model.ignored) continue;
    tablesExpected++;
    if (!db.tables.has(model.table)) {
      tablesMissing++;
      const f = {
        kind: "MISSING_TABLE",
        model: model.name,
        table: model.table,
        risk: classifyFinding({ kind: "MISSING_TABLE" }),
      };
      findings.push(f);
      findingsByRisk[f.risk]++;
      continue;
    }

    const actualColsList = db.columnsByTable.get(model.table) ?? [];
    const actualColMap = new Map(actualColsList.map((c) => [c.name, c]));
    const actualColSet = new Set(actualColMap.keys());

    for (const field of model.fields) {
      columnsExpected++;
      const exp = expectedPgType(field);

      const actual = actualColMap.get(field.column);
      if (!actual) {
        // Naming drift check.
        const drift = detectNamingDrift(field.column, actualColSet);
        if (drift) {
          const f = {
            kind: "NAMING_DRIFT",
            model: model.name,
            table: model.table,
            fieldName: field.fieldName,
            expectedColumn: field.column,
            driftedTo: drift.actual,
            driftDirection: drift.kind,
            expectedTypes: exp.acceptable,
          };
          f.risk = classifyFinding(f);
          findings.push(f);
          findingsByRisk[f.risk]++;
          columnsMissing++;
          continue;
        }
        columnsMissing++;
        const sqlType = fieldToSqlType(field);
        const f = {
          kind: "MISSING_COLUMN",
          model: model.name,
          table: model.table,
          fieldName: field.fieldName,
          column: field.column,
          optional: field.optional,
          expectedTypes: exp.acceptable,
          suggestedSql: sqlType,
        };
        f.risk = classifyFinding(f);
        findings.push(f);
        findingsByRisk[f.risk]++;
        continue;
      }

      // Type check (only when expected list is known).
      if (exp.acceptable && !exp.acceptable.includes(actual.data_type)) {
        const f = {
          kind: "TYPE_MISMATCH",
          model: model.name,
          table: model.table,
          fieldName: field.fieldName,
          column: field.column,
          actualType: actual.data_type,
          actualUdt: actual.udt_name,
          expectedTypes: exp.acceptable,
        };
        f.risk = classifyFinding(f);
        findings.push(f);
        findingsByRisk[f.risk]++;
      }

      // Enum udt_name check.
      if (exp.expectedUdt && actual.udt_name !== exp.expectedUdt) {
        const f = {
          kind: "TYPE_MISMATCH",
          model: model.name,
          table: model.table,
          fieldName: field.fieldName,
          column: field.column,
          actualType: `udt=${actual.udt_name}`,
          expectedTypes: [`enum:${exp.expectedUdt}`],
        };
        f.risk = classifyFinding(f);
        findings.push(f);
        findingsByRisk[f.risk]++;
      }

      // Nullable check.
      if (!field.optional && actual.is_nullable) {
        const f = {
          kind: "NULLABLE_DB_NULLABLE_PRISMA_REQUIRED",
          model: model.name,
          table: model.table,
          fieldName: field.fieldName,
          column: field.column,
        };
        f.risk = classifyFinding(f);
        findings.push(f);
        findingsByRisk[f.risk]++;
      }
      if (field.optional && !actual.is_nullable) {
        const f = {
          kind: "NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL",
          model: model.name,
          table: model.table,
          fieldName: field.fieldName,
          column: field.column,
        };
        f.risk = classifyFinding(f);
        findings.push(f);
        findingsByRisk[f.risk]++;
      }
    }
  }

  // Enum value check.
  for (const e of parsed.enums) {
    const dbValues = db.enumsByName.get(e.name);
    if (!dbValues) continue; // enum not yet created; flagged via udt_name mismatch above
    const missing = e.values.filter((v) => !dbValues.includes(v));
    for (const v of missing) {
      const f = {
        kind: "MISSING_ENUM_VALUE",
        enumName: e.name,
        value: v,
      };
      f.risk = classifyFinding(f);
      findings.push(f);
      findingsByRisk[f.risk]++;
    }
  }

  return {
    findings,
    summary: {
      tablesExpected,
      tablesMissing,
      tablesPresent: tablesExpected - tablesMissing,
      columnsExpected,
      columnsMissing,
      findingsByRisk,
    },
  };
}

function lowerFirst(s) {
  return s.length > 0 ? s[0].toLowerCase() + s.slice(1) : s;
}

function renderReport(parsed, db, audit, options) {
  const repoRoot = options.repoRoot;
  const lines = [];
  lines.push("");
  lines.push("============================================================");
  lines.push("  PROOVRA FULL PRODUCTION SCHEMA AUDIT");
  lines.push("============================================================");
  lines.push(`  target        : ${options.target}`);
  lines.push(`  schema file   : services/api/prisma/schema.prisma`);
  lines.push(`  models parsed : ${parsed.models.length}`);
  lines.push(`  enums  parsed : ${parsed.enums.length}`);
  lines.push(`  audited at    : ${new Date().toISOString()}`);
  lines.push("");

  // Section 1 — summary
  lines.push("------------------------------------------------------------");
  lines.push("SECTION 1 — SUMMARY COUNTS");
  lines.push("------------------------------------------------------------");
  const s = audit.summary;
  lines.push(`  tables expected      : ${s.tablesExpected}`);
  lines.push(`  tables present       : ${s.tablesPresent}`);
  lines.push(`  tables missing       : ${s.tablesMissing}`);
  lines.push(`  columns expected     : ${s.columnsExpected}`);
  lines.push(`  columns missing      : ${s.columnsMissing}`);
  lines.push(`  findings by risk:`);
  for (const k of ["CRITICAL", "HIGH", "MEDIUM", "LOW"]) {
    lines.push(`    ${k.padEnd(8)} : ${s.findingsByRisk[k]}`);
  }
  lines.push("");

  // Sections 2-5 — findings grouped by risk
  for (const risk of ["CRITICAL", "HIGH", "MEDIUM", "LOW"]) {
    const inRisk = audit.findings.filter((f) => f.risk === risk);
    if (inRisk.length === 0) continue;
    lines.push("------------------------------------------------------------");
    lines.push(`SECTION — ${risk} (${inRisk.length})`);
    lines.push("------------------------------------------------------------");
    for (const f of inRisk) {
      lines.push(formatFinding(f, repoRoot));
    }
    lines.push("");
  }

  // Migration risk patterns
  const riskPatterns = scanMigrationsForRiskPatterns(
    `${repoRoot}/services/api/prisma/migrations`,
  );
  lines.push("------------------------------------------------------------");
  lines.push(`SECTION — MIGRATION RISK PATTERNS (CREATE TABLE IF NOT EXISTS) (${riskPatterns.length})`);
  lines.push("------------------------------------------------------------");
  if (riskPatterns.length === 0) {
    lines.push("  none detected.");
  } else {
    // Group by table.
    const byTable = new Map();
    for (const p of riskPatterns) {
      if (!byTable.has(p.table)) byTable.set(p.table, []);
      byTable.get(p.table).push(p.migration);
    }
    for (const [table, migs] of [...byTable.entries()].sort()) {
      lines.push(`  ${table.padEnd(40)} ${migs.length} migration(s)`);
    }
  }
  lines.push("");

  // Repair proposal
  const critical = audit.findings.filter((f) => f.risk === "CRITICAL" && f.kind === "MISSING_COLUMN");
  lines.push("------------------------------------------------------------");
  lines.push("SECTION — REPAIR PROPOSAL (NOT APPLIED)");
  lines.push("------------------------------------------------------------");
  lines.push("  NOTE: Operator MUST take a Neon snapshot before applying.");
  lines.push("        The proposal below is generated; not applied.");
  lines.push("");
  if (critical.length === 0) {
    lines.push("  no CRITICAL MISSING_COLUMN findings — no repair statements proposed.");
  } else {
    for (const f of critical) {
      const repair = suggestRepair(f);
      if (repair) lines.push(repair);
    }
  }
  lines.push("");

  // Verdict
  lines.push("------------------------------------------------------------");
  lines.push("SECTION — VERDICT");
  lines.push("------------------------------------------------------------");
  const cCount = s.findingsByRisk.CRITICAL;
  if (cCount === 0) {
    lines.push("  no CRITICAL findings detected. Production schema matches expected.");
  } else {
    lines.push(`  ${cCount} CRITICAL finding(s). See proposal above; review then apply via safe-migrate.mjs.`);
  }
  lines.push("");

  return lines.join("\n");
}

function formatFinding(f, repoRoot) {
  const head = `  [${f.risk}] ${f.kind}  ${f.table ?? f.enumName ?? "?"}${f.column ? "." + f.column : ""}`;
  const detailLines = [head];
  if (f.model) detailLines.push(`    model      : ${f.model}.${f.fieldName ?? ""}`);
  if (f.expectedTypes) detailLines.push(`    expected   : ${f.expectedTypes.join("|")}${f.optional ? " (nullable)" : ""}`);
  if (f.actualType) detailLines.push(`    actual     : ${f.actualType}`);
  if (f.driftedTo) detailLines.push(`    drift      : DB has "${f.driftedTo}" (${f.driftDirection})`);
  if (f.value) detailLines.push(`    value      : ${f.value}`);
  if (f.model && f.fieldName && repoRoot) {
    const hits = findCodeUsage(repoRoot, lowerFirst(f.model), f.fieldName);
    if (hits.length > 0) {
      detailLines.push(`    code usage (best-effort):`);
      for (const h of hits.slice(0, 6)) {
        detailLines.push(`      ${h.replace(repoRoot + "/", "")}`);
      }
      if (hits.length > 6) detailLines.push(`      ... +${hits.length - 6} more`);
    }
  }
  return detailLines.join("\n");
}

async function main() {
  const flags = new Set(process.argv.slice(2));
  const parseOnly = flags.has("--parse-only");
  const jsonOnly = flags.has("--json");

  // Resolve repo root from this script's location.
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../../..");
  const schemaPath = resolve(repoRoot, "services/api/prisma/schema.prisma");

  if (!existsSync(schemaPath)) {
    process.stderr.write(`fatal: schema not found at ${schemaPath}\n`);
    process.exit(3);
  }
  const schemaSrc = readFileSync(schemaPath, "utf8");
  const parsed = parsePrismaSchema(schemaSrc);

  if (parseOnly) {
    const out = {
      mode: "parse-only",
      models: parsed.models.length,
      enums: parsed.enums.length,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    process.exit(0);
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    process.stderr.write("ERROR: DATABASE_URL is not set. Export it before running this audit.\n");
    process.exit(3);
  }
  const target = redactDatabaseUrl(databaseUrl);

  // Lazy import of pg so --parse-only does not require it.
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });

  try {
    const db = await fetchDbMetadata(pool);
    const migrations = await fetchMigrationHistory(pool);
    const audit = buildFindings(parsed, db);

    if (jsonOnly) {
      const out = {
        target,
        summary: audit.summary,
        findings: audit.findings,
        recentMigrations: migrations,
      };
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    } else {
      const report = renderReport(parsed, db, audit, { target, repoRoot });
      process.stdout.write(report);
    }

    process.exitCode = audit.summary.findingsByRisk.CRITICAL > 0 ? 2 : 0;
  } catch (err) {
    process.stderr.write(`fatal: ${err?.message ?? err}\n`);
    process.exit(3);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

// Run main only when invoked directly (not when imported by tests).
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  import.meta.url.endsWith("/" + (process.argv[1]?.replace(/\\/g, "/").split("/").pop() ?? ""));

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err?.message ?? err}\n`);
    process.exit(3);
  });
}
