import type { Metadata } from "next";
import { Search, ShieldCheck, ScrollText, Briefcase, Lock, FileText } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { LegalClarification } from "../../../components/marketing/page-shell/LegalClarification";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Corporate Investigations — PROOVRA Solutions",
  description:
    "Internal incident evidence, audit trails, access controls, and reviewable evidence operations for corporate investigations and compliance teams.",
};

const PAINS = [
  { title: "Sensitive incidents", body: "Investigations require strict confidentiality and rigorous custody from day one.", Icon: Lock, accent: "#94A3B8" },
  { title: "Distributed evidence", body: "Reports come from many channels with inconsistent context and timing.", Icon: Search, accent: "#94A3B8" },
  { title: "Audit-ready expectations", body: "Findings will be reviewed by legal, audit, and sometimes regulators.", Icon: ScrollText, accent: "#94A3B8" },
];

const PROOVRA_CAPABILITIES = [
  { title: "Case-organized evidence", body: "Group incident evidence into a case with strict scope and assignment.", Icon: Briefcase, accent: "#2563EB" },
  { title: "Access controls", body: "Role-based access with department scoping and delegated administration.", Icon: Lock, accent: "#7C3AED" },
  { title: "Immutable audit log", body: "Every access, change, and decision is recorded in a tamper-evident log.", Icon: ScrollText, accent: "#06B6D4" },
  { title: "Tamper-evident custody", body: "Linked-hash custody log records every action with prior-event binding.", Icon: ShieldCheck, accent: "#F97316" },
  { title: "Reviewer-ready reports", body: "Generate audit-ready PDF reports with integrity proof and audit trail.", Icon: FileText, accent: "#EC4899" },
  { title: "Cross-org sharing", body: "Share signed verification packages with legal, audit, or external advisors.", Icon: Search, accent: "#2563EB" },
];

export default function CorporateInvestigationsPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Solutions · Corporate Investigations"
        title="Internal investigations,"
        highlight="organized and defensible."
        description="PROOVRA gives corporate investigators a private, structured workspace where evidence is captured, governed, and reviewable end-to-end."
        primaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondaryCta={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
      <FeatureGrid
        eyebrow="Pain points"
        title="Where investigations get hard today."
        items={PAINS}
        surface="soft"
        columns={3}
      />
      <FeatureGrid
        eyebrow="How PROOVRA helps"
        title="Six capabilities for incident response."
        items={PROOVRA_CAPABILITIES}
        columns={3}
      />
      <LegalClarification />
      <PageCTA
        title="Investigate,"
        highlight="defend, and close out."
        primary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondary={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
    </MarketingPage>
  );
}
