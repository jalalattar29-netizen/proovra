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
import {
  resolvePersonaEmptyState,
  usePersonaProfile,
  usePlatformContext,
  useWorkspaceId,
  workflowFromPersona,
} from "../../lib/platform-context";
import { HintCallout } from "../persona/HintCallout";
import { ContextualHelp } from "../contextual-help/ContextualHelp";
import { AccessGate } from "../access/AccessGate";
// Phase G3.2 — every Report PDF / Verification Package ZIP download
// MUST route through the governance pre-flight wrapper. The wrapper
// keys on the same `/v1/governance/export-eligibility` endpoint the
// evidence detail page already consumes; blocked verdicts disable the
// button + surface the reason inline.
import { GovernedExportAction } from "../governance/GovernedExportAction";
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

// Phase IA-self-serve-regression-fix — user-scoped fallback. Shape
// returned by GET /v1/reports (see services/api/src/routes/reports.routes.ts).
type UserReportRow = {
  evidenceId: string;
  title: string | null;
  type: string;
  status: string;
  caseId: string | null;
  createdAt: string;
  report: {
    available: boolean;
    version: number | null;
    generatedAtUtc: string | null;
  };
  package: {
    available: boolean;
    version: number | null;
    generatedAtUtc: string | null;
  };
};
type UserReportsEnvelope = {
  items: UserReportRow[];
  nextCursor: string | null;
};

/**
 * Phase IA-self-serve-regression-fix — call the user-scoped reports
 * endpoint and adapt its shape into the artifact-envelope shape the
 * rest of this component renders without changes. Returns null on
 * any failure (network, 5xx, parse) so the caller can preserve the
 * existing error message rather than masking it.
 *
 * The mapping is conservative:
 *   * `report.state = "ready"` when the user-scoped endpoint says a
 *     Report row exists; "not_requested" otherwise.
 *   * `package.state = "ready"` when a VerificationPackage row
 *     exists; "not_requested" otherwise.
 *   * `verificationStatus` is omitted (null) because the user-scoped
 *     endpoint doesn't include the integrity-verification column.
 *   * Summary section is reported as `unavailable` so the page
 *     gracefully degrades to "the artifact list below remains
 *     usable" — the summary tiles are advisory only.
 */
async function tryUserScopedReports(): Promise<ReportsArtifactsEnvelope | null> {
  try {
    const envelope = (await apiFetch(`/v1/reports`, {
      method: "GET",
    })) as UserReportsEnvelope;
    const items: ArtifactRow[] = (envelope.items ?? []).map((row) => ({
      evidenceId: row.evidenceId,
      title: row.title ?? "Untitled evidence",
      type: row.type,
      status: row.status,
      verificationStatus: null,
      caseId: row.caseId,
      createdAt: row.createdAt,
      report: {
        state: row.report.available ? "ready" : "not_requested",
        version: row.report.version,
        generatedAtUtc: row.report.generatedAtUtc,
      },
      package: {
        state: row.package.available ? "ready" : "not_requested",
        version: row.package.version,
        generatedAtUtc: row.package.generatedAtUtc,
        blockedReason: null,
      },
    }));
    return {
      generatedAt: new Date().toISOString(),
      workspace: { id: "user-scoped", role: "USER" },
      sections: {
        summary: { status: "unavailable", data: null },
        artifacts: {
          status: "ok",
          items,
          nextCursor: envelope.nextCursor,
        },
      },
    };
  } catch {
    return null;
  }
}

