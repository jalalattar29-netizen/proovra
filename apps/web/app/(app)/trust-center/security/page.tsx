"use client";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { TrustCenterSectionList } from "../_section-list";

export default function SecurityCenterPage() {
  return (
    <PageRouteGate routeId="workspace.trust_center">
      <TrustCenterSectionList
        kind="SECURITY"
        title="Security Documentation Center"
        description="Authentication, authorisation, RBAC, MFA, SAML, SCIM, encryption, KMS, audit logging, evidence immutability, object lock, access controls, monitoring, incident response, disaster recovery, retention, deletion, security contacts."
        anchor="security"
        relatedLinks={[
          { label: "Security & Responsible Disclosure", href: "/legal/security" },
          { label: "Incident Response Policy", href: "/legal/incident-response" },
          {
            label: "Technical & Organizational Measures",
            href: "/legal/toms",
          },
        ]}
      />
    </PageRouteGate>
  );
}
