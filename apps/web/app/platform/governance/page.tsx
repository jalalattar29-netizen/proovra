import type { Metadata } from "next";
import { ScrollText, ShieldCheck, Lock, Eye, Clock, Briefcase } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { LegalClarification } from "../../../components/marketing/page-shell/LegalClarification";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Governance — PROOVRA Platform",
  description:
    "Retention policies, legal hold, lifecycle visibility, audit logs, and reviewable destruction — built for review-sensitive operations.",
};

const FEATURES = [
  { title: "Retention policies", body: "Configurable retention rules with reviewable destruction windows.", Icon: Clock, accent: "#2563EB" },
  { title: "Legal hold", body: "Suspend scheduled destruction and exports pending review or litigation.", Icon: ShieldCheck, accent: "#7C3AED" },
  { title: "Lifecycle visibility", body: "See exactly where every record is in its lifecycle, with policy context.", Icon: Eye, accent: "#06B6D4" },
  { title: "Immutable audit log", body: "Every access, change, and decision is appended to a tamper-evident audit log.", Icon: ScrollText, accent: "#F97316" },
  { title: "Object lock / immutable storage", body: "Where configured, evidence is stored with WORM/Object Lock controls.", Icon: Lock, accent: "#EC4899" },
  { title: "Department scoping", body: "Govern access and policy by department, team, or workspace.", Icon: Briefcase, accent: "#2563EB" },
];

export default function GovernancePage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Platform · Governance"
        title="Evidence governance,"
        highlight="built into the platform."
        description="Retention, legal hold, lifecycle visibility, and audit logging are not bolted on — they are first-class capabilities every PROOVRA workspace inherits."
        primaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondaryCta={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
      <FeatureGrid
        eyebrow="Governance capabilities"
        title="Policy-aware evidence operations."
        items={FEATURES}
        surface="soft"
        columns={3}
      />
      <LegalClarification />
      <PageCTA
        title="Govern evidence"
        highlight="with confidence."
        primary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondary={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
    </MarketingPage>
  );
}
