import { MarketingHeader } from "../components/marketing/MarketingHeader";
import { HeroSection } from "../components/marketing/HeroSection";
import { TrustedStandards } from "../components/marketing/TrustedStandards";
import { VerifyInstantly } from "../components/marketing/VerifyInstantly";
import { EvidenceLifecycle } from "../components/marketing/EvidenceLifecycle";
import { IndustriesGrid } from "../components/marketing/IndustriesGrid";
import { SecurityMethodology } from "../components/marketing/SecurityMethodology";
import { ProofInAction } from "../components/marketing/ProofInAction";
import { Workflows } from "../components/marketing/Workflows";
import { CapabilityImpact } from "../components/marketing/CapabilityImpact";
import { ImportantClarification } from "../components/marketing/ImportantClarification";
import { EnterpriseFooter } from "../components/marketing/EnterpriseFooter";

export default function HomePage() {
  return (
    <main
      className="min-h-screen w-full bg-white text-[#0F172A]"
      style={{ fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif" }}
    >
      <MarketingHeader />
      <HeroSection />
      <TrustedStandards />
      <VerifyInstantly />
      <EvidenceLifecycle />
      <IndustriesGrid />
      <SecurityMethodology />
      <ProofInAction />
      <Workflows />
      <CapabilityImpact />
      <ImportantClarification />
      <EnterpriseFooter />
    </main>
  );
}
