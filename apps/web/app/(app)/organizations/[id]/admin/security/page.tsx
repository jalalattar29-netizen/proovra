"use client";

/**
 * Phase 12 STEP-3 — Org admin / Security tab.
 *
 * The real OrganizationSecurityPolicy editor. The editor itself lives in
 * components/organizations/OrganizationSecurityPolicyEditor.tsx so it can be
 * unit-rendered directly (bypassing PageRouteGate + platform-context) per the
 * render-test convention. This page only resolves the org id + route gate.
 */

import { useParams } from "next/navigation";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { OrganizationSecurityPolicyEditor } from "../../../../../../components/organizations/OrganizationSecurityPolicyEditor";
import { HeldEmergencyGrantsPanel } from "../../../../../../components/identity-security/HeldEmergencyGrantsPanel";

export default function OrganizationAdminSecurityPage() {
  const params = useParams<{ id: string }>();
  const orgId = typeof params?.id === "string" ? params.id : "";
  return (
    <PageRouteGate routeId="account.organization-detail">
      {/* AUD-0037 — emergency access a PROOVRA operator named this
          administrator to hold over this Organization. Nothing renders unless
          they hold a live grant here. */}
      {orgId ? <HeldEmergencyGrantsPanel organizationId={orgId} /> : null}
      <OrganizationSecurityPolicyEditor orgId={orgId} />
    </PageRouteGate>
  );
}
