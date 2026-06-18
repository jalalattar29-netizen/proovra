import type { Metadata } from "next";
import { Newspaper, ShieldCheck, Lock, Globe2, FileText, Camera } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Journalism — PROOVRA Solutions",
  description:
    "Source protection, media verification, tamper-evident records, and public verification for newsrooms and investigative journalists.",
};

const PAINS = [
  { title: "Source safety", body: "Source materials must be handled with strict confidentiality and access control.", Icon: Lock, accent: "#94A3B8" },
  { title: "Media authenticity questions", body: "Audiences increasingly ask whether photos and videos are altered.", Icon: Camera, accent: "#94A3B8" },
  { title: "Sharing across teams", body: "Editors, lawyers, and external partners need defensible access — not raw files.", Icon: Globe2, accent: "#94A3B8" },
];

const PROOVRA_CAPABILITIES = [
  { title: "Capture-time integrity", body: "Hash, timestamp, and custody-log every record at intake — no manual ceremony.", Icon: Newspaper, accent: "#2563EB" },
  { title: "Tamper-evident records", body: "Linked-hash custody log surfaces any later modification clearly.", Icon: ShieldCheck, accent: "#7C3AED" },
  { title: "Access controls", body: "Role-based access keeps source material restricted to the people who need it.", Icon: Lock, accent: "#06B6D4" },
  { title: "Public verification", body: "Publish verification URLs so readers can check integrity signals themselves.", Icon: Globe2, accent: "#F97316" },
  { title: "Verification packages", body: "Hand off defensible bundles to fact-check partners, lawyers, or external editors.", Icon: ShieldCheck, accent: "#EC4899" },
  { title: "Structured reports", body: "Generate clear technical reports describing what verification confirms — and what it does not.", Icon: FileText, accent: "#2563EB" },
];

export default function JournalismPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Solutions · Journalism"
        title="Source protection."
        highlight="Story integrity."
        description="PROOVRA supports newsrooms and investigative journalists with tamper-evident records, access controls, and public verification — without claiming editorial truth."
        primaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondaryCta={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
      />
      <FeatureGrid
        eyebrow="Pain points"
        title="Where newsrooms struggle with evidence today."
        items={PAINS}
        surface="soft"
        columns={3}
      />
      <FeatureGrid
        eyebrow="How PROOVRA helps"
        title="Six capabilities for journalism teams."
        items={PROOVRA_CAPABILITIES}
        columns={3}
      />
      <PageCTA
        title="Protect sources,"
        highlight="defend the story."
        primary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondary={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
    </MarketingPage>
  );
}
