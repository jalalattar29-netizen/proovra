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

import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import {
  PageShell,
  PageHeader,
  PageSection,
  FilterBar,
} from "../ui";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { FileText } from "lucide-react";
import { apiFetch } from "../../lib/api";
import "./reports.css";
// THE canonical Evidence title cascade — the same one the Evidence Library and
// Case Detail use. Reports read `title` alone and rendered "Untitled evidence"
// over every record whose name lives in a filename field.
import { getDisplayTitle } from "../../app/(app)/evidence/lib/evidence-library-status";
import {
  usePlatformContext,
  useWorkspaceId,
} from "../../lib/platform-context";
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
  ReportsSummary,
} from "./types";

/**
 * THE SUMMARY STRIP, declared once.
 *
 * Tone is the card's identity: the rail and the NUMBER wear it together, the
 * same pattern Operations and Notifications use. The six were previously flat
 * near-black values on an undifferentiated card, so the strip read as one
 * block of digits.
 *
 * The mapping follows the meaning the rest of the product already gives these
 * tones — ready is green, pending amber, blocked red, and the two totals are
 * neutral/blue rather than borrowing an alarm colour for a count that is not
 * one.
 */
const SUMMARY_METRICS = [
  { key: "reports_ready", field: "reportsReady", label: "Reports generated", tone: "blue" },
  { key: "reports_pending", field: "reportsPending", label: "Reports pending", tone: "amber" },
  { key: "packages_ready", field: "packagesReady", label: "Packages ready", tone: "green" },
  { key: "packages_pending", field: "packagesPending", label: "Packages pending", tone: "indigo" },
  { key: "packages_blocked", field: "packagesBlocked", label: "Packages blocked", tone: "red" },
  { key: "total_artifacts", field: "totalEvidenceWithArtifacts", label: "Evidence with artifacts", tone: "slate" },
] as const satisfies ReadonlyArray<{
  key: string;
  field: keyof ReportsSummary;
  label: string;
  tone: string;
}>;

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
  /** Present on the aggregator; the user-scoped route may omit them. */
  displayFileName?: string | null;
  originalFileName?: string | null;
  mimeType?: string | null;
  type: string;
  status: string;
  caseId: string | null;
  caseTitle?: string | null;
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
      // VERBATIM. The display name is resolved once, at render, through the
      // canonical cascade — never substituted at the edge of a fetch.
      title: row.title ?? null,
      displayFileName: row.displayFileName ?? null,
      originalFileName: row.originalFileName ?? null,
      mimeType: row.mimeType ?? null,
      type: row.type,
      status: row.status,
      verificationStatus: null,
      caseId: row.caseId,
      caseTitle: row.caseTitle ?? null,
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
  /** A reload is in flight over results that are already on screen. */
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<LifecycleFilter>("all");
  const [search, setSearch] = useState("");

  const reload = useCallback(
    async (currentFilter: LifecycleFilter, currentSearch: string) => {
      if (!workspaceId) return;
      // ONLY the FIRST load shows the skeleton.
      //
      // This set `{ status: "loading" }` unconditionally, and the render
      // returns `<ReportsLoading />` for that status — so every debounced
      // keystroke tore the whole page down, search input included, and rebuilt
      // it when the response landed. The input lost its DOM node and its focus
      // mid-word, which is the "it reloads before the next character" the
      // operator sees. The debounce was never the problem; the remount was.
      //
      // A reload with results already on screen now keeps them, and marks the
      // list stale instead.
      setState((prev) =>
        prev.status === "ready" ? prev : { status: "loading" },
      );
      setRefreshing(true);
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
        // THE FALLBACK IS A BOOTSTRAP PROBE, NOT AN EMPTY-RESULT HANDLER.
        //
        // It exists for one case: a personal workspace whose TeamMember row
        // the bootstrap missed, where the aggregator legitimately returns
        // zero. It fired on ANY empty result — including the entirely correct
        // emptiness of a search or a lifecycle filter — and
        // `tryUserScopedReports` queries `/v1/reports` with NEITHER the search
        // nor the lifecycle parameter, and reports its summary as
        // `unavailable`.
        //
        // So typing a query produced: the UNFILTERED list back (search looked
        // broken), a filter that appeared to do nothing, and
        // "Summary is temporarily unavailable" — three symptoms, one cause.
        //
        // It now runs ONLY for the unfiltered default view, which is the only
        // shape it was ever able to reason about.
        const isUnfilteredView = currentFilter === "all" && trimmed.length === 0;
        if (
          isUnfilteredView &&
          envelope.sections.artifacts.status === "ok" &&
          envelope.sections.artifacts.items.length === 0
        ) {
          const recovered = await tryUserScopedReports();
          if (recovered) {
            setState({ status: "ready", envelope: recovered });
            return;
          }
        }
        // THE SUMMARY IS A WORKSPACE TOTAL, so it survives a list query that
        // could not produce one. Without this a response whose summary section
        // failed would blank six counters that were correct a moment ago and
        // are still correct — the list changed, the workspace did not.
        setState((prev) => {
          const previousSummary =
            prev.status === "ready" ? prev.envelope.sections.summary : null;
          const incoming = envelope.sections.summary;
          if (incoming.status === "ok" || !previousSummary || previousSummary.status !== "ok") {
            return { status: "ready", envelope };
          }
          return {
            status: "ready",
            envelope: {
              ...envelope,
              sections: { ...envelope.sections, summary: previousSummary },
            },
          };
        });
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
            message: toSafeUserError(e, { message: "Unable to load artifacts." }).message,
          });
        }
      } finally {
        setRefreshing(false);
      }
    },
    [workspaceId],
  );

  // Provider-state scalars, narrowed before the effect so the dependency
  // array is statically checkable.
  const ctxStateName = ctxState.name;
  const ctxErrorCode = ctxState.name === "FAILED" ? ctxState.errorCode : null;
  const ctxMessage = ctxState.name === "FAILED" ? ctxState.message : null;
  // The CURRENT query, read (not subscribed to) by the workspace-switch reload.
  // Filter and search changes are owned by the debounced effect below; firing
  // them from here as well would issue the same request twice.
  const queryRef = useRef({ filter, search, reload });
  queryRef.current = { filter, search, reload };

  useEffect(() => {
    if (ctxStateName === "IDLE" || ctxStateName === "LOADING_CONTEXT") {
      setState({ status: "loading" });
      return;
    }
    if (ctxStateName === "FAILED") {
      const isAuth =
        ctxErrorCode === "AUTH_REQUIRED" ||
        ctxErrorCode === "PERMISSION_DENIED";
      setState({
        status: isAuth ? "auth_error" : "unavailable",
        code:
          ctxErrorCode === "PERMISSION_DENIED"
            ? "permission_denied"
            : "auth_required",
        message: ctxMessage,
      } as LoadState);
      return;
    }
    if (!workspaceId) {
      setState({ status: "no_workspace" });
      return;
    }
    const q = queryRef.current;
    void q.reload(q.filter, q.search);
    // Reload when the workspace switches (or provider state resolves).
  }, [ctxStateName, ctxErrorCode, ctxMessage, workspaceId]);

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

  const lifecycleFilters: Array<[LifecycleFilter, string]> = [
    ["all", "All"],
    ["report_ready", "Report ready"],
    ["report_pending", "Report pending"],
    ["package_ready", "Package ready"],
    ["package_pending", "Package pending"],
    ["package_blocked", "Package blocked"],
  ];

  return (
    <PageShell
      data-reports-index
      header={
        <PageHeader
          eyebrow="Deliverables"
          title={
            /* The canonical title treatment — `.app-title-row` +
               `.app-title-icon`, the same geometry Notifications, Cases and
               Search render. `aria-hidden` because the heading beside it
               already names the page. */
            <span className="app-title-row">
              <span aria-hidden className="app-title-icon">
                <FileText strokeWidth={1.75} data-reports-title-icon />
              </span>
              <span data-reports-title>Reports &amp; Artifacts</span>
            </span>
          }
          subtitle={
            <>
              Generated report snapshots and verification packages. These are
              workspace deliverables — they record integrity at the time of
              generation and do NOT assert legal admissibility, authenticity, or
              "court-ready" status.
            </>
          }
          contextStrip={
            <span
              title={envelope.generatedAt}
              style={{ fontSize: 12.5, color: "var(--ink-muted, #94a3b8)" }}
            >
              Refreshed {formatRelativeTime(envelope.generatedAt)}
            </span>
          }
        />
      }
    >
      {/* THE WORKSPACE STRIP IS GONE (2026-08-26).
          It rendered "Reports & artifacts for Personal Space · Personal
          Space" — the workspace named twice in one line, under a global header
          that already names it a third time. The list re-scopes on switch
          either way (`reload` depends on `workspaceId`), so the strip carried
          no information the page did not already show.

          The contextual help stays: it is a real expandable surface with real
          content about snapshot integrity. It is restyled, not deleted. */}
      <ContextualHelp surface="reports" collapsedByDefault />

      {/* Operational summary */}
      {sections.summary.status === "ok" && sections.summary.data ? (
        <PageSection title="Operational summary" data-reports-summary>
          <ul className="rpt-summary__grid" data-reports-summary-grid>
            {SUMMARY_METRICS.map((m) => (
              <li key={m.key}>
                <div
                  className="app-metric-card rpt-metric"
                  data-rpt-tone={m.tone}
                  data-reports-summary-key={m.key}
                  data-reports-summary-value={String(
                    sections.summary.data![m.field],
                  )}
                >
                  <span className="app-metric-card__value rpt-metric__value">
                    {sections.summary.data![m.field]}
                  </span>
                  <span className="app-metric-card__label rpt-metric__label">
                    {m.label}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </PageSection>
      ) : (
        <PageSection title="Operational summary">
          <Card variant="status" tone="neutral">
            <span
              className="cc-section-note"
              data-cc-section-status={sections.summary.status}
              style={{ color: "var(--ink-secondary, #475569)", fontSize: 13.5 }}
            >
              Summary is temporarily unavailable. The artifact list below remains
              usable.
            </span>
          </Card>
        </PageSection>
      )}

      {/* Filters */}
      <PageSection title="Filters" data-reports-filters>
        <FilterBar>
          <FilterBar.Search
            label="Search by evidence title"
            placeholder="Search by evidence title"
            value={search}
            onChange={setSearch}
            data-reports-search-input
          />
          <div
            className="cases-filter-chips"
            role="tablist"
            aria-label="Artifact lifecycle filters"
          >
            {lifecycleFilters.map(([key, label]) => {
              const active = filter === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setFilter(key)}
                  data-reports-filter={key}
                  className={`cases-filter-chip${active ? " is-active" : ""}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </FilterBar>
      </PageSection>

      {/* Artifact list */}
      <PageSection
        title={`Artifacts · ${sections.artifacts.items.length}`}
        data-reports-list
        data-reports-refreshing={refreshing ? "true" : "false"}
      >
        {sections.artifacts.status !== "ok" ? (
          <Card variant="status" tone="pending">
            <span
              className="cc-section-note"
              data-cc-section-status={sections.artifacts.status}
              style={{ color: "var(--ink-secondary, #475569)", fontSize: 13.5 }}
            >
              Artifact list is temporarily unavailable. Retry shortly.
            </span>
          </Card>
        ) : sections.artifacts.items.length === 0 ? (
          <ReportsEmptyState filter={filter} />
        ) : (
          <ul className="rpt-list" data-reports-list-items>
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
          <div
            className="cc-section-foot"
            style={{
              marginTop: 12,
              fontSize: 12.5,
              color: "var(--ink-muted, #94a3b8)",
            }}
          >
            More artifacts available — refine filters or open the evidence
            library for a full paginated view.
          </div>
        ) : null}
      </PageSection>

      <PageSection data-reports-footnote>
        <div
          className="cc-section-note"
          data-cc-section-status="not_applicable"
          style={{ fontSize: 12.5, color: "var(--ink-muted, #94a3b8)", lineHeight: 1.6 }}
        >
          Browsing this page never triggers report or package generation
          and never marks any artifact as viewed. Signed download URLs are
          only minted on explicit per-row action (the Download buttons
          above), the same gated path used by the evidence-detail page.
        </div>
      </PageSection>
    </PageShell>
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
    <li
      className="rpt-row"
      data-reports-row-id={row.evidenceId}
    >
      <div className="rpt-row__body">
        <Link href={`/evidence/${row.evidenceId}`} className="rpt-row__link">
          {/* A — PRIMARY: the record's name, resolved once through the
              canonical cascade. B — SECONDARY: what it IS, in the neutral
              classification voice, so a kind can never be mistaken for a
              state. */}
          <div className="rpt-row__head">
            <span className="rpt-row__title">
              {getDisplayTitle({
                id: row.evidenceId,
                title: row.title,
                displayFileName: row.displayFileName,
                originalFileName: row.originalFileName,
                type: row.type,
                mimeType: row.mimeType,
                itemCount: null,
              })}
            </span>
            <span className="rpt-row__type">{humanize(row.type)}</span>
          </div>

          {/* C — STATUS / METADATA, one coherent group.
              The two lifecycle states were capsules; they are plain coloured
              text now. Two pills beside an integrity verdict made three chips
              on one line and the eye had nothing to land on. */}
          <div className="rpt-row__meta">
            <span
              className="rpt-status"
              data-tone={reportStatusAttr(row.report.state)}
              data-reports-report-state={row.report.state}
            >
              Report {reportLabel(row.report.state)}
              {row.report.version ? ` · v${row.report.version}` : ""}
            </span>
            <span
              className="rpt-status"
              data-tone={packageStatusAttr(row.package.state)}
              data-reports-package-state={row.package.state}
            >
              Package {packageLabel(row.package.state)}
              {row.package.version ? ` · v${row.package.version}` : ""}
            </span>
            {row.verificationStatus ? (
              /* "Integrity Recorded Integrity Verified" was the raw enum
                 humanised — RECORDED_INTEGRITY_VERIFIED — with the word
                 "Integrity" already in front of it. Same value, same meaning,
                 said once. */
              <span
                className="rpt-status"
                data-tone={integrityToneAttr(row.verificationStatus)}
                data-reports-verification={row.verificationStatus}
              >
                Integrity: {integrityLabel(row.verificationStatus)}
              </span>
            ) : null}
            {row.caseId ? (
              <Link
                href={`/cases/${row.caseId}`}
                onClick={(e) => e.stopPropagation()}
                data-reports-case-link={row.caseId}
                className="rpt-row__case"
              >
                {/* The NAME, not the identifier. A truncated uuid is not
                    something a person recognises; the short id survives only
                    for a legacy row that genuinely has no name. */}
                Case: {row.caseTitle ?? `#${row.caseId.slice(0, 6)}`}
              </Link>
            ) : null}
            <time dateTime={row.createdAt} className="rpt-row__captured">
              Captured {formatRelativeTime(row.createdAt)}
            </time>
            {row.package.blockedReason ? (
              <span
                className="rpt-status"
                data-tone="amber"
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
      </div>
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
          toSafeUserError(e, { message: "Report download blocked by workspace policy." }).message,
        );
      } else {
        setError(toSafeUserError(e, { message: "Could not start download." }).message);
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
        setError("Package is still generating.");
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
        setError(toSafeUserError(e, { message: "Package blocked by workspace policy." }).message);
      } else {
        setError(toSafeUserError(e, { message: "Could not start download." }).message);
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
        setError(toSafeUserError(e, { message: "Could not enqueue regeneration." }).message);
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
      className="rpt-row__actions"
      data-reports-row-actions={row.evidenceId}
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
              /* CANONICAL PURPLE — `app-primary-action`.
                 This was `<Button variant="primary">`, and that legacy
                 variant is the marketing CTA: a coral-to-pink gradient
                 (`--btn-primary-bg`) belonging to the login page, not to the
                 redesigned app. The token keeps its real consumers; this
                 surface simply stops borrowing it. */
              type="button"
              className="app-primary-action rpt-row__action"
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
          className="app-status-badge" data-tone="slate"
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
              /* CANONICAL DARK — the filled secondary variant, which keeps its
                 white label on hover and focus. The legacy `Button` wrapper
                 did not compose with it, so the hover fell through to a pale
                 ground with dark text. */
              type="button"
              className="app-secondary-action app-secondary-action--filled rpt-row__action"
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
          className="app-status-badge" data-tone="slate"
          data-reports-package-action-status="blocked"
          style={{ opacity: 0.7 }}
        >
          Package blocked — {row.package.blockedReason ?? "governance policy"}
        </span>
      ) : (
        <span
          className="app-status-badge" data-tone="slate"
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
        <Button
          variant="secondary"
          size="sm"
          data-reports-regenerate={row.evidenceId}
          data-reports-regenerate-trigger-report-state={row.report.state}
          data-reports-regenerate-trigger-package-state={row.package.state}
          onClick={triggerRegenerate}
          disabled={busy !== null}
        >
          {busy === "regen" ? "Enqueuing…" : "Retry generation"}
        </Button>
      ) : null}
      <Link
        href={`/evidence/${row.evidenceId}`}
        className="app-secondary-action rpt-row__open"
        data-reports-open-evidence={row.evidenceId}
      >
        Open evidence
      </Link>
      {error ? (
        <span
          role="alert"
          data-reports-row-error={row.evidenceId}
          style={{
            color: "#B23442",
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
            color: "#167A5B",
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

// Map artifact lifecycle → the canonical `.app-status-badge[data-tone]`
// vocabulary (green ready · amber pending · red failed · slate neutral).
// This replaces the previous hack of borrowing CASE-STATUS names ("OPEN",
// "ON_HOLD", "CLOSED") purely for their colour, plus the inline red style
// that existed only because the borrowed system had no failed tint.
function reportStatusAttr(state: ReportLifecycle): string {
  switch (state) {
    case "ready":
      return "green";
    case "pending":
      return "amber";
    case "failed":
      return "red";
    default:
      return "slate";
  }
}

function packageStatusAttr(state: PackageLifecycle): string {
  switch (state) {
    case "ready":
      return "green";
    case "pending":
      return "amber";
    case "blocked":
      return "indigo";
    case "failed":
      return "red";
    default:
      return "slate";
  }
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
  // Canonical Reports empty state. (2026-07-20) The per-persona empty
  // state variants were removed with the workspace-persona feature.
  const state = {
    title: "No reports yet",
    body:
      "Reports are generated from signed evidence. Capture or upload evidence to make a report available.",
    primaryCtaLabel: "Open evidence",
    primaryCtaHref: "/evidence",
  };
  return (
    <div className="cases-empty" data-reports-empty={filter}>
      <EmptyState
        framed
        title={state.title}
        purpose={state.body}
        action={
          <Link
            href={state.primaryCtaHref}
            className="cc-quick-action"
            data-reports-empty-state-cta
            style={{
              display: "inline-flex",
              alignItems: "center",
              minHeight: 42,
              padding: "0 18px",
              fontSize: 14,
              fontWeight: 650,
              borderRadius: 12,
              textDecoration: "none",
              background: "var(--btn-primary-bg)",
              color: "var(--btn-primary-color)",
              border: "1px solid var(--btn-primary-border)",
              boxShadow: "var(--btn-primary-shadow)",
            }}
          >
            {state.primaryCtaLabel}
          </Link>
        }
      />
    </div>
  );
}

function ReportsLoading() {
  return (
    <PageShell
      data-reports-loading
      header={
        <PageHeader eyebrow="Deliverables" title="Reports & Artifacts" />
      }
    >
      <PageSection>
        <Card variant="empty" padding="comfortable">
          <div
            style={{
              height: 120,
              borderRadius: "var(--radius-card, 14px)",
              background:
                "linear-gradient(90deg, rgba(15,23,42,0.04), rgba(15,23,42,0.08), rgba(15,23,42,0.04))",
            }}
            aria-hidden="true"
          />
        </Card>
      </PageSection>
    </PageShell>
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
    <PageShell
      data-reports-no-workspace
      header={
        <PageHeader eyebrow="Deliverables" title="Reports & Artifacts" />
      }
    >
      <PageSection>
        <AccessGate
          kind="WORKSPACE_REQUIRED"
          surface="Reports"
          headline="Workspace setup pending"
          reason="We're finishing workspace setup, or you haven't picked one yet. Reports + verification packages are scoped to a workspace — pick one to continue."
          actions={[
            { label: "Open workspaces", href: "/workspaces", variant: "primary" },
            { label: "Open settings", href: "/settings", variant: "secondary" },
          ]}
          testid="reports-access-gate-no-workspace"
        />
      </PageSection>
    </PageShell>
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
    <PageShell
      data-reports-auth-error={code}
      header={
        <PageHeader eyebrow="Deliverables" title="Reports & Artifacts" />
      }
    >
      <PageSection>
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
              { label: "Switch workspace", href: "/workspaces", variant: "primary" },
              { label: "Open settings", href: "/settings", variant: "secondary" },
            ]}
            testid="reports-access-gate-permission"
          />
        )}
      </PageSection>
    </PageShell>
  );
}

function ReportsUnavailable({ message }: { message: string }) {
  return (
    <PageShell
      data-reports-unavailable
      header={
        <PageHeader
          eyebrow="Deliverables"
          title="Temporarily unavailable"
          subtitle={message}
        />
      }
    >
      <PageSection>
        <Card variant="empty" padding="comfortable">
          <EmptyState
            title="Reports & Artifacts couldn't load"
            purpose={message}
          />
        </Card>
      </PageSection>
    </PageShell>
  );
}

/**
 * INTEGRITY, said once.
 *
 * The column carried the raw enum through `humanize`, so
 * `RECORDED_INTEGRITY_VERIFIED` rendered as "Recorded Integrity Verified" —
 * behind a label that already said "Integrity". The word appeared twice and
 * the verdict was buried in the middle of it.
 *
 * The enum is unchanged and so is its meaning; only the leading
 * `RECORDED_INTEGRITY_` prefix is dropped, because the label supplies it. Any
 * value this does not recognise is humanised as before rather than hidden — a
 * state nobody can read is worse than a long one.
 */
function integrityLabel(status: string): string {
  const raw = String(status ?? "").trim().toUpperCase();
  const stripped = raw.replace(/^RECORDED_INTEGRITY_/, "").replace(/^INTEGRITY_/, "");
  return humanize(stripped || raw);
}

/** Verified is the only positive integrity outcome; it alone reads green. */
function integrityToneAttr(status: string): string {
  const raw = String(status ?? "").trim().toUpperCase();
  if (raw.endsWith("VERIFIED")) return "green";
  if (raw.includes("FAIL") || raw.includes("MISMATCH")) return "red";
  return "slate";
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
