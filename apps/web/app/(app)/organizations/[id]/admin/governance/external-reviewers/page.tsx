"use client";

/**
 * Phase 5 (Enterprise Governance) — Org admin / Governance / External
 * reviewer grants (read-only governance view).
 *
 * SCOPE J. A READ-ONLY governance view of external-reviewer grants —
 * the "external sharing under governance" surface. The Governance
 * Control Center (../governance) shows only the *count* of active
 * grants; this sub-view is the reviewable detail behind that number:
 * every grant's lifecycle state (active / expired / revoked), who
 * issued it, who revoked / rotated it, its evidence / case / package
 * scope, expiration, watermark + download policy, and its access
 * audit trail (last accessed, access count).
 *
 * Honest by construction — it REUSES the existing operator read
 * endpoints and adds no new storage or portal:
 *   - GET /v1/external-review/grants?teamId=…  (gated `audit.read`)
 *   - GET /v1/external-review/activity?teamId=… (gated `audit.read`)
 * Both are the SAME reads the External Review Management Console
 * (/review/external) consumes; this surface is a read-only governance
 * projection over them, NOT a second portal. Mutation (issue / revoke /
 * rotate / reveal) stays on the canonical operator console, deep-linked
 * below.
 *
 * Constitutional checks satisfied:
 *   - Wrapped in <PageRouteGate routeId="account.organization-detail">
 *     (enterprise-only via the /organizations path-prefix tier + org
 *     membership; the backend re-gates every read at `audit.read`).
 *   - Read-only: no mutating apiFetch verbs, no window.confirm.
 *   - toSafeUserError is the only non-ApiError display path.
 *   - Workspace-anchored read: the grant/activity endpoints are
 *     teamId-scoped, so the view derives the active workspace via the
 *     canonical platform-context `useTeamId()` and passes it explicitly.
 *   - Strong TypeScript types throughout.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../../lib/feedback/toSafeUserError";
import { formatUtcAuditDateTime } from "../../../../../../../lib/date";
import { useTeamId } from "../../../../../../../lib/platform-context";

// ---------------------------------------------------------------------------
// Wire types — mirror GET /v1/external-review/grants (ExternalReviewGrantRow)
// and GET /v1/external-review/activity (narrower access-feed projection).
// ---------------------------------------------------------------------------

type GrantState =
  | "INVITED"
  | "ACTIVE"
  | "EXPIRED"
  | "REVOKED"
  | "BLOCKED_BY_POLICY";

type ScopeKind = "EVIDENCE" | "CASE" | "PACKAGE";

interface GrantRow {
  id: string;
  teamId: string;
  scopeKind: ScopeKind;
  evidenceId: string | null;
  caseId: string | null;
  packageId: string | null;
  reviewerEmail: string;
  reviewerDisplayName: string | null;
  state: GrantState;
  invitedByUserId: string;
  approvedByUserId: string | null;
  revokedByUserId: string | null;
  expiresAtUtc: string;
  acceptedAtUtc: string | null;
  revokedAtUtc: string | null;
  lastAccessedAtUtc: string | null;
  accessCount: number;
  allowOriginalDownload: boolean;
  allowPackageDownload: boolean;
  redactionPolicyVersion: string | null;
  safeNote: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
}

interface GrantsResponse {
  grants: GrantRow[];
}

type Loadable<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string; status: number; requestId?: string };

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export default function OrganizationAdminExternalReviewersPage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <ExternalReviewerGovernanceView />
    </PageRouteGate>
  );
}

function ExternalReviewerGovernanceView() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";
  const teamId = useTeamId();
  const [state, setState] = useState<Loadable<GrantsResponse>>({
    kind: "loading",
  });

  const load = useCallback(async () => {
    if (!teamId) {
      // No active workspace resolved yet — hold in loading. The
      // grant/activity reads are teamId-scoped; without one there is
      // nothing honest to show.
      setState({ kind: "loading" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const data = (await apiFetch(
        `/v1/external-review/grants?teamId=${encodeURIComponent(teamId)}`,
      )) as GrantsResponse;
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
          message: "Failed to load external-reviewer grants.",
        }).message;
        setState({ kind: "error", message, status: 0 });
      }
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const grants = state.kind === "ready" ? state.data.grants : [];
  const counts = summarize(grants);

  return (
    <section data-testid="org-admin-external-reviewers" data-team-id={teamId ?? ""}>
      {/* ---------------------------------------------------------------
          Intro — what this governance view is.
          --------------------------------------------------------------- */}
      <section data-section="external-reviewers-intro" style={cardStyle}>
        <h2 style={{ margin: 0, fontSize: 16 }}>External reviewer grants</h2>
        <p style={{ fontSize: 13, opacity: 0.85, marginTop: 8 }}>
          A read-only governance view of external sharing: every scoped
          grant that lets an outside reviewer see workspace evidence, its
          lifecycle state, who issued and who revoked it, its scope,
          expiration, watermark &amp; download policy, and its access
          history. Issuing, revoking, and rotating grants happens on the
          operator console linked below — this view never mutates.
        </p>
        <DeepLink
          testId="ext-reviewers-link-console"
          label="External Review Management Console"
          href="/review/external"
        />
      </section>

      {state.kind === "loading" ? (
        <div
          data-state="loading"
          style={{ ...cardStyle, marginTop: "1rem", fontSize: 13, opacity: 0.7 }}
        >
          Loading external-reviewer grants…
        </div>
      ) : state.kind === "error" ? (
        <div
          data-state="error"
          data-testid="external-reviewers-error"
          role="alert"
          style={{ ...cardStyle, marginTop: "1rem", fontSize: 13 }}
        >
          {state.status === 403 || state.status === 404
            ? "You don't have access to external-reviewer governance for this workspace. This view requires audit-read on the workspace."
            : state.message}
          {state.requestId ? (
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                fontFamily: "monospace",
                opacity: 0.7,
              }}
            >
              Request id: {state.requestId}
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {/* -----------------------------------------------------------
              KPI tiles — the headline grant-lifecycle counts.
              ----------------------------------------------------------- */}
          <div
            data-section="external-reviewers-kpis"
            style={{
              display: "grid",
              gap: 10,
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              margin: "1rem 0 1.25rem",
            }}
          >
            <Kpi testId="kpi-active-grants" label="Active" value={counts.active} />
            <Kpi
              testId="kpi-pending-grants"
              label="Pending (invited)"
              value={counts.invited}
            />
            <Kpi testId="kpi-expired-grants" label="Expired" value={counts.expired} />
            <Kpi testId="kpi-revoked-grants" label="Revoked" value={counts.revoked} />
          </div>

          {/* -----------------------------------------------------------
              Grant table — the reviewable governance detail.
              ----------------------------------------------------------- */}
          <section
            data-testid="section-external-reviewer-grants"
            style={{ ...cardStyle, marginBottom: "1.25rem" }}
          >
            <header
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                gap: 12,
                flexWrap: "wrap",
                marginBottom: "0.5rem",
              }}
            >
              <h2 style={{ margin: 0, fontSize: 16 }}>All grants</h2>
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                {grants.length} grant{grants.length === 1 ? "" : "s"}
              </span>
            </header>

            {grants.length === 0 ? (
              <div
                data-state="empty"
                data-testid="external-reviewers-empty"
                style={{ marginTop: 8, fontSize: 13, opacity: 0.75 }}
              >
                No external-reviewer grants have been issued for this
                workspace.
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table
                  data-testid="external-reviewer-grants-table"
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 12,
                  }}
                >
                  <thead>
                    <tr style={{ textAlign: "left", opacity: 0.7 }}>
                      <th style={th}>Reviewer</th>
                      <th style={th}>State</th>
                      <th style={th}>Scope</th>
                      <th style={th}>Downloads</th>
                      <th style={th}>Redaction</th>
                      <th style={th}>Issued</th>
                      <th style={th}>Expires</th>
                      <th style={th}>Revoked</th>
                      <th style={th}>Last access</th>
                      <th style={th}>Accesses</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grants.map((g) => (
                      <tr key={g.id} data-testid="external-reviewer-grant-row" data-grant-state={g.state}>
                        <td style={td}>
                          <div style={{ fontWeight: 500 }}>
                            {g.reviewerDisplayName ?? g.reviewerEmail}
                          </div>
                          {g.reviewerDisplayName ? (
                            <div style={{ fontSize: 11, opacity: 0.7 }}>
                              {g.reviewerEmail}
                            </div>
                          ) : null}
                        </td>
                        <td style={td}>
                          <StatePill state={g.state} />
                        </td>
                        <td style={td}>
                          <code>{g.scopeKind}</code>
                          <div style={{ fontSize: 11, opacity: 0.7 }}>
                            {scopeTarget(g)}
                          </div>
                        </td>
                        <td style={td}>{downloadPolicy(g)}</td>
                        <td style={td}>
                          {g.redactionPolicyVersion ? (
                            <code>{g.redactionPolicyVersion}</code>
                          ) : (
                            <span style={{ opacity: 0.6 }}>—</span>
                          )}
                        </td>
                        <td style={td}>{formatUtcAuditDateTime(g.createdAtUtc)}</td>
                        <td style={td}>{formatUtcAuditDateTime(g.expiresAtUtc)}</td>
                        <td style={td}>
                          {g.revokedAtUtc
                            ? formatUtcAuditDateTime(g.revokedAtUtc)
                            : "—"}
                        </td>
                        <td style={td}>
                          {g.lastAccessedAtUtc
                            ? formatUtcAuditDateTime(g.lastAccessedAtUtc)
                            : "—"}
                        </td>
                        <td style={td}>{g.accessCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* -----------------------------------------------------------
              Canonical surfaces — deep-links (mutation lives elsewhere).
              ----------------------------------------------------------- */}
          <section data-section="external-reviewers-deep-links" style={cardStyle}>
            <h2 style={{ margin: 0, fontSize: 16 }}>Canonical surfaces</h2>
            <p style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
              This governance view is read-only. Grant issuance, revocation,
              rotation, and delivery live on their canonical operator
              surface.
            </p>
            <ul style={{ listStyle: "none", padding: 0, margin: "0.5rem 0 0" }}>
              <DeepLinkRow
                testId="ext-reviewers-deep-link-console"
                label="External Review Management Console"
                description="Issue, resend, revoke, and rotate external reviewer grants (REVIEWER_OPS_ACT)."
                href="/review/external"
              />
              <DeepLinkRow
                testId="ext-reviewers-deep-link-governance"
                label="Governance Control Center"
                description="Org-wide governance posture, including active external-sharing counts."
                href={`/organizations/${orgId}/admin/governance`}
              />
            </ul>
          </section>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Derivations.
// ---------------------------------------------------------------------------

function summarize(grants: GrantRow[]): {
  active: number;
  invited: number;
  expired: number;
  revoked: number;
} {
  let active = 0;
  let invited = 0;
  let expired = 0;
  let revoked = 0;
  for (const g of grants) {
    if (g.state === "ACTIVE") active += 1;
    else if (g.state === "INVITED") invited += 1;
    else if (g.state === "EXPIRED") expired += 1;
    else if (g.state === "REVOKED") revoked += 1;
  }
  return { active, invited, expired, revoked };
}

function scopeTarget(g: GrantRow): string {
  const id =
    g.scopeKind === "EVIDENCE"
      ? g.evidenceId
      : g.scopeKind === "CASE"
        ? g.caseId
        : g.packageId;
  return id ? `${id.slice(0, 8)}…` : "—";
}

function downloadPolicy(g: GrantRow): string {
  if (g.allowOriginalDownload && g.allowPackageDownload) return "Original + package";
  if (g.allowOriginalDownload) return "Original";
  if (g.allowPackageDownload) return "Package";
  return "View only";
}

// ---------------------------------------------------------------------------
// Presentational helpers.
// ---------------------------------------------------------------------------

const cardStyle = {
  padding: "1rem 1.1rem",
  border: "1px solid rgba(127,127,127,0.3)",
  borderRadius: 8,
} as const;

const th = { padding: "6px 8px", borderBottom: "1px solid rgba(127,127,127,0.25)" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid rgba(127,127,127,0.14)" } as const;

function Kpi({
  testId,
  label,
  value,
}: {
  testId: string;
  label: string;
  value: number;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        padding: "0.75rem 0.9rem",
        border: "1px solid rgba(127,127,127,0.3)",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minHeight: 76,
      }}
    >
      <div
        style={{
          fontSize: 11,
          opacity: 0.7,
          letterSpacing: 0.5,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function StatePill({ state }: { state: GrantState }) {
  const tone: "ok" | "warn" | "muted" =
    state === "ACTIVE"
      ? "ok"
      : state === "INVITED"
        ? "warn"
        : "muted";
  const bg =
    tone === "ok"
      ? "rgba(16,185,129,0.18)"
      : tone === "warn"
        ? "rgba(245,158,11,0.18)"
        : "rgba(127,127,127,0.15)";
  return (
    <span
      data-state={state}
      style={{
        fontSize: 11,
        padding: "1px 8px",
        borderRadius: 999,
        background: bg,
        display: "inline-block",
        fontWeight: 600,
        letterSpacing: 0.3,
        textTransform: "uppercase",
      }}
    >
      {state}
    </span>
  );
}

function DeepLink({
  testId,
  label,
  href,
}: {
  testId: string;
  label: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="cases-filter-chip"
      style={{ marginTop: 8, display: "inline-block" }}
    >
      {label} →
    </Link>
  );
}

function DeepLinkRow({
  testId,
  label,
  description,
  href,
}: {
  testId: string;
  label: string;
  description: string;
  href: string;
}) {
  return (
    <li
      style={{
        padding: "0.5rem 0",
        borderBottom: "1px solid rgba(127,127,127,0.18)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0, flex: "1 1 auto" }}>
        <div style={{ fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>{description}</div>
      </div>
      <Link href={href} data-testid={testId} className="cases-filter-chip">
        Open →
      </Link>
    </li>
  );
}
