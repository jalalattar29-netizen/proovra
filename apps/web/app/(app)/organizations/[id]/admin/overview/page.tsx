"use client";

/**
 * Phase 8 — Org admin / Overview tab.
 *
 * Read-only posture summary across the canonical org REST surface
 * (/v1/orgs/:id, /v1/orgs/:id/members, /v1/orgs/:id/workspaces,
 * /v1/orgs/:id/audit-events) plus deep-links to canonical Phase 4A
 * governance/audit/trust pages.
 *
 * Constitutional checks satisfied:
 *
 *   - Wrapped in <PageRouteGate routeId="account.organization-detail">.
 *   - No raw window.confirm — page is read-only.
 *   - No platform-context workspace-fragment reads — we use apiFetch
 *     against /v1/orgs/:id only.
 *   - Strong TypeScript types throughout.
 *   - No new workspace kinds; deep-links surface canonical surfaces.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../../../lib/api";

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
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
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
      const message = err instanceof Error ? err.message : "Failed to load.";
      return { kind: "error", message, status: 0 };
    }
  }, []);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void (async () => {
      const [o, m, a] = await Promise.all([
        fetchOne<OrgResponse>(`/v1/orgs/${orgId}`),
        fetchOne<MembersResponse>(`/v1/orgs/${orgId}/members`),
        fetchOne<AuditResponse>(`/v1/orgs/${orgId}/audit-events`),
      ]);
      if (cancelled) return;
      setOrg(o);
      setMembers(m);
      setAudit(a);
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

  const lastAudit =
    audit.kind === "ready" && audit.data.events.length > 0
      ? audit.data.events[0]!
      : null;

  return (
    <section data-testid="org-admin-overview" data-org-id={orgId}>
      <div
        style={{
          display: "grid",
          gap: 10,
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          marginBottom: "1.25rem",
        }}
      >
        <Tile
          dataAttr="tile-status"
          title="Status"
          primary={org.kind === "ready" ? org.data.status : loadingOrError(org)}
          secondary={
            org.kind === "ready"
              ? `Created ${new Date(org.data.createdAt).toLocaleDateString()}`
              : null
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
                  .map(
                    ([role, n]) =>
                      `${n} ${ROLE_LABEL[role as OrgRole]}`,
                  )
                  .join(" · ")
              : "Role distribution loading…"
          }
          footer={
            <Link
              href={`/organizations/${orgId}/admin/members`}
              data-testid="overview-link-members"
              style={{ fontSize: 12 }}
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
              style={{ fontSize: 12 }}
            >
              Manage in members tab →
            </Link>
          }
        />
        <Tile
          dataAttr="tile-workspaces"
          title="Workspaces"
          primary={
            org.kind === "ready"
              ? String(org.data.summary.workspaceCount)
              : loadingOrError(org)
          }
          secondary="Workspaces bound to this organization."
          footer={
            <Link
              href={`/teams?org=${orgId}`}
              data-testid="overview-link-workspaces"
              style={{ fontSize: 12 }}
            >
              Workspace administration →
            </Link>
          }
        />
        <Tile
          dataAttr="tile-audit"
          title="Audit timeline"
          primary={
            audit.kind === "ready"
              ? String(audit.data.summary.totalEvents)
              : audit.kind === "error" && audit.status === 403
                ? "Auditor-only"
                : loadingOrError(audit)
          }
          secondary={
            lastAudit
              ? `Latest ${lastAudit.eventType} · ${new Date(lastAudit.createdAt).toLocaleString()}`
              : audit.kind === "ready"
                ? "No events yet."
                : audit.kind === "error" && audit.status === 403
                  ? "Requires ORG_AUDITOR or higher."
                  : null
          }
          footer={
            <Link
              href={`/organizations/${orgId}/admin/audit`}
              data-testid="overview-link-audit"
              style={{ fontSize: 12 }}
            >
              Open audit tab →
            </Link>
          }
        />
        <Tile
          dataAttr="tile-your-role"
          title="Your role"
          primary={
            org.kind === "ready" ? ROLE_LABEL[org.data.callerRole] : loadingOrError(org)
          }
          secondary="Org-level governance role. Workspace access is separate."
        />
      </div>

      <DeepLinkCard
        title="Canonical surfaces"
        subtitle="The following surfaces own write semantics; this overview is read-only."
      >
        <DeepLinkRow
          testId="deep-link-governance"
          label="Governance Platform"
          description="Policies, departments, delegated admins, cross-org reviews."
          href="/governance-platform"
        />
        <DeepLinkRow
          testId="deep-link-audit-transparency"
          label="Audit & Transparency"
          description="Federated audit feed across organizations."
          href="/audit-transparency"
        />
        <DeepLinkRow
          testId="deep-link-trust-center"
          label="Trust Center"
          description="Public trust articles + subprocessors + status."
          href="/trust-hub"
        />
        <DeepLinkRow
          testId="deep-link-evidence-lifecycle"
          label="Evidence Lifecycle"
          description="Retention runs, legal holds, archive + destruction."
          href="/evidence-lifecycle"
        />
      </DeepLinkCard>
    </section>
  );
}

function loadingOrError(l: Loadable<unknown>): string {
  if (l.kind === "loading") return "Loading…";
  if (l.kind === "error") return l.status === 403 ? "Not permitted" : "—";
  return "—";
}

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
    <div
      data-tile={dataAttr}
      style={{
        padding: "0.75rem 0.9rem",
        border: "1px solid rgba(127,127,127,0.3)",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minHeight: 120,
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
        {title}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{primary}</div>
      {secondary ? (
        <div style={{ fontSize: 12, opacity: 0.8 }}>{secondary}</div>
      ) : null}
      {footer ? <div style={{ marginTop: "auto" }}>{footer}</div> : null}
    </div>
  );
}

function DeepLinkCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-section="deep-link-card"
      style={{
        padding: "1rem 1.1rem",
        border: "1px solid rgba(127,127,127,0.3)",
        borderRadius: 8,
      }}
    >
      <header style={{ marginBottom: "0.5rem" }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
        {subtitle ? (
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{subtitle}</div>
        ) : null}
      </header>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>{children}</ul>
    </section>
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
      <Link
        href={href}
        data-testid={testId}
        className="cases-filter-chip"
      >
        Open →
      </Link>
    </li>
  );
}
