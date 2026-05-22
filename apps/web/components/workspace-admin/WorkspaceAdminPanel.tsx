"use client";

/**
 * Phase 32.8E — Enterprise Workspace Administration panel.
 *
 * Replaces the previous "team list" page. Renders workspace
 * overview, access/roles, role-permission matrix, governance
 * snapshot, integrations posture, billing/seat awareness, and
 * operational accountability — all from `/v1/teams/workspace-admin`.
 *
 * Hard rules:
 *   - Browse is side-effect-free. The aggregator emits no audit.
 *     The existing audited /v1/teams + /v1/teams/:id endpoints
 *     remain authoritative for "viewed-team" telemetry and for
 *     mutation actions (invite, role change, etc.) — this panel
 *     reads the workspace admin envelope only.
 *   - Personal workspace shows account-scope copy, not broken
 *     team admin widgets.
 *   - Viewer role hides invite/admin mutation CTAs.
 *   - Backend authorization remains authoritative.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import {
  usePlatformContext,
  useTeamWorkspaceGate,
} from "../../lib/platform-context";
import type { WorkspaceAdminEnvelope } from "./types";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; envelope: WorkspaceAdminEnvelope }
  | { status: "no_workspace" }
  | { status: "auth_error"; code: "auth_required" | "permission_denied" }
  | { status: "not_found" }
  | { status: "unavailable"; message: string };

type TabKey =
  | "overview"
  | "access"
  | "permissions"
  | "governance"
  | "integrations"
  | "billing"
  | "accountability";

export function WorkspaceAdminPanel() {
  const ctx = usePlatformContext();
  const workspace = useTeamWorkspaceGate();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [tab, setTab] = useState<TabKey>("overview");

  const load = useCallback(async () => {
    if (workspace.status !== "ready") return;
    setState({ status: "loading" });
    try {
      const envelope = (await apiFetch(
        `/v1/teams/workspace-admin?teamId=${encodeURIComponent(workspace.workspaceId)}`,
        { method: "GET" },
      )) as WorkspaceAdminEnvelope;
      setState({ status: "ready", envelope });
    } catch (err) {
      const e = err as { message?: string; statusCode?: number };
      if (e.statusCode === 404) setState({ status: "not_found" });
      else if (e.statusCode === 401)
        setState({ status: "auth_error", code: "auth_required" });
      else if (e.statusCode === 403)
        setState({ status: "auth_error", code: "permission_denied" });
      else
        setState({
          status: "unavailable",
          message: e.message ?? "Unable to load workspace administration.",
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
  if (state.status === "auth_error") return <ShellAuthError code={state.code} />;
  if (state.status === "not_found") return <ShellNotFound />;
  if (state.status === "unavailable")
    return <ShellUnavailable message={state.message} />;

  const env = state.envelope;
  // Phase 32.8 Foundation cleanup — capability-derived visibility.
  const isTeam = ctx.envelope?.flags.isTeamWorkspace === true;
  const canManage = ctx.can("TEAM_MANAGE");

  const tabs: Array<{ key: TabKey; label: string; visible: boolean }> = [
    { key: "overview", label: "Overview", visible: true },
    { key: "access", label: "Access & Roles", visible: true },
    { key: "permissions", label: "Role Matrix", visible: true },
    { key: "governance", label: "Governance Snapshot", visible: isTeam },
    { key: "integrations", label: "Integrations", visible: isTeam },
    { key: "billing", label: "Billing & Seats", visible: true },
    { key: "accountability", label: "Operational Accountability", visible: isTeam },
  ];

  return (
    <main className="cc-page" data-workspace-admin data-workspace-id={env.workspace.id}>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Workspace Administration</div>
          <h1 className="cc-title">{env.workspace.name}</h1>
          <p className="cc-subtitle">
            <span data-workspace-scope={env.workspace.scope}>
              {env.workspace.scope === "PERSONAL"
                ? "Personal workspace"
                : `Team workspace · ${env.workspace.memberCount} members · ${env.workspace.adminCount} admins`}
            </span>
            {" · "}
            <span data-workspace-role={env.workspace.role}>
              Role: {env.workspace.role}
            </span>
            {env.workspace.pendingInviteCount > 0 ? (
              <>
                {" · "}
                <span>
                  {env.workspace.pendingInviteCount} pending invite
                  {env.workspace.pendingInviteCount === 1 ? "" : "s"}
                </span>
              </>
            ) : null}
          </p>
        </div>
        <div className="cc-meta">
          <span data-workspace-plan={env.workspace.plan}>
            Plan: {env.workspace.plan}
          </span>
          <span data-workspace-billing-status={env.workspace.billingStatus}>
            Billing: {env.workspace.billingStatus}
          </span>
          <span title={env.generatedAt}>
            Refreshed {relTime(env.generatedAt)}
          </span>
        </div>
      </header>

      <nav className="case-tabs" role="tablist" aria-label="Workspace admin tabs">
        {tabs
          .filter((t) => t.visible)
          .map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`case-tab ${tab === t.key ? "is-active" : ""}`}
              onClick={() => setTab(t.key)}
              data-workspace-admin-tab={t.key}
            >
              {t.label}
            </button>
          ))}
      </nav>

      {tab === "overview" && (
        <OverviewTab env={env} isTeam={isTeam} canManage={canManage} />
      )}
      {tab === "access" && <AccessTab env={env} canManage={canManage} />}
      {tab === "permissions" && <RoleMatrixTab />}
      {tab === "governance" && isTeam && <GovernanceSnapshotTab env={env} />}
      {tab === "integrations" && isTeam && (
        <IntegrationsPostureTab env={env} canManage={canManage} />
      )}
      {tab === "billing" && <BillingTab env={env} canManage={canManage} />}
      {tab === "accountability" && isTeam && (
        <AccountabilityTab env={env} />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

function OverviewTab({
  env,
  isTeam,
  canManage,
}: {
  env: WorkspaceAdminEnvelope;
  isTeam: boolean;
  canManage: boolean;
}) {
  const ov = env.sections.overview;
  if (ov.status !== "ok" || !ov.data) {
    return (
      <section className="cc-section" data-tab-body="overview">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Overview</h2>
        </header>
        <SectionNote status={ov.status} kind="overview" />
      </section>
    );
  }
  const d = ov.data;
  return (
    <section className="cc-section" data-tab-body="overview">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Overview</h2>
      </header>
      <div className="cc-tile-grid" data-workspace-overview-tiles>
        <div className="cc-tile" data-workspace-overview-key="members">
          <span className="cc-tile-value">{env.workspace.memberCount}</span>
          <span className="cc-tile-label">Members</span>
        </div>
        <div className="cc-tile" data-workspace-overview-key="admins">
          <span className="cc-tile-value">{env.workspace.adminCount}</span>
          <span className="cc-tile-label">Admins / Owner</span>
        </div>
        <div className="cc-tile" data-workspace-overview-key="invites">
          <span className="cc-tile-value">
            {env.workspace.pendingInviteCount}
          </span>
          <span className="cc-tile-label">Pending invites</span>
        </div>
        <div className="cc-tile" data-workspace-overview-key="cases">
          <span className="cc-tile-value">{d.caseCount}</span>
          <span className="cc-tile-label">Cases</span>
        </div>
        <div className="cc-tile" data-workspace-overview-key="evidence">
          <span className="cc-tile-value">{d.evidenceCount}</span>
          <span className="cc-tile-label">Evidence records</span>
        </div>
      </div>
      <div className="cc-section-foot">
        Workspace owner:{" "}
        <span data-workspace-owner-email>{d.ownerEmail ?? d.ownerUserId.slice(0, 8)}</span>{" "}
        · Created {relTime(env.workspace.createdAt)}
        {isTeam && canManage ? (
          <>
            {" · "}
            <Link href="/billing">Manage billing</Link>
            {" · "}
            <Link href="/integrations">Manage integrations</Link>
          </>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Access & roles tab
// ---------------------------------------------------------------------------

function AccessTab({
  env,
  canManage,
}: {
  env: WorkspaceAdminEnvelope;
  canManage: boolean;
}) {
  const a = env.sections.access;
  if (a.status === "unavailable") {
    return (
      <section className="cc-section" data-tab-body="access">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Access & Roles</h2>
        </header>
        <SectionNote status="unavailable" kind="access" />
      </section>
    );
  }
  return (
    <section className="cc-section" data-tab-body="access">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Access & Roles · {a.members.length}</h2>
      </header>
      {a.members.length === 0 ? (
        <div className="cc-section-note">No active members.</div>
      ) : (
        <ul className="cases-list" data-workspace-members-list>
          {a.members.map((m) => (
            <li
              key={m.userId}
              className="cases-row"
              data-workspace-member-id={m.userId}
              data-workspace-member-role={m.role}
              data-workspace-member-status={m.status}
            >
              <div className="cases-row-link">
                <div className="cases-row-main">
                  <span className="cases-row-title">
                    {m.displayName ?? m.email ?? m.userId.slice(0, 8)}
                  </span>
                  <span
                    className="cases-row-scope"
                    data-workspace-member-role-chip={m.role}
                  >
                    {m.role}
                  </span>
                </div>
                <div className="cases-row-meta">
                  {m.email ? <span>{m.email}</span> : null}
                  <span data-workspace-member-status-chip={m.status}>
                    {m.status}
                  </span>
                  <span title={m.joinedAt}>
                    Joined {relTime(m.joinedAt)}
                  </span>
                  {m.lastSeenAtUtc ? (
                    <span title={m.lastSeenAtUtc}>
                      Last seen {relTime(m.lastSeenAtUtc)}
                    </span>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {a.invites.length > 0 ? (
        <>
          <header className="cc-section-header" style={{ marginTop: 12 }}>
            <h3 className="cc-section-title">
              Pending invites · {a.invites.length}
            </h3>
          </header>
          <ul className="cases-list" data-workspace-invites-list>
            {a.invites.map((i) => (
              <li
                key={i.id}
                className="cases-row"
                data-workspace-invite-id={i.id}
                data-workspace-invite-role={i.role}
              >
                <div className="cases-row-link">
                  <div className="cases-row-main">
                    <span className="cases-row-title">{i.email}</span>
                    <span className="cases-row-scope">{i.role}</span>
                  </div>
                  <div className="cases-row-meta">
                    <span title={i.createdAt}>
                      Invited {relTime(i.createdAt)}
                    </span>
                    <span title={i.expiresAt}>
                      Expires {relTime(i.expiresAt)}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {a.status === "degraded" ? (
        <SectionNote status="degraded" kind="access" />
      ) : null}

      {canManage ? (
        <div className="cc-section-foot">
          Member invite + role-change actions are performed on the legacy
          /teams/[id] surface (audited). This panel is read-only.
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Role permission matrix tab
// ---------------------------------------------------------------------------

function RoleMatrixTab() {
  // Bounded product-level role summary. This is NOT a complete
  // permission catalog — backend permissions remain authoritative.
  // The matrix mirrors the bounded role gates surfaced elsewhere in
  // the platform (workspace-profile.ts / governance role gates).
  const rows: Array<{
    capability: string;
    OWNER: "yes" | "no" | "partial";
    ADMIN: "yes" | "no" | "partial";
    MEMBER: "yes" | "no" | "partial";
    VIEWER: "yes" | "no" | "partial";
  }> = [
    { capability: "View workspace", OWNER: "yes", ADMIN: "yes", MEMBER: "yes", VIEWER: "yes" },
    { capability: "Capture evidence", OWNER: "yes", ADMIN: "yes", MEMBER: "yes", VIEWER: "no" },
    { capability: "Open / link cases", OWNER: "yes", ADMIN: "yes", MEMBER: "yes", VIEWER: "no" },
    { capability: "Review queue actions", OWNER: "yes", ADMIN: "yes", MEMBER: "partial", VIEWER: "no" },
    { capability: "Governance policy edit", OWNER: "yes", ADMIN: "yes", MEMBER: "no", VIEWER: "no" },
    { capability: "Legal hold place / release", OWNER: "yes", ADMIN: "yes", MEMBER: "no", VIEWER: "no" },
    { capability: "Retention / destruction review", OWNER: "yes", ADMIN: "yes", MEMBER: "no", VIEWER: "no" },
    { capability: "Manage team / invites", OWNER: "yes", ADMIN: "yes", MEMBER: "no", VIEWER: "no" },
    { capability: "Manage billing", OWNER: "yes", ADMIN: "yes", MEMBER: "no", VIEWER: "no" },
    { capability: "Manage integrations / API keys", OWNER: "yes", ADMIN: "yes", MEMBER: "no", VIEWER: "no" },
    { capability: "Download report / package", OWNER: "yes", ADMIN: "yes", MEMBER: "partial", VIEWER: "no" },
  ];
  return (
    <section className="cc-section" data-tab-body="permissions">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Role Permission Matrix</h2>
      </header>
      <div className="cc-section-foot">
        Product-level summary. Backend permissions remain authoritative —
        capabilities marked "partial" depend on workspace policy (step-up
        flags, governance gates, role grants).
      </div>
      <table className="workspace-permission-matrix" data-workspace-permission-matrix>
        <thead>
          <tr>
            <th>Capability</th>
            <th>OWNER</th>
            <th>ADMIN</th>
            <th>MEMBER</th>
            <th>VIEWER</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.capability} data-workspace-permission-row={r.capability}>
              <td>{r.capability}</td>
              <td data-permission-cell={r.OWNER}>{cellGlyph(r.OWNER)}</td>
              <td data-permission-cell={r.ADMIN}>{cellGlyph(r.ADMIN)}</td>
              <td data-permission-cell={r.MEMBER}>{cellGlyph(r.MEMBER)}</td>
              <td data-permission-cell={r.VIEWER}>{cellGlyph(r.VIEWER)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function cellGlyph(v: "yes" | "no" | "partial"): string {
  return v === "yes" ? "✓" : v === "partial" ? "~" : "—";
}

// ---------------------------------------------------------------------------
// Governance snapshot tab
// ---------------------------------------------------------------------------

function GovernanceSnapshotTab({ env }: { env: WorkspaceAdminEnvelope }) {
  const g = env.sections.governanceSnapshot;
  if (g.status !== "ok" || !g.data) {
    return (
      <section className="cc-section" data-tab-body="governance">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Governance Snapshot</h2>
        </header>
        <SectionNote status={g.status} kind="governance" />
      </section>
    );
  }
  const d = g.data;
  const tiles = [
    { key: "legal_holds", label: "Active legal holds", value: d.activeLegalHoldsCount },
    { key: "case_legal_holds", label: "Case-level holds", value: d.activeCaseLegalHoldsCount },
    { key: "retention_policies", label: "Active retention policies", value: d.retentionPoliciesCount },
    { key: "pending_destruction", label: "Pending destruction reviews", value: d.pendingDestructionCount },
  ];
  return (
    <section className="cc-section" data-tab-body="governance">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Governance Snapshot</h2>
      </header>
      <div className="cc-tile-grid" data-workspace-governance-tiles>
        {tiles.map((t) => (
          <div className="cc-tile" key={t.key} data-workspace-governance-tile={t.key}>
            <span className="cc-tile-value">{t.value}</span>
            <span className="cc-tile-label">{t.label}</span>
          </div>
        ))}
      </div>
      <div className="cc-section-foot">
        Policy source:{" "}
        <span data-workspace-policy-source={d.policySource}>
          {d.policySource === "workspace_row"
            ? "workspace policy row"
            : "platform default"}
        </span>{" "}
        · Report downloads:{" "}
        <span data-workspace-gate-report={d.allowReportDownload}>
          {d.allowReportDownload ? "allowed" : "blocked"}
        </span>{" "}
        · Package downloads:{" "}
        <span data-workspace-gate-package={d.allowPackageDownload}>
          {d.allowPackageDownload ? "allowed" : "blocked"}
        </span>{" "}
        · Public verify:{" "}
        <span data-workspace-gate-publicverify={d.allowPublicVerify}>
          {d.allowPublicVerify ? "allowed" : "blocked"}
        </span>
        {" · "}
        <Link href="/governance">Open governance control plane</Link>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Integrations posture tab
// ---------------------------------------------------------------------------

function IntegrationsPostureTab({
  env,
  canManage,
}: {
  env: WorkspaceAdminEnvelope;
  canManage: boolean;
}) {
  const i = env.sections.integrationsPosture;
  if (i.status !== "ok" || !i.data) {
    return (
      <section className="cc-section" data-tab-body="integrations">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Integrations Posture</h2>
        </header>
        <SectionNote status={i.status} kind="integrations" />
      </section>
    );
  }
  const d = i.data;
  return (
    <section className="cc-section" data-tab-body="integrations">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Integrations Posture</h2>
      </header>
      <div className="cc-tile-grid" data-workspace-integrations-tiles>
        <div className="cc-tile" data-workspace-integrations-tile="api_credentials">
          <span className="cc-tile-value">{d.apiCredentialsCount}</span>
          <span className="cc-tile-label">API credentials</span>
        </div>
        <div className="cc-tile" data-workspace-integrations-tile="webhooks">
          <span className="cc-tile-value">{d.webhookEndpointsCount}</span>
          <span className="cc-tile-label">Webhook endpoints</span>
        </div>
        <div
          className="cc-tile"
          data-workspace-integrations-tile="failed_deliveries"
          data-cc-tile-severe={d.recentFailedDeliveriesCount > 0 ? "true" : "false"}
        >
          <span className="cc-tile-value">{d.recentFailedDeliveriesCount}</span>
          <span className="cc-tile-label">Failed deliveries · 24h</span>
        </div>
      </div>
      <div className="cc-section-foot">
        Secrets are never surfaced here. {canManage ? (
          <Link href="/integrations">Manage in Integrations</Link>
        ) : (
          "Administrators can manage details in Integrations."
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Billing tab
// ---------------------------------------------------------------------------

function BillingTab({
  env,
  canManage,
}: {
  env: WorkspaceAdminEnvelope;
  canManage: boolean;
}) {
  const b = env.sections.billing;
  if (b.status !== "ok" || !b.data) {
    return (
      <section className="cc-section" data-tab-body="billing">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Billing & Seats</h2>
        </header>
        <SectionNote status={b.status} kind="billing" />
      </section>
    );
  }
  const d = b.data;
  return (
    <section className="cc-section" data-tab-body="billing">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Billing & Seats</h2>
      </header>
      <div className="cc-tile-grid" data-workspace-billing-tiles>
        <div className="cc-tile" data-workspace-billing-tile="plan">
          <span className="cc-tile-value">{d.plan}</span>
          <span className="cc-tile-label">Plan</span>
        </div>
        <div className="cc-tile" data-workspace-billing-tile="status">
          <span className="cc-tile-value">{d.status}</span>
          <span className="cc-tile-label">Billing status</span>
        </div>
        <div className="cc-tile" data-workspace-billing-tile="seats">
          <span className="cc-tile-value">
            {d.activeMembers} / {d.includedSeats || "—"}
          </span>
          <span className="cc-tile-label">Seats used</span>
        </div>
        <div
          className="cc-tile"
          data-workspace-billing-tile="over_seat"
          data-cc-tile-severe={d.overSeatLimit ? "true" : "false"}
        >
          <span className="cc-tile-value">{d.overSeatLimit ? "Yes" : "No"}</span>
          <span className="cc-tile-label">Over seat limit</span>
        </div>
      </div>
      <div className="cc-section-foot">
        {canManage ? (
          <Link href="/billing">Open billing</Link>
        ) : (
          "Administrators can adjust plan + seats in Billing."
        )}{" "}
        · This panel reads from the workspace billing row — it does not
        change billing state.
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Operational accountability tab
// ---------------------------------------------------------------------------

function AccountabilityTab({ env }: { env: WorkspaceAdminEnvelope }) {
  const a = env.sections.operationalAccountability;
  return (
    <section className="cc-section" data-tab-body="accountability">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Operational Accountability</h2>
      </header>
      {a.reviewerWorkload ? (
        <div className="cc-tile-grid" data-workspace-reviewer-workload-tiles>
          <div className="cc-tile" data-workspace-reviewer-tile="queued">
            <span className="cc-tile-value">{a.reviewerWorkload.queuedCount}</span>
            <span className="cc-tile-label">Queued</span>
          </div>
          <div className="cc-tile" data-workspace-reviewer-tile="assigned">
            <span className="cc-tile-value">{a.reviewerWorkload.assignedCount}</span>
            <span className="cc-tile-label">Assigned</span>
          </div>
          <div
            className="cc-tile"
            data-workspace-reviewer-tile="overdue"
            data-cc-tile-severe={a.reviewerWorkload.overdueCount > 0 ? "true" : "false"}
          >
            <span className="cc-tile-value">{a.reviewerWorkload.overdueCount}</span>
            <span className="cc-tile-label">Overdue</span>
          </div>
          <div
            className="cc-tile"
            data-workspace-reviewer-tile="escalations"
            data-cc-tile-severe={a.reviewerWorkload.openEscalationsCount > 0 ? "true" : "false"}
          >
            <span className="cc-tile-value">
              {a.reviewerWorkload.openEscalationsCount}
            </span>
            <span className="cc-tile-label">Open escalations</span>
          </div>
        </div>
      ) : null}
      {a.activities.length === 0 ? (
        <div className="cc-section-note">
          No recent team activity recorded yet.
        </div>
      ) : (
        <ul className="cases-activity-list" data-workspace-activity-list>
          {a.activities.map((row) => (
            <li
              key={row.id}
              className="cases-activity-row"
              data-workspace-activity-event={row.eventType}
            >
              <div className="cases-activity-main">
                <span className="cases-activity-event">{humanize(row.eventType)}</span>
                {row.actorUserId ? (
                  <span className="cases-activity-actor">
                    by {row.actorUserId.slice(0, 8)}
                  </span>
                ) : null}
                {row.targetType ? (
                  <span className="cases-activity-actor">
                    · {row.targetType}
                  </span>
                ) : null}
              </div>
              <time className="cases-activity-time" dateTime={row.createdAt}>
                {relTime(row.createdAt)}
              </time>
            </li>
          ))}
        </ul>
      )}
      {a.status === "degraded" ? (
        <SectionNote status="degraded" kind="accountability" />
      ) : null}
      <div className="cc-section-foot">
        Reviewer workload links to{" "}
        <Link href="/reviewer-ops">Reviewer Ops</Link>. Activity feed reads the
        workspace `team_activities` table — no audit emission on browse.
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
  status: "degraded" | "unavailable" | "not_applicable" | "ok";
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

function ShellLoading() {
  return (
    <main className="cc-page" data-workspace-admin-loading>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Workspace Administration</div>
          <h1 className="cc-title">Loading workspace…</h1>
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
    <main className="cc-page" data-workspace-admin-no-workspace>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Workspace Administration</div>
          <h1 className="cc-title">No workspace selected</h1>
          <p className="cc-subtitle">
            Switch to a workspace to administer it.
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
    <main className="cc-page" data-workspace-admin-auth-error={code}>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Workspace Administration</div>
          <h1 className="cc-title">
            {code === "auth_required" ? "Sign in required" : "Permission required"}
          </h1>
          <p className="cc-subtitle">
            {code === "auth_required"
              ? "Sign in to administer this workspace."
              : "You do not have permission to administer this workspace."}
          </p>
        </div>
      </header>
    </main>
  );
}

function ShellNotFound() {
  return (
    <main className="cc-page" data-workspace-admin-not-found>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Workspace Administration</div>
          <h1 className="cc-title">Workspace not found</h1>
        </div>
      </header>
    </main>
  );
}

function ShellUnavailable({ message }: { message: string }) {
  return (
    <main className="cc-page" data-workspace-admin-unavailable>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Workspace Administration</div>
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
