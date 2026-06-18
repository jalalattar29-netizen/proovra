import type { Metadata } from "next";
import { FingerprintPattern, CircleCheck, ShieldCheck, Hash } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { LegalClarification } from "../../../components/marketing/page-shell/LegalClarification";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Cryptographic Hashing — PROOVRA Technology",
  description:
    "SHA-256 fingerprinting binds every evidence record to its exact content. What hash match means — and what it does not.",
};

const ITEMS = [
  { title: "SHA-256 fingerprint", body: "Every file and package is hashed with SHA-256 at intake and stored alongside the record.", Icon: FingerprintPattern, accent: "#F97316" },
  { title: "Hash match", body: "Verification confirms that the content being inspected matches the recorded SHA-256.", Icon: CircleCheck, accent: "#10B981" },
  { title: "Canonical composite digest", body: "For multi-file packages, a canonical composite digest binds the bundle as a whole.", Icon: Hash, accent: "#2563EB" },
  { title: "What hash match does not mean", body: "It does not establish authorship, truth, identity, or legal admissibility — only content equivalence.", Icon: ShieldCheck, accent: "#7C3AED" },
];

export default function CryptographicHashingPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Technology · Cryptographic Hashing"
        title="A fingerprint for"
        highlight="every evidence record."
        description="Cryptographic hashing is the foundation of independent verifiability — a precise, content-addressed signal that anyone can check."
        primaryCta={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondaryCta={{ label: "Read methodology", href: MARKETING_LINKS.technology.verificationMethodology }}
      />
      <FeatureGrid
        eyebrow="What we use SHA-256 for"
        title="One algorithm. Four uses."
        items={ITEMS}
        surface="soft"
        columns={2}
      />
      <LegalClarification />
      <PageCTA
        title="Verify a record"
        highlight="by its hash."
        primary={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
      />
    </MarketingPage>
  );
}
