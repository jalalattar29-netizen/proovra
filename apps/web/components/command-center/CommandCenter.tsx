"use client";

/**
 * Phase 32.8C — Enterprise Evidence Operations Command Center.
 *
 * Renders the /home dashboard from the `/v1/dashboard/command-center`
 * aggregator envelope. Every section consumes real backend state.
 * No fake metrics, no decorative widgets, no fabricated trends.
 *
 * Section catalog (Phase 32.8A → 32.8C):
 *   A. Operational Summary Strip
 *   B. Attention Queue
 *   C. Recent Evidence Activity
 *   D. Pipeline Readiness
 *   E. Reviewer / Case Workload (team-scoped)
 *   F. Governance Posture (team-scoped)
 *   G. Platform Impact Banner (reuse RuntimeStatusBanner)
 *   H. Quick Actions (role-aware)
 *
 * Hard rules:
 *   - Every section reads its own `status` and renders the
 *     corresponding state (ok / degraded / unavailable /
 *     not_applicable). One degraded subsystem does NOT poison the
 *     whole dashboard.
 *   - Personal workspaces render reviewer/governance sections as
 *     "Personal workspace uses basic evidence controls" — never
 *     broken team widgets.
 *   - Viewer role hides mutation CTAs (Capture, Create Case). Quick
 *     Actions filter by role.
 *   - All counts come from the envelope; the component never
 *     fabricates numbers.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import { useActiveWorkspaceId } from "../../lib/useActiveWorkspaceId";
import {
  OperationalEmptyState,
  RuntimeStatusBanner,
} from "../operational";
import type { CommandCenterEnvelope, SectionStatus } from "./types";

// ---------------------------------------------------------------------------
// Top-level page
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

  if (state.status === "loading") {
    return <CommandCenterLoading />;
  }
  if (state.status === "no_workspace") {
    return <NoWorkspaceState />;
  }
  if (state.status === "auth_error") {
    return <AuthErrorState code={state.code} />;
  }
  if (state.status === "unavailable") {
    return <UnavailableState message={state.message} requestId={state.requestId} />;
  }

  return <CommandCenterReady envelope={state.envelope} />;
}

// ---------------------------------------------------------------------------
// Ready (real dashboard)
// ---------------------------------------------------------------------------

function CommandCenterReady({ envelope }: { envelope: CommandCenterEnvelope }) {
  const { workspace, sections } = envelope;
  const isTeam = workspace.scope === "TEAM";
  const role = workspace.role;
  const canMutate = role === "OWNER" || role === "ADMIN" || role === "MEMBER" || role === "REVIEWER";

  return (
    <main className="cc-page" data-command-center>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Command Center</div>
          <h1 className="cc-title">Evidence Operations</h1>
          <p className="cc-subtitle">
            What needs attention, what is in motion, and where to act next.
          </p>
        </div>
        <div className="cc-meta" data-cc-meta>
          <span data-cc-workspace-scope={workspace.scope}>
            {workspace.scope === "PERSONAL" ? "Personal workspace" : `Team workspace · ${workspace.memberCount} members`}
          </span>
          <span data-cc-role={role}>Role: {role}</span>
          <span title={envelope.generatedAt}>
            Updated {formatRelativeTime(envelope.generatedAt)}
          </span>
        </div>
      </header>

      {/* G. Platform Impact Banner — reuse the canonical runtime banner.
          Scoped to the evidence/governance/reviewer_ops domains so platform-
          internal degradations don't poison the operator-facing surface. */}
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

      {/* A. Operational Summary Strip */}
      <SummaryStrip section={sections.summary} role={role} isTeam={isTeam} />

      <div className="cc-grid-2col">
        {/* B. Attention Queue (left, prominent) */}
        <AttentionQueue section={sections.attentionQueue} />

        {/* H. Quick Actions (right, sticky) */}
        <QuickActions role={role} isTeam={isTeam} canMutate={canMutate} />
      </div>

      <div className="cc-grid-2col">
        {/* C. Recent Evidence Activity */}
        <RecentEvidenceSection section={sections.recentEvidence} />

        {/* D. Pipeline Readiness */}
        <PipelineSection section={sections.pipeline} />
      </div>

      <div className="cc-grid-2col">
        {/* E. Reviewer / Case Workload (team-only) */}
        <ReviewerWorkloadSection section={sections.reviewerWorkload} />

        {/* F. Governance Posture (team-only) */}
        <GovernancePostureSection section={sections.governancePosture} />
      </div>

      {/* Incidents block — sourced from real operational incidents.
          Visible to all roles but read-only here; clicking through
          surfaces details under /ops/runbooks or /ops/observability. */}
      <IncidentsSection section={sections.incidents} />

    </main>
  );
}

