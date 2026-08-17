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
 * Honest "Not available": the download-audit report is marked as an
 * honest unavailable-at-the-org-tier card (the endpoint returns a
 * documented note CSV rather than fabricated rows).
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
import { apiFetch, ApiError, apiBaseUrl, readApiToken } from "../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";
import { notifyApiError } from "../../../../../../lib/feedback/notify";
import { useToast } from "../../../../../../components/ui-legacy";
import { Card } from "../../../../../../components/ui/Card";
import { Badge } from "../../../../../../components/ui/Badge";
import { Button } from "../../../../../../components/ui/Button";
import { EmptyState } from "../../../../../../components/ui/EmptyState";
import {
  ORG_ROLE_LABEL,
  roleMeetsMin,
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
  /** The real backing data source, shown as an honest provenance note. */
  source: string;
  /** When false, the report has no data at the org tier (honest unavailable). */
  available: boolean;
}

const REPORTS: ReadonlyArray<ReportDef> = [
  {
    id: "members",
    label: "Members & roles",
    description:
      "Every org member with their user id, email, display name, org role, and join date.",
    file: "members.csv",
    filename: "org-members.csv",
    minRole: "ORG_AUDITOR",
    source: "GET /v1/orgs/:id/members",
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
    source: "GET /v1/orgs/:id/billing/rollup",
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
    source: "GET /v1/orgs/:id/audit-events",
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
    source: "GET /v1/orgs/:id/policies/retention",
    available: true,
  },
  {
    id: "external-access",
    label: "External reviewer access",
    description:
      "External reviewer grants across the org's workspaces — email, role, state, expiry, revocation, and access-activity count.",
    file: "external-access.csv",
    filename: "org-external-access.csv",
    minRole: "ORG_AUDITOR",
    source: "ExternalReviewerRoleAssignment (org workspaces)",
    available: true,
  },
  {
    id: "download-audit",
    label: "Evidence download audit",
    description:
      "Evidence report/package/original downloads are recorded in the platform audit log scoped to user + evidence id, not attributed to an organization — so this report is not available at the org tier.",
    file: "download-audit.csv",
    filename: "org-download-audit.csv",
    minRole: "ORG_AUDITOR",
    source: "Platform audit log (category=evidence)",
    available: false,
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
    <PageRouteGate routeId="account.organization_admin_reports">
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

  const load = useCallback(async () => {
    if (!orgId) return;
    setState({ kind: "loading" });
    try {
      const data = (await apiFetch(`/v1/orgs/${orgId}`)) as OrgHeader;
      setState({ kind: "ready", data });
    } catch (err) {
      if (err instanceof ApiError) {
        setState({
          kind: "error",
          message: err.message,
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
                : `Failed to download report (HTTP ${res.status}).`;
          const err: Error & { statusCode?: number; requestId?: string } =
            new Error(message);
          err.statusCode = res.status;
          err.requestId = requestId;
          notifyApiError(addToast, err, { message });
          return;
        }

        const text = await res.text();
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
    ? REPORTS.filter((r) => roleMeetsMin(callerRole, r.minRole))
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
        subtitle="Export existing organization data as CSV. Each report reads real records — nothing is fabricated. Role-appropriate; the backend gates every download."
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
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--ink-muted, #94a3b8)",
                      fontFamily: "monospace",
                    }}
                  >
                    {report.source}
                  </div>
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
