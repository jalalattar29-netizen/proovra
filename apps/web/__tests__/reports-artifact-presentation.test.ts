/**
 * REPORTS — the title bug, and the presentation rules that replaced the pills.
 *
 * THE BUG THIS PINS
 * ---------------------------------------------------------------------------
 * Every row on /reports read "Untitled evidence". Two layers each coerced a
 * null title to that literal — the aggregator (`r.title ?? "Untitled
 * evidence"`) and the client's user-scoped fallback mapper — so a record whose
 * name lives in `displayFileName` or `originalFileName`, which is the ordinary
 * shape for a capture or an intake upload, could never show it. The Evidence
 * Library has always resolved those through `getDisplayTitle`; Reports was the
 * one list that did not.
 *
 * The substitution is gone from both layers, the fields the cascade needs
 * travel with the row, and the client resolves the name once at render through
 * the SAME cascade every other list uses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { getDisplayTitle } from "../app/(app)/evidence/lib/evidence-library-status";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const INDEX = read("apps/web/components/reports-experience/ReportsIndex.tsx");
const TYPES = read("apps/web/components/reports-experience/types.ts");
const CSS = read("apps/web/components/reports-experience/reports.css");
const AGGREGATOR = read(
  "services/api/src/services/reports/reports-aggregator.service.ts",
);
const USER_ROUTE = read("services/api/src/routes/reports.routes.ts");

// ---------------------------------------------------------------------------
// The title
// ---------------------------------------------------------------------------

test("no layer substitutes the literal 'Untitled evidence' any more", () => {
  for (const [name, body] of [
    ["the aggregator", AGGREGATOR],
    ["the reports client", INDEX],
  ] as const) {
    assert.doesNotMatch(
      body,
      /title:\s*[\w.]+\s*\?\?\s*"Untitled evidence"/,
      `${name} still coerces a null title to the literal fallback`,
    );
  }
});

test("both report sources carry the inputs the title cascade needs", () => {
  // Selecting `title` alone is what made the fallback unavoidable: the name
  // simply was not in the payload.
  for (const [name, body] of [
    ["the aggregator", AGGREGATOR],
    ["the user-scoped route", USER_ROUTE],
  ] as const) {
    for (const field of ["displayFileName", "originalFileName", "mimeType"]) {
      assert.match(
        body,
        new RegExp(`${field}: true`),
        `${name} must select ${field} for the title cascade`,
      );
    }
  }
});

test("the wire type keeps the stored title nullable, not pre-substituted", () => {
  for (const field of ["title", "displayFileName", "originalFileName"]) {
    assert.match(
      TYPES,
      new RegExp("\\n {2}" + field + ": string \\| null;"),
      "the wire type must keep " + field + " nullable, not pre-substituted",
    );
  }
});

test("the row resolves its name through the canonical cascade", () => {
  assert.match(
    INDEX,
    /import \{ getDisplayTitle \} from ".*evidence-library-status"/,
    "Reports must reuse the Evidence Library cascade, not write a second one",
  );
  assert.match(INDEX, /getDisplayTitle\(\{[\s\S]{0,240}displayFileName: row\.displayFileName/);
});

test("BEHAVIOUR: a stored title wins, and distinct records stay distinct", () => {

  const row = (over: Record<string, unknown>) =>
    getDisplayTitle({
      id: "11111111-1111-4111-8111-111111111111",
      title: null,
      displayFileName: null,
      originalFileName: null,
      type: "DOCUMENT",
      mimeType: "application/pdf",
      itemCount: null,
      ...over,
    } as never);

  // A real title is used EXACTLY, never decorated.
  assert.equal(
    row({ title: "Joint Scene Examination by Fire Investigators.jpg" }),
    "Joint Scene Examination by Fire Investigators.jpg",
  );

  // Fallback ONLY where the title is genuinely absent — and the filename is
  // the next real name, not a sentinel.
  assert.equal(
    row({ title: null, displayFileName: "scene-04.jpg" }),
    "scene-04.jpg",
  );
  assert.equal(
    row({ title: null, originalFileName: "IMG_2291.HEIC" }),
    "IMG_2291.HEIC",
  );

  // Distinct records stay distinct — the failure mode was N rows collapsing
  // onto one string.
  const names = [
    row({ title: "Alpha statement" }),
    row({ title: "Bravo statement" }),
    row({ title: null, displayFileName: "charlie.pdf" }),
    row({ title: null, originalFileName: "delta.pdf" }),
  ];
  assert.equal(new Set(names).size, 4, `collapsed: ${names.join(" | ")}`);
  for (const n of names) assert.notEqual(n, "Untitled evidence");
});

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

test("report and package states are TEXT, not capsules", () => {
  // `app-status-badge` is the pill primitive. The two lifecycle states must not
  // wear it; the row had four chips on one line and no hierarchy.
  const rowBlock = INDEX.slice(
    INDEX.indexOf("function ArtifactRowView"),
    INDEX.indexOf("function ArtifactRowActions"),
  );
  assert.doesNotMatch(
    rowBlock,
    /className="app-status-badge"[\s\S]{0,200}data-reports-report-state/,
    "the report state must not render as a badge",
  );
  assert.doesNotMatch(
    rowBlock,
    /className="app-status-badge"[\s\S]{0,200}data-reports-package-state/,
    "the package state must not render as a badge",
  );
  assert.match(rowBlock, /className="rpt-status"/);
  // …and the text style really is background-free.
  assert.match(CSS, /\.rpt-status \{[\s\S]*?background: none;/);
});

test("integrity says the word once", () => {
  // `RECORDED_INTEGRITY_VERIFIED` humanised under a label that already said
  // "Integrity" produced "Integrity Recorded Integrity Verified".
  assert.match(INDEX, /Integrity: \{integrityLabel\(row\.verificationStatus\)\}/);
  assert.doesNotMatch(INDEX, /Integrity \{humanize\(row\.verificationStatus\)\}/);
});

test("the case relationship is canonical blue, and not a badge", () => {
  assert.match(CSS, /\.rpt-row__case \{[\s\S]*?color: var\(--tone-blue\);/);
  assert.doesNotMatch(INDEX, /data-reports-case-link[\s\S]{0,160}#6D28D9/);
});

test("the summary strip maps every counter to a tone, and the number wears it", () => {
  const fields = [
    "reportsReady",
    "reportsPending",
    "packagesReady",
    "packagesPending",
    "packagesBlocked",
    "totalEvidenceWithArtifacts",
  ];
  for (const f of fields) {
    assert.match(INDEX, new RegExp(`field: "${f}"`), `${f} has no summary card`);
  }
  // The value takes the card's tone — not a flat ink colour, which is what
  // made six coloured rails read as decoration.
  assert.match(CSS, /\.rpt-metric__value \{\s*color: var\(--rpt-tone/);
});

test("the header carries the canonical title icon and no Search-reports button", () => {
  assert.match(INDEX, /className="app-title-row"/);
  assert.match(INDEX, /data-reports-title-icon/);
  assert.doesNotMatch(INDEX, /Search reports/);
  assert.doesNotMatch(INDEX, /documentType=REPORT/);
});

test("the duplicated workspace strip is gone", () => {
  assert.doesNotMatch(INDEX, /<WorkspaceContextBanner/);
  // The help surface is real and stays.
  assert.match(INDEX, /<ContextualHelp surface="reports"/);
});

test("a refresh does not tear the page down — that was the typing lag", () => {
  // `setState({ status: "loading" })` on every debounced keystroke unmounted
  // the page (the render returns a skeleton for that status), taking the
  // search input and its focus with it.
  assert.doesNotMatch(
    INDEX,
    /if \(!workspaceId\) return;\s*setState\(\{ status: "loading" \}\);/,
    "an unconditional loading swap remounts the search input mid-word",
  );
  assert.match(
    INDEX,
    /prev\.status === "ready" \? prev : \{ status: "loading" \}/,
    "results already on screen must survive a reload",
  );
});

test("filters keep their canonical chip component and every state", () => {
  for (const key of [
    "all",
    "report_ready",
    "report_pending",
    "package_ready",
    "package_pending",
    "package_blocked",
  ]) {
    assert.match(
      INDEX,
      new RegExp(`"${key}"`),
      `the ${key} filter must still exist`,
    );
  }
  assert.match(INDEX, /cases-filter-chip/);
});
