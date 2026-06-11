"use client";

/**
 * Phase IA-self-serve-home-rebuild + Phase IA-home-polish — production
 * self-serve Home.
 *
 * Layout (top to bottom):
 *
 *   Header     : Title + Compact Quick Actions
 *   Row 1      : Workspace Snapshot (5 tiles)
 *   Row 2      : Next Action + Storage Usage
 *   Row 3      : Recent Evidence + Recent Cases
 *   Row 4      : Recent Reports + Pipeline (or onboarding when empty)
 *   Row 5      : Recent Activity + Evidence Health
 *   Row 6      : Team Activity (PRO/TEAM) + Getting Started
 *   Row 7      : Trust Summary + Integrity Alerts (when non-empty)
 *
 * Data sources (all pre-existing — NO new APIs introduced):
 *   * GET /v1/dashboard/command-center   — allowlisted slice only
 *   * GET /v1/billing/overview           — storage usage
 *   * GET /v1/reports?teamId=<id>        — workspace-scoped reports
 *   * envelope.organizations             — team activity (PRO/TEAM)
 */

import { useHomeData } from "./useHomeData";
import {
  CompactQuickActions,
  EvidenceHealthCard,
  GettingStartedChecklist,
  HomeSkeleton,
  IntegrityAlerts,
  NextActionCard,
  PipelineSnapshot,
  RecentActivity,
  RecentCases,
  RecentEvidence,
  RecentReports,
  StorageUsageCard,
  TeamActivityCard,
  TrustSummary,
  WorkspaceSnapshot,
} from "./HomeSections";
import { isFreePlan } from "./home-view-model";

export function SelfServeHomeDashboard() {
  const state = useHomeData();

  if (state.status === "loading") {
    return (
      <main
        className="self-serve-home"
        data-self-serve-home
        data-self-serve-home-state="loading"
        style={pageStyle}
      >
        <HomeSkeleton />
      </main>
    );
  }

  const vm = state.viewModel;
  const free = isFreePlan(vm.plan);

  return (
    <main
      className="self-serve-home"
      data-self-serve-home
      data-self-serve-home-state={state.status}
      data-self-serve-plan={vm.plan ?? "UNKNOWN"}
      style={pageStyle}
    >
      <header style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Your evidence workspace</h1>
          <p style={subtitleStyle}>
            Records, cases, reports and storage at a glance.
          </p>
        </div>
        <CompactQuickActions actions={vm.quickActions} />
      </header>

      <WorkspaceSnapshot tiles={vm.snapshot} />

      <div style={rowTwoColStyle}>
        <NextActionCard action={vm.nextAction} />
        <StorageUsageCard usage={vm.storage} />
      </div>

      <div style={rowTwoColStyle}>
        <RecentEvidence rows={vm.recentEvidence} />
        <RecentCases rows={vm.recentCases} />
      </div>

      <div style={rowTwoColStyle}>
        <RecentReports rows={vm.recentReports} isFreePlan={free} />
        <PipelineSnapshot stages={vm.pipeline} empty={vm.pipelineEmpty} />
      </div>

      <div style={rowTwoColStyle}>
        <RecentActivity events={vm.activity} />
        <EvidenceHealthCard health={vm.health} />
      </div>

      <div style={rowTwoColStyle}>
        <TeamActivityCard team={vm.teamActivity} />
        <GettingStartedChecklist steps={vm.checklist} />
      </div>

      <div style={rowTwoColStyle}>
        <TrustSummary />
        <IntegrityAlerts alerts={vm.integrityAlerts} />
      </div>
    </main>
  );
}

const pageStyle: React.CSSProperties = {
  maxWidth: 1200,
  margin: "0 auto",
  padding: "28px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  display: "flex",
  flexDirection: "column",
  gap: 18,
  background: "#f8fafc",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  marginBottom: 4,
};
const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  margin: 0,
};
const subtitleStyle: React.CSSProperties = {
  margin: 0,
  marginTop: 4,
  fontSize: 14,
  color: "#5d6d71",
};
const rowTwoColStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 14,
};
