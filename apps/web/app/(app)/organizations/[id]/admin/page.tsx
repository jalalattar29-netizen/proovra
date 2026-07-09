"use client";

/**
 * Phase 8 — Org admin index → redirects to /overview.
 *
 * The admin shell expects every visit to land on a tab. The index page
 * client-redirects to /admin/overview so the layout's tab bar always
 * has an active tab. We also render a server-friendly fallback link
 * for clients with JS disabled.
 *
 * Constitutional checks satisfied:
 *
 *   - PageRouteGate wraps the surface so denied callers see the
 *     canonical "request access" panel rather than a blank redirect.
 *   - Reuses the existing account.organization-detail routeId so we
 *     don't introduce a new capability surface.
 *
 * Phase 7C — premium visual pass. The redirect fallback is now framed in
 * the shared design system (PageShell / PageHeader + Card / Button) so
 * the brief pre-redirect flash reads as a first-class console surface
 * rather than a bare template line. Behaviour, gating, and the
 * data-testid are unchanged.
 */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader } from "../../../../../components/ui";
import { Card } from "../../../../../components/ui/Card";
import { Button } from "../../../../../components/ui/Button";

export default function OrganizationAdminIndexPage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <OrganizationAdminIndexInner />
    </PageRouteGate>
  );
}

function OrganizationAdminIndexInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const orgId = params?.id ?? "";

  useEffect(() => {
    if (!orgId) return;
    router.replace(`/organizations/${orgId}/admin/overview`);
  }, [orgId, router]);

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Enterprise administration"
          title="Organization admin"
          subtitle="Opening the administration overview — plan, seats, members, identity, domains, retention, and audit posture."
        />
      }
    >
      <section
        data-testid="org-admin-index-fallback"
        style={{ display: "block" }}
      >
        <Card variant="status" tone="governance" padding="comfortable">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 16,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 650,
                  color: "var(--ink-primary, #0f172a)",
                }}
              >
                Redirecting to overview…
              </div>
              <p
                style={{
                  margin: "4px 0 0",
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: "var(--ink-secondary, #475569)",
                }}
              >
                You are being taken to the administration overview tab. If it
                does not open automatically, use the button.
              </p>
            </div>
            {orgId ? (
              <Link
                href={`/organizations/${orgId}/admin/overview`}
                style={{ textDecoration: "none", flexShrink: 0 }}
              >
                <Button variant="enterprise">Open overview tab</Button>
              </Link>
            ) : null}
          </div>
        </Card>
      </section>
    </PageShell>
  );
}
