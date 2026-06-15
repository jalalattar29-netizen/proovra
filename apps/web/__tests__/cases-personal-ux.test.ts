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
  assert.match(
    CASES_PAGE,
    /<p className="cc-subtitle" data-cases-subtitle>\s*\n?\s*Group related evidence into simple workspaces for incidents,\s*\n?\s*claims, projects, or reviews\./,
  );
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
  assert.match(
    CASES_PAGE,
    /setTimeout\(\(\) => \{\s*\n?\s*setAppliedSearch\(filters\.search\.trim\(\)\);\s*\n?\s*\}, 300\)/,
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

test("Cases page imports + computes `canSeeAdvancedCaseOps` via canAccessSurface('/investigation')", () => {
  assert.match(
    CASES_PAGE,
    /import \{ canAccessSurface \} from "\.\.\/\.\.\/lib\/surface\/access";/,
  );
  assert.match(
    CASES_PAGE,
    /import \{ useSurfaceUserContext \} from "\.\.\/\.\.\/lib\/surface\/useSurfaceUserContext";/,
  );
  assert.match(
    CASES_PAGE,
    /const canSeeAdvancedCaseOps = canAccessSurface\(\s*\n?\s*surfaceUserCtx,\s*\n?\s*"\/investigation",\s*\n?\s*\);/,
  );
  // Anti-regression: no hardcoded plan name strings driving the gate.
  assert.doesNotMatch(
    CASES_PAGE,
    /=== "ENTERPRISE"|=== "FREE"|=== "PROFESSIONAL"/,
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

test("Status select stays visible for everyone and uses human-readable labels", () => {
  assert.match(
    CASES_PAGE,
    /const STATUS_LABEL: Record<\(typeof CASE_STATUSES\)\[number\], string> = \{\s*\n?\s*OPEN: "Open",\s*\n?\s*INVESTIGATING: "Investigating",\s*\n?\s*ON_HOLD: "On hold",\s*\n?\s*RESOLVED: "Resolved",\s*\n?\s*CLOSED: "Closed",\s*\n?\s*ARCHIVED: "Archived",\s*\n?\s*\};/,
  );
  assert.match(CASES_PAGE, /\{STATUS_LABEL\[s\]\}/);
});

test("Risk select is gated on canSeeAdvancedCaseOps (hidden on personal workspaces)", () => {
  // Find the risk select block and assert it sits inside a
  // `{canSeeAdvancedCaseOps ? (...) : null}` conditional.
  assert.match(
    CASES_PAGE,
    /\{canSeeAdvancedCaseOps \? \(\s*\n?\s*<select\s*\n?\s*aria-label="Risk level"/,
  );
});

test("'Open issues' + 'Missing report or package' chips render for ALL audiences", () => {
  // Both chips must NOT sit inside the advanced-gate conditional.
  // We check the data-keys appear BEFORE the first
  // `{canSeeAdvancedCaseOps ? (` inside the chips block.
  const chipsBlockStart = CASES_PAGE.indexOf('aria-label="Filters"');
  assert.ok(chipsBlockStart > 0);
  const advancedGateAfterChips = CASES_PAGE.indexOf(
    "{canSeeAdvancedCaseOps ? (",
    chipsBlockStart,
  );
  assert.ok(advancedGateAfterChips > chipsBlockStart);
  const unconditionalRegion = CASES_PAGE.slice(chipsBlockStart, advancedGateAfterChips);
  assert.match(unconditionalRegion, /dataKey="has-open-incidents"/);
  assert.match(unconditionalRegion, /dataKey="missing-artifact"/);
  // Spec asks for the plain-language label.
  assert.match(unconditionalRegion, /label="Missing report or package"/);
});

test("'Assigned to me', 'Governance blockers', 'Overdue workflows', 'Active legal hold' chips are gated on canSeeAdvancedCaseOps", () => {
  const chipsBlockStart = CASES_PAGE.indexOf('aria-label="Filters"');
  const chipsBlockEnd = CASES_PAGE.indexOf("</section>", chipsBlockStart);
  const advancedGateStart = CASES_PAGE.indexOf(
    "{canSeeAdvancedCaseOps ? (",
    chipsBlockStart,
  );
  const advancedGateRegion = CASES_PAGE.slice(advancedGateStart, chipsBlockEnd);
  assert.match(advancedGateRegion, /dataKey="assigned-to-me"/);
  assert.match(advancedGateRegion, /dataKey="has-governance-blockers"/);
  assert.match(advancedGateRegion, /dataKey="has-overdue-workflows"/);
  assert.match(advancedGateRegion, /dataKey="has-legal-hold"/);
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

test("Risk badge on the row is gated on canSeeAdvancedCaseOps", () => {
  assert.match(
    CASES_PAGE,
    /\{canSeeAdvancedCaseOps \? \(\s*\n?\s*<RiskBadge level=\{row\.riskLevel\} score=\{row\.riskScore\} \/>/,
  );
});

test("All granular counters (incidents, workflows, overdue, governance, hold, assignments, gap) are gated on canSeeAdvancedCaseOps", () => {
  for (const dataKey of [
    "open-incidents",
    "active-workflows",
    "overdue-workflows",
    "governance-blockers",
    "assignments",
    "evidence-gap",
  ]) {
    assert.match(
      CASES_PAGE,
      new RegExp(
        `canSeeAdvancedCaseOps && row\\.[a-zA-Z]+(?:Count|Score) > 0 \\? \\(\\s*\\n?\\s*<Counter\\s*\\n?\\s*dataKey="${dataKey}"`,
      ),
      `Counter ${dataKey} must be gated on canSeeAdvancedCaseOps`,
    );
  }
  // Legal-preservation chip is a span, not a Counter.
  assert.match(
    CASES_PAGE,
    /canSeeAdvancedCaseOps && row\.activeLegalHoldCount > 0 \? \(\s*\n?\s*<span[\s\S]{0,300}?Legal preservation/,
  );
});

test("Personal card surfaces a single plain-language 'needs report or package' chip when gaps exist", () => {
  assert.match(CASES_PAGE, /const hasMissingArtifact = row\.evidenceGapCount > 0;/);
  assert.match(
    CASES_PAGE,
    /!canSeeAdvancedCaseOps && hasMissingArtifact \? \(\s*\n?\s*<span[\s\S]{0,400}?data-matter-queue-row-chip="needs-artifact"[\s\S]{0,400}?records? need[s]? report or package/,
  );
});

test("Linked-evidence counter on the row uses plain language ('evidence record / evidence records')", () => {
  assert.match(
    CASES_PAGE,
    /label=\{row\.linkedEvidenceCount === 1 \? "evidence record" : "evidence records"\}/,
  );
});

test("Personal fallback recommendation surfaces when no backend recommendedAction is set but there is a gap", () => {
  // Three independent anchors; the gaps between them include the
  // JSX comment so the previous narrow window missed.
  assert.match(CASES_PAGE, /:\s*!canSeeAdvancedCaseOps && hasMissingArtifact \?/);
  assert.match(CASES_PAGE, /data-recommendation-source="personal-fallback"/);
  assert.match(
    CASES_PAGE,
    /Generate the missing report or package from the evidence detail page\./,
  );
});

test("Last-updated time uses the spec phrasing 'Last updated …'", () => {
  assert.match(
    CASES_PAGE,
    /Last updated \{formatRelativeTime\(row\.latestActivityAtUtc\)\}/,
  );
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
