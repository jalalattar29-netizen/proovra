"use client";

/**
 * Phase 32.8D-frontend — Matter Operations Queue.
 *
 * The /cases route is no longer a CRUD card list. It is the
 * team-scoped Matter Operations Queue, sourced from
 * `GET /v1/cases/matter-queue`. Each row surfaces:
 *
 *   - case identity (name, reference number)
 *   - status / priority chips
 *   - operational counters (linked evidence, evidence gaps, open
 *     incidents, active + overdue workflows, governance blockers,
 *     legal hold count)
 *   - risk score / risk level / risk reason codes / recommended
 *     action
 *   - latest activity time
 *
 * Hard rules:
 *
 *   1. Authority is read from the canonical platform context only.
 *      NO useActiveWorkspaceId, NO /v1/users/me authority fetch,
 *      NO /v1/teams authority fetch, NO local role/scope derivation.
 *   2. Personal workspace renders the canonical
 *      CapabilityDegradedPanel — the matter queue is team-scoped.
 *   3. Browsing is side-effect free. No signed URLs, no audit
 *      events, no report/package generation on render.
 *   4. NO fabricated metrics — every count comes verbatim from the
 *      envelope.
 *   5. Filters are wired client-side as query parameters; the
 *      server is the only authority on which rows are visible.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import {
  CapabilityDegradedPanel,
  usePlatformContext,
  useTeamId,
} from "../../lib/platform-context";
import type {
  MatterQueueEnvelope,
  MatterQueueItem,
  MatterRiskLevel,
} from "./types";

// ---------------------------------------------------------------------------
// Bounded filter vocabularies (mirror MatterQueueQuery on the backend)
// ---------------------------------------------------------------------------

const CASE_STATUSES = [
  "OPEN",
  "INVESTIGATING",
  "ON_HOLD",
  "RESOLVED",
  "CLOSED",
  "ARCHIVED",
] as const;
type CaseStatus = (typeof CASE_STATUSES)[number];

const RISK_LEVELS = ["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

type QueueFilters = {
  search: string;
  status: CaseStatus | "";
  riskLevel: MatterRiskLevel | "";
  assignedToMe: boolean;
  hasOpenIncidents: boolean;
  hasGovernanceBlockers: boolean;
  hasOverdueWorkflows: boolean;
  hasLegalHold: boolean;
  missingArtifact: boolean;
};

const DEFAULT_FILTERS: QueueFilters = {
  search: "",
  status: "",
  riskLevel: "",
  assignedToMe: false,
  hasOpenIncidents: false,
  hasGovernanceBlockers: false,
  hasOverdueWorkflows: false,
  hasLegalHold: false,
  missingArtifact: false,
};

// ---------------------------------------------------------------------------
// Load state
// ---------------------------------------------------------------------------

type LoadState =
  | { status: "loading" }
  | { status: "ready"; envelope: MatterQueueEnvelope }
  | { status: "auth_error"; code: "auth_required" | "permission_denied" }
  | { status: "unavailable"; message: string };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CasesIndex() {
  const ctx = usePlatformContext();
  const teamId = useTeamId();
  const viewerUserId = ctx.envelope?.user.id ?? null;

  const [filters, setFilters] = useState<QueueFilters>(DEFAULT_FILTERS);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  // Build the canonical query string from the filter state. The
  // matter-queue endpoint takes the bounded params verbatim.
  const queryString = useMemo(() => {
    if (!teamId) return "";
    const qs = new URLSearchParams();
    qs.set("teamId", teamId);
    if (filters.search.trim()) qs.set("search", filters.search.trim());
    if (filters.status) qs.set("status", filters.status);
    if (filters.riskLevel) qs.set("riskLevel", filters.riskLevel);
    if (filters.assignedToMe && viewerUserId)
      qs.set("assignedToUserId", viewerUserId);
    if (filters.hasOpenIncidents) qs.set("hasOpenIncidents", "true");
    if (filters.hasGovernanceBlockers) qs.set("hasGovernanceBlockers", "true");
    if (filters.hasOverdueWorkflows) qs.set("hasOverdueWorkflows", "true");
    if (filters.hasLegalHold) qs.set("hasLegalHold", "true");
    if (filters.missingArtifact) qs.set("missingArtifact", "true");
    return qs.toString();
  }, [teamId, filters, viewerUserId]);

  const reload = useCallback(async () => {
    if (!teamId) return;
    setState({ status: "loading" });
    try {
      const envelope = (await apiFetch(`/v1/cases/matter-queue?${queryString}`, {
        method: "GET",
      })) as MatterQueueEnvelope;
      setState({ status: "ready", envelope });
    } catch (err) {
      const e = err as { message?: string; statusCode?: number };
      if (e.statusCode === 401) {
        setState({ status: "auth_error", code: "auth_required" });
      } else if (e.statusCode === 403) {
        setState({ status: "auth_error", code: "permission_denied" });
      } else {
        setState({
          status: "unavailable",
          message: e.message ?? "Unable to load matter queue.",
        });
      }
    }
  }, [teamId, queryString]);

  useEffect(() => {
    if (!teamId) return;
    void reload();
  }, [reload, teamId]);

  // Personal workspace — matter queue is team-scoped. Render the
  // canonical structured panel rather than a plain-text fallback.
  if (!teamId) {
    return (
      <main className="cc-page" data-cases-personal-mode>
        <CapabilityDegradedPanel
          surface="Matter Operations Queue"
          requiredCapability="CASES_VIEW"
          reason="The Matter Operations Queue coordinates investigation matters across a team — risk scoring, evidence gaps, open incidents, governance blockers, and reviewer pressure all live together. It activates when you switch into a team workspace."
          alternatives={[
            { label: "View your evidence", href: "/evidence" },
            { label: "Generate a report", href: "/reports" },
            { label: "Switch or create a team workspace", href: "/teams" },
          ]}
        />
      </main>
    );
  }

  if (state.status === "loading") return <QueueLoading />;
  if (state.status === "auth_error") return <QueueAuthError code={state.code} />;
  if (state.status === "unavailable")
    return <QueueUnavailable message={state.message} onRetry={reload} />;

  const { envelope } = state;
  return (
    <main className="cc-page" data-cases-index data-matter-queue>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Investigation Matters</div>
          <h1 className="cc-title">Matter Operations Queue</h1>
          <p className="cc-subtitle">
            Real operational state of every case in this team — risk score,
            evidence gaps, open incidents, governance blockers, reviewer
            pressure, and legal preservation. Browse is read-only; explicit
            actions remain audited.
          </p>
        </div>
        <div className="cc-meta">
          <span data-matter-queue-total>
            {envelope.total} {envelope.total === 1 ? "matter" : "matters"}
          </span>
          <span title={envelope.generatedAt} data-matter-queue-generated-at>
            Refreshed {formatRelativeTime(envelope.generatedAt)}
          </span>
        </div>
      </header>

      <MatterQueueFilters
        filters={filters}
        viewerUserId={viewerUserId}
        onChange={setFilters}
      />

      <MatterQueueTable
        items={envelope.items}
        totalBeforeFilter={envelope.total}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function MatterQueueFilters({
  filters,
  viewerUserId,
  onChange,
}: {
  filters: QueueFilters;
  viewerUserId: string | null;
  onChange: (f: QueueFilters) => void;
}) {
  const set = <K extends keyof QueueFilters>(key: K, value: QueueFilters[K]) =>
    onChange({ ...filters, [key]: value });
  return (
    <section className="cc-section" data-matter-queue-filters>
      <header className="cc-section-header">
        <h2 className="cc-section-title">Filters</h2>
      </header>
      <div className="cases-filter-row">
        <input
          type="search"
          className="cases-filter-search"
          placeholder="Search by case name"
          value={filters.search}
          onChange={(e) => set("search", e.target.value)}
          data-matter-queue-search-input
        />
        <select
          aria-label="Status"
          value={filters.status}
          onChange={(e) => set("status", e.target.value as CaseStatus | "")}
          data-matter-queue-status-select
          className="cases-filter-chip"
        >
          <option value="">Any status</option>
          {CASE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          aria-label="Risk level"
          value={filters.riskLevel}
          onChange={(e) =>
            set("riskLevel", e.target.value as MatterRiskLevel | "")
          }
          data-matter-queue-risk-select
          className="cases-filter-chip"
        >
          <option value="">Any risk</option>
          {RISK_LEVELS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="cases-filter-chips" role="group" aria-label="Operational filters">
        <FilterToggle
          dataKey="assigned-to-me"
          label="Assigned to me"
          active={filters.assignedToMe}
          disabled={!viewerUserId}
          onToggle={() => set("assignedToMe", !filters.assignedToMe)}
        />
        <FilterToggle
          dataKey="has-open-incidents"
          label="Open incidents"
          active={filters.hasOpenIncidents}
          onToggle={() => set("hasOpenIncidents", !filters.hasOpenIncidents)}
        />
        <FilterToggle
          dataKey="has-governance-blockers"
          label="Governance blockers"
          active={filters.hasGovernanceBlockers}
          onToggle={() =>
            set("hasGovernanceBlockers", !filters.hasGovernanceBlockers)
          }
        />
        <FilterToggle
          dataKey="has-overdue-workflows"
          label="Overdue workflows"
          active={filters.hasOverdueWorkflows}
          onToggle={() =>
            set("hasOverdueWorkflows", !filters.hasOverdueWorkflows)
          }
        />
        <FilterToggle
          dataKey="has-legal-hold"
          label="Active legal hold"
          active={filters.hasLegalHold}
          onToggle={() => set("hasLegalHold", !filters.hasLegalHold)}
        />
        <FilterToggle
          dataKey="missing-artifact"
          label="Missing report/package"
          active={filters.missingArtifact}
          onToggle={() => set("missingArtifact", !filters.missingArtifact)}
        />
      </div>
    </section>
  );
}

function FilterToggle({
  dataKey,
  label,
  active,
  disabled,
  onToggle,
}: {
  dataKey: string;
  label: string;
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`cases-filter-chip ${active ? "is-active" : ""}`}
      data-matter-queue-filter={dataKey}
      aria-pressed={active}
      disabled={disabled}
      onClick={onToggle}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Queue table
// ---------------------------------------------------------------------------

function MatterQueueTable({
  items,
  totalBeforeFilter,
}: {
  items: ReadonlyArray<MatterQueueItem>;
  totalBeforeFilter: number;
}) {
  return (
    <section className="cc-section" data-matter-queue-table>
      <header className="cc-section-header">
        <h2 className="cc-section-title">
          {items.length === totalBeforeFilter
            ? `Matters · ${items.length}`
            : `Matters · ${items.length} of ${totalBeforeFilter}`}
        </h2>
      </header>
      {items.length === 0 ? (
        <div className="cc-section-note" data-matter-queue-empty>
          No matters match the current filters. Clear filters or open a case
          from the evidence detail to begin matter coordination.
        </div>
      ) : (
        <ul className="cases-list" data-matter-queue-items>
          {items.map((row) => (
            <MatterQueueRow key={row.id} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MatterQueueRow({ row }: { row: MatterQueueItem }) {
  const reasonCodes = row.riskReasonCodes ?? [];
  return (
    <li
      className="cases-row"
      data-matter-queue-row
      data-matter-queue-row-id={row.id}
      data-matter-queue-row-risk={row.riskLevel ?? "NONE"}
      data-matter-queue-row-status={row.status}
    >
      <Link href={`/cases/${row.id}`} className="cases-row-link">
        <div className="cases-row-main">
          <span className="cases-row-title">{row.name}</span>
          {row.referenceNumber ? (
            <span
              className="cases-row-scope"
              data-matter-queue-row-reference={row.referenceNumber}
            >
              {row.referenceNumber}
            </span>
          ) : null}
          <RiskBadge level={row.riskLevel} score={row.riskScore} />
          <span
            className="cases-row-chip"
            data-matter-queue-row-chip="status"
            data-status={row.status}
          >
            {row.status}
          </span>
          {row.priority && row.priority !== "P2" ? (
            <span
              className="cases-row-chip"
              data-matter-queue-row-chip="priority"
              data-priority={row.priority}
            >
              {row.priority}
            </span>
          ) : null}
        </div>
        <div className="cases-row-meta">
          <Counter
            dataKey="linked-evidence"
            value={row.linkedEvidenceCount}
            label="evidence"
          />
          {row.evidenceGapCount > 0 ? (
            <Counter
              dataKey="evidence-gap"
              value={row.evidenceGapCount}
              label="gap"
              tone="warning"
            />
          ) : null}
          {row.openIncidentCount > 0 ? (
            <Counter
              dataKey="open-incidents"
              value={row.openIncidentCount}
              label="incident"
              tone="high"
            />
          ) : null}
          {row.activeWorkflowCount > 0 ? (
            <Counter
              dataKey="active-workflows"
              value={row.activeWorkflowCount}
              label="wf"
            />
          ) : null}
          {row.overdueWorkflowCount > 0 ? (
            <Counter
              dataKey="overdue-workflows"
              value={row.overdueWorkflowCount}
              label="overdue"
              tone="critical"
            />
          ) : null}
          {row.governanceBlockerCount > 0 ? (
            <Counter
              dataKey="governance-blockers"
              value={row.governanceBlockerCount}
              label="gov block"
              tone="high"
            />
          ) : null}
          {row.activeLegalHoldCount > 0 ? (
            <span
              className="cases-row-chip"
              data-matter-queue-row-chip="hold"
              data-hold-count={row.activeLegalHoldCount}
            >
              Legal preservation
            </span>
          ) : null}
          {row.activeAssignmentCount > 0 ? (
            <Counter
              dataKey="assignments"
              value={row.activeAssignmentCount}
              label="assigned"
            />
          ) : null}
          <time
            dateTime={row.latestActivityAtUtc}
            data-matter-queue-row-latest-activity
            title={row.latestActivityAtUtc}
          >
            {formatRelativeTime(row.latestActivityAtUtc)}
          </time>
        </div>
        {reasonCodes.length > 0 ? (
          <div
            className="cases-row-reasons"
            data-matter-queue-row-reason-codes
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              padding: "6px 0 0",
            }}
          >
            {reasonCodes.map((code) => (
              <span
                key={code}
                className="cases-row-chip"
                data-matter-queue-row-reason={code}
                style={{ fontSize: 11 }}
              >
                {reasonCodeLabel(code)}
              </span>
            ))}
          </div>
        ) : null}
        {row.recommendedAction ? (
          <div
            className="cases-row-recommendation"
            data-matter-queue-row-recommendation
            style={{
              padding: "6px 0 0",
              fontSize: 12,
              color: "#b8c7c3",
            }}
          >
            Recommended: {row.recommendedAction}
          </div>
        ) : null}
      </Link>
    </li>
  );
}

function RiskBadge({
  level,
  score,
}: {
  level: string | null;
  score: number | null;
}) {
  if (!level) return null;
  const tone =
    level === "CRITICAL"
      ? "critical"
      : level === "HIGH"
        ? "high"
        : level === "MEDIUM"
          ? "warning"
          : "neutral";
  return (
    <span
      className="cases-row-chip"
      data-matter-queue-row-chip="risk"
      data-risk-tone={tone}
      data-risk-level={level}
      data-risk-score={score ?? ""}
    >
      Risk: {level}
      {typeof score === "number" ? ` · ${score}` : ""}
    </span>
  );
}

function Counter({
  dataKey,
  value,
  label,
  tone,
}: {
  dataKey: string;
  value: number;
  label: string;
  tone?: "warning" | "high" | "critical";
}) {
  return (
    <span
      data-matter-queue-row-counter={dataKey}
      data-counter-tone={tone ?? "neutral"}
    >
      {value} {label}
    </span>
  );
}

function reasonCodeLabel(code: string): string {
  switch (code) {
    case "EVIDENCE_GAP":
      return "Evidence gap";
    case "INCIDENT_OPEN":
      return "Open incident";
    case "WORKFLOW_OVERDUE":
      return "Workflow overdue";
    case "WORKFLOW_ACTIVE":
      return "Active workflow";
    case "INTEGRITY_FAILED":
      return "Integrity failed";
    case "INTEGRITY_REVIEW_REQUIRED":
      return "Integrity review";
    case "GOVERNANCE_BLOCKER":
      return "Governance blocker";
    case "LEGAL_HOLD_ACTIVE":
      return "Legal preservation";
    case "REVIEWER_OVERLOAD":
      return "Reviewer overload";
    case "AUDIT_GAP":
      return "Audit gap";
    case "PACKAGE_MISSING":
      return "Package missing";
    case "REPORT_MISSING":
      return "Report missing";
    case "CUSTODY_CONCERN":
      return "Custody concern";
    default:
      return code;
  }
}

// ---------------------------------------------------------------------------
// Shells
// ---------------------------------------------------------------------------

function QueueLoading() {
  return (
    <main className="cc-page" data-matter-queue-loading>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Investigation Matters</div>
          <h1 className="cc-title">Matter Operations Queue</h1>
        </div>
      </header>
      <section className="cc-section">
        <div className="cc-skeleton" />
      </section>
    </main>
  );
}

function QueueAuthError({
  code,
}: {
  code: "auth_required" | "permission_denied";
}) {
  return (
    <main className="cc-page" data-matter-queue-auth-error={code}>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Investigation Matters</div>
          <h1 className="cc-title">
            {code === "auth_required"
              ? "Sign in required"
              : "Permission required"}
          </h1>
          <p className="cc-subtitle">
            {code === "auth_required"
              ? "Sign in to view the matter queue."
              : "You do not have permission to view the matter queue for this workspace. Ask a workspace administrator."}
          </p>
        </div>
      </header>
    </main>
  );
}

function QueueUnavailable({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <main className="cc-page" data-matter-queue-unavailable>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Investigation Matters</div>
          <h1 className="cc-title">Matter queue temporarily unavailable</h1>
          <p className="cc-subtitle">{message}</p>
        </div>
        <div className="cc-meta">
          <button type="button" onClick={onRetry} className="cases-filter-chip">
            Retry
          </button>
        </div>
      </header>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Time helper
// ---------------------------------------------------------------------------

function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
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
