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

/** Strip comments — a prose mention of a retired pattern is not a usage. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

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
  assert.match(CSS, /\.rpt-metric__value \{[\s\S]{0,300}color: var\(--rpt-tone/);
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

// ---------------------------------------------------------------------------
// Search, filters, and the summary they used to destroy
// ---------------------------------------------------------------------------

test("the user-scoped fallback fires ONLY on the unfiltered view", () => {
  // THE ROOT CAUSE of three symptoms at once. The fallback is a bootstrap
  // probe for a personal workspace whose membership row is missing, but it
  // fired on ANY empty result — including the correct emptiness of a search or
  // a filter. `tryUserScopedReports` sends neither `search` nor `lifecycle`
  // and reports its summary `unavailable`, so a query returned the UNFILTERED
  // list and blanked the summary.
  assert.match(
    INDEX,
    /const isUnfilteredView = currentFilter === "all" && trimmed\.length === 0;/,
  );
  assert.match(
    INDEX,
    /isUnfilteredView &&\s*\n\s*envelope\.sections\.artifacts\.status === "ok" &&\s*\n\s*envelope\.sections\.artifacts\.items\.length === 0/,
    "the empty-result fallback must be gated on the unfiltered view",
  );
});

test("the summary is fetched independently of the list", () => {
  // Stronger than merging it out of the list response: the counters have their
  // OWN request and their OWN state, so a list query cannot blank them and a
  // list refresh cannot delay them. Six workspace aggregations that no filter,
  // search or page can change are no longer recomputed per keystroke — which
  // is what made changing a filter feel like a page load.
  assert.match(INDEX, /const loadSummary = useCallback/);
  assert.match(INDEX, /const \[summarySection, setSummarySection\] = useState</);
  assert.match(INDEX, /\{summarySection\.status === "ok" && summarySection\.data \? \(/);
  // …and the LIST asks the server to skip them.
  assert.match(INDEX, /summary: "0",/);
});

test("search and lifecycle both reach the server, and compose", () => {
  // One request carries both, so `filter=package_ready` + `search=Joint` is
  // one query for package-ready rows matching Joint — neither overwrites the
  // other.
  assert.match(INDEX, /lifecycle: currentFilter,/);
  assert.match(INDEX, /params\.set\("search", trimmed\.slice\(0, 80\)\)/);
  assert.match(INDEX, /void reload\(filter, search, cursor\)/);
});

test("SERVER: search matches every field the title cascade displays", () => {
  // Matching `title` alone meant a user could read a name on screen — resolved
  // from `displayFileName` — type it, and get nothing back.
  const block = AGGREGATOR.slice(
    AGGREGATOR.indexOf("if (input.search"),
    AGGREGATOR.indexOf("// Cursor —"),
  );
  for (const field of ["title", "displayFileName", "originalFileName"]) {
    assert.match(
      block,
      new RegExp("[{] " + field + ": like [}]"),
      `search must cover ${field}`,
    );
  }
  assert.match(block, /whereBase\.OR = \[/);
});

test("SERVER: all six lifecycle filters map to a real status field", () => {
  const block = AGGREGATOR.slice(AGGREGATOR.indexOf("function filterByLifecycle"));
  const cases: Array<[string, string]> = [
    ["report_ready", 'i.report.state === "ready"'],
    ["report_pending", 'i.report.state === "pending"'],
    ["package_ready", 'i.package.state === "ready"'],
    ["package_pending", 'i.package.state === "pending"'],
    ["package_blocked", 'i.package.state === "blocked"'],
  ];
  for (const [key, predicate] of cases) {
    assert.match(block, new RegExp(`case "${key}":`), `${key} has no branch`);
    assert.ok(block.includes(predicate), `${key} must filter on ${predicate}`);
  }
  // `all` returns everything rather than filtering to nothing.
  assert.match(block, /case "all":\s*\n\s*return items;/);
});

test("there is exactly ONE clear control on the search field", () => {
  // `type="search"` makes WebKit draw its own cancel button beside the
  // component's canonical one, in the same corner.
  const GLOBALS = read("apps/web/app/globals.css");
  assert.match(GLOBALS, /\.ui-filterbar__input::-webkit-search-cancel-button/);
  assert.match(GLOBALS, /appearance: none;/);
  // …and the component's own control is the one that stays.
  const FILTERBAR = read("apps/web/components/ui/FilterBar.tsx");
  assert.match(FILTERBAR, /aria-label="Clear search"/);
});

// ---------------------------------------------------------------------------
// Case name, buttons, card typography
// ---------------------------------------------------------------------------

test("the row shows the case NAME, sourced in the same query", () => {
  // A truncated uuid is not something a person recognises. The name travels on
  // the existing `caseLinks` select — no second request, no N+1.
  assert.match(AGGREGATOR, /case: \{ select: \{ name: true \} \}/);
  assert.match(AGGREGATOR, /caseTitle: r\.caseLinks\[0\]\?\.case\?\.name\?\.trim\(\) \|\| null,/);
  assert.match(TYPES, /\n {2}caseTitle: string \| null;/);
  // The short id survives only as the fallback for a case with no name.
  assert.match(INDEX, /Case: \{row\.caseTitle \?\? `#\$\{row\.caseId\.slice\(0, 6\)\}`\}/);
  assert.doesNotMatch(INDEX, /Case #\{row\.caseId\.slice/);
});

test("Download report PDF is canonical purple, not the legacy coral CTA", () => {
  assert.match(INDEX, /className="app-primary-action rpt-row__action"/);
  // `Button variant="primary"` is the login/marketing CTA — a coral-to-pink
  // gradient. The Reports row must not borrow it.
  // Comments stripped: this file EXPLAINS which variant was retired, and a
  // guard that tripped on its own rationale would be deleted by the next
  // person who read it.
  const actions = code(INDEX.slice(INDEX.indexOf("function ArtifactRowActions")));
  assert.doesNotMatch(actions, /variant="primary"/);
});

test("the legacy coral CTA token still exists for its real consumers", () => {
  // The goal was to stop USING it here, not to delete a token other surfaces
  // legitimately own.
  const BUTTON = read("apps/web/components/ui/Button.tsx");
  assert.match(BUTTON, /--btn-primary-bg/);
});

test("Download verification package is canonical dark, white on hover and focus", () => {
  assert.match(
    INDEX,
    /className="app-secondary-action app-secondary-action--filled rpt-row__action"/,
  );
  // The filled variant keeps its white label on hover; the base secondary
  // hover sets a dark `color` at equal specificity, which is what turned the
  // text dark on a dark ground.
  const PRIMITIVES = read("apps/web/components/app-primitives/app-primitives.css");
  assert.match(
    PRIMITIVES,
    /\.app-secondary-action--filled:hover:not\(:disabled\) \{[\s\S]{0,160}color: (#ffffff|rgb\(255, 255, 255\)|var\(--ink-inverse\))/,
  );
});

test("the summary value uses the page's own type system", () => {
  // The digits rendered in the browser's default numeric face because nothing
  // in the chain set a family, so they looked like a different typeface from
  // every label beside them.
  assert.match(CSS, /\.rpt-metric__value \{[\s\S]{0,200}font-family: inherit;/);
  assert.match(CSS, /font-variant-numeric: tabular-nums;/);
  assert.match(CSS, /\.rpt-metric__label \{[\s\S]{0,160}font-family: inherit;/);
  // Roomier cards, still not huge.
  assert.match(CSS, /minmax\(196px, 1fr\)/);
});

// ---------------------------------------------------------------------------
// Pagination, totals, and the 25-row cap
// ---------------------------------------------------------------------------

const ROUTES = read("services/api/src/routes/case-workspace.routes.ts");

test("the list exposes a TOTAL, counted on the same predicate as the page", () => {
  // `Artifacts · 25` was `items.length` — the page size announced as if it
  // were the answer, on a workspace with 278 reports.
  assert.match(AGGREGATOR, /const total = await prisma\.evidence\.count\(\{/);
  assert.match(TYPES, /\n {6}total: number \| null;/);
  assert.match(INDEX, /sections\.artifacts\.total \?\? sections\.artifacts\.items\.length/);
  // NEVER derived from the rows.
  assert.doesNotMatch(INDEX, /title=\{`Artifacts · \$\{sections\.artifacts\.items\.length\}`\}/);
});

test("a 25-row page can describe a larger total", () => {
  // The page size is named once and the page count derives from the server's
  // total, so 278 renders as 25 rows across 12 pages rather than as 25.
  assert.match(INDEX, /const REPORTS_PAGE_SIZE = 25;/);
  assert.match(
    INDEX,
    /Math\.max\(1, Math\.ceil\(sections\.artifacts\.total \/ REPORTS_PAGE_SIZE\)\)/,
  );
});

test("Next reaches different records, and Previous comes back", () => {
  // Cursor pagination: the stack is the history. Next pushes the server's own
  // `nextCursor`, Previous pops — so page 2 is a different query, not a
  // client-side slice of the same 25 rows.
  assert.match(INDEX, /const \[cursors, setCursors\] = useState<string\[\]>\(\[\]\)/);
  assert.match(INDEX, /setCursors\(\(c\) => \[\.\.\.c, next\]\)/);
  assert.match(INDEX, /setCursors\(\(c\) => c\.slice\(0, -1\)\)/);
  assert.match(INDEX, /params\.set\("cursor", currentCursor\)/);
  // Both ends are truthfully disabled.
  assert.match(INDEX, /disabled=\{page <= 1 \|\| refreshing\}/);
  assert.match(INDEX, /disabled=\{!sections\.artifacts\.nextCursor \|\| refreshing\}/);
});

test("the lifecycle filter is a QUERY predicate, not a post-pagination slice", () => {
  // THE CAP BUG. `filterByLifecycle(items, …)` ran over the 25 rows already
  // fetched, so "Report pending" searched 9% of a 278-record workspace and
  // reported a count from that slice.
  assert.match(AGGREGATOR, /function lifecycleWhere\(/);
  assert.match(AGGREGATOR, /\(whereBase\.AND as Prisma\.EvidenceWhereInput\[\]\)\.push\(lifecycleClause\)/);
  assert.doesNotMatch(
    code(AGGREGATOR),
    /const filtered = filterByLifecycle\(items,/,
    "the filter must not run after pagination",
  );
});

test("every filter maps to a predicate over the full dataset", () => {
  const block = AGGREGATOR.slice(
    AGGREGATOR.indexOf("function lifecycleWhere("),
    AGGREGATOR.indexOf("function filterByLifecycle("),
  );
  const cases: Array<[string, RegExp]> = [
    ["all", /case "all":\s*\n\s*return null;/],
    ["report_ready", /reports: \{ some: \{\} \}/],
    ["report_pending", /reports: \{ none: \{\} \}/],
    ["package_ready", /verificationPackages: \{ some: \{\} \}/],
    ["package_blocked", /verificationPackageMetadata: \{ path: \["blocked"\], equals: true \}/],
  ];
  for (const [key, re] of cases) {
    assert.match(block, re, `${key} has no full-dataset predicate`);
  }
  // Pending is "no package AND not blocked" — the two are disjoint.
  assert.match(block, /NOT: \{ verificationPackageMetadata: \{ path: \["blocked"\], equals: true \} \}/);
});

test("changing filter or search resets to page 1", () => {
  // A cursor names a position in ONE ordered result set; carrying it into a
  // different query points at a row that may not be in it.
  assert.match(INDEX, /const changeFilter = useCallback\(\(next: LifecycleFilter\) => \{\s*\n\s*setFilter\(next\);\s*\n\s*setCursors\(\[\]\);/);
  assert.match(INDEX, /const changeSearch = useCallback\(\(next: string\) => \{\s*\n\s*setSearch\(next\);\s*\n\s*setCursors\(\[\]\);/);
  assert.match(INDEX, /onChange=\{changeSearch\}/);
  assert.match(INDEX, /onClick=\{\(\) => changeFilter\(key\)\}/);
});

test("the list asks the server to skip the workspace aggregations", () => {
  // THE PERFORMANCE FIX. Six aggregate counts a filter cannot change were
  // recomputed on every list request.
  assert.match(AGGREGATOR, /if \(input\.includeSummary === false\) \{/);
  assert.match(AGGREGATOR, /summary = \{ status: "skipped", data: null \};/);
  assert.match(ROUTES, /summary: z\.enum\(\["0", "1"\]\)\.optional\(\)/);
  assert.match(ROUTES, /includeSummary: query\.summary !== "0"/);
});

test("a stale response cannot overwrite a newer query", () => {
  // Three quick filter clicks start three requests; without this the slowest
  // wins and the list shows a filter the operator already left.
  assert.match(INDEX, /const generation = \(listGeneration\.current \+= 1\)/);
  assert.match(INDEX, /listAbort\.current\?\.abort\(\)/);
  assert.match(INDEX, /const isCurrent = \(\) => generation === listGeneration\.current/);
  assert.match(INDEX, /signal: controller\.signal/);
  assert.match(INDEX, /if \(!isCurrent\(\)\) return;/);
  assert.match(INDEX, /"AbortError"/);
});

test("the empty state distinguishes no data from no matches", () => {
  assert.match(INDEX, /const filtered = filter !== "all" \|\| search\.trim\(\)\.length > 0;/);
  assert.match(INDEX, /"No reports match your search\."/);
  assert.match(INDEX, /"No reports match this filter\."/);
  assert.match(INDEX, /"No reports yet"/);
  assert.match(INDEX, /data-reports-empty-kind=\{filtered \? "no_match" : "no_data"\}/);
});

test("the empty-state CTA is canonical purple, and the coral CTA is gone", () => {
  const empty = INDEX.slice(INDEX.indexOf("function ReportsEmptyState"));
  assert.match(empty, /className="app-primary-action"/);
  // The inline coral treatment: `--btn-primary-bg` is the login/marketing CTA.
  assert.doesNotMatch(code(empty), /--btn-primary-bg/);
  assert.doesNotMatch(code(empty), /cc-quick-action/);
  // …and it is offered only where "open evidence" answers the sentence above.
  assert.match(empty, /!filtered \? \(/);
});

test("the coral CTA token keeps its legitimate consumers", () => {
  // The goal was to stop USING it on Reports, not to delete a token other
  // surfaces own.
  const BUTTON = read("apps/web/components/ui/Button.tsx");
  assert.match(BUTTON, /--btn-primary-bg/);
});
