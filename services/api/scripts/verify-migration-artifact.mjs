#!/usr/bin/env node
/**
 * PHASE 12 CORRECTIVE PASS §7 (DB-010) — THE MIGRATION ARTIFACT GATE.
 *
 * WHY THIS EXISTS ALONGSIDE THE POINT-8 BOUNDARY GATE
 * ---------------------------------------------------------------------------
 * The Point-8 gate answers "are the three SOURCE VIEWS conserved?" — which
 * migration paths are in HEAD, in the worktree, and in the proposed artifact.
 * That is a question about accounting, and it is a good one. DB-010 is a
 * DIFFERENT question, and the Point-8 gate cannot answer it:
 *
 *     Does the artifact that will actually be applied contain a destructive
 *     statement WITHOUT the guard that authorises it, or in a release wave
 *     where it must not run at all?
 *
 * A path can be perfectly conserved between views and still be a
 * `DROP TABLE … CASCADE` shipping a release early with its guard left behind.
 * That is the exact shape the previous pass found in the GHCR artifact, so the
 * check has to read the SQL in the MATERIALIZED artifact, not the directory
 * listing.
 *
 * WHAT IT READS
 * ---------------------------------------------------------------------------
 * A materialized artifact directory (`release-materialize.mjs --out`), the
 * curated inventory (classification + release wave + readiness), and the image
 * definitions. It opens no socket, contacts no registry, and prints no SQL
 * body — only statement KINDS, file names and line numbers.
 *
 * EVERY RULE IS NEGATIVE-TESTED. `phase-12-db-010-migration-artifact.test.ts`
 * injects ten specific defects into a materialized artifact and requires each
 * one to fail. A detector that has never been shown to detect is the same
 * fictional control this gate replaces.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../../..");

// ---------------------------------------------------------------------------
// Statement classification
// ---------------------------------------------------------------------------

/**
 * Destructive statement kinds, as patterns over COMMENT-STRIPPED SQL.
 *
 * Comments are stripped first and deliberately: a migration that merely
 * DESCRIBES a drop in prose is not destructive, and a gate that cannot tell
 * the difference trains people to stop writing the prose.
 */
const DESTRUCTIVE_PATTERNS = [
  { kind: "DROP_TABLE", re: /\bDROP\s+TABLE\b/i },
  { kind: "DROP_COLUMN", re: /\bDROP\s+COLUMN\b/i },
  { kind: "DROP_CONSTRAINT", re: /\bDROP\s+CONSTRAINT\b/i },
  { kind: "DROP_INDEX", re: /\bDROP\s+INDEX\b/i },
  { kind: "DROP_TYPE", re: /\bDROP\s+TYPE\b/i },
  { kind: "DROP_SCHEMA", re: /\bDROP\s+SCHEMA\b/i },
  // CASCADE only where it AMPLIFIES a removal. `ON DELETE CASCADE` in a
  // CREATE TABLE is a referential rule, not a destructive statement, and
  // flagging it made the gate report the whole schema as destructive — which
  // is how a gate becomes noise people route around.
  { kind: "CASCADE", re: /\b(?:DROP|TRUNCATE)\b[^;]{0,200}?\bCASCADE\b/i },
  /**
   * `ALTER TABLE … DROP <object>`.
   *
   * Deliberately NOT `ALTER TABLE … DROP <anything>`. The first draft used the
   * broad form and flagged five pending migrations that only RELAX a
   * constraint — `ALTER COLUMN … DROP NOT NULL`, `DROP DEFAULT`. Relaxing a
   * constraint removes no object and no row; it strictly widens what the
   * column accepts. Demanding a readiness guard for it teaches people that
   * this gate does not know what it is talking about, which is how a gate
   * stops being read.
   */
  { kind: "ALTER_DROP", re: /\bALTER\s+TABLE\b[\s\S]{0,300}?\bDROP\s+(COLUMN|CONSTRAINT)\b/i },
  { kind: "RENAME", re: /\bRENAME\s+(TO|COLUMN|CONSTRAINT)\b/i },
  { kind: "TRUNCATE", re: /\bTRUNCATE\b/i },
  { kind: "DELETE_WITHOUT_WHERE", re: /\bDELETE\s+FROM\b(?![\s\S]{0,300}?\bWHERE\b)/i },
];

