import { MarketingHeader } from "../components/marketing/MarketingHeader";
import { HeroSection } from "../components/marketing/HeroSection";
import { TrustedStandards } from "../components/marketing/TrustedStandards";
import { VerifyInstantly } from "../components/marketing/VerifyInstantly";
import { EvidenceLifecycle } from "../components/marketing/EvidenceLifecycle";
import { EvidenceOperations } from "../components/marketing/EvidenceOperations";
import { IndustriesGrid } from "../components/marketing/IndustriesGrid";
import { SecurityMethodology } from "../components/marketing/SecurityMethodology";
import { ProofInAction } from "../components/marketing/ProofInAction";
import { EnterpriseOperationsPlatform } from "../components/marketing/EnterpriseOperationsPlatform";
import { EnterpriseGovernanceSecurity } from "../components/marketing/EnterpriseGovernanceSecurity";
import { IntegrationsComplianceSection } from "../components/marketing/IntegrationsComplianceSection";
import { ImportantClarification } from "../components/marketing/ImportantClarification";
import { EnterpriseFooter } from "../components/marketing/EnterpriseFooter";

export default function HomePage() {
  return (
    <main
      className="min-h-screen w-full bg-[var(--proovra-page-bg)] text-[#0F172A]"
      style={{ fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif" }}
    >
      <MarketingHeader />
      <HeroSection />
      <TrustedStandards />
      <VerifyInstantly />
      <EvidenceLifecycle />
      <EvidenceOperations />
      <IndustriesGrid />
      <SecurityMethodology />
      <ProofInAction />
      <EnterpriseOperationsPlatform />
      <EnterpriseGovernanceSecurity />
      <IntegrationsComplianceSection />
      <ImportantClarification />
      <EnterpriseFooter />
    </main>
  );
}
