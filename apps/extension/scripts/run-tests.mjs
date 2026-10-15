/**
 * RUN THE EXTENSION'S UNIT TESTS ON ANY SUPPORTED NODE.
 *
 * The script used to be `node --test "test/*.test.mjs"`. Node 22+ expands that
 * glob itself, so it passed on a developer machine — and Node 20, which is
 * what CI pins, does not: it looked for a file literally named `*.test.mjs`,
 * found none, and exited 1. These 21 tests had never run in CI, and the first
 * run of the new job is what said so.
 *
 * `node --test test/` is not the fix either. That walks the directory and
 * treats `test/dist/*.js` — the compiled modules the tests IMPORT, written by
 * build-test.mjs — as test files, executing their top level and reporting four
 * modules as four passing tests.
 *
 * So the files are enumerated explicitly: only `*.test.mjs`, only at the top
 * level of `test/`, in sorted order, and the count is asserted so an empty
 * discovery is a failure rather than a green run of nothing.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { tapVerdict } from "./run-tests-verdict.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const testDir = resolve(here, "..", "test");

const files = readdirSync(testDir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".test.mjs"))
  .map((e) => join(testDir, e.name))
  .sort();

if (files.length === 0) {
  console.error("no *.test.mjs files found in test/ — refusing to report success");
  process.exit(1);
}

console.log(`running ${files.length} test files on ${process.version}`);
// `node --test` exits 0 when tests are skipped or marked todo. A skipped test
// proves nothing, so the TAP summary is read and any skip or todo fails the run.
const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
process.stdout.write(r.stdout ?? "");
process.stderr.write(r.stderr ?? "");
if (r.status !== 0) process.exit(r.status ?? 1);
const verdict = tapVerdict(r.stdout ?? "");
if (!verdict.ok) {
  console.error(verdict.reason);
  process.exit(1);
}
