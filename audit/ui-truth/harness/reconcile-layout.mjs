/**
 * PHASE UI-TRUTH — reconcile the layout classification with the re-measurement.
 *
 * The classification was produced against the failures measured at e341e5be.
 * The audit re-measured on the audited SHA and got a set that differs by three
 * tests. This pass re-keys every classified row by (project, spec:line, title)
 * — indices move, identities do not — carries the classification across,
 * classifies what is new, and records what no longer fails.
 *
 * It ABORTS unless the result covers the current measurement exactly.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { REPO } from "./surfaces.mjs";

const DATA = join(REPO, "audit", "ui-truth", "data");
const current = JSON.parse(readFileSync(join(DATA, "layout-failures-current.json"), "utf8"));
const prior = JSON.parse(readFileSync(join(DATA, "layout-failures-prior.json"), "utf8"));
const classification = JSON.parse(readFileSync(join(DATA, "layout-classification.json"), "utf8"));

const key = (f) => `${f.project}|${f.spec}:${f.specLine}|${f.title}`;
const classified = new Map(classification.rows.map((r) => [key(r), r]));

/**
 * Failures the re-measurement produced that the classification never saw.
 * Each is classified here, with its own evidence, exactly like the rest.
 */
const NEW_ROWS = {
  "search-layout|e2e/search-layout/case-copilot-layout.spec.ts:494|evidence selection is reachable › the fixture is contract-shaped, and the authority agrees": {
    classification: "FIXTURE_DEFECT",
    rationale:
      "The test asserts the shape of the spec's OWN fixture generator, not the product: it requires every generated record to carry an analysisRevision matching /^ear1_[A-Za-z0-9_-]{43}$/, and the first generated record carries a placeholder id instead. It fails in 2ms while the five product-facing siblings in the same describe block (Select all, Clear, individual selection, ineligible refusal) all pass.",
    evidence: [
      "e2e/search-layout/case-copilot-layout.spec.ts:494-500 — the assertion is over evidenceItems(14), the spec's own helper",
      "scratchpad/uit-layout.log — test 209 fails in 2ms with 'Error: e0000000-0000-4000-8000-000000000000'; tests 210-213 in the same block pass",
    ],
    affectedRoute: "/cases/[id]",
    severityIfReal: null,
    visibleInProductionRendering: false,
    visibilityReason:
      "The assertion never renders a product surface; it checks the generator that feeds the other tests, and those tests pass.",
    groupKey: "SEARCH-COPILOT-FIXTURE-SELF-CHECK",
  },
  "search-layout|e2e/search-layout/search-layout.spec.ts:181|390px ltr › the typeahead paints above the panels that would clip it": {
    classification: "FIXTURE_DEFECT",
    rationale:
      "The same assertion failed in the rtl direction in the earlier measurement and in ltr here, with the identical message, while the other direction passed each time. A defect in stacking order would not change direction between runs; an overlay that sometimes intercepts the pointer does.",
    evidence: [
      "audit/ui-truth/data/layout-failures-prior.json — the rtl case failed at e341e5be and passes now",
      "audit/ui-truth/data/layout-failures-current.json — the ltr case fails now with the same 'something painted over the typeahead'",
    ],
    affectedRoute: "/search",
    severityIfReal: null,
    visibleInProductionRendering: "UNKNOWN",
    visibilityReason:
      "Direction-flipping between runs points at the consent overlay this project does not suppress, but no interception line was logged, so the product cannot be cleared or blamed from this evidence alone.",
    groupKey: "SEARCH-TYPEAHEAD-OVERLAY-FLAKE",
  },
};

const rows = [];
const unmatched = [];
for (const f of current.failures) {
  const k = key(f);
  const carried = classified.get(k);
  if (carried) {
    rows.push({ ...carried, failureId: f.failureId, measuredAtSha: current.measuredAtSha, carriedFrom: classification.measuredAtSha });
    continue;
  }
  const fresh = NEW_ROWS[k];
  if (!fresh) {
    unmatched.push(k);
    continue;
  }
  rows.push({
    failureId: f.failureId,
    project: f.project,
    spec: f.spec,
    specLine: f.specLine,
    title: f.title,
    measuredAtSha: current.measuredAtSha,
    carriedFrom: null,
    ...fresh,
  });
}

if (unmatched.length > 0) {
  console.error(`ABORT — ${unmatched.length} measured failure(s) carry no classification:`);
  for (const u of unmatched) console.error(`  ${u}`);
  process.exit(2);
}

const currentKeys = new Set(current.failures.map(key));
const resolved = classification.rows.filter((r) => !currentKeys.has(key(r)));

const byClassification = {};
for (const r of rows) byClassification[r.classification] = (byClassification[r.classification] ?? 0) + 1;
const byProject = {};
for (const r of rows) byProject[r.project] = (byProject[r.project] ?? 0) + 1;
const byGroup = {};
for (const r of rows) byGroup[r.groupKey] = (byGroup[r.groupKey] ?? 0) + 1;
const realBySeverity = {};
for (const r of rows.filter((r) => r.classification === "REAL_PRODUCT_DEFECT")) {
  realBySeverity[r.severityIfReal ?? "UNSET"] = (realBySeverity[r.severityIfReal ?? "UNSET"] ?? 0) + 1;
}

rows.sort((a, b) => (a.failureId < b.failureId ? -1 : 1));

writeFileSync(
  join(DATA, "layout-classification-current.json"),
  JSON.stringify(
    {
      artifact: "ui-truth/layout-classification-current",
      schemaVersion: 1,
      measuredAtSha: current.measuredAtSha,
      note: "Every failure of the re-measurement on the audited SHA, classified. Rows carried from the earlier measurement keep their rationale and evidence; rows new to this measurement were classified here.",
      total: rows.length,
      carriedRows: rows.filter((r) => r.carriedFrom).length,
      newlyClassifiedRows: rows.filter((r) => !r.carriedFrom).length,
      resolvedSinceEarlierMeasurement: resolved.map((r) => ({ project: r.project, spec: r.spec, specLine: r.specLine, title: r.title, wasClassified: r.classification })),
      rows,
    },
    null,
    2,
  ) + "\n",
);

writeFileSync(
  join(DATA, "layout-classification-summary.json"),
  JSON.stringify(
    {
      artifact: "ui-truth/layout-classification-summary",
      schemaVersion: 1,
      measuredAtSha: current.measuredAtSha,
      earlierMeasurementSha: prior.measuredAtSha,
      totals: {
        measuredFailures: current.totals.failed,
        classifiedRows: rows.length,
        byClassification,
        byProject,
        realProductDefectsBySeverity: realBySeverity,
        resolvedSinceEarlierMeasurement: resolved.length,
        newSinceEarlierMeasurement: rows.filter((r) => !r.carriedFrom).length,
        distinctGroups: Object.keys(byGroup).length,
      },
      byGroup: Object.fromEntries(Object.entries(byGroup).sort((a, b) => b[1] - a[1])),
      realProductDefects: rows
        .filter((r) => r.classification === "REAL_PRODUCT_DEFECT")
        .map((r) => ({ failureId: r.failureId, route: r.affectedRoute, severity: r.severityIfReal, title: r.title })),
      affectedRoutes: [...new Set(rows.map((r) => r.affectedRoute))].sort(),
    },
    null,
    2,
  ) + "\n",
);

console.log(JSON.stringify({ classified: rows.length, measured: current.totals.failed, byClassification, resolved: resolved.length }, null, 2));
