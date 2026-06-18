import type { Metadata } from "next";
import { Scale, ScrollText, Briefcase, Package, ShieldCheck, FileText } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { LegalClarification } from "../../../components/marketing/page-shell/LegalClarification";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Legal & eDiscovery — PROOVRA Solutions",
  description:
    "Matter review, custody timeline, review-ready reports, verification packages, and legal hold for legal and eDiscovery teams.",
};

const PAINS = [
  { title: "Scattered evidence", body: "Files arrive from many systems with inconsistent context and metadata.", Icon: Briefcase, accent: "#94A3B8" },
  { title: "Weak custody trail", body: "Ad-hoc trackers and email threads leave gaps that surface during disputes.", Icon: ScrollText, accent: "#94A3B8" },
  { title: "Hard to share with counsel", body: "External counsel and opposing parties need defensible bundles, not zip files.", Icon: Package, accent: "#94A3B8" },
];

const PROOVRA_CAPABILITIES = [
  { title: "Matter-organized evidence", body: "Group records into cases with assignments, decisions, timelines, and roles.", Icon: Briefcase, accent: "#2563EB" },
  { title: "Tamper-evident custody", body: "Every action is recorded in a linked-hash custody log that survives audit.", Icon: ScrollText, accent: "#7C3AED" },
  { title: "Review-ready reports", body: "Court-review-ready PDF reports with integrity proof and a technical appendix.", Icon: FileText, accent: "#06B6D4" },
  { title: "Verification packages", body: "Portable signed bundles let opposing counsel and reviewers verify independently.", Icon: Package, accent: "#EC4899" },
  { title: "Legal hold", body: "Suspend scheduled destruction and exports for records relevant to active matters.", Icon: ShieldCheck, accent: "#F97316" },
  { title: "Audit trail", body: "Immutable audit log surfaces every access, change, and decision on the matter.", Icon: Scale, accent: "#2563EB" },
];

export default function LegalEDiscoveryPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Solutions · Legal & eDiscovery"
        title="Evidence work,"
        highlight="organized around the matter."
        description="PROOVRA gives legal and eDiscovery teams a defensible foundation: matter-organized evidence, tamper-evident custody, and reviewer-ready reports and packages."
        primaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondaryCta={{ label: "View sample report", href: MARKETING_LINKS.sampleReport }}
      />
      <FeatureGrid
        eyebrow="Pain points"
        title="Where legal teams lose time today."
        items={PAINS}
        surface="soft"
        columns={3}
      />
      <FeatureGrid
        eyebrow="How PROOVRA helps"
        title="Six capabilities that close the gap."
        items={PROOVRA_CAPABILITIES}
        columns={3}
      />
      <LegalClarification />
      <PageCTA
        title="Defensible evidence,"
        highlight="from intake to disclosure."
        primary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondary={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
    </MarketingPage>
  );
}
