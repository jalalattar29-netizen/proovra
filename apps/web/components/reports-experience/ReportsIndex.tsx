"use client";

/**
 * Phase 32.8D — Enterprise Reports & Artifacts deliverables index.
 *
 * Powered by `/v1/reports/artifacts` (read-only aggregator). The
 * page surfaces report + verification-package lifecycle state for
 * workspace evidence WITHOUT calling any of the side-effecting
 * download endpoints (`/v1/evidence/:id/report/latest`,
 * `/v1/evidence/:id/verification-package`). Those remain reachable
 * exclusively through the explicit "Open evidence" link in each
 * row → the existing evidence-detail download flow.
 *
 * Hard rules:
 *   - Browse is NEVER a download. Page-mount emits no custody
 *     events, no signed-URL generation, no audit log writes.
 *   - Every count comes from the aggregator. No fake numbers,
 *     no decorative charts, no fabricated readiness.
 *   - Reports are described as "generated snapshots" / "verification
 *     packages". The page makes NO legal-admissibility,
 *     authenticity, or "court-ready" claims.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import { useTeamWorkspaceGate } from "../../lib/platform-context";
import type {
  ArtifactRow,
  LifecycleFilter,
  PackageLifecycle,
  ReportLifecycle,
  ReportsArtifactsEnvelope,
} from "./types";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; envelope: ReportsArtifactsEnvelope }
  | { status: "no_workspace" }
  | { status: "auth_error"; code: "auth_required" | "permission_denied" }
  | { status: "unavailable"; message: string };

export function ReportsIndex() {
  const workspace = useTeamWorkspaceGate();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [filter, setFilter] = useState<LifecycleFilter>("all");
  const [search, setSearch] = useState("");

  const reload = useCallback(
    async (currentFilter: LifecycleFilter, currentSearch: string) => {
      if (workspace.status !== "ready") return;
      setState({ status: "loading" });
      const params = new URLSearchParams({
        teamId: workspace.workspaceId,
        lifecycle: currentFilter,
      });
      const trimmed = currentSearch.trim();
      if (trimmed) params.set("search", trimmed.slice(0, 80));
      try {
        const envelope = (await apiFetch(
          `/v1/reports/artifacts?${params.toString()}`,
          { method: "GET" },
        )) as ReportsArtifactsEnvelope;
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
            message: e.message ?? "Unable to load artifacts.",
          });
        }
      }
    },
    [workspace.status, workspace.status === "ready" ? workspace.workspaceId : null],
  );

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
    void reload(filter, search);
    // Reload when the workspace switches.
  }, [
    workspace.status,
    workspace.status === "ready" ? workspace.workspaceId : null,
  ]);

  // Trigger a server re-query when the filter changes (server already
  // honors the `lifecycle` param). Search is debounced client-side.
  useEffect(() => {
    if (workspace.status !== "ready") return;
    const t = setTimeout(() => {
      void reload(filter, search);
    }, search ? 250 : 0);
    return () => clearTimeout(t);
  }, [filter, search, reload, workspace.status]);

  if (state.status === "loading") {
    return <ReportsLoading />;
  }
  if (state.status === "no_workspace") {
    return <ReportsNoWorkspace />;
  }
  if (state.status === "auth_error") {
    return <ReportsAuthError code={state.code} />;
  }
  if (state.status === "unavailable") {
    return <ReportsUnavailable message={state.message} />;
  }

  const { envelope } = state;
  const { sections } = envelope;

  return (
    <main className="cc-page" data-reports-index>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Deliverables</div>
          <h1 className="cc-title">Reports &amp; Artifacts</h1>
          <p className="cc-subtitle">
            Generated report snapshots and verification packages. These are
            workspace deliverables — they record integrity at the time of
            generation and do NOT assert legal admissibility, authenticity, or
            "court-ready" status.
          </p>
        </div>
        <div className="cc-meta">
          <span title={envelope.generatedAt}>
            Refreshed {formatRelativeTime(envelope.generatedAt)}
          </span>
        </div>
      </header>

      {/* Operational summary */}
      {sections.summary.status === "ok" && sections.summary.data ? (
        <section className="cc-section" data-reports-summary>
          <header className="cc-section-header">
            <h2 className="cc-section-title">Operational Summary</h2>
          </header>
          <div className="cc-summary-strip">
            <SummaryTile
              keyId="reports_ready"
              label="Reports generated"
              value={sections.summary.data.reportsReady}
            />
            <SummaryTile
              keyId="reports_pending"
              label="Reports pending"
              value={sections.summary.data.reportsPending}
            />
            <SummaryTile
              keyId="packages_ready"
              label="Packages ready"
              value={sections.summary.data.packagesReady}
            />
            <SummaryTile
              keyId="packages_pending"
              label="Packages pending"
              value={sections.summary.data.packagesPending}
            />
            <SummaryTile
              keyId="packages_blocked"
              label="Packages blocked"
              value={sections.summary.data.packagesBlocked}
              severe={sections.summary.data.packagesBlocked > 0}
            />
            <SummaryTile
              keyId="total_artifacts"
              label="Evidence with artifacts"
              value={sections.summary.data.totalEvidenceWithArtifacts}
            />
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
            Summary is temporarily unavailable. The artifact list below remains usable.
          </div>
        </section>
      )}

      {/* Filters */}
      <section className="cc-section" data-reports-filters>
        <header className="cc-section-header">
          <h2 className="cc-section-title">Filters</h2>
        </header>
        <div className="cases-filter-row">
          <input
            type="search"
            className="cases-filter-search"
            placeholder="Search by evidence title"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-reports-search-input
          />
          <div
            className="cases-filter-chips"
            role="tablist"
            aria-label="Artifact lifecycle filters"
          >
            {(
              [
                ["all", "All"],
                ["report_ready", "Report ready"],
                ["report_pending", "Report pending"],
                ["package_ready", "Package ready"],
                ["package_pending", "Package pending"],
                ["package_blocked", "Package blocked"],
              ] as Array<[LifecycleFilter, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={filter === key}
                onClick={() => setFilter(key)}
                className={`cases-filter-chip ${filter === key ? "is-active" : ""}`}
                data-reports-filter={key}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Artifact list */}
      <section className="cc-section" data-reports-list>
        <header className="cc-section-header">
          <h2 className="cc-section-title">
            Artifacts · {sections.artifacts.items.length}
          </h2>
        </header>
        {sections.artifacts.status !== "ok" ? (
          <div
            className="cc-section-note"
            data-cc-section-status={sections.artifacts.status}
          >
            Artifact list is temporarily unavailable. Retry shortly.
          </div>
        ) : sections.artifacts.items.length === 0 ? (
          <ReportsEmptyState filter={filter} />
        ) : (
          <ul className="cases-list" data-reports-list-items>
            {sections.artifacts.items.map((row) => (
              <ArtifactRowView key={row.evidenceId} row={row} />
            ))}
          </ul>
        )}
        {sections.artifacts.nextCursor ? (
          <div className="cc-section-foot">
            More artifacts available — refine filters or open the evidence
            library for a full paginated view.
          </div>
        ) : null}
      </section>

      <section className="cc-section" data-reports-footnote>
        <div className="cc-section-note" data-cc-section-status="not_applicable">
          Browsing this page never triggers report or package generation,
          never generates a signed download URL, and never marks any artifact
          as viewed. Use the per-evidence detail page to explicitly download a
          deliverable.
        </div>
      </section>
    </main>
  );
}

