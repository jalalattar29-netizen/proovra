import type { Metadata } from "next";
import {
  FingerprintPattern,
  KeyRound,
  Clock,
  Anchor,
  Link2,
  Compass,
  Lock,
  ShieldCheck,
} from "lucide-react";
import { MarketingPage } from "../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../components/marketing/page-shell/FeatureGrid";
import { PageCTA } from "../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Technology — PROOVRA",
  description:
    "How PROOVRA creates verifiable evidence records: SHA-256 hashing, ED25519 signatures, RFC 3161 timestamps, OpenTimestamps anchoring, custody chain, and verification methodology.",
};

const PILLARS = [
  { title: "Cryptographic Hashing", body: "SHA-256 fingerprints for every evidence record and package.", Icon: FingerprintPattern, accent: "#F97316" },
  { title: "Digital Signatures", body: "ED25519 signatures on fingerprints with versioned keys and optional KMS.", Icon: KeyRound, accent: "#7C3AED" },
  { title: "Trusted Timestamping", body: "RFC 3161 timestamping authority integration for independent timing proof.", Icon: Clock, accent: "#06B6D4" },
  { title: "OpenTimestamps", body: "Bitcoin-anchored timestamps via OTS for public, independent verifiability.", Icon: Anchor, accent: "#EC4899" },
  { title: "Chain of Custody", body: "Linked-hash custody log records every action with actor and prior-event binding.", Icon: Link2, accent: "#2563EB" },
  { title: "Verification Methodology", body: "Documented method for what PROOVRA checks — and what it does not assert.", Icon: Compass, accent: "#7C3AED" },
  { title: "Storage Protection", body: "Object lock / immutable storage with retention modes where configured.", Icon: Lock, accent: "#06B6D4" },
  { title: "Security Architecture", body: "Identity, access controls, MFA, immutable audit logging, and data protection.", Icon: ShieldCheck, accent: "#F97316" },
];

export default function TechnologyPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Technology"
        title="How PROOVRA creates"
        highlight="verifiable evidence."
        description="Each layer of the platform is engineered for independent verifiability — so a reviewer never has to trust us, they can check."
        primaryCta={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondaryCta={{ label: "Read methodology", href: MARKETING_LINKS.technology.verificationMethodology }}
      />
      <FeatureGrid
        eyebrow="Trust infrastructure"
        title="Eight layers. One verifiable record."
        description="Each layer is implemented with a public standard or documented method — and described honestly, with no overclaiming."
        items={PILLARS}
        surface="soft"
        columns={4}
      />
      <PageCTA
        title="See how PROOVRA"
        highlight="verifies evidence."
        primary={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
        secondary={{ label: "Read methodology", href: MARKETING_LINKS.technology.verificationMethodology }}
      />
    </MarketingPage>
  );
}
