import type { Metadata } from "next";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { ComparisonTable } from "../../../components/marketing/page-shell/ComparisonTable";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Compare — Traditional Files vs PROOVRA",
  description:
    "A side-by-side comparison of ordinary file workflows and PROOVRA Evidence Records, packages, and verification.",
};

export default function ComparePage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Comparison"
        title="Traditional files vs"
        highlight="PROOVRA Evidence Records."
        description="A side-by-side look at where ordinary file workflows fall short — and what PROOVRA adds, honestly."
        primaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondaryCta={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
      />
      <ComparisonTable
        eyebrow="Capabilities"
        title="What you get, side by side."
        leftHeader="Traditional files"
        rightHeader="PROOVRA"
        rows={[
          { feature: "Independent verification by reviewer", left: false, right: true },
          { feature: "Cryptographic fingerprint", left: false, right: true },
          { feature: "Captured time context", left: false, right: true },
          { feature: "Linked-hash custody log", left: false, right: true },
          { feature: "Trusted timestamping (RFC 3161)", left: false, right: true },
          { feature: "Public OpenTimestamps anchoring", left: false, right: true },
          { feature: "Court-review-ready PDF report", left: false, right: true },
          { feature: "Portable signed verification package", left: false, right: true },
          { feature: "Public verification URL", left: false, right: true },
          { feature: "Retention and legal hold controls", left: false, right: true },
          { feature: "Immutable audit log", left: false, right: true },
          { feature: "Sharing breaks context", left: "Common", right: "Avoided" },
          { feature: "Manual chain of custody work", left: "Required", right: "Eliminated" },
          { feature: "Determines factual truth", left: false, right: false },
          { feature: "Supports audit-ready review workflows", left: false, right: true },
        ]}
      />
      <PageCTA
        title="Ready to move past"
        highlight="ordinary files?"
        primary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondary={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
      />
    </MarketingPage>
  );
}
