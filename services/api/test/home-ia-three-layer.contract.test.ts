/**
 * Home information-architecture lock (updated for the APPROVED tabbed IA
 * that supersedes both the old 3-layer HomeLayerHeader and the interim
 * "landing + data-home-diagnostics disclosure" layout).
 *
 * Home is now a segmented workspace with three views — Overview,
 * Operations, Analytics — rendered as tab panels:
 *
 *   • OVERVIEW leads with the operational summary + KPIs + the
 *     consolidated "what needs you now" priorities surface
 *     (`WorkspacePrioritiesCard`, which absorbed the old standalone
 *     OperationalQueue) + recent work. It is the default, above-the-fold
 *     view and must NOT carry the dense diagnostic cards.
 *   • OPERATIONS owns verification/trust/report-production/intake.
 *   • ANALYTICS owns the records-by-type donut, the activity chart and
 *     the activity feed.
 *
 * This test pins that contract. If a future pass dumps the heavy
 * diagnostic cards back into the Overview panel (the regression the tabbed
 * IA fixed), or reintroduces the standalone `<OperationalQueue`, it fails.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const DASH = readFileSync(
  resolve(
    REPO_ROOT,
    "apps/web/components/home-experience/SelfServeHomeDashboard.tsx",
  ),
  "utf8",
);

function indexOfOrThrow(needle: string): number {
  const idx = DASH.indexOf(needle);
  if (idx < 0) throw new Error(`Missing in dashboard source: ${needle}`);
  return idx;
}

// The Overview panel is the default landing region; the Operations panel
// marker is the boundary between it and the deeper diagnostic views.
const OVERVIEW_PANEL = 'data-home-tabpanel="overview"';
const OPERATIONS_PANEL = 'data-home-tabpanel="operations"';
const ANALYTICS_PANEL = 'data-home-tabpanel="analytics"';

describe("Home tabbed IA — Overview leads, diagnostics live in Operations/Analytics", () => {
  it("renders the three approved workspace views (Overview / Operations / Analytics)", () => {
    expect(DASH).toMatch(/data-home-tabpanel="overview"/);
    expect(DASH).toMatch(/data-home-tabpanel="operations"/);
    expect(DASH).toMatch(/data-home-tabpanel="analytics"/);
  });

  it("the Overview panel LEADS: ExecutiveSummary + KPI + consolidated priorities + RecentEvidence", () => {
    const start = indexOfOrThrow(OVERVIEW_PANEL);
    const end = indexOfOrThrow(OPERATIONS_PANEL);
    const overview = DASH.slice(start, end);
    expect(overview).toMatch(/<ExecutiveSummaryBand/);
    expect(overview).toMatch(/<KpiRow/);
    // The consolidated priorities surface replaced the standalone
    // OperationalQueue and is the first attention module in Overview.
    expect(overview).toMatch(/<WorkspacePrioritiesCard/);
    expect(overview).toMatch(/<RecentEvidenceCard/);
  });

  it("the heavy diagnostic cards do NOT appear in the default Overview panel", () => {
    const start = indexOfOrThrow(OVERVIEW_PANEL);
    const end = indexOfOrThrow(OPERATIONS_PANEL);
    const overview = DASH.slice(start, end);
    // These dense signals live in Operations / Analytics, never on the
    // default Overview view.
    expect(overview).not.toMatch(/<TrustStateCard/);
    expect(overview).not.toMatch(/<EvidenceTypeDonutCard/);
    expect(overview).not.toMatch(/<EvidenceActivityChart/);
    expect(overview).not.toMatch(/<ActivityFeed/);
  });

  it("Operations + Analytics OWN the deep diagnostic cards (relegated, not deleted)", () => {
    const boundary = indexOfOrThrow(OPERATIONS_PANEL);
    const belowOverview = DASH.slice(boundary);
    expect(belowOverview).toMatch(/<VerificationHealthCard/);
    expect(belowOverview).toMatch(/<TrustStateCard/);
    expect(belowOverview).toMatch(/<ReportProductionCard/);
    expect(belowOverview).toMatch(/<EvidenceTypeDonutCard/);
    expect(belowOverview).toMatch(/<EvidenceActivityChart/);
    expect(belowOverview).toMatch(/<ActivityFeed/);
    // Sanity: the analytics panel really is below the operations boundary.
    expect(belowOverview).toMatch(/data-home-tabpanel="analytics"/);
    // Anchor the analytics marker so the constant is exercised.
    expect(DASH.indexOf(ANALYTICS_PANEL)).toBeGreaterThan(boundary);
  });

  /**
   * CONTRACT MIGRATION — Attention Architecture Phase 4C (2026-08-22).
   *
   * The first half of this assertion is unchanged and still holds: there is no
   * standalone `<OperationalQueue>` widget on Home.
   *
   * The second half said the queue's DATA was "not discarded" and flowed into
   * the priorities card. That data was the caller's own notification feed
   * reshaped as workspace state, and it is now discarded, deliberately. What
   * flows into the priorities card instead is the canonical workspace
   * Operations summary — shared truth, read from one authority, used by the
   * card for exactly one decision: whether it is entitled to say "All clear".
   */
  it("no standalone OperationalQueue, and the priorities card consumes the SHARED summary", () => {
    expect(DASH).not.toMatch(/<OperationalQueue/);
    expect(DASH).toMatch(
      /<WorkspacePrioritiesCard[\s\S]{0,200}?operations=\{vm\.operations\}/,
    );
    // The old personal-feed wiring must not survive anywhere on the surface.
    expect(DASH).not.toMatch(/operationalQueue=\{/);
  });
});
