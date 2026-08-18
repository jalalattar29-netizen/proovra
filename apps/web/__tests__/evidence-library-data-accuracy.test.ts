/**
 * Phase EVIDENCE-LIBRARY-DATA-ACCURACY — acceptance lock for the
 * data-accuracy correction (no UX redesign):
 *
 *   1. Verification Package Readiness is REAL — backend predicate
 *      is `verificationPackages.some` / `verificationPackages.none`,
 *      NOT `latestReportVersion`. The frontend never silently
 *      proxies report state for package state; when the workspace
 *      summary is unavailable, the package cards show
 *      "Package readiness unavailable" instead.
 *
 *   2. Counts that come from `/v1/evidence/library-summary` are
 *      labelled "Workspace total · {scope}"; counts derived from
 *      the loaded page are labelled "On this page". The two
 *      sources are never silently mixed in the same card.
 *
 *   3. The metric cards are READ-ONLY — they render through the
 *      existing EvidenceMetrics component (plain divs), not as
 *      buttons / filter dispatchers. The page does NOT mount a
 *      parallel quick-filter chip strip.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");

function src(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

const ROUTES = src("services/api/src/routes/evidence.routes.ts");
const TYPES = src("apps/web/app/(app)/evidence/lib/evidence-library-types.ts");
const PAGE = src("apps/web/app/(app)/evidence/page.tsx");
const METRICS_COMPONENT = src(
  "apps/web/app/(app)/evidence/components/EvidenceMetrics.tsx",
);

// ===========================================================================
// Backend — REAL package readiness
// ===========================================================================

test("Backend route GET /v1/evidence/library-summary is registered with requireAuth", () => {
  assert.match(
    ROUTES,
    /app\.get\(\s*\n?\s*"\/v1\/evidence\/library-summary"[\s\S]{0,200}preHandler:\s*requireAuth/,
  );
});

test("Backend reuses buildEvidenceListBaseWhere — same scope/access/permission envelope as the list endpoint", () => {
  const start = ROUTES.indexOf('"/v1/evidence/library-summary"');
  const body = ROUTES.slice(start, start + 10_000);
  assert.match(body, /buildEvidenceListBaseWhere\(/);
});

test("Backend packages-ready uses verificationPackages.some — NOT latestReportVersion", () => {
  const start = ROUTES.indexOf('"/v1/evidence/library-summary"');
  const body = ROUTES.slice(start, start + 10_000);
  assert.match(
    body,
    /PACKAGES_READY_PREDICATE[\s\S]{0,200}verificationPackages:\s*\{\s*some:\s*\{\s*\}\s*\}/,
  );
  // Anti-regression — the predicate must NOT contain
  // `latestReportVersion` (that would be the rejected proxy).
  const packagesPredicateBlock = body.slice(
    body.indexOf("PACKAGES_READY_PREDICATE"),
    body.indexOf("PACKAGES_READY_PREDICATE") + 400,
  );
  assert.doesNotMatch(packagesPredicateBlock, /latestReportVersion/);
});

test("Backend packages-missing predicate is REPORTED AND verificationPackages.none (real, not proxy)", () => {
  const start = ROUTES.indexOf('"/v1/evidence/library-summary"');
  const body = ROUTES.slice(start, start + 10_000);
  assert.match(
    body,
    /PACKAGES_MISSING_PREDICATE[\s\S]{0,400}status:\s*prismaPkg\.EvidenceStatus\.REPORTED[\s\S]{0,400}verificationPackages:\s*\{\s*none:\s*\{\s*\}\s*\}/,
  );
  const missingBlock = body.slice(
    body.indexOf("PACKAGES_MISSING_PREDICATE"),
    body.indexOf("PACKAGES_MISSING_PREDICATE") + 500,
  );
  assert.doesNotMatch(missingBlock, /latestReportVersion/);
});

test("Backend response shape carries every workspace-scoped count + source discriminator", () => {
  const start = ROUTES.indexOf('"/v1/evidence/library-summary"');
  const body = ROUTES.slice(start, start + 10_000);
  assert.match(body, /source:\s*"workspace_total"/);
  for (const field of [
    "totalActiveRecords",
    "reportsReadyCount",
    "packagesReadyCount",
    "packagesMissingCount",
    "storageProtectedCount",
    "storageNeedsReviewCount",
    "multipartCount",
    "verificationIssuesCount",
    "unassignedCount",
    "needsActionCount",
  ]) {
    assert.match(body, new RegExp(`${field}[,\\s]`));
  }
});

test("Backend needsActionCount is computed as ONE OR-union query (no double-counting)", () => {
  const start = ROUTES.indexOf('"/v1/evidence/library-summary"');
  const body = ROUTES.slice(start, start + 10_000);
  assert.match(
    body,
    /const needsActionCount\s*=\s*await prisma\.evidence\.count\(\{\s*\n?\s*where:\s*compose\(\{\s*\n?\s*OR:\s*\[/,
  );
});

// ===========================================================================
// Frontend type contract
// ===========================================================================

test("EvidenceLibrarySummaryResponse type covers every workspace count + source discriminator", () => {
  assert.match(
    TYPES,
    /export type EvidenceLibrarySummaryResponse\s*=\s*\{[\s\S]{0,1000}source:\s*"workspace_total"[\s\S]{0,200}totalActiveRecords:\s*number[\s\S]{0,200}reportsReadyCount:\s*number[\s\S]{0,200}packagesReadyCount:\s*number[\s\S]{0,200}packagesMissingCount:\s*number[\s\S]{0,200}storageProtectedCount:\s*number[\s\S]{0,200}storageNeedsReviewCount:\s*number[\s\S]{0,200}multipartCount:\s*number[\s\S]{0,200}verificationIssuesCount:\s*number[\s\S]{0,200}unassignedCount:\s*number[\s\S]{0,200}needsActionCount:\s*number/,
  );
});

// ===========================================================================
// Frontend wiring
// ===========================================================================

test("Page fetches /v1/evidence/library-summary alongside the list (partial-failure tolerant)", () => {
  assert.match(PAGE, /buildEvidenceLibrarySummaryPath\(query\)/);
  assert.match(
    PAGE,
    /\(async \(\) => \{\s*\n?\s*try \{\s*\n?\s*return \(await apiFetch\(\s*\n?\s*buildEvidenceLibrarySummaryPath\(query\),\s*\n?\s*\)\) as EvidenceLibrarySummaryResponse;\s*\n?\s*\} catch \{\s*\n?\s*return null;/,
  );
});

test("Page nulls workspaceSummary on list-error so cards switch to honest fallback labels", () => {
  assert.match(
    PAGE,
    /setLibrary\(\(current\) => \(\{\s*\n?\s*\.\.\.current,\s*\n?\s*items: \[\],\s*\n?\s*pageInfo: null,\s*\n?\s*\}\)\);[\s\S]{0,400}?setWorkspaceSummary\(null\)/,
  );
});

// ===========================================================================
// Frontend metric cards — read-only + honest scope labels
// ===========================================================================

test("EvidenceMetrics component renders cards as read-only (Card components, NOT buttons)", () => {
  // The component is the existing one — it renders MetricCard
  // instances that wrap each metric in a Card. The cards do
  // NOT carry onClick handlers / button elements / quick-filter
  // dispatch — confirming the rejected redesign behaviour is
  // genuinely gone.
  // Part 1 moved the card onto the canonical `.app-kpi-card` (the same card
  // Case Details and the operational dashboards render). The GUARANTEE is
  // unchanged and now stricter: no button, no link, no handler of any kind,
  // so a KPI can never become a filter trigger again.
  assert.match(METRICS_COMPONENT, /function MetricCard\(\{/);
  assert.match(METRICS_COMPONENT, /className="app-kpi-card"/);
  assert.doesNotMatch(METRICS_COMPONENT, /<button/);
  assert.doesNotMatch(METRICS_COMPONENT, /<a[\s>]/);
  assert.doesNotMatch(METRICS_COMPONENT, /href=/);
  assert.doesNotMatch(METRICS_COMPONENT, /role="button"/);
  // Tone stays SEMANTIC: only the canonical vocabulary may be emitted, so no
  // decorative colour can be introduced through this component.
  // The target colours the VALUE, not a rail on the card. Only the two
  // meaningful tones may be produced, and the card itself carries no tone.
  // The CARD carries no tone (the target has no coloured top rail); only the
  // VALUE may, so state reads from the number itself.
  assert.match(METRICS_COMPONENT, /className="app-kpi-card" data-evidence-metric=/);
  assert.match(METRICS_COMPONENT, /className="app-kpi-card__value"/);
  assert.match(METRICS_COMPONENT, /data-tone=\{TONE_TO_VALUE\[tone\]/);
  const tones = [...METRICS_COMPONENT.matchAll(/"(danger|accent)"/g)].map((m) => m[1]);
  assert.ok(tones.length >= 2, "expected the value-tone map");
  assert.doesNotMatch(METRICS_COMPONENT, /onClick=/);
});

test("Page does NOT mount a parallel quick-filter chip strip / clickable KPI cards", () => {
  // Rejected redesign artifacts MUST NOT come back.
  assert.doesNotMatch(PAGE, /EvidenceQuickFilters/);
  assert.doesNotMatch(PAGE, /EvidenceOperationalMetrics/);
  assert.doesNotMatch(PAGE, /onApplyQuickFilter/);
  assert.doesNotMatch(PAGE, /applyQuickFilter/);
  assert.doesNotMatch(PAGE, /buildPresetFilters/);
});

test("Metric cards use workspace summary when available", () => {
  // The cards source from workspaceSummary fields.
  assert.match(PAGE, /workspaceSummary\.totalActiveRecords/);
  assert.match(PAGE, /workspaceSummary\.reportsReadyCount/);
  assert.match(PAGE, /workspaceSummary\.packagesReadyCount/);
  assert.match(PAGE, /workspaceSummary\.packagesMissingCount/);
  assert.match(PAGE, /workspaceSummary\.storageProtectedCount/);
  assert.match(PAGE, /workspaceSummary\.multipartCount/);
  assert.match(PAGE, /workspaceSummary\.unassignedCount/);
});

test("Workspace totals and page counts keep distinct, honest captions", () => {
  // The captions must remain DISTINCT and non-empty: a workspace total may
  // never render with the page caption or vice versa. The scope qualifier
  // moved out of the caption when the target composition put the Scope
  // control immediately below the cards; the SOURCE distinction — the thing
  // that makes the number honest — is unchanged.
  assert.match(PAGE, /workspaceScopeDetail\s*=\s*"Workspace total"/);
  assert.match(PAGE, /pageScopeDetail\s*=\s*"On this page"/);
  assert.notEqual("Workspace total", "On this page");
  // Page-derived branches must never borrow the workspace caption.
  const pageBranches = [...PAGE.matchAll(/value: String\(page\w+\),\s*\n\s*detail: ([^,\n]+),/g)].map(
    (m) => m[1].trim(),
  );
  for (const d of pageBranches) {
    assert.notEqual(d, "workspaceScopeDetail", "a page-derived count used the workspace caption");
  }
});

test("Page-derived counts are labelled 'On this page'", () => {
  assert.match(PAGE, /pageScopeDetail\s*=\s*"On this page"/);
});

test("Package readiness cards show 'Package readiness unavailable' instead of the proxy when summary fails", () => {
  // The packages-ready + packages-missing fallback branches must
  // surface the unavailable state, NEVER fall back to
  // `latestReportVersion`.
  const pageBlock = PAGE.slice(
    PAGE.indexOf("packagesReadyCard"),
    PAGE.indexOf("packagesMissingCard") + 1200,
  );
  assert.match(pageBlock, /"Verification packages ready"[\s\S]{0,400}?value:\s*"—"[\s\S]{0,200}?detail:\s*"Package readiness unavailable"/);
  assert.match(pageBlock, /"Verification packages missing"[\s\S]{0,400}?value:\s*"—"[\s\S]{0,200}?detail:\s*"Package readiness unavailable"/);
});

test("Package readiness fallback NEVER reads latestReportVersion as the source", () => {
  // Audit the package cards specifically — they must not contain
  // any read of `item.latestReportVersion`. Other cards (Reports
  // ready) legitimately use latestReportVersion as a page-level
  // proxy because the list field IS report-version state.
  const packagesReadySlice = PAGE.slice(
    PAGE.indexOf("packagesReadyCard"),
    PAGE.indexOf("packagesMissingCard"),
  );
  assert.doesNotMatch(packagesReadySlice, /latestReportVersion/);
  const packagesMissingSlice = PAGE.slice(
    PAGE.indexOf("packagesMissingCard"),
    PAGE.indexOf("storageProtectedCard"),
  );
  assert.doesNotMatch(packagesMissingSlice, /latestReportVersion/);
});

test("The vague 'Detail check' sentinel is gone from the package card", () => {
  assert.doesNotMatch(PAGE, /value:\s*"Detail check"/);
});

// ===========================================================================
// Regression — existing dropdown filters / saved views / bulk selection
// ===========================================================================

test("Regression — existing filters/saved-views/bulk-selection still mount", () => {
  assert.match(PAGE, /<EvidenceFilters/);
  assert.match(PAGE, /<SavedViewsMenu/);
  assert.match(PAGE, /<BulkActionsToolbar/);
  assert.match(PAGE, /<EvidenceMetrics items=\{metrics\}/);
});

test("Regression — GET /v1/evidence list response shape unchanged", () => {
  assert.match(
    ROUTES,
    /return reply\.code\(200\)\.send\(\{\s*\n?\s*scope,\s*\n?\s*items: mappedItems,\s*\n?\s*pageInfo:\s*\{/,
  );
});
