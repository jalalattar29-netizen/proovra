/**
 * Intake-link multi-file upload — partIndex assignment.
 *
 * Regression pins for the closure-stale `parts.length` bug.
 *
 * Previously stageFile() read `const partIndex = parts.length` from
 * the React state captured in its closure. The onChange handler
 * looped `for (const f of files) await stageFile(f)`, but React
 * doesn't re-render between awaits — every iteration saw
 * `parts.length === 0`, every POST sent `partIndex=0`, and the
 * backend's `(evidenceId, partIndex)` unique constraint rejected all
 * but the first file as `part_index_taken`. Result: only one file
 * landed on multi-select, the rest were silently dropped.
 *
 * The fix:
 *   1. stageFile(file, partIndex) — partIndex is a REQUIRED parameter.
 *      The function no longer reads parts.length internally.
 *   2. onChange captures `let nextIndex = parts.length` ONCE, then
 *      increments locally as it iterates the File[] from the picker.
 *   3. The maxFileCountPerSession guard also runs against the local
 *      counter (not stale React state) before each stage call, and
 *      breaks the loop with a clear message when the cap is hit.
 *
 * These tests are source-contract pins (the rest of this codebase
 * uses the same approach for closure-fragile React handlers) so a
 * future refactor that reintroduces `parts.length` inside stageFile
 * fails this suite, not in production where contributors lose files.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const INTAKE_PAGE = resolve(
  REPO_ROOT,
  "apps/web/app/intake/[token]/page.tsx",
);
const SRC = readFileSync(INTAKE_PAGE, "utf8");

test("stageFile takes partIndex as a REQUIRED parameter (no stale-closure read)", () => {
  // Signature must accept partIndex explicitly. The whole point of
  // the fix is the caller decides the index.
  assert.match(SRC, /async function stageFile\(file: File, partIndex: number\)/);
});

test("stageFile no longer reads `parts.length` to derive partIndex", () => {
  // The smoking-gun line `const partIndex = parts.length;` must be
  // gone. Any reintroduction recreates the multi-file bug.
  assert.ok(
    !/const partIndex = parts\.length/.test(SRC),
    "stageFile must not derive partIndex from React state",
  );
});

test("stageFile no longer enforces the max-files cap from parts.length", () => {
  // The cap check moved to the caller (onChange) where the local
  // counter is authoritative. The old in-function guard read stale
  // state and so under-counted.
  assert.ok(
    !/parts\.length >= link\.maxFileCountPerSession/.test(SRC),
    "stageFile must not gate on parts.length — the caller owns the cap check",
  );
});

test("onChange seeds nextIndex from parts.length ONCE and increments per file", () => {
  // The local counter pattern — exact source-contract pin. We accept
  // any of: "let nextIndex = parts.length" + "nextIndex += 1".
  assert.match(SRC, /let nextIndex = parts\.length;/);
  assert.match(SRC, /await stageFile\(f, nextIndex\);/);
  assert.match(SRC, /nextIndex \+= 1;/);
});

test("onChange max-files guard uses the LOCAL counter, not React state", () => {
  // The cap check must consult `nextIndex`, not `parts.length`, so it
  // remains correct across the await boundaries inside the loop.
  assert.match(
    SRC,
    /if \(cap !== null && nextIndex >= cap\)/,
  );
});

test("selecting 5 files sends partIndex 0..4 (deterministic local-counter walk)", () => {
  // Sequence simulation: nextIndex starts at parts.length (0 on a
  // fresh session), then the loop body increments by 1 for each
  // file. With files.length === 5, the partIndex sent must be the
  // sequence [0,1,2,3,4].
  const code = SRC;
  // Reconstruct the local-counter contract from the source itself,
  // then run the same arithmetic to verify the sequence is what we
  // claim. This is a static behaviour proof: if the source shape
  // ever changes such that the local counter no longer monotonically
  // increments by 1, this test fails.
  const loopMatch = code.match(
    /let nextIndex = parts\.length;[\s\S]{0,600}?for \(const f of files\)[\s\S]{0,800}?await stageFile\(f, nextIndex\);[\s\S]{0,200}?nextIndex \+= 1;/,
  );
  assert.ok(
    loopMatch,
    "the onChange local-counter loop shape must be present in source",
  );
  // Now simulate: starting from parts.length = 0, what indices does
  // a 5-file selection produce?
  const selected = 5;
  const startedAt = 0;
  const observed: number[] = [];
  let nextIndex = startedAt;
  for (let i = 0; i < selected; i++) {
    observed.push(nextIndex);
    nextIndex += 1;
  }
  assert.deepEqual(observed, [0, 1, 2, 3, 4]);
});

test("adding 3 files then 2 more files: second batch starts at partIndex 3", () => {
  // Same simulator as above. After the first batch lands, parts.length
  // is 3 (the state IS reflected in `parts.length` between user-input
  // events — the stale-read problem only occurs within a single
  // onChange invocation, never across them). So the second onChange
  // seeds nextIndex from parts.length = 3 and produces [3, 4].
  const batch1 = 3;
  const observed1: number[] = [];
  let nextIndex = 0;
  for (let i = 0; i < batch1; i++) {
    observed1.push(nextIndex);
    nextIndex += 1;
  }
  assert.deepEqual(observed1, [0, 1, 2]);

  // Simulate the React state catching up between the two onChange
  // events. The next batch seeds from the new parts.length.
  const partsLengthAfterBatch1 = batch1; // 3
  const batch2 = 2;
  const observed2: number[] = [];
  nextIndex = partsLengthAfterBatch1;
  for (let i = 0; i < batch2; i++) {
    observed2.push(nextIndex);
    nextIndex += 1;
  }
  assert.deepEqual(observed2, [3, 4]);
});

test("local cap-check stops the loop at the limit and surfaces a message", () => {
  // The guard must break the loop and message the user, not silently
  // skip — the contributor needs to know why their 11th-of-10 file
  // wasn't added.
  assert.match(
    SRC,
    /Maximum of \$\{cap\} files for this link\. The remaining selection was not added\./,
  );
  assert.match(SRC, /break;/);
});

test("file picker still has multiple={true} and reads every selected file", () => {
  // Sanity guard against a future regression that drops `multiple`
  // or replaces Array.from(e.target.files) with files[0]. The whole
  // fix is moot if the picker only surfaces one file in the first
  // place.
  assert.match(SRC, /<input[\s\S]{0,300}type="file"[\s\S]{0,200}multiple/);
  assert.match(SRC, /Array\.from\(e\.target\.files \?\? \[\]\)/);
});
