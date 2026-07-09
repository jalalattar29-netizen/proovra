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
 *
 * Phase 7 (Enterprise UX): presentation migrated to the shared design
 * system (PageSection + Card + Button). Renders inside the org admin
 * shell (which owns the org title + tab bar), so uses PageSection — not
 * a duplicate PageHeader.
 */

import Link from "next/link";
import { useParams } from "next/navigation";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { PageSection } from "../../../../../../components/ui/PageShell";
import { Card } from "../../../../../../components/ui/Card";
import { Button } from "../../../../../../components/ui/Button";

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
    <section
      data-testid="org-admin-departments"
      data-org-id={orgId}
      style={{ display: "flex", flexDirection: "column", gap: 24 }}
    >
      <Card variant="admin" data-section="departments-summary" title="Departments">
        <p
          style={{
            margin: 0,
            fontSize: 13.5,
            lineHeight: 1.6,
            color: "var(--ink-secondary, #475569)",
          }}
        >
          Departments live on the workspace-scoped Governance Platform surface.
          Members are mapped to departments via the canonical
          <code> /v1/governance/departments </code>
          endpoint. The mutation surface enforces delegated-tier checks
          (ORG_ADMIN+) and emits POLICY-aware audit events.
        </p>
        <div
          data-state="not-configured-explainer"
          style={{
            marginTop: 12,
            padding: "10px 12px",
            borderLeft: "3px solid var(--status-neutral-solid, #64748b)",
            background: "var(--surface-muted, #f1f4f9)",
            borderRadius: 6,
            fontSize: 12.5,
            lineHeight: 1.55,
            color: "var(--ink-secondary, #475569)",
          }}
        >
          Department CRUD is intentionally NOT duplicated here. Use the
          canonical surface so audit events + drift detection remain a
          single source of truth.
        </div>
      </Card>

      <PageSection
        title="Canonical departments surface"
        description="Manage departments and delegated administration on the Governance Platform, scoped to the active workspace's organization."
      >
        <div
          data-section="departments-deep-links"
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
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
        </div>
      </PageSection>
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
