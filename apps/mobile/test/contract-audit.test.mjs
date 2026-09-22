/**
 * THE GATE F-09 AND THE INTAKE SUBMISSIONS DEFECT BOTH WALKED THROUGH.
 *
 * Every other test in this directory checks that a pure function behaves as
 * its author intended. None of them could catch a parser reading the wrong
 * envelope key, because the fixture was written from the same understanding as
 * the code: `parseLegalNotes` read `notes`, its fixture sent `notes`, and the
 * route has always sent `{ items }`. Two surfaces shipped unable to display a
 * single row with 2156 assertions passing.
 *
 * This one does not read fixtures. It reads the server: every place the app
 * hands a fetched response to a parser, matched to the handler in
 * services/api/src/routes that answers that path, and compared key for key.
 *
 * A MISMATCH is a screen that cannot show real data. An UNRESOLVED row or an
 * unbound parser call is not a pass either - it is the tool admitting it did
 * not look, and a matrix with holes in it is how this was missed the first
 * time. All four counts must be zero.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { audit, writeMarkdown } from "../tools/contract-audit.mjs";

const result = audit();

test("every parsed response matches the envelope its route sends", () => {
  const bad = result.rows.filter((r) => r.verdict === "MISMATCH");
  assert.deepEqual(
    bad.map((r) => `${r.parser} <- ${r.route}: ${r.why}`),
    [],
  );
});

test("no contract is excused because the tool could not read it", () => {
  const unresolved = result.rows.filter((r) => r.verdict === "UNRESOLVED");
  assert.deepEqual(
    unresolved.map((r) => `${r.parser} (${r.builder}): ${r.why}`),
    [],
  );
});

test("every parser that is handed a response is bound to its route", () => {
  assert.deepEqual(
    result.unbound.map((u) => `${u.site} ${u.parser}: ${u.why}`),
    [],
  );
});

test("the audit is actually looking at the whole app", () => {
  // A tool that quietly stopped finding call sites would report a clean matrix
  // over nothing at all, which is the failure this file exists to prevent.
  assert.ok(
    result.rows.length >= 70,
    `only ${result.rows.length} parser/route bindings found; the walker has probably stopped matching a call shape`,
  );
  assert.equal(result.counts.OK, result.rows.length);
});

test("the two defects that motivated this gate are covered by it", () => {
  // Not "do these pass" - whether they are IN the matrix at all. Both were
  // invisible to it before the binder learned the shapes their screens use.
  const covered = new Set(result.rows.map((r) => r.parser));
  for (const parser of ["parseLegalNotes", "parseAnnotations", "parseIntakeSubmissions"]) {
    assert.ok(covered.has(parser), `${parser} is not covered by the contract audit`);
  }
});

test("the committed matrix is the one this audit produces", () => {
  // The same generate-and-guard shape as domain-enums.generated.ts: the
  // document beside the code is regenerated and compared, so a matrix cannot
  // sit in the repository claiming coverage the tool no longer finds.
  const committed = readFileSync(new URL("../docs/contract-coverage.md", import.meta.url), "utf8");
  const regenerated = readFileSync(writeMarkdown(result), "utf8");
  assert.equal(
    committed,
    regenerated,
    "docs/contract-coverage.md is stale — run `node tools/contract-audit.mjs --json`",
  );
});
