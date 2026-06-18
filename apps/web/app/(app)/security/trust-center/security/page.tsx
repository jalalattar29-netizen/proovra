"use client";

import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import { TrustCenterSectionList } from "../_section-list";

export default function SecurityCenterPage() {
  return (
    <PageRouteGate routeId="workspace.trust">
      <TrustCenterSectionList
        kind="SECURITY"
        title="Security Documentation Center"
        description="Authentication, authorisation, RBAC, MFA, SAML, SCIM, encryption, KMS, audit logging, evidence immutability, object lock, access controls, monitoring, incident response, disaster recovery, retention, deletion, security contacts."
        anchor="security"
      />
    </PageRouteGate>
  );
}
