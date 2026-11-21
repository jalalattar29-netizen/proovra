"use client";

/**
 * Phase 8 (Enterprise Production Readiness) — SCOPE C.
 * Org admin / Operational reports tab.
 *
 * Lists the org's downloadable OPERATIONAL reports as cards, each with a
 * "Download CSV" button. Every report is backed by a REAL org endpoint
 * (organizations-reports.routes.ts) that serializes EXISTING data — this
 * page never fabricates a dataset and never touches the evidence PDF /
 * verification-package pipeline.
 *
 * Role-appropriate: the caller's org role (from GET /v1/orgs/:id
 * `callerRole`) filters which report cards render, mirroring how the org
 * admin tab bar filters by role (layout.tsx `visibleAdminTabsForRole`).
 * The backend remains the authoritative gate on every endpoint — this is
 * presentation only.
 *
 * PRO-O1-14 — the download-audit report lists the download events of the
 * organization's workspaces (they are tenant-audit rows carrying the record's
 * workspace); the "Not available" badge remains for a card whose data is not
 * held at the org tier.
 *
 * Constitutional checks satisfied:
 *   - Wrapped in <PageRouteGate routeId="account.organization_admin_reports">.
 *   - orgId derives from the URL path param (useParams) — no envelope read.
 *   - No raw window.confirm (read-only downloads).
 *   - Errors surface via toSafeUserError / notifyApiError.
 *   - Strong TypeScript types throughout.
 */

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { apiFetch, apiBaseUrl, readApiToken, isApiResponseError } from "../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";
import { notifyApiError } from "../../../../../../lib/feedback/notify";
import { useToast } from "../../../../../../components/ui-legacy";
import { Card } from "../../../../../../components/ui/Card";
import { Badge } from "../../../../../../components/ui/Badge";
import { Button } from "../../../../../../components/ui/Button";
import { EmptyState } from "../../../../../../components/ui/EmptyState";
import {
  ORG_ROLE_LABEL,
  type OrgRole,
} from "../_lib/orgRoles";

// ---------------------------------------------------------------------------
// Report catalog — declarative so the runtime + the contract test agree.
// Each report maps to a REAL org endpoint. `minRole` mirrors the backend
// gate on that endpoint; `available: false` is an HONEST unavailable card.
// ---------------------------------------------------------------------------

interface ReportDef {
  id: string;
  label: string;
  description: string;
  /** Path suffix under /v1/orgs/:id/reports/. */
  file: string;
  /** Local download filename. */
  filename: string;
  /** Minimum org role the backend requires (visibility mirror). */
  minRole: OrgRole;
  /**
   * PRO-T2-08 — the EXPLICIT role set the export route admits
   * (organizations-reports.routes.ts, AUD-31: never rank — the two rank-3
   * specialists see different exports).
   */
  roles: ReadonlyArray<OrgRole>;
  /** The real backing data source, shown as an honest provenance note. */
  source: string;
  /** When false, the report has no data at the org tier (honest unavailable). */
  available: boolean;
}

const MEMBERS_EXPORT_ROLES: ReadonlyArray<OrgRole> = ["ORG_OWNER", "ORG_ADMIN", "ORG_SECURITY_ADMIN", "ORG_BILLING_ADMIN", "ORG_AUDITOR"];
const SEATS_EXPORT_ROLES: ReadonlyArray<OrgRole> = ["ORG_OWNER", "ORG_ADMIN", "ORG_BILLING_ADMIN"];
const OVERSIGHT_EXPORT_ROLES: ReadonlyArray<OrgRole> = ["ORG_OWNER", "ORG_ADMIN", "ORG_SECURITY_ADMIN", "ORG_AUDITOR"];

