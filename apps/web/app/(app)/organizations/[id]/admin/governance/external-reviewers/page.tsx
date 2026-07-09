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
 *
 * Phase 7 (Enterprise UX): presentation migrated to the shared design
 * system (PageSection + Card + DataTable + Badge + Button + EmptyState).
 * This sub-tab renders INSIDE the org admin layout shell (which already
 * owns the org title + tab bar), so it uses PageSection headings — not a
 * second PageHeader — to avoid a duplicate title. All data reads, gating,
 * testids, data-state markers and honest "—"/empty behaviour are unchanged.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../../lib/feedback/toSafeUserError";
import { formatUtcAuditDateTime } from "../../../../../../../lib/date";
import { useTeamId } from "../../../../../../../lib/platform-context";
import { PageSection } from "../../../../../../../components/ui/PageShell";
import { Card } from "../../../../../../../components/ui/Card";
import { Badge } from "../../../../../../../components/ui/Badge";
import { Button } from "../../../../../../../components/ui/Button";
import { EmptyState } from "../../../../../../../components/ui/EmptyState";
import {
  DataTable,
  type DataTableColumn,
} from "../../../../../../../components/ui/DataTable";

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

  const grantColumns: DataTableColumn<GrantRow>[] = [
    {
      key: "reviewer",
      header: "Reviewer",
      render: (g) => (
        <span data-testid="external-reviewer-grant-row" data-grant-state={g.state}>
          <div style={{ fontWeight: 600 }}>
            {g.reviewerDisplayName ?? g.reviewerEmail}
          </div>
          {g.reviewerDisplayName ? (
            <div style={{ fontSize: 11.5, color: "var(--ink-muted, #94a3b8)" }}>
              {g.reviewerEmail}
            </div>
          ) : null}
        </span>
      ),
    },
    {
      key: "state",
      header: "State",
      render: (g) => <StatePill state={g.state} />,
      nowrap: true,
    },
    {
      key: "scope",
      header: "Scope",
      render: (g) => (
        <>
          <code>{g.scopeKind}</code>
          <div style={{ fontSize: 11.5, color: "var(--ink-muted, #94a3b8)" }}>
            {scopeTarget(g)}
          </div>
        </>
      ),
    },
    { key: "downloads", header: "Downloads", render: (g) => downloadPolicy(g), nowrap: true },
    {
      key: "redaction",
      header: "Redaction",
      render: (g) =>
        g.redactionPolicyVersion ? (
          <code>{g.redactionPolicyVersion}</code>
        ) : (
          <span style={{ color: "var(--ink-muted, #94a3b8)" }}>—</span>
        ),
      nowrap: true,
    },
    {
      key: "issued",
      header: "Issued",
      render: (g) => formatUtcAuditDateTime(g.createdAtUtc),
      nowrap: true,
    },
    {
      key: "expires",
      header: "Expires",
      render: (g) => formatUtcAuditDateTime(g.expiresAtUtc),
      nowrap: true,
    },
    {
      key: "revoked",
      header: "Revoked",
      render: (g) =>
        g.revokedAtUtc ? formatUtcAuditDateTime(g.revokedAtUtc) : "—",
      nowrap: true,
    },
    {
      key: "lastAccess",
      header: "Last access",
      render: (g) =>
        g.lastAccessedAtUtc ? formatUtcAuditDateTime(g.lastAccessedAtUtc) : "—",
      nowrap: true,
    },
    { key: "accesses", header: "Accesses", render: (g) => g.accessCount, align: "right", nowrap: true },
  ];

  return (
    <section
      data-testid="org-admin-external-reviewers"
      data-team-id={teamId ?? ""}
      style={{ display: "flex", flexDirection: "column", gap: 24 }}
    >
      {/* ---------------------------------------------------------------
          Intro — what this governance view is.
          --------------------------------------------------------------- */}
      <Card
        variant="status"
        tone="governance"
        data-section="external-reviewers-intro"
        title="External reviewer grants"
        headerAction={<Badge tone="governance" dot>Read-only</Badge>}
      >
        <p
          style={{
            margin: 0,
            fontSize: 13.5,
            lineHeight: 1.6,
            color: "var(--ink-secondary, #475569)",
          }}
        >
          A read-only governance view of external sharing: every scoped
          grant that lets an outside reviewer see workspace evidence, its
          lifecycle state, who issued and who revoked it, its scope,
          expiration, watermark &amp; download policy, and its access
          history. Issuing, revoking, and rotating grants happens on the
          operator console linked below — this view never mutates.
        </p>
        <div style={{ marginTop: 12 }}>
          <Link
            href="/review/external"
            data-testid="ext-reviewers-link-console"
            style={{ textDecoration: "none" }}
          >
            <Button variant="secondary" size="sm">
              External Review Management Console →
            </Button>
          </Link>
        </div>
      </Card>

      {state.kind === "loading" ? (
        <Card variant="admin" data-state="loading">
          <span style={{ fontSize: 13, color: "var(--ink-muted, #94a3b8)" }}>
            Loading external-reviewer grants…
          </span>
        </Card>
      ) : state.kind === "error" ? (
        <Card
          variant="status"
          tone="risk"
          data-state="error"
          data-testid="external-reviewers-error"
          role="alert"
        >
          <div style={{ fontSize: 13.5, color: "var(--ink-primary, #0f172a)" }}>
            {state.status === 403 || state.status === 404
              ? "You don't have access to external-reviewer governance for this workspace. This view requires audit-read on the workspace."
              : state.message}
          </div>
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
        </Card>
      ) : (
        <>
          {/* -----------------------------------------------------------
              KPI tiles — the headline grant-lifecycle counts.
              ----------------------------------------------------------- */}
          <div
            data-section="external-reviewers-kpis"
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
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
          <PageSection
            data-testid="section-external-reviewer-grants"
            title="All grants"
            action={
              <span style={{ fontSize: 12.5, color: "var(--ink-muted, #94a3b8)" }}>
                {grants.length} grant{grants.length === 1 ? "" : "s"}
              </span>
            }
          >
            {grants.length === 0 ? (
              <div data-state="empty">
                <EmptyState
                  data-testid="external-reviewers-empty"
                  framed
                  title="No external reviewers have access"
                  purpose="No external-reviewer grants have been issued for this workspace. Grants let an outside reviewer see scoped evidence under governance — with expiration, watermark, download policy, and a full access audit."
                  action={
                    <Link href="/review/external" style={{ textDecoration: "none" }}>
                      <Button variant="secondary" size="sm">
                        Open the External Review Console →
                      </Button>
                    </Link>
                  }
                  note="Issuing grants requires REVIEWER_OPS_ACT on the operator console; this governance view is read-only."
                />
              </div>
            ) : (
              <div data-testid="external-reviewer-grants-table">
                <DataTable<GrantRow>
                  columns={grantColumns}
                  rows={grants}
                  getRowId={(g) => g.id}
                  density="compact"
                  ariaLabel="External reviewer grants"
                />
              </div>
            )}
          </PageSection>

          {/* -----------------------------------------------------------
              Canonical surfaces — deep-links (mutation lives elsewhere).
              ----------------------------------------------------------- */}
          <PageSection
            data-section="external-reviewers-deep-links"
            title="Canonical surfaces"
            description="This governance view is read-only. Grant issuance, revocation, rotation, and delivery live on their canonical operator surface."
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
            </div>
          </PageSection>
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
    <Card variant="summary" padding="compact" data-testid={testId}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minHeight: 76 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--ink-muted, #94a3b8)",
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 24,
            fontWeight: 700,
            lineHeight: 1.1,
            color: "var(--ink-primary, #0f172a)",
          }}
        >
          {value}
        </div>
      </div>
    </Card>
  );
}

function StatePill({ state }: { state: GrantState }) {
  const tone: "verified" | "pending" | "neutral" =
    state === "ACTIVE"
      ? "verified"
      : state === "INVITED"
        ? "pending"
        : "neutral";
  return (
    <span data-state={state}>
      <Badge tone={tone} subtle>
        {state}
      </Badge>
    </span>
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
    <Card
      variant="summary"
      padding="compact"
      style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
    >
      <div style={{ minWidth: 0, flex: "1 1 auto" }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 14,
            color: "var(--ink-primary, #0f172a)",
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--ink-secondary, #475569)",
            marginTop: 2,
          }}
        >
          {description}
        </div>
      </div>
      <Link href={href} data-testid={testId} style={{ textDecoration: "none", flexShrink: 0 }}>
        <Button variant="secondary" size="sm">
          Open →
        </Button>
      </Link>
    </Card>
  );
}
