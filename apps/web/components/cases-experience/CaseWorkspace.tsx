"use client";

/**
 * Phase 32.8D — Case Workspace (tabbed investigation/matter view).
 *
 * Sourced from `GET /v1/cases/:id/workspace` which assembles:
 *   - case metadata
 *   - linked evidence with bounded report/package readiness flags
 *   - case-level + evidence-level legal holds
 *   - reviewer workflow state (team workspaces only)
 *   - real-timestamp timeline (case + evidence + holds)
 *   - team-activity feed (team workspaces only)
 *
 * Hard rules preserved from Phase 32.8D:
 *   - Browsing this page is side-effect-free. The aggregator emits
 *     no audit; the existing /v1/cases/:id GET endpoint remains the
 *     canonical "viewed-case" audit surface and is INTENTIONALLY not
 *     called by this component.
 *   - Evidence mutation lives on /evidence/[id] — this workspace
 *     surfaces links only.
 *   - No legal-admissibility / authenticity / truth claims.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import type { CaseWorkspaceEnvelope } from "./types";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; envelope: CaseWorkspaceEnvelope }
  | { status: "not_found" }
  | { status: "auth_error"; code: "auth_required" | "permission_denied" }
  | { status: "unavailable"; message: string };

type TabKey =
  | "overview"
  | "evidence"
  | "timeline"
  | "review"
  | "preservation"
  | "activity";

export function CaseWorkspace({ caseId }: { caseId: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [activeTab, setActiveTab] = useState<TabKey>("overview");

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const envelope = (await apiFetch(
        `/v1/cases/${encodeURIComponent(caseId)}/workspace`,
        { method: "GET" },
      )) as CaseWorkspaceEnvelope;
      setState({ status: "ready", envelope });
    } catch (err) {
      const e = err as { message?: string; statusCode?: number };
      if (e.statusCode === 404) {
        setState({ status: "not_found" });
      } else if (e.statusCode === 401) {
        setState({ status: "auth_error", code: "auth_required" });
      } else if (e.statusCode === 403) {
        setState({ status: "auth_error", code: "permission_denied" });
      } else {
        setState({
          status: "unavailable",
          message: e.message ?? "Unable to load case workspace.",
        });
      }
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") {
    return <CaseWorkspaceLoading />;
  }
  if (state.status === "not_found") {
    return <CaseWorkspaceNotFound />;
  }
  if (state.status === "auth_error") {
    return <CaseWorkspaceAuthError code={state.code} />;
  }
  if (state.status === "unavailable") {
    return <CaseWorkspaceUnavailable message={state.message} />;
  }

  const { envelope } = state;
  const { case: caseRow, viewer, sections } = envelope;
  const isTeam = caseRow.scope === "TEAM";
  const tabs: Array<{ key: TabKey; label: string; visible: boolean }> = [
    { key: "overview", label: "Overview", visible: true },
    { key: "evidence", label: "Linked Evidence", visible: true },
    { key: "timeline", label: "Timeline", visible: true },
    { key: "review", label: "Review Coordination", visible: isTeam },
    { key: "preservation", label: "Legal Preservation", visible: true },
    { key: "activity", label: "Activity", visible: isTeam },
  ];

  return (
    <main className="cc-page" data-case-workspace data-case-id={caseRow.id}>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Investigation Workspace</div>
          <h1 className="cc-title">{caseRow.name}</h1>
          <p className="cc-subtitle">
            <span data-case-scope={caseRow.scope}>
              {caseRow.scope === "PERSONAL" ? "Personal case" : "Team case"}
            </span>
            {" · "}
            <Link href="/cases">Back to cases</Link>
          </p>
        </div>
        <div className="cc-meta">
          <span data-case-role={viewer.role}>Role: {viewer.role}</span>
          <span title={caseRow.createdAt}>
            Created {formatRelativeTime(caseRow.createdAt)}
          </span>
          <span title={envelope.generatedAt}>
            Refreshed {formatRelativeTime(envelope.generatedAt)}
          </span>
        </div>
      </header>

      {/* Tab bar */}
      <nav className="case-tabs" role="tablist" aria-label="Case sections">
        {tabs
          .filter((t) => t.visible)
          .map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={activeTab === t.key}
              className={`case-tab ${activeTab === t.key ? "is-active" : ""}`}
              onClick={() => setActiveTab(t.key)}
              data-case-tab={t.key}
            >
              {t.label}
            </button>
          ))}
      </nav>

      {/* Tab content */}
      {activeTab === "overview" ? (
        <OverviewTab
          envelope={envelope}
          onSwitchTab={setActiveTab}
        />
      ) : null}
      {activeTab === "evidence" ? (
        <EvidenceTab section={sections.evidence} />
      ) : null}
      {activeTab === "timeline" ? (
        <TimelineTab section={sections.timeline} />
      ) : null}
      {activeTab === "review" ? (
        <ReviewTab section={sections.reviewCoordination} />
      ) : null}
      {activeTab === "preservation" ? (
        <PreservationTab section={sections.preservation} />
      ) : null}
      {activeTab === "activity" ? (
        <ActivityTab section={sections.activity} />
      ) : null}
    </main>
  );
}

