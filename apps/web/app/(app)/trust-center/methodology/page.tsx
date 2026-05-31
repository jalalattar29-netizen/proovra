"use client";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { TrustCenterSectionList } from "../_section-list";

export default function MethodologyPage() {
  return (
    <PageRouteGate routeId="workspace.trust_center">
      <TrustCenterSectionList
        kind="METHODOLOGY"
        title="Verification Methodology Center"
        description="How verification, hashing, trusted timestamps, OpenTimestamps, provenance, verification packages, trust decisions, redaction, and intelligence work. Sourced from actual implementation."
        anchor="methodology"
      />
    </PageRouteGate>
  );
}
