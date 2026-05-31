"use client";

/**
 * Phase 4A — Governance Platform Dashboard.
 *
 * Distinct from the legacy `/governance` hub: this is the
 * enterprise org-level governance surface (orgs / departments /
 * delegated admin / policies / access reviews / cross-org).
 */

import { useCallback, useEffect, useState } from "react";

import type { GovernanceDashboardProjection } from "@proovra/shared";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../lib/api";

export default function GovernancePlatformPage() {
  return (
    <PageRouteGate routeId="workspace.governance_platform">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [dashboard, setDashboard] = useState<GovernanceDashboardProjection | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch("/v1/governance/dashboard", { method: "GET" });
      setDashboard((res?.dashboard ?? null) as GovernanceDashboardProjection | null);
    } catch {
      setDashboard(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-governance-platform
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Governance Platform</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Compliance · access reviews · delegated administration · cross-org
          · policy violations · audit health · security health · trust health.
        </p>
        <nav data-governance-platform-nav style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
          <a data-governance-platform-link="departments" href="/governance-platform/departments" style={navLink}>Departments</a>
          <a data-governance-platform-link="delegated-admin" href="/governance-platform/delegated-admin" style={navLink}>Delegated Admin</a>
          <a data-governance-platform-link="policies" href="/governance-platform/policies" style={navLink}>Policies</a>
          <a data-governance-platform-link="access-reviews" href="/governance-platform/access-reviews" style={navLink}>Access Reviews</a>
          <a data-governance-platform-link="cross-org" href="/governance-platform/cross-org" style={navLink}>Cross-Org</a>
        </nav>
      </header>

      <button
        type="button"
        data-governance-platform-refresh
        disabled={busy}
        onClick={() => void refresh()}
        style={primaryButton}
      >
        {busy ? "Loading…" : "Refresh"}
      </button>

      {!dashboard ? (
        <p style={{ color: "#475569", marginTop: 12 }}>Loading…</p>
      ) : (
        <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
          <Family title="Policy compliance" anchor="data-governance-compliance">
            <Tile label="Policies" value={dashboard.compliance.policyCount} />
            <Tile label="Active" value={dashboard.compliance.policiesActive} />
            <Tile label="Draft" value={dashboard.compliance.policiesDraft} />
            <Tile label="Deprecated" value={dashboard.compliance.policiesDeprecated} />
          </Family>
          <Family title="Access reviews" anchor="data-governance-access-reviews">
            <Tile label="Total campaigns" value={dashboard.accessReviews.totalCampaigns} />
            <Tile label="Open" value={dashboard.accessReviews.openCampaigns} />
            <Tile label="Pending items" value={dashboard.accessReviews.pendingItems} />
            <Tile label="Approved" value={dashboard.accessReviews.approvedItems} />
            <Tile label="Revoked" value={dashboard.accessReviews.revokedItems} />
            <Tile label="Escalated" value={dashboard.accessReviews.escalatedItems} />
          </Family>
          <Family title="Delegated admin" anchor="data-governance-delegated">
            <Tile label="Active grants" value={dashboard.delegatedAdminActivity.activeGrants} />
            <Tile label="Revoked · 30d" value={dashboard.delegatedAdminActivity.revokedLast30d} />
          </Family>
          <Family title="Departments" anchor="data-governance-departments-tiles">
            <Tile label="Total" value={dashboard.departments.total} />
          </Family>
          <Family title="Cross-org" anchor="data-governance-cross-org">
            <Tile label="Active" value={dashboard.crossOrg.activeGrants} />
            <Tile label="Pending invitations" value={dashboard.crossOrg.pendingInvitations} />
          </Family>
          <Family title="Policy violations" anchor="data-governance-violations">
            <Tile label="Total · 30d" value={dashboard.policyViolations.totalLast30d} />
            <Tile label="Blocking · 30d" value={dashboard.policyViolations.blockingLast30d} />
          </Family>
          <Family title="Audit health" anchor="data-governance-audit-health">
            <Tile label="Events · 24h" value={dashboard.auditHealth.activityEventsLast24h} />
            <Tile label="Events · 30d" value={dashboard.auditHealth.activityEventsLast30d} />
          </Family>
          <Family title="Security health" anchor="data-governance-security-health">
            <Tile label="MFA coverage %" value={`${dashboard.securityHealth.mfaCoveragePct}%`} />
            <Tile label="SAML" value={String(dashboard.securityHealth.samlEnabled)} />
            <Tile label="SCIM" value={String(dashboard.securityHealth.scimEnabled)} />
          </Family>
          <Family title="Trust health" anchor="data-governance-trust-health">
            <Tile label="Trust articles" value={dashboard.trustHealth.publishedTrustArticles} />
            <Tile label="Methodology" value={dashboard.trustHealth.publishedMethodologyArticles} />
            <Tile label="AI Disclosure" value={dashboard.trustHealth.publishedAiDisclosureArticles} />
            <Tile label="Security" value={dashboard.trustHealth.publishedSecurityArticles} />
            <Tile label="Subprocessors" value={dashboard.trustHealth.activeSubprocessors} />
          </Family>
          <footer
            data-governance-platform-limitations
            style={{
              marginTop: 12,
              padding: 10,
              background: "rgba(15, 23, 42, 0.04)",
              border: "1px dashed rgba(15, 23, 42, 0.18)",
              borderRadius: 8,
              fontSize: 11,
              color: "#475569",
            }}
          >
            <strong style={{ color: "#0f172a" }}>Standing limitations</strong>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {dashboard.limitations.map((l) => (
                <li key={l}><code>{l}</code></li>
              ))}
            </ul>
          </footer>
        </div>
      )}
    </div>
  );
}

function Family({
  title,
  anchor,
  children,
}: {
  title: string;
  anchor: string;
  children: React.ReactNode;
}) {
  return (
    <section
      {...({ [anchor]: "" } as Record<string, string>)}
      style={{
        padding: 12,
        background: "rgba(15, 23, 42, 0.03)",
        border: "1px solid rgba(15, 23, 42, 0.06)",
        borderRadius: 10,
      }}
    >
      <strong style={{ fontSize: 14, display: "block", marginBottom: 6 }}>{title}</strong>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 10,
        }}
      >
        {children}
      </div>
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      data-governance-tile={label}
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
        padding: 10,
      }}
    >
      <small style={{ fontSize: 11, color: "#475569", fontWeight: 600 }}>{label}</small>
      <strong style={{ fontSize: 22, display: "block", marginTop: 4 }}>{value}</strong>
    </div>
  );
}

const primaryButton = {
  padding: "6px 12px",
  border: "1px solid #0f172a",
  background: "#0f172a",
  color: "#fafafa",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
} as const;
const navLink = {
  fontSize: 12,
  color: "#0f172a",
  textDecoration: "underline",
  fontWeight: 600,
} as const;
