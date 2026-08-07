/**
 * PHASE 12 — POINT 8 PART A, STEP A0: the three source views, and the
 * conservation proof between them.
 *
 * WHY THREE VIEWS
 * ---------------------------------------------------------------------------
 * The release-blocking finding is a DIFFERENCE between what is on disk and what
 * a clean checkout would produce: 221 migration directories exist, 204 are in
 * HEAD, and the seventeen missing ones include the guard for a tracked,
 * unguarded `DROP TABLE … CASCADE`. A statement about "the migrations" is
 * therefore meaningless without saying WHICH view it is about, and the previous
 * pass could only report the discrepancy because it happened to check both.
 *
 *   HEAD_ARTIFACT              what `actions/checkout` + `docker build` sees.
 *                              This is what actually ships today.
 *   SETTLED_WORKTREE           what is on this machine, including 1,000+
 *                              uncommitted files of unrelated user work.
 *                              NOT a reproducible artifact and never treated
 *                              as one.
 *   PROPOSED_RELEASE_ARTIFACT  HEAD plus exactly the additions this pass
 *                              justifies, minus nothing. Enumerated, not
 *                              inferred.
 *
 * CONSERVATION
 * ---------------------------------------------------------------------------
 * Every path in any view must be accounted for in the others: added, carried,
 * or deliberately excluded with a reason. A path that simply vanishes between
 * views is the failure mode that produced the guard/drop split in the first
 * place, so it is an error here rather than a diff nobody read.
 *
 * Reads files and runs `git`. Opens no socket. Prints no SQL body.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "../../../..");

export function git(...args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);

/** LF-normalised digest — the basis Prisma-independent comparisons use here. */
export function digestText(text) {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

/** Raw-byte digest — the basis `_prisma_migrations.checksum` uses. */
export function digestBytes(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function deriveSourceSets() {
  const tracked = new Set(lines(git("ls-files")));
  const modified = new Set(lines(git("ls-files", "-m", "--exclude-standard")));
  const deleted = new Set(lines(git("ls-files", "-d")));
  const untracked = new Set(lines(git("ls-files", "-o", "--exclude-standard")));
  // `ls-files -m` reports deletions as modifications; separate them so the
  // counts add up rather than double-count.
  for (const d of deleted) modified.delete(d);
  return { tracked, modified, deleted, untracked };
}

const MIG_DIR = "services/api/prisma/migrations";

export function migrationsOnDisk() {
  const root = resolve(REPO, MIG_DIR);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => statSync(join(root, d)).isDirectory() && existsSync(join(root, d, "migration.sql")))
    .sort();
}

export function migrationsInHead() {
  // A migration is a DIRECTORY containing `migration.sql`. `migration_lock.toml`
  // also lives at the migrations root, so keying on the first path segment
  // alone counts it as a migration and inflates the HEAD total by one.
  const suffix = "/migration.sql";
  return lines(git("ls-tree", "-r", "--name-only", "HEAD", `${MIG_DIR}/`))
    .filter((p) => p.endsWith(suffix))
    .map((p) => p.slice(MIG_DIR.length + 1, p.length - suffix.length))
    .filter((n) => n && !n.includes("/"))
    .sort();
}

export function migrationsInInventory() {
  const inv = JSON.parse(readFileSync(resolve(REPO, "docs/architecture/migration-inventory-p6.json"), "utf8"));
  return { names: inv.migrations.map((m) => m.name).sort(), entries: inv.migrations };
}

export function migrationSql(name) {
  return readFileSync(resolve(REPO, MIG_DIR, name, "migration.sql"));
}

/**
 * Build the three views over MIGRATION DIRECTORIES (the set the finding is
 * about) and prove conservation.
 *
 * `proposedAdditions` is the explicit list A1/A3 justify adding to HEAD.
 * `proposedExclusions` maps a name to the reason it is deliberately left out.
 */
/**
 * PHASE 12 CORRECTIVE PASS 3 §1.1 (2026-08-06) — THE LEDGER IS A HISTORY, THE
 * PARTITION IS DERIVED.
 *
 * What was wrong
 * ---------------------------------------------------------------------------
 * `proposedAdditions` was a hand-maintained list that meant "on disk but not
 * yet in HEAD". That is a statement about a MOMENT, and the list outlived the
 * moment: the eighteen Point-8 entries landed at `a7863bec`, a nineteenth was
 * authored afterwards, and the all-in-or-all-out check then reported
 *
 *     "the release landed partially: 18 of 19 additions are in HEAD"
 *
 * — a true statement about a drifted model, not about the migrations. The
 * previous pass concluded this could only be repaired by a commit. That was
 * wrong: nothing about the repair requires committing. The list simply has to
 * stop being a snapshot and become what it always described — a LEDGER of every
 * addition this programme has justified, with the landed/proposed split DERIVED
 * from HEAD at evaluation time.
 *
 * The model now
 * ---------------------------------------------------------------------------
 *   LEDGER     every justified addition, ever. Append-only. An entry is never
 *              removed when it lands, because the justification is still the
 *              reason the migration is in the artifact.
 *   LANDED     ledger ∩ HEAD. Baseline. Not proposed, not re-litigated.
 *   PROPOSED   ledger ∩ (disk \ HEAD). What a release would still add.
 *
 * Both partitions are computed, so the model cannot drift again: committing a
 * migration moves it from PROPOSED to LANDED with no edit, and authoring one
 * moves it into PROPOSED as soon as it is justified.
 *
 * Conservation is strictly stronger than before. The removed check could only
 * see one failure (a mixed list). These see five, and each is adversarially
 * injected in `phase-12-point8-release-artifact.test.ts`:
 * a landed entry reported as still proposed; a worktree-only migration missing
 * from the ledger; a ledger entry naming a migration that exists nowhere; a
 * HEAD migration deleted from disk; and a guard/drop pair split across the HEAD
 * boundary.
 */
export function partitionAdditions({ ledger, head, disk }) {
  const headSet = new Set(head);
  const diskSet = new Set(disk);
  const landed = [];
  const proposed = [];
  const vanished = [];
  for (const n of ledger) {
    if (headSet.has(n)) landed.push(n);
    else if (diskSet.has(n)) proposed.push(n);
    else vanished.push(n);
  }
  return { landed: landed.sort(), proposed: proposed.sort(), vanished: vanished.sort() };
}

/**
 * A destructive migration and the guard whose RAISE is its only safety must
 * never be separated. The wave selector already enforces that WITHIN an
 * artifact; this enforces it ACROSS the HEAD boundary, which is the split that
 * actually shipped: the drop was tracked and its guard was not.
 *
 * A pair is discovered, not listed — the guard names the migration it guards in
 * its own SQL, which is the link the Point-8 gate established.
 */
function guardDropSplitAcrossHead({ disk, head }) {
  const headSet = new Set(head);
  const errors = [];
  for (const guard of disk) {
    let text;
    try {
      text = migrationSql(guard).toString("utf8");
    } catch {
      continue;
    }
    for (const target of disk) {
      if (target === guard) continue;
      if (!text.includes(target)) continue;
      // `guard` names `target`. If exactly one of them is in HEAD, a clean
      // checkout ships half the pair.
      if (headSet.has(guard) !== headSet.has(target)) {
        errors.push(
          `guard/drop pair split across the HEAD boundary: ${guard} names ${target}, ` +
            `but only ${headSet.has(guard) ? guard : target} is tracked`,
        );
      }
    }
  }
  return errors;
}

export function buildViews({ proposedAdditions = [], proposedExclusions = {} } = {}) {
  const onDisk = migrationsOnDisk();
  const head = migrationsInHead();
  const { names: inventory } = migrationsInInventory();

  const headSet = new Set(head);
  const diskSet = new Set(onDisk);
  const exclSet = new Set(Object.keys(proposedExclusions));

  // `proposedAdditions` is the LEDGER. The landed/proposed split is derived.
  const ledger = [...proposedAdditions];
  const ledgerSet = new Set(ledger);
  const { landed, proposed: stillProposed, vanished } = partitionAdditions({
    ledger,
    head,
    disk: onDisk,
  });

  const proposed = [...new Set([...head, ...stillProposed])].filter((n) => !exclSet.has(n)).sort();

  const untrackedOnDisk = onDisk.filter((n) => !headSet.has(n));

  const errors = [];

  // Conservation 1: a ledger entry must exist SOMEWHERE — in HEAD or on disk.
  // An entry naming neither is a migration that was justified and then lost,
  // which is exactly the class of disappearance this file exists to catch.
  for (const n of vanished) {
    errors.push(`ledger entry exists in neither HEAD nor the worktree: ${n}`);
  }

  // Conservation 1b: a LANDED entry must never be reported as still proposed.
  // Derived, so it cannot be violated by construction — asserted anyway,
  // because a future change to the partition would otherwise fail silently.
  for (const n of landed) {
    if (stillProposed.includes(n)) {
      errors.push(`landed migration is still listed as proposed: ${n}`);
    }
  }

  // Conservation 1c: a tracked migration must not have been deleted from disk.
  // `git ls-tree` still reports it, so a clean checkout would ship a directory
  // this worktree no longer has — and every local rehearsal would be blind to it.
  for (const n of head) {
    if (!diskSet.has(n)) {
      errors.push(`migration is in HEAD but missing from the worktree: ${n}`);
    }
  }

  // Conservation 2: every untracked directory must be in the ledger or
  // explicitly excluded with a reason. Silence is the bug.
  for (const n of untrackedOnDisk) {
    if (!ledgerSet.has(n) && !exclSet.has(n)) {
      errors.push(`untracked migration is neither added nor excluded with a reason: ${n}`);
    }
  }

  // Conservation 3: nothing in HEAD may be dropped by accident.
  for (const n of head) {
    if (!proposed.includes(n) && !exclSet.has(n)) {
      errors.push(`HEAD migration disappears from the proposed artifact: ${n}`);
    }
  }

  // Conservation 3b: a guard and the migration it guards must land together.
  errors.push(...guardDropSplitAcrossHead({ disk: onDisk, head }));

  // Conservation 4: the Point-6 inventory must describe exactly what is on disk.
  const invSet = new Set(inventory);
  const inventoryFilesystemMismatch = [
    ...onDisk.filter((n) => !invSet.has(n)).map((n) => `on disk, not in inventory: ${n}`),
    ...inventory.filter((n) => !diskSet.has(n)).map((n) => `in inventory, not on disk: ${n}`),
  ];

  return {
    views: {
      HEAD_ARTIFACT: head,
      SETTLED_WORKTREE: onDisk,
      PROPOSED_RELEASE_ARTIFACT: proposed,
    },
    counts: {
      headArtifact: head.length,
      settledWorktree: onDisk.length,
      proposedReleaseArtifact: proposed.length,
      inventory: inventory.length,
      untrackedOnDisk: untrackedOnDisk.length,
      additionLedger: ledger.length,
      landedAdditions: landed.length,
      proposedAdditions: stillProposed.length,
      proposedExclusions: exclSet.size,
    },
    additions: { landed, proposed: stillProposed, vanished },
    untrackedOnDisk,
    conservationErrors: errors,
    inventoryFilesystemMismatch,
    metrics: {
      MigrationInventoryFilesystemMismatch: inventoryFilesystemMismatch.length,
      ConservationErrors: errors.length,
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const sets = deriveSourceSets();
  const views = buildViews();
  console.log(
    JSON.stringify(
      {
        gitCommit: git("rev-parse", "HEAD").trim(),
        sourceSets: {
          tracked: sets.tracked.size,
          modifiedTracked: sets.modified.size,
          deletedTracked: sets.deleted.size,
          untracked: sets.untracked.size,
        },
        ...views,
      },
      null,
      2,
    ),
  );
}
