"use client";

/**
 * Phase IA-home-final — operational evidence dashboard.
 *
 * Exact information architecture (Phase 15), organized around the
 * user's work, with NO sidebar-duplicating button row and NO broken
 * CTAs:
 *
 *   Top   : workspace title + contextual subtitle (no buttons)
 *   Band 1: Needs Attention (single contextual primary action)
 *   Band 2: Submissions Waiting Review + Request & Collect
 *   Band 3: Recent Evidence + Recent Reports
 *   Band 4: Trust State + Case Health
 *   Band 5: Activity + Storage
 *   Optional: Getting Started — only for true first-time users
 *
 * Personal Space: no Team Work. PRO/TEAM in an organization workspace:
 * Team Work appears below Getting Started. Every CTA points at a route
 * that renders (verified by phase-ia-home-cta-validation).
 */

import { useHomeData } from "./useHomeData";
import {
  ActivityFeed,
  CaseHealthCard,
  GettingStartedChecklist,
  HeroNextAction,
  HomeSkeleton,
  RecentEvidence,
  RecentReports,
  RequestAndCollect,
  StorageUsageCard,
  SubmissionsToReview,
  TeamWorkCard,
  TrustStateCard,
} from "./HomeSections";
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
      {/* Top — title + subtitle, NO nav-duplicate button row. */}
      <header style={headerStyle}>
        <h1 style={titleStyle}>Your evidence workspace</h1>
        <p style={subtitleStyle}>What needs you, what you collected, and whether it&apos;s trustworthy.</p>
      </header>

      {/* Band 1 — Needs Attention */}
      <HeroNextAction action={vm.heroAction} />

      {/* Band 2 — Submissions + Request & Collect */}
      {pro ? (
        <div style={rowTwoColStyle}>
          <SubmissionsToReview rows={vm.submissions} />
          <RequestAndCollect rows={vm.collection} />
        </div>
      ) : (
        <SubmissionsToReview rows={vm.submissions} />
      )}

      {/* Band 3 — Recent Evidence + Recent Reports */}
      <div style={rowTwoColStyle}>
        <RecentEvidence rows={vm.recentEvidence} />
        <RecentReports rows={vm.recentReports} isFreePlan={free} />
      </div>

      {/* Band 4 — Trust State + Case Health */}
      <div style={rowTwoColStyle}>
        <TrustStateCard trust={vm.trustState} />
        <CaseHealthCard rows={vm.caseHealth} />
      </div>

      {/* Band 5 — Activity + Storage */}
      <div style={rowTwoColStyle}>
        <ActivityFeed groups={vm.activity} />
        <StorageUsageCard usage={vm.storage} />
      </div>

      {/* Optional — Getting Started (auto-hides when complete). */}
      <GettingStartedChecklist steps={vm.checklist} complete={vm.checklistComplete} />

      {/* Team Work — only inside an organization workspace (null in Personal Space). */}
      {vm.teamWork ? <TeamWorkCard team={vm.teamWork} /> : null}
    </main>
  );
}

const pageStyle: React.CSSProperties = {
  maxWidth: 1200,
  margin: "0 auto",
  padding: "28px 24px",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  display: "flex",
  flexDirection: "column",
  gap: 18,
  background: "#f8fafc",
};
const headerStyle: React.CSSProperties = { marginBottom: 4 };
const titleStyle: React.CSSProperties = { fontSize: 24, fontWeight: 700, margin: 0 };
const subtitleStyle: React.CSSProperties = { margin: "4px 0 0 0", fontSize: 14, color: "#5d6d71" };
const rowTwoColStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 };
