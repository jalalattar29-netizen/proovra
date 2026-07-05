"use client";

/**
 * PROOVRA Home — operational command surface.
 *
 * Daily operating view for solo professionals, lawyers, journalists,
 * investigators, consultants and small firms.
 *
 * Layout (Phase HOME-IA, 3-layer):
 *
 *   Header — greeting + search + inbox + ONE primary action
 *
 *   ───────────────────────────────────────────────────────────────
 *   Layer 1 — Overview ("what do I have, what's ready, what needs me")
 *   ───────────────────────────────────────────────────────────────
 *     • Executive Summary (one state, one sentence, one action)
 *     • KPI row (5 real numbers)
 *
 *   ───────────────────────────────────────────────────────────────
 *   Layer 2 — Your work right now ("the operational pile")
 *   ───────────────────────────────────────────────────────────────
 *     • Action needed (Op Queue)        | What needs attention
 *     • Active Matters                  | Intake Pipeline
 *     • Report Production               | Recent Evidence
 *
 *   ───────────────────────────────────────────────────────────────
 *   Layer 3 — Verification & details ("trust + technical context")
 *   ───────────────────────────────────────────────────────────────
 *     • Verification summary            | Public verification links
 *     • Workspace health                | Records by type
 *     • Evidence activity (chart)       | Recent activity
 *     • Storage usage                   | (Getting Started / extras)
 *
 *   Trailing — Team Work (organization workspaces only)
 *
 * Layer headings are visual dividers, not navigation. They reduce
 * cognitive overload by clustering related cards instead of
 * presenting 12+ cards as one flat list.
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
      {/* Header — time-of-day greeting + one neutral navigation CTA
          (hero-aware: capture-first onboarding vs. "All evidence").
          Search / inbox live in the global app header, not duplicated. */}
      <HomeHeader hero={vm.heroAction} />

      {/* ─────────────────────────────────────────────────────────
          LAYER 1 — Overview. What do I have? What is ready? What needs
          me right now? Two surfaces only: the one-line Executive Summary
          (critical alert) + the five real-number KPIs. The 3-layer IA
          is a product contract (home-ia-three-layer.contract.test.ts) —
          the Layer 1 header must precede ExecutiveSummaryBand + KpiRow.
          ───────────────────────────────────────────────────────── */}
      <HomeLayerHeader
        layer={1}
        title="Overview"
        subtitle="What you have, what is ready, what needs you right now."
      />
      <ExecutiveSummaryBand summary={vm.executiveSummary} />
      <KpiRow kpis={vm.kpis} />

      {/* ─────────────────────────────────────────────────────────
          LAYER 2 — Your work right now. The operational pile: open
          actions, matters, intake, report production, recent
          captures. Everything in this layer is something the user
          can act on; trust signals live in Layer 3.
          ───────────────────────────────────────────────────────── */}
      <HomeLayerHeader
        layer={2}
        title="Your work"
        subtitle="Open actions, matters, intake, and report production."
      />
      <div style={rowQueueChartStyle}>
        <OperationalQueue
          items={vm.operationalQueue}
          hero={vm.heroAction}
          workspaceId={vm.workspaceId}
          onChanged={state.reload}
        />
        {vm.showGettingStarted ? (
          <GettingStartedChecklist
            steps={vm.checklist}
            complete={vm.checklistComplete}
          />
        ) : (
          <WorkspacePrioritiesCard priorities={vm.workspacePriorities} />
        )}
      </div>
      <div style={rowTwoColStyle}>
        <ActiveMatters rows={vm.activeMatters} summary={vm.caseHealthSummary} />
        <IntakePipelineCard
          pipeline={vm.intakePipeline}
          workspaceId={vm.workspaceId}
          onChanged={state.reload}
          locked={!pro}
        />
      </div>
      <div style={rowTwoColStyle}>
        <ReportProductionCard production={vm.reportProduction} isFreePlan={free} />
        <RecentEvidenceCard rows={vm.richRecentEvidence} />
      </div>

      {/* ─────────────────────────────────────────────────────────
          LAYER 3 — Verification & details. Trust posture (the
          verification summary + public-verification links), what's
          in the workspace (records by type, workspace health),
          and the context streams (activity chart, recent activity,
          storage). Lower altitude — read it when you want detail,
          ignore it when you don't.
          ───────────────────────────────────────────────────────── */}
      <HomeLayerHeader
        layer={3}
        title="Verification & details"
        subtitle="Trust posture, distribution, recent activity, and storage."
      />
      <div style={rowTwoColStyle}>
        <TrustStateCard trust={vm.trustState} />
        <VerificationHealthCard health={vm.verificationHealth} />
      </div>
      <div style={rowTwoColStyle}>
        <WorkspaceHealthCard metrics={vm.workspaceHealth} overall={vm.workspaceHealthOverall} />
        <EvidenceTypeDonutCard
          distribution={vm.typeDistribution}
          preservedFiles={vm.preservedFilesByType}
        />
      </div>
      <div style={rowTwoColStyle}>
        <EvidenceActivityChart series={vm.activitySeries} />
        <ActivityFeed groups={vm.activity} />
      </div>
      <div style={rowTwoColStyle}>
        <StorageUsageCard usage={vm.storage} />
        <div />
      </div>

      {/* Team Work — organization workspaces only (null in Personal Space). */}
      {vm.teamWork ? <TeamWorkCard team={vm.teamWork} /> : null}
    </main>
  );
}

/**
 * Phase HOME-IA — section divider for the 3-layer Home.
 *
 * Lightweight visual chip + heading + subtitle. NOT a navigation
 * surface — these are reading-flow cues that cluster cards by
 * altitude so the user isn't presented with 12+ unrelated tiles
 * as one flat wall.
 *
 * The `data-home-layer` attribute is the contract for tests +
 * analytics + future scroll-anchors; it MUST stay stable across
 * copy revisions.
 */
function HomeLayerHeader({
  layer,
  title,
  subtitle,
}: {
  layer: 1 | 2 | 3;
  title: string;
  subtitle: string;
}) {
  return (
    <header
      data-home-layer={layer}
      data-home-layer-title={title}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        // Section header with a subtle hairline divider so each band of
        // cards reads as a distinct, premium section of the dashboard
        // system rather than a loose pile of white boxes. Extra top
        // margin gives the sections room to breathe (8px grid).
        padding: "0 2px 14px",
        marginTop: layer === 1 ? 8 : 24,
        borderBottom: "1px solid rgba(15, 23, 42, 0.08)",
      }}
    >
      <div
        style={{
          fontSize: 15,
          fontWeight: 750,
          letterSpacing: -0.2,
          color: "#0f172a",
        }}
      >
        {title}
      </div>
      <p
        style={{
          margin: 0,
          fontSize: 13,
          color: "#64748b",
          lineHeight: 1.45,
        }}
      >
        {subtitle}
      </p>
    </header>
  );
}

// Phase HOME-POLISH — the soft pearl surface from home-theme.ts.
const pageStyle: React.CSSProperties = homePageStyle;
// minmax(0, …) keeps charts/lists from forcing horizontal overflow on
// narrow viewports; auto-fit collapses to one column under ~720px.
const rowTwoColStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))",
  gap: 20,
  alignItems: "stretch",
};
const rowQueueChartStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))",
  gap: 20,
  alignItems: "stretch",
};
