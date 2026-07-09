"use client";

/**
 * Phase 8 — Org admin / Trust tab.
 *
 * Surfaces canonical Trust Center deep-links. The /v1/trust/articles
 * and /v1/trust/subprocessors endpoints are workspace-scoped (require
 * an active workspace context); from a pure org-admin context we link
 * to the canonical surfaces rather than fabricate counts.
 *
 * Constitutional checks satisfied:
 *
 *   - Wrapped in <PageRouteGate routeId="account.organization-detail">.
 *   - No raw window.confirm (read-only).
 *   - No platform-context workspace-fragment reads.
 *   - Strong TypeScript types throughout.
 *
 * Phase 7 (Enterprise UX): presentation migrated to the shared design
 * system (PageSection + Card + Button). This tab renders INSIDE the org
 * admin layout shell (which already owns the org title + tab bar), so it
 * uses PageSection — not a second PageHeader — to avoid a duplicate title.
 */

import Link from "next/link";
import { useParams } from "next/navigation";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { PageSection } from "../../../../../../components/ui/PageShell";
import { Card } from "../../../../../../components/ui/Card";
import { Button } from "../../../../../../components/ui/Button";

export default function OrganizationAdminTrustPage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <TrustTab />
    </PageRouteGate>
  );
}

function TrustTab() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";

  return (
    <section
      data-testid="org-admin-trust"
      data-org-id={orgId}
      style={{ display: "flex", flexDirection: "column", gap: 24 }}
    >
      <Card
        variant="admin"
        data-section="trust-summary"
        title="Trust Center"
      >
        <p
          style={{
            margin: 0,
            fontSize: 13.5,
            lineHeight: 1.6,
            color: "var(--ink-secondary, #475569)",
          }}
        >
          The Trust Center publishes versioned trust articles (security
          policy, methodology, AI disclosure, etc.) and the subprocessor
          registry. Article + subprocessor CRUD lives on the canonical
          workspace-scoped surface; drift detection runs against the
          published versions.
        </p>
      </Card>

      <PageSection
        title="Canonical trust surfaces"
        description="Published trust content lives on the canonical workspace-scoped pages. Open them below."
      >
        <div
          data-section="trust-deep-links"
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
          <DeepLink
            testId="trust-deep-link-center"
            label="Trust Center"
            description="Published trust articles (security, methodology, AI disclosure, …)."
            href="/trust-hub"
          />
          <DeepLink
            testId="trust-deep-link-subprocessors"
            label="Subprocessors"
            description="Subprocessor registry + version history."
            href="/trust-center/subprocessors"
          />
          <DeepLink
            testId="trust-deep-link-status"
            label="Status page"
            description="Live + historical status of the platform's internal + external dependencies."
            href="/trust-center/status"
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
