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

import Link from "next/link";

import { PageShell, PageSection } from "../ui";
import { Card } from "../ui/Card";

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
import { HOME_COLORS } from "./home-theme";
import { isFreePlan, isProOrTeam } from "./home-view-model";

export function SelfServeHomeDashboard() {
  const state = useHomeData();

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
  const free = isFreePlan(vm.plan);
  const pro = isProOrTeam(vm.plan);

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

      {/* Operational summary band — one state, one sentence, one action.
          Honest-null aware (onboarding state for zero-data users). */}
      <ExecutiveSummaryBand summary={vm.executiveSummary} />

      {/* Premium KPI cards — five real view-model numbers. */}
      <KpiRow kpis={vm.kpis} />

      {/* What needs me now — the operational decision surfaces. Action
          needed (queue) pairs with either onboarding (true zero-data
          users) or the ranked "What needs attention" priorities. */}
      <PageSection
        title="What needs you now"
        description="Open actions and the workspace priorities ranked by severity."
        style={sectionStyle}
      >
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
      </PageSection>

      {/* Recent work — the newest captures and the active matter
          portfolio. Both deep-link into the working routes. */}
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

      {/* Primary actions — the core workflow entry points. Clean action
          cards (Card `action` variant) over the exact working routes;
          no fabricated data, pure navigation. */}
      <PageSection
        title="Get things done"
        description="Jump straight into the core evidence workflows."
        style={sectionStyle}
      >
        <div style={actionsRowStyle}>
          <PrimaryActionCard
            href="/capture"
            label="Capture evidence"
            hint="Seal a photo, video, document, or screen recording."
          />
          <PrimaryActionCard
            href="/evidence"
            label="All evidence"
            hint="Browse, filter, and manage every record."
          />
          <PrimaryActionCard
            href="/cases"
            label="Matters & cases"
            hint="Group related evidence and track it end-to-end."
          />
          <PrimaryActionCard
            href="/reports"
            label="Reports"
            hint="Generate and download signed evidence reports."
          />
        </div>
      </PageSection>

      {/* ─────────────────────────────────────────────────────────────
          OPERATIONAL DETAIL — relegated diagnostics. Every card below is
          real, honest-null data; it simply lives one click away so the
          landing page stays a clean Evidence Operations overview instead
          of a diagnostic wall. Collapsed by default. Nothing here was
          deleted — the full trust posture, verification links, workspace
          health, records-by-type, intake pipeline, report production,
          activity streams and storage all still render (and keep their
          data-testid/data-* contracts) when expanded.
          ───────────────────────────────────────────────────────────── */}
      <details data-home-diagnostics style={detailsStyle}>
        <summary style={summaryStyle}>
          <span style={summaryLabelStyle}>Operational detail</span>
          <span style={summaryHintStyle}>
            Full trust posture, verification links, workspace health, intake
            pipeline, report production, and activity — one click away.
          </span>
          <span aria-hidden style={summaryChevronStyle}>▾</span>
        </summary>

        <div style={detailsBodyStyle}>
          <div style={rowTwoColStyle}>
            <TrustStateCard trust={vm.trustState} />
            <VerificationHealthCard health={vm.verificationHealth} />
          </div>
          <div style={rowTwoColStyle}>
            <ReportProductionCard production={vm.reportProduction} isFreePlan={free} />
            <IntakePipelineCard
              pipeline={vm.intakePipeline}
              workspaceId={vm.workspaceId}
              onChanged={state.reload}
              locked={!pro}
            />
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
        </div>
      </details>

      {/* Team Work — organization workspaces only (null in Personal Space). */}
      {vm.teamWork ? <TeamWorkCard team={vm.teamWork} /> : null}
    </PageShell>
  );
}

/**
 * Primary-action tile — a clean navigation card over one core workflow
 * route. Uses the shared premium `Card` (action variant) wrapped in a
 * Next <Link> so the whole tile is a real, keyboard-navigable link. No
 * data, no metrics — pure navigation.
 */
function PrimaryActionCard({
  href,
  label,
  hint,
}: {
  href: string;
  label: string;
  hint: string;
}) {
  return (
    <Link href={href} data-home-action={href} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <Card variant="action" padding="comfortable" style={{ height: "100%" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minHeight: 78 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: HOME_COLORS.ink, letterSpacing: -0.2 }}>
            {label}
          </span>
          <span style={{ fontSize: 12.5, lineHeight: 1.45, color: HOME_COLORS.slate }}>
            {hint}
          </span>
          <span style={{ marginTop: "auto", fontSize: 12.5, fontWeight: 650, color: HOME_COLORS.indigo }}>
            Open →
          </span>
        </div>
      </Card>
    </Link>
  );
}

// Phase 7C — PageShell owns the page frame (max-width, `--page-pad-x`,
// `--page-pad-y`, section gap), matching every other authenticated page.
// We do NOT re-apply the home-theme `homePageStyle` outer gutter here —
// that would double the shell's horizontal padding (the exact
// double-gutter home-theme.ts warns about). The only override is a touch
// more bottom breathing room so the relegated-diagnostics disclosure
// isn't flush with the viewport edge on a long scroll.
const pageShellStyle: React.CSSProperties = { paddingBottom: 56 };
// PageSection already owns its header margin; kill the extra block so the
// section title sits tight above its cards.
const sectionStyle: React.CSSProperties = { display: "block" };
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
const actionsRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
  gap: 16,
  alignItems: "stretch",
};

// Relegated-diagnostics disclosure — a premium collapsed panel. Closed
// by default so the landing page stays clean; opens to the full
// operational detail. Styled inline with the home-theme tokens (the
// shared card vocabulary) rather than forking a shared component.
const detailsStyle: React.CSSProperties = {
  border: `1px solid ${HOME_COLORS.cardBorder}`,
  borderRadius: 16,
  background: HOME_COLORS.card,
  boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
  overflow: "hidden",
};
const summaryStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "16px 20px",
  cursor: "pointer",
  listStyle: "none",
  userSelect: "none",
};
const summaryLabelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: HOME_COLORS.ink,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  flexShrink: 0,
};
const summaryHintStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  color: HOME_COLORS.slate,
  lineHeight: 1.45,
};
const summaryChevronStyle: React.CSSProperties = {
  fontSize: 14,
  color: HOME_COLORS.muted,
  flexShrink: 0,
};
const detailsBodyStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 20,
  padding: "0 20px 20px",
};
