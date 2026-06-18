import type { Metadata } from "next";
import { Building2, Camera, Clock, ShieldCheck, FileText, Link2 } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Insurance — PROOVRA Solutions",
  description:
    "Claim evidence with photo and video documentation, time context, custody trail, and fast independent verification for claims investigation.",
};

const PAINS = [
  { title: "Disputed submissions", body: "Photos and videos arrive without verifiable context or capture history.", Icon: Camera, accent: "#94A3B8" },
  { title: "Slow review", body: "Adjusters and SIU spend time validating what should already be verifiable.", Icon: Clock, accent: "#94A3B8" },
  { title: "Hard to share defensibly", body: "Sharing with counsel, third parties, or reinsurers loses context every step.", Icon: Link2, accent: "#94A3B8" },
];

const PROOVRA_CAPABILITIES = [
  { title: "Token-based intake links", body: "Insureds and third parties submit evidence through guarded links with structured metadata.", Icon: Link2, accent: "#2563EB" },
  { title: "Capture-time integrity", body: "Records are hashed and timestamped at intake — no manual chain-of-custody work.", Icon: Camera, accent: "#F97316" },
  { title: "Faster review", body: "Adjusters see integrity signals up front so they spend time on the claim, not the evidence.", Icon: Clock, accent: "#7C3AED" },
  { title: "Verification packages", body: "Share defensible bundles with counsel, SIU, or reinsurers without losing context.", Icon: ShieldCheck, accent: "#06B6D4" },
  { title: "Court-review-ready reports", body: "Structured PDF reports with audit trail support escalation when needed.", Icon: FileText, accent: "#EC4899" },
  { title: "Dispute reduction", body: "Independent verification reduces back-and-forth on claim authenticity questions.", Icon: Building2, accent: "#2563EB" },
];

export default function InsurancePage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Solutions · Insurance"
        title="Faster claims,"
        highlight="defensible evidence."
        description="PROOVRA helps claims teams capture, verify, and share evidence with integrity signals built in — so review is faster and disputes shrink."
        primaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondaryCta={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
      />
      <FeatureGrid
        eyebrow="Pain points"
        title="Where claims teams lose time today."
        items={PAINS}
        surface="soft"
        columns={3}
      />
      <FeatureGrid
        eyebrow="How PROOVRA helps"
        title="Six capabilities for claims operations."
        items={PROOVRA_CAPABILITIES}
        columns={3}
      />
      <PageCTA
        title="Resolve more claims,"
        highlight="dispute fewer."
        primary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondary={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
    </MarketingPage>
  );
}
