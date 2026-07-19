"use client";

import Link from "next/link";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { TrustCenterSectionList } from "../_section-list";

export default function MethodologyPage() {
  return (
    <PageRouteGate routeId="workspace.trust_center">
      <TrustCenterSectionList
        kind="METHODOLOGY"
        title="Verification Methodology Center"
        description="How verification, hashing, trusted timestamps, OpenTimestamps, provenance, verification packages, trust decisions, redaction, and intelligence work. Sourced from actual implementation."
        anchor="methodology"
        /*
          Phase 4A enterprise polish (preserved through the 2026-07-18
          redesign) — visible cross-link to the legal methodology
          document. The in-product Methodology Center surfaces the
          implementation-backed sections; the legal counterpart at
          /legal/verification-methodology is the full legally-styled
          methodology document. We LINK only — never mirror — so neither
          surface can drift from the other.
        */
        heroChildren={
          <aside
            data-methodology-legal-callout
            className="flex flex-wrap items-center gap-2.5 rounded-[12px] border border-[#DDE6F2] bg-white/80 px-4 py-3 text-[12.5px] text-[#475569]"
          >
            <strong className="text-[#0F172A]">Legal counterpart</strong>
            <span>
              For the full legal methodology document, see{" "}
              <Link
                data-methodology-legal-link
                href="/settings/legal/verification-methodology"
                className="font-semibold text-[#2563EB] underline underline-offset-4 hover:text-[#1E40AF]"
              >
                Evidence Verification Methodology (legal)
              </Link>
              .
            </span>
            <Link
              data-methodology-legal-cta
              href="/settings/legal/verification-methodology"
              className="ml-auto rounded-lg border border-[#DDE6F2] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-[#0F172A] no-underline hover:border-[#94A3B8]"
            >
              Read full legal methodology →
            </Link>
          </aside>
        }
        relatedLinks={[
          {
            label: "Evidence Verification Methodology (legal)",
            href: "/settings/legal/verification-methodology",
          },
          { label: "Evidence Handling Policy", href: "/settings/legal/evidence-handling" },
          {
            label: "Verification Disclaimer",
            href: "/settings/legal/verification-disclaimer",
          },
        ]}
      />
    </PageRouteGate>
  );
}
