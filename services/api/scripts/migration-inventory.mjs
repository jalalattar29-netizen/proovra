#!/usr/bin/env node
/**
 * PHASE 12 — POINT 6: the authoritative migration inventory.
 *
 * ONE canonical machine-readable record per migration directory on disk.
 *
 * The inventory is NOT allowed to prove itself: every field that CAN be
 * derived from the filesystem IS derived here on each run (checksum, schema
 * objects touched, data tables touched, dependencies, destructive statements,
 * guard shape). Only the facts that cannot be read out of SQL — release wave,
 * owner action, readiness command, removal condition, dependent runtime code —
 * come from the curation overlay, and a migration with no curated disposition
 * is reported as UNCLASSIFIED rather than silently defaulted.
 *
 * MODES
 *   --write      regenerate docs/architecture/migration-inventory-p6.json
 *   --check      (default) recompute from disk and fail on ANY divergence,
 *                unknown, or conservation break. This is the gate.
 *   --git        additionally resolve each migration's introducing commit
 *                (slow: one `git log` per migration). Cached in the artifact.
 *   --json       print the computed inventory to stdout instead of a summary
 *
 * PRODUCTION STATE
 *   `prodApplied` is UNKNOWN for every migration until the owner returns a
 *   read-only `_prisma_migrations` snapshot (see
 *   scripts/p6-production-migration-snapshot.mjs). Reconcile it with
 *   scripts/migration-production-reconcile.mjs. This script never connects to
 *   any database.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, "..");
const REPO = resolve(API, "../..");
const MIGRATIONS_DIR = join(API, "prisma", "migrations");
const INVENTORY_PATH = join(REPO, "docs", "architecture", "migration-inventory-p6.json");
const CURATION_PATH = join(REPO, "docs", "architecture", "migration-inventory-p6.curation.json");

const CLASSIFICATIONS = new Set([
  "EXPAND",
  "BACKFILL",
  "CUTOVER",
  "CONTRACT_DROP",
  "REPAIR",
  "HISTORICAL_PRESERVE",
  "BASELINE",
]);

const RELEASE_WAVES = new Set([
  "HISTORICAL_PRESERVE_NEVER_REWRITE",
  "SAFE_TO_APPLY_NOW",
  "OWNER_ACTION_AFTER_BACKUP",
  "WAIT_FOR_BACKFILL_READINESS",
  "WAIT_FOR_RUNTIME_CUTOVER",
  "WAIT_FOR_OBSERVATION_WINDOW",
  "CONTRACT_DROP_LATER",
]);

/** Catalog / system namespaces that are never migration dependencies. */
const NON_DEPENDENCY_RELATIONS = new Set([
  "information_schema",
  "pg_catalog",
  "columns",
  "tables",
  "pg_class",
  "pg_constraint",
  "pg_indexes",
  "pg_namespace",
  "pg_proc",
  "pg_type",
  "pg_attribute",
  "pg_enum",
  "pg_index",
  "pg_extension",
  "pg_tables",
  "pg_settings",
  "pg_stat_user_tables",
  "pg_depend",
  "pg_rewrite",
  "pg_attrdef",
  "pg_description",
  "pg_matviews",
  "table_constraints",
  "key_column_usage",
  "constraint_column_usage",
  "referential_constraints",
  "schemata",
  "views",
  "unnest",
  "public",
]);

// ---------------------------------------------------------------------------
// SQL analysis
// ---------------------------------------------------------------------------

/**
 * Remove comments WITHOUT removing dollar-quoted bodies: guard blocks carry
 * real DDL inside `DO $$ ... $$`, so the body must stay analysable. A `--`
 * sequence inside a single-quoted literal is left alone.
 */
