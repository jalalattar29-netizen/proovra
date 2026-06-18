import type { Metadata } from "next";
import { ShieldCheck, Link2, Package, Hash, CircleCheck, FingerprintPattern } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Verification — PROOVRA Platform",
  description:
    "Public and private verification of evidence records by URL, hash, or sealed package. Verification confirms integrity signals — not factual truth.",
};

const PATHS = [
  { title: "Verify by URL", body: "Paste a published verification URL to check the live record state.", Icon: Link2, accent: "#2563EB" },
  { title: "Verify by package", body: "Upload a sealed verification package and inspect manifest, hashes, and signatures.", Icon: Package, accent: "#7C3AED" },
  { title: "Verify by hash", body: "Enter a SHA-256 hash to look up the matching evidence record.", Icon: Hash, accent: "#06B6D4" },
];

const SIGNALS = [
  { title: "Hash match", body: "Content fingerprint matches the recorded SHA-256.", Icon: FingerprintPattern, accent: "#F97316" },
  { title: "Timestamp status", body: "RFC 3161 trusted timestamp or fallback signal where available.", Icon: ShieldCheck, accent: "#2563EB" },
  { title: "Signature status", body: "ED25519 signature on the fingerprint validates against a known signing key.", Icon: CircleCheck, accent: "#7C3AED" },
  { title: "Anchoring status", body: "OpenTimestamps state: pending, anchored to Bitcoin, or failed.", Icon: Package, accent: "#06B6D4" },
  { title: "Custody continuity", body: "Linked-hash custody log is consistent and complete.", Icon: Link2, accent: "#EC4899" },
  { title: "Package integrity", body: "Verification package manifest, hashes, and signatures cross-check successfully.", Icon: Package, accent: "#2563EB" },
];

export default function VerificationPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Platform · Verification"
        title="Three ways to verify."
        highlight="One consistent answer."
        description="Verification confirms the recorded integrity state, timing context, and custody continuity of an evidence record — independently and on demand."
        primaryCta={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondaryCta={{ label: "Offline verifier", href: MARKETING_LINKS.offlineVerifier }}
      />
      <FeatureGrid
        eyebrow="Verification paths"
        title="By URL, package, or hash."
        items={PATHS}
        surface="soft"
        columns={3}
      />
      <FeatureGrid
        eyebrow="Signals checked"
        title="Six signals. One verification result."
        description="Every verification produces a structured set of signals you can act on — and a clear statement of what was and was not confirmed."
        items={SIGNALS}
        columns={3}
      />
      <PageCTA
        title="Run a live verification"
        highlight="right now."
        primary={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
      />
    </MarketingPage>
  );
}
