"use client";

/**
 * Phase 32.8D — Enterprise Cases / Matters index.
 *
 * Replaces the previous CRUD-style cases page. Cases are presented
 * as investigation/matter workspaces with operational summary +
 * enriched rows (linked evidence, holds, review pressure).
 *
 * Hard rules:
 *   - Every count + indicator comes from `/v1/cases/summary`. No
 *     fake metrics, no decorative cards.
 *   - Personal workspace renders the same shape but the operational
 *     strip surfaces only the relevant cards (no broken team
 *     governance widgets — `casesWithActiveHolds` and
 *     `casesWithPendingReview` simply show 0 / are gated for
 *     personal-only workspaces).
 *   - Browse loads NEVER mutate state. Create / rename / delete go
 *     through explicit user actions and reuse the existing audited
 *     /v1/cases endpoints — Phase 32.8D does not weaken governance.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import { useActiveWorkspaceId } from "../../lib/useActiveWorkspaceId";
import type {
  CaseSummaryItem,
  CasesSummaryEnvelope,
} from "./types";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; envelope: CasesSummaryEnvelope }
  | { status: "no_workspace" }
  | { status: "auth_error"; code: "auth_required" | "permission_denied" }
  | { status: "unavailable"; message: string };

type StatusFilter = "all" | "with_evidence" | "with_holds" | "with_review";

export function CasesIndex() {
  const workspace = useActiveWorkspaceId();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    if (workspace.status !== "ready") return;
    setState({ status: "loading" });
    try {
      const envelope = (await apiFetch(
        `/v1/cases/summary?teamId=${encodeURIComponent(workspace.workspaceId)}`,
        { method: "GET" },
      )) as CasesSummaryEnvelope;
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
          message: e.message ?? "Unable to load cases.",
        });
      }
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
          workspace.code === "auth_required" ||
          workspace.code === "permission_denied"
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
    void reload();
  }, [workspace.status, workspace.status === "ready" ? workspace.workspaceId : null, reload]);

  const onCreateCase = useCallback(async () => {
    if (workspace.status !== "ready") return;
    const name = window.prompt("Case name");
    if (!name?.trim()) return;
    setCreating(true);
    try {
      await apiFetch("/v1/cases", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      await reload();
    } catch (err) {
      const e = err as { message?: string };
      window.alert(`Could not create case: ${e.message ?? "unknown error"}`);
    } finally {
      setCreating(false);
    }
  }, [workspace.status, reload]);

  if (state.status === "loading") {
    return <CasesLoading />;
  }
  if (state.status === "no_workspace") {
    return <CasesNoWorkspace />;
  }
  if (state.status === "auth_error") {
    return <CasesAuthError code={state.code} />;
  }
  if (state.status === "unavailable") {
    return <CasesUnavailable message={state.message} />;
  }

  const { envelope } = state;
  const { workspace: ws, sections } = envelope;
  const isTeam = ws.scope === "TEAM";
  const canCreate =
    ws.role === "OWNER" ||
    ws.role === "ADMIN" ||
    ws.role === "MEMBER" ||
    ws.role === "REVIEWER";

  const filtered = filterCases(sections.cases.items, filter, search);

  return (
    <main className="cc-page" data-cases-index>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Investigation Workspaces</div>
          <h1 className="cc-title">Cases &amp; Matters</h1>
          <p className="cc-subtitle">
            Coordination layer for linked evidence, review workflows, and legal
            preservation. Read-only browse — explicit actions remain authoritative.
          </p>
        </div>
        <div className="cc-meta">
          <span data-cases-workspace-scope={ws.scope}>
            {ws.scope === "PERSONAL"
              ? "Personal workspace"
              : `Team workspace · ${ws.memberCount} members`}
          </span>
          {canCreate ? (
            <button
              type="button"
              className="cc-quick-action is-primary"
              onClick={onCreateCase}
              disabled={creating}
              data-cases-create-button
            >
              {creating ? "Creating…" : "Create case"}
            </button>
          ) : null}
        </div>
      </header>

      {/* Operational summary strip */}
      {sections.summary.status === "ok" && sections.summary.data ? (
        <section className="cc-section" data-cases-summary>
          <header className="cc-section-header">
            <h2 className="cc-section-title">Operational Summary</h2>
          </header>
          <div className="cc-summary-strip">
            <div className="cc-summary-card" data-cases-summary-key="total">
              <span className="cc-summary-card-value">
                {sections.summary.data.totalCases}
              </span>
              <span className="cc-summary-card-label">Total cases</span>
            </div>
            <div
              className="cc-summary-card"
              data-cases-summary-key="with_evidence"
            >
              <span className="cc-summary-card-value">
                {sections.summary.data.casesWithEvidence}
              </span>
              <span className="cc-summary-card-label">With evidence</span>
            </div>
            {isTeam ? (
              <>
                <div
                  className="cc-summary-card"
                  data-cases-summary-key="with_holds"
                >
                  <span className="cc-summary-card-value">
                    {sections.summary.data.casesWithActiveHolds}
                  </span>
                  <span className="cc-summary-card-label">
                    Active legal preservation
                  </span>
                </div>
                <div
                  className="cc-summary-card"
                  data-cases-summary-key="with_review"
                >
                  <span className="cc-summary-card-value">
                    {sections.summary.data.casesWithPendingReview}
                  </span>
                  <span className="cc-summary-card-label">
                    With pending review
                  </span>
                </div>
              </>
            ) : null}
          </div>
        </section>
      ) : (
        <section className="cc-section">
          <header className="cc-section-header">
            <h2 className="cc-section-title">Operational Summary</h2>
          </header>
          <div
            className="cc-section-note"
            data-cc-section-status={sections.summary.status}
          >
            Summary is temporarily unavailable. The case list below remains usable.
          </div>
        </section>
      )}

      {/* Filters */}
      <section className="cc-section" data-cases-filters>
        <header className="cc-section-header">
          <h2 className="cc-section-title">Filters</h2>
        </header>
        <div className="cases-filter-row">
          <input
            type="search"
            className="cases-filter-search"
            placeholder="Search by case name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-cases-search-input
          />
          <div className="cases-filter-chips" role="tablist" aria-label="Case filters">
            <FilterChip
              active={filter === "all"}
              onClick={() => setFilter("all")}
              label="All"
              dataKey="all"
            />
            <FilterChip
              active={filter === "with_evidence"}
              onClick={() => setFilter("with_evidence")}
              label="With evidence"
              dataKey="with_evidence"
            />
            {isTeam ? (
              <>
                <FilterChip
                  active={filter === "with_holds"}
                  onClick={() => setFilter("with_holds")}
                  label="Active preservation"
                  dataKey="with_holds"
                />
                <FilterChip
                  active={filter === "with_review"}
                  onClick={() => setFilter("with_review")}
                  label="Pending review"
                  dataKey="with_review"
                />
              </>
            ) : null}
          </div>
        </div>
      </section>

      {/* Cases list */}
      <section className="cc-section" data-cases-list>
        <header className="cc-section-header">
          <h2 className="cc-section-title">
            {filtered.length === sections.cases.items.length
              ? `Cases · ${filtered.length}`
              : `Cases · ${filtered.length} of ${sections.cases.items.length}`}
          </h2>
        </header>
        {sections.cases.status !== "ok" ? (
          <div
            className="cc-section-note"
            data-cc-section-status={sections.cases.status}
          >
            Cases are temporarily unavailable. Retry shortly.
          </div>
        ) : filtered.length === 0 ? (
          <CasesEmptyState
            hasAny={sections.cases.items.length > 0}
            canCreate={canCreate}
            onCreate={onCreateCase}
          />
        ) : (
          <ul className="cases-list" data-cases-list-items>
            {filtered.map((c) => (
              <li key={c.id} className="cases-row" data-cases-row-id={c.id}>
                <Link href={`/cases/${c.id}`} className="cases-row-link">
                  <div className="cases-row-main">
                    <span className="cases-row-title">{c.name}</span>
                    <span
                      className="cases-row-scope"
                      data-cases-row-scope={c.scope}
                    >
                      {c.scope === "PERSONAL" ? "Personal" : "Team"}
                    </span>
                  </div>
                  <div className="cases-row-meta">
                    <span data-cases-row-evidence={c.linkedEvidenceCount}>
                      {c.linkedEvidenceCount} evidence
                    </span>
                    {c.hasActiveLegalHold ? (
                      <span
                        className="cases-row-chip"
                        data-cases-row-chip="hold"
                      >
                        Legal preservation
                      </span>
                    ) : null}
                    {c.pendingReviewCount > 0 ? (
                      <span
                        className="cases-row-chip"
                        data-cases-row-chip="review"
                      >
                        {c.pendingReviewCount} pending review
                      </span>
                    ) : null}
                    <time
                      dateTime={c.updatedAt}
                      data-cases-row-updated
                      title={c.updatedAt}
                    >
                      Updated {formatRelativeTime(c.updatedAt)}
                    </time>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function filterCases(
  items: CaseSummaryItem[],
  filter: StatusFilter,
  search: string,
): CaseSummaryItem[] {
  const q = search.trim().toLowerCase();
  let out = items;
  if (q) {
    out = out.filter((c) => c.name.toLowerCase().includes(q));
  }
  switch (filter) {
    case "all":
      return out;
    case "with_evidence":
      return out.filter((c) => c.linkedEvidenceCount > 0);
    case "with_holds":
      return out.filter((c) => c.hasActiveLegalHold);
    case "with_review":
      return out.filter((c) => c.pendingReviewCount > 0);
  }
}

function FilterChip({
  active,
  onClick,
  label,
  dataKey,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  dataKey: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`cases-filter-chip ${active ? "is-active" : ""}`}
      data-cases-filter={dataKey}
    >
      {label}
    </button>
  );
}

function CasesEmptyState({
  hasAny,
  canCreate,
  onCreate,
}: {
  hasAny: boolean;
  canCreate: boolean;
  onCreate: () => void;
}) {
  if (hasAny) {
    return (
      <div className="cc-section-note" data-cases-empty="filtered">
        No cases match the current filter or search.
      </div>
    );
  }
  return (
    <div className="cases-empty" data-cases-empty="none">
      <strong>No cases yet.</strong>
      <p>
        Cases coordinate evidence, review workflows, and legal preservation
        across an investigation or matter.
      </p>
      {canCreate ? (
        <button
          type="button"
          className="cc-quick-action is-primary"
          onClick={onCreate}
        >
          Create your first case
        </button>
      ) : null}
    </div>
  );
}

function CasesLoading() {
  return (
    <main className="cc-page" data-cases-loading>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Investigation Workspaces</div>
          <h1 className="cc-title">Cases &amp; Matters</h1>
        </div>
      </header>
      <section className="cc-section">
        <div className="cc-skeleton" />
      </section>
    </main>
  );
}

function CasesNoWorkspace() {
  return (
    <main className="cc-page" data-cases-no-workspace>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Investigation Workspaces</div>
          <h1 className="cc-title">No workspace selected</h1>
          <p className="cc-subtitle">
            Switch to a workspace to view cases.
          </p>
        </div>
      </header>
    </main>
  );
}

function CasesAuthError({
  code,
}: {
  code: "auth_required" | "permission_denied";
}) {
  return (
    <main className="cc-page" data-cases-auth-error={code}>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Investigation Workspaces</div>
          <h1 className="cc-title">
            {code === "auth_required"
              ? "Sign in required"
              : "Permission required"}
          </h1>
          <p className="cc-subtitle">
            {code === "auth_required"
              ? "Sign in to view cases."
              : "You do not have permission to view cases for this workspace."}
          </p>
        </div>
      </header>
    </main>
  );
}

function CasesUnavailable({ message }: { message: string }) {
  return (
    <main className="cc-page" data-cases-unavailable>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Investigation Workspaces</div>
          <h1 className="cc-title">Temporarily unavailable</h1>
          <p className="cc-subtitle">{message}</p>
        </div>
      </header>
    </main>
  );
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