export function ReportsIndex() {
  // Phase EMERGENCY-RECOVERY — Reports works for ANY active workspace
  // (personal Team with isPersonal=true OR a real team). Both have a
  // valid Team UUID after the workspace-bootstrap fix, so we consume
  // the canonical workspace id instead of gating on team-only mode.
  const { state: ctxState } = usePlatformContext();
  const workspaceId = useWorkspaceId();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [filter, setFilter] = useState<LifecycleFilter>("all");
  const [search, setSearch] = useState("");
  // Phase 38.17 — workflow-aware contextual help.
  const personaProfileForHelp = usePersonaProfile();
  const reportsWorkflowCode = workflowFromPersona(
    personaProfileForHelp.primaryProfile,
  ).code;

  const reload = useCallback(
    async (currentFilter: LifecycleFilter, currentSearch: string) => {
      if (!workspaceId) return;
      setState({ status: "loading" });
      const params = new URLSearchParams({
        teamId: workspaceId,
        lifecycle: currentFilter,
      });
      const trimmed = currentSearch.trim();
      if (trimmed) params.set("search", trimmed.slice(0, 80));
      try {
        const envelope = (await apiFetch(
          `/v1/reports/artifacts?${params.toString()}`,
          { method: "GET" },
        )) as ReportsArtifactsEnvelope;
        // Phase IA-self-serve-regression-fix — workspace-scoped
        // aggregator returned 200 but with zero artifacts. For
        // self-serve PERSONAL workspace users that's a known false
        // negative: the bootstrap may have missed the TeamMember
        // row, or evidence may live under a different teamId than
        // the active workspace. Re-query the user-scoped fallback
        // (`/v1/reports`) which finds reports via evidence
        // ownership + ANY active team membership the user holds.
        if (
          envelope.sections.artifacts.status === "ok" &&
          envelope.sections.artifacts.items.length === 0
        ) {
          const recovered = await tryUserScopedReports();
          if (recovered) {
            setState({ status: "ready", envelope: recovered });
            return;
          }
        }
        setState({ status: "ready", envelope });
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        // Phase IA-self-serve-regression-fix — 404 from the
        // workspace-scoped aggregator means "you are not a
        // TeamMember of the supplied teamId". For self-serve
        // PERSONAL users that's a known bootstrap gap; fall back
        // to the user-scoped list instead of surfacing the error.
        if (e.statusCode === 404) {
          const recovered = await tryUserScopedReports();
          if (recovered) {
            setState({ status: "ready", envelope: recovered });
            return;
          }
        }
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
    [workspaceId],
  );

  useEffect(() => {
    if (ctxState.name === "IDLE" || ctxState.name === "LOADING_CONTEXT") {
      setState({ status: "loading" });
      return;
    }
    if (ctxState.name === "FAILED") {
      const isAuth =
        ctxState.errorCode === "AUTH_REQUIRED" ||
        ctxState.errorCode === "PERMISSION_DENIED";
      setState({
        status: isAuth ? "auth_error" : "unavailable",
        code:
          ctxState.errorCode === "PERMISSION_DENIED"
            ? "permission_denied"
            : "auth_required",
        message: ctxState.message,
      } as LoadState);
      return;
    }
    if (!workspaceId) {
      setState({ status: "no_workspace" });
      return;
    }
    void reload(filter, search);
    // Reload when the workspace switches.
  }, [ctxState.name, workspaceId]);

  // Trigger a server re-query when the filter changes (server already
  // honors the `lifecycle` param). Search is debounced client-side.
  useEffect(() => {
    if (!workspaceId) return;
    const t = setTimeout(() => {
      void reload(filter, search);
    }, search ? 250 : 0);
    return () => clearTimeout(t);
  }, [filter, search, reload, workspaceId]);

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
          {/* Phase 14 — deep link from the reports index into the
              canonical /search surface, pre-filtered to REPORT
              documents so operators can search across generated
              report snapshots. */}
          <Link
            href="/search?documentType=REPORT"
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "#1e40af",
              textDecoration: "none",
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              borderRadius: 999,
              padding: "4px 12px",
              marginRight: 12,
            }}
          >
            Search reports
          </Link>
          <span title={envelope.generatedAt}>
            Refreshed {formatRelativeTime(envelope.generatedAt)}
          </span>
        </div>
      </header>

      {/* Phase 38.17 — workflow-aware contextual help, collapsed by
          default so the reports/artifacts queue stays primary. */}
      <ContextualHelp
        workflow={reportsWorkflowCode}
        surface="reports"
        collapsedByDefault
      />

      {/* Phase 38.4 — persona-aware contextual hint. Dismissible;
          gated on the hint's capabilityKey via useCan; never blocks
          the page. */}
      <HintCallout surface="reports" />

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
              <ArtifactRowView
                key={row.evidenceId}
                row={row}
                teamId={workspaceId}
              />
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
          Browsing this page never triggers report or package generation
          and never marks any artifact as viewed. Signed download URLs are
          only minted on explicit per-row action (the Download buttons
          above), the same gated path used by the evidence-detail page.
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

function ArtifactRowView({
  row,
  teamId,
}: {
  row: ArtifactRow;
  teamId: string | null;
}) {
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
      {/* Phase 2.1 — Explicit per-row download actions. The page
          remains side-effect-free on browse (mount does NOT call any
          download endpoint). These buttons only fire on EXPLICIT user
          click, mirroring the evidence-detail download flow. The
          backend (`/v1/evidence/:id/report/latest`,
          `/v1/evidence/:id/verification-package`) still gates on
          workspace policy + retention; this UI never simulates
          permission. */}
      <ArtifactRowActions row={row} teamId={teamId} />
    </li>
  );
}