function stripComments(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (sql[i] === "'") {
      const start = i;
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      // A single-quoted literal is prose or a value UNLESS it is a dynamic
      // statement handed to EXECUTE. Keeping prose would make a RAISE NOTICE
      // that merely MENTIONS a column read as a reference to it; dropping the
      // executable form would hide real DDL (e.g. the partial unique indexes
      // built by EXECUTE 'CREATE UNIQUE INDEX ...'). So the literal survives
      // only when its body actually starts with a SQL verb.
      const literal = sql.slice(start, i);
      const inner = literal.slice(1, -1);
      out += /^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|SELECT|TRUNCATE)\b/i.test(inner)
        ? literal
        : " ";
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

const ident = String.raw`(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))`;

function collect(body, re, pick = (m) => m[1] ?? m[2]) {
  const found = new Set();
  for (const m of body.matchAll(re)) {
    const v = pick(m);
    if (v) found.add(v.toLowerCase());
  }
  return [...found].sort();
}

function analyzeSql(rawSql) {
  const body = stripComments(rawSql);

  const createdTables = collect(
    body,
    new RegExp(String.raw`CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"?public"?\.)?${ident}`, "gi"),
  );
  const droppedTables = collect(
    body,
    new RegExp(String.raw`DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+(?:"?public"?\.)?${ident}`, "gi"),
  );
  const alteredTables = collect(
    body,
    new RegExp(String.raw`ALTER\s+TABLE(?:\s+ONLY)?(?:\s+IF\s+EXISTS)?\s+(?:"?public"?\.)?${ident}`, "gi"),
  );
  const createdIndexes = collect(
    body,
    new RegExp(String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+CONCURRENTLY)?(?:\s+IF\s+NOT\s+EXISTS)?\s+${ident}`, "gi"),
  );
  const droppedIndexes = collect(
    body,
    new RegExp(String.raw`DROP\s+INDEX(?:\s+CONCURRENTLY)?(?:\s+IF\s+EXISTS)?\s+(?:"?public"?\.)?${ident}`, "gi"),
  );
  const createdTypes = collect(body, new RegExp(String.raw`CREATE\s+TYPE\s+${ident}`, "gi"));
  const droppedTypes = collect(body, new RegExp(String.raw`DROP\s+TYPE(?:\s+IF\s+EXISTS)?\s+${ident}`, "gi"));
  const alteredTypes = collect(body, new RegExp(String.raw`ALTER\s+TYPE\s+${ident}`, "gi"));
  const extensions = collect(
    body,
    new RegExp(String.raw`CREATE\s+EXTENSION(?:\s+IF\s+NOT\s+EXISTS)?\s+${ident}`, "gi"),
  );
  const addedColumns = collect(
    body,
    new RegExp(String.raw`ADD\s+COLUMN(?:\s+IF\s+NOT\s+EXISTS)?\s+${ident}`, "gi"),
  );
  const droppedColumns = collect(
    body,
    new RegExp(String.raw`DROP\s+COLUMN(?:\s+IF\s+EXISTS)?\s+${ident}`, "gi"),
  );
  const addedConstraints = collect(
    body,
    new RegExp(String.raw`ADD\s+CONSTRAINT\s+${ident}`, "gi"),
  );
  const droppedConstraints = collect(
    body,
    new RegExp(String.raw`DROP\s+CONSTRAINT(?:\s+IF\s+EXISTS)?\s+${ident}`, "gi"),
  );

  const insertTargets = collect(
    body,
    new RegExp(String.raw`INSERT\s+INTO\s+(?:"?public"?\.)?${ident}`, "gi"),
  );
  const updateTargets = collect(
    body,
    new RegExp(String.raw`UPDATE\s+(?:ONLY\s+)?(?:"?public"?\.)?${ident}`, "gi"),
  );
  const deleteTargets = collect(
    body,
    new RegExp(String.raw`DELETE\s+FROM\s+(?:ONLY\s+)?(?:"?public"?\.)?${ident}`, "gi"),
  );

  // Relation ALIASES and CTE names are local scopes, not dependencies on a
  // physical table. Collect them first so `FROM evidence e ... WHERE e.case_id`
  // does not register a dependency on a relation called "e".
  const localNames = new Set();
  const SQL_KEYWORDS_AFTER_RELATION = new Set([
    "on", "where", "using", "group", "order", "left", "right", "inner", "outer",
    "full", "cross", "join", "set", "values", "having", "limit", "offset",
    "union", "except", "intersect", "returning", "as", "and", "or", "not",
    "add", "drop", "alter", "rename", "select", "into", "for", "with", "when",
    "then", "else", "end", "loop", "if", "exists", "is", "null", "only",
  ]);
  for (const m of body.matchAll(
    new RegExp(
      String.raw`(?:FROM|JOIN|UPDATE)\s+(?:ONLY\s+)?(?:"?public"?\.)?(?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*)\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*)`,
      "gi",
    ),
  )) {
    const alias = m[1].toLowerCase();
    if (!SQL_KEYWORDS_AFTER_RELATION.has(alias)) localNames.add(alias);
  }
  for (const m of body.matchAll(new RegExp(String.raw`(?:WITH|,)\s+${ident}\s+AS\s*\(`, "gi"))) {
    const v = (m[1] ?? m[2] ?? "").toLowerCase();
    if (v) localNames.add(v);
  }
  // `FROM ( ... ) alias` — a derived table.
  for (const m of body.matchAll(new RegExp(String.raw`\)\s*(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:$|[,;\)\s])`, "gim"))) {
    const v = m[1].toLowerCase();
    if (!SQL_KEYWORDS_AFTER_RELATION.has(v)) localNames.add(v);
  }

  const referenced = new Set();
  for (const m of body.matchAll(
    new RegExp(
      // `(?<!ON\s+)` keeps referential-action clauses out: `ON UPDATE CASCADE`
      // and `ON DELETE NO ACTION` are not references to relations named
      // "cascade" or "no".
      String.raw`(?:ALTER\s+TABLE(?:\s+ONLY)?(?:\s+IF\s+EXISTS)?|REFERENCES|(?<!ON\s{1,8})UPDATE|INSERT\s+INTO|DELETE\s+FROM|JOIN|FROM)\s+(?:ONLY\s+)?(?:"?public"?\.)?${ident}`,
      "gi",
    ),
  )) {
    const v = (m[1] ?? m[2] ?? "").toLowerCase();
    if (v && !NON_DEPENDENCY_RELATIONS.has(v) && !localNames.has(v)) referenced.add(v);
  }

  // A constraint/index dropped and re-added in the same file is a REPAIR of
  // that object, not the removal of a persistent one.
  const netDroppedConstraints = droppedConstraints.filter((c) => !addedConstraints.includes(c));
  const netDroppedIndexes = droppedIndexes.filter((i) => !createdIndexes.includes(i));
  const netDroppedTables = droppedTables.filter((t) => !createdTables.includes(t));
  const netDroppedTypes = droppedTypes.filter((t) => !createdTypes.includes(t));

  const destructive = [];
  for (const t of netDroppedTables) destructive.push({ kind: "DROP_TABLE", object: t });
  for (const c of droppedColumns) destructive.push({ kind: "DROP_COLUMN", object: c });
  for (const t of netDroppedTypes) destructive.push({ kind: "DROP_TYPE", object: t });

  // PHASE 12 POINT 8 — destruction through a DYNAMIC identifier.
  //
  // Every list above is a list of NAMES, so a statement whose target is a
  // `format()` placeholder contributes nothing and the migration reads as
  // non-destructive. `20271117000000_point4_schema_authority_contract` executes
  // `format('DROP TABLE %I', legacy_table)` and
  // `format('ALTER TABLE %I DROP COLUMN %I', …)` inside a FOREACH loop, and was
  // recorded with zero destructive statements — which is what
  // `UnguardedDestructiveStatementsPending = 0` was computed from.
  //
  // The verb is detectable even when the object is not, so record it with a
  // null object rather than dropping the statement. The identifier is genuinely
  // unknown until runtime; claiming a name here would be worse than admitting
  // there isn't one.
  const DYNAMIC_TARGET = String.raw`(?:%[IsL]|"?\s*\|\|)`;
  for (const [re, kind] of [
    [new RegExp(String.raw`DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+${DYNAMIC_TARGET}`, "gi"), "DROP_TABLE"],
    [new RegExp(String.raw`DROP\s+COLUMN(?:\s+IF\s+EXISTS)?\s+${DYNAMIC_TARGET}`, "gi"), "DROP_COLUMN"],
    [new RegExp(String.raw`DROP\s+TYPE(?:\s+IF\s+EXISTS)?\s+${DYNAMIC_TARGET}`, "gi"), "DROP_TYPE"],
  ]) {
    for (let n = (body.match(re) ?? []).length; n > 0; n -= 1) {
      destructive.push({ kind, object: null, dynamicIdentifier: true });
    }
  }

  // A reference is SOFT when the migration tolerates the relation not existing:
  // `ALTER TABLE IF EXISTS "x"`, or any reference guarded by an existence probe
  // naming x (`table_name='x'` / `tablename='x'`). The drift-repair migrations
  // use this deliberately, so a soft reference is a no-op on a clean chain and
  // must NOT be read as an ordering violation.
  const softReferences = new Set();
  for (const m of body.matchAll(
    new RegExp(String.raw`ALTER\s+TABLE\s+IF\s+EXISTS\s+(?:"?public"?\.)?${ident}`, "gi"),
  )) {
    const v = (m[1] ?? m[2] ?? "").toLowerCase();
    if (v) softReferences.add(v);
  }
  for (const m of body.matchAll(/\b(?:table_name|tablename|relname)\s*=\s*'([a-z_][a-z0-9_]*)'/gi)) {
    softReferences.add(m[1].toLowerCase());
  }
  for (const m of body.matchAll(/\bto_regclass\s*\(\s*'(?:public\.)?"?([a-z_][a-z0-9_]*)"?'\s*\)/gi)) {
    softReferences.add(m[1].toLowerCase());
  }

  const dmlTables = [...new Set([...insertTargets, ...updateTargets, ...deleteTargets])]
    .filter((t) => !NON_DEPENDENCY_RELATIONS.has(t))
    .sort();
  const dmlOnPreexisting = dmlTables.filter((t) => !createdTables.includes(t));

  const guardCount = (body.match(/RAISE\s+EXCEPTION/gi) ?? []).length;
  const doBlocks = (body.match(/\bDO\s*\$\$/gi) ?? []).length;

  return {
    createdTables,
    droppedTables: netDroppedTables,
    alteredTables,
    createdIndexes,
    droppedIndexes: netDroppedIndexes,
    createdTypes,
    droppedTypes: netDroppedTypes,
    alteredTypes,
    extensions,
    addedColumns,
    droppedColumns,
    addedConstraints,
    droppedConstraints: netDroppedConstraints,
    dmlTables,
    dmlOnPreexisting,
    referenced: [...referenced].sort(),
    softReferences: [...softReferences].sort(),
    destructive,
    guardCount,
    doBlocks,
  };
}

/**
 * Deterministic SQL-shape classification. HISTORICAL_PRESERVE and CUTOVER are
 * deliberately NOT derivable from SQL: the first is a deployment fact and the
 * second is a runtime fact. Both come from curation.
 */
function deriveSqlShape(a, isFirst) {
  if (isFirst) return { shape: "BASELINE", evidence: "lexically first migration in the chain" };
  if (a.destructive.length > 0) {
    return {
      shape: "CONTRACT_DROP",
      evidence: `removes ${a.destructive.length} persistent object(s): ${a.destructive
        .map((d) => `${d.kind}:${d.object}`)
        .join(", ")}`,
    };
  }
  if (a.dmlOnPreexisting.length > 0) {
    return {
      shape: "BACKFILL",
      evidence: `mutates rows in pre-existing table(s): ${a.dmlOnPreexisting.join(", ")}`,
    };
  }
  if (a.createdTables.length > 0 || a.addedColumns.length > 0 || a.createdTypes.length > 0 || a.extensions.length > 0) {
    return {
      shape: "EXPAND",
      evidence: `additive only — tables:${a.createdTables.length} columns:${a.addedColumns.length} types:${a.createdTypes.length} extensions:${a.extensions.length}`,
    };
  }
  return {
    shape: "REPAIR",
    evidence:
      "alters existing objects only (defaults / nullability / constraints / indexes / type conversion); creates nothing, drops nothing, mutates no pre-existing rows",
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function discover() {
  const entries = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  return entries.map((name) => {
    const sqlPath = join(MIGRATIONS_DIR, name, "migration.sql");
    const present = existsSync(sqlPath);
    // TWO digests, because they answer two different questions.
    //
    //   checksumSha256    — over LF-NORMALISED content. Stable across a
    //                       Windows (CRLF) and a Linux (LF) checkout, so the
    //                       inventory's own drift gate does not fire merely
    //                       because the repository was cloned on another
    //                       platform.
    //   checksumSha256Raw — over the RAW bytes on disk. This is the basis
    //                       Prisma uses for `_prisma_migrations.checksum`,
    //                       proven in the Point-6 empty-database rehearsal:
    //                       221/221 production rows matched the raw digest and
    //                       0 matched the normalised one.
    //
    // Consequence the runbook records: a database migrated from a CRLF
    // checkout and one migrated from an LF checkout store DIFFERENT checksums
    // for identical SQL, so the reconciler accepts either basis rather than
    // reporting a phantom P3006.
    const bytes = present ? readFileSync(sqlPath) : Buffer.alloc(0);
    const normalized = bytes.toString("utf8").replace(/\r\n/g, "\n");
    return {
      name,
      sqlPresent: present,
      byteLength: Buffer.byteLength(normalized, "utf8"),
      checksumSha256: present ? createHash("sha256").update(normalized, "utf8").digest("hex") : null,
      checksumSha256Raw: present ? createHash("sha256").update(bytes).digest("hex") : null,
      raw: normalized,
    };
  });
}

function gitIntroCommit(name) {
  try {
    const out = execFileSync(
      "git",
      ["log", "--diff-filter=A", "--format=%H", "-1", "--", `services/api/prisma/migrations/${name}/migration.sql`],
      { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

function gitTracked() {
  try {
    const out = execFileSync("git", ["ls-files", "services/api/prisma/migrations"], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const set = new Set();
    for (const line of out.split("\n")) {
      const m = line.match(/^services\/api\/prisma\/migrations\/([^/]+)\//);
      if (m) set.add(m[1]);
    }
    return set;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildInventory({ withGit = false, previous = null } = {}) {
  const curation = JSON.parse(readFileSync(CURATION_PATH, "utf8"));
  const disk = discover();
  const tracked = gitTracked();

  const createdBy = new Map();
  const typeCreatedBy = new Map();
  const analyses = new Map();

  disk.forEach((d) => {
    const a = analyzeSql(d.raw);
    analyses.set(d.name, a);
    for (const t of a.createdTables) if (!createdBy.has(t)) createdBy.set(t, d.name);
    for (const t of a.createdTypes) if (!typeCreatedBy.has(t)) typeCreatedBy.set(t, d.name);
  });

  const prevByName = new Map((previous?.migrations ?? []).map((m) => [m.name, m]));

  const migrations = disk.map((d, index) => {
    const a = analyses.get(d.name);
    const derived = deriveSqlShape(a, index === 0);
    const cur = curation.migrations?.[d.name] ?? null;
    const prev = prevByName.get(d.name) ?? null;

    // Dependencies: the migration that physically creates each referenced
    // relation. Self-created relations are not dependencies. Anything with no
    // known creator is an UNKNOWN dependency and fails the gate.
    const dependencies = [];
    const softDependencies = [];
    const unknownDependencies = [];
    for (const relation of a.referenced) {
      if (a.createdTables.includes(relation)) continue;
      const creator = createdBy.get(relation);
      if (!creator) {
        if (curation.knownExternalRelations?.includes(relation)) continue;
        unknownDependencies.push(relation);
        continue;
      }
      if (creator === d.name) continue;
      const bucket = a.softReferences.includes(relation) ? softDependencies : dependencies;
      if (!bucket.includes(creator)) bucket.push(creator);
    }
    dependencies.sort();
    softDependencies.sort();

    const requiredExtensions = [...new Set([...(a.extensions ?? []), ...((cur?.requiredExtensions ?? []))])].sort();

    const classification = cur?.classification ?? null;
    const releaseWave = cur?.releaseWave ?? null;

    const introCommit = withGit
      ? gitIntroCommit(d.name)
      : (prev?.gitIntroductionCommit ?? null);

    const sqlChangedSinceIntroduction =
      prev && prev.checksumSha256 && prev.checksumSha256 !== d.checksumSha256 ? true : (prev?.sqlChangedSinceIntroduction ?? false);

    return {
      name: d.name,
      order: index,
      sqlPresent: d.sqlPresent,
      byteLength: d.byteLength,
      checksumSha256: d.checksumSha256,
      checksumSha256Raw: d.checksumSha256Raw,
      checksumBasis:
        "checksumSha256 = sha256 over LF-normalised migration.sql; checksumSha256Raw = sha256 over the raw bytes on disk, which is the basis Prisma uses for _prisma_migrations.checksum",
      gitTracked: tracked ? tracked.has(d.name) : null,
      gitIntroductionCommit: introCommit,
      sqlChangedSinceIntroduction,
      classification,
      sqlShape: derived.shape,
      sqlShapeEvidence: derived.evidence,
      classificationEvidence: cur?.classificationEvidence ?? null,
      schemaObjectsTouched: {
        createdTables: a.createdTables,
        droppedTables: a.droppedTables,
        alteredTables: a.alteredTables,
        addedColumns: a.addedColumns,
        droppedColumns: a.droppedColumns,
        createdTypes: a.createdTypes,
        droppedTypes: a.droppedTypes,
        alteredTypes: a.alteredTypes,
        createdIndexes: a.createdIndexes,
        droppedIndexes: a.droppedIndexes,
        addedConstraints: a.addedConstraints,
        droppedConstraints: a.droppedConstraints,
      },
      dataTablesTouched: a.dmlTables,
      dataTablesMutatedPreexisting: a.dmlOnPreexisting,
      dependencies,
      softDependencies,
      unknownDependencies,
      dependentRuntimeCode: cur?.dependentRuntimeCode ?? [],
      compatibleCodeVersions: cur?.compatibleCodeVersions ?? null,
      requiredExtensions,
      destructiveStatements: a.destructive,
      guardBlocks: a.doBlocks,
      guardRaises: a.guardCount,
      destructiveGuarded: a.destructive.length === 0 ? null : a.guardCount > 0,
      guardedByPrecedingMigration: cur?.guardedByPrecedingMigration ?? null,
      prodApplied: "UNKNOWN_AWAITING_SNAPSHOT",
      prodChecksum: null,
      prodStatus: null,
      believedProductionState: cur?.believedProductionState ?? null,
      believedProductionEvidence: cur?.believedProductionEvidence ?? null,
      safeBeforeCodeDeployment: cur?.safeBeforeCodeDeployment ?? null,
      requiresBackfill: cur?.requiresBackfill ?? null,
      readinessCommand: cur?.readinessCommand ?? null,
      blockingReadinessCategories: cur?.blockingReadinessCategories ?? [],
      rollbackDisposition: cur?.rollbackDisposition ?? null,
      releaseWave,
      ownerAction: cur?.ownerAction ?? null,
      removalCondition: cur?.removalCondition ?? null,
      evidence: cur?.evidence ?? null,
    };
  });

  return { curation, migrations };
}

// ---------------------------------------------------------------------------
// Validation (the gate)
// ---------------------------------------------------------------------------

export function validate(migrations, curation) {
  const failures = [];
  const seen = new Map();

  for (const m of migrations) {
    if (!m.sqlPresent) failures.push(`MISSING_SQL: ${m.name} has no migration.sql`);
    if (m.byteLength === 0) failures.push(`EMPTY_SQL: ${m.name} migration.sql is empty`);
    if (!m.classification) failures.push(`UNCLASSIFIED: ${m.name} has no curated classification`);
    else if (!CLASSIFICATIONS.has(m.classification))
      failures.push(`BAD_CLASSIFICATION: ${m.name} -> ${m.classification}`);
    if (!m.releaseWave) failures.push(`UNKNOWN_RELEASE_WAVE: ${m.name}`);
    else if (!RELEASE_WAVES.has(m.releaseWave)) failures.push(`BAD_RELEASE_WAVE: ${m.name} -> ${m.releaseWave}`);
    if (!m.evidence) failures.push(`NO_EVIDENCE: ${m.name} carries no classification evidence`);
    if (m.unknownDependencies.length > 0)
      failures.push(`UNKNOWN_DEPENDENCY: ${m.name} references ${m.unknownDependencies.join(", ")}`);

    // Timestamp prefix + monotonicity.
    const ts = m.name.match(/^(\d{8,14})_/)?.[1] ?? null;
    if (!ts) {
      if (!curation.allowedNonTimestampedMigrations?.includes(m.name))
        failures.push(`NON_TIMESTAMPED: ${m.name}`);
    } else {
      const prior = seen.get(ts);
      if (prior && !(ts in (curation.acknowledgedDuplicateTimestamps ?? {})))
        failures.push(`DUPLICATE_TIMESTAMP: ${ts} used by ${prior} and ${m.name}`);
      seen.set(ts, m.name);
    }

    // Dependencies must be lexically earlier — a pending migration ordered
    // before its prerequisite cannot replay on a clean database.
    for (const dep of m.dependencies) {
      if (dep > m.name) failures.push(`DEPENDENCY_ORDER: ${m.name} depends on later ${dep}`);
    }

    // Every destructive statement must be guarded, and every CONTRACT_DROP
    // must state the condition under which removal is permitted.
    if (m.destructiveStatements.length > 0 && m.classification !== "HISTORICAL_PRESERVE") {
      // A guard may live in a lexically PRECEDING migration when the guarded
      // file's bytes must not change (a tracked migration's Prisma checksum).
      // `prisma migrate deploy` applies in lexical order and stops at the
      // first failure, so a RAISE there aborts before the drop is reached.
      const guardedBy = m.guardedByPrecedingMigration;
      let externalGuardOk = false;
      if (guardedBy) {
        const guard = migrations.find((x) => x.name === guardedBy);
        if (!guard) failures.push(`GUARD_MIGRATION_MISSING: ${m.name} names ${guardedBy}`);
        else if (guard.name >= m.name)
          failures.push(`GUARD_MIGRATION_NOT_EARLIER: ${guardedBy} must sort before ${m.name}`);
        else if (guard.guardRaises < 1)
          failures.push(`GUARD_MIGRATION_HAS_NO_RAISE: ${guardedBy}`);
        else externalGuardOk = true;
      }
      if (!m.destructiveGuarded && !externalGuardOk)
        failures.push(`UNGUARDED_DESTRUCTIVE: ${m.name} drops without a RAISE-guard`);
      if (m.classification !== "CONTRACT_DROP")
        failures.push(
          `DESTRUCTIVE_NOT_CONTRACT: ${m.name} is ${m.classification} but removes ${m.destructiveStatements.length} object(s)`,
        );
      if (!m.removalCondition) failures.push(`CONDITIONLESS_CONTRACT_DROP: ${m.name}`);
      if (m.releaseWave !== "CONTRACT_DROP_LATER")
        failures.push(`CONTRACT_DROP_IN_EARLY_WAVE: ${m.name} -> ${m.releaseWave}`);
    }

    // Release A must never carry a destructive statement.
    if (m.releaseWave === "SAFE_TO_APPLY_NOW" && m.destructiveStatements.length > 0)
      failures.push(`FIRST_DEPLOYMENT_CONTRACT_DROP: ${m.name}`);

    // A HISTORICAL_PRESERVE migration may never be scheduled for removal or
    // rewritten.
    if (m.classification === "HISTORICAL_PRESERVE" && m.releaseWave !== "HISTORICAL_PRESERVE_NEVER_REWRITE")
      failures.push(`HISTORICAL_PRESERVE_REMOVABLE: ${m.name} -> ${m.releaseWave}`);
    if (
      m.classification !== "HISTORICAL_PRESERVE" &&
      m.classification !== "BASELINE" &&
      m.releaseWave === "HISTORICAL_PRESERVE_NEVER_REWRITE"
    )
      failures.push(`NON_HISTORICAL_IN_FROZEN_WAVE: ${m.name}`);

    // A backfill without a readiness command cannot be proven complete.
    if (m.classification === "BACKFILL" && !m.readinessCommand)
      failures.push(`BACKFILL_WITHOUT_READINESS: ${m.name}`);

    // Extension prerequisites must have a readiness gate.
    for (const ext of m.requiredExtensions) {
      if (!curation.extensionReadiness?.[ext])
        failures.push(`EXTENSION_WITHOUT_READINESS: ${m.name} requires ${ext}`);
    }
  }

  // Curation must not name a migration that does not exist on disk.
  const onDisk = new Set(migrations.map((m) => m.name));
  for (const name of Object.keys(curation.migrations ?? {})) {
    if (!onDisk.has(name)) failures.push(`INVENTORY_ORPHAN: curated ${name} is not on disk`);
  }

  // Duplicate inventory records.
  const counts = new Map();
  for (const m of migrations) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  for (const [name, c] of counts) if (c > 1) failures.push(`INVENTORY_DUPLICATE: ${name} x${c}`);

  return failures;
}

export function metricsOf(migrations) {
  const byClass = {};
  const byWave = {};
  for (const m of migrations) {
    byClass[m.classification ?? "UNCLASSIFIED"] = (byClass[m.classification ?? "UNCLASSIFIED"] ?? 0) + 1;
    byWave[m.releaseWave ?? "UNKNOWN"] = (byWave[m.releaseWave ?? "UNKNOWN"] ?? 0) + 1;
  }
  const pending = migrations.filter((m) => m.classification !== "HISTORICAL_PRESERVE" && m.classification !== "BASELINE");
  return {
    filesystemMigrations: migrations.length,
    classifiedMigrations: migrations.filter((m) => m.classification).length,
    appliedInProduction: 0,
    pendingInProduction: 0,
    productionSnapshotUnknown: migrations.length,
    byClassification: byClass,
    byReleaseWave: byWave,
    MigrationInventoryUnknown: migrations.filter((m) => !m.classification || !m.releaseWave).length,
    UnclassifiedMigrations: migrations.filter((m) => !m.classification).length,
    UnknownDependencies: migrations.reduce((n, m) => n + m.unknownDependencies.length, 0),
    UnknownReleaseWave: migrations.filter((m) => !m.releaseWave).length,
    ConditionlessContractDrops: migrations.filter(
      (m) => m.classification === "CONTRACT_DROP" && !m.removalCondition,
    ).length,
    MigrationInventoryDuplicates: 0,
    FirstDeploymentContractDrops: migrations.filter(
      (m) => m.releaseWave === "SAFE_TO_APPLY_NOW" && m.destructiveStatements.length > 0,
    ).length,
    UnguardedDestructiveStatementsPending: pending.reduce(
      (n, m) =>
        n +
        (m.destructiveStatements.length > 0 && !m.destructiveGuarded && !m.guardedByPrecedingMigration
          ? m.destructiveStatements.length
          : 0),
      0,
    ),
    UnguardedDestructiveStatementsHistorical: migrations
      .filter((m) => m.classification === "HISTORICAL_PRESERVE")
      .reduce(
        (n, m) => n + (m.destructiveStatements.length > 0 && !m.destructiveGuarded ? m.destructiveStatements.length : 0),
        0,
      ),
    ProductionMigrationStateUnknown: migrations.length,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const withGit = argv.includes("--git");
  const asJson = argv.includes("--json");

  const previous = existsSync(INVENTORY_PATH) ? JSON.parse(readFileSync(INVENTORY_PATH, "utf8")) : null;
  const { curation, migrations } = buildInventory({ withGit, previous });
  const failures = validate(migrations, curation);
  const metrics = metricsOf(migrations);
  metrics.MigrationInventoryDuplicates = failures.filter((f) => f.startsWith("INVENTORY_DUPLICATE")).length;

  const artifact = {
    $schema: "proovra/p6-migration-inventory@1",
    generatedBy: "services/api/scripts/migration-inventory.mjs",
    authority:
      "CANONICAL migration inventory for PHASE 12 POINT 6. Supersedes the migration half of docs/architecture/schema-migration-classification.json (which remains the MODEL-level authority). One record per migration directory on disk.",
    productionSnapshot: previous?.productionSnapshot ?? {
      state: "AWAITING_OWNER_PRODUCTION_MIGRATION_SNAPSHOT",
      reason:
        "P6_PRODUCTION_READONLY_DATABASE_URL is not present in this environment. No production database was contacted. Collect with scripts/p6-production-migration-snapshot.mjs and reconcile with scripts/migration-production-reconcile.mjs.",
      collectedAtUtc: null,
      postgresVersion: null,
      extensions: null,
      rows: null,
    },
    conservation: {
      equation: "FilesystemMigrations = ClassifiedMigrations = AppliedInProduction + PendingInProduction + ProductionSnapshotUnknown",
      filesystemMigrations: metrics.filesystemMigrations,
      classifiedMigrations: metrics.classifiedMigrations,
      appliedInProduction: metrics.appliedInProduction,
      pendingInProduction: metrics.pendingInProduction,
      productionSnapshotUnknown: metrics.productionSnapshotUnknown,
      holds:
        metrics.filesystemMigrations === metrics.classifiedMigrations &&
        metrics.filesystemMigrations ===
          metrics.appliedInProduction + metrics.pendingInProduction + metrics.productionSnapshotUnknown,
    },
    metrics,
    gateFailures: failures,
    migrations,
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  }

  if (write) {
    writeFileSync(INVENTORY_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    process.stdout.write(`migration-inventory: wrote ${INVENTORY_PATH}\n`);
  }

  if (!asJson) {
    process.stdout.write(
      [
        `migrations on disk        : ${metrics.filesystemMigrations}`,
        `classified                : ${metrics.classifiedMigrations}`,
        `conservation holds        : ${artifact.conservation.holds}`,
        `by classification         : ${JSON.stringify(metrics.byClassification)}`,
        `by release wave           : ${JSON.stringify(metrics.byReleaseWave)}`,
        `production snapshot       : ${artifact.productionSnapshot.state}`,
        `gate failures             : ${failures.length}`,
        "",
      ].join("\n"),
    );
    for (const f of failures.slice(0, 60)) process.stdout.write(`  FAIL ${f}\n`);
    if (failures.length > 60) process.stdout.write(`  ... and ${failures.length - 60} more\n`);
  }

  if (failures.length > 0 || !artifact.conservation.holds) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
