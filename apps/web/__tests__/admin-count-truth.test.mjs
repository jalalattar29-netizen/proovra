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
 * real instrument, wired to nothing. Both run here, against the current
 * source, so a new page that prints `rows.length` fails the suite rather than
 * shipping.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(WEB, "../..");

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

function liveClassification() {
  const r = run("scripts/admin-count-truth-audit.mjs", "--json");
  assert.equal(r.status, 0, r.out);
  return JSON.parse(r.out);
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

test("no count site is classified as unbacked", () => {
  const live = liveClassification();
  assert.ok(live.sites.length > 0, "the audit scanned no count sites");
  const unbacked = live.sites.filter((s) => s.truth === "LOADED_ONLY");
  assert.deepEqual(unbacked, [], "a count site prints a bare length");
});

test("every complete-list declaration names an endpoint and a reason", () => {
  // The declaration is the ONE place the audit accepts "trust me". It is only
  // worth anything if it says what is being trusted and where the proof lives
  // — services/api/test/admin-count-truth-complete-lists.test.ts asserts the
  // handler side.
  const live = liveClassification();
  for (const d of live.completeListDeclarations ?? []) {
    assert.match(d.endpoint, /^(GET|POST) \/v1\//, "declaration names a route");
    assert.ok(d.reason.length > 40, `${d.endpoint} states why it is complete`);
    // The page a declaration vouches for may live outside /admin (several
    // administrative pages live in their tenant homes and the audit scans
    // them there). "Names the page" is therefore checked against what the
    // audit actually SCANNED: the declared page must carry a count site the
    // audit credited as COMPLETE_LIST. A declaration for a page the scan never
    // reached, or one whose count is not the declared kind, vouches for
    // nothing.
    assert.ok(
      live.sites.some(
        (s) => s.route === d.route && s.truth === "COMPLETE_LIST",
      ),
      `declaration for ${d.route} names a scanned page carrying a COMPLETE_LIST count`,
    );
  }
});
