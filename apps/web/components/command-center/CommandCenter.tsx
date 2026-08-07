"use client";

/**
 * Phase 32.8C (Full Rebuild) — Enterprise Evidence Operations Command Center.
 *
 * Renders the /home dashboard from `/v1/dashboard/command-center` as
 * an enterprise SOC-style operational surface — NOT an analytics
 * homepage.
 *
 * Mandatory operational sections (top-to-bottom hierarchy):
 *   1. Active Operational Pressure     (hero)
 *   2. Investigation & Case Operations
 *   3. Reviewer Orchestration
 *   4. Evidence Pipeline Visibility
 *   5. Governance & Compliance Posture
 *   6. Organizational Intelligence
 *   7. Operational Timeline
 *   8. Audit Readiness
 *
 * Hard rules:
 *   - Every count / status / severity comes from the envelope. No
 *     fake metrics, no decorative charts, no marketing copy.
 *   - Personal-workspace renders the same envelope but team-only
 *     sections render the bounded `not_applicable` neutral note.
 *   - Empty states are operationally meaningful — e.g.,
 *     "No operational pressure detected" instead of "Nothing
 *     needs attention".
 *   - VIEWER role hides mutation CTAs. Backend authorization is
 *     authoritative.
 */

import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import {
  // R8.1A — `getPersonaSectionOrder` was removed from this file's
  // imports in R3 when `resolveDashboardSections` took over the
  // ordering+emphasis contract. The helper still exists and is
  // consumed transitively by `resolveDashboardSections`; it just
  // does not need a direct import here. Leaving the dead import
  // surfaced an `unused-vars` ESLint error that broke the Vercel
  // build.
  useActiveSpace,
  useCan,
  usePlatformContext,
} from "../../lib/platform-context";
import {
  emit as emitStateEvent,
  redactWorkspaceId,
} from "../../lib/platform-context/state-observability";
import { resolveWorkspaceExperience } from "../../lib/workspace-experience";
import {
  resolveDashboardOnboarding,
  resolveDashboardQuickActions,
  resolveDashboardSections,
} from "../../lib/dashboard";
import { ContextualHelp } from "../contextual-help/ContextualHelp";
import { CommandCenterQuickActions } from "./CommandCenterQuickActions";
import { WorkflowOperationsSection } from "./_sections/WorkflowOperationsSection";
import { RuntimeStatusBanner } from "../operational";
import type {
  AuditReadinessCounter,
  CaseOperationsItem,
  CommandCenterEnvelope,
  OperationalPressureItem,
  PipelineDetail,
  ReviewerOrchestrationRow,
  SectionStatus,
  SeverityTone,
  TimelineEvent,
  WorkspaceScope,
} from "./types";

// ---------------------------------------------------------------------------
// Top-level page state
// ---------------------------------------------------------------------------

type LoadState =
  | { status: "loading" }
  | { status: "ready"; envelope: CommandCenterEnvelope }
  | { status: "no_workspace" }
  | { status: "auth_error"; code: "auth_required" | "permission_denied" }
  | { status: "unavailable"; message: string; requestId: string | null };

