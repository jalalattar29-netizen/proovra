import type { Metadata } from "next";
import { Landmark, ShieldCheck, ScrollText, Globe2, FileText, Lock } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Government — PROOVRA Solutions",
  description:
    "Transparent public-sector evidence collection with tamper-evident custody, audit trails, and independent public verification.",
};

const PAINS = [
  { title: "Public scrutiny", body: "Records may be reviewed by citizens, legislators, or oversight bodies.", Icon: Globe2, accent: "#94A3B8" },
  { title: "Long retention horizons", body: "Public-sector records often need to remain reviewable for decades.", Icon: Lock, accent: "#94A3B8" },
  { title: "Cross-agency sharing", body: "Evidence travels between agencies, courts, and counsel — losing context each step.", Icon: ScrollText, accent: "#94A3B8" },
];

const PROOVRA_CAPABILITIES = [
  { title: "Transparent collection", body: "Capture evidence with integrity signals built in from the first action.", Icon: Landmark, accent: "#2563EB" },
  { title: "Independent verification", body: "Citizens, oversight, and partners can verify records without trusting any one party.", Icon: ShieldCheck, accent: "#7C3AED" },
  { title: "Tamper-evident audit trail", body: "Linked-hash custody log and immutable audit log support long-term review.", Icon: ScrollText, accent: "#06B6D4" },
  { title: "Retention controls", body: "Policy-aware retention with legal hold for sensitive matters.", Icon: Lock, accent: "#F97316" },
  { title: "Cross-agency packages", body: "Portable signed packages let other agencies verify without account access.", Icon: Globe2, accent: "#EC4899" },
  { title: "Reviewer-ready reports", body: "Structured PDF reports for legal, oversight, and public records review.", Icon: FileText, accent: "#2563EB" },
];

export default function GovernmentPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Solutions · Government"
        title="Transparent evidence,"
        highlight="public accountability."
        description="PROOVRA helps public-sector teams capture, govern, and prove evidence in a way citizens and oversight bodies can independently verify."
        primaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondaryCta={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
      <FeatureGrid
        eyebrow="Pain points"
        title="Where public-sector evidence work struggles."
        items={PAINS}
        surface="soft"
        columns={3}
      />
      <FeatureGrid
        eyebrow="How PROOVRA helps"
        title="Six capabilities for public-sector teams."
        items={PROOVRA_CAPABILITIES}
        columns={3}
      />
      <PageCTA
        title="Public accountability,"
        highlight="independently verifiable."
        primary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondary={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
    </MarketingPage>
  );
}
