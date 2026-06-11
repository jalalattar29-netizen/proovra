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
 * Layout (fixed):
 *   Header  : workspace context, no button row
 *   Band 1  : Operational Queue
 *   Band 2  : Active Matters | Intake Pipeline
 *   Band 3  : Report Production | Verification Health
 *   Band 4  : Trust State | Workspace Health
 *   Band 5  : Recent Activity
 *   Band 6  : Storage | Getting Started (new users only)
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
      {/* Header — workspace context only, no nav-duplicate button row. */}
      <header style={headerStyle}>
        <h1 style={titleStyle}>Your evidence operation</h1>
        <p style={subtitleStyle}>Evidence, intake, reports, and verification in one operational view.</p>
      </header>

      {/* Band 1 — Operational Queue (the most important widget, first). */}
      <OperationalQueue
        items={vm.operationalQueue}
        hero={vm.heroAction}
        workspaceId={vm.workspaceId}
        onChanged={state.reload}
      />

      {/* Band 2 — Active Matters + Intake Pipeline. */}
      <div style={rowTwoColStyle}>
        <ActiveMatters rows={vm.activeMatters} summary={vm.caseHealthSummary} />
        <IntakePipelineCard
          pipeline={vm.intakePipeline}
          workspaceId={vm.workspaceId}
          onChanged={state.reload}
          locked={!pro}
        />
      </div>

      {/* Band 3 — Report Production + Verification Health. */}
      <div style={rowTwoColStyle}>
        <ReportProductionCard production={vm.reportProduction} isFreePlan={free} />
        <VerificationHealthCard health={vm.verificationHealth} />
      </div>

      {/* Band 4 — Trust State + Workspace Health. */}
      <div style={rowTwoColStyle}>
        <TrustStateCard trust={vm.trustState} />
        <WorkspaceHealthCard metrics={vm.workspaceHealth} />
      </div>

      {/* Band 5 — Recent Activity (full width). */}
      <ActivityFeed groups={vm.activity} />

      {/* Band 6 — Storage + Getting Started (new users only; auto-hides). */}
      <div style={rowTwoColStyle}>
        <StorageUsageCard usage={vm.storage} />
        <GettingStartedChecklist steps={vm.checklist} complete={vm.checklistComplete} />
      </div>

      {/* Team Work — organization workspaces only (null in Personal Space). */}
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
