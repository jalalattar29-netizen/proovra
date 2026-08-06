/**
 * PHASE 12 — POINT 8 PART A, STEP A2: the release-artifact integrity gate.
 *
 * THE DEFECT THIS EXISTS TO CATCH
 * ---------------------------------------------------------------------------
 * `20270924000000_drop_workspace_persona_profiles` is tracked in git and issues
 * a bare `DROP TABLE IF EXISTS … CASCADE`. Its entire safety comes from
 * `20270923500000_persona_profiles_removal_precondition`, which measures
 * dependencies and RAISEs — and which is NOT tracked. A clean checkout, which
 * is what `actions/checkout` hands `docker build`, therefore produces an
 * artifact containing the destructive statement WITHOUT the guard that makes it
 * safe. Nothing in the repository noticed, because every check ran against the
 * working tree, where both files exist.
 *
 * WHY IT DISCOVERS RATHER THAN READS A LIST
 * ---------------------------------------------------------------------------
 * A gate that consults a hand-maintained list of "destructive migrations"
 * fails the same way the artifact did: by omission. So destructive statements
 * are found by scanning SQL, and the guard relationship is found by the guard
 * NAMING the migration it guards — a link that exists in the file and cannot
 * drift out of sync with it. The Point-6 inventory is consulted for one thing
 * only: which migrations are still PENDING versus already-applied history that
 * may never be rewritten. That claim is cross-checked against the SQL scan, so
 * the inventory cannot understate what is destructive.
 *
 * It must FAIL against HEAD_ARTIFACT and PASS against PROPOSED_RELEASE_ARTIFACT.
 * A gate that has only ever passed has not been shown to be capable of failing.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const MIG_DIR = resolve(REPO, "services/api/prisma/migrations");

/**
 * Strip SQL comments so a statement mentioned in prose is not mistaken for one
 * that executes. The persona guard's own header discusses `DROP … CASCADE` at
 * length; without this it would be classified as destructive itself.
 */
export function stripSqlComments(sql) {
  let out = "";
  let i = 0;
  let state = "code"; // code | line | block | single | double | dollar
  let dollarTag = "";
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (state === "code") {
      if (two === "--") { state = "line"; i += 2; continue; }
      if (two === "/*") { state = "block"; i += 2; continue; }
      if (sql[i] === "'") { state = "single"; out += sql[i++]; continue; }
      if (sql[i] === '"') { state = "double"; out += sql[i++]; continue; }
      const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (dollar) { dollarTag = dollar[0]; state = "dollar"; out += dollarTag; i += dollarTag.length; continue; }
      out += sql[i++];
      continue;
    }
    if (state === "line") {
      if (sql[i] === "\n") { state = "code"; out += "\n"; }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (two === "*/") { state = "code"; i += 2; continue; }
      i += 1;
      continue;
    }
    if (state === "single") {
      out += sql[i];
      if (sql[i] === "'") state = "code";
      i += 1;
      continue;
    }
    if (state === "double") {
      out += sql[i];
      if (sql[i] === '"') state = "code";
      i += 1;
      continue;
    }
    // dollar-quoted body: kept, because PL/pgSQL guards live inside it
    if (sql.slice(i, i + dollarTag.length) === dollarTag) {
      out += dollarTag;
      i += dollarTag.length;
      state = "code";
      continue;
    }
    out += sql[i++];
  }
  return out;
}

/** Destructive statement shapes, discovered from executable SQL. */
const DESTRUCTIVE = [
  [/\bDROP\s+TABLE\b/gi, "DROP TABLE"],
  [/\bDROP\s+COLUMN\b/gi, "DROP COLUMN"],
  [/\bDROP\s+TYPE\b/gi, "DROP TYPE"],
  [/\bDROP\s+SCHEMA\b/gi, "DROP SCHEMA"],
  [/\bDROP\s+(MATERIALIZED\s+)?VIEW\b/gi, "DROP VIEW"],
  [/\bTRUNCATE\b/gi, "TRUNCATE"],
  [/\bDELETE\s+FROM\b/gi, "DELETE FROM"],
];

export function scanMigration(name) {
  const path = resolve(MIG_DIR, name, "migration.sql");
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const code = stripSqlComments(raw);
  const destructive = [];
  for (const [re, label] of DESTRUCTIVE) {
    const n = (code.match(re) ?? []).length;
    if (n > 0) destructive.push({ statement: label, count: n });
  }
  return {
    name,
    destructive,
    destructiveCount: destructive.reduce((a, d) => a + d.count, 0),
    // A guard is a file that REFUSES. `RAISE EXCEPTION` is the only construct
    // that aborts a Prisma migration mid-transaction.
    raises: (code.match(/\bRAISE\s+EXCEPTION\b/gi) ?? []).length,
    // A readiness/removal condition: the guard must be conditional on measured
    // state, not an unconditional abort.
    hasCondition: /\bIF\b[\s\S]*\bTHEN\b/i.test(code),
    /** Migrations this file names in its text — the guard→target link. */
    namesMigrations: [...new Set((raw.match(/\b\d{14}_[a-z0-9_]+/gi) ?? []))],
    rawText: raw,
  };
}

