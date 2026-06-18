import type { Metadata } from "next";
import { Link2, ScrollText, ShieldCheck, Eye } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { LegalClarification } from "../../../components/marketing/page-shell/LegalClarification";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Chain of Custody — PROOVRA Technology",
  description:
    "Linked-hash custody log records every action on an evidence record with actor, time, and prior-event binding — tamper-evident by design.",
};

const ITEMS = [
  { title: "Linked-hash events", body: "Each custody event includes the hash of the previous event, forming a tamper-evident chain.", Icon: Link2, accent: "#2563EB" },
  { title: "Actor and time", body: "Every event records who performed it, when, and the action context.", Icon: ScrollText, accent: "#7C3AED" },
  { title: "Continuity check", body: "Verification confirms the chain is complete and consistent end-to-end.", Icon: ShieldCheck, accent: "#06B6D4" },
  { title: "Visible to reviewers", body: "The custody timeline is surfaced in reports, verification pages, and packages.", Icon: Eye, accent: "#F97316" },
];

export default function ChainOfCustodyPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Technology · Chain of Custody"
        title="Every action,"
        highlight="bound to the next."
        description="PROOVRA's custody log is a linked-hash record of every action on an evidence record — tamper-evident by design and visible to every reviewer."
        primaryCta={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondaryCta={{ label: "Read methodology", href: MARKETING_LINKS.technology.verificationMethodology }}
      />
      <FeatureGrid
        eyebrow="How custody works"
        title="Four properties to know."
        items={ITEMS}
        surface="soft"
        columns={2}
      />
      <LegalClarification />
      <PageCTA
        title="Inspect a custody timeline"
        highlight="on a sample record."
        primary={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
      />
    </MarketingPage>
  );
}
