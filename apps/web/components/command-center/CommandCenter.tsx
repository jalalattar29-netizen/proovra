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

      {/* SUMMARY STRIP */}
      <SummaryStrip envelope={envelope} isTeam={isTeam} />

      {/* 1. ACTIVE OPERATIONAL PRESSURE — full-width hero */}
      <OperationalPressureSection
        section={sections.operationalPressure}
        canMutate={canMutate}
      />

      {/* 2 + 3. INVESTIGATION OPERATIONS + REVIEWER ORCHESTRATION */}
      <div className="ec-grid-2col">
        <CaseOperationsSection section={sections.caseOperations} />
        <ReviewerOrchestrationSection section={sections.reviewerOrchestration} />
      </div>

      {/* 4 + 5. PIPELINE DETAIL + GOVERNANCE POSTURE */}
      <div className="ec-grid-2col">
        <PipelineDetailSection section={sections.pipelineDetail} />
        <GovernancePostureSection
          section={sections.governancePosture}
          isTeam={isTeam}
        />
      </div>

      {/* 8 + 6. AUDIT READINESS + ORGANIZATIONAL INTELLIGENCE */}
      <div className="ec-grid-2col">
        <AuditReadinessSection section={sections.auditReadiness} />
        <OrganizationalIntelligenceSection
          section={sections.organizationalIntelligence}
        />
      </div>

      {/* 7. OPERATIONAL TIMELINE — full-width heartbeat */}
      <TimelineSection section={sections.timeline} />

      {/* Activity + Incidents + Quick Actions row */}
      <div className="ec-grid-3col">
        <RecentEvidenceSection section={sections.recentEvidence} />
        <IncidentsSection section={sections.incidents} />
        <QuickActions role={role} isTeam={isTeam} canMutate={canMutate} />
      </div>
    </main>
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