/**
 * Evaluate one artifact view.
 *
 * `view` is the list of migration directory names the artifact would contain.
 * `pendingWaves` maps migration name → Point-6 release wave; anything in
 * `HISTORICAL_PRESERVE_NEVER_REWRITE` is out of scope because it is already
 * applied and may never be rewritten.
 */
export function evaluateArtifactIntegrity({ view, waves }) {
  const inView = new Set(view);
  const failures = [];
  const scanned = new Map();

  for (const name of view) {
    const s = scanMigration(name);
    if (!s) {
      failures.push({ code: "MISSING_SQL", migration: name, reason: "migration.sql absent from the artifact" });
      continue;
    }
    scanned.set(name, s);
  }

  // Build the guard index: guard → the migrations it names.
  const guardsFor = new Map();
  for (const [name, s] of scanned) {
    if (s.raises === 0) continue;
    for (const target of s.namesMigrations) {
      if (target === name) continue;
      if (!guardsFor.has(target)) guardsFor.set(target, []);
      guardsFor.get(target).push(name);
    }
  }

  const pendingDestructive = [];
  for (const [name, s] of scanned) {
    if (s.destructiveCount === 0) continue;
    const wave = waves[name] ?? "UNKNOWN";
    if (wave === "HISTORICAL_PRESERVE_NEVER_REWRITE") continue; // already applied; frozen
    pendingDestructive.push(name);

    // Self-guarded: the file both measures and refuses before it destroys.
    if (s.raises > 0 && s.hasCondition) continue;

    const guards = (guardsFor.get(name) ?? []).filter((g) => inView.has(g));
    if (guards.length === 0) {
      // Does a guard exist ON DISK but outside this artifact? That is the
      // exact defect, and saying so is more useful than "no guard".
      const onDiskGuards = [];
      for (const other of Object.keys(waves)) {
        if (other === name || inView.has(other)) continue;
        const o = scanMigration(other);
        if (o && o.raises > 0 && o.namesMigrations.includes(name)) onDiskGuards.push(other);
      }
      failures.push({
        code: onDiskGuards.length > 0 ? "GUARD_EXCLUDED_FROM_ARTIFACT" : "UNGUARDED_DESTRUCTIVE",
        migration: name,
        reason:
          onDiskGuards.length > 0
            ? `destructive migration is in the artifact but its guard (${onDiskGuards.join(", ")}) is not`
            : "destructive migration has no guard anywhere",
      });
      continue;
    }

    for (const g of guards) {
      if (g >= name) {
        failures.push({
          code: "GUARD_ORDER",
          migration: name,
          reason: `guard ${g} does not sort before the destructive migration`,
        });
      }
      const gs = scanned.get(g);
      if (!gs?.hasCondition) {
        failures.push({
          code: "GUARD_UNCONDITIONAL",
          migration: name,
          reason: `guard ${g} has no readiness/removal condition — it aborts or passes unconditionally`,
        });
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    metrics: {
      migrationsInView: view.length,
      pendingDestructiveMigrations: pendingDestructive.length,
      TrackedDropWithoutGuard: failures.filter(
        (f) => f.code === "GUARD_EXCLUDED_FROM_ARTIFACT" || f.code === "UNGUARDED_DESTRUCTIVE",
      ).length,
      MigrationOrderConflicts: failures.filter((f) => f.code === "GUARD_ORDER").length,
      CleanArtifactMissingMigrations: failures.filter((f) => f.code === "MISSING_SQL").length,
    },
  };
}

/** Cross-check: the inventory may not understate what the SQL says is destructive. */
export function crossCheckInventory({ inventoryEntries }) {
  const mismatches = [];
  for (const e of inventoryEntries) {
    const s = scanMigration(e.name);
    if (!s) continue;
    const declared = (e.destructiveStatements ?? []).length;
    if (s.destructiveCount > 0 && declared === 0 && e.releaseWave !== "HISTORICAL_PRESERVE_NEVER_REWRITE") {
      mismatches.push({
        migration: e.name,
        reason: `SQL scan finds ${s.destructiveCount} destructive statement(s); inventory declares none`,
      });
    }
  }
  return mismatches;
}
