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

import { useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import { useActiveWorkspaceId } from "../../lib/useActiveWorkspaceId";
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
  const workspace = useActiveWorkspaceId();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (workspace.status === "loading") {
      setState({ status: "loading" });
      return;
    }
    if (workspace.status === "no-workspace") {
      setState({ status: "no_workspace" });
      return;
    }
    if (workspace.status === "error") {
      if (
        workspace.code === "auth_required" ||
        workspace.code === "permission_denied"
      ) {
        setState({ status: "auth_error", code: workspace.code });
      } else {
        setState({
          status: "unavailable",
          message: workspace.message,
          requestId: workspace.requestId ?? null,
        });
      }
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    apiFetch(
      `/v1/dashboard/command-center?teamId=${encodeURIComponent(workspace.workspaceId)}`,
      { method: "GET" },
    )
      .then((envelope: CommandCenterEnvelope) => {
        if (cancelled) return;
        setState({ status: "ready", envelope });
      })
      .catch((err: { message?: string; requestId?: string }) => {
        if (cancelled) return;
        setState({
          status: "unavailable",
          message: err?.message ?? "Unable to load command center.",
          requestId: err?.requestId ?? null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    workspace.status,
    workspace.status === "ready" ? workspace.workspaceId : null,
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
  const { workspace, sections } = envelope;
  const isTeam = workspace.scope === "TEAM";
  const role = workspace.role;
  const canMutate =
    role === "OWNER" || role === "ADMIN" || role === "MEMBER" || role === "REVIEWER";

  return (
    <main className="ec-page" data-command-center>
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
            {workspace.scope === "PERSONAL"
              ? "Personal workspace"
              : `Team · ${workspace.memberCount} members`}
          </span>
          <span data-cc-role={role}>Role · {role}</span>
          <span title={envelope.generatedAt}>
            Refreshed {relTime(envelope.generatedAt)}
          </span>
        </div>
      </header>

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

      {/* SUMMARY STRIP */}
      <SummaryStrip envelope={envelope} isTeam={isTeam} />

      {/* 1. ACTIVE OPERATIONAL PRESSURE — full-width hero */}
      <OperationalPressureSection
        section={sections.operationalPressure}
        canMutate={canMutate}
      />

      {/* Operational Routing Queue — actionable form of pressure */}
      <RoutingQueueSection section={sections.routingQueue} />

      {/* Investigation Risk Board + Reviewer Workload Engine */}
      <div className="ec-grid-2col">
        <InvestigationRiskBoard section={sections.investigationIntelligence} />
        <WorkloadEngineBoard section={sections.workloadEngine} />
      </div>

      {/* Legacy case ops + reviewer orchestration (kept for back-compat) */}
      <div className="ec-grid-2col">
        <CaseOperationsSection section={sections.caseOperations} />
        <ReviewerOrchestrationSection section={sections.reviewerOrchestration} />
      </div>

      {/* Pipeline & Artifact Operations + Governance & Compliance */}
      <div className="ec-grid-2col">
        <PipelineDetailSection section={sections.pipelineDetail} />
        <GovernancePostureSection
          section={sections.governancePosture}
          isTeam={isTeam}
        />
      </div>

      {/* Queue Congestion (full-width row) */}
      <QueueCongestionSection section={sections.queueCongestion} />

      {/* AUDIT READINESS + ORGANIZATIONAL INTELLIGENCE */}
      <div className="ec-grid-2col">
        <AuditReadinessSection section={sections.auditReadiness} />
        <OrganizationalIntelligenceSection
          section={sections.organizationalIntelligence}
        />
      </div>

      {/* Custody/Integrity Watch + Access/Security Watch */}
      <div className="ec-grid-2col">
        <CustodyIntegrityWatch
          section={sections.custodyIntegrityAnomalies}
        />
        <AccessSecurityWatch section={sections.accessSecurityAnomalies} />
      </div>

      {/* OPERATIONAL TIMELINE — full-width heartbeat */}
      <TimelineSection section={sections.timeline} />

      {/* Activity + Incidents + Quick Actions row */}
      <div className="ec-grid-3col">
        <RecentEvidenceSection section={sections.recentEvidence} />
        <IncidentsSection section={sections.incidents} />
        <QuickActions role={role} isTeam={isTeam} canMutate={canMutate} />
      </div>

      {/* Phase 32.8C++ Deep Operations Intelligence */}
      <PredictiveRiskBoard section={sections.predictiveRisk} />
      <OrgIntelligenceV2Board section={sections.organizationalIntelligenceV2} />
      <div className="ec-grid-2col">
        <RelationshipIntelligenceBoard section={sections.relationshipIntelligence} />
        <CrossCaseIntelligenceV2Board section={sections.crossCaseIntelligenceV2} />
      </div>
      <div className="ec-grid-2col">
        <DeepIntegrityWatch section={sections.deepIntegrityWatch} />
        <AccessSecurityClassifierBoard section={sections.accessSecurityClassifier} />
      </div>
      <div className="ec-grid-2col">
        <QueueWorkerTelemetryBoard section={sections.queueWorkerTelemetry} />
        <CoordinationSignalsBoard section={sections.coordinationSignals} />
      </div>
      <ReconstructedTimelineSection section={sections.reconstructedTimeline} />

      {/* Unsupported Signals — transparent catalog, collapsed by default */}
      <UnsupportedSignalsSection signals={envelope.unsupportedSignals} />
    </main>
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
      <SectionShell kicker="Predictive Risk Forecast" title="Forecast unavailable">
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
        title="Org intelligence unavailable"
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
        title="Relationship intelligence unavailable"
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
        title="Cross-case intelligence unavailable"
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
        title="Deep integrity unavailable"
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
}: {
  section: CommandCenterEnvelope["sections"]["accessSecurityClassifier"];
}) {
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell
        kicker="Security Anomaly Classifier"
        title="Classifier unavailable"
      >
        <SectionNote status="unavailable" kind="security-classifier" />
      </SectionShell>
    );
  }
  if (section.anomalies.length === 0) {
    return (
      <SectionShell
        kicker="Security Anomaly Classifier"
        title="No classified anomalies · 24h"
      >
        <EnterpriseEmpty
          title="No classified security anomalies"
          body="The classifier is rule-based on eventType strings. ML scoring is not in scope — see unsupported signals."
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
}: {
  section: CommandCenterEnvelope["sections"]["queueWorkerTelemetry"];
}) {
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell
        kicker="Queue / Worker Telemetry"
        title="Queue telemetry unavailable"
      >
        <SectionNote status="unavailable" kind="queue-worker-telemetry" />
      </SectionShell>
    );
  }
  const d = section.data;
  const snapshots = d.queueSnapshots ?? [];
  const heartbeats = d.workerHeartbeats ?? [];
  return (
    <SectionShell
      kicker="Queue / Worker Telemetry"
      title={`Reconcile · ${d.reconcileHealth}`}
      severity={
        d.reconcileHealth === "UNAVAILABLE"
          ? "high"
          : d.reconcileHealth === "STALE"
            ? "warning"
            : "info"
      }
    >
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
        title="Coordination signals unavailable"
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
        title="Reconstructed timeline unavailable"
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
        title="Routing queue unavailable"
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
          title="Routing queue clear"
          body="No items above warning severity require routing. The catalog of supported pressure signals is unchanged; new actionable items will appear here as they fire."
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
        title="Investigation intelligence unavailable"
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
      <SectionShell kicker="Workload Engine" title="Workload engine unavailable">
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
        title="Queue congestion unavailable"
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
        title="Custody / integrity unavailable"
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
  if (section.meta.status === "unavailable") {
    return (
      <SectionShell
        kicker="Access / Security Watch"
        title="Security event stream unavailable"
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
          title="No security anomalies surfaced"
          body="The watch reads the SecurityEvent stream filtered to WARNING + HIGH severity in the last 24 hours. No DB-side anomaly classifier is in scope; operator review is the canonical path."
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
      <summary className="ec-unsupported-summary">
        Unsupported signals · {signals.length}
        <small> (transparent catalog of intelligence the platform does not yet compute)</small>
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
      href: "/ops/observability",
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
        title="Operational pressure surface unavailable"
        severity="info"
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
          title="No operational pressure detected"
          body="No overdue reviews, stalled workflows, governance conflicts, or high-severity incidents on this workspace. New pressure items will surface here in real time."
          hint="Operational pressure is recomputed every time the dashboard loads — there is no per-row polling."
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
        title="Case operations unavailable"
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
        title="Reviewer orchestration unavailable"
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
        title="Pipeline visibility unavailable"
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
        title="Governance posture unavailable"
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
        title="Throughput unavailable"
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
        title="Timeline unavailable"
      >
        <SectionNote status="unavailable" kind="timeline" />
      </SectionShell>
    );
  }
  if (section.items.length === 0) {
    return (
      <SectionShell
        kicker="7 · Operational Timeline"
        title="No recent operational events"
      >
        <EnterpriseEmpty
          title="Operational heartbeat — no recent events"
          body="The timeline aggregates evidence finalizations, report/package generations, lifecycle transitions, hold actions, escalations, and incidents from the last 14 days."
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
        title="Audit readiness unavailable"
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
      <ul className="ec-audit-list" data-cc-audit-list>
        {section.counters.map((c) => (
          <AuditCounterRow key={c.key} counter={c} />
        ))}
      </ul>
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
      <SectionShell kicker="Recent" title="Recent evidence unavailable">
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

function IncidentsSection({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["incidents"];
}) {
  if (section.status === "unavailable") {
    return (
      <SectionShell kicker="Incidents" title="Incidents unavailable">
        <SectionNote status="unavailable" kind="incidents" />
      </SectionShell>
    );
  }
  if (section.items.length === 0) {
    return (
      <SectionShell kicker="Incidents" title="No open incidents">
        <EnterpriseEmpty
          title="No open operational incidents"
          body="Detailed platform health lives under Operations Center."
          actionLabel="Open observability"
          actionHref="/ops/observability"
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      kicker="Incidents"
      title={`Open incidents · ${section.items.length}`}
    >
      <ul className="ec-incident-list" data-cc-incidents-list>
        {section.items.map((i) => (
          <li
            key={i.id}
            className="ec-incident-row"
            data-cc-incident-severity={i.severity}
            data-cc-incident-category={i.category}
          >
            <Link
              href={
                i.runbookSlug
                  ? `/ops/runbooks#${i.runbookSlug}`
                  : "/ops/observability"
              }
              className="ec-incident-link"
            >
              <span className="ec-incident-title">{i.title}</span>
              <span className="ec-incident-meta">
                {i.category} · {i.severity} · {i.occurrenceCount}×
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="ec-section-foot">
        Detailed platform health lives under{" "}
        <Link href="/ops">Operations Center</Link>.
      </div>
    </SectionShell>
  );
}

function QuickActions({
  role,
  isTeam,
  canMutate,
}: {
  role: string;
  isTeam: boolean;
  canMutate: boolean;
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
      visible:
        isTeam && (role === "OWNER" || role === "ADMIN" || role === "MEMBER"),
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

function SectionNote({
  status,
  kind,
}: {
  status: SectionStatus;
  kind: string;
}) {
  if (status === "ok") return null;
  const copy =
    status === "degraded"
      ? "This section returned partial data. Other sections remain usable."
      : status === "unavailable"
        ? "This section is temporarily unavailable. Retry shortly."
        : "Not applicable for this workspace.";
  return (
    <div
      className="ec-section-note"
      data-cc-section-status={status}
      data-cc-section-kind={kind}
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
        ? "Reviewer orchestration is a team workspace feature."
        : "Governance posture is a team workspace feature."}
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
  return (
    <main className="ec-page" data-command-center-empty>
      <header className="ec-hero">
        <div className="ec-hero-titles">
          <div className="ec-kicker">Evidence Operations Center</div>
          <h1 className="ec-title">No workspace selected</h1>
          <p className="ec-subtitle">
            Select a workspace to view operational pressure, investigation
            status, reviewer coordination, and governance posture.
          </p>
        </div>
      </header>
      <SectionShell kicker="Get started" title="Onboarding">
        <div className="ec-quick-grid">
          <Link href="/teams" className="ec-quick-action is-primary">
            Create or join a workspace
          </Link>
          <Link href="/capture" className="ec-quick-action">
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
          <h1 className="ec-title">Temporarily unavailable</h1>
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
