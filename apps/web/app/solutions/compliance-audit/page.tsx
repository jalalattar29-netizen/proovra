import type { Metadata } from "next";
import { BookOpen, ScrollText, Clock, ShieldCheck, FileText, Lock } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { LegalClarification } from "../../../components/marketing/page-shell/LegalClarification";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Compliance & Audit — PROOVRA Solutions",
  description:
    "Audit-ready records, retention policies, legal hold, immutable audit trails, and independent verification for compliance and internal audit teams.",
};

const PAINS = [
  { title: "Audit preparation", body: "Pulling together policy evidence for auditors is manual and time-consuming.", Icon: ScrollText, accent: "#94A3B8" },
  { title: "Retention complexity", body: "Different rules for different record types — easy to misapply or forget.", Icon: Clock, accent: "#94A3B8" },
  { title: "Defensibility under review", body: "Auditors and regulators expect tamper-evident records, not ad-hoc folders.", Icon: ShieldCheck, accent: "#94A3B8" },
];

const PROOVRA_CAPABILITIES = [
  { title: "Audit-ready records", body: "Evidence Records carry integrity signals, custody history, and policy context.", Icon: BookOpen, accent: "#2563EB" },
  { title: "Retention engine", body: "Configurable retention policies with reviewable destruction and full audit logging.", Icon: Clock, accent: "#7C3AED" },
  { title: "Legal hold", body: "Suspend scheduled destruction during litigation, regulatory action, or review.", Icon: ShieldCheck, accent: "#06B6D4" },
  { title: "Immutable audit log", body: "Every access, change, and decision is recorded in a tamper-evident log.", Icon: ScrollText, accent: "#F97316" },
  { title: "Object lock storage", body: "Where configured, evidence is stored with WORM controls and retention modes.", Icon: Lock, accent: "#EC4899" },
  { title: "Reviewer-ready reports", body: "Generate structured PDF reports for auditors, regulators, and internal review.", Icon: FileText, accent: "#2563EB" },
];

export default function ComplianceAuditPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Solutions · Compliance & Audit"
        title="Audit-ready records,"
        highlight="all the time."
        description="PROOVRA gives compliance and audit teams a defensible record system: integrity signals, retention, legal hold, and immutable audit logging built in."
        primaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondaryCta={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
      <FeatureGrid
        eyebrow="Pain points"
        title="Where compliance teams burn time today."
        items={PAINS}
        surface="soft"
        columns={3}
      />
      <FeatureGrid
        eyebrow="How PROOVRA helps"
        title="Six capabilities for compliance operations."
        items={PROOVRA_CAPABILITIES}
        columns={3}
      />
      <LegalClarification />
      <PageCTA
        title="Compliance evidence,"
        highlight="ready for review."
        primary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondary={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
    </MarketingPage>
  );
}
