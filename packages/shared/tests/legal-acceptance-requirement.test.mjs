/**
 * F-10 — THE ACCEPTANCE REQUIREMENT IS NOT THE DOCUMENT'S REVISION.
 *
 * They are two questions:
 *
 *   "which revision is published?"        LEGAL_DOCUMENT_REVISIONS
 *   "which revision must a user have      REQUIRED_LEGAL_VERSIONS
 *    accepted?"
 *
 * They are equal today, which is exactly why they need two names: a surface
 * that reads one while meaning the other cannot be caught while the values
 * happen to match.
 *
 * The separation deliberately does NOT restore a hand-maintained table. That
 * table is what produced the defect this branch already fixed — three dates in
 * four places, all saying 2026-04-06 while the documents said 2026-06-23, so
 * every acceptance record named a revision that was not the one on screen. The
 * requirement still DERIVES from the corpus; the only way to separate the two
 * is a pin to an EARLIER published revision, and a pin to a later one is
 * refused before anyone is asked to accept anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

import {
  ACCEPTANCE_PINS,
  LEGAL_DOCUMENT_REVISIONS,
  REQUIRED_LEGAL_POLICY_KEYS,
  REQUIRED_LEGAL_VERSIONS,
  acceptanceIsPinnedBehind,
  legalDocumentRevision,
  requiredAcceptanceFor,
} from "../dist/legal.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(HERE, "../src/legal.ts"), "utf8");

test("every gated policy has a published revision and a requirement", () => {
  for (const key of REQUIRED_LEGAL_POLICY_KEYS) {
    assert.match(
      LEGAL_DOCUMENT_REVISIONS[key],
      /^\d{4}-\d{2}-\d{2}$/,
      `${key} has no published revision date`,
    );
    assert.match(REQUIRED_LEGAL_VERSIONS[key], /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(legalDocumentRevision(key), LEGAL_DOCUMENT_REVISIONS[key]);
  }
});

test("nothing is pinned, so the two agree — and they are still two values", () => {
  assert.deepEqual(ACCEPTANCE_PINS, {});
  for (const key of REQUIRED_LEGAL_POLICY_KEYS) {
    assert.equal(REQUIRED_LEGAL_VERSIONS[key], LEGAL_DOCUMENT_REVISIONS[key]);
    assert.equal(acceptanceIsPinnedBehind(key), false);
  }
});

test("the requirement is still DERIVED, never a written-down table", () => {
  // The defect this branch fixed: three dates in four places, two months
  // behind the documents. A literal date beside a policy key in this module
  // would be that table coming back.
  const table = SOURCE.match(/ACCEPTANCE_PINS[^=]*=\s*Object\.freeze\(\{([^}]*)\}\)/);
  assert.ok(table, "ACCEPTANCE_PINS is no longer a frozen literal");
  assert.equal(
    table[1].trim(),
    "",
    "a pin was added; it must be reviewed against the published revision, not merged silently",
  );
});

test("requiredAcceptanceFor answers the REQUIREMENT, for gated slugs only", () => {
  for (const key of REQUIRED_LEGAL_POLICY_KEYS) {
    assert.deepEqual(requiredAcceptanceFor(key), {
      policyKey: key,
      requiredVersion: REQUIRED_LEGAL_VERSIONS[key],
    });
  }
  // A document nobody has to accept has no requirement to report.
  assert.equal(requiredAcceptanceFor("subprocessors"), null);
  assert.equal(requiredAcceptanceFor("not-a-slug"), null);
});

/**
 * Load the real module with `ACCEPTANCE_PINS` replaced.
 *
 * The guard runs at module load, so the only way to see it refuse is to load a
 * module that has something to refuse. Asserting that the source contains a
 * comparison would prove that somebody wrote one, not that it fires.
 */
async function loadWithPins(pins) {
  const built = readFileSync(resolve(HERE, "../dist/legal.js"), "utf8");
  const patched = built.replace(
    /export const ACCEPTANCE_PINS = Object\.freeze\(\{[^}]*\}\);/,
    `export const ACCEPTANCE_PINS = Object.freeze(${JSON.stringify(pins)});`,
  );
  assert.notEqual(patched, built, "ACCEPTANCE_PINS is not where the patch expects it");
  // The module's own relative imports have to resolve, so it is written beside
  // the original rather than loaded from a data URL.
  const tmp = resolve(HERE, `../dist/legal.__pin-probe-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(tmp, patched);
  try {
    return await import(pathToFileURL(tmp).href);
  } finally {
    rmSync(tmp, { force: true });
  }
}

test("a pin LATER than the published revision is refused at module load", async () => {
  // THE ONLY DANGEROUS DIRECTION. A requirement ahead of the document would
  // record a user as having accepted a revision they were never shown, which
  // is the one thing an acceptance record exists to state correctly.
  await assert.rejects(
    () => loadWithPins({ terms: "2099-01-01" }),
    (err) => {
      assert.match(err.message, /later than the published/);
      // The refusal says WHY, not just that a rule was broken.
      assert.match(err.message, /revision the user was never shown/);
      return true;
    },
  );
});

test("a pin that is not a revision date is refused too", async () => {
  await assert.rejects(
    () => loadWithPins({ privacy: "latest" }),
    /not a revision date/,
  );
});

test("a pin to an EARLIER revision is honoured — that is the whole point", async () => {
  // Correcting a typo in a policy should not ask every user in the product to
  // accept it again. This is the case the collapsed value could not express.
  const mod = await loadWithPins({ terms: "2020-01-01" });
  assert.equal(mod.REQUIRED_LEGAL_VERSIONS.terms, "2020-01-01");
  assert.equal(mod.LEGAL_DOCUMENT_REVISIONS.terms, LEGAL_DOCUMENT_REVISIONS.terms);
  assert.notEqual(mod.REQUIRED_LEGAL_VERSIONS.terms, mod.LEGAL_DOCUMENT_REVISIONS.terms);
  assert.equal(mod.acceptanceIsPinnedBehind("terms"), true);
  // And the un-pinned policies are untouched.
  assert.equal(mod.acceptanceIsPinnedBehind("privacy"), false);
  assert.deepEqual(mod.requiredAcceptanceFor("terms"), {
    policyKey: "terms",
    requiredVersion: "2020-01-01",
  });
});
