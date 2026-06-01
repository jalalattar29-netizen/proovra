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
 */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";

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
    <section
      data-testid="org-admin-index-fallback"
      style={{ padding: "1rem 0", fontSize: 13 }}
    >
      Redirecting to overview…{" "}
      {orgId ? (
        <Link href={`/organizations/${orgId}/admin/overview`}>
          Open overview tab
        </Link>
      ) : null}
    </section>
  );
}
