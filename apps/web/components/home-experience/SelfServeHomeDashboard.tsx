"use client";

/**
 * Phase IA-home-v2 — workflow-centric self-serve Home.
 *
 * Information architecture (top → bottom), organized around jobs, not
 * database tables:
 *
 *   Header  : workspace context + workflow launchers
 *   BAND 1 — "What needs me"
 *     • Hero Next Action (expanded, prioritized)
 *     • Submissions needing review (only when present)
 *   BAND 2 — "My work"
 *     • Request & Collect          • Recent Evidence (integrity chips)
 *     • Case Health                • Recent Reports
 *   BAND 3 — "Is it trustworthy"
 *     • Trust State (live counts)  • Activity (grouped)
 *     • Storage                    • Team work (PRO/TEAM)
 *   Getting Started (auto-collapses when complete)
 *
 * Solo (Personal Space) sees the same surface minus team work and the
 * PRO-only launchers. No reviewer/governance language anywhere.
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
  WorkflowLaunchers,
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
      <header style={headerStyle}>
        <div>
          <h1 style={titleStyle}>{pro ? "Your workspace" : "Your evidence workspace"}</h1>
          <p style={subtitleStyle}>What needs you, what you collected, and whether it's trustworthy.</p>
        </div>
        <WorkflowLaunchers launchers={vm.launchers} />
      </header>

      {/* BAND 1 — What needs me */}
      <HeroNextAction action={vm.heroAction} />
      <SubmissionsToReview rows={vm.submissions} />

      {/* BAND 2 — My work */}
      <div style={rowTwoColStyle}>
        {pro ? <RequestAndCollect rows={vm.collection} /> : <RecentEvidence rows={vm.recentEvidence} />}
        {pro ? <RecentEvidence rows={vm.recentEvidence} /> : <RecentReports rows={vm.recentReports} isFreePlan={free} />}
      </div>
      <div style={rowTwoColStyle}>
        <CaseHealthCard rows={vm.caseHealth} />
        {pro ? <RecentReports rows={vm.recentReports} isFreePlan={free} /> : <StorageUsageCard usage={vm.storage} />}
      </div>

      {/* BAND 3 — Is it trustworthy */}
      <div style={rowTwoColStyle}>
        <TrustStateCard trust={vm.trustState} />
        <ActivityFeed groups={vm.activity} />
      </div>
      <div style={rowTwoColStyle}>
        {pro ? <StorageUsageCard usage={vm.storage} /> : <GettingStartedChecklist steps={vm.checklist} complete={vm.checklistComplete} />}
        {pro ? <TeamWorkCard team={vm.teamWork} /> : null}
      </div>

      {pro ? (
        <GettingStartedChecklist steps={vm.checklist} complete={vm.checklistComplete} />
      ) : null}
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
const headerStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 12, marginBottom: 4 };
const titleStyle: React.CSSProperties = { fontSize: 24, fontWeight: 700, margin: 0 };
const subtitleStyle: React.CSSProperties = { margin: "4px 0 0 0", fontSize: 14, color: "#5d6d71" };
const rowTwoColStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 };
