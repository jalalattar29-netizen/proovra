import type { Metadata } from "next";
import { KeyRound, FingerprintPattern, ShieldCheck, ScrollText } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Digital Signatures — PROOVRA Technology",
  description:
    "ED25519 signatures bind evidence fingerprints to PROOVRA signing keys with versioning and optional KMS-backed key custody.",
};

const ITEMS = [
  { title: "ED25519 signatures", body: "Compact, modern Edwards-curve signatures bind the fingerprint to a known signing key.", Icon: KeyRound, accent: "#7C3AED" },
  { title: "Signed fingerprints", body: "Signatures cover the SHA-256 fingerprint — not the raw file — so verification is fast and unambiguous.", Icon: FingerprintPattern, accent: "#F97316" },
  { title: "Key versioning", body: "Every signature is tagged with the signing key version so historical signatures stay verifiable.", Icon: ScrollText, accent: "#06B6D4" },
  { title: "What a signature does not assert", body: "A valid signature shows the record was signed by a known PROOVRA key — not that the content is truthful or legally binding.", Icon: ShieldCheck, accent: "#EC4899" },
];

export default function DigitalSignaturesPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Technology · Digital Signatures"
        title="Signed records,"
        highlight="known signing keys."
        description="Digital signatures bind every evidence record to a known PROOVRA signing key — providing an origin signal that reviewers can check on their own."
        primaryCta={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondaryCta={{ label: "Read methodology", href: MARKETING_LINKS.technology.verificationMethodology }}
      />
      <FeatureGrid
        eyebrow="How signatures work"
        title="Four things to know."
        items={ITEMS}
        surface="soft"
        columns={2}
      />
      <PageCTA
        title="Verify a record"
        highlight="by its signature."
        primary={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
      />
    </MarketingPage>
  );
}
