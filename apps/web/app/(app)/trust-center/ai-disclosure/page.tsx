"use client";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { TrustCenterSectionList } from "../_section-list";
import { AiCapabilityStatusTable } from "../../../../components/ai-copilot/AiCapabilityStatusTable";

export default function AiDisclosurePage() {
  return (
    <PageRouteGate routeId="workspace.trust_center">
      <TrustCenterSectionList
        kind="AI_DISCLOSURE"
        title="AI Disclosure Center"
        description="Models used, providers used, data sent, data NOT sent, confidence model, human review model, correction model, limitations, known risks, provider status, AI activity transparency, cost transparency."
        anchor="ai-disclosure"
        /* Phase A1 — live, backend-computed capability status (never
           inferred). Renders at the top of the canonical document body. */
        beforeArticles={
          <div className="mb-8">
            <AiCapabilityStatusTable />
          </div>
        }
        relatedLinks={[
          { label: "AI Use Policy", href: "/legal/ai-use-policy" },
          { label: "Subprocessors", href: "/legal/subprocessors" },
        ]}
      />
    </PageRouteGate>
  );
}
