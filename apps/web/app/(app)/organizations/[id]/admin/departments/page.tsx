"use client";

/**
 * Phase 8 — Org admin / Departments tab.
 *
 * Honest "thin summary + canonical deep-link" page. Department CRUD
 * lives on the workspace-scoped Governance Platform surface (Phase 4A).
 * From the org-admin context we cannot reliably assume an active
 * workspace is bound to this organization, so we render a small
 * informational card + a deep-link rather than fabricating org-scoped
 * department counts.
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

export default function OrganizationAdminDepartmentsPage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <DepartmentsTab />
    </PageRouteGate>
  );
}

function DepartmentsTab() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";

  return (
    <section data-testid="org-admin-departments" data-org-id={orgId}>
      <section
        data-section="departments-summary"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Departments</h2>
        <p style={{ fontSize: 13, opacity: 0.85, marginTop: 8 }}>
          Departments live on the workspace-scoped Governance Platform surface.
          Members are mapped to departments via the canonical
          <code> /v1/governance/departments </code>
          endpoint. The mutation surface enforces delegated-tier checks
          (ORG_ADMIN+) and emits POLICY-aware audit events.
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
          Department CRUD is intentionally NOT duplicated here. Use the
          canonical surface so audit events + drift detection remain a
          single source of truth.
        </p>
      </section>

      <section
        data-section="departments-deep-links"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Canonical departments surface</h2>
        <ul style={{ listStyle: "none", padding: 0, margin: "0.5rem 0 0" }}>
          <DeepLink
            testId="dept-deep-link-platform"
            label="Governance Platform · Departments"
            description="List, create, archive departments scoped to the active workspace's organization."
            href="/governance-platform/departments"
          />
          <DeepLink
            testId="dept-deep-link-delegated-admin"
            label="Delegated administration"
            description="Grant tier-scoped admin powers (DEPT_ADMIN, SECURITY_OFFICER, etc.)."
            href="/governance-platform/delegated-admin"
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
