"use client";

/**
 * Public Verify — enterprise landing.
 *
 * Composition-only. Each section lives in `_components/` so this file
 * stays under the CR4 byte-size guard
 * (`PRE_CR4_VERIFY_LANDING_BYTES = 21548` in
 * `services/api/test/phase-cr4-verify-decomposition.test.ts`).
 *
 * Sibling page: `/offline-verifier`.
 *
 * Routing contract preserved verbatim in `_components/VerifyHero.tsx`:
 *   POST → router.push(`/verify/${encodeURIComponent(token)}`).
 *
 * Safe-language contract: this page must NOT claim factual truth,
 * authorship, legal admissibility, court acceptance, identity proof,
 * or evidentiary weight.
 */

import { EnterpriseFooter } from "../../components/marketing/EnterpriseFooter";
import { RevealSection } from "../../components/motion";
import { VerifyHero } from "./_components/VerifyHero";
import { VerifyMaterialsSection } from "./_components/VerifyMaterialsSection";
import { VerifyOpensSection } from "./_components/VerifyOpensSection";
import { VerifyComparisonSection } from "./_components/VerifyComparisonSection";
import { VerifyBoundariesSection } from "./_components/VerifyBoundariesSection";
import { VerifyUseCasesSection } from "./_components/VerifyUseCasesSection";
import { VerifyFinalCta } from "./_components/VerifyFinalCta";

export default function VerifyIntroPage() {
  return (
    <>
      <main className="bg-white" data-testid="verify-root">
        <VerifyHero />
        <RevealSection direction="up">
          <VerifyMaterialsSection />
        </RevealSection>
        <RevealSection direction="right">
          <VerifyOpensSection />
        </RevealSection>
        <RevealSection direction="left">
          <VerifyComparisonSection />
        </RevealSection>
        <RevealSection direction="up">
          <VerifyBoundariesSection />
        </RevealSection>
        <RevealSection direction="right">
          <VerifyUseCasesSection />
        </RevealSection>
        <RevealSection direction="up">
          <VerifyFinalCta />
        </RevealSection>
      </main>
      <EnterpriseFooter />
    </>
  );
}
