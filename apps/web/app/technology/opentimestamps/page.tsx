import type { Metadata } from "next";
import { Anchor, Clock, CircleCheck, ShieldCheck } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "OpenTimestamps — PROOVRA Technology",
  description:
    "Bitcoin-anchored timestamps via OpenTimestamps for public, independent verifiability — without overclaiming blockchain proof.",
};

const ITEMS = [
  { title: "OpenTimestamps protocol", body: "Industry-standard protocol for anchoring digests to public timestamping calendars.", Icon: Anchor, accent: "#EC4899" },
  { title: "Bitcoin anchoring", body: "Calendars roll up into Bitcoin transactions, providing a public, independent reference point.", Icon: Clock, accent: "#F97316" },
  { title: "Pending vs anchored", body: "Records may be PENDING (calendar accepted) or ANCHORED (settled into a Bitcoin block).", Icon: CircleCheck, accent: "#10B981" },
  { title: "What OTS does not claim", body: "OTS does not prove identity, intent, or legal effect — it provides a public, time-anchored reference.", Icon: ShieldCheck, accent: "#7C3AED" },
];

export default function OpenTimestampsPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Technology · OpenTimestamps"
        title="Publicly verifiable timing,"
        highlight="anchored to Bitcoin."
        description="OpenTimestamps gives every evidence record an independent, public time reference — without requiring anyone to trust PROOVRA's own clock."
        primaryCta={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondaryCta={{ label: "Read methodology", href: MARKETING_LINKS.technology.verificationMethodology }}
      />
      <FeatureGrid
        eyebrow="How OTS works"
        title="Four facts to know."
        items={ITEMS}
        surface="soft"
        columns={2}
      />
      <PageCTA
        title="Verify an anchored"
        highlight="evidence record."
        primary={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
      />
    </MarketingPage>
  );
}