const REPORTS: ReadonlyArray<ReportDef> = [
  {
    id: "members",
    label: "Members & roles",
    description:
      "Every org member with their user id, email, display name, org role, and join date.",
    file: "members.csv",
    filename: "org-members.csv",
    minRole: "ORG_AUDITOR",
    roles: MEMBERS_EXPORT_ROLES,
    source: "Organization members",
    available: true,
  },
  {
    id: "seats",
    label: "Seats & plans",
    description:
      "Per-workspace plan, billing status, and included vs. used seats (over-seat flagged). Counts only — no payment data.",
    file: "seats.csv",
    filename: "org-seats.csv",
    minRole: "ORG_BILLING_ADMIN",
    roles: SEATS_EXPORT_ROLES,
    source: "Organization billing summary",
    available: true,
  },
  {
    id: "audit",
    label: "Governance audit log",
    description:
      "Org governance audit events (invites, role changes, policy publishes, exports). Bounded to the most recent 5,000 rows.",
    file: "audit.csv",
    filename: "org-audit.csv",
    minRole: "ORG_AUDITOR",
    roles: OVERSIGHT_EXPORT_ROLES,
    source: "Organization audit events",
    available: true,
  },
  {
    id: "governance",
    label: "Governance posture",
    description:
      "Published retention default + governance posture snapshot for the organization. Honest nulls where nothing is published.",
    file: "governance.csv",
    filename: "org-governance.csv",
    minRole: "ORG_AUDITOR",
    roles: OVERSIGHT_EXPORT_ROLES,
    source: "Retention policies",
    available: true,
  },
  {
    id: "external-access",
    label: "External reviewer access",
    description:
      "External reviewer grants across the org's workspaces — email, role, state, expiry, revocation, and access-activity count. Bounded to the most recent 5,000 grants.",
    file: "external-access.csv",
    filename: "org-external-access.csv",
    minRole: "ORG_AUDITOR",
    roles: OVERSIGHT_EXPORT_ROLES,
    source: "External reviewer assignments in this organization’s workspaces",
    available: true,
  },
  {
    id: "download-audit",
    label: "Evidence download audit",
    description:
      // PRO-O1-14 — download audits carry the record's workspace, so the
      // organization's downloads ARE listed (an API older than this change
      // answers with a single explanatory row instead).
      // M738 — the CSV body carries no truncation note (its shape stays
      // stable for spreadsheet / SIEM consumers); the API signals a cap
      // through response headers, which `download` reads and reports on the
      // card. The copy promises nothing the file itself does not do.
      // NEW-RG-11-3 — the rows name records, so they cover only the records
      // the caller can open (workspace membership + case reach); the
      // organization-wide counts are the summary card below.
      "Report, verification-package and original download events for the records you can open in this organization's workspaces (your workspace membership and case access decide which). Bounded to the most recent 5,000 rows.",
    file: "download-audit.csv",
    filename: "org-download-audit.csv",
    minRole: "ORG_AUDITOR",
    roles: OVERSIGHT_EXPORT_ROLES,
    source: "Download events in this organization's workspace audit, limited to records you can open",
    available: true,
  },
  {
    id: "download-audit-summary",
    label: "Evidence download volume",
    description:
      // NEW-RG-11-3 — the authorized organization-wide aggregate: counts per
      // day, workspace and action. It names no record, person or event.
      "Download counts per day, workspace and download kind across every workspace in the organization. Counts only — no record, person or event identifiers.",
    file: "download-audit-summary.csv",
    filename: "org-download-audit-summary.csv",
    minRole: "ORG_AUDITOR",
    roles: OVERSIGHT_EXPORT_ROLES,
    source: "Download events in this organization's workspace audit (aggregated)",
    available: true,
  },
];

interface OrgHeader {
  organizationId: string;
  callerRole: OrgRole;
}

type Loadable<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string; status: number; requestId?: string };

// AUDIT-003 (2026-08-15): this was a third copy of the API-origin derivation,
// complete with its own production default and its own trailing-slash trim.
// The origin is ONE authority; re-deriving it means a change has to find every
// copy, and a copy that drifts points a whole page at the wrong host.
const API_BASE = apiBaseUrl();

export default function OrganizationAdminReportsPage() {
  return (
    // PRO-T2-08 — gated like the sibling admin leaves (membership; the server
    // decides by organization role), not by the active workspace's plan.
    <PageRouteGate routeId="account.organization-detail">
      <ReportsTab />
    </PageRouteGate>
  );
}

