"use client";

/**
 * Phase 32.8E — Reviewer Orchestration & Escalation Command.
 *
 * Renders the workspace-level review-ops summary on top of (and
 * replacing) the previous bespoke /reviewer-ops console. Sourced
 * from `/v1/reviewer-ops/command` — a single read-only envelope
 * with per-section status.
 *
 * Out of scope here:
 *   - Per-workflow inspector + mutation actions (start / pause /
 *     approve / reject / escalate / reassign) — they continue to
 *     live on the existing /reviewer-ops/[reviewId] detail route
 *     and on the audited POST /v1/reviewer-ops/* endpoints. This
 *     orchestration console is a triage surface, not a mutation
 *     surface.
 *   - SLA configuration UI — `/governance/policy`.
 *   - Per-reviewer drill-down — link to /reviewer-ops/sla.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import { useActiveWorkspaceId } from "../../lib/useActiveWorkspaceId";
import { RuntimeStatusBanner } from "../operational";
import type { ReviewerCommandEnvelope, SectionStatus } from "./types";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; envelope: ReviewerCommandEnvelope }
  | { status: "no_workspace" }
  | { status: "auth_error"; code: "auth_required" | "permission_denied" }
  | { status: "unavailable"; message: string };

export function ReviewerCommandConsole() {
  const workspace = useActiveWorkspaceId();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(async () => {
    if (workspace.status !== "ready") return;
    setState({ status: "loading" });
    try {
      const envelope = (await apiFetch(
        `/v1/reviewer-ops/command?teamId=${encodeURIComponent(workspace.workspaceId)}`,
        { method: "GET" },
      )) as ReviewerCommandEnvelope;
      setState({ status: "ready", envelope });
    } catch (err) {
      const e = err as { message?: string; statusCode?: number };
      if (e.statusCode === 401)
        setState({ status: "auth_error", code: "auth_required" });
      else if (e.statusCode === 403)
        setState({ status: "auth_error", code: "permission_denied" });
      else
        setState({
          status: "unavailable",
          message: e.message ?? "Unable to load reviewer command center.",
        });
    }
  }, [workspace.status, workspace.status === "ready" ? workspace.workspaceId : null]);

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
      setState({
        status:
          workspace.code === "auth_required" || workspace.code === "permission_denied"
            ? "auth_error"
            : "unavailable",
        code:
          workspace.code === "permission_denied"
            ? "permission_denied"
            : "auth_required",
        message: workspace.message,
      } as LoadState);
      return;
    }
    void load();
  }, [workspace.status, workspace.status === "ready" ? workspace.workspaceId : null, load]);

  if (state.status === "loading") return <ShellLoading />;
  if (state.status === "no_workspace") return <ShellNoWorkspace />;
  if (state.status === "auth_error")
    return <ShellAuthError code={state.code} />;
  if (state.status === "unavailable")
    return <ShellUnavailable message={state.message} />;

  const env = state.envelope;
  const isTeam = env.workspace.scope === "TEAM";

  return (
    <main className="cc-page" data-reviewer-command>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Review Orchestration · Escalation Command</div>
          <h1 className="cc-title">Reviewer Ops</h1>
          <p className="cc-subtitle">
            Triage queue, SLA pressure, and open escalations for the workspace.
            Reviewer actions live on the per-workflow inspector pages — this
            console is a read-only triage surface.
          </p>
        </div>
        <div className="cc-meta">
          <span data-reviewer-scope={env.workspace.scope}>
            {env.workspace.scope === "PERSONAL"
              ? "Personal workspace"
              : "Team workspace"}
          </span>
          <span data-reviewer-role={env.workspace.role}>
            Role: {env.workspace.role}
          </span>
          <span title={env.generatedAt}>Refreshed {relTime(env.generatedAt)}</span>
        </div>
      </header>

      {/* Phase 32.7 — runtime banner scoped to reviewer_ops so platform-
          internal degradations don't poison the operator view. */}
      <RuntimeStatusBanner
        teamId={env.workspace.id}
        forDomains={["reviewer_ops"]}
      />

      {/* Phase 32.8C FINAL-3 — capability degradation rather than page
          hiding. Personal workspace renders the same surface; team-only
          sections render disabled with a clear "Requires team workspace"
          label. The page never early-returns a plain text fallback. */}
      {!isTeam ? (
        <div
          className="cc-section-note"
          data-reviewer-personal-banner
          data-cc-section-status="not_applicable"
          role="status"
        >
          Personal workspace — reviewer orchestration sections render in
          read-only enterprise-lite mode. Team-only actions (escalation
          ownership, reviewer policy editing, bulk reassignment) are
          disabled with clear labels. Switch to a team workspace to enable
          the full reviewer command surface.
        </div>
      ) : null}
      <SummarySection env={env} />
      <div className="cc-grid-2col">
        <QueuePeekSection env={env} />
        <EscalationsSection env={env} />
      </div>
      <div className="cc-grid-2col">
        <WorkloadSection env={env} />
        <PolicySection env={env} />
      </div>
      <ReconciliationSection env={env} />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Summary section
