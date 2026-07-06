"use client";

/**
 * Phase 32.8E — Governance Control Plane.
 *
 * Replaces the previous widget-collection governance page with an
 * operational control-plane view sourced from
 * `/v1/governance/control-plane`. Surfaces posture, preservation,
 * retention/destruction, export governance, policy snapshot, and
 * governance-tagged incidents. No fabricated admin dashboard, no fabricated
 * charts, no legal admissibility claims.
 */

import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import {
  CapabilityDegradedPanel,
  useActiveSpaceId,
  useCan,
  usePersonaProfile,
  usePlatformContext,
  workflowFromPersona,
} from "../../lib/platform-context";
import { ContextualHelp } from "../contextual-help/ContextualHelp";
import { RuntimeStatusBanner } from "../operational";
import type { GovernanceControlPlaneEnvelope, SectionStatus } from "./types";

// CR1.6 — The legacy `no_workspace` LoadState branch was removed.
// PageRouteGate (governance.hub, ORGANIZATION_ONLY) gates entry and
// the in-component capability check (GOVERNANCE_VIEW) renders the
// canonical CapabilityDegradedPanel for personal users. The previous
// `ShellNoWorkspace` render was unreachable dead code.
type LoadState =
  | { status: "loading" }
  | { status: "ready"; envelope: GovernanceControlPlaneEnvelope }
  | { status: "auth_error"; code: "auth_required" | "permission_denied" }
  | { status: "unavailable"; message: string };

type TabKey =
  | "posture"
  | "preservation"
  | "retention"
  | "exports"
  | "policy"
  | "incidents";

