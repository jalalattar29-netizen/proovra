#!/usr/bin/env node
/**
 * PHASE 12 POINT 4 — raw-schema ownership verification.
 *
 * The Prisma datamodel owns table and column EXISTENCE. Everything else that
 * a hand-written migration created and the datamodel deliberately does not
 * declare — index names, extra indexes, foreign keys, column defaults, native
 * type detail, extension-conditional columns — is registered in
 * `docs/architecture/raw-schema-ownership.json`.
 *
 * This verifier recomputes the residual set against a real database and
 * compares it to the manifest IN BOTH DIRECTIONS. It is NOT a filter:
 *
 *   - an object in the manifest that is no longer in the residual set means a
 *     registered raw object was DELETED or MUTATED  -> failure;
 *   - an object in the residual set that is not in the manifest means a NEW
 *     undeclared divergence appeared                -> failure;
 *   - any table or column proposed for removal, or any destructive column
 *     recreation, is a hard failure regardless of the manifest, because the
 *     datamodel must own existence.
 *
 * Usage:
 *   node scripts/raw-schema-verify.mjs --database-url=postgres://…
 *   DRIFT_CHECK_DATABASE_URL=… node scripts/raw-schema-verify.mjs
 *
 * Exit codes:
 *   0  verified
 *   2  no database target supplied (never guesses)
 *   3  explicit target on a non-local host (refused)
 *   4  a table or column is proposed for removal / destructive recreation
 *   5  registered object missing from the residual set (deleted or mutated)
 *   6  unregistered divergence present
 *   7  the schema comparison could not run
 *   8  extension verification failed
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyHost, parseDatabaseHost } from "./db-host-policy.mjs";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = resolve(
  API_ROOT,
  "../../docs/architecture/raw-schema-ownership.json",
);

const argUrl =
  process.argv
    .slice(2)
    .find((a) => a.startsWith("--database-url="))
    ?.slice("--database-url=".length)
    .trim() ?? "";
const envUrl = process.env.DRIFT_CHECK_DATABASE_URL?.trim() ?? "";
const ambient = process.env.DATABASE_URL?.trim() ?? "";
const databaseUrl = argUrl || envUrl || ambient;
const source = argUrl
  ? "--database-url argument"
  : envUrl
    ? "DRIFT_CHECK_DATABASE_URL"
    : ambient
      ? "DATABASE_URL (environment)"
      : "";

if (!databaseUrl) {
  process.stderr.write(
    "\n  raw-schema-verify: no database target resolved. Supply --database-url, " +
      "DRIFT_CHECK_DATABASE_URL or DATABASE_URL. It never guesses.\n\n",
  );
  process.exit(2);
}
if (argUrl || envUrl) {
  const { host } = parseDatabaseHost(databaseUrl);
  if (classifyHost(host) !== "local") {
    process.stderr.write(
      `\n  raw-schema-verify: REFUSING an explicit target on a non-local host (${host}).\n\n`,
    );
    process.exit(3);
  }
}

process.env.DATABASE_URL = databaseUrl;

const { host, database } = parseDatabaseHost(databaseUrl);
process.stderr.write("\n───────────────────────────────────────────────\n");
process.stderr.write("  PROOVRA raw-schema ownership verification\n");
process.stderr.write("───────────────────────────────────────────────\n");
process.stderr.write(`  host    : ${host}\n  database: ${database}\n  source  : ${source}\n`);
process.stderr.write("───────────────────────────────────────────────\n");

const diff = spawnSync(
  "pnpm",
  ["exec", "prisma", "migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma"],
  { cwd: API_ROOT, encoding: "utf8", shell: process.platform === "win32" },
);
if (diff.status !== 0 && !diff.stdout) {
  process.stderr.write(`  could not run the schema comparison:\n${diff.stderr}\n`);
  process.exit(7);
}
const text = diff.stdout ?? "";

/**
 * Parse the comparison into the same shape the manifest records.
 *
 * PHASE 12 POINT 6 — ENUMs are now parsed too. The scope regex previously
 * matched only `Changed the <x> table`, so an enum divergence fell through
 * every check and this verifier reported "0 unregistered divergences" while
 * `migrate diff --script` was emitting a full `AlterEnum` block. One real
 * residual was hidden that way: `mfa_recovery_request_status` still carries the
 * superseded `PENDING` variant that the datamodel no longer declares. An enum
 * scope is recorded as `<name> (enum)` so it can never be confused with a
 * table of the same name.
 */