// ===========================================================================
// Overview tab
// ===========================================================================

function OverviewTab({
  envelope,
  onSwitchTab,
}: {
  envelope: CaseWorkspaceEnvelope;
  onSwitchTab: (k: TabKey) => void;
}) {
  const { sections, case: caseRow } = envelope;
  if (sections.overview.status !== "ok" || !sections.overview.data) {
    return (
      <section className="cc-section" data-case-tab-body="overview">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Overview</h2>
        </header>
        <div className="cc-section-note" data-cc-section-status={sections.overview.status}>
          Overview is temporarily unavailable. Other tabs may still load.
        </div>
      </section>
    );
  }
  const d = sections.overview.data;
  const isTeam = caseRow.scope === "TEAM";
  const tiles: Array<{
    key: string;
    value: number;
    label: string;
    visible: boolean;
    onClick?: () => void;
  }> = [
    { key: "linked_evidence", value: d.linkedEvidenceCount, label: "Linked evidence", visible: true, onClick: () => onSwitchTab("evidence") },
    { key: "recent", value: d.recentlyLinkedCount, label: "New (7d)", visible: true },
    { key: "case_holds", value: d.activeCaseHoldsCount, label: "Case-level holds", visible: true, onClick: () => onSwitchTab("preservation") },
    { key: "evidence_holds", value: d.affectedEvidenceHoldsCount, label: "Evidence holds", visible: true, onClick: () => onSwitchTab("preservation") },
    { key: "review_pending", value: d.pendingReviewCount, label: "Pending review", visible: isTeam, onClick: () => onSwitchTab("review") },
    { key: "escalations", value: d.openEscalationsCount, label: "Open escalations", visible: isTeam, onClick: () => onSwitchTab("review") },
  ];
  return (
    <section className="cc-section" data-case-tab-body="overview">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Overview</h2>
      </header>
      <div className="cc-tile-grid" data-case-overview-tiles>
        {tiles
          .filter((t) => t.visible)
          .map((t) => (
            <button
              key={t.key}
              type="button"
              className="cc-tile"
              onClick={t.onClick}
              data-case-tile-key={t.key}
            >
              <span className="cc-tile-value">{t.value}</span>
              <span className="cc-tile-label">{t.label}</span>
            </button>
          ))}
      </div>
    </section>
  );
}

// ===========================================================================
// Evidence tab
// ===========================================================================

