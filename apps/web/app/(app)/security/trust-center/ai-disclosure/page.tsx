"use client";

import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import { TrustCenterSectionList } from "../_section-list";

export default function AiDisclosurePage() {
  return (
    <PageRouteGate routeId="workspace.trust">
      <TrustCenterSectionList
        kind="AI_DISCLOSURE"
        title="AI Disclosure Center"
        description="Models used, providers used, data sent, data NOT sent, confidence model, human review model, correction model, limitations, known risks, provider status, AI activity transparency, cost transparency."
        anchor="ai-disclosure"
      />
    </PageRouteGate>
  );
}
