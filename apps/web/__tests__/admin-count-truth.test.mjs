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

/**
 * A count may never quietly get LESS honest. The sites below each state an
 * exact total, a declared complete list, or an open-ended "the server has
 * more" — the reviewed minimum an operator is told. Falling to a disclosed
 * cap (or worse) still exits 0 from the audit, so it is pinned here as a
 * product contract. Raising a site is free; lowering one, or removing a site,
 * means editing this table on purpose.
 */
const TRUTH_RANK = { LOADED_ONLY: 0, CAP_DISCLOSED: 1, SERVER_HAS_MORE: 2, EXACT_TOTAL: 3, COMPLETE_LIST: 3 };
const REVIEWED_MINIMUM = {
  "/admin/adoption | ResultCount | capability": "COMPLETE_LIST",
  "/admin/alerts | ResultCount | alert": "SERVER_HAS_MORE",
  "/admin/audit | ResultCount | audit entry": "SERVER_HAS_MORE",
  "/admin/audit | inline | row(s) loaded in this vi": "SERVER_HAS_MORE",
  "/admin/contact-sales | ResultCount | inquiry": "EXACT_TOTAL",
  "/admin/operations | ResultCount | security event": "SERVER_HAS_MORE",
  "/admin/platform/media-graph | ResultCount | run": "SERVER_HAS_MORE",
  "/admin/platform/observability | ResultCount | non-zero signal": "EXACT_TOTAL",
  "/admin/platform/queues | ResultCount | failed job": "EXACT_TOTAL",
  "/admin/platform/runbooks | inline | runbook": "EXACT_TOTAL",
  "/admin/platform/signers | ResultCount | attestation": "EXACT_TOTAL",
  "/admin/provisioning | ResultCount | pending invitation": "EXACT_TOTAL",
  "/admin/support-access | ResultCount | support grant": "EXACT_TOTAL",
  "/operations/automation | ResultCount | rule": "COMPLETE_LIST",
  "/operations/automation | ResultCount | run": "EXACT_TOTAL",
  "/security-center/identity | ResultCount | member": "COMPLETE_LIST",
  "/security-center/identity/permission-matrix | ResultCount | role": "COMPLETE_LIST",
  "/security-center/identity/runtime | ResultCount | quarantined session": "SERVER_HAS_MORE",
  "/security-center/identity/runtime | ResultCount | session": "SERVER_HAS_MORE",
  "/security-center/identity/scim | ResultCount | sync failure": "EXACT_TOTAL",
  "/security-center/identity/sessions | ResultCount | held session": "SERVER_HAS_MORE",
  "/security-center/identity/sessions | ResultCount | session": "SERVER_HAS_MORE",
  "/security-center/identity/timeline | ResultCount | event": "SERVER_HAS_MORE",
  "/security-center/posture | ResultCount | MFA event": "SERVER_HAS_MORE",
  "/security-center/posture | ResultCount | recovery event": "SERVER_HAS_MORE",
  "/security-center/posture | ResultCount | security event": "SERVER_HAS_MORE",
};

test("no reviewed count site is downgraded below what it tells the operator", () => {
  const live = liveClassification();
  const best = new Map();
  for (const s of live.sites) {
    const key = `${s.route} | ${s.kind} | ${s.noun}`;
    assert.ok(s.truth in TRUTH_RANK, `${key}: unknown truth class ${s.truth}`);
    best.set(key, Math.max(best.get(key) ?? -1, TRUTH_RANK[s.truth]));
  }
  for (const [key, minimum] of Object.entries(REVIEWED_MINIMUM)) {
    assert.ok(best.has(key), `${key}: the reviewed count site is no longer found by the audit`);
    assert.ok(
      best.get(key) >= TRUTH_RANK[minimum],
      `${key}: now states less than ${minimum}`,
    );
  }
});

test("every COMPLETE_LIST count is backed by a declaration", () => {
  const live = liveClassification();
  const declared = new Set((live.completeListDeclarations ?? []).map((d) => d.route));
  const complete = live.sites.filter((s) => s.truth === "COMPLETE_LIST");
  assert.ok(complete.length > 0, "the audit credited no COMPLETE_LIST site");
  for (const s of complete) {
    assert.ok(declared.has(s.route), `${s.route} claims a complete list with no declaration`);
  }
});
