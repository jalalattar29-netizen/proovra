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
import { PageShell, PageHeader, PageSection } from "../../../components/ui/PageShell";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
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
    <PageShell
      data-governance-platform
      header={
        <PageHeader
          eyebrow="Governance"
          title="Governance Platform"
          subtitle="Compliance · access reviews · delegated administration · cross-org · policy violations · audit health · security health · trust health."
          primaryAction={
            <Button
              variant="enterprise"
              data-governance-platform-refresh
              disabled={busy}
              loading={busy}
              onClick={() => void refresh()}
            >
              {busy ? "Loading…" : "Refresh"}
            </Button>
          }
        />
      }
    >
      <nav
        data-governance-platform-nav
        style={{ display: "flex", gap: 10, flexWrap: "wrap" }}
      >
        <a data-governance-platform-link="departments" href="/governance-platform/departments" style={navLink}>Departments</a>
        <a data-governance-platform-link="delegated-admin" href="/governance-platform/delegated-admin" style={navLink}>Delegated Admin</a>
        <a data-governance-platform-link="policies" href="/governance-platform/policies" style={navLink}>Policies</a>
        <a data-governance-platform-link="access-reviews" href="/governance-platform/access-reviews" style={navLink}>Access Reviews</a>
        <a data-governance-platform-link="cross-org" href="/governance-platform/cross-org" style={navLink}>Cross-Org</a>
      </nav>

      {!dashboard ? (
        <EmptyState
          framed
          title="Loading governance metrics…"
          purpose="Compliance, access-review, delegated-admin and cross-org posture appears here once the governance dashboard loads."
        />
      ) : (
        <>
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
          <Card
            variant="admin"
            padding="compact"
            data-governance-platform-limitations
          >
            <strong style={{ color: "var(--ink-primary, #0f172a)", fontSize: 12 }}>Standing limitations</strong>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 11, color: "var(--ink-secondary, #475569)" }}>
              {dashboard.limitations.map((l) => (
                <li key={l}><code>{l}</code></li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </PageShell>
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
    <PageSection title={title} {...({ [anchor]: "" } as Record<string, string>)}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 10,
        }}
      >
        {children}
      </div>
    </PageSection>
  );
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <Card variant="summary" padding="compact" data-governance-tile={label}>
      <small style={{ fontSize: 11, color: "var(--ink-secondary, #475569)", fontWeight: 600 }}>{label}</small>
      <strong style={{ fontSize: 22, display: "block", marginTop: 4 }}>{value}</strong>
    </Card>
  );
}

const navLink = {
  fontSize: 12,
  color: "var(--ink-primary, #0f172a)",
  textDecoration: "underline",
  fontWeight: 600,
} as const;
