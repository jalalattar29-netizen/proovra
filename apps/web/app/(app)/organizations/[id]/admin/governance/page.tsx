"use client";

/**
 * Phase 8 — Org admin / Governance tab.
 *
 * Honest summary card + canonical deep-links. Governance policy CRUD
 * lives on the workspace-scoped Governance Platform surface (Phase 4A),
 * so we do NOT fabricate org-scoped policy counts from this org-admin
 * surface. We surface the canonical entry points instead.
 *
 * Constitutional checks satisfied:
 *
 *   - Wrapped in <PageRouteGate routeId="account.organization-detail">.
 *   - Governance remains a feature area, not a workspace.
 *   - No raw window.confirm (page is read-only).
 *   - No platform-context workspace-fragment reads.
 *   - Strong TypeScript types throughout.
 */

import Link from "next/link";
import { useParams } from "next/navigation";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";

export default function OrganizationAdminGovernancePage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <GovernanceTab />
    </PageRouteGate>
  );
}

function GovernanceTab() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";

  return (
    <section data-testid="org-admin-governance" data-org-id={orgId}>
      <section
        data-section="governance-summary"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Governance posture</h2>
        <p style={{ fontSize: 13, opacity: 0.85, marginTop: 8 }}>
          Governance policies (retention, access, redaction, classification,
          export, evidence-handling) are evaluated against the active
          workspace. Each policy emits POLICY_VIOLATION codes when broken;
          mutation requires a delegated administration tier
          (SECURITY_OFFICER or COMPLIANCE_OFFICER).
        </p>
        <p
          data-state="not-configured-explainer"
          style={{
            fontSize: 12,
            opacity: 0.7,
            marginTop: 8,
            padding: "0.5rem 0.6rem",
            borderLeft: "3px solid rgba(127,127,127,0.45)",
            background: "rgba(127,127,127,0.06)",
          }}
        >
          Policy CRUD is intentionally NOT duplicated here. Use the
          canonical workspace-scoped surface so audit + drift detection
          remains a single source of truth.
        </p>
      </section>

      <section
        data-section="governance-deep-links"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Canonical governance surfaces</h2>
        <ul style={{ listStyle: "none", padding: 0, margin: "0.5rem 0 0" }}>
          <DeepLink
            testId="gov-deep-link-platform"
            label="Governance Platform"
            description="Policies + departments + delegated administration."
            href="/governance-platform"
          />
          <DeepLink
            testId="gov-deep-link-policies"
            label="Policies"
            description="Retention, access, redaction, classification, export, evidence-handling."
            href="/governance-platform/policies"
          />
          <DeepLink
            testId="gov-deep-link-delegated-admin"
            label="Delegated administration"
            description="Tier-scoped admins (SECURITY_OFFICER, COMPLIANCE_OFFICER, etc.)."
            href="/governance-platform/delegated-admin"
          />
          <DeepLink
            testId="gov-deep-link-dashboard"
            label="Governance dashboard"
            description="Cross-workspace posture, drift, and policy hit counts."
            href="/governance-platform"
          />
        </ul>
      </section>
    </section>
  );
}

function DeepLink({
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
