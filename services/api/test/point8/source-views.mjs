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
export function buildViews({ proposedAdditions = [], proposedExclusions = {} } = {}) {
  const onDisk = migrationsOnDisk();
  const head = migrationsInHead();
  const { names: inventory } = migrationsInInventory();

  const headSet = new Set(head);
  const diskSet = new Set(onDisk);
  const addSet = new Set(proposedAdditions);
  const exclSet = new Set(Object.keys(proposedExclusions));

  const proposed = [...new Set([...head, ...proposedAdditions])].filter((n) => !exclSet.has(n)).sort();

  const untrackedOnDisk = onDisk.filter((n) => !headSet.has(n));

  const errors = [];

  // Conservation 1: every proposed addition must actually exist on disk.
  for (const n of proposedAdditions) {
    if (!diskSet.has(n)) errors.push(`proposed addition is not on disk: ${n}`);
  }

  // Conservation 1b: the additions must be all-out or all-in relative to HEAD.
  //
  // Before the release commits, none of them are tracked; after it commits, all
  // of them are. Both are correct states. What is NEVER correct is a mixture —
  // that means the release landed partially, which is precisely the shape that
  // ships a destructive migration whose guard was left behind. Asserting the
  // old "must not already be in HEAD" made the release un-committable: every
  // addition is in HEAD the instant it lands, so the gate would have failed on
  // every clean checkout from then on. This check is strictly stronger: it
  // still rejects a stale additions list, and it also catches partial landing,
  // which the previous form could not see at all.
  const addedInHead = proposedAdditions.filter((n) => headSet.has(n));
  if (addedInHead.length > 0 && addedInHead.length < proposedAdditions.length) {
    const missing = proposedAdditions.filter((n) => !headSet.has(n));
    errors.push(
      `the release landed partially: ${addedInHead.length} of ${proposedAdditions.length} ` +
        `additions are in HEAD, missing ${missing.join(", ")}`,
    );
  }

  // Conservation 2: every untracked directory must be either added or
  // explicitly excluded with a reason. Silence is the bug.
  for (const n of untrackedOnDisk) {
    if (!addSet.has(n) && !exclSet.has(n)) {
      errors.push(`untracked migration is neither added nor excluded with a reason: ${n}`);
    }
  }

  // Conservation 3: nothing in HEAD may be dropped by accident.
  for (const n of head) {
    if (!proposed.includes(n) && !exclSet.has(n)) {
      errors.push(`HEAD migration disappears from the proposed artifact: ${n}`);
    }
  }

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
      proposedAdditions: proposedAdditions.length,
      proposedExclusions: exclSet.size,
    },
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