function ReportsTab() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";

  const { addToast } = useToast();
  const [state, setState] = useState<Loadable<OrgHeader>>({ kind: "loading" });
  const [downloading, setDownloading] = useState<string | null>(null);
  // M738 — reports whose last download hit the API's row cap, with the cap
  // the API stated (x-report-truncated / x-report-row-cap). An API that does
  // not expose those headers cross-origin simply yields no notice.
  const [truncatedCaps, setTruncatedCaps] = useState<Record<string, number | null>>({});

  const load = useCallback(async () => {
    if (!orgId) return;
    setState({ kind: "loading" });
    try {
      const data = (await apiFetch(`/v1/orgs/${orgId}`)) as OrgHeader;
      setState({ kind: "ready", data });
    } catch (err) {
      if (isApiResponseError(err)) {
        setState({
          kind: "error",
          message: toSafeUserError(err, { message: "Failed to load." }).message,
          status: err.statusCode ?? 0,
          requestId: err.requestId,
        });
      } else {
        const message = toSafeUserError(err, {
          message: "Failed to load organization.",
        }).message;
        setState({ kind: "error", message, status: 0 });
      }
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Authenticated CSV download. apiFetch returns null for non-JSON bodies,
  // so we do a direct authenticated fetch (mirroring lib/api credentials +
  // x-web-client + bearer) and stream the CSV to a Blob download.
  const download = useCallback(
    async (report: ReportDef) => {
      if (!orgId || downloading) return;
      setDownloading(report.id);
      try {
        const headers = new Headers();
        if (typeof window !== "undefined") headers.set("x-web-client", "1");
        const token = readApiToken();
        if (token) headers.set("authorization", `Bearer ${token}`);

        const res = await fetch(
          `${API_BASE}/v1/orgs/${orgId}/reports/${report.file}`,
          {
            method: "GET",
            headers,
            credentials: "include",
            cache: "no-store",
          },
        );

        if (!res.ok) {
          // Surface a bounded, sanitized error (403/404/429/500 all handled).
          const requestId = res.headers.get("x-request-id") ?? undefined;
          const message =
            res.status === 403 || res.status === 404
              ? `You don't have access to this report (requires ${ORG_ROLE_LABEL[report.minRole]} or higher).`
              : res.status === 429
                ? "Too many report exports. Try again shortly."
                : "Could not download the report. Try again.";
          const err: Error & { statusCode?: number; requestId?: string } =
            new Error(message);
          err.statusCode = res.status;
          err.requestId = requestId;
          notifyApiError(addToast, err, { message });
          return;
        }

        const text = await res.text();
        const truncated = res.headers.get("x-report-truncated") === "true";
        const capRaw = Number(res.headers.get("x-report-row-cap"));
        const cap = Number.isInteger(capRaw) && capRaw > 0 ? capRaw : null;
        setTruncatedCaps((prev) => {
          const next = { ...prev };
          if (truncated) next[report.id] = cap;
          else delete next[report.id];
          return next;
        });
        const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = report.filename;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        notifyApiError(addToast, err, { message: "Failed to download report." });
      } finally {
        setDownloading(null);
      }
    },
    [orgId, downloading, addToast],
  );

  const callerRole = state.kind === "ready" ? state.data.callerRole : null;

  // Role-filter the report cards. Until the role resolves, render nothing
  // sensitive; the backend still gates each endpoint.
  const visibleReports = callerRole
    ? REPORTS.filter((r) => r.roles.includes(callerRole))
    : [];

  return (
    <section
      data-testid="org-admin-reports"
      data-org-id={orgId}
      style={{ display: "flex", flexDirection: "column", gap: 24 }}
    >
      <Card
        variant="summary"
        data-section="reports-intro"
        title="Operational reports"
        subtitle="Export existing organization data as CSV. Each report reads your real records. What you can download depends on your role."
      >
        {state.kind === "loading" ? (
          <div data-state="loading" style={mutedText}>
            Loading…
          </div>
        ) : state.kind === "error" ? (
          <div data-state="error" role="alert" style={{ fontSize: 13 }}>
            {state.status === 403
              ? "You don't have access to this organization."
              : state.message}
            {state.requestId ? (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  fontFamily: "monospace",
                  color: "var(--ink-muted, #94a3b8)",
                }}
              >
                Request id: {state.requestId}
              </div>
            ) : null}
          </div>
        ) : (
          <div
            style={{ fontSize: 13, color: "var(--ink-secondary, #475569)" }}
            data-testid="reports-caller-role"
            data-caller-role={callerRole ?? ""}
          >
            Your role: <strong>{callerRole ? ORG_ROLE_LABEL[callerRole] : "—"}</strong>
            {" · "}
            {visibleReports.length} report
            {visibleReports.length === 1 ? "" : "s"} available to you.
          </div>
        )}
      </Card>

      {state.kind === "ready" ? (
        visibleReports.length === 0 ? (
          <div data-testid="reports-empty">
            <EmptyState
              compact
              framed
              title="No reports available to your role"
              purpose="Operational report exports are role-scoped. Members and auditors see governance reports; billing exports require a billing admin."
            />
          </div>
        ) : (
          <div
            data-testid="reports-list"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 16,
            }}
          >
            {visibleReports.map((report) => (
              <Card
                key={report.id}
                variant="admin"
                data-testid={`report-card-${report.id}`}
                data-report-available={report.available ? "true" : "false"}
                title={report.label}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                    height: "100%",
                  }}
                >
                  <p style={{ ...mutedText, lineHeight: 1.55, margin: 0 }}>
                    {report.description}
                  </p>
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
                    <Badge tone="neutral" subtle>
                      {ORG_ROLE_LABEL[report.minRole]}+
                    </Badge>
                    {report.available ? null : (
                      <Badge tone="pending" subtle data-testid={`report-unavailable-${report.id}`}>
                        Not available
                      </Badge>
                    )}
                  </div>
                  {report.id in truncatedCaps ? (
                    <p
                      role="status"
                      data-testid={`report-truncated-${report.id}`}
                      style={{ ...mutedText, margin: 0, color: "var(--ink-primary, #0f172a)" }}
                    >
                      {truncatedCaps[report.id] != null
                        ? `Your download holds only the most recent ${truncatedCaps[report.id]!.toLocaleString("en-US")} rows; older entries were left out.`
                        : "Your download holds only the most recent rows; older entries were left out."}
                    </p>
                  ) : null}
                  <div style={{ marginTop: "auto", paddingTop: 4 }}>
                    <Button
                      type="button"
                      data-testid={`report-download-${report.id}`}
                      variant="secondary"
                      size="sm"
                      loading={downloading === report.id}
                      disabled={downloading !== null}
                      onClick={() => void download(report)}
                    >
                      {report.available
                        ? "Download CSV"
                        : "Download note (CSV)"}
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )
      ) : null}
    </section>
  );
}

const mutedText: React.CSSProperties = {
  fontSize: 13,
  color: "var(--ink-secondary, #475569)",
};
