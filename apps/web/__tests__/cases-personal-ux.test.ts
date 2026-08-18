/**
 * Phase CASES-PERSONAL-UX — source-pinned contract for the Cases page.
 *
 * Pins:
 *   1. Header copy: single canonical "Cases" title + spec subtitle;
 *      duplicated "Your cases" kicker is gone.
 *   2. Search keeps focus: the page does NOT short-circuit to a full
 *      <QueueLoading /> remount on every reload; the filters row
 *      stays mounted with the same React identity. Search input
 *      change is debounced into `appliedSearch` before triggering
 *      the network request.
 *   3. Filter / chip gating:
 *      - Status select renders for everyone, with human-readable
 *        labels driven by `STATUS_LABEL`.
 *      - Risk select gated on `canSeeAdvancedCaseOps`.
 *      - "Open issues" + "Missing report or package" chips are
 *        unconditional.
 *      - "Assigned to me", "Governance blockers", "Overdue workflows",
 *        "Active legal hold" chips are gated on `canSeeAdvancedCaseOps`.
 *      - Gating is rendered-only — backend filter state is preserved.
 *   4. Case card simplification: risk badge, priority chip, reason
 *      codes, and the granular counter strip are gated on
 *      `canSeeAdvancedCaseOps`. The personal-mode card surfaces a
 *      single "needs report or package" chip when there is a gap.
 *   5. Two distinct empty states with the spec-locked copy:
 *      "No cases yet" + Create-case CTA, and "No cases match these
 *      filters" + Clear-filters CTA.
 *   6. `canAccessSurface(ctx, "/investigation")` is the canonical
 *      gate — no hardcoded plan names.
 *   7. The backend selector / matter-queue contract is untouched
 *      (cross-checked from the backend route file).
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

const CASES_PAGE = src("apps/web/components/cases-experience/CasesIndex.tsx");
const CASES_ROUTE = src("services/api/src/routes/case-workspace.routes.ts");
const MATTER_QUEUE_SVC = src("services/api/src/services/cases/matter-queue.service.ts");

// ===========================================================================
// Header
// ===========================================================================

test("Header renders a single 'Cases' title — kicker duplicate is gone", () => {
  // h1 must say exactly "Cases".
  assert.match(
    CASES_PAGE,
    /<h1 className="cc-title" data-cases-title>\s*\n?\s*Cases\s*\n?\s*<\/h1>/,
  );
  // The old kicker that repeated `Your {casePlural}` must not be
  // present anywhere in the file.
  assert.doesNotMatch(CASES_PAGE, /data-cases-kicker/);
  assert.doesNotMatch(CASES_PAGE, /Your \{terms\.casePlural\.toLowerCase\(\)\}/);
});

test("Subtitle uses the spec copy and carries a stable data attribute", () => {
  // CORRECTED ASSERTION. This previously pinned `<p className="cc-subtitle">`,
  // which locked in a DEFECT: `PageHeader` already wraps `subtitle` in its own
  // <p>, so a <p> here rendered invalid `<p><p>` nesting and React logged a
  // `validateDOMNesting` hydration error on /cases. The spec copy and the
  // `data-cases-subtitle` hook are unchanged — only the element is now the
  // inline `<span>` the subtitle contract requires.
  assert.match(
    CASES_PAGE,
    /<span className="cc-subtitle" data-cases-subtitle>\s*\n?\s*Group related evidence into simple workspaces for incidents,\s*\n?\s*claims, projects, or reviews\./,
  );
  // Anti-regression: the subtitle must never become a block element again.
  assert.doesNotMatch(CASES_PAGE, /subtitle=\{\s*\n?\s*(\/\/[^\n]*\n\s*)*<(p|div)[\s>]/);
});

// ===========================================================================
// Search focus + debounce
// ===========================================================================

test("Search input value is bound to the immediate `filters.search` state (always responsive)", () => {
  assert.match(
    CASES_PAGE,
    /type="search"[\s\S]{0,300}?value=\{filters\.search\}[\s\S]{0,200}?onChange=\{\(e\) => set\("search", e\.target\.value\)\}/,
  );
});

test("Search is debounced into `appliedSearch` (single 300ms timer) before triggering the network request", () => {
  // Anti-regression: the network query string must reference the
  // debounced copy, not the raw input value.
  assert.match(
    CASES_PAGE,
    /const \[appliedSearch, setAppliedSearch\] = useState\(""\);/,
  );
  // §8 — the debounced value is ALSO normalised (a single leading `#`
  // stripped) so the row's `#f2b14622` short id is searchable.
  assert.match(
    CASES_PAGE,
    /setTimeout\(\(\) => \{[\s\S]*?setAppliedSearch\(\s*\n?\s*filters\.search\.trim\(\)\.replace\(\/\^#\/, ""\)\.trim\(\),?\s*\n?\s*\);[\s\S]*?\}, 300\)/,
  );
  assert.match(
    CASES_PAGE,
    /if \(appliedSearch\) qs\.set\("search", appliedSearch\);/,
  );
  // Anti-regression: the raw `filters.search.trim()` must not be
  // shoved straight into the query string anymore.
  assert.doesNotMatch(
    CASES_PAGE,
    /if \(filters\.search\.trim\(\)\) qs\.set\("search", filters\.search\.trim\(\)\);/,
  );
});

test("Page chrome stays mounted across reloads — loading early-return only fires when no envelope exists yet", () => {
  // The loading branch must be the LAST of the three terminal-state
  // checks. The previous order was loading → auth_error →
  // unavailable, which meant every reload took over the whole page
  // and remounted the search input. New order: auth_error first,
  // then unavailable, then loading-without-prior-data.
  assert.match(
    CASES_PAGE,
    /if \(state\.status === "auth_error"\)[\s\S]{0,200}?if \(state\.status === "unavailable"\)[\s\S]{0,200}?if \(state\.status === "loading"\) return <QueueLoading \/>;/,
  );
  // Reload now preserves the previous envelope so the next render
  // can keep the filters + table mounted with the prior data.
  assert.match(
    CASES_PAGE,
    /setState\(\(prev\) =>\s*\n?\s*prev\.status === "ready"\s*\n?\s*\?\s*\{ status: "ready", envelope: prev\.envelope, isReloading: true \}\s*\n?\s*:\s*\{ status: "loading" \},\s*\n?\s*\);/,
  );
});

test("During an in-flight reload an 'Updating…' indicator is rendered (proves chrome is still mounted)", () => {
  assert.match(CASES_PAGE, /data-matter-queue-reloading/);
});

// ===========================================================================
// Capability gating helper
// ===========================================================================

test("Cases page computes canSeeAdvancedCaseOps via the server-projection gate", () => {
  // PHASE 12B Track 1A — SERVER-projected enterprise hook, never client tier/plan.
  assert.match(CASES_PAGE, /useEnterpriseSurfaceAccess/);
  assert.match(
    CASES_PAGE,
    /const canSeeAdvancedCaseOps = useEnterpriseSurfaceAccess\(\);/,
  );
});

test("Main container carries `data-cases-advanced-mode` so E2E can assert per-mode rendering", () => {
  assert.match(
    CASES_PAGE,
    /data-cases-advanced-mode=\{canSeeAdvancedCaseOps \? "true" : "false"\}/,
  );
});

// ===========================================================================
// Filter / chip gating
// ===========================================================================

test("Status filter stays visible for everyone via the segment tabs with human-readable labels", () => {
  // §3 — the duplicate native "Any status" <select> was removed; the
  // status SEGMENT strip is the ONLY status filter now. STATUS_LABEL is
  // still the canonical enum→label map (used by the row status pill),
  // and the segment tabs carry the same human-readable labels via
  // STATUS_SEGMENTS ("All cases" + the six bounded statuses).
  assert.match(
    CASES_PAGE,
    /const STATUS_LABEL: Record<CaseStatus, string> = \{\s*\n?\s*OPEN: "Open",\s*\n?\s*INVESTIGATING: "Investigating",\s*\n?\s*ON_HOLD: "On hold",\s*\n?\s*RESOLVED: "Resolved",\s*\n?\s*CLOSED: "Closed",\s*\n?\s*ARCHIVED: "Archived",\s*\n?\s*\};/,
  );
  // The status tabs are the ONLY status control and drive filters.status.
  assert.match(CASES_PAGE, /data-cases-status-segments/);
  assert.match(CASES_PAGE, /\{ value: "", label: "All cases" \}/);
  assert.match(CASES_PAGE, /onClick=\{\(\) => set\("status", seg\.value/);
  // The native "Any status" <select> must be gone.
  assert.doesNotMatch(CASES_PAGE, /data-matter-queue-status-select/);
});

test("Risk select is gated on canSeeAdvancedCaseOps (hidden on personal workspaces)", () => {
  // Find the risk select block and assert it sits inside a
  // `{canSeeAdvancedCaseOps ? (...) : null}` conditional.
  assert.match(
    CASES_PAGE,
    /\{canSeeAdvancedCaseOps \? \(\s*\n?\s*<select\s*\n?\s*aria-label="Risk level"/,
  );
});

test("Personal-mode chip strip is gone — no 'Open issues' or 'Missing report or package' chip renders", () => {
  // Phase CASES-PERSONAL-UX-CLEANUP removed every chip from the
  // Cases list page. The page is now Search + Status + Create +
  // cards + count + empty states only. Neither the personal chips
  // nor their data-keys may render anywhere on the surface.
  assert.doesNotMatch(CASES_PAGE, /dataKey="has-open-incidents"/);
  assert.doesNotMatch(CASES_PAGE, /dataKey="missing-artifact"/);
  assert.doesNotMatch(CASES_PAGE, /label="Missing report or package"/);
  // The chip-group container was deleted along with its chip
  // children — no aria-labelled Filters group remains.
  assert.doesNotMatch(CASES_PAGE, /aria-label="Filters"/);
});

test("Advanced-mode chip strip is gone — no 'Assigned to me' / 'Governance blockers' / 'Overdue workflows' / 'Active legal hold' chip renders", () => {
  // The advanced-mode chips were removed at the same time as the
  // personal ones. Enterprise users keep reaching the equivalent
  // backend filters via the matter-queue API directly (see the
  // Filter state shape test below).
  for (const dataKey of [
    "assigned-to-me",
    "has-governance-blockers",
    "has-overdue-workflows",
    "has-legal-hold",
  ]) {
    assert.doesNotMatch(
      CASES_PAGE,
      new RegExp(`dataKey="${dataKey}"`),
    );
  }
});

test("Filter state shape is unchanged — backend selectors are preserved (visibility-only gate)", () => {
  // Every original filter key must still exist on QueueFilters.
  for (const key of [
    "search",
    "status",
    "riskLevel",
    "assignedToMe",
    "hasOpenIncidents",
    "hasGovernanceBlockers",
    "hasOverdueWorkflows",
    "hasLegalHold",
    "missingArtifact",
  ]) {
    assert.match(
      CASES_PAGE,
      new RegExp(`${key}: `),
      `QueueFilters missing key ${key}`,
    );
  }
  // queryString still serialises every key when the corresponding
  // filter is active — proves the backend selectors stay reachable
  // even though some chips were hidden.
  for (const param of [
    'qs.set("status", filters.status)',
    'qs.set("riskLevel", filters.riskLevel)',
    'qs.set("assignedToUserId", viewerUserId)',
    'qs.set("hasOpenIncidents", "true")',
    'qs.set("hasGovernanceBlockers", "true")',
    'qs.set("hasOverdueWorkflows", "true")',
    'qs.set("hasLegalHold", "true")',
    'qs.set("missingArtifact", "true")',
  ]) {
    assert.ok(
      CASES_PAGE.includes(param),
      `queryString must still serialise: ${param}`,
    );
  }
});

// ===========================================================================
// Card simplification for personal users
// ===========================================================================

// §1 — the row is now a real enterprise TABLE (Case · Status · Owner ·
// Evidence · Readiness · Last updated · Actions). The old personal-card
// row (risk chip inline, "needs report or package" chip, "evidence
// record" counter, backend recommendation line) was replaced by aligned
// columns + an honest derived Readiness cell. The tests below pin the new
// structure. Advanced (enterprise) operational signals still exist but are
// grouped, gated on canSeeAdvancedCaseOps, under the Readiness cell.

test("Advanced-only operational signals (risk + counters) are grouped and gated on canSeeAdvancedCaseOps", () => {
  // The signals group only renders for advanced workspaces.
  assert.match(
    CASES_PAGE,
    /canSeeAdvancedCaseOps \? \(\s*\n?\s*<span className="cases-readiness-signals"[\s\S]{0,120}?<RiskBadge level=\{row\.riskLevel\} score=\{row\.riskScore\} \/>/,
  );
  // The granular counters live inside that gated group.
  for (const dataKey of [
    "evidence-gap",
    "open-incidents",
    "overdue-workflows",
    "governance-blockers",
  ]) {
    assert.match(
      CASES_PAGE,
      new RegExp(`<Counter dataKey="${dataKey}"`),
      `Counter ${dataKey} must still render inside the gated signals group`,
    );
  }
  // Legal-preservation chip is a span inside the same gated group.
  assert.match(CASES_PAGE, /Legal preservation/);
});

test("Readiness column is derived honestly (Not started / Needs attention / Ready), never risk language", () => {
  assert.match(CASES_PAGE, /const hasMissingArtifact = row\.evidenceGapCount > 0;/);
  assert.match(CASES_PAGE, /const readiness = isEmptyCase/);
  assert.match(CASES_PAGE, /label: "Not started"/);
  assert.match(CASES_PAGE, /label: "Needs attention"/);
  assert.match(CASES_PAGE, /label: "Ready"/);
  assert.match(CASES_PAGE, /data-matter-queue-row-readiness=\{readiness\.key\}/);
  // The invalid "operating within risk tolerance" recommendation line is
  // gone from the rendered output.
  assert.ok(
    !/Recommended: \{row\.recommendedAction\}/.test(CASES_PAGE),
    "recommendedAction line must be removed",
  );
});

test("Evidence column shows a plain record count ('record' / 'records')", () => {
  assert.match(CASES_PAGE, /data-matter-queue-row-evidence=\{row\.linkedEvidenceCount\}/);
  assert.match(
    CASES_PAGE,
    /row\.linkedEvidenceCount === 1 \? "record" : "records"/,
  );
});

test("The table has a visible column header including 'Last updated'", () => {
  assert.match(CASES_PAGE, /<div className="cases-table-head"/);
  assert.match(CASES_PAGE, /<span className="cases-th">Last updated<\/span>/);
  assert.match(
    CASES_PAGE,
    /\{formatRelativeTime\(row\.latestActivityAtUtc\)\}/,
  );
});

test("The row exposes a working overflow menu (Open / Rename / Change status / Archive / Delete)", () => {
  assert.match(CASES_PAGE, /role="menuitem"/);
  // Real actions, not dead links: archive POSTs an ARCHIVED status and
  // delete DELETEs the case (both confirmed), open/rename/change-status
  // navigate.
  assert.match(CASES_PAGE, /toStatus: "ARCHIVED"/);
  assert.match(CASES_PAGE, /apiFetch\(`\/v1\/cases\/\$\{caseId\}`, \{ method: "DELETE" \}\)/);
  for (const label of ["Open", "Rename", "Change status", "Archive", "Delete"]) {
    assert.match(
      CASES_PAGE,
      new RegExp(`>\\s*\\n?\\s*${label}\\s*\\n?\\s*<\\/button>`),
      `overflow menu must include a working '${label}' action`,
    );
  }
});

// ===========================================================================
// Empty states
// ===========================================================================

test("'No cases yet' empty state renders with spec-locked copy + Create-case CTA when total is 0 and no filters are active", () => {
  assert.match(
    CASES_PAGE,
    /totalBeforeFilter === 0 && !anyFilterActive \? \(/,
  );
  assert.match(
    CASES_PAGE,
    /data-empty-state="no-cases-yet"[\s\S]{0,200}?<strong>No cases yet<\/strong>[\s\S]{0,300}?Create a case to group related evidence for an incident,\s*\n?\s*claim, project, or review\./,
  );
  assert.match(
    CASES_PAGE,
    /data-empty-state-cta="create-case"[\s\S]{0,200}?>\s*\n?\s*Create case\s*\n?\s*<\/button>/,
  );
});

test("'No cases match these filters' empty state renders with spec copy + Clear-filters CTA when filters narrow to zero", () => {
  assert.match(
    CASES_PAGE,
    /data-empty-state="no-filter-match"[\s\S]{0,200}?<strong>No cases match these filters<\/strong>[\s\S]{0,300}?Try clearing filters or searching for a different case name\./,
  );
  assert.match(
    CASES_PAGE,
    /data-empty-state-cta="clear-filters"[\s\S]{0,200}?>\s*\n?\s*Clear filters\s*\n?\s*<\/button>/,
  );
});

test("Clear-filters CTA resets the filter state to DEFAULT_FILTERS", () => {
  assert.match(
    CASES_PAGE,
    /onClearFilters=\{\(\) => setFilters\(DEFAULT_FILTERS\)\}/,
  );
});

// ===========================================================================
// Backend not weakened
// ===========================================================================

test("Backend matter-queue route still accepts every filter parameter (selectors intact)", () => {
  assert.match(CASES_ROUTE, /"\/v1\/cases\/matter-queue"/);
  for (const field of [
    "status",
    "riskLevel",
    "assignedToUserId",
    "hasOpenIncidents",
    "hasGovernanceBlockers",
    "hasOverdueWorkflows",
    "hasLegalHold",
    "missingArtifact",
    "search",
  ]) {
    assert.match(
      CASES_ROUTE,
      new RegExp(`${field}: q\\.${field}`),
      `matter-queue route must still wire ${field}`,
    );
  }
});

test("Backend matter-queue service still computes the advanced filter shapes (no fields removed)", () => {
  // Confirm the service still surfaces the enterprise fields. The
  // frontend just chooses not to render them on personal workspaces.
  for (const field of [
    "linkedEvidenceCount",
    "openIncidentCount",
    "governanceBlockerCount",
    "overdueWorkflowCount",
    "activeLegalHoldCount",
    "evidenceGapCount",
    "riskScore",
    "riskLevel",
    "recommendedAction",
    "latestActivityAtUtc",
  ]) {
    assert.ok(
      MATTER_QUEUE_SVC.includes(field),
      `matter-queue service must still expose ${field}`,
    );
  }
});