/**
 * A statement executed through a string the scanner cannot read.
 *
 * `EXECUTE format(...)` and `EXECUTE 'DROP …'` are legitimate and used
 * throughout this repository's guarded migrations — but a dynamic statement
 * whose text contains a destructive keyword must be classified as destructive,
 * because the alternative is a gate that any migration can walk past by
 * building its DDL out of a variable.
 */
function dynamicDestructiveKinds(sql) {
  const kinds = new Set();
  for (const m of sql.matchAll(/\bEXECUTE\b([\s\S]{0,600}?);/gi)) {
    const body = m[1] ?? "";
    for (const { kind, re } of DESTRUCTIVE_PATTERNS) {
      if (re.test(body)) kinds.add(`DYNAMIC_${kind}`);
    }
    // A dynamic statement built from a value this scanner cannot resolve AND
    // containing no recognised keyword is UNKNOWN — reported, never assumed
    // safe.
    //
    // SELECT and SET belong in this list: a guarded migration's readiness
    // checks are `EXECUTE 'SELECT COUNT(*) …' INTO n`, which is how the
    // migration MEASURES before it acts. Omitting them made the gate report
    // its own readiness queries as unclassifiable.
    if (
      !/\b(SELECT|SET|CREATE|ALTER|DROP|UPDATE|INSERT|DELETE|COMMENT|TRUNCATE|GRANT|REVOKE|ANALYZE|VACUUM)\b/i.test(
        body,
      )
    ) {
      kinds.add("UNKNOWN_EXECUTABLE_SQL");
    }
  }
  return [...kinds];
}

export function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

/**
 * A constraint that is DROPPED and immediately RE-ADDED under the same name is
 * a REPLACEMENT, not a removal — the invariant is being changed, and the
 * database is never left without one. `20271006000000` and `20271114000000`
 * both have this shape.
 */
function constraintDropsAreAllSwaps(bare) {
  const dropped = [...bare.matchAll(/\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi)]
    .map((m) => m[1]);
  if (dropped.length === 0) return false;
  return dropped.every((name) =>
    new RegExp(`\\bADD\\s+CONSTRAINT\\s+"?${name}"?`, "i").test(bare),
  );
}

/**
 * Remove single-quoted string literals.
 *
 * Needed because a guard's own RAISE message legitimately says things like
 * "the pending DROP … CASCADE would destroy those rows silently" — and the
 * first draft of this gate read that sentence as a destructive statement and
 * reported the GUARD as the thing needing a guard.
 *
 * Applied ONLY to the static keyword pass. `dynamicDestructiveKinds` runs over
 * the un-stripped text, because an `EXECUTE 'ALTER TABLE … DROP COLUMN'` is a
 * real statement that happens to be spelled as a literal, and it must stay
 * classified.
 */