function SummaryTile({
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
      className="cc-summary-card"
      data-reports-summary-key={keyId}
      data-cc-tile-severe={severe ? "true" : "false"}
    >
      <span className="cc-summary-card-value">{value}</span>
      <span className="cc-summary-card-label">{label}</span>
    </div>
  );
}

function ArtifactRowView({ row }: { row: ArtifactRow }) {
  return (
    <li className="cases-row" data-reports-row-id={row.evidenceId}>
      <Link href={`/evidence/${row.evidenceId}`} className="cases-row-link">
        <div className="cases-row-main">
          <span className="cases-row-title">{row.title}</span>
          <span className="cases-row-scope">{humanize(row.type)}</span>
        </div>
        <div className="cases-row-meta">
          <span
            className="cases-row-chip"
            data-reports-report-state={row.report.state}
          >
            Report: {reportLabel(row.report.state)}
            {row.report.version ? ` · v${row.report.version}` : ""}
          </span>
          <span
            className="cases-row-chip"
            data-reports-package-state={row.package.state}
          >
            Package: {packageLabel(row.package.state)}
            {row.package.version ? ` · v${row.package.version}` : ""}
          </span>
          {row.verificationStatus ? (
            <span data-reports-verification={row.verificationStatus}>
              Integrity {humanize(row.verificationStatus)}
            </span>
          ) : null}
          {row.caseId ? (
            <Link
              href={`/cases/${row.caseId}`}
              onClick={(e) => e.stopPropagation()}
              data-reports-case-link={row.caseId}
            >
              Case #{row.caseId.slice(0, 6)}
            </Link>
          ) : null}
          <time dateTime={row.createdAt}>
            Captured {formatRelativeTime(row.createdAt)}
          </time>
          {row.package.blockedReason ? (
            <span
              className="cases-row-chip"
              data-reports-package-blocked-reason={row.package.blockedReason}
            >
              Export blocked by governance: {row.package.blockedReason}
            </span>
          ) : null}
        </div>
      </Link>
    </li>
  );
}

