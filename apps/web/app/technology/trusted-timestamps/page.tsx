import type { Metadata } from "next";
import { Clock, ShieldCheck, ScrollText, CircleCheck } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { LegalClarification } from "../../../components/marketing/page-shell/LegalClarification";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Trusted Timestamping — PROOVRA Technology",
  description:
    "RFC 3161 trusted timestamping anchors evidence to independent time authorities, with fallback signals when a TSA is unavailable.",
};

const ITEMS = [
  { title: "RFC 3161", body: "Industry-standard timestamp request and reply format used by major TSAs.", Icon: Clock, accent: "#06B6D4" },
  { title: "Independent time authority", body: "Timestamps are signed by an external authority, separating timing proof from PROOVRA itself.", Icon: ShieldCheck, accent: "#2563EB" },
  { title: "Timestamp status", body: "Verification surfaces whether the timestamp is present, valid, and within the trusted issuance window.", Icon: CircleCheck, accent: "#10B981" },
  { title: "Fallback signals", body: "If a TSA reply is unavailable, the record carries a clearly labelled fallback timing signal — not a fabricated timestamp.", Icon: ScrollText, accent: "#F97316" },
];

export default function TrustedTimestampsPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Technology · Trusted Timestamping"
        title="An independent clock,"
        highlight="bound to your record."
        description="Trusted timestamping connects every evidence record to an external time authority — so the time of recording is verifiable without trusting PROOVRA's own clock."
        primaryCta={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondaryCta={{ label: "Read methodology", href: MARKETING_LINKS.technology.verificationMethodology }}
      />
      <FeatureGrid
        eyebrow="How timestamping works"
        title="Four signals you can check."
        items={ITEMS}
        surface="soft"
        columns={2}
      />
      <LegalClarification />
      <PageCTA
        title="Verify when an"
        highlight="evidence record was created."
        primary={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
      />
    </MarketingPage>
  );
}
