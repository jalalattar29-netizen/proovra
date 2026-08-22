"use client";

/**
 * PROOVRA Home — Evidence Operations landing page.
 *
 * Phase 7C VISUAL redesign. Home is now a clean, premium landing
 * surface — not the dense "operations center" diagnostic dump it grew
 * into. The default view answers three questions and nothing more:
 *
 *   • What is my workspace state?     → Executive Summary band
 *   • What do I have / what's ready?  → KPI cards
 *   • What needs me right now?        → Action needed + What needs attention
 *   • What did I capture recently?    → Recent evidence + Active matters
 *   • What do I want to do next?      → Primary actions row
 *
 * Everything else — the full trust posture, verification-links board,
 * workspace-health matrix, records-by-type donut, activity chart,
 * activity feed, intake-pipeline detail, report-production detail and
 * storage — is REAL, honest-null data and still shipped, but relegated
 * into a collapsed "Operational detail" disclosure so it doesn't drown
 * the landing page. Nothing was deleted; every data-testid/data-*
 * attribute those cards carry still renders (inside the disclosure).
 *
 * Data source is unchanged: one `useHomeData()` view-model. No new data,
 * no fabricated metrics — empty inputs still yield empty charts and the
 * honest "Not measured"/"—" fallbacks.
 *
 * Frame (Phase 7C): Home sits on the shared `PageShell` like every other
 * authenticated page — PageShell owns the page max-width, gutter and
 * section gap. It does NOT re-apply the home-theme `homePageStyle` outer
 * gutter (that would double the shell's horizontal padding). HomeHeader
 * still renders the greeting + primary CTA, so no `PageHeader` is added
 * (it would duplicate the <h1> and CTA).
 */

import { useState } from "react";

import { PageShell, PageSection } from "../ui";

import { useHomeData } from "./useHomeData";
import {
  ActiveMatters,
  ActivityFeed,
  GettingStartedChecklist,
  HomeSkeleton,
  IntakePipelineCard,
  ReportProductionCard,
  TeamWorkCard,
  TrustStateCard,
  VerificationHealthCard,
  WorkspaceHealthCard,
} from "./HomeSections";
import {
  EvidenceActivityChart,
  EvidenceTypeDonutCard,
  ExecutiveSummaryBand,
  HomeHeader,
  KpiRow,
  RecentEvidenceCard,
  WorkspacePrioritiesCard,
} from "./HomeDashboardSections";
// Track 1A — entitlement decisions come from SERVER-projected vm.features,
// never from the raw plan name.

