import type { Metadata } from "next";
import { FileBadge, FingerprintPattern, ScrollText, ShieldCheck, FileText, Link2 } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { ComparisonTable } from "../../../components/marketing/page-shell/ComparisonTable";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Evidence Records — PROOVRA Platform",
  description:
    "Evidence Records are structured digital artifacts with cryptographic hashes, custody events, verification signals, and linked reports or packages — stronger than ordinary files.",
};

const PROPERTIES = [
  { title: "Cryptographic fingerprint", body: "SHA-256 hash binds the record to its exact content.", Icon: FingerprintPattern, accent: "#F97316" },
  { title: "Structured metadata", body: "Source, time context, workflow, and submitter attribution captured at intake.", Icon: FileBadge, accent: "#2563EB" },
  { title: "Custody events", body: "Linked-hash log records every action with actor and timestamp.", Icon: ScrollText, accent: "#7C3AED" },
  { title: "Verification signals", body: "Hash match, timestamp status, signature, and anchoring state ready for review.", Icon: ShieldCheck, accent: "#06B6D4" },
  { title: "Linked reports", body: "Court-review-ready PDF reports generated from the record on demand.", Icon: FileText, accent: "#EC4899" },
  { title: "Linked packages", body: "Portable verification bundles sealed for independent review.", Icon: Link2, accent: "#2563EB" },
];

export default function EvidenceRecordsPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Platform · Evidence Records"
        title="Evidence Records are"
        highlight="stronger than ordinary files."
        description="Every Evidence Record captures the integrity state, timing context, and custody metadata at the moment of recording — and stays linkable for verification, reporting, and review forever."
        primaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondaryCta={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
      />
      <FeatureGrid
        eyebrow="What's inside an Evidence Record"
        title="Six properties that make a record verifiable."
        description="These properties are recorded together at intake, so every reviewer can independently check the same signals."
        items={PROPERTIES}
        surface="soft"
        columns={3}
      />
      <ComparisonTable
        eyebrow="Comparison"
        title="Ordinary file vs PROOVRA Evidence Record"
        leftHeader="Ordinary file"
        rightHeader="PROOVRA Evidence Record"
        rows={[
          { feature: "Cryptographic fingerprint", left: false, right: true },
          { feature: "Captured time context", left: false, right: true },
          { feature: "Custody event log", left: false, right: true },
          { feature: "Linked verification page", left: false, right: true },
          { feature: "Reviewer-ready PDF report", left: false, right: true },
          { feature: "Portable verification package", left: false, right: true },
          { feature: "Recipient can independently verify", left: false, right: true },
        ]}
      />
      <PageCTA
        title="Turn your files into"
        highlight="Evidence Records."
        primary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondary={{ label: "Open verification demo", href: MARKETING_LINKS.verifyDemo }}
      />
    </MarketingPage>
  );
}
