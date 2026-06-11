"use client";

/**
 * Phase IA-self-serve-home-rebuild — production self-serve Home.
 *
 * Replaces the previous Phase IA-self-serve-simplification scaffolding
 * (which rendered placeholder dashes and static copy with no APIs)
 * with a real evidence-workspace dashboard. Layout in 6 rows:
 *
 *   Row 1: Workspace Snapshot (5 tiles)
 *   Row 2: Next Action + Storage Usage
 *   Row 3: Recent Evidence + Recent Cases
 *   Row 4: Recent Reports + Pipeline Snapshot
 *   Row 5: Team Activity (PRO/TEAM) + Getting Started
 *   Row 6: Integrity Alerts (when non-empty) + Trust Summary
 *
 * Data sources (all pre-existing — NO new APIs introduced):
 *   * GET /v1/dashboard/command-center  — allowlisted slice only
 *   * GET /v1/billing/overview          — storage usage
 *   * GET /v1/reports                   — user-scoped reports list
 *   * envelope.organizations            — team activity (PRO/TEAM)
 *
 * The `home-view-model.ts` normalizer is the single boundary between
 * the raw envelope and the UI; this file just maps the view model
 * onto presentational components and never touches enterprise
 * sections (see ENTERPRISE_ONLY_SECTIONS in the view model).
 *
 * Vocabulary rules carried forward:
 *   * No "operational", "governance posture", "reviewer-ops",
 *     "SLA", "intelligence platform", "queue congestion", etc.
 *   * Plain labels only: Evidence records, Cases, Reports,
 *     Verification links, Storage, Pipeline, Trust.
 */

import { useHomeData } from "./useHomeData";
import {
  GettingStartedChecklist,
  HomeSkeleton,
  IntegrityAlerts,
  NextActionCard,
  PipelineSnapshot,
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
        <h1 style={titleStyle}>Your evidence workspace</h1>
        <p style={subtitleStyle}>
          Records, cases, reports and storage at a glance.
        </p>
      </header>

      {/* Row 1 — Workspace Snapshot */}
      <WorkspaceSnapshot tiles={vm.snapshot} />

      {/* Row 2 — Next Action + Storage */}
      <div style={rowTwoColStyle}>
        <NextActionCard action={vm.nextAction} />
        <StorageUsageCard usage={vm.storage} />
      </div>

      {/* Row 3 — Recent Evidence + Recent Cases */}
      <div style={rowTwoColStyle}>
        <RecentEvidence rows={vm.recentEvidence} />
        <RecentCases rows={vm.recentCases} />
      </div>

      {/* Row 4 — Recent Reports + Pipeline */}
      <div style={rowTwoColStyle}>
        <RecentReports rows={vm.recentReports} isFreePlan={free} />
        <PipelineSnapshot stages={vm.pipeline} />
      </div>

      {/* Row 5 — Team Activity (PRO/TEAM) + Getting Started */}
      <div style={rowTwoColStyle}>
        <TeamActivityCard team={vm.teamActivity} />
        <GettingStartedChecklist steps={vm.checklist} />
      </div>

      {/* Row 6 — Integrity Alerts (when non-empty) + Trust Summary */}
      <div style={rowTwoColStyle}>
        <IntegrityAlerts alerts={vm.integrityAlerts} />
        <TrustSummary />
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
