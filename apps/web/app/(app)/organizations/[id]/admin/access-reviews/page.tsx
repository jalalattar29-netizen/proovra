"use client";

/**
 * Phase 8 — Org admin / Access reviews tab.
 *
 * Honest summary + deep-link card. Access review campaign CRUD lives on
 * the workspace-scoped Governance Platform surface (Phase 4A), where
 * mutation enforces a delegated-tier check + REVOKED outcomes actually
 * revoke grants. From an org-admin context (no required active
 * workspace) we link out rather than fabricate campaign aggregates.
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
 * system. Renders inside the org admin shell (which owns the org title +
 * tab bar), so uses PageSection — not a duplicate PageHeader.
 */

import Link from "next/link";
import { useParams } from "next/navigation";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { PageSection } from "../../../../../../components/ui/PageShell";
import { Card } from "../../../../../../components/ui/Card";
import { Button } from "../../../../../../components/ui/Button";

export default function OrganizationAdminAccessReviewsPage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <AccessReviewsTab />
    </PageRouteGate>
  );
}

function AccessReviewsTab() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";

  return (
    <section
      data-testid="org-admin-access-reviews"
      data-org-id={orgId}
      style={{ display: "flex", flexDirection: "column", gap: 24 }}
    >
      <Card variant="admin" data-section="access-reviews-summary" title="Access reviews">
        <p
          style={{
            margin: 0,
            fontSize: 13.5,
            lineHeight: 1.6,
            color: "var(--ink-secondary, #475569)",
          }}
        >
          Periodic access-review campaigns evaluate every grant for an
          organization's workspaces. REVOKED decisions execute against the
          underlying grant in the same transaction — campaigns are not
          paper exercises.
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
          No campaign is required by default. If your org needs one, run
          it from the canonical surface so audit + revocation execute
          atomically.
        </div>
      </Card>

      <PageSection
        title="Canonical access review surfaces"
        description="Run and decide campaigns on the Governance Platform, where revocation is atomic and audited."
      >
        <div
          data-section="access-reviews-deep-links"
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
          <DeepLink
            testId="ar-deep-link-list"
            label="Access reviews"
            description="List, run, and decide pending access-review campaigns."
            href="/governance-platform/access-reviews"
          />
          <DeepLink
            testId="ar-deep-link-platform"
            label="Governance Platform"
            description="Cross-workspace governance dashboard (drift, policy hits, posture)."
            href="/governance-platform"
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
