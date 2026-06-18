import type { Metadata } from "next";
import { FileBadge, Camera, Briefcase, ShieldCheck, ScrollText, Globe2 } from "lucide-react";
import { MarketingPage } from "../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../components/marketing/page-shell/FeatureGrid";
import { ComparisonTable } from "../../components/marketing/page-shell/ComparisonTable";
import { PageCTA } from "../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Why PROOVRA — Move from files to Evidence Records",
  description:
    "Ordinary files lose context the moment they are sent. PROOVRA Evidence Records carry integrity signals, custody history, and independent verifiability — designed for review-sensitive work.",
};

const SHIFTS = [
  { title: "From ordinary files to Evidence Records", body: "Files lose context when shared. Evidence Records carry integrity signals and custody with them.", Icon: FileBadge, accent: "#2563EB" },
  { title: "From screenshots to verifiable records", body: "Screenshots are deniable. Cryptographic fingerprints and timestamps are not.", Icon: Camera, accent: "#7C3AED" },
  { title: "From scattered evidence to evidence operations", body: "Stop reconstructing custody from email threads. Make it a first-class system.", Icon: Briefcase, accent: "#06B6D4" },
  { title: "From trust-us to verify-yourself", body: "Reviewers should not have to take your word for it — they should check.", Icon: ShieldCheck, accent: "#F97316" },
  { title: "From ad-hoc audit trail to immutable log", body: "Spreadsheets and chat threads are not an audit trail. A linked-hash log is.", Icon: ScrollText, accent: "#EC4899" },
  { title: "From local proof to global verifiability", body: "Public verification URLs and signed packages let anyone independently confirm.", Icon: Globe2, accent: "#2563EB" },
];

export default function WhyProovraPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Why PROOVRA"
        title="Files lose context."
        highlight="Evidence Records keep it."
        description="High-trust work runs on evidence, not files. PROOVRA turns digital artifacts into Evidence Records — structured, signed, time-anchored, and independently verifiable."
        primaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondaryCta={{ label: "See verification demo", href: MARKETING_LINKS.verifyDemo }}
      />
      <FeatureGrid
        eyebrow="Six shifts"
        title="What changes when evidence becomes an operations problem."
        items={SHIFTS}
        surface="soft"
        columns={3}
      />
      <ComparisonTable
        eyebrow="Side by side"
        title="Ordinary files vs PROOVRA Evidence Records"
        leftHeader="Ordinary files"
        rightHeader="PROOVRA Evidence Records"
        rows={[
          { feature: "Independent integrity check", left: false, right: true },
          { feature: "Captured time context", left: false, right: true },
          { feature: "Linked-hash custody log", left: false, right: true },
          { feature: "Reviewer-ready PDF report", left: false, right: true },
          { feature: "Portable verification package", left: false, right: true },
          { feature: "Public verification URL", left: false, right: true },
          { feature: "Recipient can verify offline", left: false, right: true },
        ]}
      />
      <PageCTA
        title="Stop trusting files."
        highlight="Start verifying records."
        primary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondary={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
      />
    </MarketingPage>
  );
}
