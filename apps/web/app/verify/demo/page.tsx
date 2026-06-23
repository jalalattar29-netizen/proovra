"use client";

// Composition-only page. Section bodies live under
// `apps/web/components/verify-demo/*` to keep this file under the
// PRE_CR4_VERIFY_DEMO_BYTES guard (Phase CR4 decomposition).

import { MarketingHeader } from "../../../components/marketing/MarketingHeader";
import { EnterpriseFooter } from "../../../components/marketing/EnterpriseFooter";
import { DEMO_VERIFY_URL } from "../../../components/verify-demo/_shared";
import { Hero } from "../../../components/verify-demo/Hero";
import { WhatReviewerSees } from "../../../components/verify-demo/WhatReviewerSees";
import { Walkthrough } from "../../../components/verify-demo/Walkthrough";
import { LifecycleTimeline } from "../../../components/verify-demo/LifecycleTimeline";
import { ExampleRecordAndOutputs } from "../../../components/verify-demo/ExampleRecordAndOutputs";
import { ImportantClarification } from "../../../components/verify-demo/ImportantClarification";
import { BottomCTA } from "../../../components/verify-demo/BottomCTA";
import { RevealSection } from "../../../components/motion";

export default function VerificationDemoPage() {
  const handleCopyLink = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard
        .writeText(
          typeof window !== "undefined"
            ? `${window.location.origin}${DEMO_VERIFY_URL}`
            : DEMO_VERIFY_URL,
        )
        .then(() => {
          alert("Demo verification link copied to clipboard.");
        })
        .catch(() => {
          alert("Could not copy. This is a demo link.");
        });
    } else {
      alert("Demo verification link: " + DEMO_VERIFY_URL);
    }
  };

  return (
    <div className="page landing-page bg-[var(--proovra-page-bg)]">
      <MarketingHeader />
      <Hero />
      <RevealSection direction="up"><WhatReviewerSees /></RevealSection>
      <RevealSection direction="right"><Walkthrough onCopyLink={handleCopyLink} /></RevealSection>
      <RevealSection direction="left"><LifecycleTimeline /></RevealSection>
      <RevealSection direction="up"><ExampleRecordAndOutputs /></RevealSection>
      <RevealSection direction="right"><ImportantClarification /></RevealSection>
      <RevealSection direction="left"><BottomCTA /></RevealSection>
      <EnterpriseFooter />
    </div>
  );
}
