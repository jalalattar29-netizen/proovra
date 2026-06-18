import type { Metadata } from "next";
import { Plug, KeyRound, Webhook, Lock, ShieldCheck, ScrollText } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { LegalClarification } from "../../../components/marketing/page-shell/LegalClarification";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Integrations — PROOVRA Platform",
  description:
    "Connect PROOVRA to your stack with a REST API, HMAC-signed webhooks, and enterprise identity integrations.",
};

const FEATURES = [
  { title: "REST API", body: "Bearer-token authenticated REST API for evidence, records, packages, and verification.", Icon: Plug, accent: "#2563EB" },
  { title: "API keys", body: "Issue and revoke scoped API keys; only the hash of each key is stored.", Icon: KeyRound, accent: "#7C3AED" },
  { title: "Webhooks", body: "HMAC-SHA256 signed webhook deliveries with a versioned signature header.", Icon: Webhook, accent: "#06B6D4" },
  { title: "Identity integration", body: "SAML 2.0 SSO and SCIM 2.0 provisioning for enterprise teams.", Icon: ShieldCheck, accent: "#F97316" },
  { title: "Secure by default", body: "Least-privilege scopes, audit-logged usage, and key rotation guidance.", Icon: Lock, accent: "#EC4899" },
  { title: "Audit-logged usage", body: "Every API call and webhook delivery is logged for review and reconciliation.", Icon: ScrollText, accent: "#2563EB" },
];

export default function IntegrationsPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Platform · Integrations"
        title="A secure integration"
        highlight="surface for your stack."
        description="PROOVRA connects to your evidence pipeline with a REST API, HMAC-signed webhooks, and identity-aware integrations — not a sprawl of point connectors."
        primaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondaryCta={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
      <FeatureGrid
        eyebrow="Integration capabilities"
        title="API + webhooks + identity."
        items={FEATURES}
        surface="soft"
        columns={3}
      />
      <LegalClarification />
      <PageCTA
        title="Wire PROOVRA into"
        highlight="your evidence pipeline."
        primary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondary={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
    </MarketingPage>
  );
}