export function GovernanceControlPlane() {
  const ctx = usePlatformContext();
  // Phase 38.15 — migrated off the legacy workspace-gate hook. The
  // /governance page is already wrapped in <PageRouteGate
  // routeId="governance.hub"> (ORGANIZATION_ONLY) so by the time
  // this component renders the actor has an active organization
  // workspace AND the GOVERNANCE_VIEW capability. We read the
  // active-space id directly; loading is a transient state.
  const teamId = useActiveSpaceId();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [tab, setTab] = useState<TabKey>("posture");
  // Phase 38.17 — workflow-aware contextual help.
  const governancePersona = usePersonaProfile();
  const governanceWorkflowCode = workflowFromPersona(
    governancePersona.primaryProfile,
  ).code;

  const load = useCallback(async () => {
    if (!teamId) return;
    setState({ status: "loading" });
    try {
      const envelope = (await apiFetch(
        `/v1/governance/control-plane?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as GovernanceControlPlaneEnvelope;
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
          message: toSafeUserError(e, { message: "Unable to load governance control plane." }).message,
        });
    }
  }, [teamId]);

  useEffect(() => {
    if (!teamId) {
      setState({ status: "loading" });
      return;
    }
    void load();
  }, [teamId, load]);

  // Phase 32.8 Foundation — canonical capability gate. Personal
  // workspaces (GOVERNANCE_VIEW = false) render the structured
  // CapabilityDegradedPanel instead of a plain-text fallback.
  if (ctx.envelope && !ctx.can("GOVERNANCE_VIEW")) {
    return (
      <main className="cc-page" data-governance-capability-degraded>
        <CapabilityDegradedPanel
          surface="Governance"
          requiredCapability="GOVERNANCE_VIEW"
          reason="Governance Control Plane oversees evidence preservation, retention, destruction, exports, and policy posture across a team. It activates when you switch into a team workspace."
          alternatives={[
            { label: "View your evidence", href: "/evidence" },
            { label: "Manage your cases", href: "/cases" },
            { label: "Review billing & plan", href: "/billing" },
          ]}
        />
      </main>
    );
  }

  if (state.status === "loading") return <ShellLoading />;
  if (state.status === "auth_error")
    return <ShellAuthError code={state.code} />;
  if (state.status === "unavailable")
    return <ShellUnavailable message={state.message} />;

  const env = state.envelope;
  // Phase 32.8 Foundation cleanup — visibility decisions read from
  // the canonical capability map, not from local role string equality.
  const isTeam = ctx.envelope?.flags.isTeamWorkspace === true;
  const isAdmin = ctx.can("GOVERNANCE_ACT");

  return (
    <main className="cc-page" data-governance-control-plane>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Compliance · Preservation · Retention</div>
          <h1 className="cc-title">Governance Control Plane</h1>
          <p className="cc-subtitle">
            Operational governance for evidence preservation, retention, and
            export. Preservation controls are workspace policy — they do not
            assert legal admissibility or authenticity of any record.
          </p>
        </div>
        <div className="cc-meta">
          <span data-governance-scope={env.workspace.scope}>
            {env.workspace.scope === "PERSONAL"
              ? "Personal workspace"
              : "Team workspace"}
          </span>
          <span data-governance-role={env.workspace.role}>
            Role: {env.workspace.role}
          </span>
          <span title={env.generatedAt}>Refreshed {relTime(env.generatedAt)}</span>
        </div>
      </header>

      {/* Phase 38.17 — workflow-aware contextual help, collapsed by
          default so the governance posture surface stays primary. */}
      <ContextualHelp
        workflow={governanceWorkflowCode}
        surface="governance"
        collapsedByDefault
      />

      {/* Phase 32.7 — runtime banner scoped to governance_lifecycle so
          platform-internal degradations don't poison the operator view. */}
      <RuntimeStatusBanner
        teamId={env.workspace.id}
        forDomains={["governance_lifecycle"]}
      />

      {/* Phase 32.8C FINAL-3 — capability degradation, not page hiding.
          Personal workspace renders an enterprise-lite governance surface.
          Team-only mutating actions (policy editing, hold approval,
          retention decisions) are gated at the route level via existing
          permission checks; the read surfaces remain accessible so an
          operator can see preservation posture in personal scope too. */}
      {!isTeam ? (
        <div
          className="cc-section-note"
          data-governance-personal-banner
          data-cc-section-status="not_applicable"
          role="status"
        >
          Personal workspace — governance surfaces render in read-only
          enterprise-lite mode. Team-only mutating actions (policy editing,
          hold approval, retention decisions, export governance) are
          disabled with clear labels. Switch to a team workspace to enable
          the full governance control plane.
        </div>
      ) : null}
      {(
        <>
          {/* Phase 32.8C FINAL-3 — tabs render for every workspace scope.
              Subsections handle their own status (ok / not_applicable) via
              the standard SectionStatus contract; team-only mutating
              actions are gated at the route level. */}
          <nav className="case-tabs" role="tablist" aria-label="Governance tabs">
            {(
              [
                ["posture", "Posture"],
                ["preservation", "Preservation"],
                ["retention", "Retention & Destruction"],
                ["exports", "Export Governance"],
                ["policy", "Policy"],
                ["incidents", "Incidents"],
              ] as Array<[TabKey, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className={`case-tab ${tab === key ? "is-active" : ""}`}
                onClick={() => setTab(key)}
                data-governance-tab={key}
              >
                {label}
              </button>
            ))}
          </nav>

          {tab === "posture" && <PostureTab env={env} />}
          {tab === "preservation" && <PreservationTab env={env} />}
          {tab === "retention" && <RetentionTab env={env} />}
          {tab === "exports" && <ExportTab env={env} />}
          {tab === "policy" && <PolicyTab env={env} isAdmin={isAdmin} />}
          {tab === "incidents" && <IncidentsTab env={env} />}
        </>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Posture tab
// ---------------------------------------------------------------------------

function PostureTab({ env }: { env: GovernanceControlPlaneEnvelope }) {
  const p = env.sections.posture;
  if (p.status !== "ok" || !p.data) {
    return (
      <section className="cc-section" data-tab-body="posture">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Posture</h2>
        </header>
        <SectionNote status={p.status} kind="posture" />
      </section>
    );
  }
  const d = p.data;
  const tiles = [
    {
      key: "evidence_holds",
      label: "Active legal holds",
      value: d.activeLegalHoldsCount,
    },
    {
      key: "case_holds",
      label: "Case-level holds",
      value: d.activeCaseLegalHoldsCount,
    },
    {
      key: "retention_candidates",
      label: "Retention candidates",
      value: d.retentionCandidatesCount,
    },
    {
      key: "pending_destruction",
      label: "Pending destruction reviews",
      value: d.pendingDestructionReviewsCount,
    },
    {
      key: "active_policies",
      label: "Active retention policies",
      value: d.activePoliciesCount,
    },
    {
      key: "policy_conflicts",
      label: "Policy conflicts",
      value: d.policyConflictsCount,
      severe: d.policyConflictsCount > 0,
    },
  ];
  return (
    <section className="cc-section" data-tab-body="posture">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Posture</h2>
      </header>
      <div className="cc-tile-grid" data-governance-posture-tiles>
        {tiles.map((t) => (
          <div
            className="cc-tile"
            key={t.key}
            data-governance-posture-tile={t.key}
            data-cc-tile-severe={t.severe ? "true" : "false"}
          >
            <span className="cc-tile-value">{t.value}</span>
            <span className="cc-tile-label">{t.label}</span>
          </div>
        ))}
      </div>
      <div className="cc-section-foot">
        Policy source:{" "}
        <span data-governance-policy-source={d.policySource}>
          {d.policySource === "workspace_row"
            ? "workspace policy row"
            : "platform default"}
        </span>
        {!d.caseLegalHoldsEnabled ? (
          <>
            {" · "}
            <span
              data-governance-case-holds-status="disabled"
              data-cc-section-status="degraded"
            >
              Case-level holds subsystem unavailable for this workspace.
            </span>
          </>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Preservation tab
// ---------------------------------------------------------------------------

function PreservationTab({ env }: { env: GovernanceControlPlaneEnvelope }) {
  const p = env.sections.preservation;
  if (p.status === "unavailable" || !p.data) {
    return (
      <section className="cc-section" data-tab-body="preservation">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Preservation</h2>
        </header>
        <SectionNote status={p.status} kind="preservation" />
      </section>
    );
  }
  const { evidenceHolds, caseHolds } = p.data;
  return (
    <section className="cc-section" data-tab-body="preservation">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Preservation</h2>
      </header>
      <div className="cases-preservation-grid">
        <div data-governance-preservation="evidence-holds">
          <h3 className="cases-preservation-heading">
            Evidence-level legal holds · {evidenceHolds.length}
          </h3>
          {evidenceHolds.length === 0 ? (
            <div className="cc-section-note">No evidence-level holds placed.</div>
          ) : (
            <ul className="cases-list">
              {evidenceHolds.map((h) => (
                <li
                  key={h.id}
                  className="cases-row"
                  data-governance-hold-id={h.id}
                  data-governance-hold-status={h.status}
                >
                  <Link
                    href={`/evidence/${h.evidenceId}`}
                    className="cases-row-link"
                  >
                    <div className="cases-row-main">
                      <span className="cases-row-title">
                        Evidence {h.evidenceId.slice(0, 8)}
                      </span>
                      <span className="cases-row-scope">{h.status}</span>
                    </div>
                    <div className="cases-row-meta">
                      {h.reason ? <span>{h.reason}</span> : null}
                      <time dateTime={h.placedAtUtc}>
                        Placed {relTime(h.placedAtUtc)}
                      </time>
                      {h.releasedAtUtc ? (
                        <time dateTime={h.releasedAtUtc}>
                          Released {relTime(h.releasedAtUtc)}
                        </time>
                      ) : null}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div data-governance-preservation="case-holds">
          <h3 className="cases-preservation-heading">
            Case-level holds · {caseHolds.length}
          </h3>
          {caseHolds.length === 0 ? (
            <div className="cc-section-note">
              No case-level legal holds placed.
            </div>
          ) : (
            <ul className="cases-list">
              {caseHolds.map((h) => (
                <li
                  key={h.id}
                  className="cases-row"
                  data-governance-case-hold-id={h.id}
                  data-governance-hold-status={h.status}
                >
                  <Link
                    href={`/cases/${h.caseId}`}
                    className="cases-row-link"
                  >
                    <div className="cases-row-main">
                      <span className="cases-row-title">{h.title}</span>
                      <span className="cases-row-scope">{h.status}</span>
                    </div>
                    <div className="cases-row-meta">
                      <time dateTime={h.placedAtUtc}>
                        Placed {relTime(h.placedAtUtc)}
                      </time>
                      {h.releasedAtUtc ? (
                        <time dateTime={h.releasedAtUtc}>
                          Released {relTime(h.releasedAtUtc)}
                        </time>
                      ) : null}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="cc-section-foot">
        Legal preservation is a workspace operational control. It does not
        assert legal admissibility or authenticity of any record.
      </div>
      {p.status === "degraded" ? (
        <SectionNote status="degraded" kind="preservation" />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Retention + destruction tab
// ---------------------------------------------------------------------------

function RetentionTab({ env }: { env: GovernanceControlPlaneEnvelope }) {
  const r = env.sections.retention;
  if (r.status === "unavailable" || !r.data) {
    return (
      <section className="cc-section" data-tab-body="retention">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Retention & Destruction</h2>
        </header>
        <SectionNote status={r.status} kind="retention" />
      </section>
    );
  }
  const { candidates, pendingDestructionReviews } = r.data;
  return (
    <section className="cc-section" data-tab-body="retention">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Retention & Destruction</h2>
      </header>
      <div className="cases-preservation-grid">
        <div data-governance-retention="candidates">
          <h3 className="cases-preservation-heading">
            Retention candidates · {candidates.length}
          </h3>
          {candidates.length === 0 ? (
            <div className="cc-section-note">
              No retention candidates awaiting review.
            </div>
          ) : (
            <ul className="cases-list">
              {candidates.map((c) => (
                <li
                  key={c.id}
                  className="cases-row"
                  data-governance-retention-id={c.id}
                >
                  <Link
                    href={`/evidence/${c.evidenceId}`}
                    className="cases-row-link"
                  >
                    <div className="cases-row-main">
                      <span className="cases-row-title">
                        Evidence {c.evidenceId.slice(0, 8)}
                      </span>
                      <span className="cases-row-scope">{c.status}</span>
                    </div>
                    <div className="cases-row-meta">
                      <time dateTime={c.createdAt}>
                        Proposed {relTime(c.createdAt)}
                      </time>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div data-governance-retention="destruction-reviews">
          <h3 className="cases-preservation-heading">
            Pending destruction reviews · {pendingDestructionReviews.length}
          </h3>
          {pendingDestructionReviews.length === 0 ? (
            <div className="cc-section-note">
              No destruction reviews pending.
            </div>
          ) : (
            <ul className="cases-list">
              {pendingDestructionReviews.map((d) => (
                <li
                  key={d.id}
                  className="cases-row"
                  data-governance-destruction-id={d.id}
                  data-governance-destruction-status={d.status}
                >
                  <Link
                    href="/governance/destruction"
                    className="cases-row-link"
                  >
                    <div className="cases-row-main">
                      <span className="cases-row-title">
                        Destruction {d.id.slice(0, 8)}
                      </span>
                      <span className="cases-row-scope">{d.status}</span>
                    </div>
                    <div className="cases-row-meta">
                      <span>Evidence {d.evidenceId.slice(0, 8)}</span>
                      <time dateTime={d.createdAt}>
                        Created {relTime(d.createdAt)}
                      </time>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="cc-section-foot">
        Destruction execution requires admin role + step-up authentication
        and continues through the existing audited destruction-review
        endpoints. This page does not execute destructions.
      </div>
      {r.status === "degraded" ? (
        <SectionNote status="degraded" kind="retention" />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Export governance tab
// ---------------------------------------------------------------------------

function ExportTab({ env }: { env: GovernanceControlPlaneEnvelope }) {
  const x = env.sections.exportGovernance;
  if (x.status !== "ok" || !x.data) {
    return (
      <section className="cc-section" data-tab-body="exports">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Export Governance</h2>
        </header>
        <SectionNote status={x.status} kind="exports" />
      </section>
    );
  }
  const d = x.data;
  return (
    <section className="cc-section" data-tab-body="exports">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Export Governance</h2>
      </header>
      <div className="cc-tile-grid" data-governance-export-tiles>
        <div className="cc-tile" data-governance-gate-tile="report">
          <span className="cc-tile-value">
            {d.gateFlags.allowReportDownload ? "Allowed" : "Blocked"}
          </span>
          <span className="cc-tile-label">Report downloads</span>
        </div>
        <div className="cc-tile" data-governance-gate-tile="package">
          <span className="cc-tile-value">
            {d.gateFlags.allowPackageDownload ? "Allowed" : "Blocked"}
          </span>
          <span className="cc-tile-label">Package downloads</span>
        </div>
        <div className="cc-tile" data-governance-gate-tile="public_verify">
          <span className="cc-tile-value">
            {d.gateFlags.allowPublicVerify ? "Allowed" : "Blocked"}
          </span>
          <span className="cc-tile-label">Public verify</span>
        </div>
        <div className="cc-tile" data-governance-gate-tile="original">
          <span className="cc-tile-value">
            {d.gateFlags.allowOriginalDownload ? "Allowed" : "Blocked"}
          </span>
          <span className="cc-tile-label">Original file download</span>
        </div>
      </div>
      <header className="cc-section-header" style={{ marginTop: 12 }}>
        <h3 className="cc-section-title">
          Recent export blocks · {d.recentBlocks.length}
        </h3>
      </header>
      {d.recentBlocks.length === 0 ? (
        <div className="cc-section-note">
          No evidence currently shows a package gate-block.
        </div>
      ) : (
        <ul className="cases-list" data-governance-export-blocks>
          {d.recentBlocks.map((b) => (
            <li
              key={b.evidenceId}
              className="cases-row"
              data-governance-export-block-evidence={b.evidenceId}
            >
              <Link
                href={`/evidence/${b.evidenceId}`}
                className="cases-row-link"
              >
                <div className="cases-row-main">
                  <span className="cases-row-title">
                    Evidence {b.evidenceId.slice(0, 8)}
                  </span>
                  <span className="cases-row-scope" data-governance-export-outcome={b.outcome}>
                    {b.outcome ?? "blocked"}
                  </span>
                </div>
                <div className="cases-row-meta">
                  <span>{b.reason}</span>
                  {b.blockedAtUtc ? (
                    <time dateTime={b.blockedAtUtc}>
                      Blocked {relTime(b.blockedAtUtc)}
                    </time>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Policy tab
// ---------------------------------------------------------------------------

function PolicyTab({
  env,
  isAdmin,
}: {
  env: GovernanceControlPlaneEnvelope;
  isAdmin: boolean;
}) {
  const p = env.sections.policy;
  if (p.status !== "ok" || !p.data) {
    return (
      <section className="cc-section" data-tab-body="policy">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Policy</h2>
        </header>
        <SectionNote status={p.status} kind="policy" />
      </section>
    );
  }
  const d = p.data;
  const rows = [
    {
      key: "retention_days",
      label: "Default retention",
      value: d.defaultRetentionDays
        ? `${d.defaultRetentionDays} days`
        : "unset",
    },
    {
      key: "deletion_mode",
      label: "Evidence deletion",
      value: d.evidenceDeletionMode,
    },
    {
      key: "hold_approval",
      label: "Hold approval required for deletion",
      value: d.requireLegalHoldApprovalForDeletion ? "Yes" : "No",
    },
    {
      key: "review_report",
      label: "Review required before report",
      value: d.requireReviewBeforeReport ? "Yes" : "No",
    },
    {
      key: "review_package",
      label: "Review required before package",
      value: d.requireReviewBeforePackage ? "Yes" : "No",
    },
    {
      key: "review_public",
      label: "Review required before public verify",
      value: d.requireReviewBeforePublicVerify ? "Yes" : "No",
    },
  ];
  return (
    <section className="cc-section" data-tab-body="policy">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Policy</h2>
      </header>
      <ul className="governance-policy-summary" data-governance-policy-rows>
        {rows.map((r) => (
          <li
            key={r.key}
            className="governance-policy-row"
            data-governance-policy-row={r.key}
          >
            <span className="governance-policy-row-label">{r.label}</span>
            <span className="governance-policy-row-value">{r.value}</span>
          </li>
        ))}
      </ul>
      <div className="cc-section-foot">
        Source:{" "}
        <span data-governance-policy-source={d.source}>
          {d.source === "workspace_row"
            ? "workspace policy row"
            : "platform default"}
        </span>
        {isAdmin ? (
          <>
            {" · "}
            <Link href="/governance/policy">Edit policy</Link>
          </>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Incidents tab
// ---------------------------------------------------------------------------

function IncidentsTab({ env }: { env: GovernanceControlPlaneEnvelope }) {
  const i = env.sections.incidents;
  // STAGE 2 — gate ops/observability/runbooks deep-links on the canonical
  // capabilities required to USE those routes. Users without the
  // capability still see the incident list, just without the deep-link
  // that they could not reach anyway.
  const canRunbooks = useCan("RUNBOOKS_VIEW");
  const canObservability = useCan("OBSERVABILITY_VIEW");
  const canOpsCenter = useCan("OPS_CENTER_VIEW");
  if (i.status === "unavailable") {
    return (
      <section className="cc-section" data-tab-body="incidents">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Governance Incidents</h2>
        </header>
        <SectionNote status="unavailable" kind="incidents" />
      </section>
    );
  }
  if (i.items.length === 0) {
    return (
      <section className="cc-section" data-tab-body="incidents">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Governance Incidents</h2>
        </header>
        <div className="cc-section-note">No open governance-tagged incidents.</div>
      </section>
    );
  }
  return (
    <section className="cc-section" data-tab-body="incidents">
      <header className="cc-section-header">
        <h2 className="cc-section-title">
          Governance Incidents · {i.items.length}
        </h2>
      </header>
      <ul className="cc-incident-list" data-governance-incidents-list>
        {i.items.map((row) => (
          <li
            key={row.id}
            className="cc-incident-row"
            data-cc-incident-severity={row.severity}
            data-cc-incident-status={row.status}
          >
            <div className="cc-incident-row-main">
              <span className="cc-incident-title">{row.title}</span>
              <span className="cc-incident-meta">
                {row.category} · {row.severity} · {row.status}
              </span>
            </div>
            <div className="cc-incident-summary">{row.safeSummary}</div>
            <div className="cc-incident-row-foot">
              {row.runbookSlug && canRunbooks ? (
                <Link href={`/ops/runbooks#${row.runbookSlug}`}>
                  Runbook → {row.runbookSlug}
                </Link>
              ) : !row.runbookSlug && canObservability ? (
                <Link href="/ops/observability">Open observability</Link>
              ) : null}
              <time dateTime={row.lastSeenAtUtc}>
                Seen {relTime(row.lastSeenAtUtc)}
              </time>
            </div>
          </li>
        ))}
      </ul>
      {canOpsCenter ? (
        <div className="cc-section-foot">
          Detailed platform health lives under{" "}
          <Link href="/ops">Operations Center</Link>.
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared shells
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
    <main className="cc-page" data-governance-loading>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Compliance · Preservation · Retention</div>
          <h1 className="cc-title">Loading governance…</h1>
        </div>
      </header>
      <section className="cc-section">
        <div className="cc-skeleton" />
      </section>
    </main>
  );
}

// CR1.6 — `ShellNoWorkspace` removed. The canonical no-team
// rendering path is the in-component `CapabilityDegradedPanel`
// (GOVERNANCE_VIEW) for personal users; PageRouteGate handles
// truly missing workspace state at route entry.

function ShellAuthError({
  code,
}: {
  code: "auth_required" | "permission_denied";
}) {
  return (
    <main className="cc-page" data-governance-auth-error={code}>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Compliance · Preservation · Retention</div>
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
    <main className="cc-page" data-governance-unavailable>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Compliance · Preservation · Retention</div>
          <h1 className="cc-title">Temporarily unavailable</h1>
          <p className="cc-subtitle">{message}</p>
        </div>
      </header>
    </main>
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
