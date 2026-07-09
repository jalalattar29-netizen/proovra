"use client";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";

/**
 * Phase 4 (Enterprise Administration) — Org admin / Overview tab.
 *
 * The real Enterprise Admin HOME. A read-only posture summary across the
 * canonical org REST surface plus evidence-platform quick actions that
 * deep-link to the sibling admin tabs / canonical config surfaces.
 *
 * Reads (all EXISTING endpoints, fetched directly — no new aggregate):
 *
 *   GET /v1/orgs/:id                      — org profile, status, plan
 *                                           verification, member/workspace/
 *                                           invite summary, caller role.
 *   GET /v1/orgs/:id/members              — role distribution.
 *   GET /v1/orgs/:id/audit-events         — recent governance audit
 *                                           (ORG_AUDITOR+; 403 tolerated).
 *   GET /v1/orgs/:id/domains              — verified-domains status
 *                                           (ORG_ADMIN+ & enterprise gate;
 *                                           403 tolerated).
 *   GET /v1/orgs/:id/policies/retention   — retention template posture
 *                                           (org member).
 *   GET /v1/orgs/:id/billing/rollup       — seat usage across workspaces
 *                                           (ORG_BILLING_ADMIN+; 403
 *                                           tolerated).
 *
 * No aggregate endpoint was added: the required reads have DIFFERENT role
 * gates (auditor / admin / billing-admin), so fanning out client-side lets
 * each section degrade to its own honest 403 without a bespoke backend gate
 * that would risk leaking billing / domain data to lower roles.
 *
 * MFA / SSO / SCIM / session policy have no org-scoped readiness endpoint;
 * mirroring the Security tab we report them honestly as "Not configured"
 * with a deep-link to the canonical identity surface — never fake-positive.
 *
 * Constitutional checks satisfied:
 *
 *   - Wrapped in <PageRouteGate routeId="account.organization-detail">.
 *   - No raw window.confirm — page is read-only (no mutations).
 *   - No platform-context workspace-fragment reads — apiFetch against
 *     /v1/orgs/:id only.
 *   - Strong TypeScript types throughout.
 *   - toSafeUserError is the only non-ApiError display path.
 *   - No new workspace kinds; quick actions surface canonical tabs/pages.
 *
 * Phase 7 (Enterprise UX): presentation migrated to the shared design
 * system (Card / Badge / Button). This tab renders INSIDE the org admin
 * layout shell (which owns the org title + tab bar), so it uses PageSection
 * headings — not a second PageHeader — to avoid a duplicate <h1>. All reads,
 * gating, tile/readiness/quick-action testids and honest states unchanged.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../../../lib/api";
import { formatUserDate, formatUtcAuditDateTime } from "../../../../../../lib/date";
import { Card } from "../../../../../../components/ui/Card";
import { Badge } from "../../../../../../components/ui/Badge";
import { Button } from "../../../../../../components/ui/Button";

// ---------------------------------------------------------------------------
// Wire types — mirror the existing org REST surface.
// ---------------------------------------------------------------------------

type OrgRole =
  | "ORG_OWNER"
  | "ORG_ADMIN"
  | "ORG_SECURITY_ADMIN"
  | "ORG_BILLING_ADMIN"
  | "ORG_AUDITOR"
  | "ORG_MEMBER";

interface OrgResponse {
  organizationId: string;
  name: string;
  legalName: string | null;
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  verificationState: string | null;
  verifiedAtUtc: string | null;
  callerRole: OrgRole;
  summary: {
    memberCount: number;
    workspaceCount: number;
    pendingInviteCount: number;
  };
  createdAt: string;
  updatedAt: string;
}

interface MembersResponse {
  organizationId: string;
  summary: { totalMembers: number };
  members: Array<{ membershipId: string; role: OrgRole }>;
}

interface AuditResponse {
  summary: { totalEvents: number };
  events: Array<{ id: string; eventType: string; createdAt: string }>;
}

interface DomainsResponse {
  domains: Array<{
    id: string;
    domain: string;
    verified: boolean;
    verifiedAt: string | null;
  }>;
}

interface RetentionResponse {
  organizationId: string;
  value: Record<string, unknown> | null;
  updatedAt: string | null;
  inheritance: { workspaceCount: number };
}

interface BillingRollupResponse {
  organizationId: string;
  workspaceCount: number;
  totalIncludedSeats: number;
  planCounts: Record<string, number>;
  statusCounts: Record<string, number>;
}

type Loadable<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string; status: number; requestId?: string };

const ROLE_LABEL: Record<OrgRole, string> = {
  ORG_OWNER: "Owner",
  ORG_ADMIN: "Admin",
  ORG_SECURITY_ADMIN: "Security admin",
  ORG_BILLING_ADMIN: "Billing admin",
  ORG_AUDITOR: "Auditor",
  ORG_MEMBER: "Member",
};

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export default function OrganizationAdminOverviewPage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <Overview />
    </PageRouteGate>
  );
}

function Overview() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";

  const [org, setOrg] = useState<Loadable<OrgResponse>>({ kind: "loading" });
  const [members, setMembers] = useState<Loadable<MembersResponse>>({
    kind: "loading",
  });
  const [audit, setAudit] = useState<Loadable<AuditResponse>>({
    kind: "loading",
  });
  const [domains, setDomains] = useState<Loadable<DomainsResponse>>({
    kind: "loading",
  });
  const [retention, setRetention] = useState<Loadable<RetentionResponse>>({
    kind: "loading",
  });
  const [billing, setBilling] = useState<Loadable<BillingRollupResponse>>({
    kind: "loading",
  });

  const fetchOne = useCallback(async function fetchOne<T>(
    path: string,
  ): Promise<Loadable<T>> {
    try {
      const data = (await apiFetch(path)) as T;
      return { kind: "ready", data };
    } catch (err) {
      if (err instanceof ApiError) {
        return {
          kind: "error",
          message: err.message,
          status: err.statusCode ?? 0,
          requestId: err.requestId,
        };
      }
      const message = toSafeUserError(err, { message: "Failed to load." }).message;
      return { kind: "error", message, status: 0 };
    }
  }, []);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void (async () => {
      // Fan out to the existing endpoints in parallel. Each section
      // degrades to its own honest 403 (auditor / admin / billing-admin
      // gates differ), so one section's forbidden read never blocks the
      // rest of the page.
      const [o, m, a, d, r, b] = await Promise.all([
        fetchOne<OrgResponse>(`/v1/orgs/${orgId}`),
        fetchOne<MembersResponse>(`/v1/orgs/${orgId}/members`),
        fetchOne<AuditResponse>(`/v1/orgs/${orgId}/audit-events`),
        fetchOne<DomainsResponse>(`/v1/orgs/${orgId}/domains`),
        fetchOne<RetentionResponse>(`/v1/orgs/${orgId}/policies/retention`),
        fetchOne<BillingRollupResponse>(`/v1/orgs/${orgId}/billing/rollup`),
      ]);
      if (cancelled) return;
      setOrg(o);
      setMembers(m);
      setAudit(a);
      setDomains(d);
      setRetention(r);
      setBilling(b);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, fetchOne]);

  const roleTally = useMemo(() => {
    if (members.kind !== "ready") return null;
    const tally: Partial<Record<OrgRole, number>> = {};
    for (const m of members.data.members) {
      tally[m.role] = (tally[m.role] ?? 0) + 1;
    }
    return tally;
  }, [members]);

  const domainStatus = useMemo(() => domainSummary(domains), [domains]);
  const recentAudit =
    audit.kind === "ready" ? audit.data.events.slice(0, 5) : [];

  return (
    <section
      data-testid="org-admin-overview"
      data-org-id={orgId}
      style={{ display: "flex", flexDirection: "column", gap: 20 }}
    >
      {/* ---------------------------------------------------------------
          Enterprise posture — organization, plan, seats, members.
          --------------------------------------------------------------- */}
      <div
        data-section="overview-posture"
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        }}
      >
        <Tile
          dataAttr="tile-organization"
          title="Organization"
          primary={org.kind === "ready" ? org.data.name : loadingOrError(org)}
          secondary={
            org.kind === "ready"
              ? `${org.data.status} · created ${formatUserDate(org.data.createdAt)}`
              : null
          }
        />
        <Tile
          dataAttr="tile-plan"
          title="Enterprise plan"
          primary={
            org.kind === "ready"
              ? planLabel(org.data.verificationState)
              : loadingOrError(org)
          }
          secondary={
            org.kind === "ready"
              ? org.data.verifiedAtUtc
                ? `Verified ${formatUserDate(org.data.verifiedAtUtc)}`
                : "Enterprise administration boundary."
              : null
          }
          footer={
            <Link
              href={`/organizations/${orgId}/admin/trust`}
              data-testid="overview-link-trust"
              style={tileLink}
            >
              Trust Center →
            </Link>
          }
        />
        <Tile
          dataAttr="tile-seats"
          title="Seat usage"
          primary={
            billing.kind === "ready"
              ? seatUsagePrimary(billing.data, members)
              : billing.kind === "error" && billing.status === 403
                ? "Billing-admin only"
                : loadingOrError(billing)
          }
          secondary={
            billing.kind === "ready"
              ? `${billing.data.totalIncludedSeats} included seat${billing.data.totalIncludedSeats === 1 ? "" : "s"} across ${billing.data.workspaceCount} workspace${billing.data.workspaceCount === 1 ? "" : "s"}`
              : billing.kind === "error" && billing.status === 403
                ? "Requires ORG_BILLING_ADMIN or higher."
                : null
          }
          footer={
            <Link
              href={`/teams?org=${orgId}`}
              data-testid="overview-link-billing"
              style={tileLink}
            >
              Billing & seats →
            </Link>
          }
        />
        <Tile
          dataAttr="tile-members"
          title="Members"
          primary={
            org.kind === "ready"
              ? String(org.data.summary.memberCount)
              : loadingOrError(org)
          }
          secondary={
            roleTally
              ? Object.entries(roleTally)
                  .filter(([, n]) => (n ?? 0) > 0)
                  .map(([role, n]) => `${n} ${ROLE_LABEL[role as OrgRole]}`)
                  .join(" · ")
              : "Role distribution loading…"
          }
          footer={
            <Link
              href={`/organizations/${orgId}/admin/members`}
              data-testid="overview-link-members"
              style={tileLink}
            >
              Open members tab →
            </Link>
          }
        />
        <Tile
          dataAttr="tile-pending-invites"
          title="Pending invites"
          primary={
            org.kind === "ready"
              ? String(org.data.summary.pendingInviteCount)
              : loadingOrError(org)
          }
          secondary="Invites issued but not yet accepted."
          footer={
            <Link
              href={`/organizations/${orgId}/admin/members`}
              data-testid="overview-link-invites"
              style={tileLink}
            >
              Manage in members tab →
            </Link>
          }
        />
        <Tile
          dataAttr="tile-your-role"
          title="Your role"
          primary={
            org.kind === "ready"
              ? ROLE_LABEL[org.data.callerRole]
              : loadingOrError(org)
          }
          secondary="Org-level governance role. Workspace access is separate."
        />
      </div>

      {/* ---------------------------------------------------------------
          Identity & compliance readiness.
          --------------------------------------------------------------- */}
      <Card
        variant="summary"
        data-section="overview-readiness"
        title="Identity & compliance"
        subtitle="Enterprise readiness across identity, domains, and evidence retention. Configuration lives on the linked surfaces."
      >
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          <ReadinessRow
            testId="readiness-sso"
            label="SSO (SAML / OIDC)"
            state={{ tone: "warn", text: "Not configured" }}
            description="Federated identity. No org-scoped readiness signal is exposed yet."
            href="/admin/identity"
            linkTestId="overview-link-sso"
            linkLabel="Configure SSO"
          />
          <ReadinessRow
            testId="readiness-scim"
            label="SCIM provisioning"
            state={{ tone: "warn", text: "Not configured" }}
            description="Automated provisioning / de-provisioning via SCIM 2.0."
            href="/admin/identity/scim"
            linkTestId="overview-link-scim"
            linkLabel="Configure SCIM"
          />
          <ReadinessRow
            testId="readiness-domains"
            label="Verified domains"
            state={domainStatus.state}
            description={domainStatus.description}
            href={`/organizations/${orgId}/admin/domains`}
            linkTestId="overview-link-domains"
            linkLabel="Verify domain"
          />
          <ReadinessRow
            testId="readiness-mfa"
            label="MFA / session policy"
            state={{ tone: "warn", text: "Not configured" }}
            description="Org-wide MFA enforcement and session timeout policy."
            href={`/organizations/${orgId}/admin/security`}
            linkTestId="overview-link-security"
            linkLabel="Configure MFA / session policy"
          />
          <ReadinessRow
            testId="readiness-retention"
            label="Retention & legal hold"
            state={retentionStatus(retention)}
            description={retentionDescription(retention)}
            href={`/organizations/${orgId}/admin/retention`}
            linkTestId="overview-link-retention"
            linkLabel="Manage retention / legal hold"
          />
          <ReadinessRow
            testId="readiness-api"
            label="API keys & webhooks"
            state={{ tone: "warn", text: "Not configured" }}
            description="Programmatic access + integration delivery. No org-scoped key inventory yet."
            href="/admin/identity"
            linkTestId="overview-link-api"
            linkLabel="Manage API keys / webhooks"
          />
        </ul>
      </Card>

      {/* ---------------------------------------------------------------
          Recent governance audit.
          --------------------------------------------------------------- */}
      <Card
        variant="summary"
        data-section="overview-audit"
        header={
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <h2 style={sectionH2}>Recent admin activity</h2>
              <div style={{ ...subtleText, marginTop: 2 }}>
                {audit.kind === "ready"
                  ? `${audit.data.summary.totalEvents} governance event${audit.data.summary.totalEvents === 1 ? "" : "s"} recorded.`
                  : audit.kind === "error" && audit.status === 403
                    ? "Requires ORG_AUDITOR or higher."
                    : "Loading audit timeline…"}
              </div>
            </div>
            <Link
              href={`/organizations/${orgId}/admin/audit`}
              data-testid="overview-link-audit"
              style={linkReset}
            >
              <Button variant="secondary" size="sm">
                Review audit log →
              </Button>
            </Link>
          </div>
        }
      >
        {recentAudit.length > 0 ? (
          <ul
            data-testid="overview-audit-list"
            style={{ listStyle: "none", padding: 0, margin: 0 }}
          >
            {recentAudit.map((e) => (
              <li
                key={e.id}
                data-testid="overview-audit-row"
                style={{
                  padding: "9px 0",
                  borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  fontSize: 13.5,
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontWeight: 600 }}>{e.eventType}</span>
                <span style={subtleText}>
                  {formatUtcAuditDateTime(e.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div
            data-testid="overview-audit-empty"
            style={{ fontSize: 13.5, color: "var(--ink-secondary, #475569)" }}
          >
            {audit.kind === "ready"
              ? "No governance events recorded yet."
              : audit.kind === "error" && audit.status === 403
                ? "You don't have permission to view the audit timeline."
                : audit.kind === "error"
                  ? audit.message
                  : "Loading…"}
          </div>
        )}
      </Card>

      {/* ---------------------------------------------------------------
          Quick actions — evidence-platform deep-links to existing tabs.
          --------------------------------------------------------------- */}
      <Card
        variant="admin"
        data-section="overview-quick-actions"
        title="Quick actions"
        subtitle="Common enterprise administration tasks. Each opens the canonical surface that owns write semantics — this overview is read-only."
      >
        <div
          data-testid="overview-quick-actions-grid"
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          }}
        >
          <QuickAction
            testId="quick-action-invite-members"
            label="Invite members"
            href={`/organizations/${orgId}/admin/members`}
          />
          <QuickAction
            testId="quick-action-configure-sso"
            label="Configure SSO"
            href="/admin/identity"
          />
          <QuickAction
            testId="quick-action-configure-scim"
            label="Configure SCIM"
            href="/admin/identity/scim"
          />
          <QuickAction
            testId="quick-action-verify-domain"
            label="Verify domain"
            href={`/organizations/${orgId}/admin/domains`}
          />
          <QuickAction
            testId="quick-action-review-audit"
            label="Review audit log"
            href={`/organizations/${orgId}/admin/audit`}
          />
          <QuickAction
            testId="quick-action-configure-mfa"
            label="Configure MFA / session policy"
            href={`/organizations/${orgId}/admin/security`}
          />
          <QuickAction
            testId="quick-action-manage-retention"
            label="Manage retention / legal hold"
            href={`/organizations/${orgId}/admin/retention`}
          />
          <QuickAction
            testId="quick-action-manage-api"
            label="Manage API keys / webhooks"
            href="/admin/identity"
          />
          <QuickAction
            testId="quick-action-review-access"
            label="Review evidence access"
            href={`/organizations/${orgId}/admin/access-reviews`}
          />
          <QuickAction
            testId="quick-action-configure-billing"
            label="Configure billing / seats"
            href={`/teams?org=${orgId}`}
          />
        </div>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Derived-status helpers.
// ---------------------------------------------------------------------------

function loadingOrError(l: Loadable<unknown>): string {
  if (l.kind === "loading") return "Loading…";
  if (l.kind === "error") return l.status === 403 ? "Not permitted" : "—";
  return "—";
}

function planLabel(verificationState: string | null): string {
  if (!verificationState) return "Enterprise";
  const v = verificationState.toUpperCase();
  if (v === "VERIFIED") return "Enterprise · Verified";
  if (v === "PENDING") return "Enterprise · Pending verification";
  if (v === "UNVERIFIED" || v === "NONE") return "Enterprise · Unverified";
  return `Enterprise · ${verificationState}`;
}

function seatUsagePrimary(
  billing: BillingRollupResponse,
  members: Loadable<MembersResponse>,
): string {
  const used =
    members.kind === "ready" ? members.data.summary.totalMembers : null;
  const included = billing.totalIncludedSeats;
  if (used === null) return `${included} seats`;
  const over = used - included;
  const overStr = over > 0 ? ` · ${over} over` : "";
  return `${used} / ${included}${overStr}`;
}

type PillState = { tone: "ok" | "warn"; text: string };

function domainSummary(domains: Loadable<DomainsResponse>): {
  state: PillState;
  description: string;
} {
  if (domains.kind === "loading") {
    return { state: { tone: "warn", text: "Loading…" }, description: "Checking verified domains…" };
  }
  if (domains.kind === "error") {
    if (domains.status === 403) {
      return {
        state: { tone: "warn", text: "Admin only" },
        description: "Requires ORG_ADMIN and the enterprise SSO/SCIM feature.",
      };
    }
    return { state: { tone: "warn", text: "Unavailable" }, description: domains.message };
  }
  const total = domains.data.domains.length;
  const verified = domains.data.domains.filter((d) => d.verified).length;
  if (total === 0) {
    return {
      state: { tone: "warn", text: "None claimed" },
      description: "No email domains claimed. Verify a domain to gate SSO and auto-associate members.",
    };
  }
  return {
    state: {
      tone: verified === total ? "ok" : "warn",
      text: `${verified}/${total} verified`,
    },
    description: `${verified} of ${total} claimed domain${total === 1 ? "" : "s"} verified via DNS TXT.`,
  };
}

function retentionStatus(retention: Loadable<RetentionResponse>): PillState {
  if (retention.kind === "loading") return { tone: "warn", text: "Loading…" };
  if (retention.kind === "error") {
    return {
      tone: "warn",
      text: retention.status === 403 ? "Not permitted" : "Unavailable",
    };
  }
  return retention.data.value === null
    ? { tone: "warn", text: "Not configured" }
    : { tone: "ok", text: "Published" };
}

function retentionDescription(retention: Loadable<RetentionResponse>): string {
  if (retention.kind !== "ready") {
    return "Organization-level retention template + legal-hold posture.";
  }
  const ws = retention.data.inheritance.workspaceCount;
  const wsStr = `${ws} workspace${ws === 1 ? "" : "s"}`;
  return retention.data.value === null
    ? `No org retention template published. ${wsStr} fall back to workspace policy.`
    : `Retention template published and inherited by ${wsStr}.`;
}

// ---------------------------------------------------------------------------
// Presentational components.
// ---------------------------------------------------------------------------

const sectionH2 = {
  margin: 0,
  fontSize: 15,
  fontWeight: 650,
  color: "var(--ink-primary, #0f172a)",
} as const;

const subtleText = {
  margin: 0,
  fontSize: 12.5,
  color: "var(--ink-muted, #94a3b8)",
} as const;

const tileLink = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--enterprise-accent, #6b5bff)",
  textDecoration: "none",
} as const;

const linkReset = { textDecoration: "none", flexShrink: 0 } as const;

function Tile({
  dataAttr,
  title,
  primary,
  secondary,
  footer,
}: {
  dataAttr: string;
  title: string;
  primary: React.ReactNode;
  secondary: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <Card variant="summary" padding="compact" data-tile={dataAttr}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          minHeight: 108,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--ink-muted, #94a3b8)",
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 18,
            fontWeight: 650,
            color: "var(--ink-primary, #0f172a)",
          }}
        >
          {primary}
        </div>
        {secondary ? (
          <div style={{ fontSize: 12.5, color: "var(--ink-secondary, #475569)" }}>
            {secondary}
          </div>
        ) : null}
        {footer ? <div style={{ marginTop: "auto", paddingTop: 6 }}>{footer}</div> : null}
      </div>
    </Card>
  );
}