/**
 * Phase 2.1 — per-row download actions. Only renders buttons for
 * states that have an actionable next step. Non-actionable states
 * (pending / not_requested / unavailable) get a quiet help label
 * instead — never a dead button.
 */
function ArtifactRowActions({
  row,
  teamId,
}: {
  row: ArtifactRow;
  teamId: string | null;
}) {
  // Phase A.1D — busy tag widened to include the "regen" retry path
  // for the new `POST /v1/evidence/:id/reports/regenerate` endpoint.
  const [busy, setBusy] = useState<null | "report" | "package" | "regen">(null);
  const [error, setError] = useState<string | null>(null);
  // Phase A.1D — explicit notice when a regen has just been enqueued
  // so the operator sees acknowledgement without leaving the row.
  const [regenNotice, setRegenNotice] = useState<string | null>(null);

  const triggerReport = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy("report");
    setError(null);
    try {
      const resp = (await apiFetch(
        `/v1/evidence/${row.evidenceId}/report/latest`,
        { method: "GET" },
      )) as { url?: string };
      if (resp.url) {
        // Open in a new tab so the operator keeps the Reports queue
        // intact behind the download.
        window.open(resp.url, "_blank", "noopener,noreferrer");
      } else {
        setError("Report URL is unavailable.");
      }
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode === 202) {
        setError("Report is still generating. Try again in a moment.");
      } else if (e.statusCode === 403) {
        setError("You don't have permission to download this report.");
      } else if (e.statusCode === 409) {
        setError(
          e.message ?? "Report download blocked by workspace policy.",
        );
      } else {
        setError(e.message ?? "Could not start download.");
      }
    } finally {
      setBusy(null);
    }
  };

  const triggerPackage = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy("package");
    setError(null);
    try {
      const resp = (await apiFetch(
        `/v1/evidence/${row.evidenceId}/verification-package`,
        { method: "GET" },
      )) as { url?: string; code?: string; message?: string };
      if (resp.url) {
        window.open(resp.url, "_blank", "noopener,noreferrer");
      } else if (resp.code === "verification_package_pending") {
        setError(resp.message ?? "Package is still generating.");
      } else {
        setError("Package URL is unavailable.");
      }
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode === 202) {
        setError("Package is still generating. Try again in a moment.");
      } else if (e.statusCode === 403) {
        setError("You don't have permission to download this package.");
      } else if (e.statusCode === 409) {
        setError(e.message ?? "Package blocked by workspace policy.");
      } else {
        setError(e.message ?? "Could not start download.");
      }
    } finally {
      setBusy(null);
    }
  };

  // Phase A.1D — operational retry/regenerate CTA. The endpoint
  // re-queues report generation (which in-process re-builds the
  // verification package). Surfaced ONLY for rows where regenerate
  // makes operational sense: a failed report OR a failed package.
  // For "pending" we don't surface retry — generation is still in
  // flight. For "blocked" we don't surface retry — the block is a
  // governance decision, not a generation failure.
  const triggerRegenerate = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy("regen");
    setError(null);
    setRegenNotice(null);
    try {
      const resp = (await apiFetch(
        `/v1/evidence/${row.evidenceId}/reports/regenerate`,
        { method: "POST" },
      )) as { enqueued?: boolean; message?: string; reason?: string | null };
      if (resp.enqueued) {
        setRegenNotice(
          resp.message ??
            "Report regeneration enqueued. Refresh shortly for updated state.",
        );
      } else {
        setRegenNotice(
          resp.message ??
            (resp.reason
              ? `Regeneration not enqueued: ${resp.reason}`
              : "An active job already exists; no new job enqueued."),
        );
      }
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode === 403) {
        setError(
          "Only the evidence owner can regenerate this report. Ask the owner to retry.",
        );
      } else if (e.statusCode === 404) {
        setError("Evidence not found.");
      } else {
        setError(e.message ?? "Could not enqueue regeneration.");
      }
    } finally {
      setBusy(null);
    }
  };

  const reportReady = row.report.state === "ready";
  const packageReady = row.package.state === "ready";
  // Phase A.1D — operational signal: regenerate is offered when either
  // artifact failed. The endpoint refreshes BOTH so one button covers
  // both failures.
  const canRegenerate =
    row.report.state === "failed" || row.package.state === "failed";

  return (
    <div
      className="cases-row-actions"
      data-reports-row-actions={row.evidenceId}
      style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}
    >
      {reportReady ? (
        // Phase G3.2 — every Report PDF download is governed by the
        // export-eligibility preflight. Blocked verdicts disable the
        // button + surface the reason inline; this is the same gate
        // the evidence detail page applies.
        <GovernedExportAction
          evidenceId={row.evidenceId}
          teamId={teamId}
          actionLabel="Download Report PDF"
          compactWhenAllowed
          onAction={() =>
            void triggerReport({
              preventDefault() {},
              stopPropagation() {},
            } as unknown as React.MouseEvent)
          }
          renderAction={({ disabled, onClick }) => (
            <button
              type="button"
              className="btn-secondary"
              data-reports-download-report={row.evidenceId}
              onClick={onClick}
              disabled={busy !== null || disabled}
            >
              {busy === "report" ? "Opening…" : "Download report PDF"}
            </button>
          )}
        />
      ) : (
        <span
          className="cases-row-chip"
          data-reports-report-action-status={row.report.state}
          style={{ opacity: 0.7 }}
        >
          {row.report.state === "pending"
            ? "Report generating — refresh later"
            : row.report.state === "failed"
              ? "Report generation failed — see evidence detail"
              : row.report.state === "not_requested"
                ? "Report not requested for this evidence"
                : "Report unavailable on this plan"}
        </span>
      )}
      {packageReady ? (
        <GovernedExportAction
          evidenceId={row.evidenceId}
          teamId={teamId}
          actionLabel="Download Verification Package ZIP"
          compactWhenAllowed
          onAction={() =>
            void triggerPackage({
              preventDefault() {},
              stopPropagation() {},
            } as unknown as React.MouseEvent)
          }
          renderAction={({ disabled, onClick }) => (
            <button
              type="button"
              className="btn-secondary"
              data-reports-download-package={row.evidenceId}
              onClick={onClick}
              disabled={busy !== null || disabled}
            >
              {busy === "package" ? "Opening…" : "Download verification package"}
            </button>
          )}
        />
      ) : row.package.state === "blocked" ? (
        <span
          className="cases-row-chip"
          data-reports-package-action-status="blocked"
          style={{ opacity: 0.7 }}
        >
          Package blocked — {row.package.blockedReason ?? "governance policy"}
        </span>
      ) : (
        <span
          className="cases-row-chip"
          data-reports-package-action-status={row.package.state}
          style={{ opacity: 0.7 }}
        >
          {row.package.state === "pending"
            ? "Package generating — refresh later"
            : row.package.state === "failed"
              ? "Package generation failed — see evidence detail"
              : row.package.state === "not_requested"
                ? "Package not yet generated"
                : "Package unavailable"}
        </span>
      )}
      {/* Phase A.1D — operational retry CTA. Fires the new audited
          POST /v1/evidence/:id/reports/regenerate endpoint. Visible
          only for failed report OR failed package states. */}
      {canRegenerate ? (
        <button
          type="button"
          className="btn-secondary"
          data-reports-regenerate={row.evidenceId}
          data-reports-regenerate-trigger-report-state={row.report.state}
          data-reports-regenerate-trigger-package-state={row.package.state}
          onClick={triggerRegenerate}
          disabled={busy !== null}
        >
          {busy === "regen" ? "Enqueuing…" : "Retry generation"}
        </button>
      ) : null}
      <Link
        href={`/evidence/${row.evidenceId}`}
        className="btn-secondary"
        data-reports-open-evidence={row.evidenceId}
        onClick={(e) => e.stopPropagation()}
      >
        Open evidence
      </Link>
      {error ? (
        <span
          role="alert"
          data-reports-row-error={row.evidenceId}
          style={{
            color: "#f6c8c8",
            fontSize: 12,
            width: "100%",
            marginTop: 4,
          }}
        >
          {error}
        </span>
      ) : null}
      {regenNotice ? (
        <span
          role="status"
          data-reports-row-regen-notice={row.evidenceId}
          style={{
            color: "#bcd0bc",
            fontSize: 12,
            width: "100%",
            marginTop: 4,
          }}
        >
          {regenNotice}
        </span>
      ) : null}
    </div>
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
  // Phase 38.1 — consume the persona empty-state library. CTAs and copy
  // adapt to the active persona while the canonical Reports surface
  // remains the same route.
  const persona = usePersonaProfile();
  const state = resolvePersonaEmptyState({
    persona: persona.primaryProfile,
    surface: "reports",
  });
  return (
    <div
      className="cases-empty"
      data-reports-empty={filter}
      data-persona-empty-state-persona={persona.primaryProfile}
    >
      <strong>{state.title}</strong>
      <p>{state.body}</p>
      <Link
        href={state.primaryCtaHref}
        className="cc-quick-action"
        data-persona-empty-state-cta
      >
        {state.primaryCtaLabel}
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
  // Phase EMERGENCY-RECOVERY — after the personal-workspace bootstrap,
  // an authenticated user always has at least a personal Team. Landing
  // here means the canonical envelope itself couldn't surface a
  // workspace. The shell renders WorkspaceRecoveryPanel above this in
  // that case; this fallback only shows transient empty UI.
  //
  // Phase 2.2 — replace dead-end text with a structured AccessGate so
  // the operator can browse / switch workspaces or open settings.
  return (
    <main className="cc-page" data-reports-no-workspace>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Deliverables</div>
          <h1 className="cc-title">Reports &amp; Artifacts</h1>
        </div>
      </header>
      <section className="cc-section">
        <AccessGate
          kind="WORKSPACE_REQUIRED"
          surface="Reports"
          headline="Workspace setup pending"
          reason="We're finishing workspace setup, or you haven't picked one yet. Reports + verification packages are scoped to a workspace — pick one to continue."
          actions={[
            { label: "Open workspaces", href: "/teams", variant: "primary" },
            { label: "Open settings", href: "/settings", variant: "secondary" },
          ]}
          testid="reports-access-gate-no-workspace"
        />
      </section>
    </main>
  );
}

