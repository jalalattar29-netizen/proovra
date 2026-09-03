/**
 * THE COUNT AUDIT IS A GATE, NOT A SCRIPT SOMEBODY REMEMBERS TO RUN.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * `scripts/admin-count-truth-audit.mjs` classifies every number an admin page
 * renders by what stands behind it, and exits non-zero when one has nothing.
 * It found five pages presenting a capped read as a population — including two
 * carrying a written comment saying there was no server cap while the request
 * sent `limit=50` on every call.
 *
 * A script with that result is worth exactly as much as the frequency someone
 * runs it. The composition contract next to it was in the same position: a
 * real instrument, wired to nothing. Both run here, so a new page that prints
 * `rows.length` fails the suite rather than shipping.
 *
 * ===========================================================================
 * WHY THE COMMITTED JSON IS CHECKED TOO
 * ===========================================================================
 * The exit code answers "is anything unbacked". It does not answer "did the
 * classification of an existing site change" — a page that quietly drops
 * `total={…}` and falls back to a disclosed cap still exits 0, because a cap
 * is honest. That is a real regression in what the operator is told, and only
 * a diff against the recorded state shows it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(WEB, "../..");
const ARTIFACT = resolve(REPO, "docs/admin/evidence/count-truth-audit.json");

function run(script, ...args) {
  try {
    return {
      status: 0,
      out: execFileSync(process.execPath, [resolve(WEB, script), ...args], {
        cwd: REPO,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    };
  } catch (err) {
    return {
      status: err.status ?? 1,
      out: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

test("every count an admin page renders has a source of truth", () => {
  const r = run("scripts/admin-count-truth-audit.mjs");
  assert.equal(
    r.status,
    0,
    `a count is being shown with nothing behind it:\n${r.out}`,
  );
});

test("every admin list still meets the composition contract", () => {
  // Same reasoning: a correct instrument nobody runs is not a gate.
  const r = run("scripts/admin-composition-contract.mjs");
  assert.equal(r.status, 0, `composition contract failed:\n${r.out}`);
});

test("the recorded classification of every count site is current", () => {
  const r = run("scripts/admin-count-truth-audit.mjs", "--json");
  assert.equal(r.status, 0, r.out);

  const live = JSON.parse(r.out);
  const recorded = JSON.parse(readFileSync(ARTIFACT, "utf8"));

  // `generatedAt` is deliberately absent from both — a timestamp would make
  // this file conflict on every run and teach the next person to regenerate
  // without reading the diff.
  assert.deepEqual(
    live,
    recorded,
    "docs/admin/evidence/count-truth-audit.json is stale.\n" +
      "Regenerate it and READ THE DIFF — a site moving from EXACT_TOTAL to\n" +
      "CAP_DISCLOSED still exits 0 and is still a regression in what the\n" +
      "operator is told:\n" +
      "  node apps/web/scripts/admin-count-truth-audit.mjs --json \\\n" +
      "    > docs/admin/evidence/count-truth-audit.json",
  );
});

test("the readable audit matches the machine one", () => {
  // Two artifacts, one source. A hand-maintained table of 17 call sites is a
  // table that is wrong within a month — the capability map in this repo is
  // 176 rows wrong for exactly that reason.
  const r = run("scripts/admin-count-truth-audit.mjs", "--markdown");
  assert.equal(r.status, 0, r.out);
  const recorded = readFileSync(
    resolve(REPO, "docs/admin/count-truth-audit.md"),
    "utf8",
  );
  assert.equal(
    r.out.replace(/\r\n/g, "\n").trimEnd(),
    recorded.replace(/\r\n/g, "\n").trimEnd(),
    "docs/admin/count-truth-audit.md is stale. Regenerate:\n" +
      "  node apps/web/scripts/admin-count-truth-audit.mjs --markdown \\\n" +
      "    > docs/admin/count-truth-audit.md",
  );
});

test("no site is recorded as unbacked", () => {
  // The artifact is checked in, so this reads as documentation of the current
  // state as much as an assertion about it.
  const recorded = JSON.parse(readFileSync(ARTIFACT, "utf8"));
  const unbacked = recorded.sites.filter((s) => s.truth === "LOADED_ONLY");
  assert.deepEqual(unbacked, [], "unbacked count sites are recorded as fixed");
});

test("every complete-list declaration names an endpoint and a reason", () => {
  // The declaration is the ONE place the audit accepts "trust me". It is only
  // worth anything if it says what is being trusted and where the proof lives
  // — services/api/test/admin-count-truth-complete-lists.test.ts asserts the
  // handler side.
  const recorded = JSON.parse(readFileSync(ARTIFACT, "utf8"));
  for (const d of recorded.completeListDeclarations ?? []) {
    assert.match(d.endpoint, /^(GET|POST) \/v1\//, "declaration names a route");
    assert.ok(d.reason.length > 40, `${d.endpoint} states why it is complete`);
    assert.ok(d.route.startsWith("/admin/"), "declaration names the page");
  }
});
