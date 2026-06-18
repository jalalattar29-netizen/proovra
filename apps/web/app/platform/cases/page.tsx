import type { Metadata } from "next";
import { Briefcase, ListChecks, ShieldCheck, ScrollText, Users, FileText } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Cases & Matters — PROOVRA Platform",
  description:
    "Organize evidence into matters, claims, incidents, and investigations with assignments, decisions, timelines, and legal holds.",
};

const FEATURES = [
  { title: "Group evidence by matter", body: "Bundle related records into a case with consistent metadata and review scope.", Icon: Briefcase, accent: "#2563EB" },
  { title: "Assignments", body: "Route work to reviewers, investigators, or external counsel with role-aware access.", Icon: Users, accent: "#7C3AED" },
  { title: "Decisions & timeline", body: "Structured decisions and a complete timeline of actions for the case.", Icon: ScrollText, accent: "#06B6D4" },
  { title: "Readiness & status", body: "Track which records and packages are ready, pending, or under hold.", Icon: ListChecks, accent: "#F97316" },
  { title: "Legal hold", body: "Suspend scheduled destruction and exports while a hold is in place.", Icon: ShieldCheck, accent: "#EC4899" },
  { title: "Case reports", body: "Generate case-level summaries with embedded record and verification references.", Icon: FileText, accent: "#2563EB" },
];

export default function CasesPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Platform · Cases & Matters"
        title="Evidence belongs to a"
        highlight="matter, not a folder."
        description="Cases organize evidence around the real shape of work — claims, incidents, investigations — with assignments, decisions, timelines, and legal hold built in."
        primaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondaryCta={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
      <FeatureGrid
        eyebrow="Case capabilities"
        title="Built for matter-driven work."
        items={FEATURES}
        surface="soft"
        columns={3}
      />
      <PageCTA
        title="Organize your evidence"
        highlight="around real work."
        primary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondary={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
    </MarketingPage>
  );
}