export function SelfServeHomeDashboard() {
  const state = useHomeData();
  const [tab, setTab] = useState<HomeTabId>("overview");

  if (state.status === "loading") {
    return (
      <PageShell
        className="self-serve-home"
        data-self-serve-home
        data-self-serve-home-state="loading"
        style={pageShellStyle}
      >
        <HomeSkeleton />
      </PageShell>
    );
  }

  const vm = state.viewModel;
  // Server-projected entitlements (fail-closed booleans), not plan names.
  const reportsIncluded = vm.features.reportsIncluded;
  const intakeIncluded = vm.features.intakeIncluded;

  return (
    // Phase 7C — Home now sits on the shared PageShell frame like every
    // other authenticated page: PageShell owns the page max-width, the
    // horizontal/vertical gutter (`--page-pad-x`/`--page-pad-y`) and the
    // inter-section gap. The old home-theme `homePageStyle` outer gutter
    // is intentionally NOT applied here — letting PageShell own padding
    // avoids the double-gutter home-theme.ts warns about (shell 40px +
    // page 32px). HomeHeader keeps rendering the greeting + primary CTA
    // (data-home-header / data-home-primary-cta), so we deliberately do
    // NOT add a <PageHeader> — that would duplicate the <h1> and CTA.
    <PageShell
      className="self-serve-home"
      data-self-serve-home
      data-self-serve-home-state={state.status}
      data-self-serve-plan={vm.plan ?? "UNKNOWN"}
      style={pageShellStyle}
    >
      {/* Header — time-of-day greeting + one neutral navigation CTA
          (hero-aware: capture-first onboarding vs. "All evidence").
          Search / inbox live in the global app header, not duplicated. */}
      <HomeHeader hero={vm.heroAction} />

      {/* Enterprise information architecture — the single long page is now
          four focused workspace views (segmented control). Operations,
          Analytics and Activity relocate their modules off the Overview so
          the landing view answers only "what needs my attention now" and
          fits a desktop viewport with minimal scroll. All data wiring is
          unchanged; each module keeps its data-testid/data-* contract. */}
      <div
        className="home-tabs"
        role="tablist"
        aria-label="Workspace views"
        data-home-tabs
      >
        {HOME_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className="home-tab"
            data-home-tab={t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <div className="home-tabpanel" role="tabpanel" data-home-tabpanel="overview">
          {/* Operational summary band — one state, one sentence, one action. */}
          <ExecutiveSummaryBand summary={vm.executiveSummary} />

          {/* Five KPI cards — equal-width, equal-height 5-column grid
              (KpiRow renders the .home-kpi-grid internally). */}
          <KpiRow kpis={vm.kpis} />

          {/* Balanced two-column row — Workspace Health (moved here from the
              Analytics tab, in the old Action-Needed slot) beside What Needs
              Attention. The former standalone "Action Needed" queue is gone;
              its missing-package action is merged into What Needs Attention. */}
          <PageSection
            title="What needs you now"
            description="Workspace health and the priorities ranked by severity."
            style={sectionStyle}
          >
            <div style={rowQueueChartStyle}>
              <WorkspaceHealthCard
                metrics={vm.workspaceHealth}
                overall={vm.workspaceHealthOverall}
              />
              {vm.showGettingStarted ? (
                <GettingStartedChecklist
                  steps={vm.checklist}
                  complete={vm.checklistComplete}
                />
              ) : (
                <WorkspacePrioritiesCard
                  priorities={vm.workspacePriorities}
                  operations={vm.operations}
                />
              )}
            </div>
          </PageSection>

          {/* Recent evidence + active matters. */}
          <PageSection
            title="Your recent work"
            description="The latest evidence you captured and the matters in progress."
            style={sectionStyle}
          >
            <div style={rowTwoColStyle}>
              <RecentEvidenceCard rows={vm.richRecentEvidence} />
              <ActiveMatters rows={vm.activeMatters} summary={vm.caseHealthSummary} />
            </div>
          </PageSection>
        </div>
      ) : null}

      {tab === "operations" ? (
        <div className="home-tabpanel" role="tabpanel" data-home-tabpanel="operations">
          {/* Operational production modules — trust posture, verification
              health, report production, and the intake pipeline. */}
          <PageSection
            title="Verification & production"
            description="Trust posture, verification health, report production, and the intake pipeline."
            style={sectionStyle}
          >
            {/* Row 1 — Verification Summary + Public Verification Links,
                balanced. Row 2 — Report Production (wider track) beside the
                Intake Pipeline, so neither is cramped in a narrow 3-up. */}
            <div className="home-ops-row">
              <VerificationHealthCard health={vm.verificationHealth} />
              <TrustStateCard trust={vm.trustState} />
            </div>
            <div className="home-ops-row-2" style={{ marginTop: 16 }}>
              <ReportProductionCard production={vm.reportProduction} isFreePlan={!reportsIncluded} />
              <IntakePipelineCard
                pipeline={vm.intakePipeline}
                workspaceId={vm.workspaceId}
                onChanged={state.reload}
                locked={!intakeIncluded}
              />
            </div>
          </PageSection>
        </div>
      ) : null}

      {tab === "analytics" ? (
        <div className="home-tabpanel" role="tabpanel" data-home-tabpanel="analytics">
          {/* Row 1 — Records by Type + Evidence Activity (balanced two-col;
              Workspace Health moved to Overview). Row 2 — the full-width
              Recent Activity module. Storage lives in the sidebar. */}
          <PageSection
            title="Workspace analytics"
            description="Records by type, evidence activity, and recent activity."
            style={sectionStyle}
          >
            <div className="home-ops-row">
              <EvidenceTypeDonutCard
                distribution={vm.typeDistribution}
                preservedFiles={vm.preservedFilesByType}
              />
              <EvidenceActivityChart series={vm.activitySeries} />
            </div>
            <div style={{ marginTop: 16 }}>
              <ActivityFeed groups={vm.activity} />
            </div>
          </PageSection>

          {/* Team Work — organization workspaces only (null in Personal). */}
          {vm.teamWork ? <TeamWorkCard team={vm.teamWork} /> : null}
        </div>
      ) : null}
    </PageShell>
  );
}

type HomeTabId = "overview" | "operations" | "analytics";

const HOME_TABS: ReadonlyArray<{ id: HomeTabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "operations", label: "Operations" },
  { id: "analytics", label: "Analytics" },
];

// Phase 7C — PageShell owns the page frame (max-width, `--page-pad-x`,
// `--page-pad-y`, section gap), matching every other authenticated page.
// We do NOT re-apply the home-theme `homePageStyle` outer gutter here —
// that would double the shell's horizontal padding.
const pageShellStyle: React.CSSProperties = { paddingBottom: 40 };
// PageSection already owns its header margin; kill the extra block so the
// section title sits tight above its cards.
const sectionStyle: React.CSSProperties = { display: "block" };
// minmax(0, …) keeps charts/lists from forcing horizontal overflow on
// narrow viewports; auto-fit collapses to one column under ~720px. Gaps
// tightened (16px) so the dashboard reads dense + premium, not spread out.
const rowTwoColStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))",
  gap: 16,
  alignItems: "stretch",
};
const rowQueueChartStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))",
  gap: 16,
  alignItems: "stretch",
};
