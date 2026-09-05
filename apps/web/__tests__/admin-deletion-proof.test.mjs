/**
 * THE §21 DELETIONS STAY DELETED, AND THE ARTIFACT STAYS TRUE.
 *
 * ===========================================================================
 * WHY THIS IS A TEST AND NOT JUST A DOCUMENT
 * ===========================================================================
 * §3 required the legacy colour system to be deleted rather than isolated, and
 * `docs/admin/phase7-deletion-proof.md` records nine deletions with zero
 * consumers each. A checked-in table of nine absences is a table that stops
 * being true the first time somebody re-adds one — and the failure mode is
 * silent, because a re-added token WORKS.
 *
 * The generator that produced the table is a set of predicates over the source,
 * so it can simply be run. This asserts two things:
 *
 *   1. every deletion still holds (the generator exits 0);
 *   2. the committed markdown matches what the generator says NOW, so the
 *      document cannot drift from the tree it describes.
 *
 * ===========================================================================
 * WHAT IT ALREADY CAUGHT
 * ===========================================================================
 * The first run reported `--text-muted` alive in `admin-system.css`: the alias
 * had been deleted along with all sixty of its consumers, and the console's own
 * stylesheet still RE-DECLARED it, under a comment asserting a `:root`
 * declaration that no longer existed. The commit that deleted the alias
 * claimed the work was complete. The predicate disagreed, and the predicate
 * was right.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const GENERATOR = resolve(REPO, "scripts/admin-ledger/deletion-proof.mjs");
const ARTIFACT = resolve(REPO, "docs/admin/phase7-deletion-proof.md");

/**
 * spawnSync BLOCKS THE WORKER, so a timeout here cannot fire — the child has
 * to finish before this process can act on anything. Recorded because the
 * opposite was once assumed in this repo: assert the child RAN before
 * asserting what it said, or a spawn failure reads as a passing test.
 */
function run(...args) {
  const r = spawnSync(process.execPath, [GENERATOR, ...args], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(r.error, undefined, `the generator did not run: ${r.error}`);
  assert.notEqual(r.status, null, "the generator was killed rather than exiting");
  return r;
}

test("every §21 deletion still holds", () => {
  const r = run();
  assert.equal(
    r.status,
    0,
    "a deletion regressed — the generator names the file and line:\n" +
      `${r.stdout}${r.stderr}`,
  );
  assert.match(r.stdout, /all \d+ deletions hold/);
});

test("the committed deletion proof is not stale", () => {
  const r = run("--markdown");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const recorded = readFileSync(ARTIFACT, "utf8");
  assert.equal(
    r.stdout.replace(/\r\n/g, "\n").trimEnd(),
    recorded.replace(/\r\n/g, "\n").trimEnd(),
    "docs/admin/phase7-deletion-proof.md is stale. Regenerate:\n" +
      "  node scripts/admin-ledger/deletion-proof.mjs --markdown \\\n" +
      "    > docs/admin/phase7-deletion-proof.md",
  );
});

test("the proof covers the deletions this phase actually made", () => {
  // A proof that shrinks is a proof that passes. This pins the count, so
  // removing a predicate to make the table green fails here instead.
  const src = readFileSync(GENERATOR, "utf8");
  const declared = src.match(/^  \{\n    what:/gm) ?? [];
  assert.ok(
    declared.length >= 9,
    `the deletion proof declares ${declared.length} deletions; it recorded 9`,
  );
});