function EvidenceTab({
  section,
}: {
  section: CaseWorkspaceEnvelope["sections"]["evidence"];
}) {
  if (section.status !== "ok") {
    return (
      <section className="cc-section" data-case-tab-body="evidence">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Linked Evidence</h2>
        </header>
        <div className="cc-section-note" data-cc-section-status={section.status}>
          Linked evidence is temporarily unavailable.
        </div>
      </section>
    );
  }
  if (section.items.length === 0) {
    return (
      <section className="cc-section" data-case-tab-body="evidence">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Linked Evidence</h2>
        </header>
        <div className="cases-empty" data-case-evidence-empty>
          <strong>No evidence linked to this case yet.</strong>
          <p>Link evidence from the evidence detail page or via the API.</p>
          <Link href="/evidence" className="cc-quick-action">
            Open evidence library
          </Link>
        </div>
      </section>
    );
  }
  return (
    <section className="cc-section" data-case-tab-body="evidence">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Linked Evidence · {section.items.length}</h2>
      </header>
      <ul className="cc-evidence-list" data-case-evidence-list>
        {section.items.map((e) => (
          <li key={e.id} className="cc-evidence-row" data-case-evidence-id={e.id}>
            <Link href={`/evidence/${e.id}`} className="cc-evidence-link">
              <div className="cc-evidence-row-main">
                <span className="cc-evidence-title">{e.title}</span>
                <span
                  className="cc-evidence-status"
                  data-cc-evidence-status={e.status}
                >
                  {humanize(e.status)}
                </span>
              </div>
              <div className="cc-evidence-row-meta">
                <time dateTime={e.createdAt}>
                  Added {formatRelativeTime(e.createdAt)}
                </time>
                {e.verificationStatus ? (
                  <span data-case-evidence-verification={e.verificationStatus}>
                    Integrity {humanize(e.verificationStatus)}
                  </span>
                ) : null}
                <span
                  data-case-evidence-report={e.reportReady ? "ready" : "not_ready"}
                >
                  Report {e.reportReady ? "ready" : "pending"}
                </span>
                <span
                  data-case-evidence-package={e.packageReady ? "ready" : "not_ready"}
                >
                  Package {e.packageReady ? "ready" : "pending"}
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ===========================================================================
// Timeline tab
// ===========================================================================

function TimelineTab({
  section,
}: {
  section: CaseWorkspaceEnvelope["sections"]["timeline"];
}) {
  if (section.status !== "ok") {
    return (
      <section className="cc-section" data-case-tab-body="timeline">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Timeline</h2>
        </header>
        <div className="cc-section-note" data-cc-section-status={section.status}>
          Timeline is temporarily unavailable.
        </div>
      </section>
    );
  }
  if (section.items.length === 0) {
    return (
      <section className="cc-section" data-case-tab-body="timeline">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Timeline</h2>
        </header>
        <div className="cc-section-note" data-case-timeline-empty>
          Timeline not tracked yet for this case.
        </div>
      </section>
    );
  }
  return (
    <section className="cc-section" data-case-tab-body="timeline">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Timeline</h2>
      </header>
      <ul className="cases-timeline-list" data-case-timeline-list>
        {section.items.map((t) => (
          <li
            key={t.id}
            className="cases-timeline-row"
            data-case-timeline-kind={t.kind}
          >
            <span className="cases-timeline-dot" data-case-timeline-kind-dot={t.kind} />
            <div className="cases-timeline-body">
              {t.href ? (
                <Link href={t.href} className="cases-timeline-label">
                  {t.label}
                </Link>
              ) : (
                <span className="cases-timeline-label">{t.label}</span>
              )}
              {t.subtitle ? (
                <span className="cases-timeline-subtitle">{t.subtitle}</span>
              ) : null}
            </div>
            <time
              dateTime={t.occurredAt}
              className="cases-timeline-time"
              title={t.occurredAt}
            >
              {formatRelativeTime(t.occurredAt)}
            </time>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ===========================================================================
// Review Coordination tab
// ===========================================================================

function ReviewTab({
  section,
}: {
  section: CaseWorkspaceEnvelope["sections"]["reviewCoordination"];
}) {
  if (section.status === "not_applicable") {
    return (
      <section className="cc-section" data-case-tab-body="review">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Review Coordination</h2>
        </header>
        <div
          className="cc-section-note"
          data-cc-section-status="not_applicable"
        >
          Personal case uses basic evidence controls. Reviewer coordination is a team workspace feature.
        </div>
      </section>
    );
  }
  if (section.status !== "ok" || !section.data) {
    return (
      <section className="cc-section" data-case-tab-body="review">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Review Coordination</h2>
        </header>
        <div className="cc-section-note" data-cc-section-status={section.status}>
          Reviewer coordination is temporarily unavailable.
        </div>
      </section>
    );
  }
  const d = section.data;
  const tiles = [
    { key: "queued", label: "Queued", value: d.queuedCount },
    { key: "assigned", label: "Assigned", value: d.assignedCount },
    { key: "in_review", label: "In review", value: d.inReviewCount },
    { key: "needs_info", label: "Needs info", value: d.needsInfoCount },
    {
      key: "overdue",
      label: "Overdue",
      value: d.overdueCount,
      severe: d.overdueCount > 0,
    },
    {
      key: "escalations",
      label: "Open escalations",
      value: d.openEscalationsCount,
      severe: d.openEscalationsCount > 0,
    },
  ];
  return (
    <section className="cc-section" data-case-tab-body="review">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Review Coordination</h2>
      </header>
      <div className="cc-tile-grid" data-case-review-tiles>
        {tiles.map((t) => (
          <div
            key={t.key}
            className="cc-tile"
            data-case-review-tile={t.key}
            data-cc-tile-severe={t.severe ? "true" : "false"}
          >
            <span className="cc-tile-value">{t.value}</span>
            <span className="cc-tile-label">{t.label}</span>
          </div>
        ))}
      </div>
      <div className="cc-section-foot">
        Reviewer actions live in <Link href="/reviewer-ops">Reviewer Ops</Link>.
      </div>
    </section>
  );
}

// ===========================================================================
// Preservation tab
// ===========================================================================

function PreservationTab({
  section,
}: {
  section: CaseWorkspaceEnvelope["sections"]["preservation"];
}) {
  if ((section.status !== "ok" && section.status !== "degraded") || !section.data) {
    return (
      <section className="cc-section" data-case-tab-body="preservation">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Legal Preservation</h2>
        </header>
        <div className="cc-section-note" data-cc-section-status={section.status}>
          Legal preservation is temporarily unavailable.
        </div>
      </section>
    );
  }
  const { caseHolds, evidenceHolds } = section.data;
  return (
    <section className="cc-section" data-case-tab-body="preservation">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Legal Preservation</h2>
      </header>
      <div className="cases-preservation-grid">
        <div data-case-preservation="case-holds">
          <h3 className="cases-preservation-heading">Case-level holds</h3>
          {caseHolds.length === 0 ? (
            <div className="cc-section-note">No case-level legal holds placed.</div>
          ) : (
            <ul className="cases-list">
              {caseHolds.map((h) => (
                <li
                  key={h.id}
                  className="cases-row"
                  data-case-hold-id={h.id}
                  data-case-hold-status={h.status}
                >
                  <div className="cases-row-main">
                    <span className="cases-row-title">{h.title}</span>
                    <span className="cases-row-scope">{h.status}</span>
                  </div>
                  <div className="cases-row-meta">
                    <time dateTime={h.placedAtUtc}>
                      Placed {formatRelativeTime(h.placedAtUtc)}
                    </time>
                    {h.releasedAtUtc ? (
                      <time dateTime={h.releasedAtUtc}>
                        Released {formatRelativeTime(h.releasedAtUtc)}
                      </time>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div data-case-preservation="evidence-holds">
          <h3 className="cases-preservation-heading">Evidence-level holds</h3>
          {evidenceHolds.length === 0 ? (
            <div className="cc-section-note">No evidence in this case is under a hold.</div>
          ) : (
            <ul className="cases-list">
              {evidenceHolds.map((h) => (
                <li
                  key={h.id}
                  className="cases-row"
                  data-case-evidence-hold={h.id}
                  data-case-hold-status={h.status}
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
                      <time dateTime={h.createdAt}>
                        Placed {formatRelativeTime(h.createdAt)}
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
        Legal preservation is a workspace control. It does not assert legal
        admissibility or authenticity of any record.
      </div>
      {section.status === "degraded" ? (
        <div className="cc-section-note" data-cc-section-status="degraded">
          One preservation subsystem returned partial data.
        </div>
      ) : null}
    </section>
  );
}

// ===========================================================================
// Activity tab
// ===========================================================================

function ActivityTab({
  section,
}: {
  section: CaseWorkspaceEnvelope["sections"]["activity"];
}) {
  if (section.status === "not_applicable") {
    return (
      <section className="cc-section" data-case-tab-body="activity">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Activity</h2>
        </header>
        <div
          className="cc-section-note"
          data-cc-section-status="not_applicable"
        >
          Personal cases do not have a team activity stream.
        </div>
      </section>
    );
  }
  if (section.status !== "ok") {
    return (
      <section className="cc-section" data-case-tab-body="activity">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Activity</h2>
        </header>
        <div className="cc-section-note" data-cc-section-status={section.status}>
          Activity is temporarily unavailable.
        </div>
      </section>
    );
  }
  if (section.items.length === 0) {
    return (
      <section className="cc-section" data-case-tab-body="activity">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Activity</h2>
        </header>
        <div className="cc-section-note" data-case-activity-empty>
          No case-scoped activity recorded yet for this workspace.
        </div>
      </section>
    );
  }
  return (
    <section className="cc-section" data-case-tab-body="activity">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Activity</h2>
      </header>
      <ul className="cases-activity-list" data-case-activity-list>
        {section.items.map((a) => (
          <li
            key={a.id}
            className="cases-activity-row"
            data-case-activity-event={a.eventType}
          >
            <div className="cases-activity-main">
              <span className="cases-activity-event">{humanize(a.eventType)}</span>
              {a.actorUserId ? (
                <span className="cases-activity-actor">
                  by {a.actorUserId.slice(0, 8)}
                </span>
              ) : null}
            </div>
            <time
              dateTime={a.createdAt}
              className="cases-activity-time"
              title={a.createdAt}
            >
              {formatRelativeTime(a.createdAt)}
            </time>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ===========================================================================
// Status / loading / error shells
// ===========================================================================

function CaseWorkspaceLoading() {
  return (
    <main className="cc-page" data-case-workspace-loading>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Investigation Workspace</div>
          <h1 className="cc-title">Loading case…</h1>
        </div>
      </header>
      <section className="cc-section">
        <div className="cc-skeleton" />
      </section>
    </main>
  );
}

function CaseWorkspaceNotFound() {
  return (
    <main className="cc-page" data-case-workspace-not-found>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Investigation Workspace</div>
          <h1 className="cc-title">Case not found</h1>
          <p className="cc-subtitle">
            This case does not exist or you do not have access to it.{" "}
            <Link href="/cases">Back to cases</Link>.
          </p>
        </div>
      </header>
    </main>
  );
}

function CaseWorkspaceAuthError({
  code,
}: {
  code: "auth_required" | "permission_denied";
}) {
  return (
    <main className="cc-page" data-case-workspace-auth-error={code}>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Investigation Workspace</div>
          <h1 className="cc-title">
            {code === "auth_required"
              ? "Sign in required"
              : "Permission required"}
          </h1>
          <p className="cc-subtitle">
            {code === "auth_required"
              ? "Sign in to view this case."
              : "You do not have permission to view this case."}
          </p>
        </div>
      </header>
    </main>
  );
}

function CaseWorkspaceUnavailable({ message }: { message: string }) {
  return (
    <main className="cc-page" data-case-workspace-unavailable>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Investigation Workspace</div>
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

function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}