export function CommandCenter() {
  // R1 (Bug A) — canonical active-space resolution. Personal Space and
  // Organization spaces are BOTH valid workspaces; the legacy team-
  // only workspace gate filtered out personal users and produced the
  // "No workspace selected" mismatch with the topbar. We now read the
  // same canonical envelope the topbar reads.
  const ctx = usePlatformContext();
  const activeSpace = useActiveSpace();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  // Every value the fetch effect reads, narrowed to statically-checkable
  // scalars BEFORE the effect. This is what lets the dependency array be both
  // complete and honest: the dashboard must refetch when the provider state or
  // the active workspace changes, and must not refetch when an unrelated field
  // of the context object is replaced.
  const ctxStateName = ctx.state.name;
  const ctxFailure =
    ctx.state.name === "FAILED"
      ? {
          errorCode: ctx.state.errorCode,
          message: ctx.state.message,
          requestId: ctx.state.requestId ?? null,
        }
      : null;
  const ctxErrorCode = ctxFailure?.errorCode ?? null;
  const ctxMessage = ctxFailure?.message ?? null;
  const ctxRequestId = ctxFailure?.requestId ?? null;
  const activeSpaceId = activeSpace?.id ?? null;
  const activeSpaceType = activeSpace?.type ?? null;
  const hasActiveSpace = activeSpace != null;

  useEffect(() => {
    // Provider state machine owns loading + auth + transport errors.
    if (ctxStateName === "IDLE" || ctxStateName === "LOADING_CONTEXT") {
      setState({ status: "loading" });
      return;
    }
    if (ctxStateName === "FAILED") {
      const code = ctxErrorCode;
      if (code === "AUTH_REQUIRED") {
        setState({ status: "auth_error", code: "auth_required" });
      } else if (
        code === "PERMISSION_DENIED" ||
        code === "WORKSPACE_MEMBERSHIP_REQUIRED"
      ) {
        setState({ status: "auth_error", code: "permission_denied" });
      } else {
        setState({
          status: "unavailable",
          message: ctxMessage ?? "",
          requestId: ctxRequestId,
        });
      }
      return;
    }
    // READY or SWITCHING — the envelope is available. If there is
    // genuinely no active space (rare; provider bootstraps Personal
    // Space), render the structured empty state. Otherwise the active
    // space id drives the dashboard fetch, regardless of PERSONAL vs
    // ORGANIZATION type.
    if (!hasActiveSpace) {
      setState({ status: "no_workspace" });
      return;
    }
    // R8.1A — PERSONAL spaces may legitimately carry `id === null`
    // during the provider's first-time bootstrap (provider creates
    // the Personal Space lazily on first command-center fetch). When
    // that's the case we render the empty-workspace state instead
    // of issuing a request with a literal "null" teamId, which the
    // backend would 400. This also resolves a pre-existing
    // `tsc --noEmit` failure that blocked the Vercel build.
    if (activeSpaceId == null) {
      setState({ status: "no_workspace" });
      return;
    }
    emitStateEvent("active-space:resolved", "CommandCenter", {
      activeSpaceType,
      activeSpaceId: redactWorkspaceId(activeSpaceId),
    });
    let cancelled = false;
    setState({ status: "loading" });
    apiFetch(
      `/v1/dashboard/command-center?teamId=${encodeURIComponent(activeSpaceId)}`,
      { method: "GET" },
    )
      .then((envelope: CommandCenterEnvelope) => {
        if (cancelled) return;
        emitStateEvent("dashboard:resolved", "CommandCenter", {
          activeSpaceType,
        });
        setState({ status: "ready", envelope });
      })
      .catch((err: { message?: string; requestId?: string }) => {
        if (cancelled) return;
        setState({
          status: "unavailable",
          message: toSafeUserError(err, { message: "Unable to load command center." }).message,
          requestId: err?.requestId ?? null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    ctxStateName,
    ctxErrorCode,
    ctxMessage,
    ctxRequestId,
    hasActiveSpace,
    activeSpaceId,
    activeSpaceType,
  ]);

  if (state.status === "loading") return <CommandCenterLoading />;
  if (state.status === "no_workspace") return <NoWorkspaceState />;
  if (state.status === "auth_error") return <AuthErrorState code={state.code} />;
  if (state.status === "unavailable")
    return <UnavailableState message={state.message} requestId={state.requestId} />;

  return <CommandCenterReady envelope={state.envelope} />;
}

// ---------------------------------------------------------------------------
// Ready dashboard
// ---------------------------------------------------------------------------

function CommandCenterReady({ envelope }: { envelope: CommandCenterEnvelope }) {
  const ctx = usePlatformContext();
  const { workspace, sections } = envelope;
  // Phase 32.8 Foundation cleanup — capability-derived visibility.
  const isTeam = ctx.envelope?.flags.isTeamWorkspace === true;
  const role = workspace.role; // retained for display only (badges, labels)
  const canMutate = ctx.can("CASES_MANAGE") || ctx.can("REVIEWER_OPS_ACT");

  // Phase 32.8C FINAL-4 — persona-aware shell. The backend resolver
  // returns the persona + ordered list of section ids; the dashboard
  // surfaces the persona in the hero + renders a "persona priority"
  // strip that anchors operators directly to their relevant sections.
  const persona =
    envelope.capabilityMatrix?.persona ?? null;
  const capabilities = envelope.capabilityMatrix?.capabilities ?? null;
  const backendSectionOrder: string[] =
    envelope.capabilityMatrix?.sectionOrder ?? [];

  // Re-rank the section order client-side. Capabilities decide which
  // sections are populated; the experience mode decides ordering. The
  // orchestrator is a pure partition + concat — never adds or removes.
  //
  // The available section ids are intersected with the section
  // component registry (CANONICAL_SECTION_IDS) and with the envelope's
  // populated sections, so a section that isn't rendered yet (or whose
  // renderer isn't registered yet) never appears in the priority
  // strip / render order.
  const sectionsKeys = new Set(Object.keys(sections));
  const renderableSectionIds = CANONICAL_SECTION_IDS.filter(
    (id) => sectionsKeys.has(id),
  );
  // R3 — canonical dashboard orchestration. Combines workspace
  // experience mode + availability into a single ordered section list
  // with per-section emphasis labels. No authorization is consulted.
  const experienceModeForSections = ctx.envelope?.activeSpace?.type
    ? resolveWorkspaceExperience({
        activeSpaceType: ctx.envelope.activeSpace.type,
        capabilities: ctx.envelope.capabilities ?? {},
      }).mode
    : ("PERSONAL" as const);
  const orchestratedSections = resolveDashboardSections({
    mode: experienceModeForSections,
    availableSectionIds:
      renderableSectionIds.length > 0
        ? renderableSectionIds
        : backendSectionOrder,
  });
  const clientSectionOrder: string[] = orchestratedSections.sectionOrder as string[];
  const sectionEmphasisById = new Map(
    orchestratedSections.sections.map((s) => [s.id, s.emphasis] as const),
  );
  const sectionOrder: string[] =
    clientSectionOrder.length > 0 ? clientSectionOrder : backendSectionOrder;
  emitStateEvent("dashboard-sections:resolved", "CommandCenterReady", {
    mode: experienceModeForSections,
    sectionCount: sectionOrder.length,
  });
  const dashboardPrimaryCount = orchestratedSections.sections.filter(
    (s) => s.emphasis === "primary",
  ).length;
  emitStateEvent("dashboard-priority:resolved", "CommandCenterReady", {
    mode: experienceModeForSections,
    primarySectionCount: dashboardPrimaryCount,
  });
  // The render loop consumes this exact ordered list. The priority
  // strip + IntersectionObserver hook also read it, so the strip,
  // active-section tracking, and rendered layout all move together.
  const finalSectionOrder: string[] = sectionOrder;

  // R1.5B — dashboard experience emphasis. Read the canonical mode
  // and surface it as a data attribute + observability event. The
  // dashboard itself is NOT redesigned in R1.5B — R3 owns the
  // emphasis orchestration. This wires the data hook so R3 can
  // target the mode without further refactor.
  const dashboardExperience = resolveWorkspaceExperience({
    activeSpaceType: ctx.envelope?.activeSpace?.type ?? null,
    capabilities: ctx.envelope?.capabilities ?? {},
  });
  emitStateEvent("dashboard-mode:resolved", "CommandCenter", {
    experienceMode: dashboardExperience.mode,
    dashboardEmphasis: dashboardExperience.dashboardEmphasis,
  });

  // R3 — contextual quick actions for the current experience mode.
  // Each action is a SHORTCUT to an existing registered route; the
  // orchestrator never invents an href. The actions render in the
  // hero meta strip so operators see them immediately.
  const quickActions = resolveDashboardQuickActions({
    mode: dashboardExperience.mode,
  });
  emitStateEvent("dashboard-quick-actions:resolved", "CommandCenterReady", {
    mode: dashboardExperience.mode,
    count: quickActions.length,
  });

  // R3 — contextual onboarding hint. Returns `null` once the operator
  // has completed setup. The dashboard renders it as a single
  // operationally-meaningful action — never generic emptiness.
  // (2026-07-20) The onboarding-completed flag previously came from
  // the deleted workspace-persona profile. It is now derived from
  // whether the dashboard already has populated data sections — a
  // workspace showing real sections is past first-run onboarding.
  const onboardingHint = resolveDashboardOnboarding({
    mode: dashboardExperience.mode,
    onboardingCompleted: renderableSectionIds.length > 0,
  });

  // Phase 32.8C+++++++ — active-section tracking via IntersectionObserver.
  // Persona priority chips light up as the operator scrolls, and the URL
  // hash is synced so browser refresh + deep links land on the right
  // section. Hash navigation also smooth-scrolls.
  const activeSection = useActiveSection(sectionOrder);

  return (
    <main
      className="ec-page"
      data-command-center
      data-cc-persona={persona ?? "VIEWER"}
      data-cc-workspace-scope={workspace.scope}
      data-cc-experience-mode={dashboardExperience.mode}
      data-cc-dashboard-emphasis={dashboardExperience.dashboardEmphasis}
      data-cc-persona-section-order={sectionOrder.join(",")}
    >
      {/* HERO STRIP */}
      <header className="ec-hero">
        <div className="ec-hero-titles">
          <div className="ec-kicker">Evidence Operations Center</div>
          <h1 className="ec-title">Operational command surface</h1>
          <p className="ec-subtitle">
            Operational pressure, investigation status, reviewer coordination,
            governance posture, and audit readiness — sourced from real
            workspace state.
          </p>
        </div>
        <div className="ec-hero-meta" data-cc-meta>
          <span data-cc-workspace-scope={workspace.scope}>
            {workspace.scope === "SINGLE_OCCUPANT"
              ? "Personal workspace"
              : `Team · ${workspace.memberCount} members`}
          </span>
          <span data-cc-role={role}>Role · {role}</span>
          {persona ? (
            <span data-cc-persona-chip={persona}>
              Persona · {persona.replace(/_/g, " ")}
            </span>
          ) : null}
          <span title={envelope.generatedAt}>
            Refreshed {relTime(envelope.generatedAt)}
          </span>
        </div>
        {/* R3 — contextual quick actions. Bounded shortcuts to
            existing routes. Never invents new destinations. */}
        <CommandCenterQuickActions
          actions={quickActions}
          mode={dashboardExperience.mode}
        />
        {/* R3 — contextual onboarding hint. Renders only while
            onboarding is incomplete. Never generic emptiness. */}
        {onboardingHint ? (
          <div
            data-cc-onboarding-hint
            data-cc-onboarding-hint-mode={dashboardExperience.mode}
            data-cc-onboarding-hint-tone={onboardingHint.tone}
            style={{
              marginTop: 8,
              fontSize: 13,
              color:
                onboardingHint.tone === "positive" ? "#065f46" : "#475569",
            }}
          >
            <Link
              href={onboardingHint.href}
              className="cc-quick-action"
              data-cc-onboarding-hint-cta
            >
              {onboardingHint.label}
            </Link>
          </div>
        ) : null}
      </header>

      {/* Phase 32.8C FINAL-4 — persona priority strip. Renders the
          ordered section ids the backend persona resolver returned, so
          the operator sees their highest-priority sections at a glance
          and can jump to them via the page-anchor links. Hidden when no
          ordering is available (e.g. unauthenticated). */}
      {sectionOrder.length > 0 ? (
        <nav
          className="ec-persona-priority"
          data-cc-persona-priority
          aria-label="Priority sections for this persona"
        >
          <span className="ec-chip-faint" data-cc-persona-priority-label>
            {persona ? `${persona.replace(/_/g, " ")} priority` : "Priority"}
          </span>
          <ul className="ec-persona-priority-list">
            {sectionOrder.slice(0, 8).map((sectionId, idx) => {
              const isActive = activeSection === sectionId;
              return (
                <li
                  key={sectionId}
                  data-cc-persona-priority-item={sectionId}
                  data-cc-persona-priority-rank={idx + 1}
                  data-cc-persona-priority-active={isActive ? "true" : "false"}
                  aria-current={isActive ? "true" : undefined}
                >
                  <a
                    href={`#${sectionId}`}
                    onClick={(ev) => {
                      // Phase 32.8C+++++++ — soft hash navigation:
                      // smooth-scroll the target into view, update the URL
                      // hash without a full page jump, focus the section
                      // for accessibility.
                      const el = document.getElementById(sectionId);
                      if (el) {
                        ev.preventDefault();
                        el.scrollIntoView({
                          behavior: "smooth",
                          block: "start",
                        });
                        if (typeof window !== "undefined") {
                          history.replaceState(
                            null,
                            "",
                            `#${sectionId}`,
                          );
                        }
                        // Briefly mark the section so operators see
                        // confirmation of where they landed.
                        el.setAttribute("data-cc-section-landed", "true");
                        window.setTimeout(() => {
                          el.removeAttribute("data-cc-section-landed");
                        }, 1500);
                      }
                    }}
                  >
                    <span data-cc-persona-priority-rank-badge>{idx + 1}</span>
                    <span>{humanizeSectionId(sectionId)}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}

      {/* Phase 32.8C FINAL-4 — bulk action toolbar. Read-only chips
          documenting what operator actions are available; the
          mutation routes live on /operations/observability. The toolbar is
          permission-aware via the capability matrix. */}
      {capabilities ? (
        <BulkActionsToolbar
          capabilities={capabilities}
          scope={workspace.scope}
        />
      ) : null}

      {/* Platform impact banner — scoped to evidence/governance/reviewer */}
      <RuntimeStatusBanner
        teamId={workspace.id}
        forDomains={[
          "core_evidence",
          "governance_lifecycle",
          "reviewer_ops",
          "workflow_engine",
          "operational_incidents",
        ]}
      />

      {/* CRITICAL OPERATIONS BAR — top-of-page health distillation */}
      <CriticalOperationsBar envelope={envelope} />

      {/* PHASE 12 — VERTICAL B. Operational workflow actions live HERE,
          on the same surface that surfaces the pressure, rather than in
          a separate workflow product. Action availability, staleness,
          and idempotency are all server-owned — see the section's own
          contract notes. */}
      <WorkflowOperationsSection teamId={workspace.id} />

      {/* SUMMARY STRIP */}
      <SummaryStrip envelope={envelope} isTeam={isTeam} />

      {/* Contextual help, collapsed by default so the operational
          sections stay primary. Uses the "ops" surface entry — the
          closest catalog match for dashboard-level operational
          guidance. */}
      <ContextualHelp surface="ops" collapsedByDefault />

      {/* Section component registry + render loop with grid grouping.
          The render ORDER is set by `finalSectionOrder` (experience-mode
          driven). The render LAYOUT is set by the `gridGroup` metadata
          on each registry entry: consecutive sections sharing the same
          `gridGroup` are wrapped in a
          multi-column grid, restoring the multi-panel command-center
          density without losing the workflow ordering. Sections with
          no gridGroup render full-width. */}
      {buildSectionRenderPlan(finalSectionOrder).map((band, bandIdx) => {
        const wrapped = band.entries.map(({ sectionId, entry }) => {
          const node = entry.render({
            envelope,
            sections,
            ctx,
            isTeam,
            canMutate,
          });
          if (!node) return null;
          return (
            <div
              key={sectionId}
              id={sectionId}
              data-section={sectionId}
              data-section-position={
                finalSectionOrder.indexOf(sectionId) + 1
              }
              data-section-grid-group={band.gridGroup ?? "single"}
              // R3 / R8.1A — per-section emphasis label sourced from
              // the dashboard orchestrator. Drives mode-aware CSS
              // tilts (primary / de-emphasized) and is observable by
              // source-contract tests. Defaults to "de-emphasized" for
              // any section the orchestrator did not classify as
              // mode-primary. (2026-07-20 — the `secondary` tier was
              // removed with the workspace-persona feature.)
              data-cc-section-emphasis={
                sectionEmphasisById.get(sectionId) ?? "de-emphasized"
              }
              aria-label={entry.ariaLabel}
            >
              {node}
            </div>
          );
        });
        const cleaned = wrapped.filter((n) => n !== null);
        if (cleaned.length === 0) return null;
        // Single-column band: render children directly.
        if (!band.gridGroup || cleaned.length === 1) {
          return (
            <div
              key={`band-${bandIdx}`}
              data-section-band={band.gridGroup ?? "single"}
            >
              {cleaned}
            </div>
          );
        }
        // Multi-column band: wrap in the corresponding ec-grid class.
        const gridClass =
          cleaned.length >= 3 ? "ec-grid-3col" : "ec-grid-2col";
        return (
          <div
            key={`band-${bandIdx}`}
            className={gridClass}
            data-section-band={band.gridGroup}
            data-section-band-size={cleaned.length}
          >
            {cleaned}
          </div>
        );
      })}

      {/* QuickActions — always rendered after the section loop. Not
          part of the persona-ordered set because it is a UI action
          surface, not a dashboard data section. */}
      <QuickActions
        isTeam={isTeam}
        canMutate={canMutate}
        canViewGovernance={ctx.can("GOVERNANCE_VIEW")}
      />

      {/* Unsupported Signals — transparent catalog, collapsed by default */}
      <UnsupportedSignalsSection signals={envelope.unsupportedSignals} />
    </main>
  );
}

// ============================================================================
// PHASE 38.11 — Canonical section component registry.
//
// Maps every dashboard section id to:
//   - a `render` function that takes the envelope + the resolved
//     sections object + context + isTeam/canMutate, and returns the
//     section's JSX node (or null when the section is missing).
//   - an `ariaLabel` used on the deep-link anchor wrapper.
//
// The registry replaces the prior hand-coded JSX layout. Adding a
// new section requires:
//   1. Adding it to `CommandCenterEnvelope["sections"]` in types.ts.
//   2. Registering it here with the renderer + label.
//
// Ordering is driven by the experience mode. The set of rendered
// sections is determined by which envelope keys are populated
// (capabilities + backend projection state).
// ============================================================================

type SectionRenderArgs = {
  envelope: CommandCenterEnvelope;
  sections: CommandCenterEnvelope["sections"];
  ctx: ReturnType<typeof usePlatformContext>;
  isTeam: boolean;
  canMutate: boolean;
};

type SectionRendererEntry = {
  ariaLabel: string;
  render: (args: SectionRenderArgs) => ReactNode;
  /**
   * Phase 38.12 — Multi-column layout hint. Consecutive sections in
   * the final render order that share the same `gridGroup` are
   * wrapped in a `.ec-grid-2col` / `.ec-grid-3col` band, restoring
   * the operational command-center density. `null` means full-width.
   *
   * Bounded vocabulary so the grouping logic stays predictable:
   *
   *   - "review-ops"  — routing queue + workload + reviewer ops
   *   - "case-ops"    — case operations + reviewer orchestration
   *   - "pipeline"    — pipeline + governance posture
   *   - "intel"       — investigation + workload boards
   *   - "audit"       — audit readiness + organizational intel
   *   - "watch"       — custody + access security watch
   *   - "deep-intel"  — relationship + cross-case intel
   *   - "deep-watch"  — deep integrity + access classifier
   *   - "ops-runtime" — queue/worker telemetry + coordination signals
   *   - "advisory"    — reviewer capacity + operational graph
   */
  gridGroup?:
    | "review-ops"
    | "case-ops"
    | "pipeline"
    | "intel"
    | "audit"
    | "watch"
    | "deep-intel"
    | "deep-watch"
    | "ops-runtime"
    | "advisory"
    | null;
};

const SECTION_RENDERERS: Record<string, SectionRendererEntry> = {
  operationalPressure: {
    ariaLabel: "Operational Pressure",
    render: ({ sections, canMutate }) => (
      <OperationalPressureSection
        section={sections.operationalPressure}
        canMutate={canMutate}
      />
    ),
  },
  routingQueue: {
    ariaLabel: "Routing Queue",
    render: ({ sections }) => (
      <RoutingQueueSection section={sections.routingQueue} />
    ),
  },
  investigationIntelligence: {
    ariaLabel: "Investigation Risk Board",
    gridGroup: "intel",
    render: ({ sections }) => (
      <InvestigationRiskBoard section={sections.investigationIntelligence} />
    ),
  },
  workloadEngine: {
    ariaLabel: "Reviewer Workload Engine",
    gridGroup: "intel",
    render: ({ sections }) => (
      <WorkloadEngineBoard section={sections.workloadEngine} />
    ),
  },
  caseOperations: {
    ariaLabel: "Case Operations",
    gridGroup: "case-ops",
    render: ({ sections }) => (
      <CaseOperationsSection section={sections.caseOperations} />
    ),
  },
  reviewerOrchestration: {
    ariaLabel: "Reviewer Orchestration",
    gridGroup: "case-ops",
    render: ({ sections }) => (
      <ReviewerOrchestrationSection section={sections.reviewerOrchestration} />
    ),
  },
  pipelineDetail: {
    ariaLabel: "Evidence Pipeline",
    gridGroup: "pipeline",
    render: ({ sections }) => (
      <PipelineDetailSection section={sections.pipelineDetail} />
    ),
  },
  governancePosture: {
    ariaLabel: "Governance Posture",
    gridGroup: "pipeline",
    render: ({ sections, isTeam }) => (
      <GovernancePostureSection
        section={sections.governancePosture}
        isTeam={isTeam}
      />
    ),
  },
  queueCongestion: {
    ariaLabel: "Queue Congestion",
    render: ({ sections }) => (
      <QueueCongestionSection section={sections.queueCongestion} />
    ),
  },
  auditReadiness: {
    ariaLabel: "Audit Readiness",
    gridGroup: "audit",
    render: ({ sections }) => (
      <AuditReadinessSection section={sections.auditReadiness} />
    ),
  },
  organizationalIntelligence: {
    ariaLabel: "Organizational Intelligence",
    gridGroup: "audit",
    render: ({ sections }) => (
      <OrganizationalIntelligenceSection
        section={sections.organizationalIntelligence}
      />
    ),
  },
  custodyIntegrityAnomalies: {
    ariaLabel: "Custody Integrity Watch",
    gridGroup: "watch",
    render: ({ sections }) => (
      <CustodyIntegrityWatch section={sections.custodyIntegrityAnomalies} />
    ),
  },
  accessSecurityAnomalies: {
    ariaLabel: "Access Security Watch",
    gridGroup: "watch",
    render: ({ sections }) => (
      <AccessSecurityWatch section={sections.accessSecurityAnomalies} />
    ),
  },
  timeline: {
    ariaLabel: "Operational Timeline",
    render: ({ sections }) => <TimelineSection section={sections.timeline} />,
  },
  recentEvidence: {
    ariaLabel: "Recent Evidence",
    render: ({ sections }) => (
      <RecentEvidenceSection section={sections.recentEvidence} />
    ),
  },
  incidents: {
    ariaLabel: "Operational Incidents",
    render: ({ sections }) => <IncidentsSection section={sections.incidents} />,
  },
  predictiveRisk: {
    ariaLabel: "Predictive Risk Forecast",
    render: ({ sections }) => (
      <PredictiveRiskBoard section={sections.predictiveRisk} />
    ),
  },
  organizationalIntelligenceV2: {
    ariaLabel: "Organizational Intelligence V2",
    render: ({ sections }) => (
      <OrgIntelligenceV2Board
        section={sections.organizationalIntelligenceV2}
      />
    ),
  },
  relationshipIntelligence: {
    ariaLabel: "Evidence Relationship Intelligence",
    gridGroup: "deep-intel",
    render: ({ sections }) => (
      <RelationshipIntelligenceBoard
        section={sections.relationshipIntelligence}
      />
    ),
  },
  crossCaseIntelligenceV2: {
    ariaLabel: "Cross-Case Intelligence",
    gridGroup: "deep-intel",
    render: ({ sections }) => (
      <CrossCaseIntelligenceV2Board
        section={sections.crossCaseIntelligenceV2}
      />
    ),
  },
  deepIntegrityWatch: {
    ariaLabel: "Deep Integrity Watch",
    gridGroup: "deep-watch",
    render: ({ sections }) => (
      <DeepIntegrityWatch section={sections.deepIntegrityWatch} />
    ),
  },
  accessSecurityClassifier: {
    ariaLabel: "Access Security Classifier",
    gridGroup: "deep-watch",
    render: ({ envelope, sections }) => (
      <AccessSecurityClassifierBoard
        section={sections.accessSecurityClassifier}
        rollupHealth={envelope.opsHealth?.securityRollup ?? null}
      />
    ),
  },
  queueWorkerTelemetry: {
    ariaLabel: "Queue / Worker Telemetry",
    gridGroup: "ops-runtime",
    render: ({ envelope, sections }) => (
      <QueueWorkerTelemetryBoard
        section={sections.queueWorkerTelemetry}
        telemetryHealth={envelope.opsHealth?.telemetry ?? null}
        reconcileHealth={envelope.opsHealth?.reconcile ?? null}
      />
    ),
  },
  coordinationSignals: {
    ariaLabel: "Coordination Signals",
    gridGroup: "ops-runtime",
    render: ({ sections }) => (
      <CoordinationSignalsBoard section={sections.coordinationSignals} />
    ),
  },
  reconstructedTimeline: {
    ariaLabel: "Reconstructed Timeline",
    render: ({ sections }) => (
      <ReconstructedTimelineSection section={sections.reconstructedTimeline} />
    ),
  },
  reviewerCapacity: {
    ariaLabel: "Reviewer Capacity",
    gridGroup: "advisory",
    render: ({ sections }) => (
      <ReviewerCapacityBoard section={sections.reviewerCapacity} />
    ),
  },
  operationalGraph: {
    ariaLabel: "Operational Graph",
    gridGroup: "advisory",
    render: ({ sections }) => (
      <OperationalGraphSummaryBoard section={sections.operationalGraph} />
    ),
  },
  organizationalHealth: {
    ariaLabel: "Organizational Health",
    render: ({ sections }) => (
      <OrganizationalHealthBoard section={sections.organizationalHealth} />
    ),
  },
};

/**
 * Canonical bounded ordering of every registered section. Used as the
 * stable fallback when persona priority doesn't claim a section.
 */
const CANONICAL_SECTION_IDS: ReadonlyArray<string> = [
  "operationalPressure",
  "routingQueue",
  "investigationIntelligence",
  "workloadEngine",
  "caseOperations",
  "reviewerOrchestration",
  "pipelineDetail",
  "governancePosture",
  "queueCongestion",
  "auditReadiness",
  "organizationalIntelligence",
  "custodyIntegrityAnomalies",
  "accessSecurityAnomalies",
  "timeline",
  "recentEvidence",
  "incidents",
  "predictiveRisk",
  "organizationalIntelligenceV2",
  "relationshipIntelligence",
  "crossCaseIntelligenceV2",
  "deepIntegrityWatch",
  "accessSecurityClassifier",
  "queueWorkerTelemetry",
  "coordinationSignals",
  "reconstructedTimeline",
  "reviewerCapacity",
  "operationalGraph",
  "organizationalHealth",
];

// ============================================================================
// PHASE 38.13 — Persona-aware section render plan.
//
// Builds the dashboard render layout in two passes:
//
//   1. PARTITION — every renderable section is assigned to a band:
//      sections sharing a `gridGroup` are bundled together; sections
//      with no group form a single-entry band of their own.
//
//   2. PRIORITIZE — each band's priority is `min(orderedIds.indexOf(...))`
//      across its members. The experience-mode section order decides
//      those indices. The band with the lowest-index member renders
//      first.
//
// Result:
//   - Paired sections ALWAYS stay grouped (no order-sensitivity bug).
//   - Workflow priority still wins — the highest-priority member of a
//     band promotes the whole band toward the top of the page.
//   - Sections with no `gridGroup` render solo, in their workflow-
//     determined order.
//
// Render wrappers (unchanged from 38.12):
//   - 1-entry band     → renders children inline
//   - 2-entry band     → `.ec-grid-2col`
//   - ≥3-entry band    → `.ec-grid-3col`
//
// Pure function. Same input → same output. No DOM access.
// ============================================================================

type SectionRenderBand = {
  gridGroup: SectionRendererEntry["gridGroup"];
  entries: Array<{ sectionId: string; entry: SectionRendererEntry }>;
  /** Lowest finalSectionOrder index across members — drives band sort. */
  priority: number;
};

function buildSectionRenderPlan(
  orderedIds: ReadonlyArray<string>,
): ReadonlyArray<SectionRenderBand> {
  // 1. Partition by gridGroup. Solo sections (no group) get a unique
  //    band id so they render independently and don't merge across the
  //    page.
  const bandsByKey = new Map<string, SectionRenderBand>();
  const soloIdx = { n: 0 };

  for (const sectionId of orderedIds) {
    const entry = SECTION_RENDERERS[sectionId];
    if (!entry) continue;
    const group = entry.gridGroup ?? null;
    const key = group !== null ? `g:${group}` : `solo:${soloIdx.n++}`;
    const positionIdx = orderedIds.indexOf(sectionId);

    if (!bandsByKey.has(key)) {
      bandsByKey.set(key, {
        gridGroup: group,
        entries: [{ sectionId, entry }],
        priority: positionIdx,
      });
    } else {
      const band = bandsByKey.get(key)!;
      if (band.entries.length < 3) {
        band.entries.push({ sectionId, entry });
      } else {
        // Band is full (≥3). Spill the extra into a fresh solo band
        // at the section's own position so nothing is hidden.
        bandsByKey.set(`spill:${sectionId}`, {
          gridGroup: null,
          entries: [{ sectionId, entry }],
          priority: positionIdx,
        });
        continue;
      }
      if (positionIdx < band.priority) band.priority = positionIdx;
    }
  }

  // 2. Stable sort by priority (ascending). Workflow profile picks
  //    the priority; bands with multiple members get the lowest
  //    member-index as their position, so a paired band where one
  //    member is highly prioritized still wins.
  const bands = Array.from(bandsByKey.values()).sort(
    (a, b) => a.priority - b.priority,
  );
  return bands;
}

// ============================================================================
// Phase 32.8C FINAL-3 — Reviewer Capacity / Operational Graph /
// Organizational Health (read-only advisory boards).
// ============================================================================

function ReviewerCapacityBoard({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["reviewerCapacity"];
}) {
  if (!section) return null;
  if (section.meta.status === "not_applicable") {
    return (
      <SectionShell
        kicker="Reviewer Capacity"
        title="Personal workspace — capacity board not applicable"
      >
        <PersonalNote subsystem="reviewer" />
      </SectionShell>
    );
  }
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell
        kicker="Reviewer Capacity"
        title="Capacity read degraded"
        severity="warning"
      >
        <SectionNote status="unavailable" kind="workload-engine" />
      </SectionShell>
    );
  }
  const reviewers = section.reviewers ?? [];
  const recs = section.recommendations ?? [];
  if (reviewers.length === 0 && recs.length === 0) {
    return (
      <SectionShell
        kicker="Reviewer Capacity"
        title="No active reviewer load"
      >
        <EnterpriseEmpty
          title="No reviewer with active assignments"
          body="The capacity engine scans EvidenceReviewWorkflow rows assigned to a reviewer (ASSIGNED / IN_REVIEW / NEEDS_INFO). A 0-result state means no reviewer currently carries an active workload."
          hint="Routing recommendations (REASSIGN / ESCALATE / SPLIT_LOAD) appear only when at least one reviewer is at HIGH or CRITICAL saturation."
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      kicker="Reviewer Capacity"
      title={`Capacity · ${reviewers.length} reviewer${reviewers.length === 1 ? "" : "s"}${recs.length > 0 ? ` · ${recs.length} recommendation${recs.length === 1 ? "" : "s"}` : ""}`}
      severity={
        reviewers.some((r) => r.saturationLevel === "CRITICAL")
          ? "high"
          : reviewers.some((r) => r.saturationLevel === "HIGH")
            ? "warning"
            : "info"
      }
    >
      <ul className="ec-telemetry-list" data-cc-reviewer-capacity>
        {reviewers.map((r) => (
          <li
            key={r.reviewerUserId}
            className="ec-telemetry-row"
            data-cc-reviewer-id={r.reviewerUserId}
            data-cc-reviewer-saturation={r.saturationLevel}
            data-cc-tile-severe={
              r.saturationLevel === "CRITICAL" || r.saturationLevel === "HIGH"
                ? "true"
                : "false"
            }
          >
            <div className="ec-telemetry-row-main">
              <span className="ec-telemetry-label">
                Reviewer {r.reviewerUserId.slice(0, 8)}
              </span>
              <span
                className="ec-chip"
                data-cc-tile-severe={
                  r.saturationLevel === "CRITICAL" || r.saturationLevel === "HIGH"
                    ? "true"
                    : "false"
                }
              >
                {r.saturationLevel}
              </span>
              <span className="ec-chip-faint">capacity {r.capacityScore}</span>
            </div>
            <div className="ec-telemetry-meta">
              <span>{r.assignedCount} assigned</span>
              {r.overdueCount > 0 ? (
                <span className="ec-chip" data-cc-tile-severe="true">
                  {r.overdueCount} overdue
                </span>
              ) : null}
              {r.dueSoonCount > 0 ? (
                <span>{r.dueSoonCount} due soon</span>
              ) : null}
              {r.staleCount > 0 ? (
                <span>{r.staleCount} stale</span>
              ) : null}
              <span>{r.completed7d} done · 7d</span>
              <span>{r.completed30d} done · 30d</span>
              <time className="ec-chip-faint" dateTime={r.sampledAtUtc}>
                sampled {relTime(r.sampledAtUtc)}
              </time>
            </div>
          </li>
        ))}
      </ul>
      {recs.length > 0 ? (
        <div
          className="ec-subsection"
          data-cc-reviewer-recommendations-block
          aria-label="Routing recommendations"
        >
          <div className="ec-subsection-head">
            <h3 className="ec-subsection-title">Routing recommendations</h3>
            <span className="ec-chip-faint">{recs.length}</span>
          </div>
          <ul className="ec-coord-list" data-cc-reviewer-recommendations>
            {recs.map((r) => (
              <li
                key={r.id}
                className="ec-coord-row"
                data-cc-rec-id={r.id}
                data-cc-rec-type={r.recommendationType}
                data-cc-rec-severity={r.severity}
              >
                <div className="ec-coord-row-main">
                  <span className="ec-coord-type">{r.recommendationType}</span>
                  <span
                    className="ec-chip"
                    data-cc-tile-severe={
                      r.severity === "CRITICAL" || r.severity === "HIGH"
                        ? "true"
                        : "false"
                    }
                  >
                    {r.reasonCode}
                  </span>
                </div>
                <div className="ec-coord-explanation">{r.explanation}</div>
                <time className="ec-chip-faint" dateTime={r.createdAt}>
                  {relTime(r.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SectionShell>
  );
}

function OperationalGraphSummaryBoard({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["operationalGraph"];
}) {
  if (!section) return null;
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell
        kicker="Operational Graph"
        title="Graph read degraded"
        severity="warning"
      >
        <SectionNote status="unavailable" kind="relationships" />
      </SectionShell>
    );
  }
  const d = section.data;
  const totalNodes = d.nodeCountsByType.reduce((acc, n) => acc + n.count, 0);
  if (totalNodes === 0 && d.topRootCauses.length === 0) {
    return (
      <SectionShell kicker="Operational Graph" title="No graph topology yet">
        <EnterpriseEmpty
          title="Graph empty — no incidents or workflows to project"
          body="The graph projects every active incident, workflow, correlation, and their linked cases / evidence / reviewers / queues. A 0-result state means the workspace currently has no operational pressure to model."
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      kicker="Operational Graph"
      title={`${totalNodes} nodes · ${d.edgeCountsByType.reduce((a, e) => a + e.count, 0)} edges`}
    >
      <div className="ec-tile-grid" data-cc-graph-counts>
        {d.nodeCountsByType.map((n) => (
          <div
            key={`node:${n.nodeType}`}
            className="ec-tile"
            data-cc-graph-node-type={n.nodeType}
          >
            <span className="ec-tile-value">{n.count}</span>
            <span className="ec-tile-label">{n.nodeType}</span>
          </div>
        ))}
      </div>
      <div className="ec-tile-grid" data-cc-graph-blast-radius>
        <div className="ec-tile" data-cc-blast-evidence>
          <span className="ec-tile-value">{d.blastRadius.impactedEvidenceCount}</span>
          <span className="ec-tile-label">Impacted evidence</span>
        </div>
        <div className="ec-tile" data-cc-blast-cases>
          <span className="ec-tile-value">{d.blastRadius.impactedCaseCount}</span>
          <span className="ec-tile-label">Impacted cases</span>
        </div>
        <div className="ec-tile" data-cc-blast-reviewers>
          <span className="ec-tile-value">{d.blastRadius.impactedReviewerCount}</span>
          <span className="ec-tile-label">Impacted reviewers</span>
        </div>
      </div>
      {d.topRootCauses.length > 0 ? (
        <div
          className="ec-subsection"
          data-cc-graph-root-causes-block
          aria-label="Top root causes"
        >
          <div className="ec-subsection-head">
            <h3 className="ec-subsection-title">Top root causes</h3>
            <span className="ec-chip-faint">{d.topRootCauses.length}</span>
          </div>
          <ul className="ec-telemetry-list" data-cc-graph-root-causes>
            {d.topRootCauses.map((r) => (
              <li
                key={r.nodeId}
                className="ec-telemetry-row"
                data-cc-graph-root-id={r.nodeId}
                data-cc-graph-root-type={r.nodeType}
              >
                <div className="ec-telemetry-row-main">
                  <span className="ec-telemetry-label">{r.label}</span>
                  <span className="ec-chip-faint">{r.nodeType}</span>
                  <span
                    className="ec-chip"
                    data-cc-tile-severe={
                      r.severity === "CRITICAL" || r.severity === "HIGH"
                        ? "true"
                        : "false"
                    }
                  >
                    {r.severity}
                  </span>
                </div>
                <div className="ec-telemetry-meta">
                  <span>out-degree {r.outDegree}</span>
                  <span className="ec-chip-faint">{r.status}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SectionShell>
  );
}

function OrganizationalHealthBoard({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["organizationalHealth"];
}) {
  if (!section) return null;
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell
        kicker="Organizational Health"
        title="Health read degraded"
        severity="warning"
      >
        <SectionNote status="unavailable" kind="org-intelligence-v2" />
      </SectionShell>
    );
  }
  const d = section.data;
  if (d.healthScore === null) {
    return (
      <SectionShell kicker="Organizational Health" title="No health snapshot yet">
        <EnterpriseEmpty
          title="Organizational health snapshot not yet computed"
          body="The maturity engine computes a deterministic 0..100 score per workspace from real counters (open incidents, active workflows, resolved-in-7d, queue freshness, audit-readiness blockers, reviewer overload). The first snapshot is written lazily on the next dashboard load."
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      kicker="Organizational Health"
      title={`Health · ${d.healthScore}/100`}
      severity={
        d.healthScore !== null && d.healthScore < 40
          ? "high"
          : d.healthScore !== null && d.healthScore < 60
            ? "warning"
            : "info"
      }
    >
      <div className="ec-tile-grid" data-cc-org-health-tiles>
        <div className="ec-tile" data-cc-health-key="health">
          <span className="ec-tile-value">{d.healthScore}</span>
          <span className="ec-tile-label">Overall health</span>
        </div>
        <div className="ec-tile" data-cc-health-key="operational">
          <span className="ec-tile-value">{d.operationalMaturityScore ?? "—"}</span>
          <span className="ec-tile-label">Operational maturity</span>
        </div>
        <div className="ec-tile" data-cc-health-key="governance">
          <span className="ec-tile-value">{d.governanceMaturityScore ?? "—"}</span>
          <span className="ec-tile-label">Governance maturity</span>
        </div>
        <div className="ec-tile" data-cc-health-key="audit">
          <span className="ec-tile-value">{d.auditReadinessScore ?? "—"}</span>
          <span className="ec-tile-label">Audit readiness</span>
        </div>
        <div className="ec-tile" data-cc-health-key="reviewer">
          <span className="ec-tile-value">{d.reviewerMaturityScore ?? "—"}</span>
          <span className="ec-tile-label">Reviewer maturity</span>
        </div>
        <div className="ec-tile" data-cc-health-key="queue-reliability">
          <span className="ec-tile-value">{d.queueReliabilityScore ?? "—"}</span>
          <span className="ec-tile-label">Queue reliability</span>
        </div>
        <div className="ec-tile" data-cc-health-key="artifact-reliability">
          <span className="ec-tile-value">{d.artifactReliabilityScore ?? "—"}</span>
          <span className="ec-tile-label">Artifact reliability</span>
        </div>
        <div className="ec-tile" data-cc-health-key="workflow-completion">
          <span className="ec-tile-value">{d.workflowCompletion7d ?? "—"}</span>
          <span className="ec-tile-label">Workflows resolved · 7d</span>
        </div>
        <div className="ec-tile" data-cc-health-key="incident-frequency">
          <span className="ec-tile-value">{d.incidentFrequency7d ?? "—"}</span>
          <span className="ec-tile-label">Active incidents</span>
        </div>
      </div>
      <div className="ec-section-foot">
        Scores derive from real counters via deterministic thresholds — no
        AI/ML, no fabricated metrics. Snapshot sampled{" "}
        {d.sampledAtUtc ? relTime(d.sampledAtUtc) : "—"}.
      </div>
    </SectionShell>
  );
}

// ============================================================================
// Phase 32.8C++ Deep Operations Intelligence — section components
// ============================================================================

function PredictiveRiskBoard({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["predictiveRisk"];
}) {
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell kicker="Predictive Risk Forecast" title="Forecast read degraded" severity="warning">
        <SectionNote status="unavailable" kind="predictive-risk" />
      </SectionShell>
    );
  }
  if (section.forecasts.length === 0) {
    return (
      <SectionShell
        kicker="Predictive Risk Forecast"
        title="No risk forecasts based on current signals"
      >
        <EnterpriseEmpty
          title="No deterministic risk signals firing"
          body="The forecast is computed from real engine outputs (reviewer + governance + pipeline + audit + retry-storm signals). Forecasts appear here when concrete thresholds are crossed."
          hint="This is a deterministic heuristic forecast — not an ML prediction or AI insight."
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      kicker="Predictive Risk Forecast"
      title={`${section.forecasts.length} deterministic risk forecast${section.forecasts.length === 1 ? "" : "s"}`}
      severity={
        section.forecasts.some((f) => f.severity === "critical")
          ? "critical"
          : section.forecasts.some((f) => f.severity === "high")
            ? "high"
            : "warning"
      }
    >
      <ul className="ec-forecast-list" data-cc-forecast-list>
        {section.forecasts.map((f) => (
          <li
            key={f.id}
            className="ec-forecast-row"
            data-cc-forecast-id={f.id}
            data-cc-forecast-type={f.forecastType}
            data-cc-forecast-severity={f.severity}
            data-cc-forecast-confidence={f.confidence}
          >
            <div className="ec-forecast-row-head">
              <span className="ec-forecast-type">{f.forecastType}</span>
              <span className="ec-chip" data-cc-tile-severe={f.severity === "high" || f.severity === "critical" ? "true" : "false"}>
                {f.severity.toUpperCase()}
              </span>
              <span className="ec-chip-faint">confidence · {f.confidence}</span>
            </div>
            <div className="ec-forecast-reason">{f.reason}</div>
            <div className="ec-forecast-impact">
              Likely impact: {f.likelyImpact}
            </div>
            <div className="ec-forecast-action">
              Recommended: {f.recommendedAction}
            </div>
          </li>
        ))}
      </ul>
      <div className="ec-section-foot">
        Forecasts are derived from real engine outputs — no ML, no AI claims.
      </div>
    </SectionShell>
  );
}

function OrgIntelligenceV2Board({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["organizationalIntelligenceV2"];
}) {
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell
        kicker="Organizational Intelligence V2"
        title="Org intelligence read degraded"
        severity="warning"
      >
        <SectionNote status="unavailable" kind="org-intelligence-v2" />
      </SectionShell>
    );
  }
  const d = section.data;
  const healthSeverity: SeverityTone =
    d.orgHealth === "CRITICAL"
      ? "critical"
      : d.orgHealth === "DEGRADED"
        ? "high"
        : d.orgHealth === "WATCH"
          ? "warning"
          : "info";
  return (
    <SectionShell
      kicker="Organizational Intelligence V2"
      title={`Org health · ${d.orgHealth}`}
      severity={healthSeverity}
    >
      <div className="ec-tile-grid" data-cc-org-v2-tiles>
        <div className="ec-tile" data-cc-org-v2-tile="evidence_24h">
          <span className="ec-tile-value">{d.throughputWindows.last24h}</span>
          <span className="ec-tile-label">Evidence · 24h</span>
        </div>
        <div className="ec-tile" data-cc-org-v2-tile="evidence_7d">
          <span className="ec-tile-value">{d.throughputWindows.last7d}</span>
          <span className="ec-tile-label">Evidence · 7d</span>
        </div>
        <div className="ec-tile" data-cc-org-v2-tile="evidence_30d">
          <span className="ec-tile-value">{d.throughputWindows.last30d}</span>
          <span className="ec-tile-label">Evidence · 30d</span>
        </div>
      </div>
      {d.bottleneckDomains.length > 0 ? (
        <div className="ec-bottleneck-grid">
          <h4 className="ec-bottleneck-title">Bottleneck domains</h4>
          <ul className="ec-bottleneck-list" data-cc-bottleneck-list>
            {d.bottleneckDomains.map((b) => (
              <li
                key={b.domain}
                className="ec-bottleneck-row"
                data-cc-bottleneck-domain={b.domain}
              >
                <span>{b.domain}</span>
                <span className="ec-chip">
                  {b.pressureItems} pressure item{b.pressureItems === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {d.topPressureSources.length > 0 ? (
        <div className="ec-bottleneck-grid">
          <h4 className="ec-bottleneck-title">Top pressure sources</h4>
          <ul className="ec-bottleneck-list" data-cc-top-sources-list>
            {d.topPressureSources.map((s) => (
              <li
                key={s.sourceTable}
                className="ec-bottleneck-row"
                data-cc-pressure-source={s.sourceTable}
              >
                <code className="ec-bottleneck-source">{s.sourceTable}</code>
                <span className="ec-chip">{s.itemCount}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {d.recommendedActions.length > 0 ? (
        <ul className="ec-recommended-actions" data-cc-org-recommended-actions>
          {d.recommendedActions.map((a, i) => (
            <li key={i} className="ec-recommended-action-row">
              · {a}
            </li>
          ))}
        </ul>
      ) : null}
    </SectionShell>
  );
}

function RelationshipIntelligenceBoard({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["relationshipIntelligence"];
}) {
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell
        kicker="Evidence Relationship Intelligence"
        title="Relationship intelligence read degraded"
        severity="warning"
      >
        <SectionNote status="unavailable" kind="relationships" />
      </SectionShell>
    );
  }
  if (section.clusters.length === 0) {
    return (
      <SectionShell
        kicker="Evidence Relationship Intelligence"
        title="No relationship clusters detected"
      >
        <EnterpriseEmpty
          title="No evidence relationship clusters"
          body="Relationship clusters surface when ≥ 2 evidence records share a real signal (file hash, submitter, explicit EvidenceRelationship row). The full graph view is deferred — see unsupported signals."
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      kicker="Evidence Relationship Intelligence"
      title={`${section.clusters.length} relationship cluster${section.clusters.length === 1 ? "" : "s"}`}
    >
      <ul className="ec-cluster-list" data-cc-cluster-list>
        {section.clusters.map((c) => (
          <li
            key={c.id}
            className="ec-cluster-row"
            data-cc-cluster-id={c.id}
            data-cc-cluster-kind={c.kind}
            data-cc-cluster-severity={c.severity}
          >
            <div className="ec-cluster-row-main">
              <span className="ec-cluster-kind">{c.kind}</span>
              <span className="ec-chip" data-cc-tile-severe={c.severity === "high" || c.severity === "critical" ? "true" : "false"}>
                {c.reasonCode}
              </span>
              <span className="ec-chip-faint">{c.confidence}</span>
            </div>
            <div className="ec-cluster-explanation">
              {c.operationalExplanation}
            </div>
            <div className="ec-cluster-action">
              Recommended: {c.recommendedAction}
            </div>
            <div className="ec-cluster-meta">
              {c.evidenceIds.length} evidence
              {c.caseIds.length > 0 ? ` · ${c.caseIds.length} case${c.caseIds.length === 1 ? "" : "s"}` : ""}
            </div>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

function CrossCaseIntelligenceV2Board({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["crossCaseIntelligenceV2"];
}) {
  if (section.meta.status === "not_applicable") {
    return (
      <SectionShell
        kicker="Cross-Case Intelligence"
        title="Personal workspace"
      >
        <PersonalNote subsystem="reviewer" />
      </SectionShell>
    );
  }
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell
        kicker="Cross-Case Intelligence"
        title="Cross-case intelligence read degraded"
        severity="warning"
      >
        <SectionNote status="unavailable" kind="cross-case-v2" />
      </SectionShell>
    );
  }
  if (section.signals.length === 0) {
    return (
      <SectionShell
        kicker="Cross-Case Intelligence"
        title="No cross-case signals firing"
      >
        <EnterpriseEmpty
          title="No cross-case patterns detected"
          body="Cross-case signals fire when ≥ 2 cases share a real operational condition (governance block, reviewer overload, failed pipeline pattern, stale preservation)."
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      kicker="Cross-Case Intelligence"
      title={`${section.signals.length} cross-case signal${section.signals.length === 1 ? "" : "s"}`}
    >
      <ul className="ec-cross-list" data-cc-cross-list>
        {section.signals.map((s) => (
          <li
            key={s.id}
            className="ec-cross-row"
            data-cc-cross-id={s.id}
            data-cc-cross-type={s.signalType}
            data-cc-cross-severity={s.severity}
          >
            <div className="ec-cross-row-main">
              <span className="ec-cross-type">{s.signalType}</span>
              <span className="ec-chip" data-cc-tile-severe={s.severity === "high" || s.severity === "critical" ? "true" : "false"}>
                {s.severity.toUpperCase()}
              </span>
            </div>
            <div className="ec-cross-meaning">{s.operationalMeaning}</div>
            <div className="ec-cross-action">Recommended: {s.recommendedAction}</div>
            <div className="ec-cross-meta">
              {s.affectedCaseIds.length} affected case
              {s.affectedCaseIds.length === 1 ? "" : "s"}
              {s.affectedEvidenceIds.length > 0
                ? ` · ${s.affectedEvidenceIds.length} evidence`
                : ""}
            </div>
            <Link href={s.route} className="ec-cross-route">
              Open
            </Link>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

function DeepIntegrityWatch({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["deepIntegrityWatch"];
}) {
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell
        kicker="Deep Integrity Watch"
        title="Deep integrity read degraded"
        severity="warning"
      >
        <SectionNote status="unavailable" kind="deep-integrity" />
      </SectionShell>
    );
  }
  if (section.items.length === 0) {
    return (
      <SectionShell
        kicker="Deep Integrity Watch"
        title="No deep integrity signals require review"
      >
        <EnterpriseEmpty
          title="No deep integrity anomalies detected"
          body="The deep watch reads Evidence verificationStatus + TSA token + OTS status + report/package relations. Deeper hash-recompute lives in the worker pipeline."
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      kicker="Deep Integrity Watch"
      title={`${section.items.length} integrity signal${section.items.length === 1 ? "" : "s"}`}
      severity={section.items.some((i) => i.severity === "critical") ? "critical" : "high"}
    >
      <ul className="ec-deep-integrity-list" data-cc-deep-integrity-list>
        {section.items.map((it) => {
          const tsa = it.tsaTimestampIntelligence;
          // Phase 32.8C++++++ — TSA issuer block. Operators see exactly
          // what the worker parsed (or that parsing is unavailable).
          // We NEVER fabricate issuer values; nulls render as "—".
          const renderTsa = tsa && tsa.parseStatus !== null;
          return (
            <li
              key={`${it.evidenceId}:${it.reasonCode}`}
              className="ec-deep-integrity-row"
              data-cc-deep-integrity-reason={it.reasonCode}
              data-cc-deep-integrity-severity={it.severity}
              data-cc-deep-integrity-confidence={it.confidence}
              data-cc-tsa-parse-status={tsa?.parseStatus ?? "absent"}
            >
              <Link href={it.href} className="ec-deep-integrity-link">
                <div className="ec-deep-integrity-row-main">
                  <span className="ec-deep-integrity-title">{it.title}</span>
                  <span
                    className="ec-chip"
                    data-cc-tile-severe={it.severity === "critical" || it.severity === "high" ? "true" : "false"}
                  >
                    {it.reasonCode}
                  </span>
                </div>
                <div className="ec-deep-integrity-explanation">
                  {it.explanation}
                </div>
                {renderTsa ? (
                  <div
                    className="ec-tsa-intel"
                    data-cc-tsa-intel
                    aria-label="TSA timestamp intelligence"
                  >
                    <span className="ec-chip-faint">TSA</span>
                    {tsa!.parseStatus === "PARSED" ? (
                      <>
                        <span data-cc-tsa-issuer-cn>
                          {tsa!.issuerCommonName ?? "—"}
                        </span>
                        <span className="ec-chip-faint" data-cc-tsa-issuer-org>
                          {tsa!.issuerOrganization ?? "—"}
                        </span>
                        {tsa!.policyOid ? (
                          <span className="ec-chip-faint" data-cc-tsa-policy-oid>
                            policy · <code>{tsa!.policyOid}</code>
                          </span>
                        ) : null}
                      </>
                    ) : tsa!.parseStatus === "UNAVAILABLE" ? (
                      <span className="ec-chip-faint" data-cc-tsa-unavailable>
                        TSA issuer parsing not yet available
                        {tsa!.parseErrorCode ? ` (${tsa!.parseErrorCode})` : ""}
                      </span>
                    ) : tsa!.parseStatus === "FAILED" ? (
                      <span className="ec-chip" data-cc-tsa-failed data-cc-tile-severe="true">
                        TSA parse failed
                        {tsa!.parseErrorCode ? ` · ${tsa!.parseErrorCode}` : ""}
                      </span>
                    ) : (
                      <span className="ec-chip-faint">TSA · {tsa!.parseStatus}</span>
                    )}
                  </div>
                ) : null}
                <div className="ec-deep-integrity-source">
                  Source · {it.sourceFields.join(" + ")}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="ec-section-foot">
        Each signal includes the exact source field(s). Language is operator-side
        review — no claim of authenticity or admissibility.
      </div>
    </SectionShell>
  );
}

function AccessSecurityClassifierBoard({
  section,
  rollupHealth,
}: {
  section: CommandCenterEnvelope["sections"]["accessSecurityClassifier"];
  /** Phase 32.8C+++++++ — backend-derived health for the rollup table.
   *  A read failure on the rollup is DEGRADED (amber), not UNAVAILABLE
   *  (red), as long as the canonical SecurityEvent log is alive. */
  rollupHealth?: NonNullable<CommandCenterEnvelope["opsHealth"]>["securityRollup"] | null;
}) {
  // Phase 32.8C closure pass — distinguish:
  //   (a) classifier read failed AND no anomalies in this fetch    → degraded read
  //   (b) classifier read succeeded but returned 0 anomalies       → healthy (no incidents)
  //   (c) classifier read succeeded with anomalies                 → render them
  if (section.meta.status === "unavailable" && section.anomalies.length === 0) {
    // Phase 32.8C+++++++ — only render the RED unavailable wall if the
    // canonical SecurityEvent log itself is also unhealthy. Otherwise
    // render an AMBER degraded banner that explains the canonical
    // source is still alive.
    const canonicalAlive =
      rollupHealth?.canonicalSourceHealthy !== false;
    return (
      <SectionShell
        kicker="Security Anomaly Classifier"
        title={
          canonicalAlive
            ? "Detection running · rollup delayed"
            : "Detection running · classifier read degraded"
        }
        severity={canonicalAlive ? "warning" : "high"}
      >
        <OpsHealthBanner
          title="Security rollup"
          kind="security-rollup"
          health={rollupHealth ?? null}
        />
        <div className="ec-section-foot" data-cc-classifier-fallback>
          Detection is operational via the canonical SecurityEvent audit
          log. The dashboard rollup will re-classify on the next refresh.
        </div>
      </SectionShell>
    );
  }
  if (section.anomalies.length === 0) {
    return (
      <SectionShell
        kicker="Security Anomaly Classifier"
        title="No security anomalies detected · 24h"
      >
        <EnterpriseEmpty
          title="No suspicious activity in the last 24h"
          body="The classifier scans SecurityEvent rows in a bounded 24h window and groups them by (category, actor, eventType). A 0-result state means: no repeated failed access, no blocked export attempts, no API credential changes, no webhook failure spikes, no step-up failures, no permission-denied bursts, no admin role changes flagged above the burst threshold."
          hint="The classifier is rule-based — no ML scoring. The full audit trail remains on the SecurityEvent log."
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      kicker="Security Anomaly Classifier"
      title={`${section.anomalies.length} classified anomal${section.anomalies.length === 1 ? "y" : "ies"} · 24h`}
      severity={section.anomalies.some((a) => a.severity === "high") ? "high" : "warning"}
    >
      <ul className="ec-classifier-list" data-cc-classifier-list>
        {section.anomalies.map((a, i) => (
          <li
            key={`${a.category}:${a.eventType}:${i}`}
            className="ec-classifier-row"
            data-cc-classifier-category={a.category}
            data-cc-classifier-severity={a.severity}
            data-cc-classifier-count={a.count}
          >
            <div className="ec-classifier-row-main">
              <span className="ec-classifier-category">{a.category}</span>
              <span className="ec-chip">{a.count}× · {a.timeWindow}</span>
              <span
                className="ec-chip"
                data-cc-tile-severe={a.severity === "high" ? "true" : "false"}
              >
                {a.severity.toUpperCase()}
              </span>
            </div>
            <div className="ec-classifier-explanation">{a.explanation}</div>
            <div className="ec-classifier-action">
              Recommended: {a.recommendedAction}
            </div>
            <div className="ec-classifier-source">
              source · {a.sourceTable} · eventType:{" "}
              <code>{a.eventType}</code>
            </div>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

/**
 * Stale-heartbeat threshold (seconds). A worker telemetry row older than
 * this is rendered with the `data-cc-stale="true"` flag so operators can
 * see the silence visually.
 */
const WORKER_HEARTBEAT_STALE_SECONDS = 300;

/**
 * Freshness threshold for queue snapshot samples (seconds). Samples
 * older than this trigger the "telemetry delayed" degradation banner —
 * the sampler is running but its last write is stale.
 */
const QUEUE_SAMPLE_STALE_SECONDS = 600;

/**
 * Telemetry freshness classifier.
 *
 * Returns:
 *  - `healthy_empty` — no rows yet AND no observed stale samples; this
 *    is the legitimate "platform is up but hasn't sampled yet" state.
 *  - `healthy`       — rows exist and the freshest sample is within
 *    the threshold.
 *  - `delayed`       — rows exist but the freshest sample is older than
 *    the threshold (telemetry is delayed, NOT unavailable).
 *  - `unavailable`   — the upstream meta says the read could not
 *    complete at all.
 */
type TelemetryFreshness = "healthy_empty" | "healthy" | "delayed" | "unavailable";

function classifyTelemetryFreshness(opts: {
  metaStatus: SectionStatus;
  freshestSampleUtc: string | null;
  staleAfterSeconds: number;
}): TelemetryFreshness {
  if (opts.metaStatus === "unavailable") return "unavailable";
  if (!opts.freshestSampleUtc) return "healthy_empty";
  const ageSeconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(opts.freshestSampleUtc).getTime()) / 1000),
  );
  return ageSeconds > opts.staleAfterSeconds ? "delayed" : "healthy";
}

function workerStatusSeverity(
  status: string,
): "info" | "warning" | "high" | "critical" {
  switch (status) {
    case "CRITICAL":
      return "critical";
    case "DEGRADED":
      return "high";
    case "UNKNOWN":
      return "warning";
    default:
      return "info";
  }
}

function QueueWorkerTelemetryBoard({
  section,
  telemetryHealth,
  reconcileHealth,
}: {
  section: CommandCenterEnvelope["sections"]["queueWorkerTelemetry"];
  /** Phase 32.8C+++++++ — backend-derived operational health for the
   *  worker/queue telemetry sampler and the reviewer reconcile loop. */
  telemetryHealth?: NonNullable<CommandCenterEnvelope["opsHealth"]>["telemetry"] | null;
  reconcileHealth?: NonNullable<CommandCenterEnvelope["opsHealth"]>["reconcile"] | null;
}) {
  const d = section.data;
  const snapshots = d?.queueSnapshots ?? [];
  const heartbeats = d?.workerHeartbeats ?? [];
  // Phase 32.8C closure pass — compute freshness directly so the worker
  // being silently up but never having sampled doesn't render as a
  // "unavailable" red card. `healthy_empty` means the platform is up
  // but hasn't sampled yet; `delayed` means the sampler is running but
  // its last write is older than the threshold.
  const queueFreshness = classifyTelemetryFreshness({
    metaStatus: section.meta.status,
    freshestSampleUtc: snapshots[0]?.sampledAtUtc ?? null,
    staleAfterSeconds: QUEUE_SAMPLE_STALE_SECONDS,
  });
  const workerFreshness = classifyTelemetryFreshness({
    metaStatus: section.meta.status,
    freshestSampleUtc: heartbeats[0]?.heartbeatAtUtc ?? null,
    staleAfterSeconds: WORKER_HEARTBEAT_STALE_SECONDS * 2,
  });
  if (
    section.meta.status === "unavailable" &&
    snapshots.length === 0 &&
    heartbeats.length === 0
  ) {
    // Truly unavailable: meta says read failed AND no fallback data.
    return (
      <SectionShell
        kicker="Queue / Worker Telemetry"
        title="Telemetry read degraded"
      >
        <SectionNote status="unavailable" kind="queue-worker-telemetry" />
      </SectionShell>
    );
  }
  // Phase 32.8C+++++++ — prefer the structured ops-health state over
  // the raw `reconcileHealth` enum so a stale-but-alive reconcile loop
  // never paints as a hard UNAVAILABLE failure.
  const reconcileLabel = reconcileHealth
    ? humanizeOpsHealthStatus(reconcileHealth.status)
    : `Reconcile · ${d.reconcileHealth}`;
  const sectionSeverity = opsHealthToShellSeverity(reconcileHealth) ??
    (d.reconcileHealth === "UNAVAILABLE"
      ? "high"
      : d.reconcileHealth === "STALE"
        ? "warning"
        : "info");
  return (
    <SectionShell
      kicker="Queue / Worker Telemetry"
      title={`Reconcile · ${reconcileLabel}`}
      severity={sectionSeverity}
    >
      {/* Phase 32.8C+++++++ — render the structured ops-health banner
          if one of the evaluators reports stale/degraded/unavailable.
          This replaces the earlier raw `UNAVAILABLE` red wall when the
          subsystem is alive but the reconcile heartbeat is stale. */}
      <OpsHealthBanner
        title="Reviewer reconcile"
        kind="reconcile"
        health={reconcileHealth ?? null}
      />
      <OpsHealthBanner
        title="Worker/queue telemetry"
        kind="telemetry"
        health={telemetryHealth ?? null}
      />

      {queueFreshness === "delayed" || workerFreshness === "delayed" ? (
        <div
          className="ec-section-note"
          data-cc-section-status="degraded"
          data-cc-section-kind="queue-worker-telemetry"
          data-cc-telemetry-freshness="delayed"
          role="status"
        >
          Telemetry sampler returning delayed snapshots. The worker remains
          operational; the latest sample is older than the freshness
          threshold.
        </div>
      ) : null}
      <div className="ec-tile-grid" data-cc-queue-telemetry-tiles>
        <div className="ec-tile" data-cc-queue-telemetry-tile="heartbeat" data-cc-tile-severe={d.reconcileHealth === "UNAVAILABLE" || d.reconcileHealth === "STALE" ? "true" : "false"}>
          <span className="ec-tile-value">{d.reconcileHealth}</span>
          <span className="ec-tile-label">Reconcile health</span>
        </div>
        <div className="ec-tile" data-cc-queue-telemetry-tile="freshness">
          <span className="ec-tile-value">
            {d.reconcileFreshnessHours !== null
              ? `${d.reconcileFreshnessHours.toFixed(2)}h`
              : "—"}
          </span>
          <span className="ec-tile-label">Heartbeat age</span>
        </div>
        <div className="ec-tile" data-cc-queue-telemetry-tile="review_queue">
          <span className="ec-tile-value">{d.reviewQueueDepth}</span>
          <span className="ec-tile-label">Review queue depth</span>
        </div>
        <div className="ec-tile" data-cc-queue-telemetry-tile="report_queue">
          <span className="ec-tile-value">{d.reportQueuePending}</span>
          <span className="ec-tile-label">Report queue pending</span>
        </div>
        <div className="ec-tile" data-cc-queue-telemetry-tile="package_queue">
          <span className="ec-tile-value">{d.packageQueuePending}</span>
          <span className="ec-tile-label">Package queue pending</span>
        </div>
        <div
          className="ec-tile"
          data-cc-queue-telemetry-tile="retry_storms"
          data-cc-tile-severe={d.retryStormIncidents > 0 ? "true" : "false"}
        >
          <span className="ec-tile-value">{d.retryStormIncidents}</span>
          <span className="ec-tile-label">Retry storms</span>
        </div>
      </div>

      {/* Phase 32.8C++++++ — Worker heartbeats from WorkerTelemetrySnapshot. */}
      <div
        className="ec-subsection"
        data-cc-worker-heartbeats-block
        aria-label="Worker heartbeats"
      >
        <div className="ec-subsection-head">
          <h3 className="ec-subsection-title">Worker heartbeats</h3>
          <span className="ec-chip-faint">
            {heartbeats.length === 0
              ? "No worker heartbeats yet"
              : `${heartbeats.length} active worker${heartbeats.length === 1 ? "" : "s"}`}
          </span>
        </div>
        {heartbeats.length === 0 ? (
          <EnterpriseEmpty
            title="No worker heartbeats yet"
            body="Worker telemetry snapshots populate once the worker sampler has emitted at least one heartbeat."
          />
        ) : (
          <ul className="ec-telemetry-list" data-cc-worker-heartbeats>
            {heartbeats.map((h) => {
              const isStale = h.ageSeconds > WORKER_HEARTBEAT_STALE_SECONDS;
              return (
                <li
                  key={`${h.workerKind}:${h.workerId}`}
                  className="ec-telemetry-row"
                  data-cc-worker-id={h.workerId}
                  data-cc-worker-kind={h.workerKind}
                  data-cc-worker-status={h.status}
                  data-cc-stale={isStale ? "true" : "false"}
                  data-cc-coord-severity={workerStatusSeverity(h.status)}
                >
                  <div className="ec-telemetry-row-main">
                    <span className="ec-telemetry-label">{h.workerKind}</span>
                    <span
                      className="ec-chip"
                      data-cc-tile-severe={
                        h.status === "CRITICAL" || h.status === "DEGRADED" || isStale
                          ? "true"
                          : "false"
                      }
                    >
                      {h.status}
                    </span>
                    {isStale ? (
                      <span className="ec-chip" data-cc-stale-flag>
                        Heartbeat stale
                      </span>
                    ) : null}
                  </div>
                  <div className="ec-telemetry-meta">
                    <span data-cc-worker-id-label title={h.workerId}>
                      {h.workerId.length > 24
                        ? `${h.workerId.slice(0, 24)}…`
                        : h.workerId}
                    </span>
                    <time dateTime={h.heartbeatAtUtc} className="ec-chip-faint">
                      heartbeat {relTime(h.heartbeatAtUtc)}
                    </time>
                    {h.processedCount !== null && h.processedCount !== undefined ? (
                      <span className="ec-chip-faint">
                        {h.processedCount} processed
                      </span>
                    ) : null}
                    {h.failedCount !== null && h.failedCount !== undefined && h.failedCount > 0 ? (
                      <span
                        className="ec-chip"
                        data-cc-tile-severe="true"
                      >
                        {h.failedCount} failed
                      </span>
                    ) : null}
                    {h.lastErrorCode ? (
                      <span className="ec-chip" data-cc-tile-severe="true">
                        {h.lastErrorCode}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Phase 32.8C++++++ — Queue snapshots from QueueTelemetrySnapshot. */}
      <div
        className="ec-subsection"
        data-cc-queue-snapshots-block
        aria-label="Queue snapshots"
      >
        <div className="ec-subsection-head">
          <h3 className="ec-subsection-title">Queue snapshots</h3>
          <span className="ec-chip-faint">
            {snapshots.length === 0
              ? "No queue samples yet"
              : `${snapshots.length} queue${snapshots.length === 1 ? "" : "s"}`}
          </span>
        </div>
        {snapshots.length === 0 ? (
          <EnterpriseEmpty
            title="No queue telemetry yet"
            body="Queue snapshots populate from the worker BullMQ sampler or the API DB-derived writer on first dashboard read."
          />
        ) : (
          <ul className="ec-telemetry-list" data-cc-queue-snapshots>
            {snapshots.map((q) => (
              <li
                key={`${q.queueName}:${q.sampledAtUtc}`}
                className="ec-telemetry-row"
                data-cc-queue-name={q.queueName}
                data-cc-queue-domain={q.queueDomain}
                data-cc-queue-source={q.source}
                data-cc-tile-severe={
                  q.failedCount > 0 || q.stalledCount > 0 ? "true" : "false"
                }
              >
                <div className="ec-telemetry-row-main">
                  <span className="ec-telemetry-label">{q.queueName}</span>
                  <span className="ec-chip-faint">{q.queueDomain}</span>
                  <span
                    className="ec-chip-faint"
                    data-cc-queue-source-label
                    title={`Sampled by ${q.source}`}
                  >
                    {q.source}
                  </span>
                </div>
                <div className="ec-telemetry-meta">
                  <span>{q.waitingCount} waiting</span>
                  <span>{q.activeCount} active</span>
                  <span>{q.delayedCount} delayed</span>
                  {q.failedCount > 0 ? (
                    <span className="ec-chip" data-cc-tile-severe="true">
                      {q.failedCount} failed
                    </span>
                  ) : null}
                  {q.stalledCount > 0 ? (
                    <span className="ec-chip" data-cc-tile-severe="true">
                      {q.stalledCount} stalled
                    </span>
                  ) : null}
                  <time dateTime={q.sampledAtUtc} className="ec-chip-faint">
                    sampled {relTime(q.sampledAtUtc)}
                  </time>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="ec-section-foot">
        Worker heartbeats are sampled by the worker every 60s and persisted
        to WorkerTelemetrySnapshot. Queue depth is sampled from BullMQ when
        the worker is online; DB-derived counts are written by the API on
        dashboard load when no fresh BullMQ sample is available.
      </div>
    </SectionShell>
  );
}

function CoordinationBacklogTiles({
  backlog,
}: {
  backlog: CommandCenterEnvelope["sections"]["coordinationSignals"]["backlog"];
}) {
  // Phase 32.8C++++++ — bounded backlog counts from CaseComment +
  // resolvedAtUtc-tracked reviewer comments + annotations.
  return (
    <div className="ec-tile-grid" data-cc-coordination-backlog>
      <div
        className="ec-tile"
        data-cc-backlog-tile="case_comment_open"
        data-cc-tile-severe={backlog.caseCommentOpenCount > 0 ? "true" : "false"}
      >
        <span className="ec-tile-value">{backlog.caseCommentOpenCount}</span>
        <span className="ec-tile-label">Case comments open</span>
      </div>
      <div
        className="ec-tile"
        data-cc-backlog-tile="case_comment_stale"
        data-cc-tile-severe={backlog.caseCommentStaleOpenCount > 0 ? "true" : "false"}
      >
        <span className="ec-tile-value">{backlog.caseCommentStaleOpenCount}</span>
        <span className="ec-tile-label">Case comments stale</span>
      </div>
      <div
        className="ec-tile"
        data-cc-backlog-tile="case_comment_resolved"
      >
        <span className="ec-tile-value">{backlog.caseCommentResolvedCount}</span>
        <span className="ec-tile-label">Case comments resolved</span>
      </div>
      <div
        className="ec-tile"
        data-cc-backlog-tile="reviewer_comment_open"
        data-cc-tile-severe={backlog.reviewerCommentOpenCount > 0 ? "true" : "false"}
      >
        <span className="ec-tile-value">{backlog.reviewerCommentOpenCount}</span>
        <span className="ec-tile-label">Reviewer comments open</span>
      </div>
      <div
        className="ec-tile"
        data-cc-backlog-tile="annotation_open"
        data-cc-tile-severe={backlog.annotationOpenCount > 0 ? "true" : "false"}
      >
        <span className="ec-tile-value">{backlog.annotationOpenCount}</span>
        <span className="ec-tile-label">Annotations open</span>
      </div>
    </div>
  );
}

function CoordinationSignalsBoard({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["coordinationSignals"];
}) {
  if (section.meta.status === "not_applicable") {
    return (
      <SectionShell kicker="Coordination Signals" title="Personal workspace">
        <PersonalNote subsystem="reviewer" />
      </SectionShell>
    );
  }
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell
        kicker="Coordination Signals"
        title="Coordination read degraded"
        severity="warning"
      >
        <SectionNote status="unavailable" kind="coordination" />
      </SectionShell>
    );
  }
  const backlog = section.backlog;
  if (section.signals.length === 0) {
    return (
      <SectionShell kicker="Coordination Signals" title="No coordination signals">
        <CoordinationBacklogTiles backlog={backlog} />
        <EnterpriseEmpty
          title="No unresolved coordination items"
          body="Coordination signals surface unowned escalations, unresolved reviewer comments, unresolved annotations, unresolved case comments, recent legal notes, and stale assigned reviews."
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      kicker="Coordination Signals"
      title={`${section.signals.length} coordination signal${section.signals.length === 1 ? "" : "s"}`}
    >
      <CoordinationBacklogTiles backlog={backlog} />
      <ul className="ec-coord-list" data-cc-coord-list>
        {section.signals.map((s) => (
          <li
            key={s.id}
            className="ec-coord-row"
            data-cc-coord-id={s.id}
            data-cc-coord-type={s.signalType}
            data-cc-coord-severity={s.severity}
            data-cc-coord-entity-type={s.entityType}
          >
            <Link href={s.route} className="ec-coord-link">
              <div className="ec-coord-row-main">
                <span className="ec-coord-type">{s.signalType}</span>
                <span
                  className="ec-chip"
                  data-cc-tile-severe={s.severity === "critical" || s.severity === "high" ? "true" : "false"}
                >
                  {s.reasonCode}
                </span>
              </div>
              <div className="ec-coord-explanation">{s.explanation}</div>
              <time className="ec-chip-faint" dateTime={s.detectedAt}>
                {relTime(s.detectedAt)}
              </time>
            </Link>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

function ReconstructedTimelineSection({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["reconstructedTimeline"];
}) {
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell
        kicker="Reconstructed Operational Timeline"
        title="Reconstructed timeline read degraded"
        severity="warning"
      >
        <SectionNote status="unavailable" kind="reconstructed-timeline" />
      </SectionShell>
    );
  }
  if (section.events.length === 0) {
    return (
      <SectionShell
        kicker="Reconstructed Operational Timeline"
        title="No reconstructed events · 14d"
      >
        <EnterpriseEmpty
          title="Reconstructed timeline empty"
          body="The reconstructed view aggregates Reports, Verification Packages, EvidenceLifecycleEvents, Reviewer Escalations, Operational Incidents, and Security Events — each tagged with actor + confidence + safeToDisplay."
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      kicker="Reconstructed Operational Timeline"
      title={`Reconstructed heartbeat · ${section.events.length} events · last 14d`}
    >
      <ul className="ec-reconstructed-timeline" data-cc-reconstructed-list>
        {section.events.map((ev) => (
          <li
            key={ev.id}
            className="ec-reconstructed-row"
            data-cc-reconstructed-id={ev.id}
            data-cc-reconstructed-family={ev.family}
            data-cc-reconstructed-severity={ev.severity}
            data-cc-reconstructed-confidence={ev.confidence}
          >
            <span
              className="ec-reconstructed-dot"
              data-cc-reconstructed-severity-dot={ev.severity}
            />
            <div className="ec-reconstructed-body">
              {ev.route ? (
                <Link href={ev.route} className="ec-reconstructed-label">
                  {ev.operationalMeaning}
                </Link>
              ) : (
                <span className="ec-reconstructed-label">
                  {ev.operationalMeaning}
                </span>
              )}
              <span className="ec-reconstructed-meta">
                {ev.family} · {ev.type}
                {ev.actor ? ` · actor ${ev.actor}` : ""}
                {" · source: "}
                {ev.sourceTable}
              </span>
            </div>
            <time
              className="ec-reconstructed-time"
              dateTime={ev.timestamp}
              title={ev.timestamp}
            >
              {relTime(ev.timestamp)}
            </time>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// CRITICAL OPERATIONS BAR
// ---------------------------------------------------------------------------

function CriticalOperationsBar({
  envelope,
}: {
  envelope: CommandCenterEnvelope;
}) {
  const pressure = envelope.sections.operationalPressure;
  const workload = envelope.sections.workloadEngine;
  const investigation = envelope.sections.investigationIntelligence;
  const critical = pressure.counts.critical;
  const high = pressure.counts.high;
  const warning = pressure.counts.warning;
  const topAction = envelope.sections.routingQueue.items[0] ?? null;

  const healthTone: SeverityTone =
    workload.health === "CRITICAL" || critical > 0
      ? "critical"
      : workload.health === "DEGRADED" || high > 0
        ? "high"
        : workload.health === "WATCH" || warning > 0
          ? "warning"
          : "info";

  const headline =
    critical > 0
      ? `${critical} critical pressure item${critical === 1 ? "" : "s"} require attention`
      : high > 0
        ? `${high} high-severity item${high === 1 ? "" : "s"} require attention`
        : warning > 0
          ? `${warning} warning-level item${warning === 1 ? "" : "s"} require attention`
          : "Workspace operating within bounded thresholds";

  const investigationCritical = investigation.items.filter(
    (i) => i.riskLevel === "CRITICAL" || i.riskLevel === "HIGH",
  ).length;

  return (
    <div
      className="ec-critical-bar"
      data-cc-critical-bar
      data-cc-critical-tone={healthTone}
    >
      <div className="ec-critical-bar-main">
        <span className="ec-critical-bar-headline" data-cc-critical-headline>
          {headline}
        </span>
        <span className="ec-critical-bar-meta">
          Health · {workload.health} · {investigationCritical} cases at risk ·{" "}
          {pressure.items.length} pressure items
        </span>
      </div>
      {topAction ? (
        <Link
          href={topAction.primaryRoute}
          className="ec-critical-bar-action"
          data-cc-critical-action-route={topAction.primaryRoute}
        >
          Next: {topAction.recommendedAction}
        </Link>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ROUTING QUEUE
// ---------------------------------------------------------------------------

function RoutingQueueSection({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["routingQueue"];
}) {
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell
        kicker="Routing · Actionable Queue"
        title="Routing read degraded"
        severity="warning"
      >
        <SectionNote status="unavailable" kind="routing" />
      </SectionShell>
    );
  }
  if (section.items.length === 0) {
    return (
      <SectionShell
        kicker="Routing · Actionable Queue"
        title="No actionable items in the routing queue"
      >
        <EnterpriseEmpty
          title="Routing queue clear · no operator action required"
          body="No operational pressure items above WARNING severity are currently routed. The routing engine scans every pressure source (overdue reviews, stalled workflows, missing reports/packages, retry storms, governance conflicts, queue saturation, integrity anomalies, escalations) and routes only items that exceed threshold."
          hint="The catalog of pressure sources is unchanged; new actionable items appear as soon as their threshold is crossed."
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      kicker="Routing · Actionable Queue"
      title={`Routing queue · ${section.items.length} actionable item${section.items.length === 1 ? "" : "s"}`}
      severity={section.items.some((i) => i.severity === "critical") ? "critical" : section.items.some((i) => i.severity === "high") ? "high" : "warning"}
    >
      <ul className="ec-routing-list" data-cc-routing-list>
        {section.items.map((item) => (
          <RoutingRow key={item.id} item={item} />
        ))}
      </ul>
    </SectionShell>
  );
}

function RoutingRow({ item }: { item: OperationalPressureItem }) {
  return (
    <li
      className="ec-routing-row"
      data-cc-routing-id={item.id}
      data-cc-routing-reason={item.reasonCode}
      data-cc-routing-domain={item.affectedDomain}
      data-cc-routing-severity={item.severity}
    >
      <div className="ec-routing-row-main">
        <span
          className="ec-routing-severity-dot"
          data-cc-routing-severity-dot={item.severity}
        />
        <div className="ec-routing-body">
          <Link href={item.primaryRoute} className="ec-routing-title">
            {item.title}
          </Link>
          <span className="ec-routing-explanation">
            {item.operationalExplanation}
          </span>
          <span className="ec-routing-meta">
            {item.reasonCode} · {item.affectedDomain}
            {item.ageMs !== null ? ` · ${formatAge(item.ageMs)}` : ""}
            {" · source: "}
            {item.sourceTable}
          </span>
        </div>
      </div>
      <div className="ec-routing-actions">
        {item.canCurrentUserAct ? (
          <Link
            href={item.primaryRoute}
            className="ec-routing-primary"
            data-cc-routing-primary-route
            data-cc-can-act="true"
          >
            {item.safeActionLabel}
          </Link>
        ) : (
          <span
            className="ec-routing-cannot-act"
            data-cc-can-act="false"
            data-cc-required-roles={item.requiredRoles.join(",")}
            title={`Required roles · ${item.requiredRoles.join(" / ")}`}
          >
            {item.safeActionLabel}
          </span>
        )}
        {item.secondaryRoute ? (
          <Link
            href={item.secondaryRoute}
            className="ec-routing-secondary"
            data-cc-routing-secondary-route
          >
            Open runbook
          </Link>
        ) : null}
      </div>
    </li>
  );
}

function formatAge(ms: number): string {
  if (ms < 60_000) return "<1m";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// ---------------------------------------------------------------------------
// INVESTIGATION RISK BOARD
// ---------------------------------------------------------------------------

function InvestigationRiskBoard({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["investigationIntelligence"];
}) {
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell
        kicker="Investigation Risk Board"
        title="Investigation read degraded"
        severity="warning"
      >
        <SectionNote status="unavailable" kind="investigation" />
      </SectionShell>
    );
  }
  if (section.items.length === 0) {
    return (
      <SectionShell
        kicker="Investigation Risk Board"
        title="No active investigations under risk"
      >
        <EnterpriseEmpty
          title="No investigations flagged"
          body="Investigation risk reads case-level evidence + reviewer + governance signals. New flagged cases will surface here as their risk score crosses the LOW threshold."
        />
      </SectionShell>
    );
  }
  const critical = section.items.filter(
    (i) => i.riskLevel === "CRITICAL",
  ).length;
  const high = section.items.filter((i) => i.riskLevel === "HIGH").length;
  return (
    <SectionShell
      kicker="Investigation Risk Board"
      title={`${section.items.length} cases scored · ${critical} critical · ${high} high`}
      severity={critical > 0 ? "critical" : high > 0 ? "high" : "warning"}
    >
      <ul className="ec-risk-list" data-cc-investigation-list>
        {section.items.map((c) => (
          <li
            key={c.caseId}
            className="ec-risk-row"
            data-cc-investigation-case={c.caseId}
            data-cc-investigation-risk={c.riskLevel}
          >
            <Link href={c.href} className="ec-risk-link">
              <div className="ec-risk-row-main">
                <span className="ec-risk-title">{c.caseName}</span>
                <span
                  className="ec-chip"
                  data-cc-investigation-risk-chip={c.riskLevel}
                  data-cc-tile-severe={
                    c.riskLevel === "CRITICAL" || c.riskLevel === "HIGH"
                      ? "true"
                      : "false"
                  }
                >
                  {c.riskLevel}
                </span>
              </div>
              <div className="ec-risk-meta">
                {c.evidenceCount} evidence
                {c.overdueReviewCount > 0
                  ? ` · ${c.overdueReviewCount} overdue review${c.overdueReviewCount === 1 ? "" : "s"}`
                  : ""}
                {c.openEscalationsCount > 0
                  ? ` · ${c.openEscalationsCount} escalation${c.openEscalationsCount === 1 ? "" : "s"}`
                  : ""}
                {c.hasActiveLegalHold ? " · legal preservation" : ""}
              </div>
              <div className="ec-risk-reasons">
                {c.reasonCodes.map((r) => (
                  <span key={r} className="ec-chip-faint" data-cc-investigation-reason={r}>
                    {r}
                  </span>
                ))}
              </div>
              <div className="ec-risk-action">
                Recommended: {c.recommendedAction}
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {section.crossCaseSignals.length > 0 ? (
        <div className="ec-cross-case-signals" data-cc-cross-case-signals>
          <h4 className="ec-cross-case-title">Cross-case signals</h4>
          <ul className="ec-cross-case-list">
            {section.crossCaseSignals.map((s) => (
              <li
                key={s.kind}
                className="ec-cross-case-row"
                data-cc-cross-case-kind={s.kind}
              >
                <Link href={s.href} className="ec-cross-case-link">
                  {s.description}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="ec-section-foot">
        Source: {section.meta.sourceSummary.join(", ")}.
      </div>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// WORKLOAD ENGINE BOARD
// ---------------------------------------------------------------------------

function WorkloadEngineBoard({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["workloadEngine"];
}) {
  if (section.meta.status === "not_applicable") {
    return (
      <SectionShell kicker="Workload Engine" title="Personal workspace">
        <PersonalNote subsystem="reviewer" />
      </SectionShell>
    );
  }
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell kicker="Workload Engine" title="Workload read degraded" severity="warning">
        <SectionNote status="unavailable" kind="workload-engine" />
      </SectionShell>
    );
  }
  const healthSeverity: SeverityTone =
    section.health === "CRITICAL"
      ? "critical"
      : section.health === "DEGRADED"
        ? "high"
        : section.health === "WATCH"
          ? "warning"
          : "info";
  return (
    <SectionShell
      kicker="Workload Engine"
      title={`Team health · ${section.health}`}
      severity={healthSeverity}
    >
      <div className="ec-workload-strip" data-cc-workload-strip>
        <div
          className="ec-workload-tile"
          data-cc-workload-tile="health"
          data-cc-workload-health={section.health}
        >
          <span className="ec-workload-tile-value">{section.health}</span>
          <span className="ec-workload-tile-label">Team health</span>
        </div>
        <div
          className="ec-workload-tile"
          data-cc-workload-tile="saturation"
          data-cc-tile-severe={section.saturationScore >= 7 ? "true" : "false"}
        >
          <span className="ec-workload-tile-value">
            {section.saturationScore.toFixed(1)}
          </span>
          <span className="ec-workload-tile-label">Saturation (0–10)</span>
        </div>
        <div
          className="ec-workload-tile"
          data-cc-workload-tile="bottlenecks"
          data-cc-tile-severe={section.bottlenecks > 0 ? "true" : "false"}
        >
          <span className="ec-workload-tile-value">{section.bottlenecks}</span>
          <span className="ec-workload-tile-label">Bottlenecks</span>
        </div>
      </div>
      {section.reviewers.length === 0 ? (
        <div className="cc-section-note">
          No reviewer assignments active. Workload engine has no data to score.
        </div>
      ) : (
        <ul className="ec-workload-list" data-cc-workload-list>
          {section.reviewers.map((r) => (
            <li
              key={r.userId}
              className="ec-workload-row"
              data-cc-workload-user={r.userId}
              data-cc-workload-bottleneck={r.bottleneck ? "true" : "false"}
              data-cc-workload-inactive={r.inactive ? "true" : "false"}
            >
              <div className="ec-workload-row-main">
                <span className="ec-workload-row-title">
                  {r.displayName ?? r.email ?? r.userId.slice(0, 8)}
                </span>
                <span
                  className="ec-chip"
                  data-cc-tile-severe={r.saturationScore >= 7 ? "true" : "false"}
                >
                  saturation {r.saturationScore}
                </span>
              </div>
              <div className="ec-workload-row-meta">
                <span>{r.assignedCount} assigned</span>
                {r.overdueCount > 0 ? (
                  <span className="ec-chip" data-cc-tile-severe="true">
                    {r.overdueCount} overdue
                  </span>
                ) : null}
                {r.bottleneck ? (
                  <span className="ec-chip" data-cc-tile-severe="true">
                    Bottleneck
                  </span>
                ) : null}
                {r.inactive ? (
                  <span className="ec-chip" data-cc-reviewer-inactive-chip="true">
                    Inactive
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// QUEUE CONGESTION SECTION
// ---------------------------------------------------------------------------

function QueueCongestionSection({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["queueCongestion"];
}) {
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell
        kicker="Queue Congestion"
        title="Queue congestion read degraded"
        severity="warning"
      >
        <SectionNote status="unavailable" kind="queue-congestion" />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      kicker="Queue Congestion"
      title={`Workspace queues · ${section.items.length}`}
    >
      <div className="ec-queue-strip" data-cc-queue-strip>
        {section.items.map((q) => (
          <div
            key={q.queueId}
            className="ec-queue-tile"
            data-cc-queue-id={q.queueId}
            data-cc-queue-severity={q.severity}
            data-cc-tile-severe={
              q.severity === "critical" || q.severity === "high"
                ? "true"
                : "false"
            }
          >
            <span className="ec-queue-tile-value">{q.depth}</span>
            <span className="ec-queue-tile-label">{q.label}</span>
            <span className="ec-queue-tile-source">{q.source}</span>
          </div>
        ))}
      </div>
      {section.meta.unsupportedSignals.length > 0 ? (
        <div className="ec-section-foot">
          Remaining gaps are listed in the Unsupported Signals section. BullMQ
          depth + worker heartbeat are now persisted by Phase 32.8C+++++
          telemetry snapshots; see the Queue / Worker Telemetry section.
        </div>
      ) : null}
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// CUSTODY / INTEGRITY WATCH
// ---------------------------------------------------------------------------

function CustodyIntegrityWatch({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["custodyIntegrityAnomalies"];
}) {
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell
        kicker="Custody / Integrity Watch"
        title="Custody/integrity read degraded"
        severity="warning"
      >
        <SectionNote status="unavailable" kind="custody-integrity" />
      </SectionShell>
    );
  }
  if (section.items.length === 0) {
    return (
      <SectionShell
        kicker="Custody / Integrity Watch"
        title="No integrity signals require review"
      >
        <EnterpriseEmpty
          title="No integrity anomalies detected"
          body="Evidence integrity is classified by the worker pipeline (verificationStatus field). REVIEW_REQUIRED and FAILED classifications surface here. The dashboard never recomputes hashes — it surfaces existing classifier output."
          hint="Deep custody-chain recompute is performed by the worker, not the dashboard."
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      kicker="Custody / Integrity Watch"
      title={`${section.items.length} integrity signal${section.items.length === 1 ? "" : "s"} require review`}
      severity={section.items.some((i) => i.severity === "critical") ? "critical" : "high"}
    >
      <ul className="ec-integrity-list" data-cc-integrity-list>
        {section.items.map((it) => (
          <li
            key={`${it.evidenceId}:${it.reasonCode}`}
            className="ec-integrity-row"
            data-cc-integrity-evidence={it.evidenceId}
            data-cc-integrity-reason={it.reasonCode}
            data-cc-integrity-severity={it.severity}
          >
            <Link href={it.href} className="ec-integrity-link">
              <span className="ec-integrity-title">{it.title}</span>
              <span
                className="ec-chip"
                data-cc-tile-severe={it.severity === "critical" || it.severity === "high" ? "true" : "false"}
              >
                {it.reasonCode}
              </span>
              <time className="ec-chip-faint" dateTime={it.detectedAt}>
                {relTime(it.detectedAt)}
              </time>
            </Link>
          </li>
        ))}
      </ul>
      <div className="ec-section-foot">
        Bounded language: each signal reports an operator-side review request,
        not a claim of authenticity or admissibility.
      </div>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// ACCESS / SECURITY WATCH
// ---------------------------------------------------------------------------

function AccessSecurityWatch({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["accessSecurityAnomalies"];
}) {
  // Phase 32.8C closure pass — read failure is rendered as a localized
  // degraded read, not as a platform outage. The canonical SecurityEvent
  // log remains operational regardless of this dashboard rollup.
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell
        kicker="Access / Security Watch"
        title="Security watch rollup degraded"
        severity="warning"
      >
        <SectionNote status="unavailable" kind="security" />
      </SectionShell>
    );
  }
  if (section.items.length === 0) {
    return (
      <SectionShell
        kicker="Access / Security Watch"
        title="No high-severity security events · 24h"
      >
        <EnterpriseEmpty
          title="No suspicious access activity in the last 24 hours"
          body="The watch reads the SecurityEvent stream filtered to WARNING + HIGH severity in a bounded 24h window. A 0-result state means: no impossible-travel sessions, no suspicious export spikes, no excessive failed access attempts, no admin-role escalations above the threshold."
          hint="The full SecurityEvent audit trail remains canonical. Operator review is the source-of-truth path."
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      kicker="Access / Security Watch"
      title={`${section.items.length} security event${section.items.length === 1 ? "" : "s"} · 24h`}
      severity={section.items.some((i) => i.severity === "high") ? "high" : "warning"}
    >
      <ul className="ec-security-list" data-cc-security-list>
        {section.items.map((s) => (
          <li
            key={s.eventId}
            className="ec-security-row"
            data-cc-security-event-id={s.eventId}
            data-cc-security-severity={s.severity}
          >
            <span className="ec-security-event-type">{s.eventType}</span>
            <span
              className="ec-chip"
              data-cc-tile-severe={s.severity === "high" ? "true" : "false"}
            >
              {s.severity.toUpperCase()}
            </span>
            {s.userId ? (
              <span className="ec-chip-faint">user {s.userId.slice(0, 8)}</span>
            ) : null}
            <time className="ec-chip-faint" dateTime={s.detectedAt}>
              {relTime(s.detectedAt)}
            </time>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// UNSUPPORTED SIGNALS (collapsed)
// ---------------------------------------------------------------------------

function UnsupportedSignalsSection({
  signals,
}: {
  signals: CommandCenterEnvelope["unsupportedSignals"];
}) {
  if (signals.length === 0) return null;
  return (
    <details className="ec-unsupported" data-cc-unsupported-signals>
      <summary className="ec-unsupported-summary" data-cc-diagnostics-disclosure>
        Engineering diagnostics · capability catalog · {signals.length}
        <small> (intelligence signals the platform does not yet compute — not a platform failure)</small>
      </summary>
      <ul className="ec-unsupported-list">
        {signals.map((s, i) => (
          <li
            key={`${s.signal}:${i}`}
            className="ec-unsupported-row"
            data-cc-unsupported-signal={s.signal}
          >
            <code className="ec-unsupported-signal">{s.signal}</code>
            <span className="ec-unsupported-reason">{s.reason}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

// ---------------------------------------------------------------------------
// SUMMARY STRIP
// ---------------------------------------------------------------------------

function SummaryStrip({
  envelope,
  isTeam,
}: {
  envelope: CommandCenterEnvelope;
  isTeam: boolean;
}) {
  const s = envelope.sections.summary;
  if (s.status !== "ok" || !s.data) {
    return null;
  }
  const d = s.data;
  const tiles: Array<{
    key: string;
    label: string;
    value: number;
    href: string;
    visible: boolean;
    severe?: boolean;
  }> = [
    {
      key: "pressure",
      label: "Operational pressure",
      value: d.operationalPressureCount,
      href: "#operational-pressure",
      visible: true,
      severe: d.operationalPressureCount > 0,
    },
    {
      key: "audit_flags",
      label: "Audit-readiness flags",
      value: d.auditReadinessFlags,
      href: "#audit-readiness",
      visible: true,
      severe: d.auditReadinessFlags > 0,
    },
    {
      key: "evidence_active",
      label: "Active evidence",
      value: d.evidenceActiveCount,
      href: "/evidence",
      visible: true,
    },
    {
      key: "evidence_recent",
      label: "New (7d)",
      value: d.evidenceRecentCount,
      href: "/evidence",
      visible: true,
    },
    {
      key: "reports_ready",
      label: "Reports ready",
      value: d.reportReadyCount,
      href: "/reports",
      visible: true,
    },
    {
      key: "reviewer_pending",
      label: "Pending review",
      value: d.reviewerPendingCount,
      href: "/reviewer-ops",
      visible: isTeam,
    },
    {
      key: "governance",
      label: "Governance attention",
      value: d.governanceAttentionCount,
      href: "/governance",
      visible: isTeam,
      severe: d.governanceAttentionCount > 0,
    },
    {
      key: "incidents",
      label: "Open incidents",
      value: d.openIncidentsCount,
      href: "/operations/observability",
      visible: true,
      severe: d.openIncidentsCount > 0,
    },
  ];
  return (
    <section className="ec-summary-strip" data-cc-summary>
      {tiles
        .filter((t) => t.visible)
        .map((t) =>
          t.href.startsWith("#") ? (
            <a
              key={t.key}
              href={t.href}
              className="ec-summary-tile"
              data-cc-summary-key={t.key}
              data-cc-tile-severe={t.severe ? "true" : "false"}
            >
              <span className="ec-summary-tile-value">{t.value}</span>
              <span className="ec-summary-tile-label">{t.label}</span>
            </a>
          ) : (
            <Link
              key={t.key}
              href={t.href}
              className="ec-summary-tile"
              data-cc-summary-key={t.key}
              data-cc-tile-severe={t.severe ? "true" : "false"}
            >
              <span className="ec-summary-tile-value">{t.value}</span>
              <span className="ec-summary-tile-label">{t.label}</span>
            </Link>
          ),
        )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 1. ACTIVE OPERATIONAL PRESSURE
// ---------------------------------------------------------------------------

function OperationalPressureSection({
  section,
  canMutate: _canMutate,
}: {
  section: CommandCenterEnvelope["sections"]["operationalPressure"];
  canMutate: boolean;
}) {
  if (section.status === "unavailable") {
    return (
      <SectionShell
        id="operational-pressure"
        kicker="Active Operational Pressure"
        title="Operational pressure read degraded"
        severity="warning"
      >
        <SectionNote status="unavailable" kind="pressure" />
      </SectionShell>
    );
  }
  const empty = section.items.length === 0;
  const heroSeverity: SeverityTone =
    section.counts.critical > 0
      ? "critical"
      : section.counts.high > 0
        ? "high"
        : section.counts.warning > 0
          ? "warning"
          : "info";

  return (
    <SectionShell
      id="operational-pressure"
      kicker="1 · Active Operational Pressure"
      title={
        empty
          ? "No operational pressure detected"
          : `${section.items.length} item${section.items.length === 1 ? "" : "s"} require attention`
      }
      severity={empty ? "info" : heroSeverity}
      data-section="operational-pressure"
    >
      <div className="ec-severity-strip" data-cc-pressure-counts>
        <span
          className="ec-severity-pill"
          data-cc-pressure-severity="critical"
          data-cc-tile-severe={section.counts.critical > 0 ? "true" : "false"}
        >
          <strong>{section.counts.critical}</strong> Critical
        </span>
        <span
          className="ec-severity-pill"
          data-cc-pressure-severity="high"
          data-cc-tile-severe={section.counts.high > 0 ? "true" : "false"}
        >
          <strong>{section.counts.high}</strong> High
        </span>
        <span
          className="ec-severity-pill"
          data-cc-pressure-severity="warning"
          data-cc-tile-severe={section.counts.warning > 0 ? "true" : "false"}
        >
          <strong>{section.counts.warning}</strong> Warning
        </span>
        <span
          className="ec-severity-pill"
          data-cc-pressure-severity="info"
        >
          <strong>{section.counts.info}</strong> Info
        </span>
      </div>
      {empty ? (
        <EnterpriseEmpty
          title="No operational pressure detected · workspace healthy"
          body="The pressure engine scans every operational source — overdue reviews, stalled review workflows, unassigned reviews, open escalations, stuck uploads, missing reports, missing packages, failed report generations, failed package generations, retry storms, governance conflicts, policy conflicts, evidence without case linkage, unsigned aged evidence, blocked exports, and active operational incidents — and surfaces items above the severity threshold. A 0-result state means every one of these signals is currently within tolerance."
          hint="Pressure is recomputed on every dashboard load from real platform state — there is no fake metric or cached score."
        />
      ) : (
        <ul className="ec-pressure-list" data-cc-pressure-list>
          {section.items.map((item) => (
            <PressureRow key={item.id} item={item} />
          ))}
        </ul>
      )}
      {section.status === "degraded" ? (
        <SectionNote status="degraded" kind="pressure" />
      ) : null}
    </SectionShell>
  );
}

function PressureRow({ item }: { item: OperationalPressureItem }) {
  return (
    <li
      className="ec-pressure-row"
      data-cc-pressure-id={item.id}
      data-cc-pressure-category={item.category}
      data-cc-pressure-severity={item.severity}
    >
      <span className="ec-pressure-dot" data-cc-pressure-dot={item.severity} />
      <div className="ec-pressure-body">
        <Link href={item.href} className="ec-pressure-title">
          {item.title}
        </Link>
        {item.subtitle ? (
          <span className="ec-pressure-subtitle">{item.subtitle}</span>
        ) : null}
        <span className="ec-pressure-meta">
          {humanize(item.category)}
          {item.occurredAt ? (
            <>
              {" · "}
              <time dateTime={item.occurredAt}>
                {relTime(item.occurredAt)}
              </time>
            </>
          ) : null}
        </span>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// 2. INVESTIGATION & CASE OPERATIONS
// ---------------------------------------------------------------------------

function CaseOperationsSection({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["caseOperations"];
}) {
  if (section.status !== "ok" || !section.data) {
    return (
      <SectionShell
        kicker="2 · Investigation & Case Operations"
        title="Case operations read degraded"
        severity="warning"
      >
        <SectionNote status={section.status} kind="case-operations" />
      </SectionShell>
    );
  }
  const d = section.data;
  const empty = d.topCases.length === 0 && d.activeCasesCount === 0;
  return (
    <SectionShell
      kicker="2 · Investigation & Case Operations"
      title={
        empty
          ? "No active investigations"
          : `${d.activeCasesCount} active case${d.activeCasesCount === 1 ? "" : "s"}`
      }
    >
      <div className="ec-case-strip" data-cc-case-strip>
        <CaseStripTile
          keyId="evidence_gaps"
          label="Cases with evidence gaps"
          value={d.casesWithEvidenceGapsCount}
        />
        <CaseStripTile
          keyId="unreviewed"
          label="Unreviewed evidence"
          value={d.unreviewedEvidenceCount}
        />
        <CaseStripTile
          keyId="unlinked"
          label="Evidence without case"
          value={d.unlinkedEvidenceCount}
        />
      </div>
      {empty ? (
        <EnterpriseEmpty
          title="No investigations underway"
          body="Cases coordinate evidence, review workflows, and legal preservation. Create the first case to begin tracking investigation pressure."
          actionLabel="Open Cases"
          actionHref="/cases"
        />
      ) : (
        <ul className="ec-case-list" data-cc-case-list>
          {d.topCases.map((c) => (
            <CaseRow key={c.caseId} caseRow={c} />
          ))}
        </ul>
      )}
    </SectionShell>
  );
}

function CaseStripTile({
  keyId,
  label,
  value,
}: {
  keyId: string;
  label: string;
  value: number;
}) {
  return (
    <div
      className="ec-case-strip-tile"
      data-cc-case-tile={keyId}
      data-cc-tile-severe={value > 0 ? "true" : "false"}
    >
      <span className="ec-case-strip-value">{value}</span>
      <span className="ec-case-strip-label">{label}</span>
    </div>
  );
}

function CaseRow({ caseRow }: { caseRow: CaseOperationsItem }) {
  const severe = caseRow.overdueReviewCount > 0 || caseRow.openEscalationsCount > 0;
  return (
    <li
      className="ec-case-row"
      data-cc-case-row-id={caseRow.caseId}
      data-cc-case-row-severe={severe ? "true" : "false"}
    >
      <Link href={`/cases/${caseRow.caseId}`} className="ec-case-row-link">
        <div className="ec-case-row-main">
          <span className="ec-case-row-title">{caseRow.caseName}</span>
          <span className="ec-case-row-meta">
            {caseRow.evidenceCount} evidence
          </span>
        </div>
        <div className="ec-case-row-meta-line">
          {caseRow.overdueReviewCount > 0 ? (
            <span
              className="ec-chip"
              data-cc-case-chip="overdue"
              data-cc-tile-severe="true"
            >
              {caseRow.overdueReviewCount} overdue
            </span>
          ) : null}
          {caseRow.openEscalationsCount > 0 ? (
            <span
              className="ec-chip"
              data-cc-case-chip="escalations"
              data-cc-tile-severe="true"
            >
              {caseRow.openEscalationsCount} escalation
              {caseRow.openEscalationsCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {caseRow.hasActiveLegalHold ? (
            <span className="ec-chip" data-cc-case-chip="hold">
              Legal preservation
            </span>
          ) : null}
          {caseRow.lastActivityAtUtc ? (
            <time
              className="ec-chip-faint"
              dateTime={caseRow.lastActivityAtUtc}
            >
              Active {relTime(caseRow.lastActivityAtUtc)}
            </time>
          ) : null}
        </div>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------
// 3. REVIEWER ORCHESTRATION
// ---------------------------------------------------------------------------

function ReviewerOrchestrationSection({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["reviewerOrchestration"];
}) {
  if (section.status === "not_applicable") {
    return (
      <SectionShell
        kicker="3 · Reviewer Orchestration"
        title="Personal workspace"
      >
        <PersonalNote subsystem="reviewer" />
      </SectionShell>
    );
  }
  if (section.status !== "ok" || !section.data) {
    return (
      <SectionShell
        kicker="3 · Reviewer Orchestration"
        title="Reviewer orchestration read degraded"
        severity="warning"
      >
        <SectionNote status={section.status} kind="reviewer-orchestration" />
      </SectionShell>
    );
  }
  const d = section.data;
  const throughputDelta = d.completedLast7dCount - d.completedPrev7dCount;
  return (
    <SectionShell
      kicker="3 · Reviewer Orchestration"
      title={
        d.queueDepth === 0
          ? "All reviewer queues within SLA"
          : `${d.queueDepth} workflow${d.queueDepth === 1 ? "" : "s"} in queue`
      }
    >
      <div className="ec-reviewer-strip" data-cc-reviewer-strip>
        <ReviewerStripTile
          keyId="queue_depth"
          label="Queue depth"
          value={d.queueDepth}
        />
        <ReviewerStripTile
          keyId="overdue"
          label="Overdue"
          value={d.overdueCount}
          severe={d.overdueCount > 0}
        />
        <ReviewerStripTile
          keyId="due_soon"
          label="Due in 24h"
          value={d.dueSoonCount}
        />
        <ReviewerStripTile
          keyId="unassigned"
          label="Unassigned"
          value={d.unassignedCount}
        />
        <ReviewerStripTile
          keyId="open_escalations"
          label="Open escalations"
          value={d.openEscalationsCount}
          severe={d.openEscalationsCount > 0}
        />
        <ReviewerStripTile
          keyId="inactive_reviewers"
          label="Inactive reviewers"
          value={d.inactiveReviewerCount}
          severe={d.inactiveReviewerCount > 0}
        />
      </div>
      <div className="ec-throughput" data-cc-reviewer-throughput>
        <span>
          Throughput · last 7d: <strong>{d.completedLast7dCount}</strong>
        </span>
        <span data-cc-reviewer-throughput-delta={throughputDelta >= 0 ? "up" : "down"}>
          vs prev 7d: {d.completedPrev7dCount}{" "}
          ({throughputDelta >= 0 ? "+" : ""}
          {throughputDelta})
        </span>
      </div>
      {d.topReviewers.length === 0 ? (
        <EnterpriseEmpty
          title="No reviewer assignments active"
          body="When workflows are assigned, this section will surface per-reviewer load, overdue counts, and inactivity flags."
        />
      ) : (
        <ul className="ec-reviewer-list" data-cc-reviewer-list>
          {d.topReviewers.map((r) => (
            <ReviewerRow key={r.userId} reviewer={r} />
          ))}
        </ul>
      )}
      <div className="ec-section-foot">
        Full reviewer console at{" "}
        <Link href="/reviewer-ops">Reviewer Ops</Link>.
      </div>
    </SectionShell>
  );
}

function ReviewerStripTile({
  keyId,
  label,
  value,
  severe,
}: {
  keyId: string;
  label: string;
  value: number;
  severe?: boolean;
}) {
  return (
    <div
      className="ec-reviewer-strip-tile"
      data-cc-reviewer-tile={keyId}
      data-cc-tile-severe={severe ? "true" : "false"}
    >
      <span className="ec-reviewer-strip-value">{value}</span>
      <span className="ec-reviewer-strip-label">{label}</span>
    </div>
  );
}

function ReviewerRow({ reviewer }: { reviewer: ReviewerOrchestrationRow }) {
  return (
    <li
      className="ec-reviewer-row"
      data-cc-reviewer-user={reviewer.userId}
      data-cc-reviewer-inactive={reviewer.inactive ? "true" : "false"}
    >
      <div className="ec-reviewer-row-main">
        <span className="ec-reviewer-row-title">
          {reviewer.displayName ?? reviewer.email ?? reviewer.userId.slice(0, 8)}
        </span>
        <span className="ec-reviewer-row-assigned">
          {reviewer.assignedCount} assigned
        </span>
      </div>
      <div className="ec-reviewer-row-meta">
        {reviewer.overdueCount > 0 ? (
          <span className="ec-chip" data-cc-tile-severe="true">
            {reviewer.overdueCount} overdue
          </span>
        ) : null}
        {reviewer.dueSoonCount > 0 ? (
          <span className="ec-chip">{reviewer.dueSoonCount} due soon</span>
        ) : null}
        {reviewer.inactive ? (
          <span className="ec-chip" data-cc-reviewer-inactive-chip="true">
            Inactive
          </span>
        ) : reviewer.lastActionAtUtc ? (
          <span className="ec-chip-faint">
            Last action {relTime(reviewer.lastActionAtUtc)}
          </span>
        ) : null}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// 4. EVIDENCE PIPELINE VISIBILITY
// ---------------------------------------------------------------------------

function PipelineDetailSection({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["pipelineDetail"];
}) {
  if (section.status !== "ok" || !section.data) {
    return (
      <SectionShell
        kicker="4 · Evidence Pipeline"
        title="Pipeline read degraded"
        severity="warning"
      >
        <SectionNote status={section.status} kind="pipeline-detail" />
      </SectionShell>
    );
  }
  const d: PipelineDetail = section.data;
  return (
    <SectionShell kicker="4 · Evidence Pipeline" title="Pipeline visibility">
      <h3 className="ec-pipeline-heading">Evidence lifecycle</h3>
      <div className="ec-pipeline-strip" data-cc-pipeline-evidence>
        <PipelineStage label="Created" value={d.evidence.created} />
        <PipelineStage
          label="Uploading"
          value={d.evidence.uploading}
          stuckBadge={d.evidence.stuckUploading}
        />
        <PipelineStage label="Uploaded" value={d.evidence.uploaded} />
        <PipelineStage label="Signed" value={d.evidence.signed} />
        <PipelineStage label="Reported" value={d.evidence.reported} />
      </div>

      <h3 className="ec-pipeline-heading">Reports</h3>
      <div className="ec-pipeline-strip" data-cc-pipeline-reports>
        <PipelineStage label="Ready" value={d.reports.ready} />
        <PipelineStage label="Queued" value={d.reports.queued} />
        <PipelineStage
          label="Failed"
          value={d.reports.failed}
          severe={d.reports.failed > 0}
        />
      </div>

      <h3 className="ec-pipeline-heading">Verification packages</h3>
      <div className="ec-pipeline-strip" data-cc-pipeline-packages>
        <PipelineStage label="Ready" value={d.packages.ready} />
        <PipelineStage label="Queued" value={d.packages.queued} />
        <PipelineStage
          label="Blocked"
          value={d.packages.blocked}
          severe={d.packages.blocked > 0}
        />
        <PipelineStage
          label="Failed"
          value={d.packages.failed}
          severe={d.packages.failed > 0}
        />
      </div>

      <h3 className="ec-pipeline-heading">Public verify</h3>
      <div className="ec-pipeline-strip" data-cc-pipeline-public-verify>
        <PipelineStage label="Published" value={d.publicVerify.published} />
        <PipelineStage label="Unpublished" value={d.publicVerify.unpublished} />
        <PipelineStage
          label="Suspended"
          value={d.publicVerify.suspended}
          severe={d.publicVerify.suspended > 0}
        />
      </div>
    </SectionShell>
  );
}

function PipelineStage({
  label,
  value,
  severe,
  stuckBadge,
}: {
  label: string;
  value: number;
  severe?: boolean;
  stuckBadge?: number;
}) {
  return (
    <div
      className="ec-pipeline-stage"
      data-cc-pipeline-stage={label.toLowerCase().replace(/\s+/g, "_")}
      data-cc-tile-severe={severe ? "true" : "false"}
    >
      <span className="ec-pipeline-stage-value">{value}</span>
      <span className="ec-pipeline-stage-label">{label}</span>
      {stuckBadge && stuckBadge > 0 ? (
        <span
          className="ec-chip"
          data-cc-tile-severe="true"
          data-cc-pipeline-stuck
        >
          {stuckBadge} stuck
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. GOVERNANCE & COMPLIANCE POSTURE
// ---------------------------------------------------------------------------

function GovernancePostureSection({
  section,
  isTeam,
}: {
  section: CommandCenterEnvelope["sections"]["governancePosture"];
  isTeam: boolean;
}) {
  if (section.status === "not_applicable" || !isTeam) {
    return (
      <SectionShell
        kicker="5 · Governance & Compliance"
        title="Personal workspace"
      >
        <PersonalNote subsystem="governance" />
      </SectionShell>
    );
  }
  if (section.status === "unavailable" || !section.data) {
    return (
      <SectionShell
        kicker="5 · Governance & Compliance"
        title="Governance read degraded"
        severity="warning"
      >
        <SectionNote status={section.status} kind="governance" />
      </SectionShell>
    );
  }
  const d = section.data;
  const empty =
    d.activeLegalHoldsCount === 0 &&
    d.activeCaseLegalHoldsCount === 0 &&
    d.pendingDestructionReviewsCount === 0 &&
    d.blockedExportsCount === 0 &&
    d.policyConflictsCount === 0;
  return (
    <SectionShell
      kicker="5 · Governance & Compliance"
      title={
        empty
          ? "No governance conflicts detected"
          : "Governance posture · active controls"
      }
    >
      <div className="ec-tile-grid" data-cc-governance-tiles>
        <Tile
          keyId="evidence_holds"
          label="Evidence-level holds"
          value={d.activeLegalHoldsCount}
        />
        <Tile
          keyId="case_holds"
          label="Case-level holds"
          value={d.activeCaseLegalHoldsCount}
        />
        <Tile
          keyId="retention_candidates"
          label="Retention candidates"
          value={d.retentionCandidatesCount}
        />
        <Tile
          keyId="pending_destruction"
          label="Pending destruction"
          value={d.pendingDestructionReviewsCount}
        />
        <Tile
          keyId="active_policies"
          label="Active policies"
          value={d.activePoliciesCount}
        />
        <Tile
          keyId="policy_conflicts"
          label="Policy conflicts"
          value={d.policyConflictsCount}
          severe={d.policyConflictsCount > 0}
        />
        <Tile
          keyId="blocked_exports"
          label="Blocked exports"
          value={d.blockedExportsCount}
          severe={d.blockedExportsCount > 0}
        />
        <Tile
          keyId="lifecycle_events_7d"
          label="Lifecycle events · 7d"
          value={d.recentLifecycleEventsCount}
        />
      </div>
      <div className="ec-section-foot">
        Full control plane at{" "}
        <Link href="/governance">Governance</Link>. Preservation controls are
        workspace policy — they do not assert legal admissibility or
        authenticity of any record.
      </div>
      {section.status === "degraded" ? (
        <SectionNote status="degraded" kind="governance" />
      ) : null}
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// 6. ORGANIZATIONAL INTELLIGENCE
// ---------------------------------------------------------------------------

function OrganizationalIntelligenceSection({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["organizationalIntelligence"];
}) {
  if (section.status !== "ok" || !section.data) {
    return (
      <SectionShell
        kicker="6 · Organizational Intelligence"
        title="Throughput read degraded"
        severity="warning"
      >
        <SectionNote status={section.status} kind="organizational" />
      </SectionShell>
    );
  }
  const d = section.data;
  return (
    <SectionShell
      kicker="6 · Organizational Intelligence"
      title="Workspace throughput"
    >
      <div className="ec-tile-grid" data-cc-organizational-tiles>
        <Tile
          keyId="evidence_24h"
          label="Evidence created · 24h"
          value={d.evidenceCreatedLast24h}
        />
        <Tile
          keyId="evidence_7d"
          label="Evidence created · 7d"
          value={d.evidenceCreatedLast7d}
        />
        <Tile
          keyId="evidence_finalized_7d"
          label="Finalized · 7d"
          value={d.evidenceFinalizedLast7d}
        />
        <Tile
          keyId="reports_7d"
          label="Reports generated · 7d"
          value={d.reportsGeneratedLast7d}
        />
        <Tile
          keyId="packages_7d"
          label="Packages generated · 7d"
          value={d.packagesGeneratedLast7d}
        />
        <Tile
          keyId="activity_7d"
          label="Workspace activity · 7d"
          value={d.activityLast7d}
        />
      </div>
      <div className="ec-section-foot">
        Throughput reflects realized workspace activity over the last 24 hours
        and 7 days — sourced from real evidence + report + package + activity
        records.
      </div>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// 7. OPERATIONAL TIMELINE
// ---------------------------------------------------------------------------

function TimelineSection({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["timeline"];
}) {
  if (section.status === "unavailable") {
    return (
      <SectionShell
        kicker="7 · Operational Timeline"
        title="Timeline read degraded"
        severity="warning"
      >
        <SectionNote status="unavailable" kind="timeline" />
      </SectionShell>
    );
  }
  if (section.items.length === 0) {
    return (
      <SectionShell
        kicker="7 · Operational Timeline"
        title="No recent operational events · 14d window"
      >
        <EnterpriseEmpty
          title="Operational heartbeat — no recent events in the last 14 days"
          body="The timeline aggregates evidence finalizations, report + verification package generations, lifecycle transitions, legal hold actions, reviewer escalations, governance reviews, and operational incidents. A 0-result state in this window means the workspace had no operationally significant activity — not a missing log."
          hint="The OperationalTimelineEvent projection is recomputed lazily on dashboard read; full audit trails remain on the per-evidence custody chain."
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      kicker="7 · Operational Timeline"
      title={`Operational heartbeat · last 14d · ${section.items.length} events`}
    >
      <ul className="ec-timeline" data-cc-timeline-list>
        {section.items.map((ev) => (
          <TimelineRow key={ev.id} ev={ev} />
        ))}
      </ul>
      {section.status === "degraded" ? (
        <SectionNote status="degraded" kind="timeline" />
      ) : null}
    </SectionShell>
  );
}

function TimelineRow({ ev }: { ev: TimelineEvent }) {
  return (
    <li
      className="ec-timeline-row"
      data-cc-timeline-id={ev.id}
      data-cc-timeline-kind={ev.kind}
      data-cc-timeline-severity={ev.severity}
    >
      <span
        className="ec-timeline-dot"
        data-cc-timeline-severity-dot={ev.severity}
      />
      <div className="ec-timeline-body">
        {ev.href ? (
          <Link href={ev.href} className="ec-timeline-label">
            {ev.label}
          </Link>
        ) : (
          <span className="ec-timeline-label">{ev.label}</span>
        )}
        <span className="ec-timeline-meta">
          {humanize(ev.kind)}
          {ev.subtitle ? <> · {ev.subtitle}</> : null}
        </span>
      </div>
      <time
        className="ec-timeline-time"
        dateTime={ev.occurredAt}
        title={ev.occurredAt}
      >
        {relTime(ev.occurredAt)}
      </time>
    </li>
  );
}

// ---------------------------------------------------------------------------
// 8. AUDIT READINESS
// ---------------------------------------------------------------------------

function AuditReadinessSection({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["auditReadiness"];
}) {
  if (section.status === "unavailable") {
    return (
      <SectionShell
        kicker="8 · Audit Readiness"
        title="Audit readiness read degraded"
        severity="warning"
      >
        <SectionNote status="unavailable" kind="audit-readiness" />
      </SectionShell>
    );
  }
  const flagged = section.counters.filter(
    (c) => c.value > 0 && c.severity !== "info",
  );
  return (
    <SectionShell
      kicker="8 · Audit Readiness"
      title={
        flagged.length === 0
          ? "All audit-readiness signals nominal"
          : `${flagged.length} signal${flagged.length === 1 ? "" : "s"} flagged`
      }
    >
      {section.counters.length === 0 ? (
        <EnterpriseEmpty
          title="Audit readiness · no blockers detected"
          body="The readiness engine inspects every audit-affecting source — unsigned finalized evidence, evidence missing verification packages, unresolved reviewer escalations, governance conflicts, incomplete lifecycle transitions, stale verification artifacts, and export governance failures. A 0-result state means every one of these surfaces is within the expected audit posture."
          hint="Each counter sources from real workspace state — never from a cached or fabricated score."
        />
      ) : (
        <ul className="ec-audit-list" data-cc-audit-list>
          {section.counters.map((c) => (
            <AuditCounterRow key={c.key} counter={c} />
          ))}
        </ul>
      )}
      <div className="ec-section-foot">
        Audit-readiness counters surface gaps an external auditor would expect
        to find resolved. Each row sources from real workspace state.
      </div>
    </SectionShell>
  );
}

function AuditCounterRow({ counter }: { counter: AuditReadinessCounter }) {
  const severe = counter.value > 0 && counter.severity !== "info";
  return (
    <li
      className="ec-audit-row"
      data-cc-audit-key={counter.key}
      data-cc-audit-severity={counter.severity}
      data-cc-tile-severe={severe ? "true" : "false"}
    >
      <span className="ec-audit-row-label">{counter.label}</span>
      <span className="ec-audit-row-value">{counter.value}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Recent evidence + incidents + quick actions
// ---------------------------------------------------------------------------

function RecentEvidenceSection({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["recentEvidence"];
}) {
  if (section.status !== "ok") {
    return (
      <SectionShell kicker="Recent" title="Recent evidence read degraded" severity="warning">
        <SectionNote status={section.status} kind="recent-evidence" />
      </SectionShell>
    );
  }
  if (section.items.length === 0) {
    return (
      <SectionShell kicker="Recent" title="No recent evidence">
        <EnterpriseEmpty
          title="No evidence captured yet"
          body="Capture or upload to populate the operational activity stream."
          actionLabel="Capture evidence"
          actionHref="/capture"
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell kicker="Recent" title="Recent evidence">
      <ul className="ec-evidence-list" data-cc-recent-list>
        {section.items.map((e) => (
          <li
            key={e.id}
            className="ec-evidence-row"
            data-cc-recent-id={e.id}
          >
            <Link href={`/evidence/${e.id}`} className="ec-evidence-link">
              <span className="ec-evidence-title">{e.title}</span>
              <span
                className="ec-chip"
                data-cc-evidence-status={e.status}
              >
                {humanize(e.status)}
              </span>
              <time className="ec-chip-faint" dateTime={e.createdAt}>
                {relTime(e.createdAt)}
              </time>
            </Link>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

/**
 * Phase 32.8C FINAL-2 — CausalityChains strip.
 *
 * Renders root-cause causality chains at the very top of the incidents
 * surface so the operator reads "Why is this happening?" before
 * "What is happening?". Each chain ties together incidents + workflows +
 * correlations and shows a single bounded summary + severity.
 */
function CausalityChainsStrip({
  chains,
}: {
  chains: CommandCenterEnvelope["sections"]["incidents"]["causalityChains"];
}) {
  if (!chains || chains.length === 0) return null;
  return (
    <div
      className="ec-subsection"
      data-cc-causality-chains-block
      aria-label="Root-cause causality chains"
    >
      <div className="ec-subsection-head">
        <h3 className="ec-subsection-title">Root-cause causality chains</h3>
        <span className="ec-chip-faint">
          {chains.length} active chain{chains.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="ec-telemetry-list" data-cc-causality-chains>
        {chains.map((c) => (
          <li
            key={c.id}
            className="ec-telemetry-row"
            data-cc-chain-id={c.id}
            data-cc-chain-key={c.chainKey}
            data-cc-chain-root={c.rootCauseType}
            data-cc-chain-severity={c.severity}
            data-cc-tile-severe={
              c.severity === "CRITICAL" || c.severity === "HIGH"
                ? "true"
                : "false"
            }
          >
            <div className="ec-telemetry-row-main">
              <span className="ec-telemetry-label">{c.title}</span>
              <span
                className="ec-chip"
                data-cc-tile-severe={
                  c.severity === "CRITICAL" || c.severity === "HIGH"
                    ? "true"
                    : "false"
                }
              >
                {c.severity}
              </span>
              <span className="ec-chip-faint">{c.rootCauseType}</span>
            </div>
            <div className="ec-coord-explanation" data-cc-chain-summary>
              {c.summary}
            </div>
            <div className="ec-telemetry-meta">
              <span data-cc-chain-incident-count>
                {c.linkedIncidentIds.length} incident
                {c.linkedIncidentIds.length === 1 ? "" : "s"}
              </span>
              <span data-cc-chain-workflow-count>
                {c.linkedWorkflowIds.length} workflow
                {c.linkedWorkflowIds.length === 1 ? "" : "s"}
              </span>
              {c.linkedCorrelationIds.length > 0 ? (
                <span data-cc-chain-correlation-count>
                  {c.linkedCorrelationIds.length} correlation
                  {c.linkedCorrelationIds.length === 1 ? "" : "s"}
                </span>
              ) : null}
              {c.linkedCaseIds.length > 0 ? (
                <span data-cc-chain-case-count>
                  {c.linkedCaseIds.length} case
                  {c.linkedCaseIds.length === 1 ? "" : "s"}
                </span>
              ) : null}
              <time className="ec-chip-faint" dateTime={c.lastSeenAtUtc}>
                last seen {relTime(c.lastSeenAtUtc)}
              </time>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Phase 32.8C FINAL-2 — Workflows strip.
 *
 * Renders the active operational workflows under causality chains.
 * Each row shows the workflow type, status, owner, severity, due
 * pressure, escalation level, retry count, and the bounded action
 * catalog (permission-aware labels — the dashboard renders chips, not
 * mutation buttons; operator actions live on the Operations Center
 * incident detail page).
 */
function WorkflowsStrip({
  workflows,
}: {
  workflows: CommandCenterEnvelope["sections"]["incidents"]["workflows"];
}) {
  if (!workflows || workflows.length === 0) return null;
  const overdue = workflows.filter(
    (w) => w.dueAtUtc && new Date(w.dueAtUtc).getTime() < Date.now(),
  ).length;
  return (
    <div
      className="ec-subsection"
      data-cc-workflows-block
      aria-label="Active operational workflows"
    >
      <div className="ec-subsection-head">
        <h3 className="ec-subsection-title">Active operational workflows</h3>
        <span className="ec-chip-faint">
          {workflows.length} active
          {overdue > 0 ? ` · ${overdue} overdue` : ""}
        </span>
      </div>
      <ul className="ec-telemetry-list" data-cc-workflows>
        {workflows.map((w) => {
          const isOverdue =
            !!w.dueAtUtc && new Date(w.dueAtUtc).getTime() < Date.now();
          const severe = w.severity === "CRITICAL" || w.severity === "HIGH";
          return (
            <li
              key={w.id}
              className="ec-telemetry-row"
              data-cc-workflow-id={w.id}
              data-cc-workflow-type={w.workflowType}
              data-cc-workflow-status={w.status}
              data-cc-workflow-severity={w.severity}
              data-cc-workflow-priority={w.priority}
              data-cc-workflow-assigned={
                w.assignedOwnerUserId ? "true" : "false"
              }
              data-cc-workflow-overdue={isOverdue ? "true" : "false"}
              data-cc-tile-severe={severe || isOverdue ? "true" : "false"}
            >
              <div className="ec-telemetry-row-main">
                <span className="ec-telemetry-label">{w.title}</span>
                <span
                  className="ec-chip"
                  data-cc-tile-severe={severe ? "true" : "false"}
                >
                  {w.severity}
                </span>
                <span className="ec-chip-faint" data-cc-workflow-priority-chip>
                  {w.priority}
                </span>
                <span className="ec-chip-faint">{w.workflowType}</span>
                <span className="ec-chip-faint" data-cc-workflow-status-chip>
                  {w.status}
                </span>
                {isOverdue ? (
                  <span className="ec-chip" data-cc-tile-severe="true">
                    Overdue
                  </span>
                ) : null}
              </div>
              <div className="ec-coord-explanation" data-cc-workflow-summary>
                {w.safeSummary}
              </div>
              <div className="ec-telemetry-meta">
                {w.assignedOwnerUserId ? (
                  <span data-cc-workflow-assignee>
                    owner {w.assignedOwnerUserId.slice(0, 8)}
                  </span>
                ) : (
                  <span data-cc-workflow-unassigned>Unassigned</span>
                )}
                {w.escalationLevel > 0 ? (
                  <span data-cc-workflow-escalation>
                    escalated ×{w.escalationLevel}
                  </span>
                ) : null}
                {w.retryCount > 0 ? (
                  <span data-cc-workflow-retry>retry ×{w.retryCount}</span>
                ) : null}
                {w.lastFailureCode ? (
                  <span className="ec-chip" data-cc-tile-severe="true">
                    {w.lastFailureCode}
                  </span>
                ) : null}
                {w.dueAtUtc ? (
                  <time className="ec-chip-faint" dateTime={w.dueAtUtc}>
                    due {relTime(w.dueAtUtc)}
                  </time>
                ) : null}
                {w.nextRetryAtUtc ? (
                  <time className="ec-chip-faint" dateTime={w.nextRetryAtUtc}>
                    next retry {relTime(w.nextRetryAtUtc)}
                  </time>
                ) : null}
              </div>
              {w.actions.length > 0 ? (
                <div
                  className="ec-telemetry-meta"
                  data-cc-workflow-actions
                  aria-label="Available operator actions"
                >
                  {w.actions.map((a) => (
                    <span
                      key={a.actionType}
                      className="ec-chip-faint"
                      data-cc-workflow-action={a.actionType}
                      data-cc-workflow-action-permission={a.permissionRequired}
                      title={`Requires ${a.requiredRoles.join(" / ")} · ${a.permissionRequired}`}
                    >
                      {a.safeActionLabel}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Phase 32.8C control plane — IncidentCorrelations strip.
 *
 * Renders root-cause correlations above the per-incident list so the
 * operator sees the underlying pattern, not the symptoms. Hidden when
 * the backend returns no correlations.
 */
function IncidentCorrelations({
  correlations,
}: {
  correlations: CommandCenterEnvelope["sections"]["incidents"]["correlations"];
}) {
  if (!correlations || correlations.length === 0) return null;
  return (
    <div className="ec-subsection" data-cc-incident-correlations-block aria-label="Cross-system correlations">
      <div className="ec-subsection-head">
        <h3 className="ec-subsection-title">Root-cause correlations</h3>
        <span className="ec-chip-faint">
          {correlations.length} correlation{correlations.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="ec-telemetry-list" data-cc-incident-correlations>
        {correlations.map((c) => (
          <li
            key={c.id}
            className="ec-telemetry-row"
            data-cc-correlation-id={c.id}
            data-cc-correlation-type={c.correlationType}
            data-cc-correlation-severity={c.severity}
            data-cc-tile-severe={
              c.severity === "CRITICAL" || c.severity === "HIGH" ? "true" : "false"
            }
          >
            <div className="ec-telemetry-row-main">
              <span className="ec-telemetry-label">{c.correlationType}</span>
              <span
                className="ec-chip"
                data-cc-tile-severe={
                  c.severity === "CRITICAL" || c.severity === "HIGH" ? "true" : "false"
                }
              >
                {c.severity}
              </span>
              <span className="ec-chip-faint">
                {c.linkedIncidentIds.length} incident
                {c.linkedIncidentIds.length === 1 ? "" : "s"}
              </span>
              <span className="ec-chip-faint">{c.confidence} confidence</span>
            </div>
            <div className="ec-coord-explanation" data-cc-correlation-root>
              {c.rootOperationalCause}
            </div>
            <div className="ec-telemetry-meta">
              <span data-cc-correlation-summary>{c.operationalSummary}</span>
              <span className="ec-chip-faint" data-cc-correlation-action>
                Recommended: {c.recommendedAction}
              </span>
              <time className="ec-chip-faint" dateTime={c.lastDetectedAtUtc}>
                detected {relTime(c.lastDetectedAtUtc)}
              </time>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function IncidentsSection({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["incidents"];
}) {
  // Phase 32.8C closure pass — "unavailable" only when the read failed
  // AND there are no items AND no correlations AND no workflows AND no
  // chains. Otherwise show what we have.
  const correlations = section.correlations ?? [];
  const workflows = section.workflows ?? [];
  const causalityChains = section.causalityChains ?? [];
  // STAGE 2 — gate ops/observability/runbooks deep-links on capability.
  // Users without OBSERVABILITY_VIEW / RUNBOOKS_VIEW still see the
  // incident list (it's diagnostic), but the deep-link into the
  // operator surface stays hidden when they could not USE it.
  const canObservability = useCan("OBSERVABILITY_VIEW");
  const canRunbooks = useCan("RUNBOOKS_VIEW");
  if (
    section.status === "unavailable" &&
    section.items.length === 0 &&
    correlations.length === 0 &&
    workflows.length === 0 &&
    causalityChains.length === 0
  ) {
    return (
      <SectionShell kicker="Incidents" title="Incidents read degraded" severity="warning">
        <SectionNote status="unavailable" kind="incidents" />
      </SectionShell>
    );
  }
  if (
    section.items.length === 0 &&
    correlations.length === 0 &&
    workflows.length === 0 &&
    causalityChains.length === 0
  ) {
    return (
      <SectionShell kicker="Incidents" title="No open incidents · workspace healthy">
        <EnterpriseEmpty
          title="No open operational incidents"
          body="The incident generator scans real platform conditions on every dashboard load — report/package backlog, stale review assignments, retry storms, stale telemetry, worker heartbeat staleness, unsigned aged evidence, and stale coordination backlog. A 0-result state means every one of these thresholds is currently within tolerance. Workflows and causality chains follow incidents — when there are no incidents there is nothing to orchestrate."
          hint="Detailed platform health remains accessible under Operations Center."
          actionLabel={canObservability ? "Open observability" : undefined}
          actionHref={canObservability ? "/operations/observability" : undefined}
        />
      </SectionShell>
    );
  }
  const titleParts = [`Open incidents · ${section.items.length}`];
  if (causalityChains.length > 0) {
    titleParts.push(
      `${causalityChains.length} chain${causalityChains.length === 1 ? "" : "s"}`,
    );
  }
  if (workflows.length > 0) {
    titleParts.push(
      `${workflows.length} workflow${workflows.length === 1 ? "" : "s"}`,
    );
  }
  if (correlations.length > 0) {
    titleParts.push(
      `${correlations.length} correlation${correlations.length === 1 ? "" : "s"}`,
    );
  }
  return (
    <SectionShell
      kicker="Incidents"
      title={titleParts.join(" · ")}
      severity={
        section.items.some((i) => i.severity === "CRITICAL")
          ? "critical"
          : section.items.some((i) => i.severity === "HIGH")
            ? "high"
            : "warning"
      }
    >
      {/* Phase 32.8C FINAL-2 — causality chains render FIRST so the
          operator reads "Why is this happening?" before "What is
          happening?". Workflows next so ownership + due pressure is
          visible. Then correlations (cross-system root patterns).
          Then the per-incident list. */}
      <CausalityChainsStrip chains={causalityChains} />
      <WorkflowsStrip workflows={workflows} />
      <IncidentCorrelations correlations={correlations} />
      {section.items.length > 0 ? (
      <ul className="ec-incident-list" data-cc-incidents-list>
        {section.items.map((i) => (
          <li
            key={i.id}
            className="ec-incident-row"
            data-cc-incident-id={i.id}
            data-cc-incident-severity={i.severity}
            data-cc-incident-category={i.category}
            data-cc-incident-status={i.status}
            data-cc-incident-assigned={i.assignedOperatorUserId ? "true" : "false"}
          >
            {(() => {
              // STAGE 2 — pick the deep-link target only if the actor
              // has the capability for that destination. If they have
              // neither, render the same content as a non-anchor row
              // so the incident still shows up.
              const incidentHref =
                i.runbookSlug && canRunbooks
                  ? `/operations/runbooks#${i.runbookSlug}`
                  : canObservability
                    ? "/operations/observability"
                    : null;
              const incidentBody = (
                <>
                  <span className="ec-incident-title">{i.title}</span>
                  <span className="ec-incident-meta">
                    {i.category} · {i.severity} · {i.occurrenceCount}×
                    {i.assignedOperatorUserId ? (
                      <>
                        {" · "}
                        <span data-cc-incident-assigned-label>
                          assigned {i.assignedOperatorUserId.slice(0, 8)}
                        </span>
                      </>
                    ) : null}
                    {i.acknowledgedByUserId && !i.assignedOperatorUserId ? (
                      <>
                        {" · "}
                        <span data-cc-incident-ack-label>
                          ack {i.acknowledgedByUserId.slice(0, 8)}
                        </span>
                      </>
                    ) : null}
                  </span>
                </>
              );
              return incidentHref ? (
                <Link href={incidentHref} className="ec-incident-link">
                  {incidentBody}
                </Link>
              ) : (
                <div className="ec-incident-link">{incidentBody}</div>
              );
            })()}
          </li>
        ))}
      </ul>
      ) : null}
      {canObservability ? (
        <div className="ec-section-foot">
          Operator actions (acknowledge / assign / resolve / suppress, workflow
          ownership transitions) live on the{" "}
          <Link href="/operations/observability">Operations Center</Link> incident +
          workflow detail pages. The dashboard is read-only.
        </div>
      ) : (
        <div className="ec-section-foot">
          The dashboard is read-only. Operator actions are performed by
          operations staff with access to the operations center.
        </div>
      )}
    </SectionShell>
  );
}

function QuickActions({
  isTeam,
  canMutate,
  canViewGovernance,
}: {
  isTeam: boolean;
  canMutate: boolean;
  canViewGovernance: boolean;
}) {
  const actions: Array<{
    id: string;
    label: string;
    href: string;
    visible: boolean;
    primary?: boolean;
  }> = [
    {
      id: "capture",
      label: "Capture evidence",
      href: "/capture",
      visible: canMutate,
      primary: true,
    },
    { id: "evidence", label: "Evidence library", href: "/evidence", visible: true },
    { id: "cases", label: "Cases", href: "/cases", visible: canMutate },
    {
      id: "reviewer-ops",
      label: "Reviewer Ops",
      href: "/reviewer-ops",
      visible: isTeam,
    },
    { id: "reports", label: "Reports & artifacts", href: "/reports", visible: true },
    {
      id: "governance",
      label: "Governance",
      href: "/governance",
      visible: canViewGovernance,
    },
  ];
  return (
    <SectionShell kicker="Quick actions" title="Operator actions">
      <div className="ec-quick-grid" data-cc-quick-actions>
        {actions
          .filter((a) => a.visible)
          .map((a) => (
            <Link
              key={a.id}
              href={a.href}
              className={`ec-quick-action ${a.primary ? "is-primary" : ""}`}
              data-cc-quick-action-id={a.id}
            >
              {a.label}
            </Link>
          ))}
      </div>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Shared shells + helpers
// ---------------------------------------------------------------------------

function SectionShell({
  id,
  kicker,
  title,
  severity,
  children,
  ...rest
}: {
  id?: string;
  kicker: string;
  title: string;
  severity?: SeverityTone;
  children: React.ReactNode;
} & Record<`data-${string}`, string>) {
  return (
    <section
      className="ec-section"
      id={id}
      data-cc-section-severity={severity ?? "info"}
      {...rest}
    >
      <header className="ec-section-header">
        <div className="ec-section-kicker">{kicker}</div>
        <h2 className="ec-section-title">{title}</h2>
      </header>
      <div className="ec-section-body">{children}</div>
    </section>
  );
}

/**
 * Phase 32.8C closure pass — per-section operational copy.
 *
 * Each kind explains what "degraded" actually means for that subsystem
 * so operators can distinguish a localized read failure from a platform
 * outage. The copy intentionally avoids generic placeholder wording so
 * a healthy subsystem with a transient read failure is never presented
 * as a broken platform.
 */
const SECTION_OPERATIONAL_COPY: Record<
  string,
  { degraded: string; unavailable: string }
> = {
  pressure: {
    degraded:
      "Operational pressure read partial. Some pressure sources could not be sampled this cycle — pressure scoring may understate the workspace state.",
    unavailable:
      "Operational pressure read could not complete on this cycle. Other dashboard sections remain usable; pressure will reattempt on the next refresh.",
  },
  routing: {
    degraded: "Action routing surface read partial; some routes may not be ranked.",
    unavailable:
      "Action routing read could not complete on this cycle. Existing routes remain accessible from the underlying pages.",
  },
  investigation: {
    degraded:
      "Case investigation read partial; some cross-evidence checks could not be sampled.",
    unavailable:
      "Investigation engine read could not complete on this cycle. Case detail pages remain authoritative.",
  },
  "workload-engine": {
    degraded:
      "Reviewer workload sampling partial; saturation score reflects the most recent successful sample only.",
    unavailable:
      "Reviewer workload sampling could not complete on this cycle. Reviewer ops pages remain authoritative.",
  },
  "queue-congestion": {
    degraded:
      "Queue congestion sampling partial; some queues could not be sampled this cycle.",
    unavailable:
      "Queue congestion read could not complete on this cycle. See Queue / Worker Telemetry for durable snapshot data.",
  },
  "custody-integrity": {
    degraded:
      "Custody/integrity anomaly read partial; some classifiers may be stale.",
    unavailable:
      "Custody/integrity anomaly read could not complete on this cycle. Evidence integrity panels remain authoritative.",
  },
  security: {
    degraded:
      "Security telemetry returning delayed snapshots. Detection remains operational; the latest sample is older than the freshness threshold.",
    unavailable:
      "Security event read could not complete on this cycle. Detection remains operational via the audit log subsystem; the dashboard rollup will reattempt next refresh.",
  },
  "security-classifier": {
    degraded:
      "Security anomaly classifier operating on a delayed snapshot. No active incidents detected from the latest sample.",
    unavailable:
      "Security classifier read could not complete on this cycle. The underlying SecurityEvent log remains canonical.",
  },
  relationships: {
    degraded:
      "Evidence relationship intelligence read partial; some relationship-cluster computations could not complete.",
    unavailable:
      "Evidence relationship intelligence read could not complete on this cycle.",
  },
  "cross-case-v2": {
    degraded:
      "Cross-case intelligence read partial; some cross-case correlations may not be surfaced.",
    unavailable:
      "Cross-case intelligence read could not complete on this cycle. Individual case pages remain authoritative.",
  },
  "deep-integrity": {
    degraded:
      "Deep integrity watch operating on a delayed snapshot. The persisted integrity classifier remains the source of truth.",
    unavailable:
      "Deep integrity read could not complete on this cycle. Per-evidence integrity panels remain authoritative.",
  },
  "queue-worker-telemetry": {
    degraded:
      "Telemetry sampler returning delayed snapshots. The worker remains operational; queue/heartbeat samples are older than the freshness threshold.",
    unavailable:
      "Queue/worker telemetry read could not complete on this cycle. The worker remains operational — the dashboard will resample on the next refresh.",
  },
  coordination: {
    degraded:
      "Coordination signals read partial; the backlog counters reflect only the queries that succeeded.",
    unavailable:
      "Coordination signals read could not complete on this cycle. Reviewer Ops + Case Detail pages remain authoritative.",
  },
  "reconstructed-timeline": {
    degraded:
      "Reconstructed timeline read partial; some source tables could not be sampled.",
    unavailable:
      "Reconstructed timeline read could not complete on this cycle. The OperationalTimelineEvent projection will be re-ingested on the next refresh.",
  },
  "predictive-risk": {
    degraded:
      "Predictive risk read partial; forecast is computed from the engine outputs that did succeed.",
    unavailable:
      "Predictive risk read could not complete on this cycle. Forecasts derive from other engines on this dashboard, all of which remain accessible directly.",
  },
  "org-intelligence-v2": {
    degraded:
      "Organizational intelligence read partial; throughput trends may reflect a narrower window.",
    unavailable:
      "Organizational intelligence read could not complete on this cycle. Workspace settings + reports surfaces remain authoritative.",
  },
  "case-operations": {
    degraded:
      "Case operations read partial; some case-level signals could not be aggregated.",
    unavailable:
      "Case operations read could not complete on this cycle. Individual case pages remain authoritative.",
  },
  "reviewer-orchestration": {
    degraded:
      "Reviewer orchestration read partial; some reviewer signals may not be surfaced.",
    unavailable:
      "Reviewer orchestration read could not complete on this cycle. Reviewer Ops remains the canonical surface.",
  },
  "pipeline-detail": {
    degraded:
      "Evidence pipeline read partial; some pipeline counters reflect the most recent successful sample.",
    unavailable:
      "Evidence pipeline read could not complete on this cycle. The Evidence list page remains authoritative.",
  },
  governance: {
    degraded:
      "Governance posture read partial; some policy counters reflect the most recent successful sample.",
    unavailable:
      "Governance posture read could not complete on this cycle. The Governance surface remains authoritative.",
  },
  organizational: {
    degraded:
      "Organizational intelligence read partial; some trend windows are narrower than usual.",
    unavailable:
      "Organizational intelligence read could not complete on this cycle.",
  },
  timeline: {
    degraded:
      "Operational timeline read partial; some source tables could not be sampled.",
    unavailable:
      "Operational timeline read could not complete on this cycle.",
  },
  "audit-readiness": {
    degraded:
      "Audit readiness read partial; readiness score reflects the most recent successful sample.",
    unavailable:
      "Audit readiness read could not complete on this cycle. The Governance + Reports surfaces remain authoritative.",
  },
  "recent-evidence": {
    degraded:
      "Recent evidence read partial; the Evidence list page remains the canonical view.",
    unavailable:
      "Recent evidence read could not complete on this cycle. The Evidence list page remains the canonical view.",
  },
};

const DEFAULT_SECTION_COPY = {
  degraded:
    "This section's read returned partial data on this cycle. The underlying subsystem remains operational; other sections remain usable.",
  unavailable:
    "This section's read could not complete on this cycle. The underlying subsystem remains operational; the dashboard will reattempt this section on the next refresh.",
};

function SectionNote({
  status,
  kind,
}: {
  status: SectionStatus;
  kind: string;
}) {
  if (status === "ok") return null;
  const operational = SECTION_OPERATIONAL_COPY[kind] ?? DEFAULT_SECTION_COPY;
  const copy =
    status === "degraded"
      ? operational.degraded
      : status === "unavailable"
        ? operational.unavailable
        : "Not applicable for this workspace.";
  // Phase 32.8C closure pass — `unavailable` is rendered as a localized
  // degraded read (data-cc-degraded-localized) rather than a full failure
  // banner so operators see degradation context rather than a generic red
  // wall.
  return (
    <div
      className="ec-section-note"
      data-cc-section-status={status}
      data-cc-section-kind={kind}
      data-cc-degraded-localized={status === "unavailable" ? "true" : "false"}
      role="status"
    >
      {copy}
    </div>
  );
}

function PersonalNote({ subsystem }: { subsystem: "reviewer" | "governance" }) {
  return (
    <div
      className="ec-section-note"
      data-cc-personal-scope={subsystem}
      data-cc-section-status="not_applicable"
    >
      Personal workspace uses basic evidence controls.{" "}
      {subsystem === "reviewer"
        ? "Reviewer orchestration is a workspace feature."
        : "Governance posture is a workspace feature."}
    </div>
  );
}

function Tile({
  keyId,
  label,
  value,
  severe,
}: {
  keyId: string;
  label: string;
  value: number;
  severe?: boolean;
}) {
  return (
    <div
      className="ec-tile"
      data-cc-tile-key={keyId}
      data-cc-tile-severe={severe ? "true" : "false"}
    >
      <span className="ec-tile-value">{value}</span>
      <span className="ec-tile-label">{label}</span>
    </div>
  );
}

function EnterpriseEmpty({
  title,
  body,
  hint,
  actionLabel,
  actionHref,
}: {
  title: string;
  body: string;
  hint?: string;
  actionLabel?: string;
  actionHref?: string;
}) {
  return (
    <div className="ec-empty" data-cc-empty>
      <strong>{title}</strong>
      <p>{body}</p>
      {hint ? <small className="ec-empty-hint">{hint}</small> : null}
      {actionLabel && actionHref ? (
        <Link href={actionHref} className="ec-quick-action is-primary">
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
}

function CommandCenterLoading() {
  return (
    <main className="ec-page" data-command-center-loading>
      <header className="ec-hero">
        <div className="ec-hero-titles">
          <div className="ec-kicker">Evidence Operations Center</div>
          <h1 className="ec-title">Loading workspace…</h1>
        </div>
      </header>
      <section className="ec-section">
        <div className="ec-skeleton" />
      </section>
    </main>
  );
}

function NoWorkspaceState() {
  // R1 Part 3 — neutral, actionable copy. After Bug A's fix this state
  // is only reachable when the envelope genuinely lacks an active
  // space (very rare; provider bootstraps Personal Space). Treat it
  // as "setup incomplete," NOT as an error.
  //
  // Phase A.1C — the account-level priorities banner is rendered
  // separately by /home so this state stays compact. We expand the
  // onboarding card to the FULL three operational steps a first-time
  // user actually needs, with real registered destinations + the
  // workspace-administration deep link.
  return (
    <main className="ec-page" data-command-center-empty>
      <header className="ec-hero">
        <div className="ec-hero-titles">
          <div className="ec-kicker">Evidence Operations Center</div>
          <h1 className="ec-title">Workspace setup incomplete</h1>
          <p className="ec-subtitle">
            Your workspace is still being prepared, or you can create or
            join an organization to enable team operations. The account
            priorities above show what is waiting for you across all
            your contexts.
          </p>
        </div>
      </header>
      <SectionShell kicker="Get started" title="Three operational steps">
        <ol
          data-cc-empty-onboarding-steps
          style={{
            margin: 0,
            paddingLeft: "1.2rem",
            display: "grid",
            gap: 8,
            fontSize: 13.5,
          }}
        >
          <li data-cc-empty-step="organize">
            <strong>Create or join an organization.</strong>{" "}
            Organizations are the governance + identity tenant.{" "}
            <Link href="/organizations" data-action="empty-open-organizations">
              Open Organizations →
            </Link>
          </li>
          <li data-cc-empty-step="capture">
            <strong>Capture evidence.</strong>{" "}
            Personal workspace is available immediately — record
            hashed, signed media without waiting for an org.{" "}
            <Link href="/capture" data-action="empty-open-capture">
              Start a capture →
            </Link>
          </li>
          <li data-cc-empty-step="govern">
            <strong>Manage workspaces.</strong>{" "}
            Set retention, invite members, configure governance from{" "}
            <Link href="/workspaces" data-action="empty-open-teams">
              Workspace administration →
            </Link>
          </li>
        </ol>
        <div
          className="ec-quick-grid"
          style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          <Link
            href="/organizations"
            className="ec-quick-action is-primary"
            data-cc-empty-primary-cta
          >
            Open Organizations
          </Link>
          <Link
            href="/capture"
            className="ec-quick-action"
            data-cc-empty-secondary-cta
          >
            Capture personal evidence
          </Link>
        </div>
      </SectionShell>
    </main>
  );
}

function AuthErrorState({
  code,
}: {
  code: "auth_required" | "permission_denied";
}) {
  return (
    <main className="ec-page" data-command-center-auth-error>
      <header className="ec-hero">
        <div className="ec-hero-titles">
          <div className="ec-kicker">Evidence Operations Center</div>
          <h1 className="ec-title">
            {code === "auth_required" ? "Sign in required" : "Permission required"}
          </h1>
          <p className="ec-subtitle">
            {code === "auth_required"
              ? "Sign in to view this workspace's operational state."
              : "You do not have permission to view this workspace."}
          </p>
        </div>
      </header>
    </main>
  );
}

function UnavailableState({
  message,
  requestId,
}: {
  message: string;
  requestId: string | null;
}) {
  return (
    <main className="ec-page" data-command-center-error>
      <header className="ec-hero">
        <div className="ec-hero-titles">
          <div className="ec-kicker">Evidence Operations Center</div>
          <h1 className="ec-title">Dashboard read could not complete</h1>
          <p className="ec-subtitle">{message}</p>
          {requestId ? (
            <p className="ec-subtitle">Request ID: {requestId}</p>
          ) : null}
        </div>
      </header>
    </main>
  );
}

function humanize(s: string): string {
  return s
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Phase 32.8C+++++++ — Operational health banner.
 *
 * Renders the structured OpsHealthState the backend evaluator returned.
 * The banner colour follows the severity ladder (info / amber / warning
 * / high / critical / muted) so a STALE telemetry sampler with the
 * canonical source alive paints AMBER, not RED.
 *
 * Hidden when the health is null or HEALTHY (no banner = healthy).
 */
function OpsHealthBanner({
  title,
  kind,
  health,
}: {
  title: string;
  kind: string;
  health:
    | {
        status: string;
        severity: string;
        reason: string;
        recoverable: boolean;
        canonicalSourceHealthy: boolean;
        lastSuccessfulRunAt: string | null;
        degradedSince: string | null;
        retrying: boolean;
      }
    | null;
}) {
  if (!health) return null;
  if (health.status === "HEALTHY") return null;
  return (
    <div
      className="ec-section-note"
      data-cc-ops-health-banner
      data-cc-ops-health-kind={kind}
      data-cc-ops-health-status={health.status}
      data-cc-ops-health-severity={health.severity}
      data-cc-ops-health-canonical={
        health.canonicalSourceHealthy ? "true" : "false"
      }
      role="status"
    >
      <div className="ec-ops-health-banner-head">
        <strong>
          {title} · {humanizeOpsHealthStatus(health.status)}
        </strong>
        {health.canonicalSourceHealthy ? (
          <span className="ec-chip-faint">canonical source healthy</span>
        ) : null}
      </div>
      <div className="ec-ops-health-banner-reason">{health.reason}</div>
      {health.lastSuccessfulRunAt ? (
        <small className="ec-chip-faint">
          Last successful run:{" "}
          <time dateTime={health.lastSuccessfulRunAt}>
            {relTime(health.lastSuccessfulRunAt)}
          </time>
        </small>
      ) : null}
    </div>
  );
}

/** Phase 32.8C+++++++ — translate OpsHealthStatus to operator-facing label. */
function humanizeOpsHealthStatus(status: string): string {
  switch (status) {
    case "HEALTHY":
      return "Healthy";
    case "STALE":
      return "Telemetry stale";
    case "DEGRADED":
      return "Degraded read";
    case "PARTIAL":
      return "Partial read";
    case "UNAVAILABLE":
      return "Read unavailable";
    case "FAILED":
      return "Failed";
    case "DISCONNECTED":
      return "Disconnected";
    default:
      return status;
  }
}

/** Phase 32.8C+++++++ — map OpsHealth severity to SectionShell severity. */
function opsHealthToShellSeverity(
  health: { severity: string; status: string } | null | undefined,
): SeverityTone | undefined {
  if (!health) return undefined;
  switch (health.severity) {
    case "info":
      return "info";
    case "amber":
    case "warning":
      return "warning";
    case "high":
      return "high";
    case "critical":
      return "critical";
    case "muted":
      return "info";
    default:
      return undefined;
  }
}

/**
 * Phase 32.8C+++++++ — active-section tracking hook.
 *
 * Uses an IntersectionObserver to detect which dashboard section is
 * currently in the viewport. The persona priority chips light up the
 * active section, and the URL hash is synced (without scroll jump) so
 * browser refresh + deep links land on the right section.
 *
 * Honors a hash already present in the URL on first mount (scrolls to
 * it once after layout settles).
 */
function useActiveSection(orderedIds: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const orderedKey = orderedIds.join(",");
  const orderedIdsRef = useRef(orderedIds);
  orderedIdsRef.current = orderedIds;

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Honor an initial hash so /home#routingQueue lands on the section.
    const initialHash = window.location.hash.replace("#", "");
    if (initialHash) {
      // Defer one frame so the section has rendered.
      window.setTimeout(() => {
        const el = document.getElementById(initialHash);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 150);
    }
    return undefined;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (orderedIdsRef.current.length === 0) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the entry with the highest intersection ratio that's at
        // least partly in view. Falls back to the topmost in-view entry.
        let best: { id: string; ratio: number; top: number } | null = null;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const id = (e.target as HTMLElement).getAttribute("data-section");
          if (!id) continue;
          const r = e.intersectionRatio;
          const top = (e.target as HTMLElement).getBoundingClientRect().top;
          if (
            !best ||
            r > best.ratio ||
            (r === best.ratio && top < best.top)
          ) {
            best = { id, ratio: r, top };
          }
        }
        if (best) {
          setActive(best.id);
          // Soft-sync the URL hash so a copy-link picks up the right
          // section. Use replaceState to avoid spamming history.
          if (window.location.hash !== `#${best.id}`) {
            history.replaceState(null, "", `#${best.id}`);
          }
        }
      },
      {
        // Trigger when the section is approximately mid-viewport. The
        // root-margin pulls the activation line down a bit so the
        // currently focused section is the one the operator is reading.
        rootMargin: "-30% 0px -55% 0px",
        threshold: [0, 0.25, 0.5, 0.75, 1],
      },
    );

    // Observe every section node we know about.
    const els: Element[] = [];
    for (const id of orderedIdsRef.current) {
      const el = document.getElementById(id);
      if (el) {
        observer.observe(el);
        els.push(el);
      }
    }
    return () => {
      for (const el of els) observer.unobserve(el);
      observer.disconnect();
    };
    // The CONTENT of the id list is the subscription key (`orderedKey`); the
    // ids themselves come from a ref so a new array with identical contents
    // does not tear down and rebuild the IntersectionObserver each render.
  }, [orderedKey]);

  return active;
}

/**
 * Phase 32.8C FINAL-4 — humanize a camelCase section id into a label.
 * Used by the persona priority strip to render anchor link text.
 */
function humanizeSectionId(s: string): string {
  return s
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\s+v2$/i, " v2")
    .replace(/\s+v\d+$/i, (m) => m.toUpperCase())
    .trim();
}

/**
 * Phase 32.8C FINAL-4 — Bulk Actions toolbar.
 *
 * Read-only chips showing the operator which bulk actions are
 * available for this persona + workspace scope. Each chip links to
 * the Operations Center where the actual mutation routes live —
 * the dashboard never invokes bulk operations directly. Permission
 * gating is sourced from the capability matrix.
 */
function BulkActionsToolbar({
  capabilities,
  scope,
}: {
  capabilities: NonNullable<
    CommandCenterEnvelope["capabilityMatrix"]
  >["capabilities"];
  scope: WorkspaceScope;
}) {
  // STAGE 2 — gate the deep-link to /operations/observability on the canonical
  // capability for that route. The chips themselves remain visible
  // (they're already permission-aware via the envelope.capabilities
  // matrix and surface their own "Requires X" reason text).
  const canObservability = useCan("OBSERVABILITY_VIEW");
  const actions: Array<{
    key: string;
    label: string;
    canAct: boolean;
    reason: string;
    href: string;
  }> = [
    {
      key: "bulk_assign_workflows",
      label: "Bulk assign workflows",
      canAct: capabilities.bulkActions && capabilities.workflowActions,
      reason:
        scope === "SINGLE_OCCUPANT"
          ? "Requires workspace"
          : capabilities.bulkActions
            ? ""
            : "Requires ADMIN or OWNER",
      href: "/operations/observability",
    },
    {
      key: "bulk_escalate_workflows",
      label: "Bulk escalate",
      canAct: capabilities.bulkActions && capabilities.workflowActions,
      reason:
        scope === "SINGLE_OCCUPANT"
          ? "Requires workspace"
          : capabilities.bulkActions
            ? ""
            : "Requires ADMIN or OWNER",
      href: "/operations/observability",
    },
    {
      key: "bulk_resolve_workflows",
      label: "Bulk resolve",
      canAct: capabilities.bulkActions && capabilities.workflowActions,
      reason:
        scope === "SINGLE_OCCUPANT"
          ? "Requires workspace"
          : capabilities.bulkActions
            ? ""
            : "Requires ADMIN or OWNER",
      href: "/operations/observability",
    },
    {
      key: "bulk_acknowledge_incidents",
      label: "Bulk acknowledge incidents",
      canAct: capabilities.bulkActions && capabilities.incidentActions,
      reason:
        scope === "SINGLE_OCCUPANT"
          ? "Requires workspace"
          : capabilities.bulkActions
            ? ""
            : "Requires ADMIN or OWNER",
      href: "/operations/observability",
    },
    {
      key: "bulk_suppress_incidents",
      label: "Bulk suppress noisy incidents",
      canAct: capabilities.bulkActions && capabilities.incidentActions,
      reason:
        scope === "SINGLE_OCCUPANT"
          ? "Requires workspace"
          : capabilities.bulkActions
            ? ""
            : "Requires ADMIN or OWNER",
      href: "/operations/observability",
    },
    {
      key: "bulk_schedule_retry",
      label: "Bulk schedule retry review",
      canAct: capabilities.bulkActions && capabilities.workflowActions,
      reason:
        scope === "SINGLE_OCCUPANT"
          ? "Requires workspace"
          : capabilities.bulkActions
            ? "Records retry intent only — never invokes the queue."
            : "Requires ADMIN or OWNER",
      href: "/operations/observability",
    },
    {
      key: "bulk_add_mitigation",
      label: "Bulk add mitigation note",
      canAct: capabilities.bulkActions && capabilities.workflowActions,
      reason:
        scope === "SINGLE_OCCUPANT"
          ? "Requires workspace"
          : capabilities.bulkActions
            ? ""
            : "Requires ADMIN or OWNER",
      href: "/operations/observability",
    },
    {
      key: "bulk_dismiss_recommendations",
      label: "Bulk dismiss routing recommendations",
      canAct: capabilities.bulkActions,
      reason:
        scope === "SINGLE_OCCUPANT"
          ? "Requires workspace"
          : capabilities.bulkActions
            ? ""
            : "Requires ADMIN or OWNER",
      href: "/operations/observability",
    },
  ];
  const anyAvailable = actions.some((a) => a.canAct);
  return (
    <section
      className="ec-section"
      id="bulkActions"
      data-cc-bulk-actions-toolbar
      data-cc-bulk-actions-available={anyAvailable ? "true" : "false"}
      aria-label="Bulk operator actions"
    >
      <div className="ec-section-head" data-cc-bulk-actions-head>
        <span className="ec-kicker">Bulk operator actions</span>
        <span className="ec-chip-faint">
          {anyAvailable
            ? `${actions.filter((a) => a.canAct).length} actions available`
            : scope === "SINGLE_OCCUPANT"
              ? "Switch to a workspace to unlock bulk actions"
              : "Requires ADMIN or OWNER role"}
        </span>
      </div>
      <ul
        className="ec-bulk-actions-list"
        data-cc-bulk-actions-list
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        {actions.map((a) => (
          <li
            key={a.key}
            data-cc-bulk-action={a.key}
            data-cc-bulk-action-can-act={a.canAct ? "true" : "false"}
          >
            {a.canAct && canObservability ? (
              <Link
                href={a.href}
                className="ec-chip"
                data-cc-bulk-action-link
                style={{ textDecoration: "none" }}
              >
                {a.label} →
              </Link>
            ) : (
              <span
                className="ec-chip-faint"
                data-cc-bulk-action-disabled
                title={a.reason}
              >
                {a.label} · {a.reason || "unavailable"}
              </span>
            )}
          </li>
        ))}
      </ul>
      {canObservability ? (
        <div className="ec-section-foot">
          Bulk actions are executed on the Operations Center page (
          <Link href="/operations/observability">/operations/observability</Link>). The
          dashboard is read-only — chips above link to the canonical surface.
          Every bulk run fans out to the underlying lifecycle service and is
          audited per-target.
        </div>
      ) : (
        <div className="ec-section-foot">
          The dashboard is read-only. Bulk actions are executed by operations
          staff with access to the operations center. Every bulk run is
          audited per-target.
        </div>
      )}
    </section>
  );
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (Math.abs(diff) < 60_000) return "just now";
  const minutes = Math.floor(Math.abs(diff) / 60_000);
  if (minutes < 60) return `${minutes}m${diff < 0 ? " from now" : " ago"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${diff < 0 ? " from now" : " ago"}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d${diff < 0 ? " from now" : " ago"}`;
  return new Date(iso).toISOString().slice(0, 10);
}