export function stripStringLiterals(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

export function classifyMigration(sql) {
  const bare = stripComments(sql);
  const staticText = stripStringLiterals(bare);
  const kinds = new Set();
  for (const { kind, re } of DESTRUCTIVE_PATTERNS) {
    if (re.test(staticText)) kinds.add(kind);
  }
  for (const k of dynamicDestructiveKinds(bare)) kinds.add(k);

  // A pure constraint SWAP is not a removal. Withdraw the two kinds it would
  // otherwise raise, but only when EVERY dropped constraint is re-added and
  // nothing else destructive is present.
  if (
    kinds.has("DROP_CONSTRAINT") &&
    constraintDropsAreAllSwaps(staticText) &&
    ![...kinds].some(
      (k) => !["DROP_CONSTRAINT", "ALTER_DROP"].includes(k),
    )
  ) {
    kinds.delete("DROP_CONSTRAINT");
    kinds.delete("ALTER_DROP");
  }
  return [...kinds].sort();
}

/**
 * Where the first destructive statement appears, in COMMENT-STRIPPED offsets,
 * and where the last guard that could authorise it appears.
 *
 * A "guard" is an executable refusal — `RAISE EXCEPTION` — or an
 * `information_schema` existence condition. Prose is not a guard, which is why
 * comments are stripped before either is located.
 */
export function guardPosition(sql) {
  const bare = stripComments(sql);
  // Offsets are taken over the LITERAL-BLANKED text so a keyword inside a
  // RAISE message cannot be mistaken for the statement it describes. Blanking
  // preserves length, so the offsets still line up with `bare`.
  const staticText = stripStringLiterals(bare);
  let firstDestructive = Infinity;
  for (const { re } of DESTRUCTIVE_PATTERNS) {
    const m = re.exec(staticText);
    if (m && m.index < firstDestructive) firstDestructive = m.index;
  }
  // A DYNAMIC destructive statement counts, and at the position of its
  // EXECUTE. Without this the ordering rule skipped every guarded migration
  // that does its work through `EXECUTE '…'` — which is most of them in this
  // repository — and a drop built from a string walked past the gate entirely.
  for (const m of bare.matchAll(/\bEXECUTE\b([\s\S]{0,600}?);/gi)) {
    const body = m[1] ?? "";
    if (DESTRUCTIVE_PATTERNS.some(({ re }) => re.test(body))) {
      if (m.index !== undefined && m.index < firstDestructive) {
        firstDestructive = m.index;
      }
    }
  }
  const raise = bare.search(/\bRAISE\s+EXCEPTION\b/i);
  const infoSchema = bare.search(/\binformation_schema\b/i);
  const firstGuard = Math.min(
    raise < 0 ? Infinity : raise,
    infoSchema < 0 ? Infinity : infoSchema,
  );
  return { firstDestructive, firstGuard, hasRaise: raise >= 0 };
}

// ---------------------------------------------------------------------------
// Artifact reading
// ---------------------------------------------------------------------------

export function readArtifact(artifactDir) {
  const migRoot = path.join(artifactDir, "services/api/prisma/migrations");
  if (!existsSync(migRoot)) {
    throw new Error(`no migrations directory in artifact: ${migRoot}`);
  }
  const names = readdirSync(migRoot)
    .filter(
      (d) =>
        statSync(path.join(migRoot, d)).isDirectory() &&
        existsSync(path.join(migRoot, d, "migration.sql")),
    )
    .sort();
  return names.map((name) => {
    const bytes = readFileSync(path.join(migRoot, name, "migration.sql"));
    return {
      name,
      sql: bytes.toString("utf8"),
      checksum: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

function loadCuration() {
  return JSON.parse(
    readFileSync(
      path.join(REPO, "docs/architecture/migration-inventory-p6.curation.json"),
      "utf8",
    ),
  );
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {string} input.artifactDir     materialized artifact root
 * @param {"A"|"B"|"C"|"D"} input.wave   which release this artifact is for
 * @param {Record<string,string>} [input.headChecksums] name → sha256 of the
 *   bytes in HEAD, for the historical-immutability check
 * @param {string[]} [input.workerInventory] the migration set the WORKER image
 *   would apply, when the deployment gives it one
 * @param {string} [input.imageTag]      the tag the compose file resolves to
 */
export function verifyArtifact(input) {
  const failures = [];
  const fail = (code, detail) => failures.push({ code, detail });

  const migrations = readArtifact(input.artifactDir);
  const curation = loadCuration();
  const curated = curation.migrations ?? {};

  /**
   * SETTLED HISTORY IS NOT GOVERNED BY THE GUARD RULES.
   *
   * 185 of these migrations are `HISTORICAL_PRESERVE_NEVER_REWRITE`: already
   * applied everywhere, their bytes recorded as a Prisma checksum in every
   * database that ran them. Many of them contain an unguarded `DROP INDEX` or
   * `ALTER … DROP` — that was the convention at the time, and demanding a
   * guard now would demand REWRITING FROZEN BYTES, which is precisely what
   * must never happen.
   *
   * So the guard rules govern the set a release will actually APPLY. History
   * is protected by a different and stricter rule — the checksum immutability
   * check below — and its destructive statements are still REPORTED, so
   * "historically unguarded" is visible rather than silently excluded.
   */
  const isSettledHistory = (name) =>
    curated[name]?.releaseWave === "HISTORICAL_PRESERVE_NEVER_REWRITE";

  const historicalDestructive = [];

  // --- 1. every destructive statement is authorised, in its own file -------
  for (const m of migrations) {
    const kinds = classifyMigration(m.sql);
    if (kinds.length === 0) continue;
    if (isSettledHistory(m.name)) {
      historicalDestructive.push({ name: m.name, kinds });
      continue;
    }

    if (kinds.includes("UNKNOWN_EXECUTABLE_SQL")) {
      fail(
        "UNKNOWN_EXECUTABLE_SQL",
        `${m.name}: a dynamic statement this scanner cannot classify. Unreadable is not safe.`,
      );
    }

    const { firstDestructive, firstGuard, hasRaise } = guardPosition(m.sql);
    if (firstDestructive === Infinity) continue;

    /**
     * THE DECLARED PRECEDING GUARD.
     *
     * One migration in this repository cannot carry its own guard:
     * `20270924000000_drop_workspace_persona_profiles` is tracked in git, so
     * its bytes are a Prisma checksum recorded in every database that applied
     * it and may never be rewritten. Its guard therefore lives in
     * `20270923500000_persona_profiles_removal_precondition`, which sorts
     * immediately before it.
     *
     * That satisfies what §7 actually requires — guard and contract SHIP
     * TOGETHER and the guard PRECEDES the contract — so it is accepted, but
     * only under three conditions that are all checked: the curation must
     * DECLARE the relationship, the named guard must be PRESENT in this same
     * artifact, and it must sort BEFORE. A declared guard left out of the
     * release is the exact failure this gate exists to catch.
     */
    const entry = curated[m.name];
    const declaredGuard = entry?.guardedByPrecedingMigration ?? null;
    let externallyGuarded = false;
    if (declaredGuard) {
      const guardPresent = migrations.some((x) => x.name === declaredGuard);
      if (!guardPresent) {
        fail(
          "DECLARED_GUARD_MISSING_FROM_ARTIFACT",
          `${m.name}: declares its guard as ${declaredGuard}, which is NOT in this artifact. The drop would ship alone.`,
        );
      } else if (declaredGuard >= m.name) {
        fail(
          "DECLARED_GUARD_DOES_NOT_PRECEDE",
          `${m.name}: declared guard ${declaredGuard} does not sort before it, so it runs too late.`,
        );
      } else {
        externallyGuarded = true;
      }
    }

    if (!externallyGuarded) {
      if (firstGuard === Infinity) {
        fail(
          "DESTRUCTIVE_WITHOUT_GUARD",
          `${m.name}: ${kinds.join(", ")} with no guard anywhere in the file.`,
        );
      } else if (firstGuard > firstDestructive) {
        fail(
          "GUARD_AFTER_DESTRUCTIVE",
          `${m.name}: the first guard appears AFTER the first destructive statement. A guard that runs second authorises nothing.`,
        );
      }
    }

    // A CONTRACT_DROP must refuse EXECUTABLY, not merely be conditional: an
    // information_schema check makes a drop a no-op on a database that never
    // had the object, but says nothing about a database whose ROWS make the
    // drop unsafe. The refusal may live in the declared preceding guard.
    if (entry?.classification === "CONTRACT_DROP" && !hasRaise) {
      const guardRaises =
        externallyGuarded &&
        guardPosition(
          migrations.find((x) => x.name === declaredGuard)?.sql ?? "",
        ).hasRaise;
      if (!guardRaises) {
        fail(
          "CONTRACT_DROP_WITHOUT_READINESS_RAISE",
          `${m.name}: classified CONTRACT_DROP but neither it nor its declared guard can RAISE. Its readiness cannot refuse.`,
        );
      }
    }
  }

  // --- 2. release-wave correctness ----------------------------------------
  //
  // A CONTRACT_DROP migration in a Release A/B/C artifact is the finding this
  // gate exists for: it RAISEs when readiness is not zero, and a raise inside
  // `prisma migrate deploy` leaves a FAILED row that blocks every later
  // migration.
  if (input.wave !== "D") {
    for (const m of migrations) {
      const entry = curated[m.name];
      if (entry?.classification === "CONTRACT_DROP") {
        fail(
          "CONTRACT_IN_EARLY_WAVE",
          `${m.name}: CONTRACT_DROP present in a Release-${input.wave} artifact.`,
        );
      }
    }
  }

  // --- 3. runtime cutover prerequisite ------------------------------------
  for (const m of migrations) {
    const entry = curated[m.name];
    if (!entry) continue;
    const destructive = classifyMigration(m.sql).length > 0;
    const { hasRaise } = guardPosition(m.sql);

    // The cutover prerequisite applies to a migration that ACTUALLY removes
    // something. A guard-only CONTRACT_DROP — one that measures and RAISEs and
    // changes nothing — is safe before the code deploys, and demanding it
    // declare otherwise would be demanding a false statement.
    if (
      entry.classification === "CONTRACT_DROP" &&
      destructive &&
      entry.safeBeforeCodeDeployment !== false
    ) {
      fail(
        "CONTRACT_MISSING_CUTOVER_PREREQUISITE",
        `${m.name}: removes something, so it must declare safeBeforeCodeDeployment: false.`,
      );
    }

    // Readiness must be RUNNABLE — but a migration whose readiness executes
    // inside itself (a RAISE) already satisfies that, more strongly than a
    // command an operator has to remember to run. Require one or the other.
    const selfChecking =
      hasRaise ||
      (entry.guardedByPrecedingMigration &&
        guardPosition(
          migrations.find((x) => x.name === entry.guardedByPrecedingMigration)
            ?.sql ?? "",
        ).hasRaise);
    if (
      (entry.classification === "CONTRACT_DROP" ||
        entry.classification === "BACKFILL") &&
      !entry.readinessCommand &&
      !selfChecking &&
      entry.releaseWave !== "HISTORICAL_PRESERVE_NEVER_REWRITE"
    ) {
      fail(
        "MISSING_READINESS_COMMAND",
        `${m.name}: ${entry.classification} with neither a readinessCommand nor a self-executing RAISE.`,
      );
    }
  }

  // --- 4. historical checksum immutability --------------------------------
  if (input.headChecksums) {
    for (const m of migrations) {
      const head = input.headChecksums[m.name];
      if (head && head !== m.checksum) {
        fail(
          "HISTORICAL_CHECKSUM_CHANGED",
          `${m.name}: bytes differ from HEAD. Every database that applied it recorded the old checksum.`,
        );
      }
    }
  }

  // --- 5. source ↔ artifact inventory parity ------------------------------
  const artifactNames = new Set(migrations.map((m) => m.name));
  const curatedNames = new Set(Object.keys(curated));
  for (const n of artifactNames) {
    if (!curatedNames.has(n)) {
      fail(
        "ARTIFACT_MIGRATION_NOT_IN_INVENTORY",
        `${n}: present in the artifact but absent from the curated inventory.`,
      );
    }
  }
  for (const n of curatedNames) {
    const entry = curated[n];
    // Contract migrations are DELIBERATELY absent from an early wave.
    if (
      !artifactNames.has(n) &&
      !(input.wave !== "D" && entry?.classification === "CONTRACT_DROP")
    ) {
      fail(
        "SOURCE_MIGRATION_MISSING_FROM_ARTIFACT",
        `${n}: in the inventory but not in the artifact that would be applied.`,
      );
    }
  }

  // --- 6. API / Worker inventory parity -----------------------------------
  //
  // The Worker image ships no migrations directory; migration authority is the
  // API's alone. If a deployment ever gives the Worker one, the two must be
  // identical, because two processes applying different chains to one database
  // is the split-authority failure SEC-004 documented in another form.
  if (input.workerInventory) {
    const worker = new Set(input.workerInventory);
    const onlyApi = [...artifactNames].filter((n) => !worker.has(n));
    const onlyWorker = [...worker].filter((n) => !artifactNames.has(n));
    if (onlyApi.length > 0 || onlyWorker.length > 0) {
      fail(
        "API_WORKER_INVENTORY_MISMATCH",
        `api-only: ${onlyApi.join(",") || "none"}; worker-only: ${onlyWorker.join(",") || "none"}`,
      );
    }
  }

  // --- 7. immutable image identity ----------------------------------------
  if (input.imageTag !== undefined) {
    const tag = String(input.imageTag).trim();
    const immutable =
      /^sha256:[0-9a-f]{64}$/.test(tag) || /^[0-9a-f]{40}$/.test(tag);
    if (!immutable) {
      fail(
        "FLOATING_IMAGE_IDENTITY",
        `image tag "${tag.slice(0, 40)}" is not an immutable identity (commit SHA or digest).`,
      );
    }
  }

  return {
    artifactDir: input.artifactDir,
    wave: input.wave,
    migrationCount: migrations.length,
    destructiveMigrations: migrations
      .map((m) => ({ name: m.name, kinds: classifyMigration(m.sql) }))
      .filter((m) => m.kinds.length > 0),
    /**
     * Destructive statements in settled history. Reported, never failed on:
     * their bytes are frozen and rewriting them would invalidate a recorded
     * checksum. Present so the number is a fact an operator can see rather
     * than an exclusion nobody knows about.
     */
    historicalDestructiveCount: historicalDestructive.length,
    failures,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : d;
  };
  const report = verifyArtifact({
    artifactDir: path.resolve(arg("--artifact", "")),
    wave: arg("--wave", "D"),
    ...(arg("--image-tag", undefined) !== undefined
      ? { imageTag: arg("--image-tag", "") }
      : {}),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.failures.length > 0) {
    process.stderr.write(
      `\nMIGRATION ARTIFACT GATE FAILED — ${report.failures.length} finding(s).\n`,
    );
    process.exit(1);
  }
}
