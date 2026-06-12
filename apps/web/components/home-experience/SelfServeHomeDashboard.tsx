"use client";

/**
 * PROOVRA Home — operational command surface.
 *
 * This is not a second sidebar. It is the daily operating view for solo
 * professionals, lawyers, journalists, investigators, consultants and
 * small firms. Top to bottom it answers: what needs me now, which matters
 * are incomplete, where my collection is, what deliverables are ready or
 * failed, whether my evidence is trustworthy and verifiable, and what
 * changed recently.
 *
 * Layout (Phase HOME-KPI):
 *   Header  : greeting + search + inbox indicator + ONE primary action
 *   Band 0  : KPI row (5 cards — all real data)
 *   Band 1  : Operational Queue (2fr) | Evidence Activity chart (3fr)
 *   Band 2  : Recent Evidence | Evidence by Type
 *   Band 3  : Active Matters | Intake Pipeline
 *   Band 4  : Report Production | Verification Health
 *   Band 5  : Trust State | Workspace Health
 *   Band 6  : Recent Activity | Storage + Getting Started
 *   Trailing: Team Work (organization workspaces only — never Personal)
 */

import { useHomeData } from "./useHomeData";
import {
  ActiveMatters,
  ActivityFeed,
  GettingStartedChecklist,
  HomeSkeleton,
  IntakePipelineCard,
  OperationalQueue,
  ReportProductionCard,
  StorageUsageCard,
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
import { homePageStyle } from "./home-theme";
import { isFreePlan, isProOrTeam } from "./home-view-model";

export function SelfServeHomeDashboard() {
  const state = useHomeData();

  if (state.status === "loading") {
    return (
      <main className="self-serve-home" data-self-serve-home data-self-serve-home-state="loading" style={pageStyle}>
        <HomeSkeleton />
      </main>
    );
  }

  const vm = state.viewModel;
  const free = isFreePlan(vm.plan);
  const pro = isProOrTeam(vm.plan);

  return (
    <main
      className="self-serve-home"
      data-self-serve-home
      data-self-serve-home-state={state.status}
      data-self-serve-plan={vm.plan ?? "UNKNOWN"}
      style={pageStyle}
    >
      {/* Header — greeting, search, inbox indicator, one primary action. */}
      <HomeHeader
        workspaceName={vm.workspaceName}
        inboxCount={vm.inboxCount}
        hero={vm.heroAction}
      />

      {/* Band 0 — Executive Summary (one state, one sentence, one
          action — Phase HOME-EXEC) + KPI row (real numbers only). */}
      <ExecutiveSummaryBand summary={vm.executiveSummary} />
      <KpiRow kpis={vm.kpis} />

      {/* Band 1 — Operational Queue (what needs me NOW) + activity chart. */}
      <div style={rowQueueChartStyle}>
        <OperationalQueue
          items={vm.operationalQueue}
          hero={vm.heroAction}
          workspaceId={vm.workspaceId}
          onChanged={state.reload}
        />
        <EvidenceActivityChart series={vm.activitySeries} />
      </div>

      {/* Band 2 — Recent Evidence + type distribution. */}
      <div style={rowTwoColStyle}>
        <RecentEvidenceCard rows={vm.richRecentEvidence} />
        <EvidenceTypeDonutCard distribution={vm.typeDistribution} />
      </div>

      {/* Band 3 — Active Matters + Intake Pipeline. */}
      <div style={rowTwoColStyle}>
        <ActiveMatters rows={vm.activeMatters} summary={vm.caseHealthSummary} />
        <IntakePipelineCard
          pipeline={vm.intakePipeline}
          workspaceId={vm.workspaceId}
          onChanged={state.reload}
          locked={!pro}
        />
      </div>

      {/* Band 4 — Report Production + Verification Health. */}
      <div style={rowTwoColStyle}>
        <ReportProductionCard production={vm.reportProduction} isFreePlan={free} />
        <VerificationHealthCard health={vm.verificationHealth} />
      </div>

      {/* Band 5 — Trust State + Workspace Health. */}
      <div style={rowTwoColStyle}>
        <TrustStateCard trust={vm.trustState} />
        <WorkspaceHealthCard metrics={vm.workspaceHealth} overall={vm.workspaceHealthOverall} />
      </div>

      {/* Band 6 — Recent Activity + Storage / onboarding-or-priorities.
          Phase HOME-POLISH: Getting Started renders for TRULY NEW users
          only; active users get real Workspace Priorities instead. */}
      <div style={rowTwoColStyle}>
        <ActivityFeed groups={vm.activity} />
        <div style={stackColStyle}>
          <StorageUsageCard usage={vm.storage} />
          {vm.showGettingStarted ? (
            <GettingStartedChecklist steps={vm.checklist} complete={vm.checklistComplete} />
          ) : (
            <WorkspacePrioritiesCard priorities={vm.workspacePriorities} />
          )}
        </div>
      </div>

      {/* Team Work — organization workspaces only (null in Personal Space). */}
      {vm.teamWork ? <TeamWorkCard team={vm.teamWork} /> : null}
    </main>
  );
}

// Phase HOME-POLISH — the soft pearl surface from home-theme.ts.
const pageStyle: React.CSSProperties = homePageStyle;
// minmax(0, …) keeps charts/lists from forcing horizontal overflow on
// narrow viewports; auto-fit collapses to one column under ~720px.
const rowTwoColStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))",
  gap: 14,
};
const rowQueueChartStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))",
  gap: 14,
  alignItems: "start",
};
const stackColStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 14 };
