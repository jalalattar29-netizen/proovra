import type { Metadata } from "next";
import { FileText, ShieldCheck, ScrollText, Clock, KeyRound, FingerprintPattern } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Reports — PROOVRA Platform",
  description:
    "Court-review-ready PDF reports with integrity proof, custody chain, technical appendix, and audit trail.",
};

const SECTIONS = [
  { title: "Cover and summary", body: "Record identity, time, signer, and high-level verification status.", Icon: FileText, accent: "#2563EB" },
  { title: "Integrity proof", body: "Hash, signature, timestamp, and OpenTimestamps state side by side.", Icon: ShieldCheck, accent: "#7C3AED" },
  { title: "Custody chain", body: "Linked-hash custody log with actor, time, and prior-event binding for every event.", Icon: ScrollText, accent: "#06B6D4" },
  { title: "Timestamping detail", body: "RFC 3161 timestamp authority detail and anchoring state where applicable.", Icon: Clock, accent: "#F97316" },
  { title: "Signing detail", body: "ED25519 signing key version and validation result for the fingerprint.", Icon: KeyRound, accent: "#EC4899" },
  { title: "Technical appendix", body: "Method, references, and what the report does and does not assert.", Icon: FingerprintPattern, accent: "#2563EB" },
];

export default function ReportsPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Platform · Reports"
        title="Court-review-ready reports,"
        highlight="generated from the record."
        description="Every Evidence Record can produce a structured PDF report — with integrity proof, custody chain, signing detail, and a clear technical appendix — ready for legal, audit, or operational review."
        primaryCta={{ label: "View sample report", href: MARKETING_LINKS.sampleReport }}
        secondaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
      />
      <FeatureGrid
        eyebrow="What's in a report"
        title="Six sections. One defensible document."
        description="The report is generated deterministically from the underlying record, so reviewers see the same signals every time."
        items={SECTIONS}
        surface="soft"
        columns={3}
      />
      <PageCTA
        title="See an example"
        highlight="evidence report."
        primary={{ label: "Open sample report", href: MARKETING_LINKS.sampleReport }}
        secondary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
      />
    </MarketingPage>
  );
}