function reportLabel(state: ReportLifecycle): string {
  switch (state) {
    case "ready":
      return "ready";
    case "pending":
      return "pending";
    case "failed":
      return "failed";
    case "unavailable":
      return "unavailable";
    case "not_requested":
      return "not requested";
  }
}

function packageLabel(state: PackageLifecycle): string {
  switch (state) {
    case "ready":
      return "ready";
    case "pending":
      return "pending";
    case "blocked":
      return "blocked by governance";
    case "failed":
      return "failed";
    case "unavailable":
      return "unavailable";
    case "not_requested":
      return "not requested";
  }
}

function ReportsEmptyState({ filter }: { filter: LifecycleFilter }) {
  return (
    <div className="cases-empty" data-reports-empty={filter}>
      <strong>No artifacts match the current filter.</strong>
      <p>
        Reports and verification packages are generated by the evidence pipeline
        after a record is signed. Capture evidence or signal finalization on the
        evidence detail page to populate this list.
      </p>
      <Link href="/evidence" className="cc-quick-action">
        Open evidence library
      </Link>
    </div>
  );
}

function ReportsLoading() {
  return (
    <main className="cc-page" data-reports-loading>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Deliverables</div>
          <h1 className="cc-title">Reports &amp; Artifacts</h1>
        </div>
      </header>
      <section className="cc-section">
        <div className="cc-skeleton" />
      </section>
    </main>
  );
}

function ReportsNoWorkspace() {
  return (
    <main className="cc-page" data-reports-no-workspace>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Deliverables</div>
          <h1 className="cc-title">No workspace selected</h1>
          <p className="cc-subtitle">
            Switch to a workspace to view its artifacts.
          </p>
        </div>
      </header>
    </main>
  );
}

function ReportsAuthError({
  code,
}: {
  code: "auth_required" | "permission_denied";
}) {
  return (
    <main className="cc-page" data-reports-auth-error={code}>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Deliverables</div>
          <h1 className="cc-title">
            {code === "auth_required"
              ? "Sign in required"
              : "Permission required"}
          </h1>
          <p className="cc-subtitle">
            {code === "auth_required"
              ? "Sign in to view artifacts."
              : "You do not have permission to view artifacts for this workspace."}
          </p>
        </div>
      </header>
    </main>
  );
}

function ReportsUnavailable({ message }: { message: string }) {
  return (
    <main className="cc-page" data-reports-unavailable>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Deliverables</div>
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
