import type { Metadata } from "next";
import { Package, FileBadge, ScrollText, KeyRound, ShieldCheck, Globe2 } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { LegalClarification } from "../../../components/marketing/page-shell/LegalClarification";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Verification Packages — PROOVRA Platform",
  description:
    "Portable, signed evidence bundles containing the manifest, hashes, signatures, and chain of custody for independent review.",
};

const CONTENTS = [
  { title: "Manifest", body: "Structured manifest listing every file and reference contained in the bundle.", Icon: FileBadge, accent: "#2563EB" },
  { title: "Hashes", body: "SHA-256 fingerprint of every file plus a canonical composite digest for the bundle.", Icon: Package, accent: "#7C3AED" },
  { title: "Signatures", body: "ED25519 signatures bind the bundle digest to a known PROOVRA signing key.", Icon: KeyRound, accent: "#06B6D4" },
  { title: "Custody references", body: "Linked-hash custody event references for the contained evidence records.", Icon: ScrollText, accent: "#F97316" },
  { title: "Verification report", body: "Embedded verification report describes what was checked and the outcome.", Icon: ShieldCheck, accent: "#EC4899" },
  { title: "Public or private", body: "Share publicly with a verification URL, or hand off privately for review.", Icon: Globe2, accent: "#2563EB" },
];

export default function VerificationPackagesPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Platform · Verification Packages"
        title="Portable, signed bundles for"
        highlight="independent review."
        description="A Verification Package is a sealed, signed bundle that contains everything a reviewer needs to verify an evidence record offline or on their own infrastructure."
        primaryCta={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
      />
      <FeatureGrid
        eyebrow="What's in a package"
        title="Six components. One sealed bundle."
        items={CONTENTS}
        surface="soft"
        columns={3}
      />
      <LegalClarification />
      <PageCTA
        title="Share evidence"
        highlight="without losing context."
        primary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondary={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
      />
    </MarketingPage>
  );
}