function StatusPill({ state }: { state: PillState }) {
  return (
    <span data-state={state.tone === "ok" ? "ok" : "not-configured"}>
      <Badge tone={state.tone === "ok" ? "verified" : "pending"} subtle>
        {state.text}
      </Badge>
    </span>
  );
}

function ReadinessRow({
  testId,
  label,
  state,
  description,
  href,
  linkTestId,
  linkLabel,
}: {
  testId: string;
  label: string;
  state: PillState;
  description: string;
  href: string;
  linkTestId: string;
  linkLabel: string;
}) {
  return (
    <li
      data-testid={testId}
      data-state={state.tone === "ok" ? "ok" : "not-configured"}
      style={{
        padding: "11px 0",
        borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0, flex: "1 1 auto" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 600 }}>{label}</span>
          <StatusPill state={state} />
        </div>
        <div style={{ ...subtleText, marginTop: 2 }}>{description}</div>
      </div>
      <Link href={href} data-testid={linkTestId} style={linkReset}>
        <Button variant="ghost" size="sm">
          {linkLabel} →
        </Button>
      </Link>
    </li>
  );
}

function QuickAction({
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
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "12px 14px",
        border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
        borderRadius: "var(--radius-card, 14px)",
        background: "var(--surface-card, #ffffff)",
        boxShadow: "var(--shadow-card, 0 1px 2px rgba(15,23,42,0.04))",
        textDecoration: "none",
        fontSize: 13.5,
        fontWeight: 600,
        color: "var(--ink-primary, #0f172a)",
      }}
    >
      <span>{label}</span>
      <span aria-hidden="true" style={{ color: "var(--enterprise-accent, #6b5bff)" }}>→</span>
    </Link>
  );
}
