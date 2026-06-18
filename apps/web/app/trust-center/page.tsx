import type { Metadata } from "next";
import { ShieldCheck, Lock, Compass, ScrollText, FileText, Sparkles, LifeBuoy, Globe2 } from "lucide-react";
import { MarketingPage } from "../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../components/marketing/page-shell/FeatureGrid";
import { LegalClarification } from "../../components/marketing/page-shell/LegalClarification";
import { PageCTA } from "../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Trust Center — PROOVRA",
  description:
    "Security posture, privacy, verification methodology, legal clarification, subprocessors, DPA, and verification demos for PROOVRA.",
};

const HUB_ITEMS = [
  { title: "Security", body: "Access controls, audit logging, MFA, identity integration, and storage protection.", Icon: Lock, accent: "#2563EB" },
  { title: "Privacy", body: "How PROOVRA processes evidence and personal data — designed for review-sensitive workflows.", Icon: ShieldCheck, accent: "#7C3AED" },
  { title: "Verification Methodology", body: "What PROOVRA checks during verification — and what it does not assert.", Icon: Compass, accent: "#06B6D4" },
  { title: "Legal Clarification", body: "Honest scope of what PROOVRA does and does not establish in any matter.", Icon: ScrollText, accent: "#F97316" },
  { title: "Subprocessors", body: "List of vendors and infrastructure providers we use to operate the platform.", Icon: Globe2, accent: "#EC4899" },
  { title: "DPA", body: "Data Processing Agreement for enterprise and regulated customers.", Icon: ScrollText, accent: "#2563EB" },
  { title: "Verification Demo", body: "Try a live verification against a sample evidence package.", Icon: Sparkles, accent: "#7C3AED" },
  { title: "Sample Report", body: "See an example evidence report with integrity proof and audit trail.", Icon: FileText, accent: "#06B6D4" },
  { title: "Contact Security / Support", body: "Reach security or support for responsible disclosure or evaluation questions.", Icon: LifeBuoy, accent: "#F97316" },
];

export default function TrustCenterPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Trust Center"
        title="Trust, designed to be"
        highlight="independently verifiable."
        description="The Trust Center is where PROOVRA documents the security posture, verification methodology, and honest limits of what we do — so reviewers never have to guess."
        primaryCta={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondaryCta={{ label: "Read methodology", href: MARKETING_LINKS.technology.verificationMethodology }}
      />
      <FeatureGrid
        eyebrow="Trust resources"
        title="Everything in one place."
        description="PROOVRA is designed to support enterprise security review. Where certifications are not yet held, we say so — we do not display fake badges."
        items={HUB_ITEMS}
        surface="soft"
        columns={3}
      />
      <LegalClarification />
      <PageCTA
        title="Have a trust question"
        highlight="we should answer?"
        primary={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
        secondary={{ label: "Support", href: MARKETING_LINKS.support }}
      />
    </MarketingPage>
  );
}
