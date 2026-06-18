import type { Metadata } from "next";
import { Compass, FingerprintPattern, KeyRound, Clock, Link2, ShieldCheck } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { LegalClarification } from "../../../components/marketing/page-shell/LegalClarification";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Verification Methodology — PROOVRA Technology",
  description:
    "What PROOVRA verification checks — and what it does not assert. Cryptographic integrity, timestamps, signatures, and custody continuity, transparently documented.",
};

const CHECKS = [
  { title: "Hash match", body: "Content fingerprint matches the recorded SHA-256.", Icon: FingerprintPattern, accent: "#F97316" },
  { title: "Signature status", body: "ED25519 signature on the fingerprint is valid for a known PROOVRA signing key.", Icon: KeyRound, accent: "#7C3AED" },
  { title: "Timestamp status", body: "RFC 3161 trusted timestamp present and valid, or a clearly labelled fallback signal.", Icon: Clock, accent: "#06B6D4" },
  { title: "Anchoring status", body: "OpenTimestamps state surfaced honestly: pending, anchored, or unavailable.", Icon: Compass, accent: "#EC4899" },
  { title: "Custody continuity", body: "Linked-hash custody log is consistent and complete from intake to current state.", Icon: Link2, accent: "#2563EB" },
  { title: "Package integrity", body: "Verification package manifest, hashes, and signatures cross-check successfully.", Icon: ShieldCheck, accent: "#7C3AED" },
];

const NOT_ASSERTED = [
  { title: "Not factual truth", body: "Verification does not determine whether the depicted facts are accurate.", Icon: Compass, accent: "#94A3B8" },
  { title: "Not authorship or identity", body: "PROOVRA does not independently verify the identity of the submitter or any depicted person.", Icon: Compass, accent: "#94A3B8" },
  { title: "Not legal admissibility", body: "Admissibility depends on jurisdiction, matter, and process — not on PROOVRA verification alone.", Icon: Compass, accent: "#94A3B8" },
];

export default function VerificationMethodologyPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Technology · Verification Methodology"
        title="What verification checks —"
        highlight="and what it does not."
        description="PROOVRA verification is transparent about its scope: it confirms integrity signals, time context, and custody continuity — and it explicitly does not assert facts beyond that."
        primaryCta={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondaryCta={{ label: "Open methodology doc", href: MARKETING_LINKS.legal.methodology }}
      />
      <FeatureGrid
        eyebrow="Signals verification checks"
        title="Six checks. One clear result."
        items={CHECKS}
        surface="soft"
        columns={3}
      />
      <FeatureGrid
        eyebrow="What verification does not assert"
        title="Three things PROOVRA does not claim."
        description="Being explicit about scope is part of how PROOVRA earns reviewer trust."
        items={NOT_ASSERTED}
        columns={3}
      />
      <LegalClarification />
      <PageCTA
        title="See verification"
        highlight="in action."
        primary={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
      />
    </MarketingPage>
  );
}