// ---------------------------------------------------------------------------

function SummarySection({ env }: { env: ReviewerCommandEnvelope }) {
  const s = env.sections.summary;
  if (s.status !== "ok" || !s.data) {
    return (
      <section className="cc-section" data-reviewer-section="summary">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Review Operations Summary</h2>
        </header>
        <SectionNote status={s.status} kind="summary" />
      </section>
    );
  }
  const d = s.data;
  const tiles = [
    {
      key: "assigned_to_me",
      label: "Assigned to me",
      value: d.assignedToMe,
      href: "/reviewer-ops",
    },
    { key: "unassigned", label: "Unassigned", value: d.unassigned, href: "/reviewer-ops" },
    {
      key: "in_review",
      label: "In review",
      value: d.inReview,
      href: "/reviewer-ops",
    },
    {
      key: "due_soon",
      label: "Due in 24h",
      value: d.dueSoon,
      href: "/reviewer-ops/sla",
    },
    {
      key: "overdue",
      label: "Overdue",
      value: d.overdue,
      severe: d.overdue > 0,
      href: "/reviewer-ops/sla",
    },
    {
      key: "open_escalations",
      label: "Open escalations",
      value: d.openEscalations,
      severe: d.openEscalations > 0,
      href: "/reviewer-ops/escalations",
    },
  ];
  return (
    <section className="cc-section" data-reviewer-section="summary">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Review Operations Summary</h2>
      </header>
      <div className="cc-summary-strip" data-reviewer-summary-tiles>
        {tiles.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            className="cc-summary-card"
            data-reviewer-summary-tile={t.key}
            data-cc-tile-severe={t.severe ? "true" : "false"}
          >
            <span className="cc-summary-card-value">{t.value}</span>
            <span className="cc-summary-card-label">{t.label}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Queue peek section
// ---------------------------------------------------------------------------

function QueuePeekSection({ env }: { env: ReviewerCommandEnvelope }) {
  const q = env.sections.queuePeek;
  if (q.status === "unavailable") {
    return (
      <section className="cc-section" data-reviewer-section="queue-peek">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Queue (top 10)</h2>
        </header>
        <SectionNote status="unavailable" kind="queue" />
      </section>
    );
  }
  if (q.items.length === 0) {
    return (
      <section className="cc-section" data-reviewer-section="queue-peek">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Queue (top 10)</h2>
        </header>
        <div className="cc-section-note">
          No open review workflows in this workspace.
        </div>
      </section>
    );
  }
  return (
    <section className="cc-section" data-reviewer-section="queue-peek">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Queue (top 10)</h2>
      </header>
      <ul className="cases-list" data-reviewer-queue-items>
        {q.items.map((row) => (
          <li
            key={row.workflowId}
            className="cases-row"
            data-reviewer-workflow-id={row.workflowId}
            data-reviewer-sla-tone={row.slaTone}
          >
            <Link
              href={`/reviewer-ops/${encodeURIComponent(row.workflowId)}`}
              className="cases-row-link"
            >
              <div className="cases-row-main">
                <span className="cases-row-title">
                  Workflow {row.workflowId.slice(0, 8)}
                </span>
                <span
                  className="cases-row-scope"
                  data-reviewer-status={row.status}
                >
                  {row.status}
                </span>
              </div>
              <div className="cases-row-meta">
                <span data-reviewer-priority={row.priority}>{row.priority}</span>
                {row.assignedToUserId ? (
                  <span>Assigned to {row.assignedToUserId.slice(0, 8)}</span>
                ) : (
                  <span>Unassigned</span>
                )}
                {row.dueAt ? (
                  <time dateTime={row.dueAt} data-reviewer-due-at={row.slaTone}>
                    {row.slaTone === "overdue"
                      ? "Overdue"
                      : row.slaTone === "due_soon"
                        ? "Due soon"
                        : `Due ${relTime(row.dueAt)}`}
                  </time>
                ) : null}
              </div>
            </Link>
          </li>
        ))}
      </ul>
      <div className="cc-section-foot">
        Full queue lives at <Link href="/reviewer-ops/sla">SLA workspace</Link>.
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Escalations section
// ---------------------------------------------------------------------------

function EscalationsSection({ env }: { env: ReviewerCommandEnvelope }) {
  const e = env.sections.escalations;
  if (e.status === "unavailable") {
    return (
      <section className="cc-section" data-reviewer-section="escalations">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Escalation Command</h2>
        </header>
        <SectionNote status="unavailable" kind="escalations" />
      </section>
    );
  }
  if (e.items.length === 0) {
    return (
      <section className="cc-section" data-reviewer-section="escalations">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Escalation Command</h2>
        </header>
        <div className="cc-section-note">No open escalations.</div>
      </section>
    );
  }
  return (
    <section className="cc-section" data-reviewer-section="escalations">
      <header className="cc-section-header">
        <h2 className="cc-section-title">
          Escalation Command · {e.items.length}
        </h2>
      </header>
      <ul className="cases-list" data-reviewer-escalation-items>
        {e.items.map((row) => (
          <li
            key={row.id}
            className="cases-row"
            data-reviewer-escalation-id={row.id}
            data-reviewer-escalation-severity={row.severity}
          >
            <Link
              href={`/reviewer-ops/escalations`}
              className="cases-row-link"
            >
              <div className="cases-row-main">
                <span className="cases-row-title">{humanize(row.reason)}</span>
                <span className="cases-row-scope">{row.severity}</span>
              </div>
              <div className="cases-row-meta">
                <span>Workflow {row.workflowId.slice(0, 8)}</span>
                {row.evidenceId ? (
                  <span>Evidence {row.evidenceId.slice(0, 8)}</span>
                ) : null}
                <time dateTime={row.createdAt}>
                  Opened {relTime(row.createdAt)}
                </time>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Workload section
// ---------------------------------------------------------------------------

function WorkloadSection({ env }: { env: ReviewerCommandEnvelope }) {
  const w = env.sections.workload;
  if (w.status === "unavailable") {
    return (
      <section className="cc-section" data-reviewer-section="workload">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Reviewer Workload</h2>
        </header>
        <SectionNote status="unavailable" kind="workload" />
      </section>
    );
  }
  if (w.reviewers.length === 0) {
    return (
      <section className="cc-section" data-reviewer-section="workload">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Reviewer Workload</h2>
        </header>
        <div className="cc-section-note">
          Workload snapshot unavailable — no reviewers currently assigned.
        </div>
      </section>
    );
  }
  return (
    <section className="cc-section" data-reviewer-section="workload">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Reviewer Workload</h2>
      </header>
      <ul className="cases-list" data-reviewer-workload-items>
        {w.reviewers.map((r) => (
          <li
            key={r.userId}
            className="cases-row"
            data-reviewer-workload-user={r.userId}
          >
            <div className="cases-row-link">
              <div className="cases-row-main">
                <span className="cases-row-title">
                  {r.displayName ?? r.email ?? r.userId.slice(0, 8)}
                </span>
                <span
                  className="cases-row-scope"
                  data-cc-tile-severe={r.overdueCount > 0 ? "true" : "false"}
                >
                  {r.assignedCount} assigned
                </span>
              </div>
              <div className="cases-row-meta">
                {r.overdueCount > 0 ? (
                  <span data-reviewer-workload-overdue="true">
                    {r.overdueCount} overdue
                  </span>
                ) : (
                  <span>On track</span>
                )}
                {r.email ? <span>{r.email}</span> : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Policy summary section
// ---------------------------------------------------------------------------

function PolicySection({ env }: { env: ReviewerCommandEnvelope }) {
  const p = env.sections.workflowPolicy;
  if (p.status !== "ok" || !p.data) {
    return (
      <section className="cc-section" data-reviewer-section="policy">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Workflow Policy</h2>
        </header>
        <SectionNote status={p.status} kind="policy" />
      </section>
    );
  }
  const d = p.data;
  const rows = [
    {
      key: "review_due",
      label: "Default review due",
      value: d.defaultReviewDueHours ? `${d.defaultReviewDueHours} h` : "unset",
    },
    {
      key: "first_response_due",
      label: "First-response due",
      value: d.defaultFirstResponseDueHours
        ? `${d.defaultFirstResponseDueHours} h`
        : "unset",
    },
    {
      key: "step_up_approve",
      label: "Step-up · approve",
      value: d.requireStepUpForApprove ? "required" : "off",
    },
    {
      key: "step_up_reject",
      label: "Step-up · reject",
      value: d.requireStepUpForReject ? "required" : "off",
    },
    {
      key: "step_up_bulk",
      label: "Step-up · bulk",
      value: d.requireStepUpForBulk ? "required" : "off",
    },
    {
      key: "inactivity",
      label: "Inactivity threshold",
      value: d.reviewerInactivityHours
        ? `${d.reviewerInactivityHours} h`
        : "unset",
    },
  ];
  return (
    <section className="cc-section" data-reviewer-section="policy">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Workflow Policy</h2>
      </header>
      <ul className="governance-policy-summary" data-reviewer-policy-rows>
        {rows.map((r) => (
          <li
            key={r.key}
            className="governance-policy-row"
            data-reviewer-policy-row={r.key}
          >
            <span className="governance-policy-row-label">{r.label}</span>
            <span className="governance-policy-row-value">{r.value}</span>
          </li>
        ))}
      </ul>
      <div className="cc-section-foot">
        Source:{" "}
        <span data-reviewer-policy-source={d.slaPolicySource}>
          {d.slaPolicySource === "workspace_row"
            ? "workspace policy row"
            : "platform default"}
        </span>{" "}
        · Edit at <Link href="/governance/policy">Governance Policy</Link>.
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Reconciliation health section
// ---------------------------------------------------------------------------

function ReconciliationSection({ env }: { env: ReviewerCommandEnvelope }) {
  const r = env.sections.reconciliationHealth;
  if (r.status !== "ok" || !r.data) {
    return (
      <section className="cc-section" data-reviewer-section="reconciliation">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Reconciliation Health</h2>
        </header>
        <SectionNote status={r.status} kind="reconciliation" />
      </section>
    );
  }
  return (
    <section className="cc-section" data-reviewer-section="reconciliation">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Reconciliation Health</h2>
      </header>
      <div className="cc-tile-grid" data-reviewer-reconciliation-tiles>
        <div className="cc-tile" data-reviewer-reconciliation-tile="last_update">
          <span className="cc-tile-value">
            {r.data.lastWorkflowUpdateAtUtc
              ? relTime(r.data.lastWorkflowUpdateAtUtc)
              : "—"}
          </span>
          <span className="cc-tile-label">Last workflow update</span>
        </div>
        <div className="cc-tile" data-reviewer-reconciliation-tile="oldest_queued">
          <span className="cc-tile-value">
            {r.data.oldestQueuedAtUtc ? relTime(r.data.oldestQueuedAtUtc) : "—"}
          </span>
          <span className="cc-tile-label">Oldest queued</span>
        </div>
      </div>
      <div className="cc-section-foot">
        Worker health + cron status live at{" "}
        <Link href="/ops/observability">Operations · Observability</Link>.
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared shells + helpers
// ---------------------------------------------------------------------------

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
      ? "This section returned partial data."
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

function ShellLoading() {
  return (
    <main className="cc-page" data-reviewer-loading>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Review Orchestration · Escalation Command</div>
          <h1 className="cc-title">Loading reviewer ops…</h1>
        </div>
      </header>
      <section className="cc-section">
        <div className="cc-skeleton" />
      </section>
    </main>
  );
}

function ShellNoWorkspace() {
  return (
    <main className="cc-page" data-reviewer-no-workspace>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Review Orchestration · Escalation Command</div>
          <h1 className="cc-title">No workspace selected</h1>
          <p className="cc-subtitle">
            Select a workspace to view reviewer orchestration.
          </p>
        </div>
      </header>
    </main>
  );
}

function ShellAuthError({
  code,
}: {
  code: "auth_required" | "permission_denied";
}) {
  return (
    <main className="cc-page" data-reviewer-auth-error={code}>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Review Orchestration · Escalation Command</div>
          <h1 className="cc-title">
            {code === "auth_required" ? "Sign in required" : "Permission required"}
          </h1>
        </div>
      </header>
    </main>
  );
}

function ShellUnavailable({ message }: { message: string }) {
  return (
    <main className="cc-page" data-reviewer-unavailable>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Review Orchestration · Escalation Command</div>
          <h1 className="cc-title">Temporarily unavailable</h1>
          <p className="cc-subtitle">{message}</p>
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