// ---------------------------------------------------------------------------
// Section A — Operational Summary Strip
// ---------------------------------------------------------------------------

function SummaryStrip({
  section,
  role: _role,
  isTeam,
}: {
  section: CommandCenterEnvelope["sections"]["summary"];
  role: string;
  isTeam: boolean;
}) {
  if (section.status !== "ok" || !section.data) {
    return (
      <SectionShell title="Operational Summary">
        <SectionStatusNote status={section.status} kind="summary" />
      </SectionShell>
    );
  }
  const d = section.data;
  const cards: Array<{
    label: string;
    value: number;
    href: string;
    visible: boolean;
  }> = [
    { label: "Active evidence", value: d.evidenceActiveCount, href: "/evidence", visible: true },
    { label: "Recent (7d)", value: d.evidenceRecentCount, href: "/evidence", visible: true },
    { label: "Reports ready", value: d.reportReadyCount, href: "/reports", visible: true },
    {
      label: "Pending review",
      value: d.reviewerPendingCount,
      href: "/reviewer-ops",
      visible: isTeam,
    },
    {
      label: "Governance attention",
      value: d.governanceAttentionCount,
      href: "/governance",
      visible: isTeam,
    },
    {
      label: "Open incidents",
      value: d.openIncidentsCount,
      href: "/ops/observability",
      visible: true,
    },
  ];
  return (
    <SectionShell title="Operational Summary" sectionId="summary">
      <div className="cc-summary-strip" data-cc-summary>
        {cards
          .filter((c) => c.visible)
          .map((c) => (
            <Link
              key={c.label}
              href={c.href}
              className="cc-summary-card"
              data-cc-summary-key={c.label}
            >
              <span className="cc-summary-card-value" data-cc-summary-value>
                {c.value}
              </span>
              <span className="cc-summary-card-label">{c.label}</span>
            </Link>
          ))}
      </div>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Section B — Attention Queue
// ---------------------------------------------------------------------------

function AttentionQueue({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["attentionQueue"];
}) {
  if (section.status === "unavailable") {
    return (
      <SectionShell title="Attention Queue" sectionId="attention">
        <SectionStatusNote status="unavailable" kind="attention" />
      </SectionShell>
    );
  }
  if (section.items.length === 0) {
    return (
      <SectionShell title="Attention Queue" sectionId="attention">
        <OperationalEmptyState
          emptyStateCode="no_attention_items"
          kicker="Attention queue"
          title="Nothing needs attention right now."
          reason="No overdue reviews, open escalations, governance holds, or high-severity incidents on this workspace."
        />
        {section.status === "degraded" ? (
          <SectionStatusNote status="degraded" kind="attention" />
        ) : null}
      </SectionShell>
    );
  }
  return (
    <SectionShell
      title={`Attention Queue · ${section.items.length}`}
      sectionId="attention"
    >
      <ul className="cc-attention-list" data-cc-attention-list>
        {section.items.map((item) => (
          <li
            key={item.id}
            className="cc-attention-row"
            data-cc-attention-severity={item.severity}
            data-cc-attention-category={item.category}
          >
            <span
              className="cc-attention-dot"
              data-cc-severity-dot={item.severity}
            />
            <div className="cc-attention-body">
              <Link href={item.href} className="cc-attention-title">
                {item.title}
              </Link>
              {item.subtitle ? (
                <div className="cc-attention-subtitle">{item.subtitle}</div>
              ) : null}
            </div>
            {item.occurredAt ? (
              <time
                className="cc-attention-time"
                dateTime={item.occurredAt}
                title={item.occurredAt}
              >
                {formatRelativeTime(item.occurredAt)}
              </time>
            ) : null}
          </li>
        ))}
      </ul>
      {section.status === "degraded" ? (
        <SectionStatusNote status="degraded" kind="attention" />
      ) : null}
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Section C — Recent Evidence Activity
// ---------------------------------------------------------------------------

function RecentEvidenceSection({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["recentEvidence"];
}) {
  if (section.status === "unavailable") {
    return (
      <SectionShell title="Recent Evidence" sectionId="recent">
        <SectionStatusNote status="unavailable" kind="recent" />
      </SectionShell>
    );
  }
  if (section.items.length === 0) {
    return (
      <SectionShell title="Recent Evidence" sectionId="recent">
        <OperationalEmptyState
          emptyStateCode="no_recent_evidence"
          kicker="Recent evidence"
          title="No recent evidence."
          reason="Capture or upload to populate the activity stream."
          actions={[
            {
              label: "Capture evidence",
              href: "/capture",
            },
          ]}
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell title="Recent Evidence" sectionId="recent">
      <ul className="cc-evidence-list" data-cc-recent-list>
        {section.items.map((item) => (
          <li key={item.id} className="cc-evidence-row" data-cc-recent-id={item.id}>
            <Link href={`/evidence/${item.id}`} className="cc-evidence-link">
              <div className="cc-evidence-row-main">
                <span className="cc-evidence-title">{item.title}</span>
                <span
                  className="cc-evidence-status"
                  data-cc-evidence-status={item.status}
                >
                  {humanizeStatus(item.status)}
                </span>
              </div>
              <div className="cc-evidence-row-meta">
                <time dateTime={item.createdAt}>
                  {formatRelativeTime(item.createdAt)}
                </time>
                {item.verificationStatus ? (
                  <span data-cc-evidence-verification={item.verificationStatus}>
                    {humanizeStatus(item.verificationStatus)}
                  </span>
                ) : null}
                {item.caseId ? (
                  <span data-cc-evidence-case={item.caseId}>
                    Case #{item.caseId.slice(0, 6)}
                  </span>
                ) : null}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Section D — Pipeline Readiness
// ---------------------------------------------------------------------------

function PipelineSection({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["pipeline"];
}) {
  if (section.status !== "ok" || !section.data) {
    return (
      <SectionShell title="Pipeline Readiness" sectionId="pipeline">
        <SectionStatusNote status={section.status} kind="pipeline" />
      </SectionShell>
    );
  }
  const d = section.data;
  const total = d.created + d.uploading + d.uploaded + d.signed + d.reported;
  const stages = [
    { key: "created", label: "Created", value: d.created },
    { key: "uploading", label: "Uploading", value: d.uploading },
    { key: "uploaded", label: "Uploaded", value: d.uploaded },
    { key: "signed", label: "Signed", value: d.signed },
    { key: "reported", label: "Report ready", value: d.reported },
  ];
  return (
    <SectionShell title="Pipeline Readiness" sectionId="pipeline">
      <div className="cc-pipeline-strip" data-cc-pipeline>
        {stages.map((s) => (
          <div
            key={s.key}
            className="cc-pipeline-stage"
            data-cc-pipeline-stage={s.key}
          >
            <span className="cc-pipeline-value">{s.value}</span>
            <span className="cc-pipeline-label">{s.label}</span>
          </div>
        ))}
      </div>
      <div className="cc-pipeline-meta">
        {total === 0
          ? "No evidence in the pipeline yet."
          : `${total} record${total === 1 ? "" : "s"} across all stages.`}
      </div>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Section E — Reviewer / Case Workload
// ---------------------------------------------------------------------------

function ReviewerWorkloadSection({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["reviewerWorkload"];
}) {
  if (section.status === "not_applicable") {
    return (
      <SectionShell title="Reviewer Workload" sectionId="reviewer-workload">
        <PersonalScopeNote subsystem="reviewer" />
      </SectionShell>
    );
  }
  if (section.status !== "ok" || !section.data) {
    return (
      <SectionShell title="Reviewer Workload" sectionId="reviewer-workload">
        <SectionStatusNote status={section.status} kind="reviewer" />
      </SectionShell>
    );
  }
  const d = section.data;
  const tiles = [
    { label: "Queued", value: d.queuedCount, href: "/reviewer-ops" },
    { label: "Assigned", value: d.assignedCount, href: "/reviewer-ops" },
    { label: "In review", value: d.inReviewCount, href: "/reviewer-ops" },
    {
      label: "Overdue",
      value: d.overdueCount,
      href: "/reviewer-ops/sla",
      severe: true,
    },
    {
      label: "Open escalations",
      value: d.openEscalationsCount,
      href: "/reviewer-ops/escalations",
      severe: true,
    },
  ];
  return (
    <SectionShell title="Reviewer Workload" sectionId="reviewer-workload">
      <div className="cc-tile-grid" data-cc-reviewer-tiles>
        {tiles.map((t) => (
          <Link
            key={t.label}
            href={t.href}
            className="cc-tile"
            data-cc-tile-key={t.label}
            data-cc-tile-severe={t.severe ? "true" : "false"}
          >
            <span className="cc-tile-value">{t.value}</span>
            <span className="cc-tile-label">{t.label}</span>
          </Link>
        ))}
      </div>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Section F — Governance Posture
// ---------------------------------------------------------------------------

function GovernancePostureSection({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["governancePosture"];
}) {
  if (section.status === "not_applicable") {
    return (
      <SectionShell title="Governance Posture" sectionId="governance-posture">
        <PersonalScopeNote subsystem="governance" />
      </SectionShell>
    );
  }
  if ((section.status !== "ok" && section.status !== "degraded") || !section.data) {
    return (
      <SectionShell title="Governance Posture" sectionId="governance-posture">
        <SectionStatusNote status={section.status} kind="governance" />
      </SectionShell>
    );
  }
  const d = section.data;
  const tiles = [
    {
      label: "Active legal holds",
      value: d.activeLegalHoldsCount,
      href: "/governance",
    },
    {
      label: "Case-level holds",
      value: d.activeCaseLegalHoldsCount,
      href: "/governance",
    },
    {
      label: "Retention candidates",
      value: d.retentionCandidatesCount,
      href: "/governance/retention",
    },
    {
      label: "Pending destruction",
      value: d.pendingDestructionReviewsCount,
      href: "/governance/destruction",
    },
    {
      label: "Active policies",
      value: d.activePoliciesCount,
      href: "/governance/policy",
    },
    {
      label: "Policy conflicts",
      value: d.policyConflictsCount,
      href: "/governance/policy",
      severe: true,
    },
  ];
  return (
    <SectionShell title="Governance Posture" sectionId="governance-posture">
      <div className="cc-tile-grid" data-cc-governance-tiles>
        {tiles.map((t) => (
          <Link
            key={t.label}
            href={t.href}
            className="cc-tile"
            data-cc-tile-key={t.label}
            data-cc-tile-severe={t.severe ? "true" : "false"}
          >
            <span className="cc-tile-value">{t.value}</span>
            <span className="cc-tile-label">{t.label}</span>
          </Link>
        ))}
      </div>
      {section.status === "degraded" ? (
        <SectionStatusNote status="degraded" kind="governance" />
      ) : null}
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Incidents (real operational incidents on this workspace)
// ---------------------------------------------------------------------------

function IncidentsSection({
  section,
}: {
  section: CommandCenterEnvelope["sections"]["incidents"];
}) {
  if (section.status === "unavailable") {
    return (
      <SectionShell title="Operational Incidents" sectionId="incidents">
        <SectionStatusNote status="unavailable" kind="incidents" />
      </SectionShell>
    );
  }
  if (section.items.length === 0) {
    return (
      <SectionShell title="Operational Incidents" sectionId="incidents">
        <OperationalEmptyState
          emptyStateCode="no_open_incidents"
          kicker="Operational incidents"
          title="No open operational incidents."
          reason="Detailed platform health lives under Operations Center."
          actions={[
            {
              label: "Open observability",
              href: "/ops/observability",
            },
          ]}
        />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      title={`Operational Incidents · ${section.items.length}`}
      sectionId="incidents"
    >
      <ul className="cc-incident-list" data-cc-incidents-list>
        {section.items.map((i) => (
          <li
            key={i.id}
            className="cc-incident-row"
            data-cc-incident-severity={i.severity}
            data-cc-incident-status={i.status}
          >
            <div className="cc-incident-row-main">
              <span className="cc-incident-title">{i.title}</span>
              <span className="cc-incident-meta">
                {i.category} · {i.severity} · {i.status}
              </span>
            </div>
            <div className="cc-incident-summary">{i.safeSummary}</div>
            <div className="cc-incident-row-foot">
              {i.runbookSlug ? (
                <Link href={`/ops/runbooks#${i.runbookSlug}`}>
                  Runbook → {i.runbookSlug}
                </Link>
              ) : (
                <Link href="/ops/observability">Open observability</Link>
              )}
              <time dateTime={i.lastSeenAtUtc}>
                Seen {formatRelativeTime(i.lastSeenAtUtc)}
              </time>
            </div>
          </li>
        ))}
      </ul>
      <div className="cc-section-foot">
        Detailed platform health lives under <Link href="/ops">Operations Center</Link>.
      </div>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Section H — Quick Actions (role/workspace-aware)
// ---------------------------------------------------------------------------

function QuickActions({
  role,
  isTeam,
  canMutate,
}: {
  role: string;
  isTeam: boolean;
  canMutate: boolean;
}) {
  // Each action carries the role/scope it requires. Filtering happens
  // client-side; backend permissions remain authoritative on the
  // target surfaces.
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
    {
      id: "evidence",
      label: "Open evidence library",
      href: "/evidence",
      visible: true,
    },
    {
      id: "cases",
      label: "Create case",
      href: "/cases",
      visible: canMutate,
    },
    {
      id: "reviewer-ops",
      label: "Review queue",
      href: "/reviewer-ops",
      visible: isTeam,
    },
    {
      id: "reports",
      label: "Open reports",
      href: "/reports",
      visible: true,
    },
    {
      id: "governance",
      label: "Governance hub",
      href: "/governance",
      visible: isTeam && (role === "OWNER" || role === "ADMIN" || role === "MEMBER"),
    },
  ];
  return (
    <SectionShell title="Quick Actions" sectionId="quick-actions">
      <div className="cc-quick-grid" data-cc-quick-actions>
        {actions
          .filter((a) => a.visible)
          .map((a) => (
            <Link
              key={a.id}
              href={a.href}
              className={`cc-quick-action ${a.primary ? "is-primary" : ""}`}
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
  title,
  sectionId,
  children,
}: {
  title: string;
  /** Bounded section id used by source-contract tests + telemetry. */
  sectionId?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="cc-section" data-cc-section={sectionId}>
      <header className="cc-section-header">
        <h2 className="cc-section-title">{title}</h2>
      </header>
      <div className="cc-section-body">{children}</div>
    </section>
  );
}

function SectionStatusNote({
  status,
  kind,
}: {
  status: SectionStatus;
  kind: string;
}) {
  if (status === "ok") return null;
  const copy =
    status === "degraded"
      ? "This section returned partial data. Some metrics may be missing."
      : status === "unavailable"
        ? "This section is temporarily unavailable. Retry shortly."
        : "Not applicable for this workspace.";
  return (
    <div
      className="cc-section-note"
      data-cc-section-status={status}
      data-cc-section-kind={kind}
    >
      {copy}
    </div>
  );
}

function PersonalScopeNote({ subsystem }: { subsystem: "reviewer" | "governance" }) {
  return (
    <div
      className="cc-section-note"
      data-cc-personal-scope={subsystem}
      data-cc-section-status="not_applicable"
    >
      Personal workspace uses basic evidence controls. {subsystem === "reviewer"
        ? "Reviewer queues are a team workspace feature."
        : "Governance posture is a team workspace feature."}
    </div>
  );
}

function CommandCenterLoading() {
  return (
    <main className="cc-page" data-command-center-loading>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Command Center</div>
          <h1 className="cc-title">Evidence Operations</h1>
        </div>
      </header>
      <SectionShell title="Loading workspace…">
        <div className="cc-skeleton" />
      </SectionShell>
    </main>
  );
}

function NoWorkspaceState() {
  return (
    <main className="cc-page" data-command-center-empty>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Command Center</div>
          <h1 className="cc-title">No workspace selected</h1>
          <p className="cc-subtitle">
            Switch to a workspace to use the command center. Personal capture is
            still available below.
          </p>
        </div>
      </header>
      <SectionShell title="Get started">
        <div className="cc-quick-grid">
          <Link href="/teams" className="cc-quick-action is-primary">
            Create or join a workspace
          </Link>
          <Link href="/capture" className="cc-quick-action">
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
    <main className="cc-page" data-command-center-auth-error>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Command Center</div>
          <h1 className="cc-title">
            {code === "auth_required"
              ? "Sign in required"
              : "Permission required"}
          </h1>
          <p className="cc-subtitle">
            {code === "auth_required"
              ? "Sign in to view this workspace."
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
    <main className="cc-page" data-command-center-error>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Command Center</div>
          <h1 className="cc-title">Temporarily unavailable</h1>
          <p className="cc-subtitle">{message}</p>
          {requestId ? (
            <p className="cc-subtitle">Request ID: {requestId}</p>
          ) : null}
        </div>
      </header>
    </main>
  );
}

function humanizeStatus(s: string): string {
  return s
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const now = Date.now();
  const diff = now - t;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

