import type { Metadata } from "next";
import { Lock, KeyRound, Eye, ShieldCheck, Globe2, ScrollText } from "lucide-react";
import { MarketingPage } from "../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../components/marketing/page-shell/FeatureGrid";
import { LegalClarification } from "../../components/marketing/page-shell/LegalClarification";
import { PageCTA } from "../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Security — PROOVRA",
  description:
    "Access controls, identity integration, MFA, immutable audit logging, storage protection, and responsible disclosure.",
};

const ITEMS = [
  { title: "Access controls", body: "Role-based access with department scoping and delegated administration.", Icon: KeyRound, accent: "#2563EB" },
  { title: "MFA", body: "TOTP-based multi-factor authentication with recovery codes.", Icon: ShieldCheck, accent: "#7C3AED" },
  { title: "Identity integration", body: "SAML 2.0 SSO and SCIM 2.0 provisioning for enterprise teams.", Icon: Globe2, accent: "#06B6D4" },
  { title: "Immutable audit logging", body: "Every access, change, and decision is recorded in a tamper-evident log.", Icon: ScrollText, accent: "#F97316" },
  { title: "Storage protection", body: "Object lock / immutable storage with configurable retention modes where deployed.", Icon: Lock, accent: "#EC4899" },
  { title: "Responsible disclosure", body: "We welcome security reports through our security contact. Coordinated disclosure preferred.", Icon: Eye, accent: "#2563EB" },
];

export default function SecurityPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Security"
        title="Security architecture,"
        highlight="designed for review."
        description="PROOVRA is designed to support enterprise security review with role-based access, identity integration, MFA, immutable audit logging, and storage protection — and is honest about controls that are configuration-dependent."
        primaryCta={{ label: "Visit Trust Center", href: MARKETING_LINKS.trustCenter }}
        secondaryCta={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
      <FeatureGrid
        eyebrow="Security controls"
        title="Six controls security teams ask about most."
        description="Controls listed here describe platform capabilities. Specific configurations and certifications depend on deployment, contract, and customer requirements."
        items={ITEMS}
        surface="soft"
        columns={3}
      />
      <LegalClarification />
      <PageCTA
        title="Bring our security posture"
        highlight="into your review."
        primary={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
        secondary={{ label: "Visit Trust Center", href: MARKETING_LINKS.trustCenter }}
      />
    </MarketingPage>
  );
}