function parse(src) {
  const out = [];
  let scope = null;
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/`/g, "");
    const t = /^\[\*\] Changed the (\S+) table/.exec(line);
    if (t) { scope = t[1]; continue; }
    const e = /^\[\*\] Changed the (\S+) enum/.exec(line);
    if (e) { scope = `${e[1]} (enum)`; continue; }
    if (/^\[/.test(line)) { if (!/^\[\*\] Changed/.test(line)) scope = null; continue; }
    const m = /^\s+\[([+\-*])\]\s+(.*)$/.exec(line);
    if (!m || !scope) continue;
    out.push({ table: scope, sign: m[1], object: m[2].trim() });
  }
  return out;
}

const residual = parse(text);
const key = (o) => `${o.table}::${o.sign}::${o.object}`;

// -- Hard failure 1: existence must be owned by the datamodel ----------------
const removedTables = /\[-\] Removed tables/.test(text)
  ? text
      .split(/\r?\n/)
      .slice(text.split(/\r?\n/).findIndex((l) => /\[-\] Removed tables/.test(l)) + 1)
      .filter((l) => /^\s+- /.test(l))
      .map((l) => l.trim().slice(2))
  : [];
const removedColumns = residual.filter((o) => /^Removed column/.test(o.object));
const recreations = residual.filter((o) => /would be dropped and recreated/.test(o.object));
if (removedTables.length || removedColumns.length || recreations.length) {
  process.stderr.write("\n  FAIL — the datamodel no longer owns object existence:\n");
  for (const t of removedTables) process.stderr.write(`    table proposed for removal : ${t}\n`);
  for (const c of removedColumns) process.stderr.write(`    column proposed for removal: ${c.table}.${c.object}\n`);
  for (const c of recreations) process.stderr.write(`    destructive recreation     : ${c.table} ${c.object}\n`);
  process.exit(4);
}

if (!existsSync(MANIFEST)) {
  process.stderr.write("\n  FAIL — raw-schema ownership manifest is missing.\n");
  process.exit(6);
}
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

// -- Extension probe, BEFORE the comparison ----------------------------------
//
// PHASE 12 POINT 5. An `EXTENSION_CONDITIONAL_COLUMN` entry records a column
// the datamodel declares and the database may not have — because the migration
// that creates it is guarded on an extension. That is a divergence ONLY while
// the extension is ABSENT. Install it, the column appears, the divergence
// disappears, and this verifier reported the registered entry as "gone or
// mutated" — failing precisely on the databases that are MORE correct.
//
// It went unnoticed because every rehearsal ran on plain PostgreSQL. Point 5
// makes pgvector a production prerequisite (the embedding chain cannot run
// without it), so both shapes must verify, and the probe has to happen before
// the diff rather than as a footnote after it.
const installedExtensions = new Set();
for (const ext of manifest.extensions ?? []) {
  // Asked of POSTGRES, not of prisma. `prisma db execute` exits 0 for any
  // statement that RUNS, including one that matches no rows, so the previous
  // probe could only ever report "present" or fail for an unrelated reason —
  // and in practice it reported "absent" on a database where the extension was
  // installed. A probe that cannot observe its subject is worse than none,
  // because the line it prints is believed.
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      "const{Client}=require('pg');" +
        "const c=new Client({connectionString:process.argv[1]});" +
        "c.connect().then(()=>c.query(\"SELECT 1 FROM pg_extension WHERE extname=$1\",[process.argv[2]]))" +
        ".then(r=>{process.exitCode=r.rowCount>0?0:1;return c.end();})" +
        ".catch(()=>{process.exitCode=2;});",
      databaseUrl,
      ext.name,
    ],
    { cwd: API_ROOT, encoding: "utf8" },
  );
  if (probe.status === 0) installedExtensions.add(ext.name);
  process.stderr.write(
    `  extension ${ext.name}: ${
      installedExtensions.has(ext.name) ? "present" : "absent"
    } — ${
      installedExtensions.has(ext.name)
        ? "extension-owned objects expected to EXIST, so their conditional entries are not divergences"
        : ext.runtimeBehaviourWhenAbsent
    }\n`,
  );
}

// The two conditional categories are MIRRORS, and both have to be honoured or
// one database shape always fails:
//
//   EXTENSION_CONDITIONAL_COLUMN  the datamodel declares it, the guarded
//                                 migration creates it. A divergence exactly
//                                 while the extension is ABSENT.
//   EXTENSION_CONDITIONAL_INDEX   raw SQL creates it and Prisma cannot express
//                                 the access method (ivfflat). A divergence
//                                 exactly while the extension is PRESENT.
//
// So each is dropped from the expected set in the state where it is NOT a
// divergence, rather than being registered unconditionally in both.
const extensionInstalled = installedExtensions.size > 0;
const conditionalSatisfied = manifest.objects.filter((o) =>
  extensionInstalled
    ? o.category === "EXTENSION_CONDITIONAL_COLUMN"
    : o.category === "EXTENSION_CONDITIONAL_INDEX",
);
const registered = new Set(
  manifest.objects
    .filter((o) => !conditionalSatisfied.includes(o))
    .map(key),
);
const present = new Set(residual.map(key));

const missing = [...registered].filter((k) => !present.has(k));
const unregistered = [...present].filter((k) => !registered.has(k));

if (missing.length) {
  process.stderr.write(
    `\n  FAIL — ${missing.length} REGISTERED raw-schema object(s) are gone or mutated:\n`,
  );
  for (const m of missing.slice(0, 25)) process.stderr.write(`    - ${m}\n`);
  if (missing.length > 25) process.stderr.write(`    … and ${missing.length - 25} more\n`);
  process.exit(5);
}
if (unregistered.length) {
  process.stderr.write(
    `\n  FAIL — ${unregistered.length} UNREGISTERED schema divergence(s) appeared:\n`,
  );
  for (const m of unregistered.slice(0, 25)) process.stderr.write(`    + ${m}\n`);
  if (unregistered.length > 25) process.stderr.write(`    … and ${unregistered.length - 25} more\n`);
  process.exit(6);
}

process.stderr.write(
  `\n  raw-schema-verify: OK — ${residual.length} registered object(s) verified, ` +
    "0 unregistered divergences, 0 objects proposed for removal.\n\n",
);
process.exit(0);