function ReportsAuthError({
  code,
}: {
  code: "auth_required" | "permission_denied";
}) {
  // Phase 2.2 — replace dead-end text with a structured AccessGate.
  // The page itself is wrapped in PageRouteGate at the route layer; this
  // surface fires only when /v1/reports/artifacts itself returns 401 or
  // 403 (which can happen for cross-workspace access). AccessGate gives
  // the operator an explicit next step instead of "permission required"
  // text with nothing to click.
  return (
    <main className="cc-page" data-reports-auth-error={code}>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Deliverables</div>
          <h1 className="cc-title">Reports &amp; Artifacts</h1>
        </div>
      </header>
      <section className="cc-section">
        {code === "auth_required" ? (
          <AccessGate
            kind="PERMISSION_REQUIRED"
            surface="Reports"
            headline="Sign in to view artifacts"
            reason="Your session has expired or you aren't signed in. Sign in to load this workspace's report and verification-package state."
            actions={[
              { label: "Sign in", href: "/login", variant: "primary" },
            ]}
            testid="reports-access-gate-auth"
          />
        ) : (
          <AccessGate
            kind="REQUEST_ACCESS"
            surface="Reports"
            headline="You don't have access to this workspace's reports"
            reason="Your role doesn't include report and verification-package access for this workspace. An admin can grant it, or you can switch to a workspace you have access to."
            actions={[
              { label: "Switch workspace", href: "/teams", variant: "primary" },
              { label: "Open settings", href: "/settings", variant: "secondary" },
            ]}
            testid="reports-access-gate-permission"
          />
        )}
      </section>
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
