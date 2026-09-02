/**
 * THE COMPLETION LEDGER CANNOT LIE BY OMISSION OR BY ADJECTIVE.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * Two failure modes have already happened on this surface, and the ledger is
 * only worth having if both are impossible:
 *
 *   OMISSION.  "47/47 on the shared shell" was reported while ten routes had
 *              never been opened. A hand-written table would have had 37 rows
 *              and looked complete. The rows therefore come from the FILE
 *              TREE, and this test asserts the ledger covers every route on
 *              disk and names none that is not.
 *
 *   ADJECTIVE. "shell applied", "returns 200", "covered by parent" were each
 *              used to describe a page nobody had looked at. The status
 *              vocabulary is four words, and a completed status is rejected
 *              unless every required proof names an artefact.
 *
 * The ledger is regenerated here rather than parsed from the committed
 * markdown, so a stale checked-in file fails instead of passing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REPO = process.cwd();
const LEDGER = resolve(REPO, "docs/admin/admin-control-plane-completion.md");

function run(...args) {
  try {
    return {
      status: 0,
      out: execFileSync(
        process.execPath,
        [resolve(REPO, "scripts/admin-ledger/generate.mjs"), ...args],
        { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      ),
    };
  } catch (err) {
    return { status: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("the ledger validates", () => {
  const r = run("--check");
  assert.equal(r.status, 0, `ledger validation failed:\n${r.out}`);
});

test("every route on disk has a row, and no row names a missing route", () => {
  // The omission failure mode, closed structurally. `--check` already asserts
  // there are no orphan rows; this asserts the count matches the tree, which
  // is the other half.
  const onDisk = execFileSync(
    process.execPath,
    ["-e", `const {readdirSync}=require("node:fs");const {join}=require("node:path");
      let n=0;(function w(d){for(const e of readdirSync(d,{withFileTypes:true})){
        const p=join(d,e.name);
        if(e.isDirectory())w(p); else if(e.name==="page.tsx")n++;}})("apps/web/app/(app)/admin");
      console.log(n);`],
    { cwd: REPO, encoding: "utf8" },
  ).trim();

  const r = run("--check");
  const m = /^(\d+) routes/m.exec(r.out);
  assert.ok(m, `could not read the route count from:\n${r.out}`);
  assert.equal(
    m[1],
    onDisk,
    "the ledger and the file tree disagree about how many admin pages exist",
  );
});

test("the committed markdown is not stale", () => {
  assert.ok(existsSync(LEDGER), "the ledger markdown has not been generated");
  const before = readFileSync(LEDGER, "utf8");
  run();
  const after = readFileSync(LEDGER, "utf8");
  assert.equal(
    after,
    before,
    "docs/admin/admin-control-plane-completion.md is stale — run scripts/admin-ledger/generate.mjs",
  );
});

test("the status vocabulary stays four words", () => {
  // Widening it is how "deferred" comes back.
  const src = readFileSync(
    resolve(REPO, "scripts/admin-ledger/generate.mjs"),
    "utf8",
  );
  const block = /export const VALID_STATUSES = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src);
  assert.ok(block, "VALID_STATUSES not found");
  // [A-Z0-9_] and not [A-Z_]: E2E has a digit in it, and the first version of
  // this line split CONTEXTUAL_DETAIL_REDESIGNED_AND_E2E_VERIFIED in two.
  const statuses = [...block[1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(statuses.sort(), [
    "CONTEXTUAL_DETAIL_REDESIGNED_AND_E2E_VERIFIED",
    "NO_INTERNAL_RECOMPOSITION_REQUIRED",
    "PENDING",
    "REDESIGNED_AND_E2E_VERIFIED",
  ]);
});

test("a completed status without its proofs is rejected", () => {
  // The adjective failure mode, EXERCISED rather than asserted about.
  //
  // A first version of this case tried to import the generator and call
  // validate() directly. The generator does its work at module scope, so
  // importing it runs the whole thing — a module that acts on import cannot be
  // unit-tested by importing it. Hence `--evidence=`, which points the CLI at
  // a throwaway file and never writes the committed markdown.
  const bad = resolve(tmpdir(), `ledger-bad-${process.pid}.json`);
  writeFileSync(
    bad,
    JSON.stringify({
      "/admin/costs": {
        family: "Commercial",
        status: "REDESIGNED_AND_E2E_VERIFIED",
        statusReason: "looks fine",
        proofs: {},
      },
    }),
    "utf8",
  );
  try {
    const r = run("--check", `--evidence=${bad}`);
    assert.equal(r.status, 1, "a proofless completed status must be rejected");
    for (const proof of ["desktop", "mobile", "rtl", "states", "authorization", "contract"]) {
      assert.match(
        r.out,
        new RegExp(`/admin/costs: claims REDESIGNED_AND_E2E_VERIFIED without ${proof} proof`),
        `the ${proof} proof must be required`,
      );
    }
  } finally {
    rmSync(bad, { force: true });
  }
});

test("the committed markdown is untouched by a test run", () => {
  // --evidence= must never write. If it did, the case above would silently
  // corrupt the real ledger every time the suite ran.
  const before = readFileSync(LEDGER, "utf8");
  const bad = resolve(tmpdir(), `ledger-bad2-${process.pid}.json`);
  writeFileSync(bad, "{}", "utf8");
  try {
    run(`--evidence=${bad}`);
    assert.equal(readFileSync(LEDGER, "utf8"), before);
  } finally {
    rmSync(bad, { force: true });
  }
});

test("PENDING routes are reported, not hidden", () => {
  const r = run("--check");
  assert.match(
    r.out,
    /\d+ routes · \d+ completed · \d+ pending/,
    "the ledger must always state how much is unfinished",
  );
});

test("--require-complete fails while anything is PENDING", () => {
  // The release gate. It is expected to FAIL today, and that is the point:
  // this asserts the gate can still say no.
  const r = run("--check", "--require-complete");
  const summary = /(\d+) pending/.exec(r.out);
  assert.ok(summary, `no summary in:\n${r.out}`);
  if (Number(summary[1]) > 0) {
    assert.equal(r.status, 1, "--require-complete must fail while routes are PENDING");
    assert.match(r.out, /NOT COMPLETE/);
  } else {
    assert.equal(r.status, 0);
  }
});
